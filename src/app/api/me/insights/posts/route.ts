import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { utcDay } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const RANGES: Record<string, number> = { "7": 7, "28": 28, "90": 90 };

/**
 * GET /api/me/insights/posts?range=7|28|90 — PRIVATE analytics for the
 * signed-in owner. Every number comes from recorded, structurally-deduped
 * events (never fabricated):
 *
 *   impressions   PostImpressionDay sums (feed placements — "served in a feed")
 *   views         PostView rows (actual views, deduped per viewer per day)
 *   likes/comments/shares/saves   row counts inside the window
 *   videoPlays    PostView rows on VIDEO posts
 *   engagementRate  (likes + comments + shares + saves) / impressions,
 *                   0 when impressions are 0 — the formula is fixed and
 *                   documented here, never re-defined per client
 *   followerGrowth  ACTIVE follows received per UTC day in the window
 *   topPosts      own posts ranked by in-window engagement
 */
export const GET = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const url = new URL(req.url);
  const rangeKey = url.searchParams.get("range") ?? "28";
  const days = RANGES[rangeKey] ?? 28;
  const start = new Date(Date.now() - days * 86_400_000);
  const startDay = utcDay(start);
  const endDay = utcDay();

  const ownPosts = await db.post.findMany({
    where: { authorId: user.id },
    select: { id: true, body: true, mediaKind: true, createdAt: true, shares: true },
    take: 500,
    orderBy: { createdAt: "desc" },
  });
  const postIds = ownPosts.map((p) => p.id);

  if (postIds.length === 0) {
    return ok({
      range: days,
      totals: { impressions: 0, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, videoPlays: 0, engagementRate: 0 },
      followerGrowth: { gained: 0, series: [] },
      topPosts: [],
    });
  }

  const [impressionsByDay, views, likes, comments, saves, shareEvents, videoViews, followerRows] = await Promise.all([
    db.postImpressionDay.findMany({
      where: { postId: { in: postIds }, day: { gte: startDay, lte: endDay } },
      select: { day: true, count: true },
    }),
    db.postView.count({ where: { postId: { in: postIds }, createdAt: { gte: start } } }),
    db.postLike.count({ where: { postId: { in: postIds }, createdAt: { gte: start } } }),
    db.postComment.count({ where: { postId: { in: postIds }, createdAt: { gte: start } } }),
    db.postBookmark.count({ where: { postId: { in: postIds }, createdAt: { gte: start } } }),
    db.postShareEvent.findMany({
      where: { postId: { in: postIds }, createdAt: { gte: start } },
      select: { postId: true },
    }),
    db.postView.count({
      where: { createdAt: { gte: start }, post: { id: { in: postIds }, mediaKind: "VIDEO" } },
    }),
    db.follow.findMany({
      where: { followingId: user.id, status: "ACTIVE", createdAt: { gte: start } },
      select: { createdAt: true },
    }),
  ]);

  const impressions = impressionsByDay.reduce((sum, r) => sum + r.count, 0);
  const shares = shareEvents.length;
  const engagements = likes + comments + shares + saves;
  const engagementRate = impressions > 0 ? engagements / impressions : 0;

  // Follower growth series per UTC day.
  const seriesMap = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    seriesMap.set(utcDay(new Date(Date.now() - i * 86_400_000)), 0);
  }
  for (const f of followerRows) {
    const d = utcDay(f.createdAt);
    if (seriesMap.has(d)) seriesMap.set(d, (seriesMap.get(d) ?? 0) + 1);
  }
  const followerGrowthSeries = [...seriesMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, gained]) => ({ day, gained }));

  // Top posts by in-window engagement (likes + 2*comments + 1.5*shares + 1.5*saves).
  const perPost = new Map<string, number>();
  const addEng = async () => {
    const [pl, pc, ps, pb] = await Promise.all([
      db.postLike.groupBy({ by: ["postId"], where: { postId: { in: postIds }, createdAt: { gte: start } }, _count: { postId: true } }),
      db.postComment.groupBy({ by: ["postId"], where: { postId: { in: postIds }, createdAt: { gte: start } }, _count: { postId: true } }),
      db.postShareEvent.groupBy({ by: ["postId"], where: { postId: { in: postIds }, createdAt: { gte: start } }, _count: { postId: true } }),
      db.postBookmark.groupBy({ by: ["postId"], where: { postId: { in: postIds }, createdAt: { gte: start } }, _count: { postId: true } }),
    ]);
    for (const r of pl) perPost.set(r.postId, (perPost.get(r.postId) ?? 0) + r._count.postId);
    for (const r of pc) perPost.set(r.postId, (perPost.get(r.postId) ?? 0) + 2 * r._count.postId);
    for (const r of ps) perPost.set(r.postId, (perPost.get(r.postId) ?? 0) + 1.5 * r._count.postId);
    for (const r of pb) perPost.set(r.postId, (perPost.get(r.postId) ?? 0) + 1.5 * r._count.postId);
  };
  await addEng();

  const topPosts = ownPosts
    .map((p) => ({
      id: p.id,
      body: p.body.slice(0, 120),
      mediaKind: p.mediaKind,
      createdAt: p.createdAt.toISOString(),
      shares: p.shares,
      engagement: Math.round(perPost.get(p.id) ?? 0),
    }))
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 5);

  return ok({
    range: days,
    totals: {
      impressions,
      views,
      likes,
      comments,
      shares,
      saves,
      videoPlays: videoViews,
      engagementRate: Math.round(engagementRate * 1000) / 1000,
    },
    followerGrowth: { gained: followerRows.length, series: followerGrowthSeries },
    topPosts,
  });
});
