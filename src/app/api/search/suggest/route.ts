import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { containsCI, getClientKey, handler, ok, rateLimitShared } from "@/lib/api-helpers";
import { publicProfileBaseFilter } from "@/lib/visibility";

export const dynamic = "force-dynamic";

/**
 * GET /api/search/suggest?q= — lightweight autocomplete for the search bar:
 * matching public usernames, hashtag names (real usage counts only) and
 * profession labels. No result bodies — just fast, bounded suggestions.
 */
export const GET = handler(async (req: NextRequest) => {
  // Generous public-read budget (M22): 300 req/min/IP — abuse throttle, not a UX limit.
  const limited = await rateLimitShared("read:search:suggest:" + getClientKey(req), 300, 60_000);
  if (limited) return limited;
  const url = new URL(req.url);
  const raw = (url.searchParams.get("q") ?? "").trim().slice(0, 40).toLowerCase();
  if (raw.length < 2) return ok({ people: [], hashtags: [], professions: [] });
  const tagQuery = raw.replace(/^#/, "");

  const [people, hashtags, professions] = await Promise.all([
    db.user.findMany({
      where: {
        AND: [
          publicProfileBaseFilter,
          { profileVisibility: "PUBLIC", username: { not: null }, onboarded: true },
          { OR: [{ username: containsCI(raw) }, { name: containsCI(raw) }] },
        ],
      },
      select: { username: true, name: true, avatarMediaId: true },
      take: 5,
    }),
    db.hashtag.findMany({
      where: { name: containsCI(tagQuery), postCount: { gt: 0 } },
      orderBy: { postCount: "desc" },
      take: 5,
      select: { name: true, postCount: true },
    }),
    db.profession.findMany({
      where: { active: true, OR: [{ label: containsCI(raw) }, { slug: containsCI(raw) }] },
      orderBy: { order: "asc" },
      take: 4,
      select: { slug: true, label: true },
    }),
  ]);

  return ok({
    people: people.map((p) => ({
      username: p.username ?? "",
      name: p.name,
      avatarUrl: p.avatarMediaId ? `/api/media/${p.avatarMediaId}/raw` : null,
    })),
    hashtags,
    professions,
  });
});
