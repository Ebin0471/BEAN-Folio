import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { rescheduleInterview } from "@/lib/ox/room";
import { mapRoomError, resolveRoomParty, type RoomPartyAccess } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — reschedule a CONFIRMED interview (RD-12/RD-13). Party-resolving —
 * either side may reschedule. The interview returns to PROPOSED under the
 * RESCHEDULING party's role (the other side now holds the confirmation
 * right). Window validation is engine-owned (RD-13 → 400
 * OX_INTERVIEW_INVALID_WINDOW); anything but CONFIRMED answers 409
 * OX_INTERVIEW_NOT_ACTIONABLE with zero writes.
 */
type RouteParams = { params: Promise<{ roomId: string; interviewId: string }> };

const rescheduleSchema = z.object({ startsAt: z.coerce.date(), endsAt: z.coerce.date() }).strict();

const ALLOWED: RoomPartyAccess[] = ["EMPLOYER_ROLES", "ASSIGNED_MANAGER", "CANDIDATE"];

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { roomId, interviewId } = await params;

  const parsed = await parseBody(req, rescheduleSchema);
  if (parsed.response) return parsed.response;
  const body = parsed.data;

  const limited = await rateLimitShared(`ox:room-act:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  try {
    const party = await resolveRoomParty(roomId, user.id);
    if (!party.access || !ALLOWED.includes(party.access)) return ERR.notFound();

    await rescheduleInterview({
      roomId,
      interviewId,
      actorUserId: user.id,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
    });
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
