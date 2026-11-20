import { NextRequest, type NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { removeRoomMember } from "@/lib/ox/room";
import { mapRoomError, resolveRoomParty } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — soft-remove a room member (RD-4). OWNER/ADMIN/RECRUITER ONLY
 * (route-level party enforcement; the assigned HIRING_MANAGER is
 * 404-denied). Rows are NEVER deleted — `removedAt` is stamped instead
 * (append-only membership trail); a missing or already-removed member is a
 * 404. The removed manager loses their room powers immediately (RD-5).
 */
type RouteParams = { params: Promise<{ roomId: string; memberId: string }> };

export const DELETE = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { roomId, memberId } = await params;

  const limited = await rateLimitShared(`ox:room-act:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  try {
    // Route-level party enforcement: EMPLOYER_ROLES only (RD-5).
    const party = await resolveRoomParty(roomId, user.id);
    if (party.access !== "EMPLOYER_ROLES") return ERR.notFound();

    await removeRoomMember({ roomId, actorUserId: user.id, memberId });
    const member = await db.hiringRoomMember.findUniqueOrThrow({ where: { id: memberId } });
    return ok({
      member: {
        id: member.id,
        roomId: member.roomId,
        userId: member.userId,
        roomRole: member.roomRole,
        assignedAt: member.createdAt.toISOString(),
        removedAt: member.removedAt ? member.removedAt.toISOString() : null,
      },
    });
  } catch (e) {
    return mapRoomError(e);
  }
});
