import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimit } from "@/lib/api-helpers";
import { fullProjectInclude, toFullProject } from "@/lib/serialize";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/:id/duplicate — owner only.
 *
 * Universal Studio project management: creates a fresh DRAFT copy of an
 * existing project. The copy is always unarchived and unfeatured, its title
 * is suffixed " (copy)", and its visibility is reset to PRIVATE so nothing
 * half-duplicate ever appears publicly by accident. Narrative fields, tools,
 * the profession-aware customFields envelope, media links, skills and
 * contributors are carried over. The original is never modified.
 */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  if (!rateLimit(`projects:duplicate:${user.id}`, 20, 60 * 60 * 1000)) return ERR.rateLimited();

  const { id } = await params;
  const source = await db.project.findUnique({
    where: { id },
    include: {
      media: { orderBy: { order: "asc" as const }, select: { mediaId: true, caption: true } },
      skills: { select: { skillId: true } },
      contributors: { select: { name: true, role: true, contribution: true } },
    },
  });
  if (!source) return ERR.notFound();
  if (source.ownerId !== user.id) return ERR.forbidden();

  // Title cap: keep the suffix honest even when the source title is at max length.
  const suffix = " (copy)";
  const baseTitle = source.title.length + suffix.length > 140
    ? source.title.slice(0, 140 - suffix.length).trimEnd()
    : source.title;

  const copy = await db.$transaction(async (tx) => {
    const p = await tx.project.create({
      data: {
        ownerId: user.id,
        title: `${baseTitle}${suffix}`,
        summary: source.summary,
        description: source.description,
        category: source.category,
        // A duplicate always starts as a PRIVATE draft — the creator decides
        // when (and whether) it becomes visible.
        status: "DRAFT",
        visibility: "PRIVATE",
        coverMediaId: source.coverMediaId,
        brief: source.brief,
        process: source.process,
        challenges: source.challenges,
        outcome: source.outcome,
        role: source.role,
        tools: source.tools,
        customFields: source.customFields,
        externalUrl: source.externalUrl,
        repoUrl: source.repoUrl,
        // archivedAt/featuredAt/publishedAt intentionally NOT copied.
      },
    });
    if (source.skills.length > 0) {
      await tx.projectSkill.createMany({
        data: source.skills.map((s) => ({ projectId: p.id, skillId: s.skillId })),
      });
    }
    if (source.media.length > 0) {
      await tx.projectMedia.createMany({
        data: source.media.map((m, i) => ({
          projectId: p.id,
          mediaId: m.mediaId,
          caption: m.caption,
          order: i,
        })),
      });
    }
    if (source.contributors.length > 0) {
      await tx.contributor.createMany({
        data: source.contributors.map((c) => ({
          projectId: p.id,
          name: c.name,
          role: c.role,
          contribution: c.contribution,
        })),
      });
    }
    return p;
  });

  const full = await db.project.findUnique({ where: { id: copy.id }, include: fullProjectInclude });
  if (!full) return ERR.server();
  return ok({ project: toFullProject(full) });
});
