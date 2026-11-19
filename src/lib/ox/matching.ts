/**
 * Opportunity Exchange (M-O4) — deterministic, explainable candidate↔
 * opportunity compatibility scoring. PURE functions only: no database
 * access, no wall-clock reads (time is injected), no randomness. Same
 * inputs ⇒ byte-identical score and explanation, on every machine, on every
 * run (approved decision D4; owner directive §3.4).
 *
 * Scoring version: `O4-MATCH-V1` (approved decision D4).
 *
 * Weights are the O0 §7 v1 draft, preserved exactly for the factors that are
 * legitimately evaluable in M-O4:
 *
 *   O0 factor                     O0 weight   O4-MATCH-V1 status
 *   -------------------------     ---------   -----------------------------
 *   Required-skill coverage       30          ACTIVE (when the opportunity
 *                                             declares REQUIRED skills)
 *   Preferred-skill coverage      10          ACTIVE (when the opportunity
 *                                             declares PREFERRED skills)
 *   Profession alignment          15          ACTIVE (when the opportunity
 *                                             declares a profession AND the
 *                                             candidate declared preferences)
 *   Experience fit                10          PERMANENTLY EXCLUDED — M-O3's
 *                                             published Opportunity model has
 *                                             NO experience-range fields
 *                                             (safeguard A: do not invent or
 *                                             derive experience; any future
 *                                             experience input requires a
 *                                             separate owner-approved schema
 *                                             change + match-version change)
 *   Evidence strength             15          ACTIVE (always evaluable: the
 *                                             count of the candidate's
 *                                             PUBLISHED PUBLIC projects —
 *                                             honest completeness signal,
 *                                             0 projects scores 0)
 *   Work-mode compatibility       5           ACTIVE (the O0 draft's single
 *                                             10-pt "work-mode/location"
 *                                             factor is split into two 5-pt
 *                                             sub-factors — the total and
 *                                             every relative weight are
 *                                             unchanged; splitting only gives
 *                                             renormalization a cleaner
 *                                             per-dimension granularity)
 *   Location compatibility        5           ACTIVE (see above)
 *   Availability                  5           ACTIVE (when the candidate
 *                                             declared availableFrom)
 *   Compensation compatibility    5           ACTIVE (ONLY when the candidate's
 *                                             salary disclosure permits THIS
 *                                             requester — safeguard B; the
 *                                             range itself is never emitted)
 *
 *   Active maximum (everything evaluable): 90 (O0's 100 minus the excluded
 *   experience 10).
 *
 * Renormalization rule (approved D10 + safeguards A/B): every factor whose
 * inputs are not legitimately evaluable is EXCLUDED and the remaining active
 * weights are renormalized:
 *
 *     score = round(rawEarned * 100 / activeWeightSum)
 *
 * Deterministic integer arithmetic: `round` is Math.round (half toward
 * +Infinity, fully deterministic in ECMAScript); the denominator
 * `activeWeightSum` is always ≥ 15 because evidence strength is always
 * evaluable — no zero-division is reachable. A factor that is not evaluable
 * is NEVER scored 0: a missing factor must not become an artificial penalty.
 *
 * Salary privacy (safeguard B): when the disclosure matrix withholds salary
 * for this requester, the compensation factor is excluded and renormalized —
 * a hidden salary can never move an employer-visible score. When disclosure
 * IS valid and the ranges are incompatible, Stage-1 (discovery.ts) hard-
 * filters the candidate (`COMPENSATION_MISMATCH`) BEFORE scoring, so this
 * engine only ever scores compatible disclosed ranges. No salary values are
 * ever written into explanations, ordering keys, logs or audit payloads.
 *
 * Insufficient-factor handling: the explanation carries `activeFactorCount`
 * and every factor's applied/not-applied state with a stable reason — a low-
 * information profile produces an explicitly low-information score, never a
 * silently manufactured number.
 *
 * Fairness: features are declared professional data only — no protected or
 * derived personal attributes, no name/avatar/gender-adjacent inputs, no
 * LLM judgment, no external AI provider, no hiring probability semantics
 * (the score is an explanation aid and never a rejection record).
 */

export const OX_MATCH_VERSION = "O4-MATCH-V1";

/** Staleness marker for stored rows. The queue expiry sweep (safeguard C)
 * removes rows past this horizon; live reads recompute regardless. */
export const OX_MATCH_TTL_MS = 7 * 24 * 60 * 60_000;

/** Stage-1 hard-filter reasons (persisted on ineligible rows / surfaced to
 * callers — vocabulary strings only, never containing candidate data). */
export type OXIneligibleReason =
  | "CONSENT_INVALID"
  | "VISIBILITY_NOT_DISCOVERABLE"
  | "BLOCK_EXISTS"
  | "EMPLOYMENT_TYPE_MISMATCH"
  | "COMPENSATION_MISMATCH"
  | "ACCOUNT_UNAVAILABLE"
  | "PROFILE_MISSING";

/** Minimal explanation factor — one entry per factor, applied or not. */
export type O4ExplanationFactor =
  | {
      key: O4FactorKey;
      label: string;
      weight: number;
      earned: number;
      max: number;
      applied: true;
    }
  | {
      key: O4FactorKey | "experience";
      label: string;
      weight: number;
      applied: false;
      reason:
        | "NO_REQUIRED_SKILLS_DECLARED"
        | "NO_PREFERRED_SKILLS_DECLARED"
        | "OPPORTUNITY_PROFESSION_UNSET"
        | "CANDIDATE_PROFESSION_PREFERENCES_UNSET"
        | "OPPORTUNITY_WORK_MODE_UNSET"
        | "CANDIDATE_WORK_MODES_UNSET"
        | "OPPORTUNITY_LOCATION_UNSET"
        | "CANDIDATE_LOCATIONS_UNSET"
        | "CANDIDATE_AVAILABILITY_UNSET"
        | "COMPENSATION_NOT_DISCLOSED_TO_THIS_REQUESTER"
        | "NOT_EVALUABLE_NO_OPPORTUNITY_INPUT";
    };

export type O4FactorKey =
  | "requiredSkills"
  | "preferredSkills"
  | "profession"
  | "evidence"
  | "workMode"
  | "location"
  | "availability"
  | "compensation";

export type O4Explanation = {
  matchVersion: string;
  activeFactorCount: number;
  activeWeightSum: number;
  earnedRaw: number;
  score: number;
  factors: O4ExplanationFactor[];
};

export type O4MatchInput = {
  /** Opportunity-declared scoring inputs (already read from the row). */
  opportunity: {
    professionId: string | null;
    location: string | null;
    employmentType: string | null;
    workMode: string | null;
  };
  /** Existing-taxonomy skill ids attached to the opportunity (M-O3). */
  requiredSkillIds: readonly string[];
  preferredSkillIds: readonly string[];
  /** Candidate-DECLARED professional inputs (already parsed from the row). */
  candidate: {
    employmentTypes: readonly string[];
    workModes: readonly string[];
    preferredLocations: readonly string[];
    preferredProfessionIds: readonly string[];
    availableFrom: Date | null;
    candidateSkillIds: readonly string[];
    /** Count of the candidate's PUBLISHED PUBLIC projects (honest evidence). */
    publishedPublicProjects: number;
  };
  /**
   * Salary disclosure resolution for THIS requester (safeguard B) — computed
   * by the caller through the approved O2 matrix. `WITHHELD` for HIDDEN,
   * AFTER_INVITE (no invitations exist in M-O4) or any incomplete row.
   */
  salaryDisclosure: { status: "WITHHELD" } | { status: "DISCLOSED" };
  /** Injected clock — never Date.now() inside this module. */
  now: Date;
};

const WEIGHTS: Record<O4FactorKey, number> = {
  requiredSkills: 30,
  preferredSkills: 10,
  profession: 15,
  evidence: 15,
  workMode: 5,
  location: 5,
  availability: 5,
  compensation: 5,
};

/** 30-day / 90-day availability gradation boundaries (documented rubric). */
const AVAILABILITY_READY_DAYS = 30;
const AVAILABILITY_PLANNED_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;

function sameToken(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function overlapCount(needles: readonly string[], haystackIds: readonly string[]): number {
  if (needles.length === 0) return 0;
  const set = new Set(haystackIds);
  let n = 0;
  for (const id of needles) if (set.has(id)) n += 1;
  return n;
}

/**
 * Compute the deterministic `O4-MATCH-V1` score + explanation. The candidate
 * is EXPECTED to have passed Stage-1 eligibility (discovery.ts) — this
 * function performs no authorization and no consent logic of its own.
 */
export function computeO4Match(input: O4MatchInput): { score: number; explanation: O4Explanation } {
  const factors: O4ExplanationFactor[] = [];
  let earnedRaw = 0;
  let activeWeightSum = 0;

  const push = (f: O4ExplanationFactor, earned: number | null): void => {
    factors.push(f);
    if (f.applied) {
      // `earned` is null-typed only for the non-applied branch; the runtime
      // guard keeps the arithmetic honest if a caller misuses the API.
      const e = earned ?? 0;
      earnedRaw += e;
      activeWeightSum += f.weight;
    }
  };

  // ---- Required-skill coverage (30) ----
  if (input.requiredSkillIds.length === 0) {
    push(
      {
        key: "requiredSkills",
        label: "Required skills",
        weight: WEIGHTS.requiredSkills,
        applied: false,
        reason: "NO_REQUIRED_SKILLS_DECLARED",
      },
      null
    );
  } else {
    const matched = overlapCount(input.requiredSkillIds, input.candidate.candidateSkillIds);
    const max = WEIGHTS.requiredSkills;
    push(
      {
        key: "requiredSkills",
        label: "Required skills",
        weight: max,
        earned: Math.round((matched * max) / input.requiredSkillIds.length),
        max,
        applied: true,
      },
      Math.round((matched * max) / input.requiredSkillIds.length)
    );
  }

  // ---- Preferred-skill coverage (10) ----
  if (input.preferredSkillIds.length === 0) {
    push(
      {
        key: "preferredSkills",
        label: "Preferred skills",
        weight: WEIGHTS.preferredSkills,
        applied: false,
        reason: "NO_PREFERRED_SKILLS_DECLARED",
      },
      null
    );
  } else {
    const matched = overlapCount(input.preferredSkillIds, input.candidate.candidateSkillIds);
    const max = WEIGHTS.preferredSkills;
    const earned = Math.round((matched * max) / input.preferredSkillIds.length);
    push({ key: "preferredSkills", label: "Preferred skills", weight: max, earned, max, applied: true }, earned);
  }

  // ---- Profession alignment (15) ----
  if (input.opportunity.professionId === null) {
    push(
      {
        key: "profession",
        label: "Profession alignment",
        weight: WEIGHTS.profession,
        applied: false,
        reason: "OPPORTUNITY_PROFESSION_UNSET",
      },
      null
    );
  } else if (input.candidate.preferredProfessionIds.length === 0) {
    push(
      {
        key: "profession",
        label: "Profession alignment",
        weight: WEIGHTS.profession,
        applied: false,
        reason: "CANDIDATE_PROFESSION_PREFERENCES_UNSET",
      },
      null
    );
  } else {
    const hit = input.candidate.preferredProfessionIds.includes(input.opportunity.professionId);
    push(
      {
        key: "profession",
        label: "Profession alignment",
        weight: WEIGHTS.profession,
        earned: hit ? WEIGHTS.profession : 0,
        max: WEIGHTS.profession,
        applied: true,
      },
      hit ? WEIGHTS.profession : 0
    );
  }

  // ---- Evidence strength (15) — always evaluable (honest completeness) ----
  {
    const count = Math.max(0, Math.floor(input.candidate.publishedPublicProjects));
    const earned = Math.min(WEIGHTS.evidence, 5 * count);
    push(
      { key: "evidence", label: "Evidence of work", weight: WEIGHTS.evidence, earned, max: WEIGHTS.evidence, applied: true },
      earned
    );
  }

  // ---- Work-mode compatibility (5) ----
  if (input.opportunity.workMode === null) {
    push(
      {
        key: "workMode",
        label: "Work mode",
        weight: WEIGHTS.workMode,
        applied: false,
        reason: "OPPORTUNITY_WORK_MODE_UNSET",
      },
      null
    );
  } else if (input.candidate.workModes.length === 0) {
    push(
      {
        key: "workMode",
        label: "Work mode",
        weight: WEIGHTS.workMode,
        applied: false,
        reason: "CANDIDATE_WORK_MODES_UNSET",
      },
      null
    );
  } else {
    const hit = input.candidate.workModes.some((m) => sameToken(m, input.opportunity.workMode as string));
    push(
      {
        key: "workMode",
        label: "Work mode",
        weight: WEIGHTS.workMode,
        earned: hit ? WEIGHTS.workMode : 0,
        max: WEIGHTS.workMode,
        applied: true,
      },
      hit ? WEIGHTS.workMode : 0
    );
  }

  // ---- Location compatibility (5) ----
  if (input.opportunity.location === null) {
    push(
      {
        key: "location",
        label: "Location",
        weight: WEIGHTS.location,
        applied: false,
        reason: "OPPORTUNITY_LOCATION_UNSET",
      },
      null
    );
  } else if (input.candidate.preferredLocations.length === 0) {
    push(
      {
        key: "location",
        label: "Location",
        weight: WEIGHTS.location,
        applied: false,
        reason: "CANDIDATE_LOCATIONS_UNSET",
      },
      null
    );
  } else {
    const hit = input.candidate.preferredLocations.some((l) => sameToken(l, input.opportunity.location as string));
    push(
      {
        key: "location",
        label: "Location",
        weight: WEIGHTS.location,
        earned: hit ? WEIGHTS.location : 0,
        max: WEIGHTS.location,
        applied: true,
      },
      hit ? WEIGHTS.location : 0
    );
  }

  // ---- Availability (5) ----
  if (input.candidate.availableFrom === null) {
    push(
      {
        key: "availability",
        label: "Availability",
        weight: WEIGHTS.availability,
        applied: false,
        reason: "CANDIDATE_AVAILABILITY_UNSET",
      },
      null
    );
  } else {
    const days = Math.floor((input.candidate.availableFrom.getTime() - input.now.getTime()) / DAY_MS);
    const earned = days <= AVAILABILITY_READY_DAYS ? 5 : days <= AVAILABILITY_PLANNED_DAYS ? 3 : 1;
    push(
      { key: "availability", label: "Availability", weight: WEIGHTS.availability, earned, max: WEIGHTS.availability, applied: true },
      earned
    );
  }

  // ---- Compensation compatibility (5) — disclosure-gated (safeguard B) ----
  if (input.salaryDisclosure.status !== "DISCLOSED") {
    push(
      {
        key: "compensation",
        label: "Compensation compatibility",
        weight: WEIGHTS.compensation,
        applied: false,
        reason: "COMPENSATION_NOT_DISCLOSED_TO_THIS_REQUESTER",
      },
      null
    );
  } else {
    // Stage-1 hard-filters disclosed-incompatible candidates before scoring;
    // a compatible disclosed range earns the full factor. No amounts are
    // recorded anywhere in the explanation.
    push(
      {
        key: "compensation",
        label: "Compensation compatibility",
        weight: WEIGHTS.compensation,
        earned: WEIGHTS.compensation,
        max: WEIGHTS.compensation,
        applied: true,
      },
      WEIGHTS.compensation
    );
  }

  // ---- Safeguard A: the experience factor is permanently excluded ----
  factors.push({
    key: "experience",
    label: "Experience fit",
    weight: 10,
    applied: false,
    reason: "NOT_EVALUABLE_NO_OPPORTUNITY_INPUT",
  });

  // Denominator guard: evidence is always evaluable, so activeWeightSum ≥ 15
  // — the zero-division branch is unreachable, kept as a fail-loud tripwire.
  if (activeWeightSum <= 0) {
    throw new Error("O4-MATCH-V1 invariant violated: no evaluable factors");
  }

  const score = Math.round((earnedRaw * 100) / activeWeightSum);
  const explanation: O4Explanation = {
    matchVersion: OX_MATCH_VERSION,
    activeFactorCount: factors.filter((f) => f.applied).length,
    activeWeightSum,
    earnedRaw,
    score,
    factors,
  };
  return { score, explanation };
}
