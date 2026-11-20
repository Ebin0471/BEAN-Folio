import { NextRequest, type NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { confirmInterview } from "@/lib/ox/room";
import { mapRoomError, resolveRoomParty, type RoomPartyAccess } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — interview confirmation (RD-12). Party-resolving: the candidate,
 * the employer roles or the assigned HIRING_MANAGER may call; the ENGINE
 * enforces the confirmation right — ONLY the party opposite
 * `proposedByRole` may confirm, so confirming your own proposal is a 409
 * OX_INTERVIEW_NOT_ACTIONABLE. Guarded PROPOSED → CONFIRMED; races and
 * stale states answer 409 with zero writes.
 */
type RouteParams = { params: Promise<{ roomId: string; interviewId: string }> };

const ALLOWED: RoomPartyAccess[] = ["EMPLOYER_ROLES", "ASSIGNED_MANAGER", "CANDIDATE"];

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { roomId, interviewId } = await params;

  const limited = await rateLimitShared(`ox:room-act:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  try {
    const party = await resolveRoomParty(roomId, user.id);
    if (!party.access || !ALLOWED.includes(party.access)) return ERR.notFound();

    await confirmInterview({ roomId, interviewId, actorUserId: user.id });
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
