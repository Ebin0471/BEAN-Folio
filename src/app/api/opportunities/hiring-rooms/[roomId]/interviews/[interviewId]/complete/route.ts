import { NextRequest, type NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { completeInterview } from "@/lib/ox/room";
import { mapRoomError, resolveRoomParty, type RoomPartyAccess } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — mark an interview COMPLETED (RD-12). EMPLOYER side only
 * (OWNER/ADMIN/RECRUITER plus the ASSIGNED HIRING_MANAGER) — a candidate
 * caller is 404-denied at the route level. CONFIRMED → COMPLETED via a
 * guarded write with `completedAt` (the one operation allowed to record a
 * past-time event); anything but CONFIRMED answers 409
 * OX_INTERVIEW_NOT_ACTIONABLE with zero writes.
 */
type RouteParams = { params: Promise<{ roomId: string; interviewId: string }> };

const ALLOWED: RoomPartyAccess[] = ["EMPLOYER_ROLES", "ASSIGNED_MANAGER"];

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

    await completeInterview({ roomId, interviewId, actorUserId: user.id });
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
