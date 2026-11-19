import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import {
  activeInviteExists,
  discardInvitationDraft,
  updateInvitationDraft,
} from "@/lib/ox/invitation";
import {
  invitationOfferSchema,
  mapInvitationError,
  requireInvitationEmployer,
} from "@/lib/ox/invitation-shared";
import { assertCandidateDiscoverableToOrg, getOrgActiveMemberUserIds } from "@/lib/ox/discovery";
import {
  serializeCandidateProfileForViewer,
  maskedStateFor,
  serializeInvitationForEmployer,
  serializeNegotiation,
  type StoredInvitationRow,
} from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * M-O6 — one employer invitation (plan §9.1).
 *
 * GET    — org-scoped detail: immutable offer/accepted snapshots, the
 *          append-only negotiation thread and the truthful state. The
 *          candidate card revalidates through the boundary in the SAME
 *          request (RD-15) — masked cards carry no candidate content.
 * PATCH  — edit a DRAFT's offer terms (pre-send only; 409 otherwise —
 *          RD-17; audited `ox.invitation.draft_updated`).
 * DELETE — discard a DRAFT (hard delete of a pre-send working artifact only;
 *          409 for anything else — no sent invitation is ever deleted —
 *          RD-17; audited `ox.invitation.draft_discarded`).
 *
 * Roles: OWNER/ADMIN/RECRUITER; tenant binding in every WHERE.
 */

type RouteParams = { params: Promise<{ invitationId: string }> };

export const GET = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { invitationId } = await params;
  const organizationId = new URL(req.url).searchParams.get("organizationId") ?? "";
  if (!organizationId) return err("organizationId is required", 400, "OX_INVITATION_INVALID_PAYLOAD");

  const limited = await rateLimitShared(`ox:invitation-read:${organizationId}`, 120, 3600_000);
  if (limited) return limited;

  const ctx = await requireInvitationEmployer(organizationId, user.id);
  if (ctx.error) return ctx.error;

  const row = await db.opportunityInvitation.findFirst({
    where: { id: invitationId, organizationId },
  });
  if (!row) return ERR.notFound(); // 404-deny: foreign invitation = unknown

  let candidateState: "LIVE" | "MASKED_CONSENT" | "MASKED_VISIBILITY" | "MASKED_BLOCKED" | "MASKED_UNAVAILABLE" =
    "MASKED_UNAVAILABLE";
  let candidate: Record<string, unknown> | undefined;
  if (row.candidateUserId) {
    const opportunity = await db.opportunity.findFirst({
      where: { id: row.opportunityId, organizationId },
    });
    if (opportunity) {
      const memberUserIds = await getOrgActiveMemberUserIds(organizationId);
      const check = await assertCandidateDiscoverableToOrg({
        candidateUserId: row.candidateUserId,
        organizationId,
        opportunity,
        memberUserIds,
      });
      if (check.ok) {
        candidateState = "LIVE";
        candidate = serializeCandidateProfileForViewer(check.profile, {
          isVerifiedEmployer: true,
          // M-O6 (RD-14): AFTER_INVITE only after a fresh boundary pass.
          hasActiveInvite: await activeInviteExists(organizationId, row.candidateUserId),
        });
      } else {
        candidateState = maskedStateFor(check.reason);
      }
    }
  }
  const negotiations = await db.invitationNegotiation.findMany({
    where: { invitationId: row.id },
    orderBy: { seq: "asc" },
  });

  return ok({
    invitation: serializeInvitationForEmployer(row as StoredInvitationRow, {
      candidateState,
      ...(candidate ? { candidate } : {}),
      negotiations: negotiations.map(serializeNegotiation),
    }),
  });
});

export const PATCH = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { invitationId } = await params;

  const parsed = await parseBody(
    req,
    z
      .object({
        organizationId: z.string().trim().min(1).max(64),
        offer: invitationOfferSchema,
      })
      .strict()
  );
  if (parsed.response) return parsed.response;
  const body = parsed.data;

  const limited = await rateLimitShared(`ox:invitation-send:${body.organizationId}`, 10, 3600_000);
  if (limited) return limited;

  const ctx = await requireInvitationEmployer(body.organizationId, user.id);
  if (ctx.error) return ctx.error;

  const exists = await db.opportunityInvitation.findFirst({
    where: { id: invitationId, organizationId: body.organizationId },
    select: { id: true },
  });
  if (!exists) return ERR.notFound();

  try {
    await updateInvitationDraft({
      invitationId,
      organizationId: body.organizationId,
      actorUserId: user.id,
      offer: body.offer,
    });
    return ok({ updated: true });
  } catch (e) {
    return mapInvitationError(e);
  }
});

export const DELETE = handler(async (req: NextRequest, { params }: RouteParams): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { invitationId } = await params;
  const organizationId = new URL(req.url).searchParams.get("organizationId") ?? "";
  if (!organizationId) return err("organizationId is required", 400, "OX_INVITATION_INVALID_PAYLOAD");

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
    await discardInvitationDraft({ invitationId, organizationId, actorUserId: user.id });
    return ok({ discarded: true });
  } catch (e) {
    return mapInvitationError(e);
  }
});
