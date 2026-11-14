import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { getClientKey, handler, ok, rateLimitShared } from "@/lib/api-helpers";
import { publicProfileBaseFilter, publicOwnerFilter } from "@/lib/visibility";
import { publicPostFilter } from "@/lib/posts";
import { containsCI } from "@/lib/api-helpers";
import { recordSearch } from "@/lib/search-history";

export const dynamic = "force-dynamic";

/**
 * GET /api/search/all?q= — unified search across people, posts and hashtags
 * (top matches per surface). Only publicly discoverable content is served —
 * private posts, drafts and hidden accounts never appear in search results.
 * Signed-in searches are recorded in the user's private history (clearable).
 */

export const GET = handler(async (req: NextRequest) => {
  // Generous public-read budget (M22): 300 req/min/IP — abuse throttle, not a UX limit.
  const limited = await rateLimitShared("read:search:all:" + getClientKey(req), 300, 60_000);
  if (limited) return limited;
  const url = new URL(req.url);
  const raw = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  if (raw.length === 0) return ok({ people: [], posts: [], hashtags: [] });
  const q = raw.toLowerCase();
  const tagQuery = q.replace(/^#/, "");

  const viewer = await getSessionUser();

  const [people, posts, hashtags] = await Promise.all([
    db.user.findMany({
      where: {
        AND: [
          publicProfileBaseFilter,
          { profileVisibility: "PUBLIC", username: { not: null }, onboarded: true },
          { OR: [{ username: containsCI(q) }, { name: containsCI(q) }, { headline: containsCI(q) }] },
        ],
      },
      select: {
        username: true, name: true, headline: true, avatarMediaId: true, location: true, availability: true,
        professions: { select: { profession: { select: { slug: true } } } },
        skills: { select: { skill: { select: { label: true } } } },
        _count: { select: { followsReceived: { where: { status: "ACTIVE" } }, projects: true } },
      },
      take: 6,
    }),
    db.post.findMany({
      where: {
        AND: [
          publicPostFilter,
          { author: publicOwnerFilter },
          { OR: [{ body: containsCI(q) }, { hashtags: containsCI(tagQuery) }, { location: containsCI(q) }] },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { id: true, body: true, mediaKind: true, createdAt: true, hashtags: true, author: { select: { username: true, name: true, avatarMediaId: true } }, media: { orderBy: { order: "asc" }, take: 1, include: { mediaAsset: { select: { id: true, kind: true } }, posterMediaAsset: { select: { id: true } } } } },
    }),
    db.hashtag.findMany({
      where: { name: containsCI(tagQuery), postCount: { gt: 0 } },
      orderBy: { postCount: "desc" },
      take: 6,
      select: { name: true, postCount: true },
    }),
  ]);

  void recordSearch(viewer?.id ?? null, raw, "all");

  return ok({
    people: people.map((p) => ({
      username: p.username ?? "",
      name: p.name,
      headline: p.headline,
      avatarUrl: p.avatarMediaId ? `/api/media/${p.avatarMediaId}/raw` : null,
      location: p.location,
      availability: p.availability ?? null,
      professions: p.professions.map((x) => x.profession.slug),
      skills: p.skills.map((x) => x.skill.label),
      stats: { followers: p._count.followsReceived, projects: p._count.projects },
    })),
    posts: posts.map((p) => {
      const first = p.media[0];
      const assetId = first ? (p.mediaKind === "VIDEO" ? (first.posterMediaAsset?.id ?? first.mediaAsset.id) : first.mediaAsset.id) : null;
      return {
        id: p.id,
        body: p.body.slice(0, 160),
        mediaKind: p.mediaKind,
        hashtags: safeTags(p.hashtags).slice(0, 4),
        createdAt: p.createdAt.toISOString(),
        author: { username: p.author.username ?? "", name: p.author.name, avatarUrl: p.author.avatarMediaId ? `/api/media/${p.author.avatarMediaId}/raw` : null },
        thumbUrl: assetId ? `/api/media/${assetId}/raw` : null,
      };
    }),
    hashtags,
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
