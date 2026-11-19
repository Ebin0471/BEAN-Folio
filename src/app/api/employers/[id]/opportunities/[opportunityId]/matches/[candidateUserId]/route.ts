import { NextRequest, type NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole, getOrg } from "@/lib/ox/authz";
import {
  assertCandidateDiscoverableToOrg,
  recomputeSingleMatch,
  getOrgActiveMemberUserIds,
} from "@/lib/ox/discovery";
import { serializeCandidateProfileForViewer, serializeMatchForEmployer, maskedStateFor, type StoredTalentMatchRow } from "@/lib/ox/dto";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";

export const dynamic = "force-dynamic";

/**
 * M-O4 — one candidate's match detail for one opportunity (D2/D6/D11).
 *
 * PUBLISHED opportunity  → recompute the single match in this request (live
 *                          eligibility is the source of truth), write the
 *                          audit event `ox.candidate.viewed` (O0 §6.7 — every
 *                          employer preview of a consented candidate is
 *                          recorded with org + recruiter identity and is
 *                          visible to the candidate), return the LIVE card.
 * PAUSED / terminal      → frozen stored card, revalidated in the same
 *                          request; masked when consent/visibility/blocks
 *                          changed (D7/D9); still audited as a view.
 * Non-discoverable now   → a STORED row renders as its truthful masked state
 *                          (the org already knew this candidate); no stored
 *                          row at all is a 404 (existence-hiding — the org
 *                          never saw this candidate and must not learn why).
 * DRAFT/PENDING_REVIEW   → 409 (never discoverable).
 */

type RouteParams = { params: Promise<{ id: string; opportunityId: string; candidateUserId: string }> };

const DISCOVERY_ROLES = ["OWNER", "ADMIN", "RECRUITER"] as const;

async function loadOrgAndOpportunity(orgId: string, opportunityId: string, userId: string) {
  const membership = await requireOrgRole(orgId, userId, DISCOVERY_ROLES);
  if (!membership) return { error: ERR.notFound() as NextResponse, opportunity: null };
  const org = await getOrg(orgId);
  if (!org) return { error: ERR.notFound() as NextResponse, opportunity: null };
  if (org.verificationStatus === "SUSPENDED") {
    return { error: err("Organization is suspended", 403, "OX_ORG_SUSPENDED") as NextResponse, opportunity: null };
  }
  const opportunity = await db.opportunity.findFirst({
    where: { id: opportunityId, organizationId: orgId },
    include: { skills: true },
  });
  if (!opportunity) return { error: ERR.notFound() as NextResponse, opportunity: null };
  if (org.verificationStatus !== "VERIFIED") {
    return {
      error: err("Employer verification required for discovery", 403, "OX_ORG_NOT_VERIFIED") as NextResponse,
      opportunity: null,
    };
  }
  return { error: null, opportunity };
}

export const GET = handler(async (_req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id, opportunityId, candidateUserId } = await params;

  const limited = await rateLimitShared(`ox:candidate-view:${user.id}`, 120, 3600_000);
  if (limited) return limited;

  const loaded = await loadOrgAndOpportunity(id, opportunityId, user.id);
  if (loaded.error) return loaded.error;
  const opportunity = loaded.opportunity!;

  if (opportunity.status === "DRAFT" || opportunity.status === "PENDING_REVIEW") {
    return err("Matching requires a PUBLISHED opportunity", 409, "OX_OPPORTUNITY_NOT_DISCOVERABLE");
  }

  const stored = await db.talentMatch.findUnique({
    where: { opportunityId_candidateUserId: { opportunityId: opportunity.id, candidateUserId } },
  });

  // Live recompute path (PUBLISHED): the authoritative boundary re-checks
  // everything in THIS request before any candidate data is serialized (T13).
  if (opportunity.status === "PUBLISHED") {
    const result = await recomputeSingleMatch({ opportunity, organizationId: id, candidateUserId });
    if ("notDiscoverable" in result) {
      if (stored) {
        return ok(
          serializeMatchForEmployer(stored as StoredTalentMatchRow, maskedStateFor(result.notDiscoverable))
        );
      }
      return ERR.notFound();
    }
    await auditOX(user.id, OX_AUDIT_ACTIONS.candidateViewed, OX_TARGET.candidateProfile, result.profile.id, {
      organizationId: id,
      opportunityId: opportunity.id,
      candidateUserId,
      purpose: "DISCOVERY",
    });
    return ok(
      serializeMatchForEmployer(
        {
          id: stored?.id ?? `${opportunity.id}:${candidateUserId}`,
          opportunityId: opportunity.id,
          candidateUserId,
          matchVersion: result.explanation.matchVersion,
          score: result.score,
          eligible: true,
          ineligibleReason: null,
          explanationJson: JSON.stringify(result.explanation),
          generatedAt: new Date(),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
        },
        "LIVE",
        serializeCandidateProfileForViewer(result.profile, { isVerifiedEmployer: true, hasActiveInvite: false })
      )
    );
  }

  // Frozen path (PAUSED / FILLED / CLOSED): stored card only, revalidated.
  if (!stored) return ERR.notFound();
  const memberUserIds = await getOrgActiveMemberUserIds(id);
  const check = await assertCandidateDiscoverableToOrg({
    candidateUserId,
    organizationId: id,
    opportunity,
    memberUserIds,
  });
  const candidateProfileId =
    (check.ok ? check.profile.id : null) ??
    (await db.candidateOpportunityProfile.findUnique({ where: { userId: candidateUserId }, select: { id: true } }))?.id ??
    candidateUserId;
  await auditOX(user.id, OX_AUDIT_ACTIONS.candidateViewed, OX_TARGET.candidateProfile, candidateProfileId, {
    organizationId: id,
    opportunityId: opportunity.id,
    candidateUserId,
    purpose: "DISCOVERY",
    matchState: opportunity.status === "PAUSED" ? "FROZEN" : "TERMINAL",
  });
  if (check.ok) {
    return ok(
      serializeMatchForEmployer(
        stored as StoredTalentMatchRow,
        "FROZEN",
        serializeCandidateProfileForViewer(check.profile, { isVerifiedEmployer: true, hasActiveInvite: false })
      )
    );
  }
  return ok(serializeMatchForEmployer(stored as StoredTalentMatchRow, maskedStateFor(check.reason)));
});
