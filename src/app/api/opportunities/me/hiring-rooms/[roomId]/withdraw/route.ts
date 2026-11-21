import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { withdrawFromRoom } from "@/lib/ox/room";
import { mapRoomError } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — candidate withdrawal (RD-7). Candidate-only: the ENGINE resolves
 * the room party and 404-denies every non-candidate caller (employers
 * included). Allowed while the room is ACTIVE or ON_HOLD; `reason` is
 * REQUIRED from the approved withdrawal vocabulary (400
 * OX_ROOM_INVALID_REASON otherwise). The engine atomically sets the
 * terminal CANDIDATE_WITHDRAWN status, appends the WITHDRAWN stage event
 * (actorRole CANDIDATE), auto-cancels live PROPOSED/CONFIRMED interviews
 * (zero deletion — rows remain with the cause on the audit meta) and
 * notifies the employer team AFTER commit. Rooms are never reopened; a
 * re-invited candidate gets a NEW room via M-O6 (out of scope here).
 */
type RouteParams = { params: Promise<{ roomId: string }> };

const withdrawSchema = z.object({ reason: z.string().trim().min(1).max(64) }).strict();

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { roomId } = await params;

  const parsed = await parseBody(req, withdrawSchema);
  if (parsed.response) return parsed.response;
  const { reason } = parsed.data;

  const limited = await rateLimitShared(`ox:room-act:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  try {
    await withdrawFromRoom({ roomId, actorUserId: user.id, reason });
    const room = await db.hiringRoom.findUniqueOrThrow({
      where: { id: roomId },
      select: { id: true, status: true, currentStage: true },
    });
    return ok({ room });
  } catch (e) {
    return mapRoomError(e);
  }
});
