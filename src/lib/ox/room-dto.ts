import { salaryPaiseFromStorage } from "@/lib/ox/validation";

/**
 * Opportunity Exchange (M-O7) — hiring-room response serializers.
 *
 * One allowlist per AUDIENCE so routes cannot accidentally leak internal
 * fields (the dto.ts convention). Three audiences exist per RD-6 and
 * acceptance clarification A:
 *  - EMPLOYER (OWNER/ADMIN/RECRUITER/assigned HIRING_MANAGER): full detail —
 *    frozen terms, employer-private stage notes, members, interviews with
 *    meetingLink when live AND the caller holds room mutation rights.
 *  - CANDIDATE (the room's own candidate): reason CODES visible; the
 *    employer-private note is stripped ENTIRELY (never even null — RD-11);
 *    frozen terms are NOT re-exposed (the candidate negotiated them in M-O6;
 *    the room does not re-expose money — RD-18 payload rule); meetingLink
 *    only while PROPOSED/CONFIRMED and the caller passes includeMeetingLink.
 *  - VIEWER (ACTIVE org member without employer powers): an explicit
 *    read-only allowlist — no meetingLink anywhere, no compensation
 *    snapshot, no notes, no members, no candidate profile enrichment
 *    (RD-6 + clarification A).
 *
 * Every serializer omits the meetingLink for CANCELLED/COMPLETED interviews
 * for EVERY audience (RD-15). Salary crossing is BigInt storage → checked
 * `salaryPaiseFromStorage` → exact JSON numbers (never rounded/clamped).
 */

// ---------- Stored-row shapes (Prisma rows + relation includes) ----------

export type StoredHiringRoomMemberRow = {
  id: string;
  roomId: string;
  userId: string | null;
  roomRole: string;
  removedAt: Date | null;
  createdAt: Date;
};

export type StoredInterviewRow = {
  id: string;
  roomId: string;
  type: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  proposedByRole: string;
  cancelReason: string | null;
  completedAt: Date | null;
  /** Optional because the APPLIED M-O7 schema carries no
   * `Interview.meetingLink` column yet (parity-100 schema, not modifiable
   * from this task). The RD-15 visibility rule below is column-ready: the
   * moment the schema owner adds the field, links flow through unchanged. */
  meetingLink?: string | null;
  createdAt: Date;
};

export type StoredStageEventRow = {
  id: string;
  roomId: string;
  stage: string;
  fromStage: string | null;
  actorRole: string;
  actorUserId: string | null;
  reason: string | null;
  note: string | null;
  createdAt: Date;
};

export type StoredHiringRoomRow = {
  id: string;
  invitationId: string;
  organizationId: string;
  opportunityId: string;
  candidateUserId: string | null;
  candidateDisplayName: string;
  status: string;
  currentStage: string;
  acceptedSalaryMinPaise: bigint;
  acceptedSalaryMaxPaise: bigint;
  acceptedCurrency: string;
  acceptedPeriod: string;
  candidateTimezone: string | null;
  closedOutcome: string | null;
  closedReason: string | null;
  closedAt: Date | null;
  pausedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  members?: StoredHiringRoomMemberRow[];
  interviews?: StoredInterviewRow[];
  stages?: StoredStageEventRow[];
};

/** RD-15: the link survives serialization ONLY for live (PROPOSED/CONFIRMED)
 * interviews — CANCELLED/COMPLETED omit it for every audience. With no
 * stored link (schema gap, see StoredInterviewRow) every audience reads
 * `null` — the rule stays dormant but correct. */
function interviewLink(interview: StoredInterviewRow, include: boolean): string | null {
  if (!include) return null;
  if (interview.status !== "PROPOSED" && interview.status !== "CONFIRMED") return null;
  return interview.meetingLink ?? null;
}

// ---------- Employer serializer ----------

/**
 * The employer-side room detail (OWNER/ADMIN/RECRUITER/assigned
 * HIRING_MANAGER). Frozen terms are rendered through the checked O2.1
 * boundary. Stage history INCLUDES the employer-private notes (employer
 * audience only). `callerCanMutateRoom` must be passed TRUE only for
 * callers with room mutation rights (EMPLOYER_ROLES or ASSIGNED_MANAGER) —
 * meetingLink is included on live interviews only under that right (RD-15).
 */
export function serializeRoomForEmployer(
  room: StoredHiringRoomRow,
  opts: { includeCompensation?: boolean; callerCanMutateRoom?: boolean } = {}
): Record<string, unknown> {
  const includeCompensation = opts.includeCompensation ?? true;
  const canSeeLinks = opts.callerCanMutateRoom ?? false;
  return {
    id: room.id,
    invitationId: room.invitationId,
    organizationId: room.organizationId,
    opportunityId: room.opportunityId,
    candidateUserId: room.candidateUserId,
    // RD-19: the frozen identity snapshot — never refreshed from the live profile.
    candidateDisplayName: room.candidateDisplayName,
    status: room.status,
    currentStage: room.currentStage,
    candidateTimezone: room.candidateTimezone,
    ...(includeCompensation
      ? {
          // The immutable accepted snapshot copied at room creation (RD-19);
          // never recomputed from the opportunity.
          compensation: {
            salaryMinPaise: salaryPaiseFromStorage(room.acceptedSalaryMinPaise),
            salaryMaxPaise: salaryPaiseFromStorage(room.acceptedSalaryMaxPaise),
            currency: room.acceptedCurrency,
            period: room.acceptedPeriod,
          },
        }
      : {}),
    ...(room.members
      ? {
          members: room.members.map((m) => ({
            id: m.id,
            userId: m.userId,
            roomRole: m.roomRole,
            removedAt: m.removedAt ? m.removedAt.toISOString() : null,
            assignedAt: m.createdAt.toISOString(),
          })),
        }
      : {}),
    ...(room.interviews
      ? {
          interviews: room.interviews.map((i) => ({
            id: i.id,
            type: i.type,
            status: i.status,
            startsAt: i.startsAt.toISOString(),
            endsAt: i.endsAt.toISOString(),
            proposedByRole: i.proposedByRole,
            cancelReason: i.cancelReason,
            completedAt: i.completedAt ? i.completedAt.toISOString() : null,
            meetingLink: interviewLink(i, canSeeLinks),
          })),
        }
      : {}),
    ...(room.stages
      ? {
          // Employer audience: the private note IS included here (RD-11).
          stageHistory: room.stages.map((s) => ({
            id: s.id,
            stage: s.stage,
            fromStage: s.fromStage,
            actorRole: s.actorRole,
            actorUserId: s.actorUserId,
            reason: s.reason,
            note: s.note,
            at: s.createdAt.toISOString(),
          })),
        }
      : {}),
    pausedAt: room.pausedAt ? room.pausedAt.toISOString() : null,
    closure: {
      outcome: room.closedOutcome,
      reason: room.closedReason,
      at: room.closedAt ? room.closedAt.toISOString() : null,
    },
    createdByUserId: room.createdByUserId,
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
  };
}

// ---------- Candidate serializer ----------

/**
 * The candidate's own room view. Reason CODES are visible (RD-11); the
 * employer-private `note` is stripped ENTIRELY (the key never appears —
 * not even as null). Frozen accepted terms are NOT included: the candidate
 * negotiated them in M-O6 and the room does not re-expose money (RD-18
 * payload rule). Interviews carry the meetingLink only while
 * PROPOSED/CONFIRMED and only when the caller passes includeMeetingLink
 * (the candidate is a link recipient, RD-15).
 */
export function serializeRoomForCandidate(
  room: StoredHiringRoomRow,
  opts: { includeMeetingLink?: boolean } = {}
): Record<string, unknown> {
  const includeLink = opts.includeMeetingLink ?? false;
  return {
    id: room.id,
    opportunityId: room.opportunityId,
    status: room.status,
    currentStage: room.currentStage,
    candidateDisplayName: room.candidateDisplayName,
    ...(room.interviews
      ? {
          interviews: room.interviews.map((i) => ({
            id: i.id,
            type: i.type,
            status: i.status,
            startsAt: i.startsAt.toISOString(),
            endsAt: i.endsAt.toISOString(),
            proposedByRole: i.proposedByRole,
            cancelReason: i.cancelReason,
            completedAt: i.completedAt ? i.completedAt.toISOString() : null,
            meetingLink: interviewLink(i, includeLink),
          })),
        }
      : {}),
    ...(room.stages
      ? {
          // Codes only — the note key is structurally absent (RD-11).
          stageHistory: room.stages.map((s) => ({
            stage: s.stage,
            fromStage: s.fromStage,
            actorRole: s.actorRole,
            reason: s.reason,
            at: s.createdAt.toISOString(),
          })),
        }
      : {}),
    closure: {
      outcome: room.closedOutcome,
      reason: room.closedReason, // reason CODE visible (RD-11)
      at: room.closedAt ? room.closedAt.toISOString() : null,
    },
    createdAt: room.createdAt.toISOString(),
  };
}

// ---------- Viewer serializer (RD-6 + clarification A) ----------

/**
 * Verification record for acceptance clarification A (VIEWER field-level
 * authorization): the compensation snapshot is NOT exposed to org VIEWERs.
 * The O0 sources were inspected for any rule granting VIEWERs compensation
 * visibility — none exists, so the field is withheld. Evidence below cites
 * the exact locations checked.
 */
export const VIEWER_COMPENSATION_RULE_VERIFICATION = {
  result: "no O0 source rule authorizes compensation exposure to org VIEWERs — withheld per clarification A",
  surfacesInspected: [
    {
      file: "src/lib/ox/dto.ts",
      symbol: "serializeCandidateProfileForViewer / compensationForViewer",
      lines: "111-175, 209-226",
      finding:
        "The ONLY viewer compensation surface in the codebase is the candidate-profile disclosure matrix (compensationForViewer), scoped to discovery/preview REQUESTERS (isVerifiedEmployer/hasActiveInvite context) — it is profile-scoped, not room-scoped, and grants nothing to an org VIEWER reading a hiring room.",
    },
    {
      file: "docs/ops/O0_OPPORTUNITY_EXCHANGE_AUDIT.md",
      symbol: "§5 Deliverable 5 — Authorization matrix",
      lines: "285-301",
      finding:
        "The HiringRoom row grants org VIEWERs 'read-only' with no field-level authorization; every other employer-side compensation-bearing surface (Opportunity, discovery search, candidate preview, shortlists, invitations) marks the VIEWER column '—'.",
    },
    {
      file: "docs/ops/O0_OPPORTUNITY_EXCHANGE_AUDIT.md",
      symbol: "§6 Deliverable 6 — Salary privacy",
      lines: "333-337",
      finding:
        "compensationVisibility ∈ {HIDDEN, VERIFIED_EMPLOYERS, AFTER_INVITE, RANGE_ONLY} governs discovery/preview responses 'unless the candidate's chosen visibility permits it for THAT requester' — a candidate-profile disclosure rule, not a room-viewer grant.",
    },
    {
      file: "docs/ops/O0_OPPORTUNITY_EXCHANGE_AUDIT.md",
      symbol: "Part I3 integrity rules (invitation snapshot)",
      lines: "176-183",
      finding:
        "The invitation compensation snapshot is employer-authored data frozen at send/acceptance; O0 grants the candidate and hiring roles visibility through the M-O6 invitation surfaces — no rule extends it to org VIEWERs on hiring rooms.",
    },
  ],
} as const;

/**
 * The org VIEWER's read-only room view (RD-6 + clarification A): an explicit
 * allowlist — room id, status, currentStage, opportunity id/title, the
 * FROZEN candidate display name (identity only — never profile enrichment),
 * createdAt, plus code-only stage history and interviews WITHOUT links.
 * Structurally absent: meetingLink (every interview, every state),
 * compensation snapshot, notes, members, candidate profile content.
 */
export function serializeRoomForViewer(
  room: StoredHiringRoomRow,
  opportunity?: { id: string; title: string | null }
): Record<string, unknown> {
  return {
    id: room.id,
    status: room.status,
    currentStage: room.currentStage,
    opportunity: {
      id: opportunity?.id ?? room.opportunityId,
      title: opportunity?.title ?? null,
    },
    // RD-19: frozen identity snapshot only — no live profile enrichment.
    candidateDisplayName: room.candidateDisplayName,
    ...(room.interviews
      ? {
          // RD-6/RD-15: NO meetingLink anywhere on the viewer shape.
          interviews: room.interviews.map((i) => ({
            id: i.id,
            type: i.type,
            status: i.status,
            startsAt: i.startsAt.toISOString(),
            endsAt: i.endsAt.toISOString(),
            proposedByRole: i.proposedByRole,
            cancelReason: i.cancelReason,
          })),
        }
      : {}),
    ...(room.stages
      ? {
          // Vocabulary codes only — no note key, no actor identity.
          stageHistory: room.stages.map((s) => ({
            stage: s.stage,
            fromStage: s.fromStage,
            actorRole: s.actorRole,
            reason: s.reason,
            at: s.createdAt.toISOString(),
          })),
        }
      : {}),
    createdAt: room.createdAt.toISOString(),
  };
}
