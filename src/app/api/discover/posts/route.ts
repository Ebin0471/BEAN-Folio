import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { getClientKey, handler, ok, rateLimitShared } from "@/lib/api-helpers";
import { publicPostFilter, postCardInclude, toPublicPost } from "@/lib/posts";

export const dynamic = "force-dynamic";

/**
 * GET /api/discover/posts — the creator social feed for the Discover homepage.
 *
 * `?kind=video` returns the Reels & Video feed (posts carrying a real VIDEO
 * asset); the default returns all recent creator posts. Only PUBLISHED,
 * PUBLIC posts by publicly visible authors are served (lib/posts.ts →
 * publicPostFilter); blocked counterparties are excluded in both directions.
 * Offset-cursor pagination; viewer like/bookmark state is resolved in ONE
 * batched query per page.
 */

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 24;

export const GET = handler(async (req: NextRequest) => {
  // Generous public-read budget (M22): 300 req/min/IP — abuse throttle, not a UX limit.
  const limited = await rateLimitShared("read:discover:posts:" + getClientKey(req), 300, 60_000);
  if (limited) return limited;
  const url = new URL(req.url);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT));
  const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
  const kind = url.searchParams.get("kind") === "video" ? "video" : "all";

  const viewer = await getSessionUser();

  const blockedRows = viewer
    ? await db.block.findMany({
        where: { OR: [{ blockerId: viewer.id }, { blockedId: viewer.id }] },
        select: { blockerId: true, blockedId: true },
      })
    : [];
  const blocked = [...new Set(blockedRows.flatMap((b) => [b.blockerId, b.blockedId]))];

  const where = {
    AND: [
      publicPostFilter,
      ...(blocked.length > 0 ? [{ authorId: { notIn: blocked } }] : []),
      ...(kind === "video" ? [{ mediaKind: "VIDEO" }] : []),
    ],
  };

  const [rows, total] = await Promise.all([
    db.post.findMany({
      where,
      include: postCardInclude,
      orderBy: { createdAt: "desc" },
      skip: cursor,
      take: limit,
    }),
    db.post.count({ where }),
  ]);

  // Batch-resolve the viewer's like/bookmark state for this page.
  const pageIds = rows.map((r) => r.id);
  let likedSet = new Set<string>();
  let bookmarkedSet = new Set<string>();
  if (viewer && pageIds.length > 0) {
    const [likes, bookmarks] = await Promise.all([
      db.postLike.findMany({ where: { userId: viewer.id, postId: { in: pageIds } }, select: { postId: true } }),
      db.postBookmark.findMany({ where: { userId: viewer.id, postId: { in: pageIds } }, select: { postId: true } }),
    ]);
    likedSet = new Set(likes.map((l) => l.postId));
    bookmarkedSet = new Set(bookmarks.map((b) => b.postId));
  }

  const nextCursor = cursor + rows.length < total ? String(cursor + rows.length) : null;

  return ok({
    items: rows.map((r) => toPublicPost(r, { liked: likedSet.has(r.id), bookmarked: bookmarkedSet.has(r.id) })),
    nextCursor,
    total,
  });
});
