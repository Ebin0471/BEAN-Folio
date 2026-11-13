import { db } from "@/lib/db";
import { ok, handler } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/hashtags/trending — real hashtag usage across PUBLIC published
 * posts (postCount is maintained on post create/edit/delete, so private
 * posts and drafts never leak into discovery). Ranked by usage with a
 * freshness tiebreak; abuse-resistant because tags are creator-curated,
 * capped per post (MAX_HASHTAGS) and structurally deduped (composite PK).
 */
export const GET = handler(async () => {
  const rows = await db.hashtag.findMany({
    where: { postCount: { gt: 0 } },
    orderBy: [{ postCount: "desc" }, { lastUsedAt: "desc" }],
    take: 12,
    select: { name: true, postCount: true, lastUsedAt: true },
  });

  return ok({
    items: rows.map((h) => ({
      name: h.name,
      postCount: h.postCount,
      lastUsedAt: h.lastUsedAt.toISOString(),
    })),
  });
});
