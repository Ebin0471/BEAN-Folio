import type { NextResponse } from "next/server";
import { z } from "zod";
import { ERR, err } from "@/lib/api-helpers";
import { getOrg, requireOrgRole } from "@/lib/ox/authz";
import { OX_COMPENSATION_PERIODS, OX_SALARY_MAX_PAISE } from "@/lib/ox/validation";
import { invitationErrorResponse } from "@/lib/ox/invitation";

/**
 * M-O6 — shared route-support helpers for the invitation API (plan §4.2/§9).
 * Every employer invitation route runs the SAME authorization stack and the
 * SAME strict offer schema; every route maps InvitationRuleError onto the
 * standard error envelope. Candidate routes use the recipient-binding rule
 * errors directly.
 */

/** Roles allowed to compose/send/withdraw invitations and negotiate (O0 §5;
 * RD-3: humans send directly — the confirm-before-send step is UI-only). */
export const INVITATION_EMPLOYER_ROLES = ["OWNER", "ADMIN", "RECRUITER"] as const;

export type InvitationRouteContext = {
  error: NextResponse | null;
  org: Awaited<ReturnType<typeof getOrg>>;
};

/**
 * Shared employer authorization stack: ACTIVE membership + approved roles
 * (404-deny otherwise — covers unknown orgs, INVITED/SUSPENDED/REMOVED
 * memberships and role exclusion), org existence (404), SUSPENDED (403), and
 * — for all invitation operations — VERIFIED (403). Per-request, never
 * cached. Opportunity/invitation tenant binding is enforced by each route's
 * queries (`findFirst({ id, organizationId })`).
 */
export async function requireInvitationEmployer(
  organizationId: string,
  userId: string,
  opts: { requireVerified?: boolean } = {}
): Promise<InvitationRouteContext> {
  const membership = await requireOrgRole(organizationId, userId, INVITATION_EMPLOYER_ROLES);
  if (!membership) return { error: ERR.notFound(), org: null };
  const org = await getOrg(organizationId);
  if (!org) return { error: ERR.notFound(), org: null };
  if (org.verificationStatus === "SUSPENDED") {
    return { error: err("Organization is suspended", 403, "OX_ORG_SUSPENDED"), org: null };
  }
  if ((opts.requireVerified ?? true) && org.verificationStatus !== "VERIFIED") {
    return { error: err("Employer verification required", 403, "OX_ORG_NOT_VERIFIED"), org: null };
  }
  return { error: null, org };
}

const salaryBound = z
  .number()
  .int()
  .min(0)
  .max(OX_SALARY_MAX_PAISE)
  .refine(Number.isSafeInteger, "Salary value must be a safe JavaScript integer");

/** Immutable original-offer terms (RD-14 class A): complete, in-domain,
 * min ≤ max. Compensation-only — no free text exists anywhere (RD-8). */
export const invitationOfferSchema = z
  .object({
    offerSalaryMinPaise: salaryBound,
    offerSalaryMaxPaise: salaryBound,
    offerCurrency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 currency code required"),
    offerPeriod: z.enum(OX_COMPENSATION_PERIODS),
  })
  .strict()
  .refine((v) => v.offerSalaryMinPaise <= v.offerSalaryMaxPaise, {
    message: "offerSalaryMinPaise must be ≤ offerSalaryMaxPaise",
  });

export type InvitationOfferInput = z.infer<typeof invitationOfferSchema>;

/** One negotiation proposal's terms (RD-14 class B): compensation-only,
 * absolute values (never deltas). */
export const negotiationTermsSchema = z
  .object({
    proposedSalaryMinPaise: salaryBound,
    proposedSalaryMaxPaise: salaryBound,
    proposedCurrency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 currency code required"),
    proposedPeriod: z.enum(OX_COMPENSATION_PERIODS),
  })
  .strict()
  .refine((v) => v.proposedSalaryMinPaise <= v.proposedSalaryMaxPaise, {
    message: "proposedSalaryMinPaise must be ≤ proposedSalaryMaxPaise",
  });

export type NegotiationTermsInput = z.infer<typeof negotiationTermsSchema>;

/** Map an InvitationRuleError onto the standard envelope; rethrow anything
 * else so handler() produces the honest 500. */
export function mapInvitationError(e: unknown): NextResponse {
  const mapped = invitationErrorResponse(e);
  if (mapped) return err(mapped.message, mapped.status, mapped.code);
  throw e;
}
