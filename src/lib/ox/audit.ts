import { db } from "@/lib/db";

/**
 * Opportunity Exchange (O1) — the ONE audit writer for OX actions.
 *
 * Consolidates the platform's near-duplicated audit helpers into a single
 * OX entry point (O0 audit §1: "do not add a third near-copy"). Same shape
 * as `auditModeration` / riishe `auditEvent`: append-only, never throws —
 * an audit failure must not fail the action it documents.
 *
 * Action vocabulary (callers MUST use these constants, not free strings):
 *   ox.org.created | ox.org.updated
 *   ox.member.invited | ox.member.updated | ox.member.accepted | ox.member.declined
 *   ox.verification.submitted | ox.verification.approved | ox.verification.rejected
 *   ox.org.suspended | ox.org.reinstated
 *   ox.ownership.transferred
 *
 * Target types: EMPLOYER_ORGANIZATION | EMPLOYER_MEMBERSHIP | EMPLOYER_VERIFICATION
 */
export const OX_AUDIT_ACTIONS = {
  orgCreated: "ox.org.created",
  orgUpdated: "ox.org.updated",
  memberInvited: "ox.member.invited",
  memberUpdated: "ox.member.updated",
  memberAccepted: "ox.member.accepted",
  memberDeclined: "ox.member.declined",
  verificationSubmitted: "ox.verification.submitted",
  verificationApproved: "ox.verification.approved",
  verificationRejected: "ox.verification.rejected",
  orgSuspended: "ox.org.suspended",
  orgReinstated: "ox.org.reinstated",
  ownershipTransferred: "ox.ownership.transferred",
} as const;

export const OX_TARGET = {
  organization: "EMPLOYER_ORGANIZATION",
  membership: "EMPLOYER_MEMBERSHIP",
  verification: "EMPLOYER_VERIFICATION",
} as const;

/** Either the global Prisma client or an interactive-transaction client. */
type Client = Parameters<Parameters<typeof db.$transaction>[0]>[0] | typeof db;

export async function auditOX(
  actorUserId: string | null,
  action: string,
  targetType: string,
  targetId: string,
  meta: Record<string, unknown>,
  client: Client = db
): Promise<void> {
  await client.auditEvent
    .create({
      data: {
        actorUserId,
        action,
        targetType,
        targetId,
        meta: JSON.stringify(meta),
      },
    })
    .catch(() => undefined);
}
