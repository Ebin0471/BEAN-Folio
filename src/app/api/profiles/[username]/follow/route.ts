import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimit } from "@/lib/api-helpers";

type Ctx = { params: Promise<{ username: string }> };

async function loadTarget(username: string) {
  const uname = username.trim().toLowerCase();
  return db.user.findFirst({ where: { username: uname, deletedAt: null } });
}

export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  // 60 follow/unfollow mutations per minute per account — bounds follow-spam
  // and notification flooding while leaving normal browsing untouched.
  if (!rateLimit(`follow:${sessionUser.id}`, 60, 60_000)) return ERR.rateLimited();

  const { username } = await params;
  const target = await loadTarget(username);
  if (!target) return ERR.notFound();
  if (target.id === sessionUser.id) return err("You cannot follow yourself", 400);

  const block = await db.block.findFirst({
    where: {
      OR: [
        { blockerId: sessionUser.id, blockedId: target.id },
        { blockerId: target.id, blockedId: sessionUser.id },
      ],
    },
  });
  if (block) return ERR.forbidden();

  const existing = await db.follow.findUnique({
    where: { followerId_followingId: { followerId: sessionUser.id, followingId: target.id } },
  });
  if (!existing) {
    await db.follow
      .create({ data: { followerId: sessionUser.id, followingId: target.id } })
      .catch(() => undefined); // concurrent duplicate follow — treat as success
    await db.notification
      .create({
        data: {
          userId: target.id,
          type: "FOLLOW",
          payload: JSON.stringify({ actor: sessionUser.name, actorUsername: sessionUser.username }),
        },
      })
      .catch(() => undefined);
  }

  return ok({ following: true });
});

export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  // Same mutation budget as POST (shared bucket — a follow/unfollow toggle
  // spends from one place).
  if (!rateLimit(`follow:${sessionUser.id}`, 60, 60_000)) return ERR.rateLimited();

  const { username } = await params;
  const target = await loadTarget(username);
  if (!target) return ERR.notFound();

  await db.follow
    .delete({ where: { followerId_followingId: { followerId: sessionUser.id, followingId: target.id } } })
    .catch(() => undefined); // idempotent unfollow

  return ok({ following: false });
});

// Lightweight follow-state probe so shared FollowButton instances can resolve
// their initial state (the full profile GET is heavier and owner-gated).
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  const { username } = await params;
  const target = await loadTarget(username);
  if (!target) return ERR.notFound();

  const follow = await db.follow.findUnique({
    where: { followerId_followingId: { followerId: sessionUser.id, followingId: target.id } },
  });
  return ok({ following: Boolean(follow) });
});
