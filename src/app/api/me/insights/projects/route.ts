import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

function startOfUtcDaysAgo(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

/**
 * GET /api/me/insights/projects — all of the user's own projects (any status or
 * visibility) with lifetime views/saves and views over the last 14 days.
 * Sorted by lifetime views, descending.
 */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const since14 = startOfUtcDaysAgo(13);

  const [projects, recentViews] = await Promise.all([
    db.project.findMany({
      where: { ownerId: user.id },
      orderBy: { views: { _count: "desc" } },
      select: {
        id: true,
        title: true,
        _count: { select: { views: true, savedBy: true } },
      },
    }),
    db.projectView.groupBy({
      by: ["projectId"],
      where: { project: { ownerId: user.id }, createdAt: { gte: since14 } },
      _count: { projectId: true },
    }),
  ]);

  const views14ByProject = new Map<string, number>();
  for (const row of recentViews) views14ByProject.set(row.projectId, row._count.projectId);

  return ok({
    projects: projects.map((p) => ({
      id: p.id,
      title: p.title,
      views: p._count.views,
      saves: p._count.savedBy,
      views14d: views14ByProject.get(p.id) ?? 0,
    })),
  });
});
