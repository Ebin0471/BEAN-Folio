import { NextRequest, type NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { getRoomActivityTimeline } from "@/lib/ox/room";
import { serializeRoomForCandidate, type StoredHiringRoomRow } from "@/lib/ox/room-dto";
import { mapRoomError } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — the session candidate's own room detail (RD-7/RD-11/RD-15/RD-22).
 * 404-deny unless `room.candidateUserId === session user` (existence
 * hiding). The candidate serializer exposes reason CODES but structurally
 * strips the employer-private `note` (the key never appears — RD-11), the
 * frozen terms (the room never re-exposes money — RD-18 payload rule) and
 * any member data. Interviews carry the meetingLink only while
 * PROPOSED/CONFIRMED (RD-15). The activity timeline is candidate-safe by
 * construction: labels are vocabulary-derived and its detail keys are an
 * id/vocabulary allowlist in the engine (TIMELINE_DETAIL_KEYS — note text,
 * links and money cannot reach it), so the candidate may receive it.
 */
type RouteParams = { params: Promise<{ roomId: string }> };

export const GET = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { roomId } = await params;

  const limited = await rateLimitShared(`ox:me-rooms:${user.id}`, 60, 3600_000);
  if (limited) return limited;

  try {
    const room = await db.hiringRoom.findFirst({
      where: { id: roomId, candidateUserId: user.id },
      select: { id: true },
    });
    if (!room) return ERR.notFound(); // 404-deny: not the recipient = unknown

    const full = (await db.hiringRoom.findUniqueOrThrow({
      where: { id: roomId },
      include: {
        interviews: { orderBy: { createdAt: "asc" } },
        stages: { orderBy: { createdAt: "asc" } },
      },
    })) as unknown as StoredHiringRoomRow;

    const activity = await getRoomActivityTimeline({ roomId });

    return ok({
      room: serializeRoomForCandidate(full, { includeMeetingLink: true }),
      activity,
    });
  } catch (e) {
    return mapRoomError(e);
  }
});
