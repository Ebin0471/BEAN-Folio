import type { NextResponse } from "next/server";
import { ERR, err } from "@/lib/api-helpers";
import { getOrg, requireOrgRole } from "@/lib/ox/authz";
import { roomErrorResponse, resolveRoomParty, type RoomPartyAccess } from "@/lib/ox/room";

/**
 * M-O7 — shared route-support helpers for the hiring-room API.
 * Mirrors invitation-shared.ts: every employer room route runs the SAME
 * authorization stack (ACTIVE membership + approved roles → 404-deny,
 * SUSPENDED → 403, VERIFIED → 403) and maps RoomRuleError onto the standard
 * error envelope. Candidate/viewer routes use `resolveRoomParty` and turn a
 * null access into a 404 (existence-hiding deny).
 */

/** Roles allowed to create/close/cancel rooms and manage room members
 * (RD-2/RD-3/RD-4). The assigned HIRING_MANAGER is deliberately NOT in this
 * set — their extra powers (stage transitions, interview operations,
 * pause/resume) are granted by `resolveRoomParty`'s ASSIGNED_MANAGER access,
 * never by an org role. */
export const HIRING_ROOM_EMPLOYER_ROLES = ["OWNER", "ADMIN", "RECRUITER"] as const;

export type RoomRouteContext = {
  error: NextResponse | null;
  org: Awaited<ReturnType<typeof getOrg>>;
};

/**
 * Shared employer authorization stack (the requireInvitationEmployer image):
 * ACTIVE membership + approved roles (404-deny otherwise — covers unknown
 * orgs, INVITED/SUSPENDED/REMOVED memberships and role exclusion), org
 * existence (404), SUSPENDED (403), and — for all room operations —
 * VERIFIED (403, the M-O6 gate convention). Per-request, never cached.
 * Opportunity/invitation/room tenant binding is enforced by each route's
 * queries (`findFirst({ id, organizationId })`).
 */
export async function requireRoomEmployerAccess(
  organizationId: string,
  userId: string
): Promise<RoomRouteContext> {
  const membership = await requireOrgRole(organizationId, userId, HIRING_ROOM_EMPLOYER_ROLES);
  if (!membership) return { error: ERR.notFound(), org: null };
  const org = await getOrg(organizationId);
  if (!org) return { error: ERR.notFound(), org: null };
  if (org.verificationStatus === "SUSPENDED") {
    return { error: err("Organization is suspended", 403, "OX_ORG_SUSPENDED"), org: null };
  }
  if (org.verificationStatus !== "VERIFIED") {
    return { error: err("Employer verification required", 403, "OX_ORG_NOT_VERIFIED"), org: null };
  }
  return { error: null, org };
}

/**
 * Resolve the caller's party access on one room (re-exported from the
 * engine so routes have exactly one import point). `access: null` → the
 * route answers ERR.notFound() (404-deny): unknown roomId, non-members,
 * non-ACTIVE memberships, org VIEWERs-without-grant are still VIEWER, but
 * an org HIRING_MANAGER NOT assigned to this room and every outsider get
 * null (RD-5/RD-6).
 */
export { resolveRoomParty };
export type { RoomPartyAccess };

/** Map a RoomRuleError onto the standard error envelope; rethrow anything
 * else so handler() produces the honest 500. */
export function mapRoomError(e: unknown): NextResponse {
  const mapped = roomErrorResponse(e);
  if (mapped) return err(mapped.message, mapped.status, mapped.code);
  throw e;
}
