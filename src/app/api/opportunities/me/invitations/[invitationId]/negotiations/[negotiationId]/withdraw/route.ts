import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { withdrawProposal } from "@/lib/ox/invitation";
import { invitationErrorResponse } from "@/lib/ox/invitation";
import { err } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * M-O6 — candidate withdraws their OWN pending proposal (plan §9.2, RD-9):
 * proposal PENDING → WITHDRAWN; the invitation stays NEGOTIATION_REQUESTED
 * and the employer may counter. Recipient-only; only the proposer can
 * withdraw; append-only history preserved. Audited.
 */
type RouteParams = { params: Promise<{ invitationId: string; negotiationId: string }> };

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { invitationId, negotiationId } = await params;

  const limited = await rateLimitShared(`ox:negotiation-write:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  const parsed = await parseBody(req, z.object({}).strict());
  if (parsed.response) return parsed.response;

  const invitation = await db.opportunityInvitation.findFirst({
    where: { id: invitationId, candidateUserId: user.id, status: { not: "DRAFT" } },
    select: { id: true },
  });
  if (!invitation) return ERR.notFound();

  try {
    await withdrawProposal({
      invitationId,
      negotiationId,
      withdrawerSide: "CANDIDATE",
      candidateUserId: user.id,
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
    const mapped = invitationErrorResponse(e);
    if (mapped) return err(mapped.message, mapped.status, mapped.code);
    throw e;
  }
});
