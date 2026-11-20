import { NextRequest, type NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { getRoomActivityTimeline } from "@/lib/ox/room";
import {
  serializeRoomForCandidate,
  serializeRoomForEmployer,
  serializeRoomForViewer,
  type StoredHiringRoomRow,
} from "@/lib/ox/room-dto";
import { mapRoomError, resolveRoomParty } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — one hiring room, employer namespace (RD-5/RD-6/RD-11/RD-15/RD-22).
 *
 * Party-aware detail — the room is ONE shared resource; every authorization
 * answer is re-derived per request through `resolveRoomParty` and a null
 * access is a 404 (existence-hiding deny: unknown rooms, outsiders, non-
 * ACTIVE memberships, unassigned HIRING_MANAGERs).
 *
 *  - EMPLOYER_ROLES / ASSIGNED_MANAGER → the employer serializer (frozen
 *    terms, members, interviews with meetingLink — both hold room mutation
 *    rights, RD-15), employer-private stage notes included (RD-11).
 *  - VIEWER → the read-only viewer allowlist (vocabulary-only stage history,
 *    NO links, NO compensation, NO notes — RD-6 + clarification A).
 *  - CANDIDATE hitting the employer namespace → the candidate serializer
 *    (reason codes visible, note key structurally absent, link on
 *    PROPOSED/CONFIRMED interviews only — RD-11/RD-15); the candidate's own
 *    me-namespace routes exist for list convenience.
 *
 * Every audience also receives the server-derived activity timeline (RD-16
 * + clarification B; vocabulary-only labels and detail — safe for every
 * party) and the full stage history embedded per audience rules (RD-22).
 */
type RouteParams = { params: Promise<{ roomId: string }> };

export const GET = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { roomId } = await params;

  const limited = await rateLimitShared(`ox:room-read:${user.id}`, 120, 3600_000);
  if (limited) return limited;

  try {
    const party = await resolveRoomParty(roomId, user.id);
    if (!party.access || !party.room) return ERR.notFound();

    const room = (await db.hiringRoom.findUniqueOrThrow({
      where: { id: roomId },
      include: {
        members: true,
        interviews: { orderBy: { createdAt: "asc" } },
        stages: { orderBy: { createdAt: "asc" } },
      },
    })) as unknown as StoredHiringRoomRow;

    const activity = await getRoomActivityTimeline({ roomId });

    if (party.access === "EMPLOYER_ROLES" || party.access === "ASSIGNED_MANAGER") {
      return ok({
        room: serializeRoomForEmployer(room, {
          includeCompensation: true,
          callerCanMutateRoom: true,
        }),
        activity,
      });
    }

    if (party.access === "VIEWER") {
      const opportunity = await db.opportunity.findUnique({
        where: { id: room.opportunityId },
        select: { id: true, title: true },
      });
      return ok({
        room: serializeRoomForViewer(
          room,
          opportunity ? { id: opportunity.id, title: opportunity.title } : undefined
        ),
        activity,
      });
    }

    // CANDIDATE — one shared resource; same body the me-namespace serves.
    return ok({
      room: serializeRoomForCandidate(room, { includeMeetingLink: true }),
      activity,
    });
  } catch (e) {
    return mapRoomError(e);
  }
});
