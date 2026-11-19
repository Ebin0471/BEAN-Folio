import { NextRequest, type NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { createCandidateProposal } from "@/lib/ox/invitation";
import { invitationErrorResponse } from "@/lib/ox/invitation";
import { negotiationTermsSchema } from "@/lib/ox/invitation-shared";

export const dynamic = "force-dynamic";

/**
 * M-O6 — candidate counter-proposal (plan §9.2, RD-9: the counter IS the
 * response to a standing employer proposal — the counter supersedes it in
 * the same transaction). Recipient-only; invitation must be
 * NEGOTIATION_REQUESTED; RD-7 rounds cap (6) enforced; append-only history.
 * Audited; employer team notified (RD-13).
 */
type RouteParams = { params: Promise<{ invitationId: string }> };

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { invitationId } = await params;

  const limited = await rateLimitShared(`ox:negotiation-write:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  const parsed = await parseBody(req, negotiationTermsSchema);
  if (parsed.response) return parsed.response;

  const exists = await db.opportunityInvitation.findFirst({
    where: { id: invitationId, candidateUserId: user.id, status: { not: "DRAFT" } },
    select: { id: true },
  });
  if (!exists) return ERR.notFound();

  try {
    const { seq } = await createCandidateProposal({
      invitationId,
      candidateUserId: user.id,
      terms: parsed.data,
    });
    const proposal = await db.invitationNegotiation.findFirstOrThrow({
      where: { invitationId, seq },
      select: { id: true, status: true, expiresAt: true, createdAt: true },
    });
    return ok(
      {
        proposal: {
          id: proposal.id,
          seq,
          status: proposal.status,
          expiresAt: proposal.expiresAt.toISOString(),
          createdAt: proposal.createdAt.toISOString(),
        },
      },
      201
    );
  } catch (e) {
    const mapped = invitationErrorResponse(e);
    if (mapped) return err(mapped.message, mapped.status, mapped.code);
    throw e;
  }
});
