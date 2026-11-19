import { NextRequest, type NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole, getOrg } from "@/lib/ox/authz";
import {
  DISCOVERY_PAGE_SIZE,
  assertCandidateDiscoverableToOrg,
  runDiscoveryForOpportunity,
  getOrgActiveMemberUserIds,
} from "@/lib/ox/discovery";
import { serializeCandidateProfileForViewer, serializeMatchForEmployer, type StoredTalentMatchRow } from "@/lib/ox/dto";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { OX_MATCH_TTL_MS } from "@/lib/ox/matching";

export const dynamic = "force-dynamic";

/**
 * M-O4 — per-opportunity talent discovery (approved decisions D2/D6/D11).
 *
 * GET  — the match list. For a PUBLISHED opportunity this IS the live
 *        discovery/search: eligibility is recomputed for every candidate in
 *        the same request (live eligibility is the source of truth, D2),
 *        current rows are upserted, and the response slices pages from the
 *        same consented filter (counts can never leak beyond it). For a
 *        PAUSED or terminal opportunity NO recomputation happens (D6): the
 *        stored rows are returned FROZEN/TERMINAL, each revalidated in the
 *        same request (revoked consent or lost visibility masks the card
 *        immediately — D7/D9). DRAFT/PENDING_REVIEW opportunities are never
 *        discoverable (409).
 *
 * POST — explicit match generation/recomputation (PUBLISHED only, audited).
 *
 * Authorization: session identity only; ACTIVE OWNER/ADMIN/RECRUITER (D11 —
 * VIEWER and HIRING_MANAGER excluded); foreign org/opportunity = 404
 * existence-hiding deny; VERIFIED org required for discovery; SUSPENDED
 * orgs refused (403). Rate limits documented (`ox:discovery-search` per org).
 * No bulk export exists: the response is bounded to `DISCOVERY_PAGE_SIZE`
 * and no endpoint returns raw candidate rows.
 */

type RouteParams = { params: Promise<{ id: string; opportunityId: string }> };

const DISCOVERY_ROLES = ["OWNER", "ADMIN", "RECRUITER"] as const;

function pageFrom(url: URL): number {
  const raw = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  if (!Number.isInteger(raw) || raw < 1 || raw > 10_000) return 1;
  return raw;
}

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

/**
 * Build the employer-visible list from STORED rows (frozen/terminal path):
 * each row is revalidated in the SAME request through the authoritative
 * boundary; masked rows carry only the identifier the org already knew.
 */
async function buildStoredMatchList(
  orgId: string,
  opportunity: Parameters<typeof assertCandidateDiscoverableToOrg>[0]["opportunity"],
  page: number
) {
  const memberUserIds = await getOrgActiveMemberUserIds(orgId);
  const rows = await db.talentMatch.findMany({
    where: { opportunityId: opportunity.id },
    orderBy: [{ score: "desc" }, { candidateUserId: "asc" }],
  });
  const cards: Record<string, unknown>[] = [];
  for (const row of rows as StoredTalentMatchRow[]) {
    const check = await assertCandidateDiscoverableToOrg({
      candidateUserId: row.candidateUserId,
      organizationId: orgId,
      opportunity,
      memberUserIds,
    });
    if (check.ok) {
      cards.push(
        serializeMatchForEmployer(
          row,
          "FROZEN",
          serializeCandidateProfileForViewer(check.profile, { isVerifiedEmployer: true, hasActiveInvite: false })
        )
      );
    } else {
      const state =
        check.reason === "CONSENT_INVALID"
          ? "MASKED_CONSENT"
          : check.reason === "VISIBILITY_NOT_DISCOVERABLE"
            ? "MASKED_VISIBILITY"
            : check.reason === "BLOCK_EXISTS"
              ? "MASKED_BLOCKED"
              : "MASKED_UNAVAILABLE";
      cards.push(serializeMatchForEmployer(row, state));
    }
  }
  const total = cards.length;
  const start = (page - 1) * DISCOVERY_PAGE_SIZE;
  return { total, matches: cards.slice(start, start + DISCOVERY_PAGE_SIZE) };
}

export const GET = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id, opportunityId } = await params;

  const limited = await rateLimitShared(`ox:discovery-search:${id}`, 60, 3600_000);
  if (limited) return limited;

  const loaded = await loadOrgAndOpportunity(id, opportunityId, user.id);
  if (loaded.error) return loaded.error;
  const opportunity = loaded.opportunity!;

  const page = pageFrom(req.nextUrl);

  if (opportunity.status === "DRAFT" || opportunity.status === "PENDING_REVIEW") {
    return err("Matching requires a PUBLISHED opportunity", 409, "OX_OPPORTUNITY_NOT_DISCOVERABLE");
  }

  if (opportunity.status === "PUBLISHED") {
    const run = await runDiscoveryForOpportunity({ opportunity, organizationId: id });
    const total = run.eligible.length;
    const start = (page - 1) * DISCOVERY_PAGE_SIZE;
    const now = new Date();
    const matches = run.eligible.slice(start, start + DISCOVERY_PAGE_SIZE).map((c) =>
      serializeMatchForEmployer(
        {
          id: `${opportunity.id}:${c.candidateUserId}`,
          opportunityId: opportunity.id,
          candidateUserId: c.candidateUserId,
          matchVersion: c.explanation.matchVersion,
          score: c.score,
          eligible: true,
          ineligibleReason: null,
          explanationJson: JSON.stringify(c.explanation),
          generatedAt: now,
          expiresAt: new Date(now.getTime() + OX_MATCH_TTL_MS),
        },
        "LIVE",
        serializeCandidateProfileForViewer(c.profile, { isVerifiedEmployer: true, hasActiveInvite: false })
      )
    );
    await auditOX(user.id, OX_AUDIT_ACTIONS.discoverySearched, OX_TARGET.opportunity, opportunity.id, {
      organizationId: id,
      matchState: "LIVE",
      resultCount: total,
      page,
    });
    return ok({ matchState: "LIVE", total, page, pageSize: DISCOVERY_PAGE_SIZE, matches });
  }

  // PAUSED / FILLED / CLOSED — frozen stored rows, revalidated per read (D6).
  const frozen = await buildStoredMatchList(id, opportunity, page);
  await auditOX(user.id, OX_AUDIT_ACTIONS.discoverySearched, OX_TARGET.opportunity, opportunity.id, {
    organizationId: id,
    matchState: opportunity.status === "PAUSED" ? "FROZEN" : "TERMINAL",
    resultCount: frozen.total,
    page,
  });
  return ok({
    matchState: opportunity.status === "PAUSED" ? "FROZEN" : "TERMINAL",
    total: frozen.total,
    page,
    pageSize: DISCOVERY_PAGE_SIZE,
    matches: frozen.matches,
  });
});

export const POST = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { id, opportunityId } = await params;

  const limited = await rateLimitShared(`ox:discovery-search:${id}`, 60, 3600_000);
  if (limited) return limited;

  const loaded = await loadOrgAndOpportunity(id, opportunityId, user.id);
  if (loaded.error) return loaded.error;
  const opportunity = loaded.opportunity!;

  if (opportunity.status !== "PUBLISHED") {
    return err("Recomputation requires a PUBLISHED opportunity", 409, "OX_OPPORTUNITY_NOT_DISCOVERABLE");
  }

  const run = await runDiscoveryForOpportunity({ opportunity, organizationId: id });
  const total = run.eligible.length;
  const now = new Date();
  const matches = run.eligible.slice(0, DISCOVERY_PAGE_SIZE).map((c) =>
    serializeMatchForEmployer(
      {
        id: `${opportunity.id}:${c.candidateUserId}`,
        opportunityId: opportunity.id,
        candidateUserId: c.candidateUserId,
        matchVersion: c.explanation.matchVersion,
        score: c.score,
        eligible: true,
        ineligibleReason: null,
        explanationJson: JSON.stringify(c.explanation),
        generatedAt: now,
        expiresAt: new Date(now.getTime() + OX_MATCH_TTL_MS),
      },
      "LIVE",
      serializeCandidateProfileForViewer(c.profile, { isVerifiedEmployer: true, hasActiveInvite: false })
    )
  );
  await auditOX(user.id, OX_AUDIT_ACTIONS.discoverySearched, OX_TARGET.opportunity, opportunity.id, {
    organizationId: id,
    matchState: "LIVE",
    mode: "recompute",
    resultCount: total,
  });
  return ok({ matchState: "LIVE", total, page: 1, pageSize: DISCOVERY_PAGE_SIZE, matches });
});
