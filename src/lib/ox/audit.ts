import { db } from "@/lib/db";

/**
 * Opportunity Exchange (O1+O2) — the ONE audit writer for OX actions.
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
 *   ox.profile.created | ox.profile.updated          (O2)
 *   ox.visibility.changed                            (O2)
 *   ox.consent.granted | ox.consent.revoked          (O2; O0 §6.4)
 *   ox.opportunity.created | ox.opportunity.updated | ox.opportunity.submitted   (O3)
 *   ox.opportunity.approved | ox.opportunity.rejected                            (O3, admin)
 *   ox.opportunity.paused | ox.opportunity.reopened                               (O3)
 *   ox.opportunity.filled | ox.opportunity.closed | ox.opportunity.deleted        (O3)
 *
 * Target types: EMPLOYER_ORGANIZATION | EMPLOYER_MEMBERSHIP | EMPLOYER_VERIFICATION
 *               | CANDIDATE_OPPORTUNITY_PROFILE | CANDIDATE_VISIBILITY_CONSENT (O2)
 *               | OPPORTUNITY (O3)
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
  profileCreated: "ox.profile.created",
  profileUpdated: "ox.profile.updated",
  visibilityChanged: "ox.visibility.changed",
  consentGranted: "ox.consent.granted",
  consentRevoked: "ox.consent.revoked",
  opportunityCreated: "ox.opportunity.created",
  opportunityUpdated: "ox.opportunity.updated",
  opportunitySubmitted: "ox.opportunity.submitted",
  opportunityApproved: "ox.opportunity.approved",
  opportunityRejected: "ox.opportunity.rejected",
  opportunityPaused: "ox.opportunity.paused",
  opportunityReopened: "ox.opportunity.reopened",
  opportunityFilled: "ox.opportunity.filled",
  opportunityClosed: "ox.opportunity.closed",
  opportunityDeleted: "ox.opportunity.deleted",
  // M-O4 additions
  candidateViewed: "ox.candidate.viewed",
  discoverySearched: "ox.discovery.searched",
  // M-O5 additions
  shortlistAdded: "ox.shortlist.added",
  shortlistRemoved: "ox.shortlist.removed",
  shortlistUpdated: "ox.shortlist.updated",
} as const;

export const OX_TARGET = {
  organization: "EMPLOYER_ORGANIZATION",
  membership: "EMPLOYER_MEMBERSHIP",
  verification: "EMPLOYER_VERIFICATION",
  candidateProfile: "CANDIDATE_OPPORTUNITY_PROFILE",
  candidateConsent: "CANDIDATE_VISIBILITY_CONSENT",
  opportunity: "OPPORTUNITY",
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
