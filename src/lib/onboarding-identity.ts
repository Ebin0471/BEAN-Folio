import { z } from "zod";
import { IDENTITY_SCHEMA, BeanIdentity } from "@/lib/identity";

/**
 * BEAN Folio — role-specific onboarding schemas (M31).
 *
 * Shared between POST /api/me/onboarding (initial onboarding) and
 * POST /api/me/identity (adding another identity later via Settings).
 *
 * Design rules (from the owner directive):
 * - NO government IDs, tax IDs, salary data or unnecessary sensitive
 *   information at initial login. Evidence is collected progressively, only
 *   when a capability requires it (verified separately, e.g. TrustVerification).
 * - Organization onboarding records workspace CONTEXT here; the organization
 *   workspace itself is created through the existing /api/employers flow with
 *   its own authorization.
 * - Talent Partner onboarding records sourcing context + an explicit
 *   acknowledgement of candidate-data rules. It grants NO access: protected
 *   candidate data requires verified organization membership or an approved
 *   TrustVerification(TALENT_PARTNER_AUTHORIZED).
 * - Everything is optional-fields oriented; unknown/extra keys are rejected
 *   (strict) so stored JSON stays auditable.
 */

const stringArray = (max: number) => z.array(z.string().trim().min(1).max(80)).max(max);

export const EMPLOYMENT_STATUSES = ["EMPLOYED", "SEEKING", "OPEN", "STUDENT_GRADUATE", "CAREER_BREAK"] as const;
export const WORK_MODES = ["ONSITE", "HYBRID", "REMOTE"] as const;
export const ORG_TYPES = ["COMPANY", "STARTUP", "STUDIO", "AGENCY", "NONPROFIT", "INSTITUTION"] as const;
export const ORG_SIZES = ["STARTUP_1_10", "SMB_11_50", "MID_51_200", "LARGE_201_1000", "ENTERPRISE_1000_PLUS"] as const;
export const PARTNER_TYPES = ["IN_HOUSE", "STAFFING_AGENCY", "INDEPENDENT_RECRUITER", "TALENT_OR_PROJECT_SCOUT"] as const;
export const SOURCING_MODES = ["OWN_ORGANIZATION", "CLIENT"] as const;

const careerProfessionalData = z
  .object({
    employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
    industries: stringArray(12).optional(),
    experienceLevel: z.string().trim().max(60).optional(),
    preferredWorkTypes: stringArray(8).optional(),
    preferredLocations: stringArray(8).optional(),
    workModes: z.array(z.enum(WORK_MODES)).max(3).optional(),
    careerInterests: z.string().trim().max(500).optional(),
    portfolioVisibility: z.enum(["PRIVATE", "PUBLIC"]).optional(),
  })
  .strict();

const independentProfessionalData = z
  .object({
    services: stringArray(12).optional(),
    specializations: stringArray(12).optional(),
    projectTypes: stringArray(12).optional(),
    portfolioUrl: z.string().trim().max(300).optional(),
    availability: z.string().trim().max(120).optional(),
    workModes: z.array(z.enum(WORK_MODES)).max(3).optional(),
    rates: z
      .object({
        amount: z.number().positive().max(100_000_000).optional(),
        currency: z.string().trim().length(3).optional(),
        period: z.enum(["HOUR", "DAY", "MONTH", "PROJECT"]).optional(),
      })
      .strict()
      .optional(),
    capacityHoursPerWeek: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const organizationData = z
  .object({
    orgType: z.enum(ORG_TYPES).optional(),
    industry: z.string().trim().max(80).optional(),
    companySize: z.enum(ORG_SIZES).optional(),
    country: z.string().trim().max(80).optional(),
    website: z.string().trim().max(300).optional(),
    representativeRole: z.string().trim().max(80).optional(),
    // Explicit attestation: the representative asserts authority to create
    // and manage the workspace. Recorded (not verified) here; organization
    // VERIFICATION is a separate reviewed process (EmployerVerification).
    authorityAttested: z.literal(true).optional(),
    teamSetupNote: z.string().trim().max(500).optional(),
  })
  .strict();

const talentPartnerData = z
  .object({
    partnerType: z.enum(PARTNER_TYPES).optional(),
    industries: stringArray(12).optional(),
    rolesSourced: stringArray(12).optional(),
    sourcingFor: z.enum(SOURCING_MODES).optional(),
    organizationAffiliation: z.string().trim().max(120).optional(),
    clientAuthorizationNote: z.string().trim().max(500).optional(),
    // Explicit acknowledgement of what candidate data may be accessed and
    // why — recorded for audit. Grants no access by itself.
    candidateDataRulesAcknowledged: z.literal(true).optional(),
  })
  .strict();

export const identityOnboardingSchema = z.object({
  type: IDENTITY_SCHEMA,
  data: z.union([careerProfessionalData, independentProfessionalData, organizationData, talentPartnerData]).default({}),
});

export type IdentityOnboardingInput = z.infer<typeof identityOnboardingSchema>;

/** Mapped User fields per identity (applied alongside the JSON payload). */
export function userFieldUpdatesFor(identity: BeanIdentity, data: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (identity === "CAREER_PROFESSIONAL") {
    if (typeof data.experienceLevel === "string") out.experienceLevel = data.experienceLevel;
    if (data.portfolioVisibility === "PRIVATE" || data.portfolioVisibility === "PUBLIC") {
      out.profileVisibility = data.portfolioVisibility;
    }
  }
  if (identity === "INDEPENDENT_PROFESSIONAL") {
    if (typeof data.availability === "string") out.availability = data.availability;
  }
  return out;
}
