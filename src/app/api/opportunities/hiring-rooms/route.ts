import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { createRoomForInvitation, HIRING_ROOM_STATUSES } from "@/lib/ox/room";
import { serializeRoomForEmployer, serializeRoomForViewer, type StoredHiringRoomRow } from "@/lib/ox/room-dto";
import { HIRING_ROOM_EMPLOYER_ROLES, mapRoomError, requireRoomEmployerAccess } from "@/lib/ox/room-shared";

export const dynamic = "force-dynamic";

/**
 * M-O7 — employer hiring-rooms collection (RD-1/RD-3/RD-6/RD-21).
 *
 * POST — spawn a room from an ACCEPTED invitation (RD-3: explicit employer
 * creation; acceptance is the immutable join contract). OWNER/ADMIN/
 * RECRUITER only (requireRoomEmployerAccess → 404-deny on role exclusion,
 * non-ACTIVE membership, unknown org; SUSPENDED/NOT_VERIFIED → 403). The
 * tenant-binding organizationId comes from the INVITATION row — never from
 * the client (an employer of another org has no membership here → 404).
 * `candidateTimezone` is IANA-validated by the engine (RD-14 → 400
 * OX_ROOM_INVALID_TIMEZONE). Duplicate creation maps the DB unique to
 * 409 OX_HIRING_ROOM_EXISTS (RD-1).
 *
 * GET — the org-scoped, party-aware room list (RD-21 status/opportunity
 * filters, ordered updatedAt desc, ≤100 rows). OWNER/ADMIN/RECRUITER and an
 * ASSIGNED HIRING_MANAGER receive the employer serializer (compensation
 * snapshot included; mutation rights on); the assigned manager is scoped to
 * the rooms they are assigned to (RD-5 — unassigned rooms stay invisible).
 * ACTIVE org VIEWERs receive the read-only viewer allowlist (RD-6 +
 * clarification A: no compensation, no notes, no links). Non-members and
 * unknown orgs are 404-denied.
 */

const createRoomSchema = z
  .object({
    invitationId: z.string().trim().min(1).max(64),
    candidateTimezone: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const listQuerySchema = z
  .object({
    organizationId: z.string().trim().min(1).max(64),
    status: z.enum(HIRING_ROOM_STATUSES).optional(),
    opportunityId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const LIST_MAX = 100;

export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();

  const parsed = await parseBody(req, createRoomSchema);
  if (parsed.response) return parsed.response;
  const body = parsed.data;

  // RD-3 burst budget: 10 room creations per user per hour.
  const limited = await rateLimitShared(`ox:room-create:${user.id}`, 10, 3600_000);
  if (limited) return limited;

  // Tenant binding: the org is derived from the invitation row itself —
  // client-supplied ids are never trusted. An unknown invitation is a plain
  // 404 (existence hiding, same observable result as every other deny).
  const invitation = await db.opportunityInvitation.findFirst({
    where: { id: body.invitationId },
    select: { id: true, organizationId: true },
  });
  if (!invitation) return ERR.notFound();

  const ctx = await requireRoomEmployerAccess(invitation.organizationId, user.id);
  if (ctx.error) return ctx.error;

  try {
    const roomId = await createRoomForInvitation({
      actorUserId: user.id,
      invitationId: body.invitationId,
      candidateTimezone: body.candidateTimezone,
      organizationId: invitation.organizationId,
    });
    const room = await db.hiringRoom.findUniqueOrThrow({
      where: { id: roomId },
      select: {
        id: true,
        invitationId: true,
        organizationId: true,
        opportunityId: true,
        candidateUserId: true,
        status: true,
        currentStage: true,
      },
    });
    return ok({ room }, 201);
  } catch (e) {
    return mapRoomError(e);
  }
});

export const GET = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const url = new URL(req.url);
  const parsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) return err("Invalid list query", 400, "OX_ROOM_INVALID_QUERY");
  const query = parsed.data;

  const limited = await rateLimitShared(`ox:room-read:${user.id}`, 120, 3600_000);
  if (limited) return limited;

  // Org party stack — the shared employer stack WITHOUT the role prefilter,
  // because RD-6 grants ACTIVE org VIEWERs a read-only list too. Unknown org
  // / non-ACTIVE membership → 404-deny; SUSPENDED → 403; the VERIFIED gate
  // binds the employer-side parties only (the VIEWER grant is membership-
  // based per RD-6).
  const org = await db.employerOrganization.findUnique({ where: { id: query.organizationId } });
  if (!org) return ERR.notFound();
  const membership = await db.employerMembership.findUnique({
    where: { organizationId_userId: { organizationId: query.organizationId, userId: user.id } },
  });
  if (!membership || membership.status !== "ACTIVE") return ERR.notFound();
  if (org.verificationStatus === "SUSPENDED") {
    return err("Organization is suspended", 403, "OX_ORG_SUSPENDED");
  }
  if (org.verificationStatus !== "VERIFIED" && membership.role !== "VIEWER") {
    return err("Employer verification required", 403, "OX_ORG_NOT_VERIFIED");
  }

  const filters = {
    organizationId: query.organizationId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.opportunityId ? { opportunityId: query.opportunityId } : {}),
  };

  if (membership.role === "OWNER" || membership.role === "ADMIN" || membership.role === "RECRUITER") {
    const rooms = await db.hiringRoom.findMany({
      where: filters,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: LIST_MAX,
    });
    return ok({
      rooms: rooms.map((room) =>
        serializeRoomForEmployer(room as StoredHiringRoomRow, {
          includeCompensation: true,
          callerCanMutateRoom: true,
        })
      ),
    });
  }

  if (membership.role === "HIRING_MANAGER") {
    // RD-5: an org HIRING_MANAGER sees exactly the rooms they are assigned
    // to (live membership row) — unassigned rooms stay invisible, mirroring
    // the per-room 404-deny.
    const rooms = await db.hiringRoom.findMany({
      where: { ...filters, members: { some: { userId: user.id, roomRole: "HIRING_MANAGER", removedAt: null } } },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: LIST_MAX,
    });
    return ok({
      rooms: rooms.map((room) =>
        serializeRoomForEmployer(room as StoredHiringRoomRow, {
          includeCompensation: true,
          callerCanMutateRoom: true,
        })
      ),
    });
  }

  // RD-6 + clarification A: ACTIVE org VIEWERs — the read-only allowlist
  // rows (opportunity title included; no compensation, notes, links, members).
  const rooms = await db.hiringRoom.findMany({
    where: filters,
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: LIST_MAX,
  });
  const opportunityCache = new Map<string, { id: string; title: string | null }>();
  const items: Record<string, unknown>[] = [];
  for (const room of rooms) {
    let opportunity = opportunityCache.get(room.opportunityId);
    if (!opportunity) {
      const row = await db.opportunity.findUnique({
        where: { id: room.opportunityId },
        select: { id: true, title: true },
      });
      opportunity = row ?? { id: room.opportunityId, title: null };
      opportunityCache.set(room.opportunityId, opportunity);
    }
    items.push(serializeRoomForViewer(room as StoredHiringRoomRow, opportunity));
  }
  return ok({ rooms: items });
});
