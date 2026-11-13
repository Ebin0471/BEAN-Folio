import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, handler, containsCI } from "@/lib/api-helpers";
import { publicPostFilter } from "@/lib/posts";
import { publicOwnerFilter } from "@/lib/visibility";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ tag: string }> };

/**
 * GET /api/hashtags/:tag — public posts carrying this hashtag. Only PUBLIC,
 * PUBLISHED posts by publicly visible authors resolve (the join goes through
 * PostHashtag → Post → publicPostFilter). The related-hashtags block is
 * computed from co-occurring tags across the matched posts (real relations,
 * no invented ones).
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const { tag } = await params;
  const name = decodeURIComponent(tag).trim().toLowerCase().replace(/^#/, "");
  if (!/^[a-z0-9_]{1,24}$/.test(name)) return ok({ tag: null, items: [], related: [] });

  const url = new URL(req.url);
  const limit = Math.min(24, Math.max(1, Number(url.searchParams.get("limit")) || 10));
  const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);

  const hashtag = await db.hashtag.findUnique({
    where: { name },
    select: { name: true, postCount: true },
  });
  if (!hashtag || hashtag.postCount <= 0) return ok({ tag: null, items: [], related: [] });

  const where = {
    AND: [
      publicPostFilter,
      { author: publicOwnerFilter },
      { postHashtags: { some: { hashtag: { is: { name } } } } },
    ],
  };

  const [rows, total] = await Promise.all([
    db.post.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: cursor,
      take: limit,
      select: {
        id: true, body: true, mediaKind: true, createdAt: true, hashtags: true,
        author: { select: { username: true, name: true, avatarMediaId: true } },
        media: { orderBy: { order: "asc" }, take: 1, include: { mediaAsset: { select: { id: true } }, posterMediaAsset: { select: { id: true } } } },
        _count: { select: { likes: true, comments: true } },
      },
    }),
    db.post.count({ where }),
  ]);

  // Related hashtags: co-occurring tags on the matched posts (bounded page).
  const related = new Map<string, number>();
  for (const r of rows) {
    for (const t of safeTags(r.hashtags)) {
      if (t !== name) related.set(t, (related.get(t) ?? 0) + 1);
    }
  }

  return ok({
    tag: { name: hashtag.name, postCount: hashtag.postCount },
    items: rows.map((p) => {
      const first = p.media[0];
      const assetId = first ? (p.mediaKind === "VIDEO" ? (first.posterMediaAsset?.id ?? first.mediaAsset.id) : first.mediaAsset.id) : null;
      return {
        id: p.id,
        body: p.body.slice(0, 200),
        mediaKind: p.mediaKind,
        createdAt: p.createdAt.toISOString(),
        author: { username: p.author.username ?? "", name: p.author.name, avatarUrl: p.author.avatarMediaId ? `/api/media/${p.author.avatarMediaId}/raw` : null },
        thumbUrl: assetId ? `/api/media/${assetId}/raw` : null,
        counts: { likes: p._count.likes, comments: p._count.comments },
      };
    }),
    related: [...related.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t),
    nextCursor: cursor + rows.length < total ? String(cursor + rows.length) : null,
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
