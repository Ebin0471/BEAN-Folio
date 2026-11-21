import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requestNegotiation } from "@/lib/ox/invitation";
import { invitationErrorResponse } from "@/lib/ox/invitation";
import { negotiationTermsSchema } from "@/lib/ox/invitation-shared";

export const dynamic = "force-dynamic";

/**
 * M-O6 — candidate requests negotiation (plan §9.2): guarded
 * {SENT,VIEWED} → NEGOTIATION_REQUESTED with an optional immediate
 * compensation-only candidate proposal (becomes seq 1 under the RD-9
 * protocol). Recipient-only; override B: consent is never consulted here.
 * Audited; employer team notified (decision NEGOTIATION_REQUESTED and, when
 * terms are included, the proposal event — RD-13).
 */
type RouteParams = { params: Promise<{ invitationId: string }> };

const bodySchema = z
  .object({
    // Optional immediate candidate proposal (compensation-only, RD-8).
    terms: negotiationTermsSchema.optional(),
  })
  .strict();

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { invitationId } = await params;

  const limited = await rateLimitShared(`ox:invitation-respond:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  const parsed = await parseBody(req, bodySchema);
  if (parsed.response) return parsed.response;

  const exists = await db.opportunityInvitation.findFirst({
    where: { id: invitationId, candidateUserId: user.id, status: { not: "DRAFT" } },
    select: { id: true },
  });
  if (!exists) return ERR.notFound();

  try {
    const { seq } = await requestNegotiation({
      invitationId,
      candidateUserId: user.id,
      ...(parsed.data.terms ? { terms: parsed.data.terms } : {}),
    });
    const row = await db.opportunityInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: { id: true, status: true, respondedAt: true },
    });
    return ok({
      invitation: {
        id: row.id,
        status: row.status,
        respondedAt: row.respondedAt?.toISOString() ?? null,
      },
      ...(seq !== null ? { proposalSeq: seq } : {}),
    });
  } catch (e) {
    const mapped = invitationErrorResponse(e);
    if (mapped) return err(mapped.message, mapped.status, mapped.code);
    throw e;
  }
});
