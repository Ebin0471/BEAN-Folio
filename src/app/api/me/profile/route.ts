import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser, getUserWithTaxonomy, buildPublicMe } from "@/lib/auth";
import { ok, err, ERR, parseBody, handler } from "@/lib/api-helpers";
import { cacheInvalidateEventShared } from "@/lib/cache";
import { resolveActiveSlugs, normalizeProfessionSlugs } from "@/lib/professions/service";

/** Event fired after a successful professions change (cache subscribers). */
const PROFILE_UPDATE_EVENT = "profile.update";

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  headline: z.string().max(120).nullish(),
  bio: z.string().max(2000).nullish(),
  location: z.string().max(100).nullish(),
  availability: z.string().max(80).nullish(),
  experienceLevel: z.string().max(60).nullish(),
  contactEmail: z.union([z.string().email(), z.null()]).optional(),
  websiteUrl: z
    .union([z.string().max(300).regex(/^https?:\/\/\S+$/i, "Must be an http(s) URL"), z.null()])
    .optional(),
  avatarMediaId: z.union([z.string().min(1), z.null()]).optional(),
  coverMediaId: z.union([z.string().min(1), z.null()]).optional(),
  coverPositionY: z.number().int().min(0).max(100).optional(),
  avatarFit: z.enum(["cover", "contain"]).optional(),
  avatarZoom: z.number().int().min(50).max(300).optional(),
  avatarPosX: z.number().int().min(0).max(100).optional(),
  avatarPosY: z.number().int().min(0).max(100).optional(),
  profileVisibility: z.enum(["PUBLIC", "PRIVATE"]).optional(),
  professions: z.array(z.string()).max(5).optional(),
  skills: z.array(z.string()).max(20).optional(),
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

export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const [me, taxonomy, published] = await Promise.all([
    db.user.findUnique({
      where: { id: user.id },
      include: {
        _count: { select: { projects: true, followsReceived: true, followsGiven: true, profileViews: true } },
      },
    }),
    getUserWithTaxonomy(user.id),
    db.project.count({ where: { ownerId: user.id, status: "PUBLISHED" } }),
  ]);
  if (!me || !taxonomy) return ERR.server();

  return ok({
    user: buildPublicMe(taxonomy),
    stats: {
      projects: me._count.projects,
      published,
      followers: me._count.followsReceived,
      following: me._count.followsGiven,
      profileViews: me._count.profileViews,
    },
  });
});

export const PATCH = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const r = await parseBody(req, patchSchema);
  if (r.response !== undefined) return r.response;
  const d = r.data;

  const data: {
    name?: string;
    headline?: string | null;
    bio?: string | null;
    location?: string | null;
    availability?: string | null;
    experienceLevel?: string | null;
    contactEmail?: string | null;
    websiteUrl?: string | null;
    avatarMediaId?: string | null;
    coverMediaId?: string | null;
    coverPositionY?: number;
    avatarFit?: string;
    avatarZoom?: number;
    avatarPosX?: number;
    avatarPosY?: number;
    profileVisibility?: string;
  } = {};

  if (d.name !== undefined) data.name = d.name.trim();
  if (d.headline !== undefined) data.headline = d.headline?.trim() || null;
  if (d.bio !== undefined) data.bio = d.bio?.trim() || null;
  if (d.location !== undefined) data.location = d.location?.trim() || null;
  if (d.availability !== undefined) data.availability = d.availability?.trim() || null;
  if (d.experienceLevel !== undefined) data.experienceLevel = d.experienceLevel?.trim() || null;
  if (d.contactEmail !== undefined) data.contactEmail = d.contactEmail?.trim().toLowerCase() || null;
  if (d.websiteUrl !== undefined) data.websiteUrl = d.websiteUrl?.trim() || null;
  if (d.profileVisibility !== undefined) data.profileVisibility = d.profileVisibility;

  if (d.avatarMediaId !== undefined) {
    if (d.avatarMediaId === null) {
      data.avatarMediaId = null;
    } else {
      const media = await db.mediaAsset.findUnique({ where: { id: d.avatarMediaId } });
      // Ownership AND kind are verified server-side: a user may only link
      // their own IMAGE asset as an avatar (never another user's media, and
      // never a document/video/audio file via a crafted request).
      if (!media || media.ownerId !== user.id) return err("Avatar media not found", 400);
      if (media.kind !== "IMAGE") return err("Avatar must be an image file", 400);
      data.avatarMediaId = media.id;
    }
  }
  if (d.coverMediaId !== undefined) {
    if (d.coverMediaId === null) {
      data.coverMediaId = null;
    } else {
      const media = await db.mediaAsset.findUnique({ where: { id: d.coverMediaId } });
      if (!media || media.ownerId !== user.id) return err("Cover media not found", 400);
      if (media.kind !== "IMAGE") return err("Cover must be an image file", 400);
      data.coverMediaId = media.id;
    }
  }
  if (d.coverPositionY !== undefined) data.coverPositionY = d.coverPositionY;
  if (d.avatarFit !== undefined) data.avatarFit = d.avatarFit;
  if (d.avatarZoom !== undefined) data.avatarZoom = d.avatarZoom;
  if (d.avatarPosX !== undefined) data.avatarPosX = d.avatarPosX;
  if (d.avatarPosY !== undefined) data.avatarPosY = d.avatarPosY;

  const professionIds = d.professions !== undefined ? await requireProfessionIds(d.professions) : undefined;
  if (professionIds === null) return err("One or more professions are not recognized", 400);
  const skillIds = d.skills !== undefined ? await resolveSkillIds(d.skills) : undefined;

  await db.$transaction(async (tx) => {
    if (Object.keys(data).length > 0) {
      await tx.user.update({ where: { id: user.id }, data });
    }
    if (professionIds) {
      await tx.profileProfession.deleteMany({ where: { userId: user.id } });
      if (professionIds.length > 0) {
        await tx.profileProfession.createMany({
          data: professionIds.map((professionId) => ({ userId: user.id, professionId })),
        });
      }
    }
    if (skillIds) {
      await tx.profileSkill.deleteMany({ where: { userId: user.id } });
      if (skillIds.length > 0) {
        await tx.profileSkill.createMany({ data: skillIds.map((skillId) => ({ userId: user.id, skillId })) });
      }
    }
  });

  // Professions changed → fire the invalidation event for profile caches.
  // Wired ONLY for the professions slice; the rest of PATCH is untouched.
  if (professionIds !== undefined) {
    await cacheInvalidateEventShared(PROFILE_UPDATE_EVENT);
  }

  const full = await getUserWithTaxonomy(user.id);
  if (!full) return ERR.server();
  return ok({ user: buildPublicMe(full) });
});
