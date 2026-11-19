import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { withdrawProposal } from "@/lib/ox/invitation";
import { mapInvitationError, requireInvitationEmployer } from "@/lib/ox/invitation-shared";

export const dynamic = "force-dynamic";

/**
 * M-O6 — employer withdraws their OWN pending proposal (plan §9.1, RD-9):
 * proposal PENDING → WITHDRAWN; the invitation stays NEGOTIATION_REQUESTED
 * and the counterparty may counter. Append-only history preserved; only the
 * proposer can withdraw. Audited `ox.negotiation.withdrawn`.
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
    await withdrawProposal({
      invitationId,
      negotiationId,
      withdrawerSide: "EMPLOYER",
      organizationId,
      actorUserId: user.id,
    });
    const proposal = await db.invitationNegotiation.findUniqueOrThrow({
      where: { id: negotiationId },
      select: { id: true, seq: true, status: true, decidedAt: true },
    });
    return ok({
      proposal: {
        id: proposal.id,
        seq: proposal.seq,
        status: proposal.status,
        decidedAt: proposal.decidedAt?.toISOString() ?? null,
      },
    });
  } catch (e) {
    return mapInvitationError(e);
  }
});
