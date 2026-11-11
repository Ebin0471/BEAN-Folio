import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, handler, containsCI } from "@/lib/api-helpers";
import { projectCardInclude, toProjectCard, type ProjectWithCardRelations } from "@/lib/serialize";
import { publicOwnerFilter } from "@/lib/visibility";

export const dynamic = "force-dynamic";

const LIMIT = 12;
/**
 * When a text query is present, results are relevance-ranked over the most
 * recent POOL_SIZE matches (bounded fetch — pagination stays cheap on large
 * datasets). Weaker matches deeper than the pool are not returned; the pool
 * is deliberately generous for a portfolio-catalogue scale.
 */
const POOL_SIZE = 240;

/** Card payload — scalar fields (description included) are always returned. */
type Row = ProjectWithCardRelations;

/**
 * Relevance score for one project against the query. Exact matches in stronger
 * fields always outrank partial matches in weaker fields (tiers, not free sums):
 *   title (exact 100 / prefix 80 / contains 60) > creator name (40/30) >
 *   username (20) > skill tag (40/20) > summary (20) > description (15).
 */
function relevanceScore(row: Row, needle: string): number {
  let score = 0;
  const title = row.title.toLowerCase();
  if (title === needle) score += 100;
  else if (title.startsWith(needle)) score += 80;
  else if (title.includes(needle)) score += 60;

  const ownerName = row.owner.name.toLowerCase();
  if (ownerName === needle) score += 40;
  else if (ownerName.includes(needle)) score += 30;
  if ((row.owner.username ?? "").toLowerCase().includes(needle)) score += 20;

  let bestSkill = 0;
  for (const s of row.skills) {
    const label = s.skill.label.toLowerCase();
    if (label === needle) bestSkill = Math.max(bestSkill, 40);
    else if (label.includes(needle) || s.skill.slug.includes(needle)) bestSkill = Math.max(bestSkill, 20);
  }
  score += bestSkill;

  if (row.summary?.toLowerCase().includes(needle)) score += 20;
  if (row.description?.toLowerCase().includes(needle)) score += 15;
  return score;
}

/**
 * GET /api/search/projects — PUBLIC+PUBLISHED projects only.
 * `q` contains-matches title/summary/description, the creator's name/username,
 * and skill (tag) slugs/labels; `skill` matches slug or label; `category`
 * matches the exact Profession slug; `sort=recent|saved` applies when there is
 * no text query (a text query always ranks by relevance, then recency).
 * Offset-based `cursor`.
 */
export const GET = handler(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;

  const q = (sp.get("q") ?? "").trim();
  if (q.length > 80) return err("Search query must be 80 characters or fewer", 400);
  // Slugs are lowercase everywhere (Profession table) — normalize filter params
  // so " Photography " or "Photography" can never fork into a second category.
  const category = sp.get("category")?.trim().toLowerCase() || null;
  const skill = sp.get("skill")?.trim() || null;
  const sort = sp.get("sort") === "saved" ? "saved" : "recent";
  const cursorRaw = Number.parseInt(sp.get("cursor") ?? "", 10);
  const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : 0;

  const sessionUser = await getSessionUser();
  let blocked: string[] = [];
  if (sessionUser) {
    const rows = await db.block.findMany({
      where: { OR: [{ blockerId: sessionUser.id }, { blockedId: sessionUser.id }] },
      select: { blockerId: true, blockedId: true },
    });
    blocked = Array.from(new Set(rows.map((b) => (b.blockerId === sessionUser.id ? b.blockedId : b.blockerId))));
  }

  const where: Prisma.ProjectWhereInput = {
    status: "PUBLISHED",
    visibility: "PUBLIC",
    // Server-side public ladder (see lib/visibility.ts).
    owner: publicOwnerFilter,
    ...(blocked.length > 0 ? { ownerId: { notIn: blocked } } : {}),
    ...(category ? { category } : {}),
    ...(skill ? { skills: { some: { skill: { OR: [{ slug: skill.toLowerCase() }, { label: skill }] } } } } : {}),
    ...(q
      ? {
          // Engine-aware case-insensitivity (see containsCI in api-helpers).
          OR: [
            { title: containsCI(q) },
            { summary: containsCI(q) },
            { description: containsCI(q) },
            // Creator name / username
            { owner: { name: containsCI(q) } },
            { owner: { username: containsCI(q) } },
            // Skills double as the platform's tags
            { skills: { some: { skill: { OR: [{ slug: containsCI(q) }, { label: containsCI(q) }] } } } },
          ],
        }
      : {}),
  };

  if (!q) {
    // No text query → transparent ordering (recency or real saves), DB-paginated.
    const rows = await db.project.findMany({
      where,
      include: projectCardInclude,
      orderBy:
        sort === "saved"
          ? [{ savedBy: { _count: "desc" } }, { publishedAt: "desc" }]
          : [{ publishedAt: "desc" }],
      skip: cursor,
      take: LIMIT + 1,
    });
    const hasMore = rows.length > LIMIT;
    return ok({
      items: rows.slice(0, LIMIT).map(toProjectCard),
      nextCursor: hasMore ? String(cursor + LIMIT) : null,
    });
  }

  // Text query → relevance ranking over a bounded candidate pool.
  const needle = q.toLowerCase();
  const pool = await db.project.findMany({
    where,
    include: projectCardInclude,
    orderBy: { publishedAt: "desc" },
    take: POOL_SIZE,
  });

  const ranked = pool
    .map((row) => ({ row, score: relevanceScore(row, needle) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.row.publishedAt?.getTime() ?? 0) - (a.row.publishedAt?.getTime() ?? 0) ||
        a.row.id.localeCompare(b.row.id)
    );

  const page = ranked.slice(cursor, cursor + LIMIT);
  return ok({
    items: page.map(({ row }) => toProjectCard(row)),
    nextCursor: cursor + LIMIT < ranked.length ? String(cursor + LIMIT) : null,
  });
});
