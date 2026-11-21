import { db } from "@/lib/db";
import { notify, notifyMany } from "@/lib/notify";
import type { PrismaClient } from "@prisma/client";
import { OX_AUDIT_ACTIONS, OX_TARGET, auditOX } from "./audit";
import { assertCandidateDiscoverableToOrg, getOrgActiveMemberUserIds } from "./discovery";
import { salaryPaiseToStorage } from "./validation";

/**
 * Opportunity Exchange (M-O6) — invitation + negotiation domain engine.
 *
 * Owner-approved implementation (M-O6 authorization; decisions RD-1…RD-18
 * plus owner overrides A/B). Everything here is server-owned: statuses are
 * never client-supplied, every transition is a status-guarded `updateMany`
 * (zero-write 409 on any stale/illegal state), and every authorization
 * answer is re-derived per request — nothing cached, nothing trusted from
 * the client.
 *
 * Binding rules implemented here (register + plan are the authority):
 *  - RD-2: invitations originate ONLY from a current eligible TalentMatch or
 *    an ACTIVE CandidateShortlist entry, and BOTH gates revalidate the
 *    single discovery boundary (`assertCandidateDiscoverableToOrg`) FRESH
 *    inside the sending transaction. A stored pointer is never authority.
 *  - RD-4: quotas 20/org/UTC-day, 200/org/fixed-30-day-window (documented
 *    fixed-window approximation), 7-day per-(org, candidate) cooldown from
 *    the most recent actually-SENT invitation (any status). Quotas count
 *    SENT rows in-transaction (fixed UTC windows; no token burn on failed
 *    sends); the 10/h burst limit is a `rateLimitShared` bucket applied by
 *    the routes.
 *  - Override A (RD-5): at most ONE non-terminal invitation per
 *    (organizationId, opportunityId, candidateUserId) — enforced by the
 *    DATABASE through the `activeInvitationToken` partial-unique emulation
 *    (sentinel "ACTIVE" while non-terminal, NULL once terminal; NULLs are
 *    distinct in both SQLite and PostgreSQL unique indexes). Application
 *    checks remain as friendly first-line refusals; P2002 is the backstop.
 *  - RD-6: invitation TTL 14 days (expiresAt stamped at send); proposal TTL
 *    7 days; stalled negotiations (no pending proposal, no activity 14d)
 *    expire; 6-hour transition-only sweep. Terminal rows are never
 *    resurrected; nothing is ever deleted by the sweep.
 *  - RD-7: max 6 proposals per invitation; declining the standing proposal
 *    declines the invitation (symmetric for both parties).
 *  - RD-8: compensation-only terms (no free text anywhere).
 *  - RD-9: exactly one PENDING proposal; ANY new proposal supersedes the
 *    standing one in the same transaction (own re-propose and cross-party
 *    counter are the same mechanism — "countering IS the response"); the
 *    guarded supersede write matching zero rows yields 409
 *    OX_NEGOTIATION_PENDING_EXISTS (deterministic race collapse).
 *  - RD-10: ACCEPTED stamps the immutable accepted-terms snapshot exactly
 *    once — from the winning proposal, or from the offer for a direct
 *    accept. Terminal; no renegotiation exists in M-O6.
 *  - RD-11: employer withdrawal from SENT/VIEWED/NEGOTIATION_REQUESTED;
 *    the pending proposal freezes as-is (append-only history preserved).
 *  - RD-12/RD-13: notifications via notify()/notifyMany() only; candidate
 *    notified on sent / withdrawn / employer counter-proposal; employer
 *    ACTIVE OWNER/ADMIN/RECRUITER set notified on decision /
 *    candidate counter-proposal / sweep expiry; NOTHING on VIEWED; no
 *    candidate notification on expiry; payloads carry identifiers and
 *    public titles only — never compensation amounts, contact data or
 *    profile content.
 *  - RD-15/override B: recipient rights (read + respond) are identity-only
 *    (candidateUserId binding + session) — they never consult, restore or
 *    bypass discovery consent. Employer-side profile exposure is handled
 *    by the M-O4 boundary + disclosure matrix, never by this module.
 *  - RD-16: performer/recipient references are SetNull on account deletion
 *    (schema-level); no code path here ever writes to a null-recipient row
 *    except the guarded terminal transitions, which do not need the
 *    recipient.
 *  - RD-17: drafts are employer-private working artifacts (create+sends
 *    atomically by default; `{send:false}` saves a draft); drafts consume
 *    no quota (quotas bind at send); PAUSED/terminal opportunities refuse
 *    NEW sends (OX_OPPORTUNITY_NOT_DISCOVERABLE) while existing invitations
 *    stay interactive.
 *  - RD-18: VIEWED is recorded automatically on the candidate's first
 *    authorized read (guarded SENT→VIEWED), audit-only, never notified.
 *    Candidate unread = SENT with viewedAt = null (no extra table).
 *
 * Snapshot integrity (RD-14, O0 integrity rules): the original offer is
 * frozen at the send transition and never rewritten afterwards; every
 * proposal row carries its own immutable absolute terms; the accepted
 * snapshot is written exactly once by the guarded accept transition itself
 * (a second accept matches zero rows by construction).
 */

// ---------- Approved constants (RD-4/RD-6/RD-7) ----------

/** Invitation status vocabulary (O0 §2 — fixed, not a decision). */
export const OX_INVITATION_STATUSES = [
  "DRAFT",
  "SENT",
  "VIEWED",
  "ACCEPTED",
  "DECLINED",
  "NEGOTIATION_REQUESTED",
  "EXPIRED",
  "WITHDRAWN",
] as const;

export type OXInvitationStatus = (typeof OX_INVITATION_STATUSES)[number];

/** Terminal invitation statuses — every transition out of these is invalid. */
export const OX_INVITATION_TERMINAL_STATUSES = ["ACCEPTED", "DECLINED", "EXPIRED", "WITHDRAWN"] as const;

/** Non-terminal invitation statuses (holders of `activeInvitationToken`). */
export const OX_INVITATION_NON_TERMINAL_STATUSES = ["DRAFT", "SENT", "VIEWED", "NEGOTIATION_REQUESTED"] as const;

/** Invitation statuses that keep an AFTER_INVITE disclosure window open
 * (RD-14: live invitation; DRAFT never activates, terminal closes it). */
export const OX_ACTIVE_INVITE_STATUSES = ["SENT", "VIEWED", "NEGOTIATION_REQUESTED", "ACCEPTED"] as const;

/** Proposal status vocabulary (plan §5.1). */
export const OX_NEGOTIATION_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "DECLINED",
  "SUPERSEDED",
  "WITHDRAWN",
  "EXPIRED",
] as const;

export const OX_NEGOTIATION_ROLES = ["EMPLOYER", "CANDIDATE"] as const;

/** Partial-unique sentinel (owner override A) — see the schema comment. */
export const OX_ACTIVE_INVITATION_TOKEN = "ACTIVE";

/** RD-6: invitation TTL from send; sweep cadence (existing queue). */
export const OX_INVITATION_TTL_MS = 14 * 24 * 60 * 60_000;
export const OX_INVITATION_EXPIRY_SWEEP_EVERY_MS = 6 * 60 * 60_000;

/** RD-7: proposal response window + rounds cap. */
export const OX_NEGOTIATION_TTL_MS = 7 * 24 * 60 * 60_000;
export const OX_NEGOTIATION_MAX_PROPOSALS = 6;

/** RD-4: cooldown from the org's most recent SENT invitation to a candidate. */
export const OX_INVITATION_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
export const OX_INVITATION_DAILY_QUOTA = 20;
export const OX_INVITATION_MONTHLY_QUOTA = 200;
/** Fixed 30-day quota window (documented approximation of a UTC month). */
const MONTH_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** RD-6: stalled-negotiation inactivity threshold. */
const NEGOTIATION_STALL_MS = 14 * 24 * 60 * 60_000;

/** Bounded sweep batch (plan §11.3/§6.1). */
export const OX_INVITATION_SWEEP_BATCH = 200;

// ---------- Rule errors (routes map these onto the standard envelope) ----------

/** A refusal that is a RULE, not a crash: carries the approved OX error code
 * and HTTP status. Routes convert via `invitationErrorResponse`. */
export class InvitationRuleError extends Error {
  constructor(
    /** Approved error-code vocabulary (plan §9.3). */
    readonly code:
      | "OX_INVITATION_DUPLICATE"
      | "OX_INVITATION_NOT_ACTIONABLE"
      | "OX_INVITATION_NOT_DRAFT"
      | "OX_INVITATION_QUOTA_EXCEEDED"
      | "OX_INVITATION_COOLDOWN"
      | "OX_INVITATION_INVALID_OFFER"
      | "OX_NEGOTIATION_LIMIT"
      | "OX_NEGOTIATION_PENDING_EXISTS"
      | "OX_NEGOTIATION_NOT_PENDING"
      | "OX_NEGOTIATION_NOT_FOUND"
      | "OX_OPPORTUNITY_NOT_DISCOVERABLE"
      | "OX_CANDIDATE_NOT_ELIGIBLE",
    readonly httpStatus: number,
    message: string
  ) {
    super(message);
    this.name = "InvitationRuleError";
  }
}

/** Map a thrown rule error onto the standard error envelope; null = not a
 * rule error (rethrow in the route so handler() produces the 500). */
export function invitationErrorResponse(
  e: unknown
): { message: string; status: number; code: string } | null {
  if (e instanceof InvitationRuleError) {
    return { message: e.message, status: e.httpStatus, code: e.code };
  }
  return null;
}

/** Either the global Prisma client or an interactive-transaction client. */
type Client = PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

// ---------- Shared helpers ----------

function utcDayStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function fixedMonthWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / MONTH_WINDOW_MS) * MONTH_WINDOW_MS);
}

/** True when a LIVE invitation exists between the org and the candidate
 * (RD-14: feeds the AFTER_INVITE branch of the disclosure matrix — callers
 * apply it strictly AFTER the discovery boundary has passed fresh in the
 * same request; the invitation itself is never a boundary bypass). */
export async function activeInviteExists(
  organizationId: string,
  candidateUserId: string,
  client: Client = db
): Promise<boolean> {
  const row = await client.opportunityInvitation.findFirst({
    where: {
      organizationId,
      candidateUserId,
      status: { in: [...OX_ACTIVE_INVITE_STATUSES] },
    },
    select: { id: true },
  });
  return row !== null;
}

export type InvitationOfferTerms = {
  offerSalaryMinPaise: number;
  offerSalaryMaxPaise: number;
  offerCurrency: string;
  offerPeriod: string;
};

export type NegotiationTerms = {
  proposedSalaryMinPaise: number;
  proposedSalaryMaxPaise: number;
  proposedCurrency: string;
  proposedPeriod: string;
};

function convertOfferTerms(terms: InvitationOfferTerms): {
  min: bigint;
  max: bigint;
} {
  const min = salaryPaiseToStorage(terms.offerSalaryMinPaise);
  const max = salaryPaiseToStorage(terms.offerSalaryMaxPaise);
  if (min === null || max === null || min > max) {
    throw new InvitationRuleError("OX_INVITATION_INVALID_OFFER", 400, "Offer compensation terms are invalid");
  }
  return { min, max };
}

function convertProposalTerms(terms: NegotiationTerms): { min: bigint; max: bigint } {
  const min = salaryPaiseToStorage(terms.proposedSalaryMinPaise);
  const max = salaryPaiseToStorage(terms.proposedSalaryMaxPaise);
  if (min === null || max === null || min > max) {
    throw new InvitationRuleError("OX_INVITATION_INVALID_OFFER", 400, "Proposal compensation terms are invalid");
  }
  return { min, max };
}

// ---------- Send-time gates (all inside the sending transaction) ----------

/**
 * The complete send-time gate stack (plan §2.2/§4). Runs INSIDE the sending
 * transaction; throws the approved rule errors with ZERO writes on any
 * refusal. Order: opportunity status → one-active (override A) → cooldown →
 * daily quota → monthly quota → source pointer → live discovery boundary.
 */
async function assertSendGates(
  tx: Client,
  params: {
    organizationId: string;
    opportunityId: string;
    candidateUserId: string;
    /** Draft-send path: the draft itself is the non-terminal row for the
     * tuple and must be excluded from the duplicate check. */
    excludeInvitationId?: string;
    now: Date;
  }
): Promise<void> {
  // Opportunity status gate (RD-17/D6): new sends require a PUBLISHED
  // opportunity; PAUSED and terminal refuse new sends while existing
  // invitations stay interactive.
  const opportunity = await tx.opportunity.findFirst({
    where: { id: params.opportunityId, organizationId: params.organizationId },
  });
  if (!opportunity) {
    // Tenant binding failed — indistinguishable from an ineligible candidate.
    throw new InvitationRuleError("OX_CANDIDATE_NOT_ELIGIBLE", 409, "Candidate is not currently eligible");
  }
  if (opportunity.status !== "PUBLISHED") {
    throw new InvitationRuleError(
      "OX_OPPORTUNITY_NOT_DISCOVERABLE",
      409,
      "New invitations require a PUBLISHED opportunity"
    );
  }

  // Override A — at most one non-terminal invitation per tuple. The database
  // unique (activeInvitationToken) is the concurrency backstop; this check
  // is the friendly first-line refusal.
  const duplicate = await tx.opportunityInvitation.findFirst({
    where: {
      organizationId: params.organizationId,
      opportunityId: params.opportunityId,
      candidateUserId: params.candidateUserId,
      status: { in: [...OX_INVITATION_NON_TERMINAL_STATUSES] },
      ...(params.excludeInvitationId ? { id: { not: params.excludeInvitationId } } : {}),
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new InvitationRuleError(
      "OX_INVITATION_DUPLICATE",
      409,
      "An active invitation already exists for this candidate and opportunity"
    );
  }

  // Cooldown (RD-4): 7 days from the org's most recent actually-SENT
  // invitation to this candidate, any status. Drafts (sentAt null) never
  // start a cooldown.
  const latestSent = await tx.opportunityInvitation.findFirst({
    where: { organizationId: params.organizationId, candidateUserId: params.candidateUserId, sentAt: { not: null } },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true },
  });
  if (
    latestSent?.sentAt &&
    params.now.getTime() - latestSent.sentAt.getTime() < OX_INVITATION_COOLDOWN_MS
  ) {
    throw new InvitationRuleError(
      "OX_INVITATION_COOLDOWN",
      409,
      "A previous invitation to this candidate is inside the 7-day cooldown"
    );
  }

  // Quotas (RD-4) — fixed UTC windows, counted in-transaction (no token is
  // consumed when the send later fails; documented approximation).
  const dailyCount = await tx.opportunityInvitation.count({
    where: { organizationId: params.organizationId, sentAt: { gte: utcDayStart(params.now) } },
  });
  if (dailyCount >= OX_INVITATION_DAILY_QUOTA) {
    throw new InvitationRuleError("OX_INVITATION_QUOTA_EXCEEDED", 429, "Daily invitation quota reached");
  }
  const monthlyCount = await tx.opportunityInvitation.count({
    where: { organizationId: params.organizationId, sentAt: { gte: fixedMonthWindowStart(params.now) } },
  });
  if (monthlyCount >= OX_INVITATION_MONTHLY_QUOTA) {
    throw new InvitationRuleError("OX_INVITATION_QUOTA_EXCEEDED", 429, "Monthly invitation quota reached");
  }

  // Source pointer (RD-2): a current eligible TalentMatch OR an ACTIVE
  // CandidateShortlist entry must exist for this (opportunity, candidate).
  // The pointer is only evidence the candidate was reached through the
  // consented discovery flow — it is NOT authorization (checked fresh next).
  const match = await tx.talentMatch.findFirst({
    where: {
      opportunityId: params.opportunityId,
      candidateUserId: params.candidateUserId,
      eligible: true,
      expiresAt: { gt: params.now },
    },
    select: { id: true },
  });
  if (!match) {
    const shortlisted = await tx.candidateShortlist.findFirst({
      where: {
        organizationId: params.organizationId,
        opportunityId: params.opportunityId,
        candidateUserId: params.candidateUserId,
        status: "ACTIVE",
      },
      select: { id: true },
    });
    if (!shortlisted) {
      throw new InvitationRuleError("OX_CANDIDATE_NOT_ELIGIBLE", 409, "Candidate is not currently eligible");
    }
  }

  // THE single eligibility boundary — fresh inside this transaction. A
  // generic refusal only: never reveals consent/visibility/salary reasons.
  const memberUserIds = await getOrgActiveMemberUserIds(params.organizationId, tx);
  const check = await assertCandidateDiscoverableToOrg({
    candidateUserId: params.candidateUserId,
    organizationId: params.organizationId,
    opportunity,
    memberUserIds,
    client: tx,
  });
  if (!check.ok) {
    throw new InvitationRuleError("OX_CANDIDATE_NOT_ELIGIBLE", 409, "Candidate is not currently eligible");
  }
}

// ---------- Notifications (after commit, best-effort, payload-minimal) ----------

const EMPLOYER_NOTIFY_ROLES = ["OWNER", "ADMIN", "RECRUITER"] as const;

async function notifyEmployerTeam(params: {
  organizationId: string;
  actorUserId: string | null;
  type: Parameters<typeof notify>[0]["type"];
  payload: Record<string, unknown>;
  dedupKey: string;
}): Promise<void> {
  try {
    const members = await db.employerMembership.findMany({
      where: { organizationId: params.organizationId, status: "ACTIVE", role: { in: [...EMPLOYER_NOTIFY_ROLES] } },
      select: { userId: true },
    });
    await notifyMany(
      members.map((m) => ({
        userId: m.userId,
        actorId: params.actorUserId,
        type: params.type,
        payload: params.payload,
        dedupKey: params.dedupKey,
      }))
    );
  } catch {
    // notifications never break the primary action
  }
}

async function notifyCandidateOf(params: {
  invitationId: string;
  candidateUserId: string | null;
  actorUserId: string | null;
  type: Parameters<typeof notify>[0]["type"];
  payload: Record<string, unknown>;
  dedupKey: string;
}): Promise<void> {
  if (!params.candidateUserId) return; // anonymized row — nobody to notify
  await notify({
    userId: params.candidateUserId,
    actorId: params.actorUserId,
    type: params.type,
    payload: params.payload,
    dedupKey: params.dedupKey,
  }).catch(() => false);
}

async function loadPublicContext(invitationId: string): Promise<{
  organizationId: string;
  opportunityId: string;
  candidateUserId: string | null;
  organizationDisplayName: string | null;
  opportunityTitle: string | null;
} | null> {
  const row = await db.opportunityInvitation.findUnique({
    where: { id: invitationId },
    select: {
      organizationId: true,
      opportunityId: true,
      candidateUserId: true,
      organization: { select: { displayName: true } },
      opportunity: { select: { title: true } },
    },
  });
  if (!row) return null;
  return {
    organizationId: row.organizationId,
    opportunityId: row.opportunityId,
    candidateUserId: row.candidateUserId,
    organizationDisplayName: row.organization?.displayName ?? null,
    opportunityTitle: row.opportunity?.title ?? null,
  };
}

// ---------- Employer: draft lifecycle + send + withdraw ----------

/**
 * Create an employer-private DRAFT (RD-17: `{send:false}` path). Drafts
 * consume NO quota and NO cooldown (they bind at send); the one-active
 * duplicate check still applies (a draft IS a non-terminal row of the
 * tuple). Eligibility is NOT checked here — it is revalidated fresh at
 * send; a draft for a candidate who became ineligible simply can never be
 * sent. Audited `ox.invitation.drafted`.
 */
export async function createInvitationDraft(params: {
  organizationId: string;
  opportunityId: string;
  candidateUserId: string;
  actorUserId: string;
  offer: InvitationOfferTerms;
  now?: Date;
}) {
  const { min, max } = convertOfferTerms(params.offer);
  return db.$transaction(async (tx) => {
    const duplicate = await tx.opportunityInvitation.findFirst({
      where: {
        organizationId: params.organizationId,
        opportunityId: params.opportunityId,
        candidateUserId: params.candidateUserId,
        status: { in: [...OX_INVITATION_NON_TERMINAL_STATUSES] },
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new InvitationRuleError(
        "OX_INVITATION_DUPLICATE",
        409,
        "An active invitation already exists for this candidate and opportunity"
      );
    }
    const row = await tx.opportunityInvitation
      .create({
        data: {
          organizationId: params.organizationId,
          opportunityId: params.opportunityId,
          candidateUserId: params.candidateUserId,
          status: "DRAFT",
          offerSalaryMinPaise: min,
          offerSalaryMaxPaise: max,
          offerCurrency: params.offer.offerCurrency,
          offerPeriod: params.offer.offerPeriod,
          createdByUserId: params.actorUserId,
          activeInvitationToken: OX_ACTIVE_INVITATION_TOKEN,
        },
      })
      .catch((e: { code?: string }) => {
        if (e?.code === "P2002") {
          // DB backstop for the one-active invariant (override A).
          throw new InvitationRuleError(
            "OX_INVITATION_DUPLICATE",
            409,
            "An active invitation already exists for this candidate and opportunity"
          );
        }
        throw e;
      });
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.invitationDrafted,
      OX_TARGET.opportunityInvitation,
      row.id,
      {
        organizationId: params.organizationId,
        opportunityId: params.opportunityId,
        candidateUserId: params.candidateUserId,
        status: "DRAFT",
      },
      tx
    );
    return row;
  });
}

/** Edit a DRAFT's offer terms (pre-send only; 409 otherwise). Audited. */
export async function updateInvitationDraft(params: {
  invitationId: string;
  organizationId: string;
  actorUserId: string;
  offer: InvitationOfferTerms;
}) {
  const { min, max } = convertOfferTerms(params.offer);
  return db.$transaction(async (tx) => {
    const res = await tx.opportunityInvitation.updateMany({
      where: { id: params.invitationId, organizationId: params.organizationId, status: "DRAFT" },
      data: {
        offerSalaryMinPaise: min,
        offerSalaryMaxPaise: max,
        offerCurrency: params.offer.offerCurrency,
        offerPeriod: params.offer.offerPeriod,
      },
    });
    if (res.count !== 1) {
      throw new InvitationRuleError("OX_INVITATION_NOT_DRAFT", 409, "Only drafts can be edited");
    }
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.invitationDraftUpdated,
      OX_TARGET.opportunityInvitation,
      params.invitationId,
      {
        organizationId: params.organizationId,
        status: "DRAFT",
      },
      tx
    );
    return true;
  });
}

/** Discard a DRAFT (hard delete — pre-send working artifact, audited). */
export async function discardInvitationDraft(params: {
  invitationId: string;
  organizationId: string;
  actorUserId: string;
}) {
  return db.$transaction(async (tx) => {
    const draft = await tx.opportunityInvitation.findFirst({
      where: { id: params.invitationId, organizationId: params.organizationId, status: "DRAFT" },
      select: { id: true, opportunityId: true, candidateUserId: true },
    });
    if (!draft) {
      throw new InvitationRuleError("OX_INVITATION_NOT_DRAFT", 409, "Only drafts can be discarded");
    }
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.invitationDraftDiscarded,
      OX_TARGET.opportunityInvitation,
      draft.id,
      {
        organizationId: params.organizationId,
        opportunityId: draft.opportunityId,
        candidateUserId: draft.candidateUserId,
        status: "DRAFT",
      },
      tx
    );
    await tx.opportunityInvitation.delete({ where: { id: draft.id } });
    return true;
  });
}

/**
 * Send a DRAFT (RD-17 draft path): every send-time gate runs inside the
 * transaction (RD-2 fresh boundary, override-A uniqueness, RD-4 quotas +
 * cooldown, D6 PUBLISHED gate), then a guarded DRAFT→SENT transition stamps
 * the send provenance and the 14-day window. The offer snapshot becomes
 * immutable here (no later write path touches it). Audited + candidate
 * notified.
 */
export async function sendInvitationDraft(params: {
  invitationId: string;
  organizationId: string;
  actorUserId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const expiresAt = new Date(now.getTime() + OX_INVITATION_TTL_MS);
  await db.$transaction(async (tx) => {
    const draft = await tx.opportunityInvitation.findFirst({
      where: { id: params.invitationId, organizationId: params.organizationId },
      select: { id: true, status: true, candidateUserId: true },
    });
    if (!draft) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_FOUND", 404, "Invitation not found");
    }
    if (draft.status !== "DRAFT") {
      throw new InvitationRuleError("OX_INVITATION_NOT_DRAFT", 409, "Only drafts can be sent");
    }
    if (!draft.candidateUserId) {
      throw new InvitationRuleError("OX_CANDIDATE_NOT_ELIGIBLE", 409, "Candidate is not currently eligible");
    }
    const full = await tx.opportunityInvitation.findUniqueOrThrow({
      where: { id: params.invitationId },
      select: { opportunityId: true },
    });
    await assertSendGates(tx, {
      organizationId: params.organizationId,
      opportunityId: full.opportunityId,
      candidateUserId: draft.candidateUserId,
      excludeInvitationId: draft.id,
      now,
    });
    const res = await tx.opportunityInvitation.updateMany({
      where: { id: params.invitationId, organizationId: params.organizationId, status: "DRAFT" },
      data: {
        status: "SENT",
        sentAt: now,
        sentByUserId: params.actorUserId,
        expiresAt,
      },
    });
    if (res.count !== 1) {
      throw new InvitationRuleError("OX_INVITATION_NOT_DRAFT", 409, "Only drafts can be sent");
    }
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.invitationSent,
      OX_TARGET.opportunityInvitation,
      params.invitationId,
      {
        organizationId: params.organizationId,
        status: "SENT",
      },
      tx
    );
  });
  const ctx = await loadPublicContext(params.invitationId);
  if (ctx) {
    await notifyCandidateOf({
      invitationId: ctx.candidateUserId ? params.invitationId : params.invitationId,
      candidateUserId: ctx.candidateUserId,
      actorUserId: params.actorUserId,
      type: "HIRING_INVITATION",
      payload: {
        invitationId: params.invitationId,
        organizationId: ctx.organizationId,
        organizationDisplayName: ctx.organizationDisplayName,
        opportunityTitle: ctx.opportunityTitle,
      },
      dedupKey: `hiring:invitation:${params.invitationId}:sent`,
    });
  }
}

/**
 * Create + send atomically (RD-17 default path): the row is created directly
 * in SENT behind the full send-gate stack. A duplicate/failed gate leaves
 * ZERO rows (the create never runs).
 */
export async function createAndSendInvitation(params: {
  organizationId: string;
  opportunityId: string;
  candidateUserId: string;
  actorUserId: string;
  offer: InvitationOfferTerms;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const { min, max } = convertOfferTerms(params.offer);
  const expiresAt = new Date(now.getTime() + OX_INVITATION_TTL_MS);
  const row = await db.$transaction(async (tx) => {
    await assertSendGates(tx, {
      organizationId: params.organizationId,
      opportunityId: params.opportunityId,
      candidateUserId: params.candidateUserId,
      now,
    });
    const created = await tx.opportunityInvitation
      .create({
        data: {
          organizationId: params.organizationId,
          opportunityId: params.opportunityId,
          candidateUserId: params.candidateUserId,
          status: "SENT",
          offerSalaryMinPaise: min,
          offerSalaryMaxPaise: max,
          offerCurrency: params.offer.offerCurrency,
          offerPeriod: params.offer.offerPeriod,
          createdByUserId: params.actorUserId,
          sentByUserId: params.actorUserId,
          sentAt: now,
          expiresAt,
          activeInvitationToken: OX_ACTIVE_INVITATION_TOKEN,
        },
      })
      .catch((e: { code?: string }) => {
        if (e?.code === "P2002") {
          throw new InvitationRuleError(
            "OX_INVITATION_DUPLICATE",
            409,
            "An active invitation already exists for this candidate and opportunity"
          );
        }
        throw e;
      });
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.invitationSent,
      OX_TARGET.opportunityInvitation,
      created.id,
      {
        organizationId: params.organizationId,
        opportunityId: params.opportunityId,
        candidateUserId: params.candidateUserId,
        status: "SENT",
      },
      tx
    );
    return created;
  });
  const ctx = await loadPublicContext(row.id).catch(() => null);
  if (ctx && ctx.candidateUserId) {
    await notifyCandidateOf({
      invitationId: row.id,
      candidateUserId: ctx.candidateUserId,
      actorUserId: params.actorUserId,
      type: "HIRING_INVITATION",
      payload: {
        invitationId: row.id,
        organizationId: ctx.organizationId,
        organizationDisplayName: ctx.organizationDisplayName,
        opportunityTitle: ctx.opportunityTitle,
      },
      dedupKey: `hiring:invitation:${row.id}:sent`,
    });
  }
  return row;
}

/**
 * Employer withdrawal (RD-11): permitted pre-acceptance (SENT / VIEWED /
 * NEGOTIATION_REQUESTED); structurally impossible from terminal states. The
 * pending proposal (if any) freezes as-is — append-only history is never
 * edited or deleted. Audited + candidate notified.
 */
export async function withdrawInvitation(params: {
  invitationId: string;
  organizationId: string;
  actorUserId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  await db.$transaction(async (tx) => {
    const res = await tx.opportunityInvitation.updateMany({
      where: {
        id: params.invitationId,
        organizationId: params.organizationId,
        status: { in: ["SENT", "VIEWED", "NEGOTIATION_REQUESTED"] },
      },
      data: {
        status: "WITHDRAWN",
        withdrawnAt: now,
        withdrawnByUserId: params.actorUserId,
        activeInvitationToken: null,
      },
    });
    if (res.count !== 1) {
      throw new InvitationRuleError(
        "OX_INVITATION_NOT_ACTIONABLE",
        409,
        "The invitation has already concluded and can no longer be withdrawn"
      );
    }
    const row = await tx.opportunityInvitation.findUniqueOrThrow({
      where: { id: params.invitationId },
      select: { opportunityId: true, candidateUserId: true },
    });
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.invitationWithdrawn,
      OX_TARGET.opportunityInvitation,
      params.invitationId,
      {
        organizationId: params.organizationId,
        opportunityId: row.opportunityId,
        candidateUserId: row.candidateUserId,
        status: "WITHDRAWN",
      },
      tx
    );
  });
  const ctx = await loadPublicContext(params.invitationId).catch(() => null);
  if (ctx) {
    await notifyCandidateOf({
      invitationId: params.invitationId,
      candidateUserId: ctx.candidateUserId,
      actorUserId: params.actorUserId,
      type: "HIRING_INVITATION_WITHDRAWN",
      payload: {
        invitationId: params.invitationId,
        organizationDisplayName: ctx.organizationDisplayName,
        opportunityTitle: ctx.opportunityTitle,
      },
      dedupKey: `hiring:invitation:${params.invitationId}:withdrawn`,
    });
  }
}

// ---------- Candidate transitions (recipient-only; override B) ----------

/**
 * RD-18: automatic VIEWED on the candidate's first authorized read.
 * Guarded SENT→VIEWED; idempotent on later reads; audit-only — the employer
 * is NEVER notified for viewing.
 */
export async function markInvitationViewed(params: {
  invitationId: string;
  candidateUserId: string;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const transitioned = await db.$transaction(async (tx) => {
    const res = await tx.opportunityInvitation.updateMany({
      where: { id: params.invitationId, candidateUserId: params.candidateUserId, status: "SENT" },
      data: { status: "VIEWED", viewedAt: now },
    });
    if (res.count !== 1) return false;
    const row = await tx.opportunityInvitation.findUniqueOrThrow({
      where: { id: params.invitationId },
      select: { organizationId: true, opportunityId: true },
    });
    await auditOX(
      params.candidateUserId,
      OX_AUDIT_ACTIONS.invitationViewed,
      OX_TARGET.opportunityInvitation,
      params.invitationId,
      {
        organizationId: row.organizationId,
        opportunityId: row.opportunityId,
        candidateUserId: params.candidateUserId,
        status: "VIEWED",
      },
      tx
    );
    return true;
  });
  return transitioned;
}

/** Guarded {SENT,VIEWED} → ACCEPTED. Stamps the immutable accepted-terms
 * snapshot from the ORIGINAL OFFER exactly once (RD-10 direct path).
 * Candidate recipient only (override B: no consent consulted). */
export async function acceptInvitationDirectly(params: {
  invitationId: string;
  candidateUserId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  await db.$transaction(async (tx) => {
    const inv = await tx.opportunityInvitation.findFirst({
      where: { id: params.invitationId, candidateUserId: params.candidateUserId },
      select: {
        status: true,
        offerSalaryMinPaise: true,
        offerSalaryMaxPaise: true,
        offerCurrency: true,
        offerPeriod: true,
      },
    });
    if (!inv) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_FOUND", 404, "Invitation not found");
    }
    if (inv.status !== "SENT" && inv.status !== "VIEWED") {
      throw new InvitationRuleError(
        "OX_INVITATION_NOT_ACTIONABLE",
        409,
        `The invitation is ${inv.status} and can no longer be responded to`
      );
    }
    const res = await tx.opportunityInvitation.updateMany({
      where: { id: params.invitationId, candidateUserId: params.candidateUserId, status: { in: ["SENT", "VIEWED"] } },
      data: {
        status: "ACCEPTED",
        respondedAt: now,
        acceptedAt: now,
        acceptedSalaryMinPaise: inv.offerSalaryMinPaise,
        acceptedSalaryMaxPaise: inv.offerSalaryMaxPaise,
        acceptedCurrency: inv.offerCurrency,
        acceptedPeriod: inv.offerPeriod,
        activeInvitationToken: null,
      },
    });
    if (res.count !== 1) {
      // Lost a race (double-accept / accept-vs-withdraw / accept-vs-expiry) —
      // zero writes, truthful 409.
      throw new InvitationRuleError(
        "OX_INVITATION_NOT_ACTIONABLE",
        409,
        "The invitation has already concluded and can no longer be responded to"
      );
    }
    const row = await tx.opportunityInvitation.findUniqueOrThrow({
      where: { id: params.invitationId },
      select: { organizationId: true, opportunityId: true },
    });
    await auditOX(
      params.candidateUserId,
      OX_AUDIT_ACTIONS.invitationAccepted,
      OX_TARGET.opportunityInvitation,
      params.invitationId,
      {
        organizationId: row.organizationId,
        opportunityId: row.opportunityId,
        candidateUserId: params.candidateUserId,
        status: "ACCEPTED",
        source: "DIRECT",
      },
      tx
    );
  });
  const ctx = await loadPublicContext(params.invitationId).catch(() => null);
  if (ctx) {
    await notifyEmployerTeam({
      organizationId: ctx.organizationId,
      actorUserId: params.candidateUserId,
      type: "HIRING_INVITATION_DECISION",
      payload: {
        invitationId: params.invitationId,
        opportunityId: ctx.opportunityId,
        opportunityTitle: ctx.opportunityTitle,
        decision: "ACCEPTED",
        candidateUserId: params.candidateUserId,
      },
      dedupKey: `hiring:invitation:${params.invitationId}:decision:ACCEPTED`,
    });
  }
}

/** Guarded {SENT,VIEWED} → DECLINED (candidate recipient only). */
export async function declineInvitationDirectly(params: {
  invitationId: string;
  candidateUserId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  await db.$transaction(async (tx) => {
    const inv = await tx.opportunityInvitation.findFirst({
      where: { id: params.invitationId, candidateUserId: params.candidateUserId },
      select: { status: true },
    });
    if (!inv) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_FOUND", 404, "Invitation not found");
    }
    if (inv.status !== "SENT" && inv.status !== "VIEWED") {
      throw new InvitationRuleError(
        "OX_INVITATION_NOT_ACTIONABLE",
        409,
        `The invitation is ${inv.status} and can no longer be responded to`
      );
    }
    const res = await tx.opportunityInvitation.updateMany({
      where: { id: params.invitationId, candidateUserId: params.candidateUserId, status: { in: ["SENT", "VIEWED"] } },
      data: { status: "DECLINED", respondedAt: now, activeInvitationToken: null },
    });
    if (res.count !== 1) {
      throw new InvitationRuleError(
        "OX_INVITATION_NOT_ACTIONABLE",
        409,
        "The invitation has already concluded and can no longer be responded to"
      );
    }
    const row = await tx.opportunityInvitation.findUniqueOrThrow({
      where: { id: params.invitationId },
      select: { organizationId: true, opportunityId: true },
    });
    await auditOX(
      params.candidateUserId,
      OX_AUDIT_ACTIONS.invitationDeclined,
      OX_TARGET.opportunityInvitation,
      params.invitationId,
      {
        organizationId: row.organizationId,
        opportunityId: row.opportunityId,
        candidateUserId: params.candidateUserId,
        status: "DECLINED",
        source: "DIRECT",
      },
      tx
    );
  });
  const ctx = await loadPublicContext(params.invitationId).catch(() => null);
  if (ctx) {
    await notifyEmployerTeam({
      organizationId: ctx.organizationId,
      actorUserId: params.candidateUserId,
      type: "HIRING_INVITATION_DECISION",
      payload: {
        invitationId: params.invitationId,
        opportunityId: ctx.opportunityId,
        opportunityTitle: ctx.opportunityTitle,
        decision: "DECLINED",
        candidateUserId: params.candidateUserId,
      },
      dedupKey: `hiring:invitation:${params.invitationId}:decision:DECLINED`,
    });
  }
}

/**
 * Guarded {SENT,VIEWED} → NEGOTIATION_REQUESTED with an optional immediate
 * candidate proposal (RD-17 candidate agency; RD-9 protocol for the
 * proposal, which becomes seq 1). Audited; employer team notified
 * (decision NEGOTIATION_REQUESTED +, when terms are included, the
 * HIRING_NEGOTIATION_PROPOSAL event).
 */
export async function requestNegotiation(params: {
  invitationId: string;
  candidateUserId: string;
  terms?: NegotiationTerms;
  now?: Date;
}): Promise<{ seq: number | null }> {
  const now = params.now ?? new Date();
  let createdSeq: number | null = null;
  await db.$transaction(async (tx) => {
    const inv = await tx.opportunityInvitation.findFirst({
      where: { id: params.invitationId, candidateUserId: params.candidateUserId },
      select: { status: true, organizationId: true, opportunityId: true },
    });
    if (!inv) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_FOUND", 404, "Invitation not found");
    }
    if (inv.status !== "SENT" && inv.status !== "VIEWED") {
      throw new InvitationRuleError(
        "OX_INVITATION_NOT_ACTIONABLE",
        409,
        `The invitation is ${inv.status} and can no longer be responded to`
      );
    }
    const res = await tx.opportunityInvitation.updateMany({
      where: { id: params.invitationId, candidateUserId: params.candidateUserId, status: { in: ["SENT", "VIEWED"] } },
      data: { status: "NEGOTIATION_REQUESTED", respondedAt: now },
    });
    if (res.count !== 1) {
      throw new InvitationRuleError(
        "OX_INVITATION_NOT_ACTIONABLE",
        409,
        "The invitation has already concluded and can no longer be responded to"
      );
    }
    await auditOX(
      params.candidateUserId,
      OX_AUDIT_ACTIONS.invitationNegotiationRequested,
      OX_TARGET.opportunityInvitation,
      params.invitationId,
      {
        organizationId: inv.organizationId,
        opportunityId: inv.opportunityId,
        candidateUserId: params.candidateUserId,
        status: "NEGOTIATION_REQUESTED",
      },
      tx
    );
    if (params.terms) {
      createdSeq = await createProposalInTx(tx, {
        invitationId: params.invitationId,
        organizationId: inv.organizationId,
        opportunityId: inv.opportunityId,
        proposerRole: "CANDIDATE",
        proposerUserId: params.candidateUserId,
        terms: params.terms,
        now,
      });
    }
  });
  const ctx = await loadPublicContext(params.invitationId).catch(() => null);
  if (ctx) {
    await notifyEmployerTeam({
      organizationId: ctx.organizationId,
      actorUserId: params.candidateUserId,
      type: "HIRING_INVITATION_DECISION",
      payload: {
        invitationId: params.invitationId,
        opportunityId: ctx.opportunityId,
        opportunityTitle: ctx.opportunityTitle,
        decision: "NEGOTIATION_REQUESTED",
        candidateUserId: params.candidateUserId,
      },
      dedupKey: `hiring:invitation:${params.invitationId}:decision:NEGOTIATION_REQUESTED`,
    });
    if (createdSeq !== null) {
      await notifyEmployerTeam({
        organizationId: ctx.organizationId,
        actorUserId: params.candidateUserId,
        type: "HIRING_NEGOTIATION_PROPOSAL",
        payload: {
          invitationId: params.invitationId,
          seq: createdSeq,
          proposerRole: "CANDIDATE",
          opportunityId: ctx.opportunityId,
          opportunityTitle: ctx.opportunityTitle,
          candidateUserId: params.candidateUserId,
        },
        dedupKey: `hiring:invitation:${params.invitationId}:negotiation:seq-${createdSeq}`,
      });
    }
  }
  return { seq: createdSeq };
}

// ---------- Negotiation protocol (RD-9) ----------

/**
 * Core proposal creation INSIDE an existing transaction (both the standalone
 * propose endpoints and the negotiation-request immediate proposal use it).
 * Enforces: invitation NEGOTIATION_REQUESTED, cap of 6 proposals, monotonic
 * seq, one-PENDING supersede protocol (any new proposal supersedes the
 * standing PENDING — own re-propose and cross-party counter alike), and the
 * guarded zero-row → 409 race refusal. Append-only: nothing is ever edited
 * or deleted. Audits `ox.negotiation.proposed` (vocabulary meta only — the
 * audit NEVER carries the proposed numbers).
 */
async function createProposalInTx(
  tx: Client,
  params: {
    invitationId: string;
    organizationId: string;
    opportunityId: string;
    proposerRole: "EMPLOYER" | "CANDIDATE";
    proposerUserId: string;
    terms: NegotiationTerms;
    now: Date;
  }
): Promise<number> {
  const invitation = await tx.opportunityInvitation.findFirst({
    where: { id: params.invitationId, organizationId: params.organizationId },
    select: { id: true, status: true },
  });
  if (!invitation) {
    throw new InvitationRuleError("OX_NEGOTIATION_NOT_FOUND", 404, "Invitation not found");
  }
  if (invitation.status !== "NEGOTIATION_REQUESTED") {
    throw new InvitationRuleError(
      "OX_INVITATION_NOT_ACTIONABLE",
      409,
      `The invitation is ${invitation.status}; proposals require an active negotiation`
    );
  }
  const existing = await tx.invitationNegotiation.count({ where: { invitationId: params.invitationId } });
  if (existing >= OX_NEGOTIATION_MAX_PROPOSALS) {
    throw new InvitationRuleError(
      "OX_NEGOTIATION_LIMIT",
      409,
      "The maximum number of negotiation proposals for this invitation has been reached"
    );
  }
  const maxSeq = await tx.invitationNegotiation.aggregate({
    where: { invitationId: params.invitationId },
    _max: { seq: true },
  });
  const seq = (maxSeq._max.seq ?? 0) + 1;

  // One-PENDING protocol (RD-9): supersede the standing PENDING proposal in
  // this same transaction. Degenerate double-submits collapse here — the
  // guarded write matching zero rows is the deterministic race loser.
  let supersededSeq: number | null = null;
  const pending = await tx.invitationNegotiation.findFirst({
    where: { invitationId: params.invitationId, status: "PENDING" },
    select: { id: true, seq: true },
  });
  if (pending) {
    const res = await tx.invitationNegotiation.updateMany({
      where: { id: pending.id, invitationId: params.invitationId, status: "PENDING" },
      data: { status: "SUPERSEDED", decidedAt: params.now },
    });
    if (res.count !== 1) {
      throw new InvitationRuleError(
        "OX_NEGOTIATION_PENDING_EXISTS",
        409,
        "Another proposal just became pending; re-check the thread and retry"
      );
    }
    supersededSeq = pending.seq;
  }

  const { min, max } = convertProposalTerms(params.terms);
  await tx.invitationNegotiation.create({
    data: {
      invitationId: params.invitationId,
      seq,
      proposerRole: params.proposerRole,
      proposerUserId: params.proposerUserId,
      proposedSalaryMinPaise: min,
      proposedSalaryMaxPaise: max,
      proposedCurrency: params.terms.proposedCurrency,
      proposedPeriod: params.terms.proposedPeriod,
      status: "PENDING",
      expiresAt: new Date(params.now.getTime() + OX_NEGOTIATION_TTL_MS),
    },
  });
  await auditOX(
    params.proposerUserId,
    OX_AUDIT_ACTIONS.negotiationProposed,
    OX_TARGET.invitationNegotiation,
    params.invitationId,
    {
      organizationId: params.organizationId,
      opportunityId: params.opportunityId,
      invitationId: params.invitationId,
      seq,
      ...(supersededSeq !== null ? { supersedesSeq: supersededSeq } : {}),
      proposerRole: params.proposerRole,
    },
    tx
  );
  return seq;
}

/** Employer proposal (invitation must be NEGOTIATION_REQUESTED; RD-9). */
export async function createEmployerProposal(params: {
  invitationId: string;
  organizationId: string;
  proposerUserId: string;
  terms: NegotiationTerms;
  now?: Date;
}): Promise<{ seq: number }> {
  const now = params.now ?? new Date();
  const seq = await db.$transaction(async (tx) => {
    const inv = await tx.opportunityInvitation.findFirst({
      where: { id: params.invitationId, organizationId: params.organizationId },
      select: { opportunityId: true },
    });
    if (!inv) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_FOUND", 404, "Invitation not found");
    }
    return createProposalInTx(tx, {
      invitationId: params.invitationId,
      organizationId: params.organizationId,
      opportunityId: inv.opportunityId,
      proposerRole: "EMPLOYER",
      proposerUserId: params.proposerUserId,
      terms: params.terms,
      now,
    });
  });
  const ctx = await loadPublicContext(params.invitationId).catch(() => null);
  if (ctx) {
    await notifyCandidateOf({
      invitationId: params.invitationId,
      candidateUserId: ctx.candidateUserId,
      actorUserId: params.proposerUserId,
      type: "HIRING_NEGOTIATION_PROPOSAL",
      payload: {
        invitationId: params.invitationId,
        seq,
        proposerRole: "EMPLOYER",
        organizationDisplayName: ctx.organizationDisplayName,
        opportunityTitle: ctx.opportunityTitle,
      },
      dedupKey: `hiring:invitation:${params.invitationId}:negotiation:seq-${seq}`,
    });
  }
  return { seq };
}

/** Candidate counter-proposal (recipient-only; RD-9 — the counter IS the
 * response to the standing employer proposal). */
export async function createCandidateProposal(params: {
  invitationId: string;
  candidateUserId: string;
  terms: NegotiationTerms;
  now?: Date;
}): Promise<{ seq: number }> {
  const now = params.now ?? new Date();
  const seq = await db.$transaction(async (tx) => {
    const inv = await tx.opportunityInvitation.findFirst({
      where: { id: params.invitationId, candidateUserId: params.candidateUserId },
      select: { organizationId: true, opportunityId: true, status: true },
    });
    if (!inv) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_FOUND", 404, "Invitation not found");
    }
    return createProposalInTx(tx, {
      invitationId: params.invitationId,
      organizationId: inv.organizationId,
      opportunityId: inv.opportunityId,
      proposerRole: "CANDIDATE",
      proposerUserId: params.candidateUserId,
      terms: params.terms,
      now,
    });
  });
  const ctx = await loadPublicContext(params.invitationId).catch(() => null);
  if (ctx) {
    await notifyEmployerTeam({
      organizationId: ctx.organizationId,
      actorUserId: params.candidateUserId,
      type: "HIRING_NEGOTIATION_PROPOSAL",
      payload: {
        invitationId: params.invitationId,
        seq,
        proposerRole: "CANDIDATE",
        opportunityId: ctx.opportunityId,
        opportunityTitle: ctx.opportunityTitle,
        candidateUserId: params.candidateUserId,
      },
      dedupKey: `hiring:invitation:${params.invitationId}:negotiation:seq-${seq}`,
    });
  }
  return { seq };
}

/**
 * Accept a PENDING proposal — RECIPIENT ONLY (accepting your own proposal is
 * refused). One atomic transaction: proposal PENDING → ACCEPTED **and**
 * invitation NEGOTIATION_REQUESTED → ACCEPTED with the accepted-terms
 * snapshot copied EXACTLY from the winning proposal (RD-10). If the
 * invitation guard fails (withdraw race, expiry, already terminal) the whole
 * transaction rolls back — no contradictory final terms are possible.
 */
export async function acceptProposal(params: {
  invitationId: string;
  negotiationId: string;
  /** EMPLOYER accepts a CANDIDATE proposal; CANDIDATE accepts an EMPLOYER one. */
  acceptorSide: "EMPLOYER" | "CANDIDATE";
  /** Tenant/recipient binding for the guarded invitation write. */
  organizationId?: string;
  candidateUserId?: string;
  actorUserId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  await db.$transaction(async (tx) => {
    const binding = params.acceptorSide === "EMPLOYER" ? { organizationId: params.organizationId } : { candidateUserId: params.candidateUserId };
    const invitation = await tx.opportunityInvitation.findFirst({
      where: { id: params.invitationId, ...binding },
      select: { id: true, status: true, organizationId: true, opportunityId: true, candidateUserId: true },
    });
    if (!invitation) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_FOUND", 404, "Invitation not found");
    }
    const proposal = await tx.invitationNegotiation.findFirst({
      where: { id: params.negotiationId, invitationId: params.invitationId },
      select: { id: true, status: true, proposerRole: true, seq: true },
    });
    if (!proposal) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_FOUND", 404, "Negotiation proposal not found");
    }
    if (proposal.status !== "PENDING") {
      throw new InvitationRuleError(
        "OX_NEGOTIATION_NOT_PENDING",
        409,
        `The proposal is ${proposal.status} and is no longer pending`
      );
    }
    if (proposal.proposerRole === params.acceptorSide) {
      throw new InvitationRuleError(
        "OX_NEGOTIATION_NOT_PENDING",
        409,
        "Only the counterparty can accept a proposal"
      );
    }
    const pres = await tx.invitationNegotiation.updateMany({
      where: { id: proposal.id, invitationId: params.invitationId, status: "PENDING" },
      data: { status: "ACCEPTED", decidedAt: now },
    });
    if (pres.count !== 1) {
      throw new InvitationRuleError(
        "OX_NEGOTIATION_NOT_PENDING",
        409,
        "The proposal is no longer pending"
      );
    }
    const terms = await tx.invitationNegotiation.findUniqueOrThrow({
      where: { id: proposal.id },
      select: {
        proposedSalaryMinPaise: true,
        proposedSalaryMaxPaise: true,
        proposedCurrency: true,
        proposedPeriod: true,
      },
    });
    const ires = await tx.opportunityInvitation.updateMany({
      where: { id: params.invitationId, status: "NEGOTIATION_REQUESTED" },
      data: {
        status: "ACCEPTED",
        respondedAt: now,
        acceptedAt: now,
        acceptedSalaryMinPaise: terms.proposedSalaryMinPaise,
        acceptedSalaryMaxPaise: terms.proposedSalaryMaxPaise,
        acceptedCurrency: terms.proposedCurrency,
        acceptedPeriod: terms.proposedPeriod,
        activeInvitationToken: null,
      },
    });
    if (ires.count !== 1) {
      // Roll back the proposal ACCEPTED too — no contradictory final terms.
      throw new InvitationRuleError(
        "OX_INVITATION_NOT_ACTIONABLE",
        409,
        "The invitation has already concluded and can no longer be accepted"
      );
    }
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.negotiationAccepted,
      OX_TARGET.invitationNegotiation,
      params.invitationId,
      {
        organizationId: invitation.organizationId,
        opportunityId: invitation.opportunityId,
        invitationId: params.invitationId,
        seq: proposal.seq,
      },
      tx
    );
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.invitationAccepted,
      OX_TARGET.opportunityInvitation,
      params.invitationId,
      {
        organizationId: invitation.organizationId,
        opportunityId: invitation.opportunityId,
        candidateUserId: invitation.candidateUserId,
        status: "ACCEPTED",
        source: `SEQ_${proposal.seq}`,
      },
      tx
    );
  });
  // RD-12/RD-13: employer decision notification when the CANDIDATE accepted;
  // (when the employer accepts, the candidate has no approved decision
  // notification — inbox state is truthful).
  if (params.acceptorSide === "CANDIDATE") {
    const ctx = await loadPublicContext(params.invitationId).catch(() => null);
    if (ctx) {
      await notifyEmployerTeam({
        organizationId: ctx.organizationId,
        actorUserId: params.actorUserId,
        type: "HIRING_INVITATION_DECISION",
        payload: {
          invitationId: params.invitationId,
          opportunityId: ctx.opportunityId,
          opportunityTitle: ctx.opportunityTitle,
          decision: "ACCEPTED",
          candidateUserId: params.candidateUserId ?? null,
        },
        dedupKey: `hiring:invitation:${params.invitationId}:decision:ACCEPTED`,
      });
    }
  }
}

/**
 * Decline a PENDING proposal (recipient only) — RD-7 symmetric rule:
 * declining the standing proposal DECLINES the invitation. One transaction,
 * both guarded writes, append-only history preserved.
 */
export async function declineProposal(params: {
  invitationId: string;
  negotiationId: string;
  declinerSide: "EMPLOYER" | "CANDIDATE";
  organizationId?: string;
  candidateUserId?: string;
  actorUserId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  await db.$transaction(async (tx) => {
    const binding = params.declinerSide === "EMPLOYER" ? { organizationId: params.organizationId } : { candidateUserId: params.candidateUserId };
    const invitation = await tx.opportunityInvitation.findFirst({
      where: { id: params.invitationId, ...binding },
      select: { id: true, status: true, organizationId: true, opportunityId: true, candidateUserId: true },
    });
    if (!invitation) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_FOUND", 404, "Invitation not found");
    }
    const proposal = await tx.invitationNegotiation.findFirst({
      where: { id: params.negotiationId, invitationId: params.invitationId },
      select: { id: true, status: true, proposerRole: true, seq: true },
    });
    if (!proposal) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_FOUND", 404, "Negotiation proposal not found");
    }
    if (proposal.status !== "PENDING") {
      throw new InvitationRuleError(
        "OX_NEGOTIATION_NOT_PENDING",
        409,
        `The proposal is ${proposal.status} and is no longer pending`
      );
    }
    if (proposal.proposerRole === params.declinerSide) {
      throw new InvitationRuleError(
        "OX_NEGOTIATION_NOT_PENDING",
        409,
        "Only the counterparty can decline a proposal"
      );
    }
    const pres = await tx.invitationNegotiation.updateMany({
      where: { id: proposal.id, invitationId: params.invitationId, status: "PENDING" },
      data: { status: "DECLINED", decidedAt: now },
    });
    if (pres.count !== 1) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_PENDING", 409, "The proposal is no longer pending");
    }
    const ires = await tx.opportunityInvitation.updateMany({
      where: { id: params.invitationId, status: "NEGOTIATION_REQUESTED" },
      data: { status: "DECLINED", respondedAt: now, activeInvitationToken: null },
    });
    if (ires.count !== 1) {
      throw new InvitationRuleError(
        "OX_INVITATION_NOT_ACTIONABLE",
        409,
        "The invitation has already concluded"
      );
    }
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.negotiationDeclined,
      OX_TARGET.invitationNegotiation,
      params.invitationId,
      {
        organizationId: invitation.organizationId,
        opportunityId: invitation.opportunityId,
        invitationId: params.invitationId,
        seq: proposal.seq,
      },
      tx
    );
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.invitationDeclined,
      OX_TARGET.opportunityInvitation,
      params.invitationId,
      {
        organizationId: invitation.organizationId,
        opportunityId: invitation.opportunityId,
        candidateUserId: invitation.candidateUserId,
        status: "DECLINED",
        source: `SEQ_${proposal.seq}`,
      },
      tx
    );
  });
  if (params.declinerSide === "CANDIDATE") {
    const ctx = await loadPublicContext(params.invitationId).catch(() => null);
    if (ctx) {
      await notifyEmployerTeam({
        organizationId: ctx.organizationId,
        actorUserId: params.actorUserId,
        type: "HIRING_INVITATION_DECISION",
        payload: {
          invitationId: params.invitationId,
          opportunityId: ctx.opportunityId,
          opportunityTitle: ctx.opportunityTitle,
          decision: "DECLINED",
          candidateUserId: params.candidateUserId ?? null,
        },
        dedupKey: `hiring:invitation:${params.invitationId}:decision:DECLINED`,
      });
    }
  }
}

/**
 * Proposer withdraws their OWN pending proposal (thread continues — the
 * invitation stays NEGOTIATION_REQUESTED; the counterparty may counter).
 * Append-only: the row flips to WITHDRAWN, nothing is deleted.
 */
export async function withdrawProposal(params: {
  invitationId: string;
  negotiationId: string;
  withdrawerSide: "EMPLOYER" | "CANDIDATE";
  organizationId?: string;
  candidateUserId?: string;
  actorUserId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  await db.$transaction(async (tx) => {
    const binding = params.withdrawerSide === "EMPLOYER" ? { organizationId: params.organizationId } : { candidateUserId: params.candidateUserId };
    const invitation = await tx.opportunityInvitation.findFirst({
      where: { id: params.invitationId, ...binding },
      select: { id: true, status: true, organizationId: true, opportunityId: true },
    });
    if (!invitation) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_FOUND", 404, "Invitation not found");
    }
    if (invitation.status !== "NEGOTIATION_REQUESTED") {
      throw new InvitationRuleError(
        "OX_INVITATION_NOT_ACTIONABLE",
        409,
        `The invitation is ${invitation.status}; proposals are only actionable during negotiation`
      );
    }
    const proposal = await tx.invitationNegotiation.findFirst({
      where: { id: params.negotiationId, invitationId: params.invitationId },
      select: { id: true, status: true, proposerRole: true, seq: true },
    });
    if (!proposal) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_FOUND", 404, "Negotiation proposal not found");
    }
    if (proposal.proposerRole !== params.withdrawerSide) {
      throw new InvitationRuleError(
        "OX_NEGOTIATION_NOT_PENDING",
        409,
        "Only the proposer can withdraw their own pending proposal"
      );
    }
    const res = await tx.invitationNegotiation.updateMany({
      where: { id: proposal.id, invitationId: params.invitationId, status: "PENDING" },
      data: { status: "WITHDRAWN", decidedAt: now },
    });
    if (res.count !== 1) {
      throw new InvitationRuleError("OX_NEGOTIATION_NOT_PENDING", 409, "The proposal is no longer pending");
    }
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.negotiationWithdrawn,
      OX_TARGET.invitationNegotiation,
      params.invitationId,
      {
        organizationId: invitation.organizationId,
        opportunityId: invitation.opportunityId,
        invitationId: params.invitationId,
        seq: proposal.seq,
      },
      tx
    );
  });
}

// ---------- Expiry sweep (RD-6; existing queue; transition-only) ----------

export interface InvitationExpirySweepCounts {
  expiredInvitations: number;
  expiredProposals: number;
  stalledNegotiations: number;
}

/**
 * The transition-only expiry sweep (RD-6). NEVER resurrects: every write is
 * guarded on a pre-response / pending state, so ACCEPTED / DECLINED /
 * WITHDRAWN rows are structurally unreachable and a second run matches zero
 * rows (idempotent). Never deletes. Never grants access or consent.
 */
export async function sweepExpiredInvitations(now: Date = new Date()): Promise<InvitationExpirySweepCounts> {
  const counts: InvitationExpirySweepCounts = {
    expiredInvitations: 0,
    expiredProposals: 0,
    stalledNegotiations: 0,
  };

  // 1. SENT/VIEWED invitations past their response window.
  const dueInvitations = await db.opportunityInvitation.findMany({
    where: { status: { in: ["SENT", "VIEWED"] }, expiresAt: { lt: now } },
    select: { id: true, organizationId: true, opportunityId: true, candidateUserId: true },
    take: OX_INVITATION_SWEEP_BATCH,
  });
  for (const inv of dueInvitations) {
    const res = await db.opportunityInvitation.updateMany({
      where: { id: inv.id, status: { in: ["SENT", "VIEWED"] } },
      data: { status: "EXPIRED", activeInvitationToken: null },
    });
    if (res.count !== 1) continue; // a response or withdrawal won the race
    counts.expiredInvitations += 1;
    await auditOX(null, OX_AUDIT_ACTIONS.invitationExpired, OX_TARGET.opportunityInvitation, inv.id, {
      organizationId: inv.organizationId,
      opportunityId: inv.opportunityId,
      candidateUserId: inv.candidateUserId,
      status: "EXPIRED",
    });
    await notifyEmployerTeam({
      organizationId: inv.organizationId,
      actorUserId: null,
      type: "HIRING_INVITATION_EXPIRED",
      payload: {
        invitationId: inv.id,
        opportunityId: inv.opportunityId,
        opportunityTitle: null,
      },
      dedupKey: `hiring:invitation:${inv.id}:expired`,
    });
  }

  // 2. PENDING proposals past their 7-day window → proposal EXPIRED, and the
  // invitation EXPIRED only when still NEGOTIATION_REQUESTED (one per-row
  // transaction; bounded batch).
  const dueProposals = await db.invitationNegotiation.findMany({
    where: { status: "PENDING", expiresAt: { lt: now } },
    select: { id: true, invitationId: true, seq: true },
    take: OX_INVITATION_SWEEP_BATCH,
  });
  for (const p of dueProposals) {
    const invitationExpired = await db.$transaction(async (tx) => {
      const pres = await tx.invitationNegotiation.updateMany({
        where: { id: p.id, status: "PENDING" },
        data: { status: "EXPIRED", decidedAt: now },
      });
      if (pres.count !== 1) return null;
      const inv = await tx.opportunityInvitation.findUniqueOrThrow({
        where: { id: p.invitationId },
        select: { id: true, organizationId: true, opportunityId: true, candidateUserId: true, status: true },
      });
      const ires =
        inv.status === "NEGOTIATION_REQUESTED"
          ? await tx.opportunityInvitation.updateMany({
              where: { id: inv.id, status: "NEGOTIATION_REQUESTED" },
              data: { status: "EXPIRED", activeInvitationToken: null },
            })
          : { count: 0 };
      await auditOX(null, OX_AUDIT_ACTIONS.negotiationExpired, OX_TARGET.invitationNegotiation, inv.id, {
        organizationId: inv.organizationId,
        opportunityId: inv.opportunityId,
        invitationId: inv.id,
        seq: p.seq,
      }, tx);
      if (ires.count === 1) {
        await auditOX(null, OX_AUDIT_ACTIONS.invitationExpired, OX_TARGET.opportunityInvitation, inv.id, {
          organizationId: inv.organizationId,
          opportunityId: inv.opportunityId,
          candidateUserId: inv.candidateUserId,
          status: "EXPIRED",
          source: "PROPOSAL_TTL",
        }, tx);
      }
      return ires.count === 1;
    });
    if (invitationExpired === null) continue;
    counts.expiredProposals += 1;
    const inv = await db.opportunityInvitation.findUnique({
      where: { id: p.invitationId },
      select: { organizationId: true, opportunityId: true, status: true },
    });
    if (inv?.status === "EXPIRED") {
      await notifyEmployerTeam({
        organizationId: inv.organizationId,
        actorUserId: null,
        type: "HIRING_INVITATION_EXPIRED",
        payload: {
          invitationId: p.invitationId,
          opportunityId: inv.opportunityId,
          opportunityTitle: null,
        },
        dedupKey: `hiring:invitation:${p.invitationId}:expired`,
      });
    }
  }

  // 3. Stalled negotiations (RD-6): NEGOTIATION_REQUESTED, no PENDING
  // proposal, no proposal activity for 14 days → EXPIRED.
  const negotiating = await db.opportunityInvitation.findMany({
    where: { status: "NEGOTIATION_REQUESTED" },
    select: { id: true, organizationId: true, opportunityId: true, candidateUserId: true, respondedAt: true },
    take: OX_INVITATION_SWEEP_BATCH,
  });
  for (const inv of negotiating) {
    const pending = await db.invitationNegotiation.count({
      where: { invitationId: inv.id, status: "PENDING" },
    });
    if (pending > 0) continue;
    const latestProposal = await db.invitationNegotiation.findFirst({
      where: { invitationId: inv.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const activityAt = Math.max(
      inv.respondedAt?.getTime() ?? 0,
      latestProposal?.createdAt.getTime() ?? 0
    );
    if (now.getTime() - activityAt < NEGOTIATION_STALL_MS) continue;
    const res = await db.opportunityInvitation.updateMany({
      where: { id: inv.id, status: "NEGOTIATION_REQUESTED" },
      data: { status: "EXPIRED", activeInvitationToken: null },
    });
    if (res.count !== 1) continue;
    counts.stalledNegotiations += 1;
    await auditOX(null, OX_AUDIT_ACTIONS.invitationExpired, OX_TARGET.opportunityInvitation, inv.id, {
      organizationId: inv.organizationId,
      opportunityId: inv.opportunityId,
      candidateUserId: inv.candidateUserId,
      status: "EXPIRED",
      source: "NEGOTIATION_STALLED",
    });
    await notifyEmployerTeam({
      organizationId: inv.organizationId,
      actorUserId: null,
      type: "HIRING_INVITATION_EXPIRED",
      payload: {
        invitationId: inv.id,
        opportunityId: inv.opportunityId,
        opportunityTitle: null,
      },
      dedupKey: `hiring:invitation:${inv.id}:expired`,
    });
  }

  return counts;
}
