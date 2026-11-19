import { NextRequest, type NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { markInvitationViewed } from "@/lib/ox/invitation";
import { invitationErrorResponse } from "@/lib/ox/invitation";
import { serializeInvitationForCandidate, serializeNegotiation, type StoredInvitationRow } from "@/lib/ox/dto";
import { err } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * M-O6 — candidate invitation detail (plan §9.2, RD-18 + override B).
 *
 * Recipient-only (WHERE binds candidateUserId to the session user; anything
 * else is 404 existence-hiding). The FIRST authorized read performs the
 * automatic SENT → VIEWED transition (audit `ox.invitation.viewed`, actor =
 * the candidate; the employer is NEVER notified for viewing — RD-18);
 * later reads are idempotent. The immutable offer snapshot, the full
 * append-only negotiation thread and the truthful state always render —
 * this is the candidate's own correspondence record and it survives
 * discovery-consent revocation (override B: recipient rights are identity
 * rights, not discovery rights). No profile content exists on this shape.
 */
type RouteParams = { params: Promise<{ invitationId: string }> };

export const GET = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { invitationId } = await params;

  const limited = await rateLimitShared(`ox:me-invitations:${user.id}`, 60, 3600_000);
  if (limited) return limited;

  const row = await db.opportunityInvitation.findFirst({
    where: {
      id: invitationId,
      candidateUserId: user.id,
      // RD-17: drafts are employer-private — a candidate can never see (nor
      // 404-leak) their own would-be invitation before it is sent.
      status: { not: "DRAFT" },
    },
  });
  if (!row) return ERR.notFound(); // 404-deny: not the recipient = unknown

  // RD-18: automatic first-read VIEWED transition (guarded; idempotent).
  try {
    await markInvitationViewed({ invitationId: row.id, candidateUserId: user.id });
  } catch (e) {
    const mapped = invitationErrorResponse(e);
    if (mapped) return err(mapped.message, mapped.status, mapped.code);
    throw e;
  }

  const fresh = (await db.opportunityInvitation.findUniqueOrThrow({
    where: { id: row.id },
  })) as StoredInvitationRow;
  const [organization, opportunity, negotiations] = await Promise.all([
    db.employerOrganization.findUnique({
      where: { id: fresh.organizationId },
      select: { id: true, displayName: true, slug: true },
    }),
    db.opportunity.findUnique({
      where: { id: fresh.opportunityId },
      select: { id: true, title: true, status: true },
    }),
    db.invitationNegotiation.findMany({ where: { invitationId: fresh.id }, orderBy: { seq: "asc" } }),
  ]);

  return ok({
    invitation: serializeInvitationForCandidate(fresh, {
      organization: organization ?? { id: fresh.organizationId, displayName: "Unknown organization", slug: "unknown" },
      opportunity: opportunity ?? { id: fresh.opportunityId, title: "Unknown opportunity", status: "UNKNOWN" },
      negotiations: negotiations.map(serializeNegotiation),
    }),
  });
});
