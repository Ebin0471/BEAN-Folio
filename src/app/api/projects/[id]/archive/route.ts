import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { fullProjectInclude, toFullProject } from "@/lib/serialize";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/:id/archive — owner only.
 *
 * Universal Studio project management: moving a project to the Archive is
 * NEVER a deletion. The row, its media links and its stats are untouched;
 * only archivedAt is stamped. Archived projects disappear from the active
 * Drafts/Published lists and from every public surface (they are owner-
 * private while archived), and can be restored at any time via /unarchive.
 */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const project = await db.project.findUnique({
    where: { id },
    select: { id: true, ownerId: true, archivedAt: true },
  });
  if (!project) return ERR.notFound();
  if (project.ownerId !== user.id) return ERR.forbidden();

  await db.project.update({
    where: { id },
    data: { archivedAt: project.archivedAt ?? new Date() },
  });

  const full = await db.project.findUnique({ where: { id }, include: fullProjectInclude });
  if (!full) return ERR.server();
  return ok({ project: toFullProject(full) });
});
