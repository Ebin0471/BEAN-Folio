import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { declineProposal } from "@/lib/ox/invitation";
import { mapInvitationError, requireInvitationEmployer } from "@/lib/ox/invitation-shared";

export const dynamic = "force-dynamic";

/**
 * M-O6 — employer declines the standing CANDIDATE proposal (RD-7 symmetric
 * rule: declining the standing proposal DECLINES the invitation — anyone who
 * wants to keep talking counters instead). One atomic transaction: proposal
 * PENDING → DECLINED and invitation NEGOTIATION_REQUESTED → DECLINED.
 * Append-only history preserved. Audited.
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
    await declineProposal({
      invitationId,
      negotiationId,
      declinerSide: "EMPLOYER",
      organizationId,
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
    return mapInvitationError(e);
  }
});
