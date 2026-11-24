import { NextRequest, type NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { serializeRoomForCandidate, type StoredHiringRoomRow } from "@/lib/ox/room-dto";

export const dynamic = "force-dynamic";

/**
 * M-O7 — the session candidate's hiring-room list (RD-7/RD-11/RD-15).
 * Recipient-only: rooms are bound to `candidateUserId = session user` —
 * anything else is invisible (no existence leak). Rows are lean (no
 * embedded interviews/stages) and carry NO meeting links (RD-15: links live
 * in the detail view, and only while an interview is PROPOSED/CONFIRMED).
 * Ordered updatedAt desc, ≤100 rows.
 */
export const GET = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const limited = await rateLimitShared(`ox:me-rooms:${user.id}`, 60, 3600_000);
  if (limited) return limited;

  const rooms = await db.hiringRoom.findMany({
    where: { candidateUserId: user.id },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: 100,
  });
  return ok({
    rooms: rooms.map((room) =>
      serializeRoomForCandidate(room as StoredHiringRoomRow, { includeMeetingLink: false })
    ),
  });
});
