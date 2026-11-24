import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { assignRoomManager } from "@/lib/ox/room";
import { mapRoomError, resolveRoomParty } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — assign the room HIRING_MANAGER (RD-4/RD-5). OWNER/ADMIN/RECRUITER
 * ONLY — the assigned HIRING_MANAGER may NOT manage members and is
 * 404-denied at the route level. The target must be an ACTIVE member of the
 * room's org with an assignable role; org VIEWERs and inactive members
 * refuse with 409 OX_MEMBER_NOT_ACTIVE (engine-enforced). Assignment
 * proceeds while the room is ON_HOLD (pause pauses hiring WORK, not access
 * administration). At most one active manager per room: reassignment
 * soft-removes the previous manager first (audited + notified).
 */
type RouteParams = { params: Promise<{ roomId: string }> };

const assignMemberSchema = z.object({ userId: z.string().trim().min(1).max(64) }).strict();

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { roomId } = await params;

  const parsed = await parseBody(req, assignMemberSchema);
  if (parsed.response) return parsed.response;
  const { userId } = parsed.data;

  const limited = await rateLimitShared(`ox:room-act:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  try {
    // Route-level party enforcement: EMPLOYER_ROLES only (RD-5 — the
    // assigned manager never manages members).
    const party = await resolveRoomParty(roomId, user.id);
    if (party.access !== "EMPLOYER_ROLES") return ERR.notFound();

    const result = await assignRoomManager({ roomId, actorUserId: user.id, targetUserId: userId });
    const member = await db.hiringRoomMember.findUniqueOrThrow({ where: { id: result.memberId } });
    return ok(
      {
        member: {
          id: member.id,
          roomId: member.roomId,
          userId: member.userId,
          roomRole: member.roomRole,
          assignedAt: member.createdAt.toISOString(),
          removedAt: member.removedAt ? member.removedAt.toISOString() : null,
        },
      },
      201
    );
  } catch (e) {
    return mapRoomError(e);
  }
});
