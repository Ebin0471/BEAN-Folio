import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole, getOrg } from "@/lib/ox/authz";
import {
  assertCandidateDiscoverableToOrg,
  getOrgActiveMemberUserIds,
  recomputeSingleMatch,
} from "@/lib/ox/discovery";
import { serializeCandidateProfileForViewer, maskedStateFor } from "@/lib/ox/dto";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { activeInviteExists } from "@/lib/ox/invitation";

export const dynamic = "force-dynamic";

/**
 * M-O5 — per-opportunity candidate shortlist (approved decisions D13/D14,
 * D6/D7/D9 semantics).
 *
 * GET  — list THIS opportunity's shortlist entries. EVERY read revalidates:
 *        membership + roles, org verification (403 when unverified) and
 *        suspension, opportunity binding (404 for foreign org/opportunity),
 *        and — per entry, in the SAME request — candidate DISCOVERY consent,
 *        visibility, blocks and account state through the ONE authoritative
 *        boundary. Still-eligible entries render live candidate cards; changed
 *        candidates render TRUTHFUL masked states (MASKED_CONSENT /
 *        MASKED_VISIBILITY / MASKED_BLOCKED / MASKED_UNAVAILABLE) that carry
 *        no candidate content (T15). The opportunity's status is returned so
 *        the UI can communicate the real state (editable vs read-only).
 *
 * POST — add a candidate FROM THIS OPPORTUNITY'S ELIGIBLE MATCHES: the
 *        candidate must pass the CURRENT eligibility boundary in this request
 *        (never assumed from the past — D14). Requires a PUBLISHED opportunity
 *        (adding is discovery-adjacent; PAUSED keeps existing entries editable
 *        but does not admit new ones — D6). Stores minimal metadata only
 *        (scoreAtAdd/matchVersionAtAdd — never a frozen candidate card, D14).
 *        Duplicate (org, opportunity, candidate) → 409. Audited.
 *
 * Roles: OWNER/ADMIN/RECRUITER only (D13; VIEWER and HIRING_MANAGER 404-deny).
 * No candidate notification exists anywhere on this surface (D13).
 */

type RouteParams = { params: Promise<{ id: string; opportunityId: string }> };

const SHORTLIST_ROLES = ["OWNER", "ADMIN", "RECRUITER"] as const;

const addShortlistSchema = z
  .object({
    candidateUserId: z.string().trim().min(1).max(64),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

async function loadContext(orgId: string, opportunityId: string, userId: string) {
  const membership = await requireOrgRole(orgId, userId, SHORTLIST_ROLES);
  if (!membership) return { error: ERR.notFound() as NextResponse, org: null, opportunity: null };
  const org = await getOrg(orgId);
  if (!org) return { error: ERR.notFound() as NextResponse, org: null, opportunity: null };
  if (org.verificationStatus === "SUSPENDED") {
    return { error: err("Organization is suspended", 403, "OX_ORG_SUSPENDED") as NextResponse, org: null, opportunity: null };
  }
  const opportunity = await db.opportunity.findFirst({
    where: { id: opportunityId, organizationId: orgId },
  });
  if (!opportunity) return { error: ERR.notFound() as NextResponse, org: null, opportunity: null };
  if (org.verificationStatus !== "VERIFIED") {
    return {
      error: err("Employer verification required for shortlists", 403, "OX_ORG_NOT_VERIFIED") as NextResponse,
      org: null,
      opportunity: null,
    };
  }
  return { error: null, org, opportunity };
}

export const GET = handler(async (_req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id, opportunityId } = await params;

  const limited = await rateLimitShared(`ox:shortlist-read:${id}`, 120, 3600_000);
  if (limited) return limited;

  const ctx = await loadContext(id, opportunityId, user.id);
  if (ctx.error) return ctx.error;
  const opportunity = ctx.opportunity!;

  const entries = await db.candidateShortlist.findMany({
    where: { organizationId: id, opportunityId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 200,
  });

  const memberUserIds = await getOrgActiveMemberUserIds(id);
  const items: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const base = {
      id: entry.id,
      candidateUserId: entry.candidateUserId,
      note: entry.note,
      scoreAtAdd: entry.scoreAtAdd,
      matchVersionAtAdd: entry.matchVersionAtAdd,
      addedByUserId: entry.addedByUserId,
      status: entry.status,
      addedAt: entry.createdAt.toISOString(),
    };
    // D14: every read revalidates — the boundary decides live vs masked.
    const check = await assertCandidateDiscoverableToOrg({
      candidateUserId: entry.candidateUserId,
      organizationId: id,
      opportunity,
      memberUserIds,
    });
    if (check.ok) {
      items.push({
        ...base,
        state: "LISTED",
        candidate: serializeCandidateProfileForViewer(check.profile, {
          isVerifiedEmployer: true,
          // M-O6 (RD-14): AFTER_INVITE activates only for a live invitation
          // AND only after the boundary passed fresh in this request.
          hasActiveInvite: await activeInviteExists(id, entry.candidateUserId),
        }),
      });
    } else {
      items.push({ ...base, state: maskedStateFor(check.reason) });
    }
  }

  return ok({
    opportunityStatus: opportunity.status,
    editable: opportunity.status === "PUBLISHED" || opportunity.status === "PAUSED",
    entries: items,
  });
});

export const POST = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { id, opportunityId } = await params;

  const limited = await rateLimitShared(`ox:shortlist-write:${id}`, 60, 3600_000);
  if (limited) return limited;

  const ctx = await loadContext(id, opportunityId, user.id);
  if (ctx.error) return ctx.error;
  const opportunity = ctx.opportunity!;

  const parsed = await z
    .union([addShortlistSchema, z.object({})])
    .safeParseAsync(await req.json().catch(() => ({})));
  if (!parsed.success) return err("Invalid shortlist payload", 400, "OX_SHORTLIST_INVALID_PAYLOAD");
  const body = parsed.data as { candidateUserId?: string; note?: string };
  if (!body.candidateUserId) return err("candidateUserId is required", 400, "OX_SHORTLIST_INVALID_PAYLOAD");

  // Adding is discovery-adjacent: PUBLISHED opportunities only (D6 — PAUSED
  // keeps existing entries editable but admits no new ones; terminal is
  // read-only).
  if (opportunity.status !== "PUBLISHED") {
    return err("Shortlist additions require a PUBLISHED opportunity", 409, "OX_OPPORTUNITY_NOT_DISCOVERABLE");
  }

  // D14: the candidate must pass the CURRENT eligibility boundary in THIS
  // request — eligibility when originally matched is never assumed. The
  // recompute also yields the score/matchVersion snapshot metadata (D14:
  // minimal metadata only, never a frozen card).
  const match = await recomputeSingleMatch({
    opportunity: { ...opportunity, skills: await db.opportunitySkill.findMany({ where: { opportunityId: opportunity.id } }) },
    organizationId: id,
    candidateUserId: body.candidateUserId,
  });
  if ("notDiscoverable" in match) {
    // Generic refusal — never reveals WHY (no consent/salary inference).
    return err("Candidate is not currently an eligible match for this opportunity", 409, "OX_CANDIDATE_NOT_ELIGIBLE");
  }

  try {
    const entry = await db.candidateShortlist.create({
      data: {
        organizationId: id,
        opportunityId: opportunity.id,
        candidateUserId: body.candidateUserId,
        note: body.note ?? null,
        scoreAtAdd: match.score,
        matchVersionAtAdd: match.explanation.matchVersion,
        addedByUserId: user.id,
        status: "ACTIVE",
      },
    });
    await auditOX(user.id, OX_AUDIT_ACTIONS.shortlistAdded, OX_TARGET.opportunity, opportunity.id, {
      organizationId: id,
      opportunityId: opportunity.id,
      candidateUserId: body.candidateUserId,
      entryId: entry.id,
      scoreAtAdd: match.score,
    });
    return ok(
      {
        entry: {
          id: entry.id,
          candidateUserId: entry.candidateUserId,
          note: entry.note,
          scoreAtAdd: entry.scoreAtAdd,
          matchVersionAtAdd: entry.matchVersionAtAdd,
          status: entry.status,
          addedAt: entry.createdAt.toISOString(),
          state: "LISTED",
        },
      },
      201
    );
  } catch (e) {
    // P2002 = the unique triple already exists — a duplicate add is a 409.
    if ((e as { code?: string }).code === "P2002") {
      return err("Candidate is already on this shortlist", 409, "OX_SHORTLIST_DUPLICATE");
    }
    throw e;
  }
});
