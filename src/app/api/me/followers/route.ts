import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR, parseBody } from "@/lib/api-helpers";
import { toPublicPerson } from "@/lib/serialize";
import type { PublicPerson } from "@/lib/types";

export const dynamic = "force-dynamic";

const otherUserInclude = {
  professions: { include: { profession: true }, orderBy: { profession: { order: "asc" as const } } },
  skills: { include: { skill: true } },
  _count: { select: { followsReceived: true, projects: true } },
} satisfies Prisma.UserInclude;

type OtherUser = Prisma.UserGetPayload<{ include: typeof otherUserInclude }>;

function toPerson(u: OtherUser): PublicPerson {
  return toPublicPerson({
    username: u.username,
    name: u.name,
    headline: u.headline,
    avatarMediaId: u.avatarMediaId,
    location: u.location,
    availability: u.availability,
    professions: u.professions,
    skills: u.skills,
    _count: { followers: u._count.followsReceived, projects: u._count.projects },
  });
}

/** GET /api/me/followers — ACTIVE followers (+ PENDING rows flagged so the UI can distinguish requests from real followers). */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const rows = await db.follow.findMany({
    where: { followingId: user.id },
    include: { follower: { include: otherUserInclude } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const people = rows
    .filter((r) => !r.follower.deletedAt && r.status === "ACTIVE")
    .map((r) => ({ person: toPerson(r.follower), followedAt: r.createdAt.toISOString() }));

  const requests = rows
    .filter((r) => !r.follower.deletedAt && r.status === "PENDING")
    .map((r) => ({ person: toPerson(r.follower), requestedAt: r.createdAt.toISOString() }));

  return ok({ people, requests });
});

/**
 * DELETE /api/me/followers — remove a follower (body: { username }). Deletes
 * any follow edge they hold on you (ACTIVE or PENDING); the removed user is
 * NOT notified (removal is private). Keyed by username so the client never
 * handles opaque user ids.
 */
export const DELETE = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const parsed = await parseBody(req, z.object({ username: z.string().min(1).max(40) }).strict());
  if (parsed.response) return parsed.response;

  const uname = parsed.data.username.trim().toLowerCase();
  const target = await db.user.findFirst({ where: { username: uname, deletedAt: null }, select: { id: true } });
  if (target) {
    await db.follow
      .deleteMany({ where: { followerId: target.id, followingId: user.id } })
      .catch(() => undefined); // idempotent
  }

  return ok({ removed: true });
});
