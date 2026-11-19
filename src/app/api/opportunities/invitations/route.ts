import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { assertCandidateDiscoverableToOrg, getOrgActiveMemberUserIds } from "@/lib/ox/discovery";
import {
  serializeCandidateProfileForViewer,
  maskedStateFor,
  serializeInvitationForEmployer,
  serializeNegotiation,
  type StoredInvitationRow,
} from "@/lib/ox/dto";
import { createAndSendInvitation, createInvitationDraft, activeInviteExists } from "@/lib/ox/invitation";
import {
  invitationOfferSchema,
  mapInvitationError,
  requireInvitationEmployer,
} from "@/lib/ox/invitation-shared";

export const dynamic = "force-dynamic";

/**
 * M-O6 — employer invitations collection (plan §9.1).
 *
 * POST — create an invitation. RD-17: create+send ATOMICALLY BY DEFAULT;
 * `{send: false}` saves an employer-private DRAFT instead (drafts consume no
 * quota — quotas bind at send). The send path runs the FULL gate stack
 * inside the sending transaction: PUBLISHED-opportunity gate (D6/RD-17),
 * one-non-terminal uniqueness per (org, opportunity, candidate) with the
 * DATABASE partial-unique emulation as the concurrency backstop (owner
 * override A), 7-day per-candidate cooldown, 20/day + 200/month quotas,
 * source pointer (current eligible TalentMatch OR ACTIVE shortlist entry —
 * RD-2), and the single discovery boundary FRESH in-request. Generic
 * refusals never reveal why (no consent/visibility/salary inference — O5
 * precedent).
 *
 * GET — the org-scoped "Invitations Sent" list. Every row's candidate card
 * is revalidated in the SAME request through the boundary (RD-15): live
 * cards render through the discovery serializer (AFTER_INVITE disclosure
 * only when a live invitation exists — RD-14); changed candidates render
 * truthful masked states with NO content. The immutable offer/accepted
 * snapshots are employer data and always render (O0 Part L).
 *
 * Roles: OWNER/ADMIN/RECRUITER (HIRING_MANAGER/VIEWER 404-deny, D11/D13).
 */

const createInvitationSchema = z
  .object({
    organizationId: z.string().trim().min(1).max(64),
    opportunityId: z.string().trim().min(1).max(64),
    candidateUserId: z.string().trim().min(1).max(64),
    send: z.boolean().optional(),
    // Advisory only — the server revalidates the source regardless (RD-2);
    // never persisted.
    sourceHint: z.enum(["MATCH", "SHORTLIST"]).optional(),
    offer: invitationOfferSchema,
  })
  .strict();

const listQuerySchema = z
  .object({
    organizationId: z.string().trim().min(1).max(64),
    opportunityId: z.string().trim().min(1).max(64).optional(),
    status: z
      .enum(["DRAFT", "SENT", "VIEWED", "ACCEPTED", "DECLINED", "NEGOTIATION_REQUESTED", "EXPIRED", "WITHDRAWN"])
      .optional(),
    page: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

const INVITATIONS_PAGE_SIZE = 25;

export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();

  const parsed = await parseBody(req, createInvitationSchema);
  if (parsed.response) return parsed.response;
  const body = parsed.data;

  // Burst limiter (RD-4): 10 per org per hour on the send surface.
  const limited = await rateLimitShared(`ox:invitation-send:${body.organizationId}`, 10, 3600_000);
  if (limited) return limited;

  const ctx = await requireInvitationEmployer(body.organizationId, user.id);
  if (ctx.error) return ctx.error;

  // The opportunity must belong to the org (tenant binding in the WHERE).
  const opportunity = await db.opportunity.findFirst({
    where: { id: body.opportunityId, organizationId: body.organizationId },
  });
  if (!opportunity) return ERR.notFound();

  try {
    if (body.send === false) {
      const draft = await createInvitationDraft({
        organizationId: body.organizationId,
        opportunityId: body.opportunityId,
        candidateUserId: body.candidateUserId,
        actorUserId: user.id,
        offer: body.offer,
      });
      return ok(
        {
          invitation: {
            id: draft.id,
            status: draft.status,
            candidateUserId: draft.candidateUserId,
            opportunityId: draft.opportunityId,
          },
        },
        201
      );
    }
    const row = await createAndSendInvitation({
      organizationId: body.organizationId,
      opportunityId: body.opportunityId,
      candidateUserId: body.candidateUserId,
      actorUserId: user.id,
      offer: body.offer,
    });
    return ok(
      {
        invitation: {
          id: row.id,
          status: row.status,
          candidateUserId: row.candidateUserId,
          opportunityId: row.opportunityId,
          sentAt: row.sentAt?.toISOString() ?? null,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        },
      },
      201
    );
  } catch (e) {
    return mapInvitationError(e);
  }
});

export const GET = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const url = new URL(req.url);
  const parsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) return err("Invalid list query", 400, "OX_INVITATION_INVALID_PAYLOAD");
  const query = parsed.data;

  const limited = await rateLimitShared(`ox:invitation-read:${query.organizationId}`, 120, 3600_000);
  if (limited) return limited;

  const ctx = await requireInvitationEmployer(query.organizationId, user.id);
  if (ctx.error) return ctx.error;

  const page = query.page ?? 1;
  const rows = await db.opportunityInvitation.findMany({
    where: {
      organizationId: query.organizationId,
      ...(query.opportunityId ? { opportunityId: query.opportunityId } : {}),
      ...(query.status ? { status: query.status } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    skip: (page - 1) * INVITATIONS_PAGE_SIZE,
    take: INVITATIONS_PAGE_SIZE + 1,
  });
  const hasMore = rows.length > INVITATIONS_PAGE_SIZE;
  const items: Record<string, unknown>[] = [];

  const memberUserIds = await getOrgActiveMemberUserIds(query.organizationId);
  const opportunityCache = new Map<string, Awaited<ReturnType<typeof db.opportunity.findFirst>>>();

  for (const row of rows.slice(0, INVITATIONS_PAGE_SIZE) as StoredInvitationRow[]) {
    // RD-15/override B: the employer's own invitation record (offer snapshot,
    // thread, state) is always visible; the CANDIDATE CARD is revalidated
    // through the boundary in this same request — no candidate content and
    // no compensation when the candidate is no longer discoverable,
    // invitation or not.
    let candidateState: "LIVE" | "MASKED_CONSENT" | "MASKED_VISIBILITY" | "MASKED_BLOCKED" | "MASKED_UNAVAILABLE" =
      "MASKED_UNAVAILABLE";
    let candidate: Record<string, unknown> | undefined;
    if (row.candidateUserId) {
      let opportunity = opportunityCache.get(row.opportunityId);
      if (!opportunity) {
        opportunity = await db.opportunity.findFirst({
          where: { id: row.opportunityId, organizationId: query.organizationId },
        });
        if (opportunity) opportunityCache.set(row.opportunityId, opportunity);
      }
      if (opportunity) {
        const check = await assertCandidateDiscoverableToOrg({
          candidateUserId: row.candidateUserId,
          organizationId: query.organizationId,
          opportunity,
          memberUserIds,
        });
        if (check.ok) {
          candidateState = "LIVE";
          candidate = serializeCandidateProfileForViewer(check.profile, {
            isVerifiedEmployer: true,
            // M-O6 (RD-14): AFTER_INVITE activates only for a live invitation
            // AND only after the boundary passed fresh in this request.
            hasActiveInvite: await activeInviteExists(query.organizationId, row.candidateUserId),
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
    items.push(
      serializeInvitationForEmployer(row, {
        candidateState,
        ...(candidate ? { candidate } : {}),
        negotiations: negotiations.map(serializeNegotiation),
      })
    );
  }

  return ok({
    page,
    pageSize: INVITATIONS_PAGE_SIZE,
    hasMore,
    invitations: items,
  });
});
