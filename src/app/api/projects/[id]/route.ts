import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, parseBody, handler, resolveViewerKey, utcDay } from "@/lib/api-helpers";
import { fullProjectInclude, toFullProject, toPublicPerson } from "@/lib/serialize";
import { isProfilePubliclyVisible } from "@/lib/visibility";
import { STUDIO_CUSTOM_FIELDS_LIMITS } from "@/lib/studio-schema";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// ---------- Validation (partial mirror of POST /api/projects) ----------

const mediaInput = z.object({
  mediaId: z.string().trim().min(1),
  caption: z.string().max(300).optional(),
});

const contributorInput = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().max(80).optional(),
  contribution: z.string().trim().max(500).optional(),
});

/** Universal Studio profession-aware payload — see POST /api/projects. */
const customFieldsInput = z
  .object({
    kind: z.string().trim().min(1).max(60).optional(),
    templateId: z.string().trim().min(1).max(60).optional(),
    fields: z
      .record(z.string().trim().max(60), z.string().trim().min(1).max(600))
      .refine((v) => Object.keys(v).length <= STUDIO_CUSTOM_FIELDS_LIMITS.MAX_FIELDS, {
        message: `Too many structured fields (max ${STUDIO_CUSTOM_FIELDS_LIMITS.MAX_FIELDS})`,
      })
      .optional(),
    custom: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(60),
          value: z.string().trim().min(1).max(600),
        })
      )
      .max(STUDIO_CUSTOM_FIELDS_LIMITS.MAX_CUSTOM)
      .optional(),
  })
  .optional();

const patchSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  summary: z.string().max(200).optional(),
  description: z.string().max(20000).optional(),
  category: z.string().max(60).optional(),
  visibility: z.enum(["PUBLIC", "UNLISTED", "PRIVATE"]).optional(),
  // Cover: omitted → keep current; null or '' → clear; string → must be owned media.
  // The union with z.null() is what makes "remove the cover" expressible at all:
  // a plain .optional() string schema forces clients to drop the key, which the
  // PATCH contract then treats as "unchanged".
  coverMediaId: z.union([z.string().max(100), z.null()]).optional(),
  brief: z.string().max(6000).optional(),
  process: z.string().max(6000).optional(),
  challenges: z.string().max(6000).optional(),
  outcome: z.string().max(6000).optional(),
  role: z.string().max(120).optional(),
  externalUrl: z.string().max(300).optional(),
  repoUrl: z.string().max(300).optional(),
  tools: z.array(z.string().trim().min(1).max(40)).max(15).optional(),
  skills: z.array(z.string().trim().min(1).max(60)).max(15).optional(),
  media: z.array(mediaInput).max(30).optional(),
  contributors: z.array(contributorInput).max(20).optional(),
  // Explicit null clears the envelope (PATCH "remove" semantics parity with coverMediaId).
  customFields: customFieldsInput.nullable(),
});

// ---------- Shared module-local helpers ----------

/** undefined → undefined (keep), '' → null (clear), else trimmed string. */
function optText(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? null : t;
}

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

/** Resolve skill labels OR slugs to Skill row ids, creating unknown ones (max 15). */
async function resolveSkillIds(inputs: string[]): Promise<string[]> {
  const items = Array.from(new Set(inputs.map((s) => s.trim()).filter(Boolean))).slice(0, 15);
  if (items.length === 0) return [];

  const existing = await db.skill.findMany({
    where: { OR: [{ slug: { in: items } }, { label: { in: items } }] },
  });
  const bySlug = new Map(existing.map((s) => [s.slug, s.id]));
  const byLabel = new Map(existing.map((s) => [s.label.toLowerCase(), s.id]));

  const ids: string[] = [];
  for (const item of items) {
    const slug = slugify(item);
    if (!slug) continue;
    const matched = bySlug.get(item) ?? byLabel.get(item.toLowerCase());
    if (matched) {
      ids.push(matched);
      continue;
    }
    const created = await db.skill
      .create({ data: { slug, label: item } })
      .catch(async (e: unknown) => {
        if (isUniqueViolation(e)) return db.skill.findUnique({ where: { slug } });
        throw e;
      });
    if (created) ids.push(created.id);
  }
  return Array.from(new Set(ids));
}

/** De-duplicate media entries by mediaId (ProjectMedia has a composite PK). */
function dedupeMedia(items: { mediaId: string; caption?: string }[]): { mediaId: string; caption?: string }[] {
  const seen = new Set<string>();
  const out: { mediaId: string; caption?: string }[] = [];
  for (const item of items) {
    if (seen.has(item.mediaId)) continue;
    seen.add(item.mediaId);
    out.push(item);
  }
  return out;
}

/** Load the project owner as a PublicPerson input (taxonomy + counts + visibility fields). */
function loadOwner(ownerId: string) {
  return db.user.findUnique({
    where: { id: ownerId },
    select: {
      id: true,
      username: true,
      name: true,
      headline: true,
      avatarMediaId: true,
      location: true,
      availability: true,
      profileVisibility: true,
      isDemo: true,
      deletedAt: true,
      professions: { include: { profession: true }, orderBy: { profession: { order: "asc" } } },
      skills: { include: { skill: true } },
      _count: { select: { followsReceived: true, projects: { where: { status: "PUBLISHED" } } } },
    },
  });
}

function toOwnerPerson(owner: NonNullable<Awaited<ReturnType<typeof loadOwner>>>) {
  return toPublicPerson({
    ...owner,
    _count: { followers: owner._count.followsReceived, projects: owner._count.projects },
  });
}

// ---------- GET /api/projects/:id — detail with visibility ladder ----------

export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();

  const project = await db.project.findUnique({ where: { id }, include: fullProjectInclude });
  if (!project) return ERR.notFound();

  const isOwner = sessionUser?.id === project.ownerId;

  // Visibility: PRIVATE owner-only; drafts are owner-only too (never shared).
  if (!isOwner) {
    if (project.visibility === "PRIVATE") return ERR.notFound();
    if (project.status !== "PUBLISHED") return ERR.notFound();
  }

  const owner = await loadOwner(project.ownerId);
  if (!owner) return ERR.notFound();
  if (!isOwner) {
    // Non-owner ladder: the owner's own profile gate also governs direct
    // project URLs (Settings copy: "Private — hidden, direct link shows not
    // found"); demo fixtures never resolve publicly (lib/visibility.ts).
    if (!isProfilePubliclyVisible(owner, false)) return ERR.notFound();
  }
  if (owner.deletedAt && !isOwner) return ERR.notFound();

  const isSaved = sessionUser
    ? Boolean(
        await db.savedProject.findUnique({
          where: { userId_projectId: { userId: sessionUser.id, projectId: id } },
        })
      )
    : false;

  const res = ok({
    project: toFullProject(project),
    owner: toOwnerPerson(owner),
    isOwner,
    isSaved,
    canEdit: isOwner,
  });

  // Record a deduped view (one per viewer per UTC day) for published projects only.
  if (project.status === "PUBLISHED" && !isOwner) {
    const viewerKey = resolveViewerKey(req, res, sessionUser?.id ?? null);
    await db.projectView
      .upsert({
        where: { projectId_viewerKey_day: { projectId: project.id, viewerKey, day: utcDay() } },
        update: {},
        create: { projectId: project.id, viewerKey, day: utcDay() },
      })
      .catch(() => undefined);
  }

  return res;
});

// ---------- PATCH /api/projects/:id — owner-only partial update ----------

export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const existing = await db.project.findUnique({ where: { id }, select: { id: true, ownerId: true } });
  if (!existing) return ERR.notFound();
  if (existing.ownerId !== user.id) return ERR.forbidden();

  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;

  const data: Prisma.ProjectUpdateInput = {};

  if (r.data.title !== undefined) data.title = r.data.title;
  if (r.data.summary !== undefined) data.summary = optText(r.data.summary) ?? null;
  if (r.data.description !== undefined) data.description = optText(r.data.description) ?? null;
  if (r.data.brief !== undefined) data.brief = optText(r.data.brief) ?? null;
  if (r.data.process !== undefined) data.process = optText(r.data.process) ?? null;
  if (r.data.challenges !== undefined) data.challenges = optText(r.data.challenges) ?? null;
  if (r.data.outcome !== undefined) data.outcome = optText(r.data.outcome) ?? null;
  if (r.data.role !== undefined) data.role = optText(r.data.role) ?? null;
  if (r.data.externalUrl !== undefined) data.externalUrl = optText(r.data.externalUrl) ?? null;
  if (r.data.repoUrl !== undefined) data.repoUrl = optText(r.data.repoUrl) ?? null;
  if (r.data.visibility !== undefined) data.visibility = r.data.visibility;
  if (r.data.tools !== undefined) data.tools = JSON.stringify(r.data.tools);
  // customFields: omitted → keep; null → clear; object → replace wholesale.
  if (r.data.customFields !== undefined) {
    data.customFields = r.data.customFields ? JSON.stringify(r.data.customFields) : null;
  }

  // Category: '' clears, otherwise must be a known Profession slug.
  if (r.data.category !== undefined) {
    const cat = r.data.category.trim();
    if (cat === "") {
      data.category = null;
    } else {
      const profession = await db.profession.findUnique({ where: { slug: cat }, select: { slug: true } });
      if (!profession) return err("Category is not recognized", 400);
      data.category = cat;
    }
  }

  // Cover: omitted → keep; null/'' → clear; otherwise must be an owned media asset.
  if (r.data.coverMediaId !== undefined) {
    if (r.data.coverMediaId === null) {
      data.coverMedia = { disconnect: true };
    } else {
      const cm = r.data.coverMediaId.trim();
      if (cm === "") {
        data.coverMedia = { disconnect: true };
      } else {
        const media = await db.mediaAsset.findUnique({ where: { id: cm }, select: { ownerId: true } });
        if (!media || media.ownerId !== user.id) return err("Cover media not found in your library", 400);
        data.coverMedia = { connect: { id: cm } };
      }
    }
  }

  // Media array replaces ProjectMedia rows wholesale.
  const mediaProvided = r.data.media !== undefined;
  const mediaItems = mediaProvided ? dedupeMedia(r.data.media ?? []) : [];
  if (mediaProvided && mediaItems.length > 0) {
    const owned = await db.mediaAsset.findMany({
      where: { id: { in: mediaItems.map((m) => m.mediaId) }, ownerId: user.id },
      select: { id: true },
    });
    if (owned.length !== mediaItems.length) return err("One or more media items are not in your library", 400);
  }

  // Skills resolve/create before the transaction; arrays replace wholesale.
  const skillsProvided = r.data.skills !== undefined;
  const skillIds = skillsProvided ? await resolveSkillIds(r.data.skills ?? []) : [];

  const contributorsProvided = r.data.contributors !== undefined;
  const contributors = contributorsProvided ? (r.data.contributors ?? []) : [];

  const updated = await db.$transaction(async (tx) => {
    await tx.project.update({ where: { id }, data });
    if (skillsProvided) {
      await tx.projectSkill.deleteMany({ where: { projectId: id } });
      if (skillIds.length > 0) {
        await tx.projectSkill.createMany({ data: skillIds.map((skillId) => ({ projectId: id, skillId })) });
      }
    }
    if (mediaProvided) {
      await tx.projectMedia.deleteMany({ where: { projectId: id } });
      if (mediaItems.length > 0) {
        await tx.projectMedia.createMany({
          data: mediaItems.map((m, i) => ({
            projectId: id,
            mediaId: m.mediaId,
            caption: m.caption?.trim() || null,
            order: i,
          })),
        });
      }
    }
    if (contributorsProvided) {
      await tx.contributor.deleteMany({ where: { projectId: id } });
      if (contributors.length > 0) {
        await tx.contributor.createMany({
          data: contributors.map((c) => ({
            projectId: id,
            name: c.name,
            role: optText(c.role) ?? null,
            contribution: optText(c.contribution) ?? null,
          })),
        });
      }
    }
    return true;
  });
  if (!updated) return ERR.server();

  const full = await db.project.findUnique({ where: { id }, include: fullProjectInclude });
  if (!full) return ERR.server();
  return ok({ project: toFullProject(full) });
});

// ---------- DELETE /api/projects/:id — owner-only ----------

export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const existing = await db.project.findUnique({ where: { id }, select: { id: true, ownerId: true } });
  if (!existing) return ERR.notFound();
  if (existing.ownerId !== user.id) return ERR.forbidden();

  await db.project.delete({ where: { id } });
  return ok({ ok: true });
});
