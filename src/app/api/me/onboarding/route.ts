import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser, getUserWithTaxonomy, buildPublicMe } from "@/lib/auth";
import { ok, err, ERR, parseBody, handler, USERNAME_RE } from "@/lib/api-helpers";
import { resolveActiveSlugs, normalizeProfessionSlugs } from "@/lib/professions/service";
import { identityOnboardingSchema, userFieldUpdatesFor } from "@/lib/onboarding-identity";

const onboardingSchema = z.object({
  username: z.string().min(1).max(24),
  displayName: z.string().min(1).max(80),
  professions: z.array(z.string()).min(1).max(5),
  skills: z.array(z.string()).max(20).optional(),
  bio: z.string().max(2000).optional(),
  location: z.string().max(100).optional(),
  headline: z.string().max(120).optional(),
  // M31 (additive): identity-aware onboarding. Absent = the legacy 2-step
  // flow behaves exactly as before (older clients, legacy accounts).
  identity: identityOnboardingSchema.optional(),
});

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2002";
}

/**
 * Validate profession slugs → ids via the taxonomy service. Accepts ANY active
 * DB profession (legacy slugs + the expanded taxonomy), case-insensitive after
 * normalization. Unknown slugs resolve to fewer ids than requested — callers
 * compare counts to keep the legacy 400 error shape.
 */
async function requireProfessionIds(slugs: string[]): Promise<string[] | null> {
  const wanted = normalizeProfessionSlugs(slugs);
  if (wanted.length === 0) return [];
  const ids = await resolveActiveSlugs(wanted);
  if (ids.length !== wanted.length) return null;
  return ids;
}

/**
 * Resolve user-supplied skill labels OR slugs to Skill ids.
 * Matches existing rows first; creates new skills (slugified label) when needed.
 */
async function resolveSkillIds(inputs: string[]): Promise<string[]> {
  const items = Array.from(new Set(inputs.map((s) => s.trim()).filter(Boolean))).slice(0, 20);
  if (items.length === 0) return [];

  const existing = await db.skill.findMany({
    where: { OR: [{ slug: { in: items } }, { label: { in: items } }] },
  });
  const bySlug = new Map(existing.map((s) => [s.slug, s.id]));
  const byLabel = new Map(existing.map((s) => [s.label.toLowerCase(), s.id]));

  const idBySlug = new Map<string, string>();
  for (const item of items) {
    const slug = slugify(item);
    if (!slug) continue;
    const matched = bySlug.get(item) ?? byLabel.get(item.toLowerCase());
    if (matched) {
      idBySlug.set(slug, matched);
      continue;
    }
    const created = await db.skill
      .create({ data: { slug, label: item } })
      .catch(async (e: unknown) => {
        if (isUniqueViolation(e)) return db.skill.findUnique({ where: { slug } });
        throw e;
      });
    if (created) idBySlug.set(slug, created.id);
  }
  return Array.from(new Set(idBySlug.values()));
}

export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const r = await parseBody(req, onboardingSchema);
  if (r.response !== undefined) return r.response;

  const username = r.data.username.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return err("Username must be 3-24 chars: lowercase letters, numbers, hyphens", 400);
  }

  const professionIds = await requireProfessionIds(r.data.professions);
  if (!professionIds) return err("One or more professions are not recognized", 400);
  const skillIds = await resolveSkillIds(r.data.skills ?? []);

  const taken = await db.user.findUnique({ where: { username } });
  if (taken && taken.id !== user.id) return err("This username is already taken", 409);

  try {
    // M31 (additive): per-identity onboarding answers + mapped User fields.
    // The identity section is validated by identityOnboardingSchema (strict,
    // per-identity) and stored as an OnboardingProfile row keyed by
    // (userId, identity). A legacy account completing identity-aware
    // onboarding EXPLICITLY adopts its first identity here (never silently).
    const identitySection = r.data.identity;
    const identityData = identitySection
      ? (identitySection.data as Record<string, unknown>)
      : null;
    const mappedUserFields =
      identitySection && identityData
        ? userFieldUpdatesFor(identitySection.type, identityData)
        : {};

    await db.$transaction(async (tx) => {
      await tx.profileProfession.deleteMany({ where: { userId: user.id } });
      await tx.profileSkill.deleteMany({ where: { userId: user.id } });
      if (professionIds.length > 0) {
        await tx.profileProfession.createMany({
          data: professionIds.map((professionId) => ({ userId: user.id, professionId })),
        });
      }
      if (skillIds.length > 0) {
        await tx.profileSkill.createMany({ data: skillIds.map((skillId) => ({ userId: user.id, skillId })) });
      }
      await tx.user.update({
        where: { id: user.id },
        data: {
          name: r.data.displayName.trim(),
          username,
          headline: r.data.headline?.trim() || null,
          bio: r.data.bio?.trim() || null,
          location: r.data.location?.trim() || null,
          onboarded: true,
          ...mappedUserFields,
          // Explicit first-identity adoption for legacy accounts.
          ...(identitySection && !user.primaryIdentity ? { primaryIdentity: identitySection.type } : {}),
        },
      });
      if (identitySection) {
        await tx.onboardingProfile.upsert({
          where: { userId_identity: { userId: user.id, identity: identitySection.type } },
          create: {
            userId: user.id,
            identity: identitySection.type,
            data: JSON.stringify(identityData ?? {}),
          },
          update: { data: JSON.stringify(identityData ?? {}) },
        });
      }
    });
    if (identitySection) {
      await db.auditEvent
        .create({
          data: {
            actorUserId: user.id,
            action: "onboarding.identity.completed",
            targetType: "USER",
            targetId: user.id,
            meta: JSON.stringify({ identity: identitySection.type }),
          },
        })
        .catch(() => undefined);
    }
  } catch (e: unknown) {
    if (isUniqueViolation(e)) return err("This username is already taken", 409);
    throw e;
  }

  const full = await getUserWithTaxonomy(user.id);
  if (!full) return ERR.server();
  return ok({ user: buildPublicMe(full) });
});
