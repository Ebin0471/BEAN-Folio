import { z } from "zod";

/**
 * BEAN Folio — role-aware account identities (M31).
 *
 * An identity describes the user's PRIMARY purpose on the platform. It is a
 * different concept from `User.role` (USER | ADMIN — platform authorization)
 * and from organization membership (EmployerMembership — workspace
 * authorization). Identity shapes onboarding, trust requirements and the
 * default workspace surface — it never grants access by itself.
 *
 * Legacy accounts (created before identity-aware onboarding) keep
 * `primaryIdentity = null` and are never reclassified by this milestone.
 */

export const BEAN_IDENTITIES = [
  "CAREER_PROFESSIONAL",
  "INDEPENDENT_PROFESSIONAL",
  "ORGANIZATION",
  "TALENT_PARTNER",
] as const;

export type BeanIdentity = (typeof BEAN_IDENTITIES)[number];

export const IDENTITY_SCHEMA = z.enum(BEAN_IDENTITIES);

/** User-facing metadata (labels, descriptions, onboarding copy). */
export const IDENTITY_META: Record<
  BeanIdentity,
  { label: string; tagline: string; description: string; examples: string }
> = {
  CAREER_PROFESSIONAL: {
    label: "Career Professional",
    tagline: "Grow and show your career",
    description: "Employees, job seekers, students and graduates, and career changers.",
    examples: "Employers · Job seekers · Students & graduates · Career changers",
  },
  INDEPENDENT_PROFESSIONAL: {
    label: "Independent Professional",
    tagline: "Run your independent work",
    description: "Freelancers, consultants, contractors and independent creators.",
    examples: "Freelancers · Consultants · Contractors · Independent creators",
  },
  ORGANIZATION: {
    label: "Organization",
    tagline: "Set up a shared workspace",
    description: "Companies, startups, studios, agencies, nonprofits and institutions.",
    examples: "Companies · Startups · Studios & agencies · Nonprofits",
  },
  TALENT_PARTNER: {
    label: "Talent Partner",
    tagline: "Source talent for hiring",
    description: "Recruiters, staffing partners, independent talent scouts and freelance project finders.",
    examples: "In-house recruiters · Staffing agencies · Independent scouts",
  },
};

/**
 * Trust gate: does THIS account need email verification before
 * trust-sensitive actions (external outreach, invitations, candidate
 * contact)? Only accounts created through the identity-aware flow are
 * gated — legacy/demo accounts keep their existing behavior exactly.
 */
export function requiresEmailVerification(user: {
  primaryIdentity: string | null;
  emailVerifiedAt: Date | null;
  isDemo: boolean;
}): boolean {
  return user.primaryIdentity !== null && !user.isDemo && user.emailVerifiedAt === null;
}

/** Serialized identity descriptor for client UIs. */
export const PUBLIC_IDENTITY_OPTIONS = BEAN_IDENTITIES.map((id) => ({
  id,
  ...IDENTITY_META[id],
}));
