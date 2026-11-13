import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, handler, containsCI } from "@/lib/api-helpers";
import { publicPostFilter } from "@/lib/posts";
import { publicOwnerFilter } from "@/lib/visibility";
import { recordSearch } from "@/lib/search-history";

export const dynamic = "force-dynamic";

/**
 * GET /api/search/posts?q= — full post search (caption, hashtags, location).
 * Public, published posts by publicly visible authors only. Ranked by
 * recency within the match set (bounded take, no full-table scans thanks to
 * the [status, visibility, createdAt] index).
 */
export const GET = handler(async (req: NextRequest) => {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const limit = Math.min(24, Math.max(1, Number(url.searchParams.get("limit")) || 10));
  const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
  const kind = url.searchParams.get("kind") === "video" ? "VIDEO" : null;

  if (raw.length === 0) return ok({ items: [], nextCursor: null, total: 0 });
  const q = raw.toLowerCase();
  const tagQuery = q.replace(/^#/, "");

  const viewer = await getSessionUser();

  const where = {
    AND: [
      publicPostFilter,
      { author: publicOwnerFilter },
      { OR: [{ body: containsCI(q) }, { hashtags: containsCI(tagQuery) }, { location: containsCI(q) }] },
      ...(kind ? [{ mediaKind: kind }] : []),
    ],
  };

  const [rows, total] = await Promise.all([
    db.post.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: cursor,
      take: limit,
      select: {
        id: true, body: true, mediaKind: true, createdAt: true, hashtags: true, shares: true,
        author: { select: { username: true, name: true, avatarMediaId: true } },
        media: { orderBy: { order: "asc" }, take: 1, include: { mediaAsset: { select: { id: true } }, posterMediaAsset: { select: { id: true } } } },
        _count: { select: { likes: true, comments: true } },
      },
    }),
    db.post.count({ where }),
  ]);

  void recordSearch(viewer?.id ?? null, raw, kind === "VIDEO" ? "videos" : "posts");

  return ok({
    items: rows.map((p) => {
      const first = p.media[0];
      const assetId = first ? (p.mediaKind === "VIDEO" ? (first.posterMediaAsset?.id ?? first.mediaAsset.id) : first.mediaAsset.id) : null;
      return {
        id: p.id,
        body: p.body.slice(0, 200),
        mediaKind: p.mediaKind,
        hashtags: safeTags(p.hashtags).slice(0, 6),
        createdAt: p.createdAt.toISOString(),
        shares: p.shares,
        counts: { likes: p._count.likes, comments: p._count.comments },
        author: { username: p.author.username ?? "", name: p.author.name, avatarUrl: p.author.avatarMediaId ? `/api/media/${p.author.avatarMediaId}/raw` : null },
        thumbUrl: assetId ? `/api/media/${assetId}/raw` : null,
      };
    }),
    nextCursor: cursor + rows.length < total ? String(cursor + rows.length) : null,
    total,
  });
});

function safeTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
