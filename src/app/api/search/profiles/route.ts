import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { containsCI, err, getClientKey, handler, ok, rateLimitShared } from "@/lib/api-helpers";
import { toPublicPerson } from "@/lib/serialize";
import { publicProfileBaseFilter } from "@/lib/visibility";

export const dynamic = "force-dynamic";

const LIMIT = 12;
/**
 * When a text query is present, profiles are relevance-ranked over the most
 * recent POOL_SIZE matches (bounded fetch — see /api/search/projects).
 */
const POOL_SIZE = 240;

type Row = Prisma.UserGetPayload<{
  include: {
    professions: { include: { profession: true } };
    skills: { include: { skill: true } };
  };
}>;

/**
 * Relevance tiers for one profile against the query:
 *   name (exact 100 / prefix 80 / contains 60) > headline 50 > profession 40 >
 *   username 30 > skill tag 30 > bio 20.
 */
function relevanceScore(row: Row, needle: string): number {
  let score = 0;
  const name = row.name.toLowerCase();
  if (name === needle) score += 100;
  else if (name.startsWith(needle)) score += 80;
  else if (name.includes(needle)) score += 60;

  if (row.username && row.username.toLowerCase().includes(needle)) score += 30;
  if (row.headline?.toLowerCase().includes(needle)) score += 50;
  if (row.bio?.toLowerCase().includes(needle)) score += 20;

  let bestProfession = 0;
  for (const p of row.professions) {
    if (p.profession.label.toLowerCase().includes(needle) || p.profession.slug.includes(needle))
      bestProfession = Math.max(bestProfession, 40);
  }
  score += bestProfession;

  let bestSkill = 0;
  for (const s of row.skills) {
    if (s.skill.label.toLowerCase().includes(needle) || s.skill.slug.includes(needle))
      bestSkill = Math.max(bestSkill, 30);
  }
  score += bestSkill;
  return score;
}

/**
 * GET /api/search/profiles — PUBLIC onboarded profiles only (never the caller).
 * `q` contains-matches name/username/headline/bio AND profession labels/slugs
 * and skill tags; `profession` by slug; `skill` matches slug or label;
 * offset-based `cursor`. A text query ranks by relevance (then name); without
 * one, ordering is real follower count, then username.
 */
export const GET = handler(async (req: NextRequest) => {
  // Generous public-read budget (M22): 300 req/min/IP — abuse throttle, not a UX limit.
  const limited = await rateLimitShared("read:search:profiles:" + getClientKey(req), 300, 60_000);
  if (limited) return limited;
  const sp = req.nextUrl.searchParams;

  const q = (sp.get("q") ?? "").trim();
  if (q.length > 80) return err("Search query must be 80 characters or fewer", 400);
  const profession = sp.get("profession")?.trim().toLowerCase() || null;
  const skill = sp.get("skill")?.trim() || null;
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

  const excludeIds = sessionUser ? [sessionUser.id, ...blocked] : blocked;

  const where: Prisma.UserWhereInput = {
    username: { not: null },
    profileVisibility: "PUBLIC",
    ...publicProfileBaseFilter, // server-side: no demo fixtures, no deleted accounts
    ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
    ...(profession ? { professions: { some: { profession: { slug: profession } } } } : {}),
    ...(skill ? { skills: { some: { skill: { OR: [{ slug: skill.toLowerCase() }, { label: skill }] } } } } : {}),
    ...(q
      ? {
          // Engine-aware case-insensitivity (see containsCI in api-helpers).
          OR: [
            { name: containsCI(q) },
            { username: containsCI(q) },
            { headline: containsCI(q) },
            { bio: containsCI(q) },
            // Professional fields are searchable text too — searching
            // "photography" finds profiles in that profession.
            { professions: { some: { profession: { OR: [{ slug: containsCI(q) }, { label: containsCI(q) }] } } } },
            { skills: { some: { skill: { OR: [{ slug: containsCI(q) }, { label: containsCI(q) }] } } } },
          ],
        }
      : {}),
  };

  const include = {
    professions: { include: { profession: true }, orderBy: { profession: { order: "asc" as const } } },
    skills: { include: { skill: true } },
  } satisfies Prisma.UserInclude;

  if (!q) {
    const rows = await db.user.findMany({
      where,
      include: { ...include, _count: { select: { followsReceived: true, projects: { where: { status: "PUBLISHED" } } } } },
      orderBy: [{ followsReceived: { _count: "desc" } }, { username: "asc" }],
      skip: cursor,
      take: LIMIT + 1,
    });
    const hasMore = rows.length > LIMIT;
    const items = rows.slice(0, LIMIT).map((row) =>
      toPublicPerson({
        ...row,
        _count: { followers: row._count.followsReceived, projects: row._count.projects },
      })
    );
    return ok({ items, nextCursor: hasMore ? String(cursor + LIMIT) : null });
  }

  // Text query → relevance ranking over a bounded candidate pool.
  const needle = q.toLowerCase();
  const pool = await db.user.findMany({ where, include, take: POOL_SIZE });

  const ranked = pool
    .map((row) => ({ row, score: relevanceScore(row, needle) }))
    .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name) || a.row.id.localeCompare(b.row.id));

  const page = ranked.slice(cursor, cursor + LIMIT);
  if (page.length === 0) return ok({ items: [], nextCursor: null });

  // Stats for the page only (two bounded queries instead of pool-wide counts).
  const stats = await db.user.findMany({
    where: { id: { in: page.map(({ row }) => row.id) } },
    select: {
      id: true,
      _count: { select: { followsReceived: true, projects: { where: { status: "PUBLISHED" } } } },
    },
  });
  const statsById = new Map(stats.map((s) => [s.id, s._count]));

  const items = page.map(({ row }) => {
    const c = statsById.get(row.id) ?? { followsReceived: 0, projects: 0 };
    return toPublicPerson({ ...row, _count: { followers: c.followsReceived, projects: c.projects } });
  });

  return ok({ items, nextCursor: cursor + LIMIT < ranked.length ? String(cursor + LIMIT) : null });
});
