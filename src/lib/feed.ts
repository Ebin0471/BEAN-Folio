import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

import { postCardInclude, toPublicPost, publicPostFilter, type PostWithCardRelations } from "@/lib/posts";
import { feedExcludedAuthorIds, activeFollowingWhere } from "@/lib/social";

/**
 * BEAN Folio — feed distribution engine.
 *
 * Four real modes over the same safety rules (server-side, never client):
 *   following — posts by accounts the viewer ACTIVELY follows (+ own posts),
 *               strict chronological keyset pagination (no rescan, no dupes);
 *   foryou    — explainable relevance ranking over a bounded candidate pool
 *               (profession/skills/location affinity, follow-graph signals,
 *               engagement quality, freshness, per-page creator diversity,
 *               negative feedback via PostHidden and mutes);
 *   trending  — engagement VELOCITY (72h likes/comments) weighted with total
 *               engagement and freshness, over the last 14 days, with a
 *               flood-spam guard;
 *   video     — reels/video posts ranked by freshness + engagement.
 *
 * Every ranking uses ONLY recorded, structurally-deduped events (composite
 * PKs make duplicate likes/bookmarks/views impossible) — never fabricated
 * popularity. Impression recording is the explicit "served in a feed" counter
 * (Post.impressions + daily PostImpressionDay buckets) and is deliberately
 * separate from PostView (actual views, deduped per viewer per day).
 */

export type FeedMode = "following" | "foryou" | "trending" | "video";

export interface FeedPage {
  items: (ReturnType<typeof toPublicPost> & { reason?: string })[];
  nextCursor: string | null;
}

const POOL = 600; // candidate cap — ranking never scans the whole table
const MAX_LIMIT = 24;
const DEFAULT_LIMIT = 10;

export interface FeedQuery {
  cursor?: number;
  limit?: number;
  /** Post ids the client has already rendered (cross-page repeat guard). */
  excludeIds?: string[];
}

// ------------------------------------------------------------------ shared

/** Viewer like/bookmark state for one page, batched (same pattern as discover/posts). */
async function viewerState(viewerId: string | null | undefined, postIds: string[]) {
  const liked = new Set<string>();
  const bookmarked = new Set<string>();
  if (viewerId && postIds.length > 0) {
    const [likes, bookmarks] = await Promise.all([
      db.postLike.findMany({ where: { userId: viewerId, postId: { in: postIds } }, select: { postId: true } }),
      db.postBookmark.findMany({ where: { userId: viewerId, postId: { in: postIds } }, select: { postId: true } }),
    ]);
    for (const l of likes) liked.add(l.postId);
    for (const b of bookmarks) bookmarked.add(b.postId);
  }
  return (p: PostWithCardRelations) => toPublicPost(p, { liked: liked.has(p.id), bookmarked: bookmarked.has(p.id) });
}

/**
 * Publish due SCHEDULED posts and record "served in feed" impressions.
 * The sweep is the scheduling mechanism of record — it runs at the top of
 * every feed read so a due post publishes even without a background worker
 * (the queue worker sweeps too when it is up).
 */
export async function sweepScheduledPosts(): Promise<void> {
  await db.post
    .updateMany({
      where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } },
      data: { status: "PUBLISHED" },
    })
    .catch(() => undefined);
}

export async function recordImpressions(postIds: string[]): Promise<void> {
  if (postIds.length === 0) return;
  const day = new Date().toISOString().slice(0, 10);
  try {
    await db.$transaction([
      db.post.updateMany({ where: { id: { in: postIds } }, data: { impressions: { increment: 1 } } }),
      ...postIds.map((postId) =>
        db.postImpressionDay.upsert({
          where: { postId_day: { postId, day } },
          create: { postId, day, count: 1 },
          update: { count: { increment: 1 } },
        })
      ),
    ]);
  } catch {
    // impressions are best-effort analytics, never a feed failure
  }
}

function basePublicWhere(excludedAuthorIds: string[]): Prisma.PostWhereInput {
  return {
    AND: [
      publicPostFilter,
      ...(excludedAuthorIds.length > 0 ? [{ authorId: { notIn: excludedAuthorIds } }] : []),
    ],
  };
}

// ------------------------------------------------------------------ following

async function followingFeed(viewerId: string, q: FeedQuery): Promise<FeedPage> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, q.limit ?? DEFAULT_LIMIT));
  const follows = await db.follow.findMany({
    where: activeFollowingWhere(viewerId),
    select: { followingId: true },
  });
  // Own posts (including PRIVATE — the author always sees their own feed) plus
  // followed authors' public posts. Drafts/SCHEDULED never appear in feeds.
  const where: Prisma.PostWhereInput = {
    AND: [
      { status: "PUBLISHED" },
      {
        OR: [
          { authorId: viewerId },
          {
            authorId: { in: follows.map((f) => f.followingId) },
            visibility: "PUBLIC",
            author: { isDemo: false, deletedAt: null },
          },
        ],
      },
    ],
  };
  // Keyset pagination on createdAt — immune to newly-inserted posts shifting
  // offsets, and never repeats an item across pages.
  const cursorDate = q.cursor ? new Date(Number(q.cursor)) : null;
  const validCursor = cursorDate && !Number.isNaN(cursorDate.getTime()) ? cursorDate : null;
  const rows = await db.post.findMany({
    where: validCursor ? { ...where, createdAt: { lt: validCursor } } : where,
    include: postCardInclude,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const serialize = await viewerState(viewerId, page.map((p) => p.id));
  return {
    items: page.map((p) => serialize(p)),
    nextCursor: hasMore && page.length > 0 ? String(page[page.length - 1].createdAt.getTime()) : null,
  };
}

// ------------------------------------------------------------------ for you

interface Candidate {
  post: PostWithCardRelations;
  score: number;
  reason: string;
}

async function viewerAffinitySignals(viewerId: string) {
  const me = await db.user.findUnique({
    where: { id: viewerId },
    select: {
      location: true,
      professions: { select: { profession: { select: { slug: true } } } },
      skills: { select: { skill: { select: { label: true } } } },
    },
  });
  return {
    professions: new Set((me?.professions ?? []).map((p) => p.profession.slug)),
    skills: new Set((me?.skills ?? []).map((s) => s.skill.label.trim().toLowerCase())),
    location: me?.location?.trim().toLowerCase() ?? null,
  };
}

/**
 * For You: rank a bounded recent-public pool for this viewer.
 * Signals (all real, explainable): author profession/skills/location overlap,
 * follow-graph direction, structurally-deduped engagement quality, freshness
 * and per-page creator diversity. Negative signals: hidden posts, muted and
 * blocked authors, plus the client's cross-page exclude list.
 */
async function forYouFeed(viewerId: string | null, q: FeedQuery, excludedAuthorIds: string[]): Promise<FeedPage> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, q.limit ?? DEFAULT_LIMIT));
  const offset = Math.max(0, q.cursor ?? 0);

  const hidden = viewerId
    ? (await db.postHidden.findMany({ where: { userId: viewerId }, select: { postId: true } })).map((h) => h.postId)
    : [];
  const excludeIds = new Set([...(q.excludeIds ?? []), ...hidden]);

  const where: Prisma.PostWhereInput = {
    AND: [
      basePublicWhere(excludedAuthorIds),
      { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      ...(viewerId ? [{ authorId: { not: viewerId } }] : []),
      ...(excludeIds.size > 0 ? [{ id: { notIn: [...excludeIds].slice(0, 200) } }] : []),
    ],
  };

  const rows = await db.post.findMany({
    where,
    include: postCardInclude,
    orderBy: { createdAt: "desc" },
    take: POOL,
  });
  if (rows.length === 0) return { items: [], nextCursor: null };

  const signals = viewerId ? await viewerAffinitySignals(viewerId) : null;

  // Follow-graph direction map for the page's authors (one query).
  const authorIds = [...new Set(rows.map((r) => r.authorId))];
  const [myFollows, followedBack] = viewerId
    ? await Promise.all([
        db.follow.findMany({
          where: { followerId: viewerId, followingId: { in: authorIds }, status: "ACTIVE" },
          select: { followingId: true },
        }),
        db.follow.findMany({
          where: { followerId: { in: authorIds }, followingId: viewerId, status: "ACTIVE" },
          select: { followerId: true },
        }),
      ])
    : [[], []];
  const iFollow = new Set(myFollows.map((f) => f.followingId));
  const followsMe = new Set(followedBack.map((f) => f.followerId));

  const now = Date.now();
  const candidates: Candidate[] = rows.map((post) => {
    let score = 0;
    const reasons: string[] = [];

    // Engagement quality — real, structurally-deduped counts (log-damped).
    const engagement =
      post._count.likes + 2 * post._count.comments + 1.5 * post.shares + 1.5 * post._count.bookmarks;
    if (engagement > 0) {
      score += Math.min(25, 6 * Math.log2(1 + engagement));
      reasons.push("Resonating with the community");
    }

    // Freshness — exp decay over ~36h half-life.
    const ageHours = (now - post.createdAt.getTime()) / 3_600_000;
    score += 25 * Math.exp(-ageHours / 36);

    // Author affinity — professions, skills, location (only when the viewer has them).
    if (signals) {
      const sharedProf = post.profession && signals.professions.has(post.profession) ? post.profession : null;
      if (sharedProf) {
        score += 30;
        reasons.push(`In your field`);
      }
      const tags = safeTags(post.hashtags);
      const sharedSkills = tags.filter((t) => signals.skills.has(t));
      if (sharedSkills.length > 0) score += Math.min(15, sharedSkills.length * 5);
      if (signals.location && post.location && post.location.trim().toLowerCase() === signals.location) {
        score += 12;
        reasons.push(`From your area`);
      }
    }

    // Follow graph — following the author (stronger) / they follow you (mutual discovery).
    if (iFollow.has(post.authorId)) {
      score += 18;
      if (followsMe.has(post.authorId)) {
        score += 12;
        reasons.push("Mutual connection");
      } else {
        reasons.push("From someone you follow");
      }
    } else if (followsMe.has(post.authorId)) {
      score += 8;
      reasons.push("Follows you");
    }

    // Deterministic tie-break jitter (stable across reloads).
    let h = 0;
    for (const c of post.id) h = (h * 31 + c.charCodeAt(0)) | 0;
    score += ((h % 100) / 100) * 3;

    if (reasons.length === 0) reasons.push("Fresh from the community");
    return { post, score, reason: reasons.slice(0, 2).join(" · ") };
  });

  candidates.sort((a, b) => b.score - a.score || (a.post.id < b.post.id ? -1 : 1));

  // Per-page creator diversity: at most 2 posts per author inside one page.
  const page: Candidate[] = [];
  const perAuthor = new Map<string, number>();
  for (let i = offset; i < candidates.length && page.length < limit; i++) {
    const c = candidates[i];
    const used = perAuthor.get(c.post.authorId) ?? 0;
    if (used >= 2) continue;
    perAuthor.set(c.post.authorId, used + 1);
    page.push(c);
  }

  const serialize = await viewerState(viewerId, page.map((p) => p.post.id));
  const hasMore = offset + limit < candidates.length;
  return {
    items: page.map((c) => ({ ...serialize(c.post), reason: c.reason })),
    nextCursor: hasMore ? String(offset + limit) : null,
  };
}

// ------------------------------------------------------------------ trending

interface VelocityRow {
  postId: string;
  n: number;
}

async function velocityMap(poolIds: string[], since: Date): Promise<Map<string, number>> {
  const [likes, comments, bookmarks] = await Promise.all([
    db.postLike.groupBy({ by: ["postId"], where: { postId: { in: poolIds }, createdAt: { gte: since } }, _count: { postId: true } }),
    db.postComment.groupBy({ by: ["postId"], where: { postId: { in: poolIds }, createdAt: { gte: since } }, _count: { postId: true } }),
    db.postBookmark.groupBy({ by: ["postId"], where: { postId: { in: poolIds }, createdAt: { gte: since } }, _count: { postId: true } }),
  ]);
  const map = new Map<string, number>();
  const add = (rows: VelocityRow[], weight: number) => {
    for (const r of rows) map.set(r.postId, (map.get(r.postId) ?? 0) + r.n * weight);
  };
  add(likes as unknown as VelocityRow[], 1);
  add(comments as unknown as VelocityRow[], 2);
  add(bookmarks as unknown as VelocityRow[], 1.5);
  return map;
}

/**
 * Trending: 72h engagement velocity (comments weighted) blended with total
 * engagement and freshness, over a 14-day public window. Flood-spam guard:
 * authors who published >8 posts in the last 24h are excluded from the window.
 */
async function trendingFeed(viewerId: string | null, q: FeedQuery, excludedAuthorIds: string[], videoOnly: boolean): Promise<FeedPage> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, q.limit ?? DEFAULT_LIMIT));
  const offset = Math.max(0, q.cursor ?? 0);

  const hidden = viewerId
    ? (await db.postHidden.findMany({ where: { userId: viewerId }, select: { postId: true } })).map((h) => h.postId)
    : [];
  const excludeIds = new Set([...(q.excludeIds ?? []), ...hidden]);

  const windowStart = new Date(Date.now() - 14 * 86_400_000);
  const where: Prisma.PostWhereInput = {
    AND: [
      basePublicWhere(excludedAuthorIds),
      { createdAt: { gte: windowStart } },
      ...(videoOnly ? [{ mediaKind: "VIDEO" }] : []),
      ...(excludeIds.size > 0 ? [{ id: { notIn: [...excludeIds].slice(0, 200) } }] : []),
    ],
  };

  const rows = await db.post.findMany({
    where,
    include: postCardInclude,
    orderBy: { createdAt: "desc" },
    take: POOL,
  });
  if (rows.length === 0) return { items: [], nextCursor: null };

  // Flood-spam guard (one grouped query): drop posts by >8 posts/day authors.
  const floodCutoff = new Date(Date.now() - 86_400_000);
  const flood = await db.post.groupBy({
    by: ["authorId"],
    where: { authorId: { in: [...new Set(rows.map((r) => r.authorId))] }, createdAt: { gte: floodCutoff } },
    _count: { _all: true },
  });
  const floodedAuthors = new Set(
    flood.filter((f) => (f._count as { _all?: number })._all !== undefined && (f._count as { _all: number })._all > 8).map((f) => f.authorId)
  );

  const velocity = await velocityMap(rows.map((r) => r.id), new Date(Date.now() - 72 * 3_600_000));

  const now = Date.now();
  const scored = rows
    .filter((r) => !floodedAuthors.has(r.authorId))
    .map((post) => {
      const v = velocity.get(post.id) ?? 0;
      const total = post._count.likes + 2 * post._count.comments + 1.5 * post.shares + 1.5 * post._count.bookmarks;
      const ageHours = (now - post.createdAt.getTime()) / 3_600_000;
      const score = 45 * Math.log2(1 + v) + 15 * Math.log2(1 + total) + 20 * Math.exp(-ageHours / 48);
      const reasons: string[] = [];
      if (v >= 3) reasons.push("Fast-rising engagement");
      else if (total >= 5) reasons.push("Strong engagement");
      if (ageHours < 12) reasons.push("Posted recently");
      return { post, score, reason: reasons.slice(0, 2).join(" · ") || "Trending in the community" };
    });

  scored.sort((a, b) => b.score - a.score || (a.post.id < b.post.id ? -1 : 1));
  const page = scored.slice(offset, offset + limit);
  const serialize = await viewerState(viewerId, page.map((p) => p.post.id));
  return {
    items: page.map((c) => ({ ...serialize(c.post), reason: c.reason })),
    nextCursor: offset + limit < scored.length ? String(offset + limit) : null,
  };
}

// ------------------------------------------------------------------ entry

export async function feedPage(
  mode: FeedMode,
  viewerId: string | null | undefined,
  q: FeedQuery
): Promise<FeedPage> {
  await sweepScheduledPosts();
  const excludedAuthorIds = await feedExcludedAuthorIds(viewerId);
  let page: FeedPage;
  if (mode === "following") {
    if (!viewerId) return { items: [], nextCursor: null }; // anonymous has no following graph
    page = await followingFeed(viewerId, q);
  } else if (mode === "foryou") {
    page = await forYouFeed(viewerId ?? null, q, excludedAuthorIds);
  } else if (mode === "trending") {
    page = await trendingFeed(viewerId ?? null, q, excludedAuthorIds, false);
  } else {
    page = await trendingFeed(viewerId ?? null, q, excludedAuthorIds, true); // video
  }
  // "Served in a feed" impressions — real placement analytics, distinct from views.
  void recordImpressions(page.items.map((i) => i.id));
  return page;
}

// ------------------------------------------------------------------ utils

function safeTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
