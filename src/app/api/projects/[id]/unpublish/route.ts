import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { fullProjectInclude, toFullProject } from "@/lib/serialize";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/projects/:id/unpublish — owner only, moves the project back to DRAFT. */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const project = await db.project.findUnique({ where: { id }, select: { id: true, ownerId: true } });
  if (!project) return ERR.notFound();
  if (project.ownerId !== user.id) return ERR.forbidden();

  await db.project.update({ where: { id }, data: { status: "DRAFT" } });

  const full = await db.project.findUnique({ where: { id }, include: fullProjectInclude });
  if (!full) return ERR.server();
  return ok({ project: toFullProject(full) });
});
