import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { HIRING_INTERVIEW_TYPES, proposeInterview } from "@/lib/ox/room";
import { mapRoomError, resolveRoomParty, type RoomPartyAccess } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — employer-side interview proposal (RD-12/RD-13/RD-15).
 * OWNER/ADMIN/RECRUITER plus the ASSIGNED HIRING_MANAGER; the candidate
 * proposing is a 404-deny. Window validation is engine-owned (RD-13:
 * endsAt > startsAt, 15 min–4 h, strictly future → 400
 * OX_INTERVIEW_INVALID_WINDOW). `meetingLink` is zod-gated at the boundary
 * (RD-15: https, ≤500 characters — the message references https; the value
 * is never rewritten and never liveness-tested) and handed to the engine.
 */
type RouteParams = { params: Promise<{ roomId: string }> };

const proposeSchema = z
  .object({
    type: z.enum(HIRING_INTERVIEW_TYPES),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    meetingLink: z
      .string()
      .trim()
      .max(500)
      .regex(/^https:\/\/\S+$/, { message: "meetingLink must be an https URL" })
      .optional(),
  })
  .strict();

const ALLOWED: RoomPartyAccess[] = ["EMPLOYER_ROLES", "ASSIGNED_MANAGER"];

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { roomId } = await params;

  const parsed = await parseBody(req, proposeSchema);
  if (parsed.response) return parsed.response;
  const body = parsed.data;

  const limited = await rateLimitShared(`ox:room-act:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  try {
    const party = await resolveRoomParty(roomId, user.id);
    if (!party.access || !ALLOWED.includes(party.access)) return ERR.notFound();

    const { interviewId } = await proposeInterview({
      roomId,
      actorUserId: user.id,
      type: body.type,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      meetingLink: body.meetingLink,
    });
    const interview = await db.interview.findUniqueOrThrow({ where: { id: interviewId } });
    return ok(
      {
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
      },
      201
    );
  } catch (e) {
    return mapRoomError(e);
  }
});
