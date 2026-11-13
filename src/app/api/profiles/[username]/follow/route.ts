import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimit } from "@/lib/api-helpers";
import { isPrivateAccount, relationshipBetween, blockedEitherWay, mutualFollows } from "@/lib/social";
import { notify } from "@/lib/notify";
import { toPublicPerson } from "@/lib/serialize";

type Ctx = { params: Promise<{ username: string }> };

async function loadTarget(username: string) {
  const uname = username.trim().toLowerCase();
  return db.user.findFirst({ where: { username: uname, deletedAt: null } });
}

/**
 * POST /api/profiles/:username/follow — follow a creator.
 * Public accounts follow instantly (ACTIVE edge). Private accounts produce a
 * PENDING follow request the target must approve. Composite PK makes
 * duplicate edges structurally impossible; notifications are deduped via the
 * notify engine and never fire for self-follows or suppressed pairs.
 */
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

  if (await blockedEitherWay(sessionUser.id, target.id)) return ERR.forbidden();

  const existing = await db.follow.findUnique({
    where: { followerId_followingId: { followerId: sessionUser.id, followingId: target.id } },
  });
  if (!existing) {
    const pending = isPrivateAccount(target);
    await db.follow
      .create({
        data: {
          followerId: sessionUser.id,
          followingId: target.id,
          status: pending ? "PENDING" : "ACTIVE",
          ...(pending ? {} : { respondedAt: new Date() }),
        },
      })
      .catch(() => undefined); // concurrent duplicate follow — treat as success

    if (pending) {
      await notify({
        userId: target.id,
        actorId: sessionUser.id,
        type: "FOLLOW_REQUEST",
        targetId: sessionUser.id,
        dedupKey: `follow-request:${sessionUser.id}:${target.id}`,
        payload: { actor: sessionUser.name, actorUsername: sessionUser.username },
      });
    } else {
      await notify({
        userId: target.id,
        actorId: sessionUser.id,
        type: "FOLLOW",
        targetId: sessionUser.id,
        dedupKey: `follow:${sessionUser.id}:${target.id}`,
        payload: { actor: sessionUser.name, actorUsername: sessionUser.username },
      });
    }
  }

  const now = await db.follow.findUnique({
    where: { followerId_followingId: { followerId: sessionUser.id, followingId: target.id } },
    select: { status: true },
  });
  return ok({ state: now?.status ?? "ACTIVE" });
});

/** DELETE — cancel a follow or withdraw a pending request (idempotent). */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  if (!rateLimit(`follow:${sessionUser.id}`, 60, 60_000)) return ERR.rateLimited();

  const { username } = await params;
  const target = await loadTarget(username);
  if (!target) return ERR.notFound();

  await db.follow
    .delete({ where: { followerId_followingId: { followerId: sessionUser.id, followingId: target.id } } })
    .catch(() => undefined); // idempotent unfollow

  return ok({ state: "NONE" });
});

/**
 * GET — relationship probe for FollowButton instances: the viewer's follow
 * state (NONE | PENDING | ACTIVE), whether the target follows them back and
 * (when the target is publicly visible) a small mutual-followers sample.
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  const { username } = await params;
  const target = await loadTarget(username);
  if (!target) return ERR.notFound();

  const rel = await relationshipBetween(sessionUser.id, target.id);
  const mutuals = await mutualFollows(sessionUser.id, target.id, 3);

  return ok({
    state: rel.following,
    followedBy: rel.followedBy,
    muted: rel.muted,
    restricted: rel.restricted,
    mutuals: mutuals.map((m) =>
      toPublicPerson({
        username: m.username,
        name: m.name,
        headline: m.headline,
        avatarMediaId: m.avatarMediaId,
        location: null,
        availability: null,
        professions: [],
        skills: [],
        _count: { followers: 0, projects: 0 },
      })
    ),
  });
});
