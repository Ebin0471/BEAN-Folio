import { db } from "@/lib/db";
import type { CandidateOpportunityProfile, PrismaClient } from "@prisma/client";
import { getCurrentConsent, OX_CONSENT_VERSION } from "./consent";
import { compensationForViewer } from "./dto";
import {
  computeO4Match,
  OX_MATCH_TTL_MS,
  OX_MATCH_VERSION,
  type O4Explanation,
  type OXIneligibleReason,
} from "./matching";
import { parseStringArrayField } from "./dto";
import type { Opportunity, OpportunitySkill } from "@prisma/client";

/**
 * Opportunity Exchange (M-O4) — candidate discovery boundary.
 *
 * ONE authoritative server-side eligibility function
 * (`assertCandidateDiscoverableToOrg`, approved directive §3.2) gates EVERY
 * surface that could disclose a discoverable candidate: live search, stored
 * match lists, match details, and (from M-O5) shortlist rendering. A stored
 * TalentMatch row NEVER grants visibility (D9; safeguard C — a queue job can
 * refresh/remove rows but never authorize). Absence of a consent record is
 * permission-DENIED, never permission (rule: never interpret absence of a
 * consent record as permission).
 *
 * Eligibility semantics implemented here (approved decisions D5–D10):
 *   - requesting org must be VERIFIED and not SUSPENDED (route + re-check);
 *   - authorized roles OWNER/ADMIN/RECRUITER (route-level, D11);
 *   - opportunity must be PUBLISHED for NEW discovery/matching (D6);
 *   - candidate: current DISCOVERY consent (valid version, not revoked,
 *     not expired), visibility ACTIVE (HIDDEN/PAUSED excluded; INVITE_ONLY
 *     behaves as HIDDEN in v1 — D7/D8), account not deleted and not a demo
 *     fixture, no Block in either direction against any ACTIVE member of the
 *     requesting org (covers "candidate and employer do not discover
 *     themselves": org members are excluded through the same member set);
 *   - employment-type compatibility checked with O0 unknown-passes rules;
 *   - salary hard-filter ONLY when the candidate's disclosure matrix permits
 *     THIS requester AND the disclosed ranges are incompatible (D10;
 *     safeguard B — a hidden salary is never evaluated, never filterable).
 *
 * V1 scale honesty (O0 §3): the candidate scan is bounded (`SCAN_CAP`),
 * preferences are JSON string columns filtered in the app layer, and per-
 * candidate consent re-checks read the (userId, scope, createdAt)-indexed
 * ledger. This is the documented SQLite-scale tradeoff, not an excuse to
 * relax any boundary.
 */

/** Upper bound on consented-ACTIVE profiles examined per discovery pass. */
export const DISCOVERY_SCAN_CAP = 500;

/** Matches returned per list page (bounded responses; no bulk export). */
export const DISCOVERY_PAGE_SIZE = 25;

/** Either the global Prisma client or an interactive-transaction client. */
type Client = PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export type CandidateDiscoveryState =
  | "LIVE" // eligible right now (freshly recomputed or revalidated)
  | "FROZEN" // stored match, discovery not recomputable (opportunity PAUSED/terminal) — candidate revalidated
  | "MASKED_CONSENT" // stored match, candidate consent no longer current (D9)
  | "MASKED_VISIBILITY" // stored match, candidate no longer ACTIVE (D7/D8)
  | "MASKED_BLOCKED" // stored match, a Block now exists
  | "MASKED_UNAVAILABLE"; // stored match, account deleted/demo/missing profile

export type DiscoverabilityResult =
  | { ok: true; profile: CandidateOpportunityProfile; disclosure: { status: "WITHHELD" } | { status: "DISCLOSED" } }
  | { ok: false; reason: Extract<OXIneligibleReason, "PROFILE_MISSING" | "ACCOUNT_UNAVAILABLE" | "CONSENT_INVALID" | "VISIBILITY_NOT_DISCOVERABLE" | "BLOCK_EXISTS" | "EMPLOYMENT_TYPE_MISMATCH" | "COMPENSATION_MISMATCH"> };

/**
 * THE authoritative discovery boundary. Loads the candidate profile + user,
 * re-checks consent (ledger read — not a flag), visibility, demo/deleted
 * account state, blocks against the org's ACTIVE member set, and the
 * per-opportunity compatibility hard filters. Every caller MUST route
 * candidate disclosure through this function in the SAME request it
 * serializes candidate data (T13 — no TOCTOU window beyond the transaction).
 */
export async function assertCandidateDiscoverableToOrg(
  params: {
    candidateUserId: string;
    organizationId: string;
    /** The opportunity the candidate would be matched/shortlisted against. */
    opportunity: Pick<
      Opportunity,
      "id" | "status" | "employmentType" | "workMode" | "location" | "professionId" | "salaryMinPaise" | "salaryMaxPaise" | "salaryCurrency" | "compensationPeriod"
    >;
    /** Must be an ACTIVE member userId set of the requesting org (fresh). */
    memberUserIds: readonly string[];
    client?: Client;
  }
): Promise<DiscoverabilityResult> {
  const client = params.client ?? db;

  // Account state first (demo fixtures and deleted accounts are never
  // discoverable — house `publicOwnerFilter` precedent).
  const user = await client.user.findUnique({
    where: { id: params.candidateUserId },
    select: { id: true, isDemo: true, deletedAt: true },
  });
  if (!user || user.isDemo || user.deletedAt !== null) {
    return { ok: false, reason: "ACCOUNT_UNAVAILABLE" };
  }

  const profile = await client.candidateOpportunityProfile.findUnique({
    where: { userId: params.candidateUserId },
  });
  if (!profile) return { ok: false, reason: "PROFILE_MISSING" };

  // Consent — ledger read, current grant only. NO_ROW / REVOKED / EXPIRED
  // and a wrong-scope grant are all "no consent".
  const consent = await getCurrentConsent(params.candidateUserId, "DISCOVERY", client);
  if (!consent.hasCurrentConsent) return { ok: false, reason: "CONSENT_INVALID" };
  // Consent-version currency (T2): a grant stamped with a vocabulary version
  // other than the server's current `OX_CONSENT_VERSION` is a stale-vocabulary
  // grant — not a current consent for DISCOVERY eligibility. This is a
  // discovery-boundary check; O2 owner endpoints keep returning their ledger
  // rows unchanged (O2 behavior is preserved, rule ⑫).
  if (consent.row.consentVersion !== OX_CONSENT_VERSION) return { ok: false, reason: "CONSENT_INVALID" };

  // Visibility — ACTIVE only (D7: PAUSED stops display everywhere; D8:
  // INVITE_ONLY behaves as HIDDEN in v1).
  if (profile.visibilityStatus !== "ACTIVE") {
    return { ok: false, reason: "VISIBILITY_NOT_DISCOVERABLE" };
  }

  // Blocks — both directions, against ANY ACTIVE member of the org (also
  // implements "candidate and employer do not discover themselves": org
  // members are inside the member set, so a candidate who blocked a member —
  // or is blocked by one — never surfaces; membership itself is not a match
  // channel).
  if (params.memberUserIds.length > 0) {
    const block = await client.block.findFirst({
      where: {
        OR: [
          { blockerId: params.candidateUserId, blockedId: { in: [...params.memberUserIds] } },
          { blockedId: params.candidateUserId, blockerId: { in: [...params.memberUserIds] } },
        ],
      },
      select: { blockerId: true },
    });
    if (block) return { ok: false, reason: "BLOCK_EXISTS" };
  }

  // Employment-type compatibility — O0 unknown-passes semantics: an unset
  // value on either side is "unknown", never a mismatch (D5 spirit).
  if (params.opportunity.employmentType !== null && profile.employmentTypes !== null) {
    const declared = parseStringArrayField(profile.employmentTypes);
    if (declared.length > 0 && !declared.includes(params.opportunity.employmentType)) {
      return { ok: false, reason: "EMPLOYMENT_TYPE_MISMATCH" };
    }
  }

  // Salary compatibility — ONLY when the candidate's own disclosure policy
  // permits THIS verified requester (safeguard B). The disclosure matrix is
  // the single source: HIDDEN and AFTER_INVITE withhold, VERIFIED_EMPLOYERS
  // permits for verified orgs, RANGE_ONLY permits the range. Incomplete
  // salary rows withhold. When disclosed AND incompatible with the
  // opportunity range → hard filter (D10). Withheld salary NEVER filters and
  // NEVER influences the score.
  const disclosure = compensationForViewer(profile, { isVerifiedEmployer: true, hasActiveInvite: false });
  if (disclosure && params.opportunity.salaryMinPaise !== null && params.opportunity.salaryMaxPaise !== null) {
    const incompatible =
      disclosure.maxPaise < params.opportunity.salaryMinPaise || disclosure.minPaise > params.opportunity.salaryMaxPaise;
    if (incompatible) return { ok: false, reason: "COMPENSATION_MISMATCH" };
  }

  return {
    ok: true,
    profile,
    disclosure: disclosure ? { status: "DISCLOSED" } : { status: "WITHHELD" },
  };
}

/** Resolve the requesting org's ACTIVE member userId set (fresh per request;
 * feeds both the block check and the do-not-discover-members rule). */
export async function getOrgActiveMemberUserIds(organizationId: string, client: Client = db): Promise<string[]> {
  const rows = await client.employerMembership.findMany({
    where: { organizationId, status: "ACTIVE" },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

export type OpportunityScoringContext = {
  requiredSkillIds: string[];
  preferredSkillIds: string[];
};

/** Split an opportunity's M-O3 skill rows into the two matching sets. */
export function splitOpportunitySkills(skills: readonly OpportunitySkill[]): OpportunityScoringContext {
  return {
    requiredSkillIds: skills.filter((s) => s.kind === "REQUIRED").map((s) => s.skillId),
    preferredSkillIds: skills.filter((s) => s.kind === "PREFERRED").map((s) => s.skillId),
  };
}

/** Count the candidate's PUBLISHED PUBLIC projects (evidence factor input). */
export async function countPublishedPublicProjects(candidateUserId: string, client: Client = db): Promise<number> {
  return client.project.count({ where: { ownerId: candidateUserId, status: "PUBLISHED", visibility: "PUBLIC" } });
}

export type DiscoveredCandidate = {
  candidateUserId: string;
  score: number;
  explanation: O4Explanation;
  profile: CandidateOpportunityProfile;
  disclosure: { status: "WITHHELD" } | { status: "DISCLOSED" };
};

export type DiscoveryRunResult = {
  scanned: number;
  eligible: DiscoveredCandidate[];
  ineligible: { candidateUserId: string; reason: OXIneligibleReason }[];
};

/**
 * Run live discovery for ONE PUBLISHED opportunity: scan the consented-ACTIVE
 * candidate universe (bounded), re-validate every boundary per candidate,
 * score the eligible ones, and persist the current TalentMatch rows (D3 —
 * upsert, overwrite, no history). Returns the FULL eligible list sorted by
 * (score desc, candidateUserId asc) — the caller slices pages from the same
 * filter so counts can never leak beyond the consented set.
 */
export async function runDiscoveryForOpportunity(
  params: {
    opportunity: Opportunity & { skills: OpportunitySkill[] };
    organizationId: string;
    now?: Date;
    client?: Client;
  }
): Promise<DiscoveryRunResult> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();

  const memberUserIds = await getOrgActiveMemberUserIds(params.organizationId, client);
  const skillSets = splitOpportunitySkills(params.opportunity.skills);

  const profiles = await client.candidateOpportunityProfile.findMany({
    where: {
      visibilityStatus: "ACTIVE",
      user: { isDemo: false, deletedAt: null },
    },
    orderBy: { updatedAt: "desc" },
    take: DISCOVERY_SCAN_CAP,
  });

  const eligible: DiscoveredCandidate[] = [];
  const ineligible: { candidateUserId: string; reason: OXIneligibleReason }[] = [];

  for (const profile of profiles) {
    const check = await assertCandidateDiscoverableToOrg({
      candidateUserId: profile.userId,
      organizationId: params.organizationId,
      opportunity: params.opportunity,
      memberUserIds,
      client,
    });
    if (!check.ok) {
      ineligible.push({ candidateUserId: profile.userId, reason: check.reason });
      continue;
    }
    const candidateSkillRows = await client.profileSkill.findMany({
      where: { userId: profile.userId },
      select: { skillId: true },
    });
    const publishedPublicProjects = await countPublishedPublicProjects(profile.userId, client);
    const { score, explanation } = computeO4Match({
      opportunity: {
        professionId: params.opportunity.professionId,
        location: params.opportunity.location,
        employmentType: params.opportunity.employmentType,
        workMode: params.opportunity.workMode,
      },
      requiredSkillIds: skillSets.requiredSkillIds,
      preferredSkillIds: skillSets.preferredSkillIds,
      candidate: {
        employmentTypes: parseStringArrayField(profile.employmentTypes),
        workModes: parseStringArrayField(profile.workModes),
        preferredLocations: parseStringArrayField(profile.preferredLocations),
        preferredProfessionIds: parseStringArrayField(profile.preferredProfessionIds),
        availableFrom: profile.availableFrom,
        candidateSkillIds: candidateSkillRows.map((r) => r.skillId),
        publishedPublicProjects,
      },
      salaryDisclosure: check.disclosure,
      now,
    });
    eligible.push({
      candidateUserId: profile.userId,
      score,
      explanation,
      profile,
      disclosure: check.disclosure,
    });
  }

  // Deterministic ordering: score desc, then candidateUserId asc (stable,
  // documented tie-break — no insertion-order or timestamp nondeterminism).
  eligible.sort((a, b) => (b.score - a.score) || (a.candidateUserId < b.candidateUserId ? -1 : a.candidateUserId > b.candidateUserId ? 1 : 0));

  // Persist current rows for eligible candidates only (D3). Ineligible
  // candidates get NO row; pre-existing rows for now-ineligible candidates
  // simply age out via `expiresAt` and are masked on every read (D9).
  for (const c of eligible) {
    const data = {
      matchVersion: OX_MATCH_VERSION,
      score: c.score,
      eligible: true,
      ineligibleReason: null,
      explanationJson: JSON.stringify(c.explanation),
      generatedAt: now,
      expiresAt: new Date(now.getTime() + OX_MATCH_TTL_MS),
    };
    await client.talentMatch.upsert({
      where: { opportunityId_candidateUserId: { opportunityId: params.opportunity.id, candidateUserId: c.candidateUserId } },
      create: { opportunityId: params.opportunity.id, candidateUserId: c.candidateUserId, ...data },
      update: data,
    });
  }

  return {
    scanned: profiles.length,
    eligible,
    ineligible,
  };
}

/**
 * Recompute ONE candidate for ONE opportunity (match-detail path). Returns
 * null when the candidate is not currently discoverable (no row is written).
 */
export async function recomputeSingleMatch(
  params: {
    opportunity: Opportunity & { skills: OpportunitySkill[] };
    organizationId: string;
    candidateUserId: string;
    now?: Date;
    client?: Client;
  }
): Promise<{ score: number; explanation: O4Explanation; profile: CandidateOpportunityProfile; disclosure: { status: "WITHHELD" } | { status: "DISCLOSED" } } | { notDiscoverable: OXIneligibleReason }> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const memberUserIds = await getOrgActiveMemberUserIds(params.organizationId, client);
  const check = await assertCandidateDiscoverableToOrg({
    candidateUserId: params.candidateUserId,
    organizationId: params.organizationId,
    opportunity: params.opportunity,
    memberUserIds,
    client,
  });
  if (!check.ok) return { notDiscoverable: check.reason };
  const skillSets = splitOpportunitySkills(params.opportunity.skills);
  const candidateSkillRows = await client.profileSkill.findMany({
    where: { userId: params.candidateUserId },
    select: { skillId: true },
  });
  const publishedPublicProjects = await countPublishedPublicProjects(params.candidateUserId, client);
  const { score, explanation } = computeO4Match({
    opportunity: {
      professionId: params.opportunity.professionId,
      location: params.opportunity.location,
      employmentType: params.opportunity.employmentType,
      workMode: params.opportunity.workMode,
    },
    requiredSkillIds: skillSets.requiredSkillIds,
    preferredSkillIds: skillSets.preferredSkillIds,
    candidate: {
      employmentTypes: parseStringArrayField(check.profile.employmentTypes),
      workModes: parseStringArrayField(check.profile.workModes),
      preferredLocations: parseStringArrayField(check.profile.preferredLocations),
      preferredProfessionIds: parseStringArrayField(check.profile.preferredProfessionIds),
      availableFrom: check.profile.availableFrom,
      candidateSkillIds: candidateSkillRows.map((r) => r.skillId),
      publishedPublicProjects,
    },
    salaryDisclosure: check.disclosure,
    now,
  });
  const data = {
    matchVersion: OX_MATCH_VERSION,
    score,
    eligible: true,
    ineligibleReason: null,
    explanationJson: JSON.stringify(explanation),
    generatedAt: now,
    expiresAt: new Date(now.getTime() + OX_MATCH_TTL_MS),
  };
  await client.talentMatch.upsert({
    where: { opportunityId_candidateUserId: { opportunityId: params.opportunity.id, candidateUserId: params.candidateUserId } },
    create: { opportunityId: params.opportunity.id, candidateUserId: params.candidateUserId, ...data },
    update: data,
  });
  return { score, explanation, profile: check.profile, disclosure: check.disclosure };
}
