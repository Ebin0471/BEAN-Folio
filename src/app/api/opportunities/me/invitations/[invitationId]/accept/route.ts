import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { acceptInvitationDirectly } from "@/lib/ox/invitation";
import { invitationErrorResponse } from "@/lib/ox/invitation";
import { err } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * M-O6 — candidate accepts the invitation directly (plan §9.2, RD-10 direct
 * path). Recipient-only; guarded {SENT,VIEWED} → ACCEPTED; the immutable
 * accepted-terms snapshot is stamped EXACTLY ONCE from the ORIGINAL OFFER.
 * Accept-vs-withdraw / accept-vs-expiry / double-accept races collapse
 * deterministically (zero-write 409 for the loser). After consent
 * revocation the recipient can still accept their own live invitation
 * (override B). Audited; employer team notified (RD-13).
 */
type RouteParams = { params: Promise<{ invitationId: string }> };

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { invitationId } = await params;

  const limited = await rateLimitShared(`ox:invitation-respond:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  const parsed = await parseBody(req, z.object({}).strict());
  if (parsed.response) return parsed.response;

  const exists = await db.opportunityInvitation.findFirst({
    where: { id: invitationId, candidateUserId: user.id, status: { not: "DRAFT" } },
    select: { id: true },
  });
  if (!exists) return ERR.notFound();

  try {
    await acceptInvitationDirectly({ invitationId, candidateUserId: user.id });
    const row = await db.opportunityInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: { id: true, status: true, acceptedAt: true, acceptedSalaryMinPaise: true, acceptedSalaryMaxPaise: true, acceptedCurrency: true, acceptedPeriod: true },
    });
    const { salaryPaiseFromStorage } = await import("@/lib/ox/validation");
    return ok({
      invitation: {
        id: row.id,
        status: row.status,
        acceptedAt: row.acceptedAt?.toISOString() ?? null,
        accepted: row.acceptedAt
          ? {
              salaryMinPaise: salaryPaiseFromStorage(row.acceptedSalaryMinPaise),
              salaryMaxPaise: salaryPaiseFromStorage(row.acceptedSalaryMaxPaise),
              currency: row.acceptedCurrency,
              period: row.acceptedPeriod,
            }
          : null,
      },
    });
  } catch (e) {
    const mapped = invitationErrorResponse(e);
    if (mapped) return err(mapped.message, mapped.status, mapped.code);
    throw e;
  }
});
