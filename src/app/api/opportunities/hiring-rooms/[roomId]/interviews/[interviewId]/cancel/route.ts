import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { cancelInterview } from "@/lib/ox/room";
import { mapRoomError, resolveRoomParty, type RoomPartyAccess } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — cancel an interview (RD-12/RD-11). Party-resolving — either side
 * may cancel a PROPOSED or CONFIRMED interview. `reason` is REQUIRED from
 * the approved interview-cancellation vocabulary (the engine refuses
 * anything else with 400 OX_ROOM_INVALID_REASON). Guarded write stamps
 * `cancelledByUserId` + `cancelReason`; terminal/absent interviews answer
 * 404/409 with zero writes.
 */
type RouteParams = { params: Promise<{ roomId: string; interviewId: string }> };

const cancelSchema = z.object({ reason: z.string().trim().min(1).max(64) }).strict();

const ALLOWED: RoomPartyAccess[] = ["EMPLOYER_ROLES", "ASSIGNED_MANAGER", "CANDIDATE"];

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { roomId, interviewId } = await params;

  const parsed = await parseBody(req, cancelSchema);
  if (parsed.response) return parsed.response;
  const { reason } = parsed.data;

  const limited = await rateLimitShared(`ox:room-act:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  try {
    const party = await resolveRoomParty(roomId, user.id);
    if (!party.access || !ALLOWED.includes(party.access)) return ERR.notFound();

    await cancelInterview({ roomId, interviewId, actorUserId: user.id, reason });
    const interview = await db.interview.findUniqueOrThrow({ where: { id: interviewId } });
    return ok({
      interview: {
        id: interview.id,
        roomId: interview.roomId,
        type: interview.type,
        status: interview.status,
        startsAt: interview.startsAt.toISOString(),
        endsAt: interview.endsAt.toISOString(),
        proposedByRole: interview.proposedByRole,
        cancelReason: interview.cancelReason,
        completedAt: interview.completedAt ? interview.completedAt.toISOString() : null,
      },
    });
  } catch (e) {
    return mapRoomError(e);
  }
});
