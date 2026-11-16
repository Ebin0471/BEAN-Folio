import { db } from "@/lib/db";
import type { EmployerMembership, EmployerOrganization, PrismaClient } from "@prisma/client";

/**
 * Opportunity Exchange (O1) — shared server-side authorization helpers.
 *
 * Rules (O0 audit §5, binding for every OX route):
 *  - Identity comes ONLY from the session (`getSessionUser`) — never from
 *    client-supplied org ids, roles or statuses.
 *  - A membership lookup is ALWAYS bound to (organizationId, userId).
 *  - Unauthorized access to a foreign organization's resources is a 404
 *    (existence-hiding deny), never a 403 that would confirm the resource.
 *  - The caller turns a `null` helper result into `ERR.notFound()`.
 */

/** Either the global Prisma client or an interactive-transaction client. */
type Client = PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export async function getMembership(
  organizationId: string,
  userId: string,
  client: Client = db
): Promise<EmployerMembership | null> {
  return client.employerMembership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
}

/**
 * Resolve the caller's ACTIVE membership and require one of `roles`.
 * Returns null when the org is unknown, the caller has no membership, the
 * membership is not ACTIVE, or the role does not qualify — callers respond
 * with 404 (deny without existence leak). INVITED/SUSPENDED/REMOVED members
 * never pass.
 */
export async function requireOrgRole(
  organizationId: string,
  userId: string,
  roles: readonly string[],
  client: Client = db
): Promise<EmployerMembership | null> {
  const membership = await getMembership(organizationId, userId, client);
  if (!membership) return null;
  if (membership.status !== "ACTIVE") return null;
  if (!roles.includes(membership.role)) return null;
  return membership;
}

/**
 * Load the organization for a tenant-scoped operation. Null → caller 404s.
 * Kept separate so every org-bound query has exactly one shape.
 */
export async function getOrg(organizationId: string, client: Client = db): Promise<EmployerOrganization | null> {
  return client.employerOrganization.findUnique({ where: { id: organizationId } });
}

/** Only VERIFIED organizations pass verification-gated operations (O0 §5). */
export function orgIsVerified(org: EmployerOrganization): boolean {
  return org.verificationStatus === "VERIFIED";
}

/**
 * The last-active-owner invariant guard data: how many ACTIVE OWNER
 * memberships the org currently has. Callers run this INSIDE the same
 * transaction as the membership mutation and refuse demotions/removals
 * that would leave zero active owners (O1 owner directive).
 */
export async function countActiveOwners(organizationId: string, client: Client = db): Promise<number> {
  return client.employerMembership.count({
    where: { organizationId, role: "OWNER", status: "ACTIVE" },
  });
}
