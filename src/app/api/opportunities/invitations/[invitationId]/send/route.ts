import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { sendInvitationDraft } from "@/lib/ox/invitation";
import { mapInvitationError, requireInvitationEmployer } from "@/lib/ox/invitation-shared";

export const dynamic = "force-dynamic";

/**
 * M-O6 — send a previously-saved DRAFT (plan §9.1, RD-17 draft path).
 * Every send-time gate runs inside the sending transaction: PUBLISHED gate,
 * one-non-terminal uniqueness (override A, DB backstop), 7-day cooldown,
 * daily/monthly quotas, source pointer (RD-2), and the fresh discovery
 * boundary. Guarded DRAFT→SENT; zero writes on any refusal.
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
    await sendInvitationDraft({ invitationId, organizationId, actorUserId: user.id });
    const row = await db.opportunityInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: { id: true, status: true, sentAt: true, expiresAt: true },
    });
    return ok({
      invitation: {
        id: row.id,
        status: row.status,
        sentAt: row.sentAt?.toISOString() ?? null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      },
    });
  } catch (e) {
    return mapInvitationError(e);
  }
});
