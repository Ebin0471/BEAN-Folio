import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { acceptProposal } from "@/lib/ox/invitation";
import { mapInvitationError, requireInvitationEmployer } from "@/lib/ox/invitation-shared";

export const dynamic = "force-dynamic";

/**
 * M-O6 — employer accepts a pending CANDIDATE proposal (plan §9.1, RD-9/RD-10).
 * One atomic transaction: proposal PENDING → ACCEPTED and invitation
 * NEGOTIATION_REQUESTED → ACCEPTED with the accepted-terms snapshot copied
 * EXACTLY from the winning proposal (stamped exactly once). Accepting your
 * own proposal is refused; races (double-accept, accept-vs-withdraw,
 * accept-vs-expiry) collapse deterministically with zero side effects.
 * Audited `ox.negotiation.accepted` + `ox.invitation.accepted`.
 *
 * Roles: OWNER/ADMIN/RECRUITER.
 */
type RouteParams = { params: Promise<{ invitationId: string; negotiationId: string }> };

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { invitationId, negotiationId } = await params;

  const parsed = await parseBody(req, z.object({ organizationId: z.string().trim().min(1).max(64) }).strict());
  if (parsed.response) return parsed.response;
  const { organizationId } = parsed.data;

  const limited = await rateLimitShared(`ox:negotiation-write:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  const ctx = await requireInvitationEmployer(organizationId, user.id);
  if (ctx.error) return ctx.error;

  const invitation = await db.opportunityInvitation.findFirst({
    where: { id: invitationId, organizationId },
    select: { id: true },
  });
  if (!invitation) return ERR.notFound();

  try {
    await acceptProposal({
      invitationId,
      negotiationId,
      acceptorSide: "EMPLOYER",
      organizationId,
      actorUserId: user.id,
    });
    const row = await db.opportunityInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: { id: true, status: true, acceptedAt: true },
    });
    return ok({
      invitation: {
        id: row.id,
        status: row.status,
        acceptedAt: row.acceptedAt?.toISOString() ?? null,
      },
    });
  } catch (e) {
    return mapInvitationError(e);
  }
});
