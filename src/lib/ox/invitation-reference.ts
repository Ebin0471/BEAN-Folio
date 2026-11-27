import { db } from "@/lib/db";
import type { OpportunityInvitation } from "@prisma/client";
import { requireOrgRole, getOrg } from "./authz";
import { OX_OPPORTUNITY_WRITE_ROLES } from "./validation";

/**
 * Opportunity Exchange (M36.4) — typed `invitationRef` authorization.
 *
 * Architecture §9 (docs/M36_MULTI_AGENT_WORKFORCE_ARCHITECTURE.md): the
 * `invitationRef` typed reference (producer `ox.invitation.prepare`, result
 * key `invitationId`) is a POINTER, never authorization. Before a resolved
 * reference value is handed to any consumer, the referenced row's CURRENT
 * authorization state is re-verified (the exact M36.3 `matchRef` convention):
 *   1. the OpportunityInvitation row still exists;
 *   2. the invitation's organization (from the ROW, never from a client or
 *      model-supplied id) still exists;
 *   3. the workflow owner still holds an ACTIVE OWNER/ADMIN/RECRUITER
 *      membership of THAT organization;
 *   4. the organization is VERIFIED and not SUSPENDED (the same gates the
 *      employer invitation stack enforces).
 *
 * Invitation-STATUS fitness for a CONSUMER's intended use is the consumer's
 * own per-execution check (this module verifies the reference is currently
 * authorized at all; `ox.room.brief` additionally requires the invitation's
 * hiring room to exist and binds it to the current workspace organization).
 * A stored invitation id can never become authority for a SEND: no M36.4
 * tool sends invitations — sending stays the existing human flow, and no
 * registered tool accepts an invitation reference for any sending purpose.
 *
 * No row is ever written here — verification is read-only. Foreign
 * invitation existence is never exposed: every failure reason is identical
 * from the outside (the resolver turns them into a single honest
 * authorization-revoked workflow error).
 */

export type InvitationRefVerification =
  | { ok: true; invitation: OpportunityInvitation }
  | {
      ok: false;
      reason:
        | "INVITATION_ROW_MISSING"
        | "ORGANIZATION_MISSING"
        | "ROLE_NOT_AUTHORIZED"
        | "ORG_SUSPENDED"
        | "ORG_NOT_VERIFIED";
    };

export async function verifyInvitationRefAuthorization(
  userId: string,
  invitationId: string
): Promise<InvitationRefVerification> {
  const invitation = await db.opportunityInvitation.findUnique({
    where: { id: invitationId },
  });
  if (!invitation) return { ok: false, reason: "INVITATION_ROW_MISSING" };

  const membership = await requireOrgRole(
    invitation.organizationId,
    userId,
    OX_OPPORTUNITY_WRITE_ROLES
  );
  if (!membership) return { ok: false, reason: "ROLE_NOT_AUTHORIZED" };

  const org = await getOrg(invitation.organizationId);
  if (!org) return { ok: false, reason: "ORGANIZATION_MISSING" };
  if (org.verificationStatus === "SUSPENDED") return { ok: false, reason: "ORG_SUSPENDED" };
  if (org.verificationStatus !== "VERIFIED") return { ok: false, reason: "ORG_NOT_VERIFIED" };

  return { ok: true, invitation };
}
