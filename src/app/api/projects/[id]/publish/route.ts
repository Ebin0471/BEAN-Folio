import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler } from "@/lib/api-helpers";
import { fullProjectInclude, toFullProject } from "@/lib/serialize";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/:id/publish — owner only.
 * Requires a non-empty title AND (a cover OR at least one media item).
 */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const project = await db.project.findUnique({
    where: { id },
    select: { id: true, ownerId: true, title: true, coverMediaId: true, publishedAt: true, _count: { select: { media: true } } },
  });
  if (!project) return ERR.notFound();
  if (project.ownerId !== user.id) return ERR.forbidden();

  const hasTitle = project.title.trim().length > 0;
  const hasVisual = Boolean(project.coverMediaId) || project._count.media > 0;
  if (!hasTitle || !hasVisual) {
    return err("Add a cover or at least one media item before publishing", 400);
  }

  await db.project.update({
    where: { id },
    data: { status: "PUBLISHED", ...(project.publishedAt ? {} : { publishedAt: new Date() }) },
  });

  const full = await db.project.findUnique({ where: { id }, include: fullProjectInclude });
  if (!full) return ERR.server();
  return ok({ project: toFullProject(full) });
});
