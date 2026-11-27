import { db } from "@/lib/db";
import type { TalentMatch } from "@prisma/client";
import { requireOrgRole, getOrg } from "./authz";
import { assertCandidateDiscoverableToOrg, getOrgActiveMemberUserIds } from "./discovery";
import { OX_OPPORTUNITY_WRITE_ROLES } from "./validation";

/**
 * Opportunity Exchange (M36.3) — typed `matchRef` authorization.
 *
 * Architecture §9 (docs/M36_MULTI_AGENT_WORKFORCE_ARCHITECTURE.md): the
 * `matchRef` typed reference (producer `ox.match.explain`, result key
 * `matchId`) is a POINTER, never authorization. Before a resolved reference
 * value is handed to any consumer, the referenced row's CURRENT authorization
 * state is re-verified:
 *   1. the TalentMatch row still exists;
 *   2. the match's opportunity exists and belongs to an organization;
 *   3. the workflow owner still holds an ACTIVE OWNER/ADMIN/RECRUITER
 *      membership of THAT organization (the org comes from the referenced
 *      row itself — never from a client/model-supplied id);
 *   4. the organization still exists, is VERIFIED and not SUSPENDED
 *      (the same gates the match routes enforce);
 *   5. the candidate STILL passes the ONE authoritative discovery boundary
 *      `assertCandidateDiscoverableToOrg` (fresh DISCOVERY-consent ledger
 *      read, ACTIVE visibility, no blocks either direction against the org's
 *      ACTIVE members, demo/deleted excluded, employment + disclosed-
 *      compensation hard filters unchanged).
 *
 * Opportunity-status fitness for a CONSUMER's intended use is the consumer's
 * own per-execution check (this module verifies the reference is currently
 * authorized at all; M36.4 consumers additionally enforce their own
 * lifecycle rules). No row is ever written here — verification is read-only.
 */

export type MatchRefVerification =
  | { ok: true; match: TalentMatch }
  | {
      ok: false;
      reason:
        | "MATCH_ROW_MISSING"
        | "OPPORTUNITY_MISSING"
        | "ORGANIZATION_MISSING"
        | "ROLE_NOT_AUTHORIZED"
        | "ORG_SUSPENDED"
        | "ORG_NOT_VERIFIED"
        | "CANDIDATE_NOT_DISCOVERABLE";
    };

export async function verifyMatchRefAuthorization(
  userId: string,
  matchId: string
): Promise<MatchRefVerification> {
  const match = await db.talentMatch.findUnique({ where: { id: matchId } });
  if (!match) return { ok: false, reason: "MATCH_ROW_MISSING" };

  const opportunity = await db.opportunity.findUnique({
    where: { id: match.opportunityId },
    select: {
      id: true,
      organizationId: true,
      status: true,
      employmentType: true,
      workMode: true,
      location: true,
      professionId: true,
      salaryMinPaise: true,
      salaryMaxPaise: true,
      salaryCurrency: true,
      compensationPeriod: true,
    },
  });
  if (!opportunity) return { ok: false, reason: "OPPORTUNITY_MISSING" };

  const membership = await requireOrgRole(opportunity.organizationId, userId, OX_OPPORTUNITY_WRITE_ROLES);
  if (!membership) return { ok: false, reason: "ROLE_NOT_AUTHORIZED" };

  const org = await getOrg(opportunity.organizationId);
  if (!org) return { ok: false, reason: "ORGANIZATION_MISSING" };
  if (org.verificationStatus === "SUSPENDED") return { ok: false, reason: "ORG_SUSPENDED" };
  if (org.verificationStatus !== "VERIFIED") return { ok: false, reason: "ORG_NOT_VERIFIED" };

  const memberUserIds = await getOrgActiveMemberUserIds(opportunity.organizationId);
  const check = await assertCandidateDiscoverableToOrg({
    candidateUserId: match.candidateUserId,
    organizationId: opportunity.organizationId,
    opportunity,
    memberUserIds,
  });
  if (!check.ok) return { ok: false, reason: "CANDIDATE_NOT_DISCOVERABLE" };

  return { ok: true, match };
}
