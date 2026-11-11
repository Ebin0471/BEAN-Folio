import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { projectCardInclude, toProjectCard } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/me/saves — the caller's saved projects, newest save first.
 * PRIVATE projects and rows whose owner has since been deleted are skipped defensively.
 */
export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const rows = await db.savedProject.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      project: {
        include: {
          ...projectCardInclude,
          owner: { select: { username: true, name: true, avatarMediaId: true, deletedAt: true } },
        },
      },
    },
  });

  const projects = rows
    .filter((row) => row.project.visibility !== "PRIVATE" && !row.project.owner.deletedAt)
    .map((row) => toProjectCard(row.project));

  return ok({ projects });
});
