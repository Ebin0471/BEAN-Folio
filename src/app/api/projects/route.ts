import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, parseBody, rateLimit, handler } from "@/lib/api-helpers";
import { fullProjectInclude, projectCardInclude, toFullProject, toProjectCard } from "@/lib/serialize";
import { STUDIO_CUSTOM_FIELDS_LIMITS } from "@/lib/studio-schema";

export const dynamic = "force-dynamic";

// ---------- Validation ----------

const mediaInput = z.object({
  mediaId: z.string().trim().min(1),
  caption: z.string().max(300).optional(),
});

const contributorInput = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().max(80).optional(),
  contribution: z.string().trim().max(500).optional(),
});

/**
 * Universal Studio profession-aware payload (additive, optional): the
 * project's work type plus structured/custom fields, stored as one JSON
 * envelope in Project.customFields. Bounds mirror STUDIO_CUSTOM_FIELDS_LIMITS.
 */
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

const createSchema = z.object({
  title: z.string().trim().min(1).max(140),
  summary: z.string().max(200).optional(),
  description: z.string().max(20000).optional(),
  category: z.string().max(60).optional(),
  visibility: z.enum(["PUBLIC", "UNLISTED", "PRIVATE"]).optional(),
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

// ---------- GET /api/projects — own projects (owner scope, all visibilities) ----------

/** Sort orders for the Studio project manager (additive, default = recent activity). */
const PROJECT_SORTS = {
  updated: { updatedAt: "desc" as const },
  created: { createdAt: "desc" as const },
  title: { title: "asc" as const },
} as const;

export const GET = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const params = req.nextUrl.searchParams;

  const statusParam = params.get("status");
  let status: "DRAFT" | "PUBLISHED" | undefined;
  if (statusParam) {
    const s = statusParam.toUpperCase();
    if (s !== "DRAFT" && s !== "PUBLISHED") {
      return err("Invalid status filter. Use DRAFT or PUBLISHED.", 400);
    }
    status = s;
  }

  // Archive scope (additive): "true" → archived only, "any" → both, omitted
  // or "false" → active projects only (existing behavior unchanged).
  const archivedParam = params.get("archived");
  let archived: boolean | undefined;
  if (archivedParam === "true") archived = true;
  else if (archivedParam === "any") archived = undefined;
  else archived = false;

  // Free-text search over the owner's own titles (additive, case-insensitive).
  const q = params.get("q")?.trim().slice(0, 80);

  // Sort order — validated against the allowlist, never raw client input.
  const sortParam = params.get("sort") ?? "updated";
  const orderBy = PROJECT_SORTS[sortParam as keyof typeof PROJECT_SORTS];
  if (!orderBy) return err("Invalid sort. Use updated, created or title.", 400);

  const projects = await db.project.findMany({
    where: {
      ownerId: user.id,
      ...(status ? { status } : {}),
      ...(archived !== undefined ? { archivedAt: archived ? { not: null } : null } : {}),
      ...(q ? { title: { contains: q } } : {}),
    },
    orderBy,
    take: 100,
    include: projectCardInclude,
  });

  return ok({ projects: projects.map(toProjectCard) });
});

// ---------- POST /api/projects — create ----------

export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  if (!rateLimit(`projects:create:${user.id}`, 20, 60 * 60 * 1000)) return ERR.rateLimited();

  const r = await parseBody(req, createSchema);
  if (r.response) return r.response;

  // Category must match an existing Profession.slug when provided.
  let category: string | null = null;
  if (r.data.category !== undefined) {
    const cat = r.data.category.trim();
    if (cat) {
      const profession = await db.profession.findUnique({ where: { slug: cat }, select: { slug: true } });
      if (!profession) return err("Category is not recognized", 400);
      category = cat;
    }
  }

  // Cover media must exist and belong to the caller (null/omitted/'' → no cover).
  let coverMediaId: string | null = null;
  if (r.data.coverMediaId !== undefined && r.data.coverMediaId !== null) {
    const cm = r.data.coverMediaId.trim();
    if (cm) {
      const media = await db.mediaAsset.findUnique({ where: { id: cm }, select: { ownerId: true } });
      if (!media || media.ownerId !== user.id) return err("Cover media not found in your library", 400);
      coverMediaId = cm;
    }
  }

  // Every media item must belong to the caller.
  const mediaItems = dedupeMedia(r.data.media ?? []);
  if (mediaItems.length > 0) {
    const owned = await db.mediaAsset.findMany({
      where: { id: { in: mediaItems.map((m) => m.mediaId) }, ownerId: user.id },
      select: { id: true },
    });
    if (owned.length !== mediaItems.length) return err("One or more media items are not in your library", 400);
  }

  const skillIds = await resolveSkillIds(r.data.skills ?? []);
  const contributors = r.data.contributors ?? [];

  const project = await db.$transaction(async (tx) => {
    const p = await tx.project.create({
      data: {
        ownerId: user.id,
        title: r.data.title,
        summary: optText(r.data.summary) ?? null,
        description: optText(r.data.description) ?? null,
        category,
        visibility: r.data.visibility ?? "PUBLIC",
        coverMediaId,
        brief: optText(r.data.brief) ?? null,
        process: optText(r.data.process) ?? null,
        challenges: optText(r.data.challenges) ?? null,
        outcome: optText(r.data.outcome) ?? null,
        role: optText(r.data.role) ?? null,
        externalUrl: optText(r.data.externalUrl) ?? null,
        repoUrl: optText(r.data.repoUrl) ?? null,
        tools: r.data.tools ? JSON.stringify(r.data.tools) : null,
        customFields: r.data.customFields ? JSON.stringify(r.data.customFields) : null,
        status: "DRAFT",
      },
    });
    if (skillIds.length > 0) {
      await tx.projectSkill.createMany({ data: skillIds.map((skillId) => ({ projectId: p.id, skillId })) });
    }
    if (mediaItems.length > 0) {
      await tx.projectMedia.createMany({
        data: mediaItems.map((m, i) => ({
          projectId: p.id,
          mediaId: m.mediaId,
          caption: m.caption?.trim() || null,
          order: i,
        })),
      });
    }
    if (contributors.length > 0) {
      await tx.contributor.createMany({
        data: contributors.map((c) => ({
          projectId: p.id,
          name: c.name,
          role: optText(c.role) ?? null,
          contribution: optText(c.contribution) ?? null,
        })),
      });
    }
    return p;
  });

  const full = await db.project.findUnique({ where: { id: project.id }, include: fullProjectInclude });
  if (!full) return ERR.server();
  return ok({ project: toFullProject(full) });
});
