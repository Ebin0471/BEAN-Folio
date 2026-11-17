import type { CandidateOpportunityProfile, CandidateVisibilityConsent, EmployerMembership, EmployerOrganization, User } from "@prisma/client";
import { salaryPaiseFromStorage } from "@/lib/ox/validation";

/**
 * Opportunity Exchange (O1+O2) — response serializers.
 *
 * One allowlist per entity so routes cannot accidentally leak internal
 * fields (the O0 consent/privacy flow §6.6: OX adds its own serializer
 * allowlist; contact fields never leave the org boundary).
 *
 * O2 additions: candidate profile serializers in TWO variants —
 *  - `serializeCandidateProfileForOwner`: the candidate's own complete view.
 *  - `serializeCandidateProfileForViewer`: the future employer/discovery
 *    view. Salary is exposed ONLY through the disclosure matrix
 *    (`compensationForViewer`) and only as a single `compensation` object —
 *    salary scalars never appear as loose top-level fields, so "absent" is
 *    unambiguous. `compensationVisibility` (the POLICY) is never serialized
 *    to viewers — only its RESULT is.
 *
 * O2.1: salary scalars are BigInt at the storage layer; every serialization
 * point converts through `salaryPaiseFromStorage` (bounds + safe-integer
 * checked) so the JSON contract stays numeric — BigInt values are never
 * emitted raw, rounded, truncated or clamped.
 */

export function serializeOrg(org: EmployerOrganization): Record<string, unknown> {
  return {
    id: org.id,
    legalName: org.legalName,
    displayName: org.displayName,
    slug: org.slug,
    website: org.website,
    industry: org.industry,
    companySize: org.companySize,
    description: org.description,
    headquarters: org.headquarters,
    verificationStatus: org.verificationStatus,
    verificationMethod: org.verificationMethod,
    verifiedAt: org.verifiedAt ? org.verifiedAt.toISOString() : null,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  };
}

export function serializeMember(
  member: EmployerMembership,
  user?: Pick<User, "id" | "name" | "username" | "avatarMediaId"> | null
): Record<string, unknown> {
  return {
    id: member.id,
    organizationId: member.organizationId,
    userId: member.userId,
    role: member.role,
    status: member.status,
    invitedByUserId: member.invitedByUserId,
    joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
    createdAt: member.createdAt.toISOString(),
    ...(user
      ? {
          user: {
            id: user.id,
            name: user.name,
            username: user.username,
            avatarUrl: user.avatarMediaId ? `/api/media/${user.avatarMediaId}/raw` : null,
          },
        }
      : {}),
  };
}

export function serializeVerification(v: {
  id: string;
  organizationId: string;
  method: string;
  status: string;
  evidenceReference: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: v.id,
    organizationId: v.organizationId,
    method: v.method,
    status: v.status,
    evidenceReference: v.evidenceReference,
    reviewedAt: v.reviewedAt ? v.reviewedAt.toISOString() : null,
    rejectionReason: v.rejectionReason,
    createdAt: v.createdAt.toISOString(),
  };
}

// ---------- Candidate opportunity profile + consent (O2) ----------

/**
 * Safely parse a JSON string-array column (SQLite house convention,
 * `User.tools` precedent). Never throws: null/invalid shapes collapse to
 * `[]` so a corrupted or hand-edited row can never crash a serializer.
 */
export function parseStringArrayField(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** Disclosure context for the viewer salary matrix (O0 §6.5). O2 defines
 * the matrix; employer-facing requests that populate it arrive in O4+. */
export type CandidateViewerContext = {
  /** Requesting org currently holds VERIFIED status (O1 verification). */
  isVerifiedEmployer: boolean;
  /** An active invitation exists between the requesting org and candidate. */
  hasActiveInvite: boolean;
};

/**
 * The salary disclosure matrix (O0 §6.5, O2_EXECUTION_PLAN §3.6):
 *   HIDDEN           → never disclosed
 *   VERIFIED_EMPLOYERS → only when the requester is a VERIFIED org
 *   AFTER_INVITE     → only when an active invite exists
 *   RANGE_ONLY       → the range is disclosable to any requester
 * Returns null (withholding) unless the exact context permits disclosure,
 * and only when the stored row is complete (bounds + currency + period) —
 * a partial salary row is never serialized. O2.1: the bounds cross from
 * BigInt storage through `salaryPaiseFromStorage` (bounds + safe-integer
 * checked, never clamped) so the emitted JSON numbers are exact.
 */
export function compensationForViewer(
  profile: Pick<
    CandidateOpportunityProfile,
    "compensationVisibility" | "salaryMinPaise" | "salaryMaxPaise" | "salaryCurrency" | "compensationPeriod"
  >,
  ctx: CandidateViewerContext
): { currency: string; period: string; minPaise: number; maxPaise: number } | null {
  let permitted = false;
  switch (profile.compensationVisibility) {
    case "VERIFIED_EMPLOYERS":
      permitted = ctx.isVerifiedEmployer;
      break;
    case "AFTER_INVITE":
      permitted = ctx.hasActiveInvite;
      break;
    case "RANGE_ONLY":
      permitted = true;
      break;
    case "HIDDEN":
    default:
      permitted = false;
      break;
  }
  if (!permitted) return null;
  // O2.1: checked BigInt → JSON-number conversion. An incomplete row (any
  // null scalar) still withholds (null); an out-of-domain stored value
  // throws (500) instead of being coerced.
  const minPaise = salaryPaiseFromStorage(profile.salaryMinPaise);
  const maxPaise = salaryPaiseFromStorage(profile.salaryMaxPaise);
  if (
    profile.salaryCurrency === null ||
    profile.compensationPeriod === null ||
    minPaise === null ||
    maxPaise === null
  ) {
    return null;
  }
  return {
    currency: profile.salaryCurrency,
    period: profile.compensationPeriod,
    minPaise,
    maxPaise,
  };
}

/** The candidate's own complete profile view (self service, O2 §4). */
export function serializeCandidateProfileForOwner(profile: CandidateOpportunityProfile): Record<string, unknown> {
  return {
    id: profile.id,
    userId: profile.userId,
    visibilityStatus: profile.visibilityStatus,
    employmentTypes: parseStringArrayField(profile.employmentTypes),
    workModes: parseStringArrayField(profile.workModes),
    preferredLocations: parseStringArrayField(profile.preferredLocations),
    preferredProfessionIds: parseStringArrayField(profile.preferredProfessionIds),
    experienceMinYears: profile.experienceMinYears,
    experienceMaxYears: profile.experienceMaxYears,
    availableFrom: profile.availableFrom ? profile.availableFrom.toISOString() : null,
    noticePeriodDays: profile.noticePeriodDays,
    compensationVisibility: profile.compensationVisibility,
    // O2.1: checked BigInt → JSON-number conversion (exact, approved domain).
    salaryMinPaise: salaryPaiseFromStorage(profile.salaryMinPaise),
    salaryMaxPaise: salaryPaiseFromStorage(profile.salaryMaxPaise),
    salaryCurrency: profile.salaryCurrency,
    compensationPeriod: profile.compensationPeriod,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

/**
 * The employer/discovery view of a candidate profile (O4+ consumers; O2
 * defines and tests the matrix). Withholds the POLICY field
 * (`compensationVisibility`) and all salary scalars; salary appears only as
 * the matrix-approved `compensation` object. Contact fields are structurally
 * impossible: the model has none and the allowlist below is exhaustive.
 */
export function serializeCandidateProfileForViewer(
  profile: CandidateOpportunityProfile,
  ctx: CandidateViewerContext
): Record<string, unknown> {
  return {
    id: profile.id,
    userId: profile.userId,
    employmentTypes: parseStringArrayField(profile.employmentTypes),
    workModes: parseStringArrayField(profile.workModes),
    preferredLocations: parseStringArrayField(profile.preferredLocations),
    preferredProfessionIds: parseStringArrayField(profile.preferredProfessionIds),
    experienceMinYears: profile.experienceMinYears,
    experienceMaxYears: profile.experienceMaxYears,
    availableFrom: profile.availableFrom ? profile.availableFrom.toISOString() : null,
    noticePeriodDays: profile.noticePeriodDays,
    compensation: compensationForViewer(profile, ctx),
  };
}

/** One consent ledger row as seen by its owner (candidate UI). */
export function serializeConsent(row: CandidateVisibilityConsent): Record<string, unknown> {
  return {
    id: row.id,
    userId: row.userId,
    scope: row.scope,
    status: row.status,
    consentVersion: row.consentVersion,
    source: row.source,
    grantedAt: row.grantedAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
