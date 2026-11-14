import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { getClientKey, handler, ok, rateLimitShared } from "@/lib/api-helpers";
import { toPublicPerson } from "@/lib/serialize";
import { publicProfileBaseFilter } from "@/lib/visibility";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;

/**
 * GET /api/discover/creators — creators eligible for discovery.
 *
 * Eligibility is tied to publishing: only profiles that are PUBLIC, onboarded,
 * non-deleted, not demo fixtures, AND have at least one PUBLISHED+PUBLIC
 * project are returned. Ordering is newest-first by the creator's most recent
 * publication (explainable — no fabricated popularity).
 */
export const GET = handler(async (req: NextRequest) => {
  // Generous public-read budget (M22): 300 req/min/IP — abuse throttle, not a UX limit.
  const limited = await rateLimitShared("read:discover:creators:" + getClientKey(req), 300, 60_000);
  if (limited) return limited;
  const sp = req.nextUrl.searchParams;
  const limitRaw = Number.parseInt(sp.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : DEFAULT_LIMIT;

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

  const eligibility: Prisma.UserWhereInput = {
    username: { not: null },
    onboarded: true,
    profileVisibility: "PUBLIC",
    ...publicProfileBaseFilter,
    ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
  };

  // Step 1 — latest publication per eligible creator (bounded by # of creators).
  const latestByOwner = await db.project.groupBy({
    by: ["ownerId"],
    where: { status: "PUBLISHED", visibility: "PUBLIC", owner: eligibility },
    _max: { publishedAt: true },
  });
  if (latestByOwner.length === 0) return ok({ items: [] });

  // Step 2 — order newest-first by that publication, take the requested page.
  const ordered = latestByOwner
    .map((row) => ({ ownerId: row.ownerId, latest: row._max.publishedAt }))
    .sort((a, b) => (b.latest?.getTime() ?? 0) - (a.latest?.getTime() ?? 0))
    .slice(0, limit);
  const orderIndex = new Map(ordered.map((o, i) => [o.ownerId, i]));

  const users = await db.user.findMany({
    where: { id: { in: ordered.map((o) => o.ownerId) } },
    include: {
      professions: { include: { profession: true }, orderBy: { profession: { order: "asc" } } },
      skills: { include: { skill: true } },
      _count: { select: { followsReceived: true, projects: { where: { status: "PUBLISHED", visibility: "PUBLIC" } } } },
    },
  });

  const items = users
    .sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
    .map((row) => {
      const person = toPublicPerson({
        ...row,
        _count: { followers: row._count.followsReceived, projects: row._count.projects },
      });
      const latest = ordered.find((o) => o.ownerId === row.id)?.latest ?? null;
      return { ...person, latestPublishedAt: latest ? latest.toISOString() : null };
    });

  return ok({ items });
});
