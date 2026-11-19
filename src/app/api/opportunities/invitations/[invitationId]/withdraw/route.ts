import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { withdrawInvitation } from "@/lib/ox/invitation";
import { mapInvitationError, requireInvitationEmployer } from "@/lib/ox/invitation-shared";

export const dynamic = "force-dynamic";

/**
 * M-O6 — employer withdrawal (plan §9.1, RD-11): permitted pre-acceptance
 * (SENT / VIEWED / NEGOTIATION_REQUESTED), structurally impossible from
 * terminal states (zero-write 409). The pending proposal freezes as-is —
 * append-only history is never edited or deleted. The candidate is notified
 * (RD-12). Guarded transition; audited.
 *
 * Roles: OWNER/ADMIN/RECRUITER.
 */
type RouteParams = { params: Promise<{ invitationId: string }> };

export const POST = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { invitationId } = await params;

  const parsed = await parseBody(req, z.object({ organizationId: z.string().trim().min(1).max(64) }).strict());
  if (parsed.response) return parsed.response;
  const { organizationId } = parsed.data;

  const limited = await rateLimitShared(`ox:invitation-send:${organizationId}`, 10, 3600_000);
  if (limited) return limited;

  const ctx = await requireInvitationEmployer(organizationId, user.id);
  if (ctx.error) return ctx.error;

  const exists = await db.opportunityInvitation.findFirst({
    where: { id: invitationId, organizationId },
    select: { id: true },
  });
  if (!exists) return ERR.notFound();

  try {
    await withdrawInvitation({ invitationId, organizationId, actorUserId: user.id });
    const row = await db.opportunityInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: { id: true, status: true, withdrawnAt: true },
    });
    return ok({
      invitation: {
        id: row.id,
        status: row.status,
        withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
      },
    });
  } catch (e) {
    return mapInvitationError(e);
  }
});
