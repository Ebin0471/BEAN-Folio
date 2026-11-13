import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { isProfilePubliclyVisible, publicProfileBaseFilter } from "@/lib/visibility";
import { activeFollowerWhere, followerCountsFor } from "@/lib/social";
import { toPublicPerson } from "@/lib/serialize";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ username: string }> };

const otherUserInclude = {
  professions: { include: { profession: true }, orderBy: { profession: { order: "asc" as const } } },
  skills: { include: { skill: true } },
} satisfies Prisma.UserInclude;

async function loadProfile(username: string) {
  const uname = username.trim().toLowerCase();
  return db.user.findFirst({
    where: { username: uname, ...publicProfileBaseFilter },
    select: { id: true, isDemo: true, deletedAt: true, profileVisibility: true, username: true },
  });
}

/**
 * GET /api/profiles/:username/followers — ACTIVE followers of a publicly
 * visible profile (the owner also sees their own lists). Members whose own
 * accounts are private/deleted/demo are filtered out by the same visibility
 * ladder — a list never reveals a hidden identity.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const { username } = await params;
  const sessionUser = await getSessionUser();
  const profile = await loadProfile(username);
  if (!profile) return ERR.notFound();
  const isSelf = Boolean(sessionUser && profile.id === sessionUser.id);
  if (!isProfilePubliclyVisible(profile, isSelf)) return ERR.notFound();

  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 30));
  const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);

  const rows = await db.follow.findMany({
    where: activeFollowerWhere(profile.id),
    include: { follower: { include: otherUserInclude } },
    orderBy: { createdAt: "desc" },
    skip: cursor,
    take: limit + 1,
  });

  const visible = rows.filter((r) => isProfilePubliclyVisible(r.follower, false)).slice(0, limit);
  const counts = await followerCountsFor(visible.map((r) => r.follower.id));

  return ok({
    people: visible.map((r) =>
      toPublicPerson({
        username: r.follower.username,
        name: r.follower.name,
        headline: r.follower.headline,
        avatarMediaId: r.follower.avatarMediaId,
        location: r.follower.location,
        availability: r.follower.availability,
        professions: r.follower.professions,
        skills: r.follower.skills,
        _count: { followers: counts.get(r.follower.id) ?? 0, projects: 0 },
      })
    ),
    nextCursor: rows.length > limit ? String(cursor + limit) : null,
  });
});
