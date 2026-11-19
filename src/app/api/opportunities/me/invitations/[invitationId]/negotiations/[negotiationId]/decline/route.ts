import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { declineProposal } from "@/lib/ox/invitation";
import { invitationErrorResponse } from "@/lib/ox/invitation";
import { err } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * M-O6 — candidate rejects the pending EMPLOYER proposal (plan §9.2 "accept/
 * reject current proposal"; RD-7 symmetric rule): proposal PENDING →
 * DECLINED and invitation NEGOTIATION_REQUESTED → DECLINED in one atomic
 * transaction (declining the standing proposal declines the invitation —
 * anyone who wants to keep talking counters instead). Recipient-only;
 * append-only history preserved; audited; employer team notified (RD-13).
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
    await declineProposal({
      invitationId,
      negotiationId,
      declinerSide: "CANDIDATE",
      candidateUserId: user.id,
      actorUserId: user.id,
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
    });
  } catch (e) {
    const mapped = invitationErrorResponse(e);
    if (mapped) return err(mapped.message, mapped.status, mapped.code);
    throw e;
  }
});
