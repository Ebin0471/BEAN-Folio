import { z } from "zod";

/**
 * Opportunity Exchange (O1+O2) — shared zod validation.
 *
 * Every OX route validates its inputs through this module so role/status
 * vocabularies and field limits have exactly one source of truth (O0 audit
 * §10.2). SQLite has no native enums (house convention): these string
 * literals are the contract that the Prisma columns store.
 */

// ---------- Vocabularies (mirrors the schema column comments) ----------

export const OX_ORG_ROLES = ["OWNER", "ADMIN", "RECRUITER", "HIRING_MANAGER", "VIEWER"] as const;
export const OX_MEMBER_STATUSES = ["ACTIVE", "INVITED", "SUSPENDED", "REMOVED"] as const;
export const OX_COMPANY_SIZES = [
  "STARTUP_1_10",
  "SMB_11_50",
  "MID_51_200",
  "LARGE_201_1000",
  "ENTERPRISE_1000_PLUS",
] as const;
export const OX_ORG_VERIFICATION_STATUSES = [
  "UNVERIFIED",
  "PENDING",
  "VERIFIED",
  "REJECTED",
  "SUSPENDED",
] as const;

/** Roles that may be ASSIGNED to an invited member. Ownership is never
 * granted through an invite or a membership PATCH — it moves only through
 * the audited ownership-transfer flow (O1 owner directive). */
export const OX_ASSIGNABLE_ROLES = ["ADMIN", "RECRUITER", "HIRING_MANAGER", "VIEWER"] as const;

/** Roles that may manage the organization (profile, members, verification). */
export const OX_MANAGER_ROLES = ["OWNER", "ADMIN"] as const;

export const OX_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/; // 3-48, lowercase, hyphens inside

// ---------- Organization ----------

export const createOrgSchema = z
  .object({
    legalName: z.string().trim().min(2).max(200),
    displayName: z.string().trim().min(1).max(80),
    slug: z.string().regex(OX_SLUG_RE, "Invalid organization address").optional(),
    website: z.string().trim().url().max(300).startsWith("https://").optional().or(z.literal("")),
    industry: z.string().trim().max(80).optional().or(z.literal("")),
    companySize: z.enum(OX_COMPANY_SIZES).optional(),
    description: z.string().trim().max(2000).optional().or(z.literal("")),
    headquarters: z.string().trim().max(120).optional().or(z.literal("")),
  })
  .strict();

export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export const updateOrgSchema = z
  .object({
    legalName: z.string().trim().min(2).max(200).optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
    website: z.string().trim().url().max(300).startsWith("https://").optional().or(z.literal("")),
    industry: z.string().trim().max(80).optional().or(z.literal("")),
    companySize: z.enum(OX_COMPANY_SIZES).optional(),
    description: z.string().trim().max(2000).optional().or(z.literal("")),
    headquarters: z.string().trim().max(120).optional().or(z.literal("")),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nothing to update",
  });

export type UpdateOrgInput = z.infer<typeof updateOrgSchema>;

// ---------- Membership ----------

export const inviteMemberSchema = z
  .object({
    username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{2,23}$/, "Invalid username"),
    role: z.enum(OX_ASSIGNABLE_ROLES),
  })
  .strict();

export const updateMemberSchema = z
  .object({
    role: z.enum(OX_ASSIGNABLE_ROLES).optional(),
    status: z.enum(OX_MEMBER_STATUSES).optional(),
  })
  .strict()
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: "Nothing to update",
  });

// ---------- Verification ----------

export const submitVerificationSchema = z
  .object({
    // SECURE REFERENCE ONLY — an external case/receipt identifier the review
    // tooling resolves. Raw identity documents are never accepted here (O1 §3).
    evidenceReference: z.string().trim().min(4).max(256),
  })
  .strict();

export const verificationDecisionSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "SUSPEND", "REINSTATE"]),
    rejectionReason: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((v) => v.decision !== "REJECT" || (v.rejectionReason !== undefined && v.rejectionReason.length > 0), {
    message: "A rejection reason is required",
  });

// ---------- Candidate opportunity profile (O2) ----------

/**
 * O2 vocabularies — the single source of truth for the candidate state
 * machines (schema column comments mirror THESE, not vice versa).
 * `getCurrentConsent` and the visibility state machine in `src/lib/ox/consent.ts`
 * consume these constants; routes consume the zod schemas.
 */
export const OX_VISIBILITY_STATUSES = ["HIDDEN", "ACTIVE", "PAUSED", "INVITE_ONLY"] as const;
export const OX_EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "FREELANCE", "INTERNSHIP"] as const;
export const OX_WORK_MODES = ["ONSITE", "HYBRID", "REMOTE"] as const;
export const OX_COMPENSATION_VISIBILITIES = ["HIDDEN", "VERIFIED_EMPLOYERS", "AFTER_INVITE", "RANGE_ONLY"] as const;
export const OX_COMPENSATION_PERIODS = ["YEAR", "MONTH", "HOUR"] as const;
export const OX_CONSENT_SCOPES = ["DISCOVERY", "PROFILE_ANALYTICS", "AI_PROCESSING"] as const;
export const OX_CONSENT_STATUSES = ["GRANTED", "REVOKED"] as const;
/** Server-owned provenance vocabulary. O2 accepts ONLY the candidate UI; the
 * value is never read from client input (consent.ts stamps it). */
export const OX_CONSENT_SOURCES = ["CANDIDATE_UI"] as const;
export const OX_CONSENT_SOURCE_CANDIDATE_UI = "CANDIDATE_UI";

/** Hard ceiling for salary bounds in minor units (paise): ₹10 crore. Never
 * floats — O0 §11 D4. Stored as Prisma BigInt since O2.1 (defect O2-ACC-01):
 * this ceiling exceeds the 32-bit Int range (2,147,483,647), so Int columns
 * silently corrupted rows for otherwise-valid payloads. */
export const OX_SALARY_MAX_PAISE = 10_000_000_000;

/**
 * O2.1 (defect O2-ACC-01) — the single checked boundary between API JSON
 * numbers and BigInt storage. The approved salary domain (integer
 * 0..OX_SALARY_MAX_PAISE) sits far below Number.MAX_SAFE_INTEGER, so any
 * approved value converts exactly in both directions — but ONLY after the
 * guards below pass. Neither direction ever rounds, truncates or clamps:
 * a value outside the approved domain fails loudly (HTTP 500 via the route
 * handler) rather than being coerced or silently withheld.
 */

/** Validated API number → native BigInt for Prisma writes (checked). */
export function salaryPaiseToStorage(value: number | null): bigint | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > OX_SALARY_MAX_PAISE) {
    throw new Error("SALARY_PAISE_OUT_OF_APPROVED_BOUNDS");
  }
  return BigInt(value);
}

/** Stored BigInt → API JSON number — exact, checked in both directions. */
export function salaryPaiseFromStorage(value: bigint | null): number | null {
  if (value === null) return null;
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber) || asNumber < 0 || asNumber > OX_SALARY_MAX_PAISE) {
    throw new Error("SALARY_PAISE_OUT_OF_APPROVED_BOUNDS");
  }
  return asNumber;
}

export type OXVisibilityStatus = (typeof OX_VISIBILITY_STATUSES)[number];
export type OXConsentScope = (typeof OX_CONSENT_SCOPES)[number];
export type OXConsentStatus = (typeof OX_CONSENT_STATUSES)[number];
export type OXCompensationVisibility = (typeof OX_COMPENSATION_VISIBILITIES)[number];
export type OXCompensationPeriod = (typeof OX_COMPENSATION_PERIODS)[number];

/**
 * Partial update of the authenticated candidate's own opportunity profile.
 * Field-local constraints only (types, formats, bounds, array caps) plus
 * intra-payload pairwise checks; MERGED-state integrity (e.g. a salary bound
 * requires currency+period across payload AND stored row) is enforced by
 * `validateMergedProfileState` after the caller merges payload over the
 * stored row — payload-local zod refinements alone cannot see stored fields.
 * `null` clears an optional field; omitted = unchanged.
 */
export const updateCandidateProfileSchema = z
  .object({
    employmentTypes: z.array(z.enum(OX_EMPLOYMENT_TYPES)).max(5).nullish(),
    workModes: z.array(z.enum(OX_WORK_MODES)).max(3).nullish(),
    preferredLocations: z.array(z.string().trim().min(1).max(80)).max(10).nullish(),
    preferredProfessionIds: z.array(z.string().trim().min(1).max(64)).max(20).nullish(),
    experienceMinYears: z.number().int().min(0).max(50).nullish(),
    experienceMaxYears: z.number().int().min(0).max(50).nullish(),
    availableFrom: z.string().datetime({ offset: true }).nullish(),
    noticePeriodDays: z.number().int().min(0).max(365).nullish(),
    compensationVisibility: z.enum(OX_COMPENSATION_VISIBILITIES).optional(), // never cleared — always a known state
    // Integer, non-negative, within the approved ceiling, and (explicitly)
    // a safe JavaScript integer — the preconditions the checked BigInt
    // conversion (salaryPaiseToStorage) relies on. The ceiling is far below
    // Number.MAX_SAFE_INTEGER, so approved values are always exact.
    salaryMinPaise: z
      .number()
      .int()
      .min(0)
      .max(OX_SALARY_MAX_PAISE)
      .refine(Number.isSafeInteger, "Salary value must be a safe JavaScript integer")
      .nullish(),
    salaryMaxPaise: z
      .number()
      .int()
      .min(0)
      .max(OX_SALARY_MAX_PAISE)
      .refine(Number.isSafeInteger, "Salary value must be a safe JavaScript integer")
      .nullish(),
    salaryCurrency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 currency code required").nullish(),
    compensationPeriod: z.enum(OX_COMPENSATION_PERIODS).nullish(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nothing to update",
  })
  .refine(
    (v) =>
      v.experienceMinYears === undefined ||
      v.experienceMinYears === null ||
      v.experienceMaxYears === undefined ||
      v.experienceMaxYears === null ||
      v.experienceMinYears <= v.experienceMaxYears,
    { message: "experienceMinYears must be ≤ experienceMaxYears" }
  )
  .refine(
    (v) =>
      v.salaryMinPaise === undefined ||
      v.salaryMinPaise === null ||
      v.salaryMaxPaise === undefined ||
      v.salaryMaxPaise === null ||
      v.salaryMinPaise <= v.salaryMaxPaise,
    { message: "salaryMinPaise must be ≤ salaryMaxPaise" }
  );

export type UpdateCandidateProfileInput = z.infer<typeof updateCandidateProfileSchema>;

/** Grant one consent purpose. Source and version are server-owned — never
 * accepted from the client (O0 §6.1). */
export const grantConsentSchema = z.object({ scope: z.enum(OX_CONSENT_SCOPES) }).strict();

export type GrantConsentInput = z.infer<typeof grantConsentSchema>;

/** Change the authenticated candidate's own visibility state. ACTIVE is
 * additionally consent-gated in `src/lib/ox/consent.ts` (server-side check,
 * O0 §6.3). */
export const changeVisibilitySchema = z.object({ status: z.enum(OX_VISIBILITY_STATUSES) }).strict();

export type ChangeVisibilityInput = z.infer<typeof changeVisibilitySchema>;

/**
 * Post-merge integrity for the profile scalars that carry cross-field rules.
 * Called with the payload merged over the stored row (salary values already
 * converted back to numbers through the checked boundary), BEFORE any write:
 *   - experience/salary min ≤ max
 *   - a salary bound requires BOTH currency and period (O0 §11 D4)
 *   - currency/period without any bound is rejected (no orphan disclosure
 *     metadata — data stays meaningful)
 * Returns null when valid, otherwise a stable machine-readable reason.
 */
export type MergedProfileScalars = {
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  salaryMinPaise: number | null;
  salaryMaxPaise: number | null;
  salaryCurrency: string | null;
  compensationPeriod: string | null;
};

export function validateMergedProfileState(m: MergedProfileScalars): string | null {
  if (
    m.experienceMinYears !== null &&
    m.experienceMaxYears !== null &&
    m.experienceMinYears > m.experienceMaxYears
  ) {
    return "EXPERIENCE_MIN_ABOVE_MAX";
  }
  if (m.salaryMinPaise !== null && m.salaryMaxPaise !== null && m.salaryMinPaise > m.salaryMaxPaise) {
    return "SALARY_MIN_ABOVE_MAX";
  }
  const hasBound = m.salaryMinPaise !== null || m.salaryMaxPaise !== null;
  if (hasBound && (m.salaryCurrency === null || m.compensationPeriod === null)) {
    return "SALARY_BOUND_REQUIRES_CURRENCY_AND_PERIOD";
  }
  if (!hasBound && (m.salaryCurrency !== null || m.compensationPeriod !== null)) {
    return "SALARY_CURRENCY_PERIOD_REQUIRE_A_BOUND";
  }
  return null;
}

// ---------- Ownership transfer ----------

export const transferOwnershipSchema = z
  .object({
    toMemberId: z.string().trim().min(1).max(64),
    // Re-authentication: the current owner must confirm their password for
    // every transfer (O1 owner directive: "controlled ownership transfer
    // with re-authentication").
    currentPassword: z.string().min(1).max(200),
  })
  .strict();

/**
 * Derive an org slug candidate from a display name: lowercase, ASCII
 * alphanumerics and single hyphens, trimmed to 40 chars. Falls back to
 * "org" when nothing usable survives (routes uniquify the result).
 */
export function slugifyOrgName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return base.length >= 3 ? base : base.length > 0 ? `${base}-org` : "org";
}

/** Normalize any slug candidate into a valid one (idempotent for valid input). */
export function normalizeSlug(candidate: string): string {
  const s = candidate.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return OX_SLUG_RE.test(s) ? s : slugifyOrgName(s || candidate);
}
