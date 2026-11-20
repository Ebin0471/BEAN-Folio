import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { transitionStage } from "@/lib/ox/room";
import { mapRoomError, resolveRoomParty, type RoomPartyAccess } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — employer-side stage transition (RD-8/RD-9/RD-10/RD-11).
 * OWNER/ADMIN/RECRUITER plus the ASSIGNED HIRING_MANAGER; every other caller
 * is 404-denied. The engine owns the machine: forward-only with skips,
 * HIRED only from OFFER, terminal transitions close the room atomically,
 * REJECTED requires an approved reason code, `WITHDRAWN` is candidate-only,
 * ON_HOLD rejects writes — each refusal is the approved envelope code with
 * zero writes. The optional `note` (≤500) is employer-private and is never
 * serialized to the candidate or the viewer (RD-11).
 */
type RouteParams = { params: Promise<{ roomId: string }> };

const stageSchema = z
  .object({
    stage: z.string().trim().min(1).max(64),
    reason: z.string().trim().min(1).max(64).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const ALLOWED: RoomPartyAccess[] = ["EMPLOYER_ROLES", "ASSIGNED_MANAGER"];

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { roomId } = await params;

  const parsed = await parseBody(req, stageSchema);
  if (parsed.response) return parsed.response;
  const body = parsed.data;

  const limited = await rateLimitShared(`ox:room-act:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  try {
    const party = await resolveRoomParty(roomId, user.id);
    if (!party.access || !ALLOWED.includes(party.access)) return ERR.notFound();

    await transitionStage({
      roomId,
      actorUserId: user.id,
      actorRole: "EMPLOYER",
      stage: body.stage,
      reason: body.reason,
      note: body.note,
    });
    const room = await db.hiringRoom.findUniqueOrThrow({
      where: { id: roomId },
      select: { id: true, status: true, currentStage: true },
    });
    return ok({ room });
  } catch (e) {
    return mapRoomError(e);
  }
});
