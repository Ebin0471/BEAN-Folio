import { z } from "zod";

/**
 * Opportunity Exchange (O1) — shared zod validation.
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
