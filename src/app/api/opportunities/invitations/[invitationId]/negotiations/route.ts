import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { createEmployerProposal } from "@/lib/ox/invitation";
import {
  mapInvitationError,
  negotiationTermsSchema,
  requireInvitationEmployer,
} from "@/lib/ox/invitation-shared";

export const dynamic = "force-dynamic";

/**
 * M-O6 — employer negotiation proposal (plan §9.1, RD-9 protocol).
 * The invitation must be NEGOTIATION_REQUESTED; the proposal carries
 * compensation-only absolute terms (RD-8); the RD-7 rounds cap (6) and the
 * one-PENDING supersede protocol are enforced inside the transaction.
 * Append-only: the superseded proposal remains in history untouched.
 * The candidate is notified (RD-12). Audited `ox.negotiation.proposed`.
 *
 * Roles: OWNER/ADMIN/RECRUITER.
 */
type RouteParams = { params: Promise<{ invitationId: string }> };

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { invitationId } = await params;

  const parsed = await parseBody(
    req,
    z
      .object({
        organizationId: z.string().trim().min(1).max(64),
        terms: negotiationTermsSchema,
      })
      .strict()
  );
  if (parsed.response) return parsed.response;
  const body = parsed.data;

  const limited = await rateLimitShared(`ox:negotiation-write:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  const ctx = await requireInvitationEmployer(body.organizationId, user.id);
  if (ctx.error) return ctx.error;

  const exists = await db.opportunityInvitation.findFirst({
    where: { id: invitationId, organizationId: body.organizationId },
    select: { id: true },
  });
  if (!exists) return ERR.notFound();

  try {
    const { seq } = await createEmployerProposal({
      invitationId,
      organizationId: body.organizationId,
      proposerUserId: user.id,
      terms: body.terms,
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
    return mapInvitationError(e);
  }
});
