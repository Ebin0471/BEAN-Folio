import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { cancelRoom } from "@/lib/ox/room";
import { mapRoomError, resolveRoomParty } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — outcome-less employer closure (RD-2/RD-8/RD-11): OWNER/ADMIN/
 * RECRUITER ONLY. The ASSIGNED HIRING_MANAGER is explicitly NOT authorized
 * on this route (close/cancel excludes the manager) and is 404-denied here
 * at the route level — matching the engine's own party gate. `reason` is
 * REQUIRED from the approved room-cancellation vocabulary (the engine
 * refuses anything else with 400 OX_ROOM_INVALID_REASON); the terminal
 * CANCELLED status carries the reason and never reopens.
 */
type RouteParams = { params: Promise<{ roomId: string }> };

const cancelRoomSchema = z.object({ reason: z.string().trim().min(1).max(64) }).strict();

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { roomId } = await params;

  const parsed = await parseBody(req, cancelRoomSchema);
  if (parsed.response) return parsed.response;
  const { reason } = parsed.data;

  const limited = await rateLimitShared(`ox:room-act:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  try {
    // Route-level party enforcement: EMPLOYER_ROLES only (RD-2 — cancel
    // excludes the assigned HIRING_MANAGER; ASSIGNED_MANAGER is 404-denied).
    const party = await resolveRoomParty(roomId, user.id);
    if (party.access !== "EMPLOYER_ROLES") return ERR.notFound();

    await cancelRoom({ roomId, actorUserId: user.id, reason });
    const room = await db.hiringRoom.findUniqueOrThrow({
      where: { id: roomId },
      select: { id: true, status: true, currentStage: true },
    });
    return ok({ room });
  } catch (e) {
    return mapRoomError(e);
  }
});
