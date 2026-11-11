import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";
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

/** GET /api/me/followers — everyone who follows the signed-in user. */
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
    .filter((r) => !r.follower.deletedAt)
    .map((r) => toPerson(r.follower));

  return ok({ people });
});
