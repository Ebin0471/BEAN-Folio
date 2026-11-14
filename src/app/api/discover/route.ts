import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { getClientKey, handler, ok, rateLimitShared } from "@/lib/api-helpers";
import { projectCardInclude, toProjectCard } from "@/lib/serialize";
import { publicOwnerFilter } from "@/lib/visibility";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;
const CANDIDATE_POOL = 60;

/** Deterministic 0..0.05 jitter from the project id (stable across requests). */
function jitterFor(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000 * 0.05;
}

/** Block counterparts for the viewer (both directions) — excluded from the feed. */
async function blockedUserIds(userId: string): Promise<string[]> {
  const rows = await db.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });
  return Array.from(
    new Set(rows.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId)))
  );
}

/**
 * GET /api/discover — ranked PUBLIC+PUBLISHED feed.
 * score = recency * engagement + same-profession boost + new-creator boost + deterministic jitter.
 */
export const GET = handler(async (req: NextRequest) => {
  // Generous public-read budget (M22): 300 req/min/IP — abuse throttle, not a UX limit.
  const limited = await rateLimitShared("read:discover:" + getClientKey(req), 300, 60_000);
  if (limited) return limited;
  const sp = req.nextUrl.searchParams;

  const limitRaw = Number.parseInt(sp.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const cursorRaw = Number.parseInt(sp.get("cursor") ?? "", 10);
  const offset = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : 0;
  const category = sp.get("category")?.trim() || null;

  const sessionUser = await getSessionUser();
  const blocked = sessionUser ? await blockedUserIds(sessionUser.id) : [];

  const candidates = await db.project.findMany({
    where: {
      status: "PUBLISHED",
      visibility: "PUBLIC",
      // Server-side public ladder: no drafts, no private/unlisted, no deleted,
      // no demo fixtures, no owner who set their profile to PRIVATE.
      owner: publicOwnerFilter,
      ...(category ? { category } : {}),
      ...(blocked.length > 0 ? { ownerId: { notIn: blocked } } : {}),
    },
    include: projectCardInclude,
    orderBy: { publishedAt: "desc" },
    take: CANDIDATE_POOL,
  });

  if (candidates.length === 0) return ok({ items: [], nextCursor: null });

  // New-creator boost: owners whose ONLY published project is this one (within the candidate set).
  const ownerIds = Array.from(new Set(candidates.map((p) => p.ownerId)));
  const ownerCounts = await db.project.groupBy({
    by: ["ownerId"],
    where: { ownerId: { in: ownerIds }, status: "PUBLISHED" },
    _count: { _all: true },
  });
  const soloCreators = new Set(ownerCounts.filter((c) => c._count._all === 1).map((c) => c.ownerId));

  // Category labels come from the Profession table (real data only).
  const categorySlugs = Array.from(
    new Set(candidates.map((p) => p.category).filter((c): c is string => Boolean(c)))
  );
  const professionRows = categorySlugs.length
    ? await db.profession.findMany({ where: { slug: { in: categorySlugs } }, select: { slug: true, label: true } })
    : [];
  const labelBySlug = new Map(professionRows.map((p) => [p.slug, p.label]));

  // Viewer professions power the same-category boost.
  let viewerProfessions: string[] = [];
  if (sessionUser) {
    const rows = await db.profileProfession.findMany({
      where: { userId: sessionUser.id },
      include: { profession: true },
    });
    viewerProfessions = rows.map((r) => r.profession.slug);
  }

  const now = Date.now();
  const scored = candidates.map((p) => {
    const publishedAt = p.publishedAt ?? p.updatedAt;
    const days = Math.max(0, (now - publishedAt.getTime()) / 86_400_000);
    const recency = Math.exp(-days / 14);
    const engagement = 1 + 0.5 * Math.log1p(p._count.savedBy) + 0.3 * Math.log1p(p._count.views);
    const categoryBoost = Boolean(sessionUser && p.category && viewerProfessions.includes(p.category));
    const newCreator = soloCreators.has(p.ownerId);
    const score = recency * engagement + (categoryBoost ? 0.8 : 0) + (newCreator ? 0.5 : 0) + jitterFor(p.id);

    let reason: string | undefined;
    if (newCreator) {
      reason = "New on BEAN Folio";
    } else if (engagement > 1.4 && p.category) {
      reason = `Popular in ${labelBySlug.get(p.category) ?? p.category}`;
    } else if (categoryBoost && p.category) {
      reason = `Matches your profession: ${labelBySlug.get(p.category) ?? p.category}`;
    }

    return { project: toProjectCard(p), score, reason };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.project.publishedAt ?? "").localeCompare(a.project.publishedAt ?? "") ||
      a.project.id.localeCompare(b.project.id)
  );

  const page = scored.slice(offset, offset + limit);
  const nextCursor = offset + limit < scored.length ? String(offset + limit) : null;

  return ok({
    items: page.map(({ project, reason }) => (reason === undefined ? { project } : { project, reason })),
    nextCursor,
  });
});
