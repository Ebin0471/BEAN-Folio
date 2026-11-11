import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler } from "@/lib/api-helpers";
import { fullProjectInclude, toFullProject } from "@/lib/serialize";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/:id/feature — owner only.
 *
 * Universal Studio portfolio curation: marks a PUBLISHED project as featured.
 * Featured work orders first on the creator's public profile and website
 * project sections. Drafts cannot be featured — feature implies the work is
 * publicly presentable (unpublishing keeps the timestamp but public surfaces
 * never render drafts, so a featured draft stays invisible until republished).
 */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const project = await db.project.findUnique({
    where: { id },
    select: { id: true, ownerId: true, status: true },
  });
  if (!project) return ERR.notFound();
  if (project.ownerId !== user.id) return ERR.forbidden();
  if (project.status !== "PUBLISHED") {
    return err("Only published projects can be featured", 400);
  }

  await db.project.update({ where: { id }, data: { featuredAt: new Date() } });

  const full = await db.project.findUnique({ where: { id }, include: fullProjectInclude });
  if (!full) return ERR.server();
  return ok({ project: toFullProject(full) });
});
