import { NextRequest, type NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { resumeRoom } from "@/lib/ox/room";
import { mapRoomError, resolveRoomParty, type RoomPartyAccess } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — resume a room (RD-2): ON_HOLD → ACTIVE. OWNER/ADMIN/RECRUITER plus
 * the ASSIGNED HIRING_MANAGER; every other caller is 404-denied. Guarded
 * transition in the engine — anything but ON_HOLD answers 409
 * OX_ROOM_NOT_ACTIONABLE with zero writes.
 */
type RouteParams = { params: Promise<{ roomId: string }> };

const ALLOWED: RoomPartyAccess[] = ["EMPLOYER_ROLES", "ASSIGNED_MANAGER"];

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { roomId } = await params;

  const limited = await rateLimitShared(`ox:room-act:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  try {
    const party = await resolveRoomParty(roomId, user.id);
    if (!party.access || !ALLOWED.includes(party.access)) return ERR.notFound();

    await resumeRoom({ roomId, actorUserId: user.id });
    const room = await db.hiringRoom.findUniqueOrThrow({
      where: { id: roomId },
      select: { id: true, status: true, currentStage: true },
    });
    return ok({ room });
  } catch (e) {
    return mapRoomError(e);
  }
});
