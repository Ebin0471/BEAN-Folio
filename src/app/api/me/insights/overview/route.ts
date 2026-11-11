import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR, utcDay } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/** UTC midnight N days before today. */
function startOfUtcDaysAgo(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

/**
 * GET /api/me/insights/overview — owner-only, ESTIMATED stats derived from the
 * deduplicated view/save tables. Every number here is real, never fabricated.
 */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const since14 = startOfUtcDaysAgo(13); // 14 UTC calendar days including today

  const [profileViews, projectViews, saves, followers, viewRows, topProjects] = await Promise.all([
    db.profileView.count({ where: { profileUserId: user.id } }),
    db.projectView.count({ where: { project: { ownerId: user.id } } }),
    db.savedProject.count({ where: { project: { ownerId: user.id } } }),
    db.follow.count({ where: { followingId: user.id } }),
    db.projectView.findMany({
      where: { project: { ownerId: user.id }, createdAt: { gte: since14 } },
      select: { day: true },
    }),
    db.project.findMany({
      where: { ownerId: user.id },
      orderBy: { views: { _count: "desc" } },
      take: 5,
      select: {
        id: true,
        title: true,
        _count: { select: { views: true, savedBy: true } },
      },
    }),
  ]);

  // Group the raw rows by their dedup day, then emit all 14 days (zeros included).
  const counts = new Map<string, number>();
  for (const row of viewRows) counts.set(row.day, (counts.get(row.day) ?? 0) + 1);

  const days: string[] = [];
  for (let i = 13; i >= 0; i--) days.push(utcDay(startOfUtcDaysAgo(i)));

  const series14d = days.map((day) => ({ day, views: counts.get(day) ?? 0 }));

  return ok({
    totals: { profileViews, projectViews, saves, followers },
    series14d,
    topProjects: topProjects.map((p) => ({
      id: p.id,
      title: p.title,
      views: p._count.views,
      saves: p._count.savedBy,
    })),
  });
});
