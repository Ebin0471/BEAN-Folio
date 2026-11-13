import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimit, parseBody } from "@/lib/api-helpers";
import { notify } from "@/lib/notify";

export const dynamic = "force-dynamic";

const actionSchema = z
  .object({
    username: z.string().min(1).max(40), // the requester's username (client never handles opaque ids)
    action: z.enum(["approve", "decline"]),
  })
  .strict();

/**
 * POST /api/me/requests — approve or decline a PENDING follow request.
 * Approve flips the edge to ACTIVE (respondedAt set) and notifies the
 * requester with FOLLOW_ACCEPTED. Decline deletes the edge silently — the
 * requester is never told, the request simply disappears from their view
 * (their follow GET returns NONE again).
 */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  if (!rateLimit(`follow-requests:${user.id}`, 60, 60_000)) return ERR.rateLimited();

  const parsed = await parseBody(req, actionSchema);
  if (parsed.response) return parsed.response;
  const { username, action } = parsed.data;

  const requester = await db.user.findFirst({
    where: { username: username.trim().toLowerCase(), deletedAt: null },
    select: { id: true },
  });
  if (!requester) return err("No pending follow request from this user", 404);
  const requesterId = requester.id;

  const pending = await db.follow.findUnique({
    where: { followerId_followingId: { followerId: requesterId, followingId: user.id } },
    select: { status: true },
  });
  if (!pending || pending.status !== "PENDING") return err("No pending follow request from this user", 404);

  if (action === "approve") {
    await db.follow.update({
      where: { followerId_followingId: { followerId: requesterId, followingId: user.id } },
      data: { status: "ACTIVE", respondedAt: new Date() },
    });
    await notify({
      userId: requesterId,
      actorId: user.id,
      type: "FOLLOW_ACCEPTED",
      targetId: user.id,
      dedupKey: `follow-accepted:${user.id}:${requesterId}`,
      payload: { actor: user.name, actorUsername: user.username },
    });
    return ok({ state: "ACTIVE" });
  }

  await db.follow.delete({
    where: { followerId_followingId: { followerId: requesterId, followingId: user.id } },
  });
  return ok({ state: "NONE" });
});
