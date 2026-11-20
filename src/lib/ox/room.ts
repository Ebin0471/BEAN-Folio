import { db } from "@/lib/db";
import { notify, notifyMany } from "@/lib/notify";
import type { PrismaClient } from "@prisma/client";
import { OX_AUDIT_ACTIONS, OX_TARGET, auditOX } from "./audit";
import { getMembership } from "./authz";

/**
 * Opportunity Exchange (M-O7) — hiring room + interview domain engine.
 *
 * Owner-approved implementation (M-O7 authorization; decisions RD-1…RD-22
 * plus acceptance clarifications A–D). Everything here is server-owned:
 * statuses/stages are never client-supplied, every state transition is a
 * status-guarded `updateMany` (zero-write 409 on any stale/illegal state),
 * and every authorization answer is re-derived per request — nothing cached,
 * nothing trusted from the client.
 *
 * Binding rules implemented here (register + plan are the authority):
 *  - RD-1: ONE room per invitation (`@unique(invitationId)`); concurrent
 *    creation attempts yield exactly one room — the loser observes the
 *    conflict through the P2002 catch (M-O6 OX_INVITATION_DUPLICATE
 *    convention) and receives 409 OX_HIRING_ROOM_EXISTS.
 *  - RD-2: status machine ACTIVE ⇄ ON_HOLD (recoverable) with terminal
 *    CANDIDATE_WITHDRAWN / CLOSED / CANCELLED; writes against ON_HOLD are
 *    rejected with OX_ROOM_NOT_ACTIONABLE. pause/resume: OWNER/ADMIN/
 *    RECRUITER plus the assigned HIRING_MANAGER. close/cancel exclude the
 *    HIRING_MANAGER. Rooms are never reopened.
 *  - RD-3: rooms are created explicitly by OWNER/ADMIN/RECRUITER; only an
 *    ACCEPTED invitation may spawn a room (the immutable join contract);
 *    no opportunity-status gate (hiring may proceed on FILLED/CLOSED
 *    listings).
 *  - RD-4: room-scoped HIRING_MANAGER assignment; the target must be an
 *    ACTIVE org member and never an org VIEWER (409 OX_MEMBER_NOT_ACTIVE);
 *    soft removal only — rows are never deleted.
 *  - RD-5: the assigned HIRING_MANAGER may perform stage transitions,
 *    interview daily operations and pause/resume; they may not create or
 *    close the room nor manage room members; an org HIRING_MANAGER who is
 *    NOT assigned to the room is 404-denied.
 *  - RD-6: org VIEWERs are read-only (serializers in room-dto.ts enforce
 *    the allowlist); zero mutation rights anywhere in this module.
 *  - RD-7: candidate withdrawal from ACTIVE or ON_HOLD; atomically sets the
 *    terminal CANDIDATE_WITHDRAWN, appends the WITHDRAWN stage event
 *    (actorRole "CANDIDATE") and auto-cancels PROPOSED/CONFIRMED interviews
 *    (cancelReason stays NULL — CANDIDATE_WITHDREW is not in the approved
 *    interview cancel vocabulary; the cause lives on the audit meta). Zero
 *    deletion anywhere.
 *  - RD-8: REJECTED (reason required) and HIRED (only reachable from OFFER)
 *    close the room atomically with the recorded outcome; CANCELLED is the
 *    outcome-less path and requires a reason.
 *  - RD-9/RD-10: the O0-FIXED ten-stage vocabulary, forward-only; illegal
 *    backward/skip transitions return 409 OX_STAGE_INVALID_TRANSITION with
 *    ZERO writes; history is append-only — never edited, never deleted.
 *  - RD-11: closed reason vocabularies for REJECTED / WITHDRAWN / room
 *    CANCELLED / interview CANCELLED; the optional employer `note` (≤500,
 *    zod-enforced at the route) is employer-private and NEVER serialized to
 *    the candidate; reason CODES are visible to the candidate.
 *  - RD-12/RD-13: interview scheduling protocol (employer proposes; the
 *    other side confirms or counters with an alternate slot; rescheduling a
 *    CONFIRMED interview returns it to PROPOSED under the rescheduler's
 *    role; the employer marks CONFIRMED → COMPLETED). Windows: endsAt >
 *    startsAt, 15 min–4 h inclusive, startsAt strictly future at
 *    propose/alternate/reschedule time — the ONLY past-time write is
 *    recording COMPLETED. Confirmation races resolve through guarded
 *    `updateMany`. No cross-interview overlap detection in v1 (RD-13).
 *  - RD-15: meetingLink is never rewritten or liveness-tested here; its
 *    serialization is restricted by the room-dto serializers (never to
 *    VIEWERs; omitted on CANCELLED/COMPLETED for every audience).
 *  - RD-16/clarification B: the activity timeline (getRoomActivityTimeline)
 *    is server-derived from HiringStageEvent + the append-only audit rows —
 *    interview history is NEVER rebuilt from the mutable Interview row.
 *  - RD-18/clarification C: notifications are best-effort, strictly AFTER
 *    commit, payload-minimal (identifiers, public titles and vocabulary
 *    codes only — never money, contact, links or profile content); terminal
 *    transitions produce exactly ONE candidate closure notification;
 *    reads never notify.
 *  - RD-19: the room freezes the candidate identity (`candidateDisplayName`
 *    = the candidate user's name at creation) and the accepted compensation
 *    snapshot at creation; neither is ever refreshed from live data.
 *  - RD-21: no automatic lifecycle — no sweep, no auto-expiry here.
 *
 * Retention honesty (clarification D): frozen identity and history are
 * retained per RD-19/RD-20; the legal-retention decision remains OPEN per
 * O0 D6 — nothing here claims legal approval.
 */

// ---------- Approved constants (RD-2/RD-8/RD-9/RD-11/RD-12/RD-13) ----------

/** Room status vocabulary (O7 RD-2). ON_HOLD rejects writes; terminals are final. */
export const HIRING_ROOM_STATUSES = [
  "ACTIVE",
  "ON_HOLD",
  "CANDIDATE_WITHDRAWN",
  "CLOSED",
  "CANCELLED",
] as const;

export type HiringRoomStatus = (typeof HIRING_ROOM_STATUSES)[number];

/** Ten-stage vocabulary (O7 RD-9, O0-FIXED order — the index IS the machine). */
export const HIRING_STAGES = [
  "INVITATION_ACCEPTED",
  "INITIAL_REVIEW",
  "SCREENING",
  "INTERVIEW",
  "ASSESSMENT",
  "REFERENCE_CHECK",
  "OFFER",
  "HIRED",
  "REJECTED",
  "WITHDRAWN",
] as const;

export type HiringStage = (typeof HIRING_STAGES)[number];

/** Terminal stage events (O7 RD-9/RD-10). HIRED/REJECTED close the room;
 * WITHDRAWN is the candidate's own terminal event. */
export const HIRING_STAGE_TERMINAL = ["HIRED", "REJECTED", "WITHDRAWN"] as const;

/** Employer room-cancellation reasons (O7 RD-11). */
export const HIRING_ROOM_CANCEL_REASONS = [
  "REQUISITION_CANCELLED",
  "OPPORTUNITY_CLOSED",
  "DUPLICATE",
  "OTHER",
] as const;

/** Candidate withdrawal reasons (O7 RD-11). */
export const HIRING_WITHDRAW_REASONS = [
  "ACCEPTED_OTHER_OFFER",
  "DECLINED_FURTHER_PROCESS",
  "PERSONAL",
  "COMPENSATION",
  "TIMING",
  "OTHER",
] as const;

/** Employer rejection reasons (O7 RD-11). */
export const HIRING_REJECT_REASONS = [
  "NOT_A_FIT",
  "SKILL_GAP",
  "EXPERIENCE_MISMATCH",
  "COMPENSATION_MISMATCH",
  "POSITION_FILLED",
  "POSITION_CLOSED",
  "OTHER",
] as const;

/** Interview types (O7 RD-12). */
export const HIRING_INTERVIEW_TYPES = ["PHONE_SCREEN", "VIDEO", "ONSITE", "ASSESSMENT", "OTHER"] as const;

/** Interview statuses (O7 RD-12). */
export const HIRING_INTERVIEW_STATUSES = ["PROPOSED", "CONFIRMED", "CANCELLED", "COMPLETED"] as const;

/** Interview cancellation reasons (O7 RD-11/RD-12). */
export const HIRING_INTERVIEW_CANCEL_REASONS = [
  "SCHEDULING_CONFLICT",
  "UNAVAILABLE",
  "NO_LONGER_REQUIRED",
  "OTHER",
] as const;

/** The two room parties (O7 RD-12 proposedByRole / stage actorRole). */
export const HIRING_PARTIES = ["EMPLOYER", "CANDIDATE"] as const;

export type HiringParty = (typeof HIRING_PARTIES)[number];

/** O7 RD-13: interview window bounds, inclusive, in minutes. */
export const OX_INTERVIEW_MIN_MINUTES = 15;
export const OX_INTERVIEW_MAX_MINUTES = 240;

/** Room-scoped role vocabulary (O7 RD-4 — exactly one room role in v1). */
export const HIRING_ROOM_ROLES = ["HIRING_MANAGER"] as const;

/** O7 RD-14: IANA-validated, display-only candidate timezone. UTC stays the
 * authoritative storage for every DateTime column; the server performs zero
 * local-time arithmetic. Validated against the platform's Intl timezone
 * registry with honest fallbacks (canonical UTC aliases) so a valid value
 * can never be refused by a registry quirk. */
export function isIanaTimezone(tz: string): boolean {
  const candidate = tz.trim();
  if (!candidate) return false;
  if (candidate === "UTC" || candidate === "Etc/UTC" || candidate === "GMT") return true;
  try {
    const supported: readonly string[] | undefined = Intl.supportedValuesOf?.("timeZone");
    if (supported && supported.includes(candidate)) return true;
    // Fallback probe: the runtime formatter is the final honesty check for
    // registries that resolve aliases `supportedValuesOf` omits.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

// ---------- Rule errors (routes map these onto the standard envelope) ----------

/** A refusal that is a RULE, not a crash: carries the approved OX error code
 * and HTTP status. Same shape as InvitationRuleError so a single mapRoomError
 * converts it onto the standard error envelope. */
export class RoomRuleError extends Error {
  constructor(
    /** Approved error-code vocabulary (O7 register + M-O6 conventions). */
    readonly code:
      | "OX_HIRING_ROOM_NOT_FOUND"
      | "OX_HIRING_ROOM_EXISTS"
      | "OX_INVITATION_NOT_ACTIONABLE"
      | "OX_ROOM_NOT_ACTIONABLE"
      | "OX_STAGE_INVALID_TRANSITION"
      | "OX_ROOM_INVALID_REASON"
      | "OX_ROOM_INVALID_TIMEZONE"
      | "OX_MEMBER_NOT_ACTIVE"
      | "OX_ROOM_MEMBER_NOT_FOUND"
      | "OX_INTERVIEW_INVALID_WINDOW"
      | "OX_INTERVIEW_NOT_ACTIONABLE"
      | "OX_INTERVIEW_NOT_FOUND",
    readonly httpStatus: number,
    message: string
  ) {
    super(message);
    this.name = "RoomRuleError";
  }
}

/** Map a thrown rule error onto the standard error envelope; null = not a
 * rule error (rethrow in the route so handler() produces the honest 500). */
export function roomErrorResponse(
  e: unknown
): { message: string; status: number; code: string } | null {
  if (e instanceof RoomRuleError) {
    return { message: e.message, status: e.httpStatus, code: e.code };
  }
  return null;
}

/** Either the global Prisma client or an interactive-transaction client. */
type Client = PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

// ---------- Party resolution (RD-5/RD-6 — re-derived per request) ----------

/**
 * What a caller IS on this room. The route layer turns `null` into a 404
 * (existence-hiding deny — covers unknown rooms, non-members, non-ACTIVE
 * memberships, org VIEWER-role users with no room grant and — critically —
 * an org HIRING_MANAGER who is NOT assigned to the room).
 */
export type RoomPartyAccess =
  | "EMPLOYER_ROLES" // ACTIVE org OWNER/ADMIN/RECRUITER (full employer powers)
  | "ASSIGNED_MANAGER" // ACTIVE org HIRING_MANAGER with a live room membership row
  | "VIEWER" // ACTIVE org member without employer roles (read-only grant)
  | "CANDIDATE" // the room's own candidate
  | null;

/**
 * Resolve the caller's access to one room. Loads the room (404-deny when
 * unknown), then derives: candidate match → CANDIDATE; ACTIVE org
 * membership → role-based (OWNER/ADMIN/RECRUITER → EMPLOYER_ROLES; an
 * ACTIVE org HIRING_MANAGER with a live (removedAt null) room row →
 * ASSIGNED_MANAGER; any other ACTIVE member → VIEWER). An org
 * HIRING_MANAGER not assigned to THIS room resolves to null (RD-5/RD-6
 * 404-deny). Includes `membershipId` when ASSIGNED_MANAGER.
 */
export async function resolveRoomParty(
  roomId: string,
  userId: string,
  client: Client = db
): Promise<{ access: RoomPartyAccess; room: Awaited<ReturnType<typeof client.hiringRoom.findFirst>>; membershipId: string | null }> {
  const room = await client.hiringRoom.findFirst({ where: { id: roomId } });
  if (!room) return { access: null, room: null, membershipId: null };
  if (room.candidateUserId && room.candidateUserId === userId) {
    return { access: "CANDIDATE", room, membershipId: null };
  }
  const membership = await getMembership(room.organizationId, userId, client);
  if (!membership || membership.status !== "ACTIVE") {
    return { access: null, room, membershipId: null };
  }
  if (membership.role === "OWNER" || membership.role === "ADMIN" || membership.role === "RECRUITER") {
    return { access: "EMPLOYER_ROLES", room, membershipId: null };
  }
  if (membership.role === "HIRING_MANAGER") {
    const row = await client.hiringRoomMember.findFirst({
      where: { roomId, userId, roomRole: "HIRING_MANAGER", removedAt: null },
      select: { id: true },
    });
    if (row) return { access: "ASSIGNED_MANAGER", room, membershipId: row.id };
    return { access: null, room, membershipId: null }; // unassigned HM — 404-deny (RD-5)
  }
  return { access: "VIEWER", room, membershipId: null }; // VIEWER and any other ACTIVE role
}

async function requireRoomAccess(
  roomId: string,
  actorUserId: string,
  allowed: readonly Exclude<RoomPartyAccess, null>[]
): Promise<{ room: NonNullable<Awaited<ReturnType<typeof resolveRoomParty>>["room"]>; access: Exclude<RoomPartyAccess, null> }> {
  const resolved = await resolveRoomParty(roomId, actorUserId);
  if (!resolved.access || !resolved.room || !allowed.includes(resolved.access)) {
    // 404-deny: outsiders, unassigned HIRING_MANAGERs, and role-excluded
    // members cannot distinguish "unknown room" from "not for you".
    throw new RoomRuleError("OX_HIRING_ROOM_NOT_FOUND", 404, "Hiring room not found");
  }
  return { room: resolved.room, access: resolved.access };
}

// ---------- Shared internals ----------

const STAGE_INDEX: ReadonlyMap<string, number> = new Map(HIRING_STAGES.map((s, i) => [s as string, i]));

/** Active-room guard for every mutating handler inside a transaction. */
async function assertRoomActiveInTx(tx: Client, roomId: string): Promise<void> {
  const room = await tx.hiringRoom.findFirst({ where: { id: roomId }, select: { status: true } });
  if (!room || room.status !== "ACTIVE") {
    throw new RoomRuleError("OX_ROOM_NOT_ACTIONABLE", 409, "The room is not in an actionable state");
  }
}

/** Post-commit reload of the public payload context (identifiers + public
 * title only — RD-18 payloads never carry money, contact or links). */
async function loadRoomPublicContext(roomId: string): Promise<{
  organizationId: string;
  opportunityId: string;
  candidateUserId: string | null;
  opportunityTitle: string | null;
} | null> {
  const row = await db.hiringRoom.findUnique({
    where: { id: roomId },
    select: {
      organizationId: true,
      opportunityId: true,
      candidateUserId: true,
      opportunity: { select: { title: true } },
    },
  });
  if (!row) return null;
  return {
    organizationId: row.organizationId,
    opportunityId: row.opportunityId,
    candidateUserId: row.candidateUserId,
    opportunityTitle: row.opportunity?.title ?? null,
  };
}

// ---------- Notifications (after commit, best-effort, payload-minimal) ----------

/** Employer notification roles (RD-18: ACTIVE OWNER/ADMIN/RECRUITER — the
 * M-O6 notifyEmployerTeam fan-out convention, extended with the room's
 * ACTIVE assigned HIRING_MANAGER, never the whole org). */
const EMPLOYER_NOTIFY_ROLES = ["OWNER", "ADMIN", "RECRUITER"] as const;

async function notifyRoomEmployerTeam(params: {
  organizationId: string;
  roomId: string;
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
    const managers = await db.hiringRoomMember.findMany({
      where: { roomId: params.roomId, roomRole: "HIRING_MANAGER", removedAt: null, userId: { not: null } },
      select: { userId: true },
    });
    const recipientIds = [...new Set([...members.map((m) => m.userId), ...managers.map((m) => m.userId as string)])];
    await notifyMany(
      recipientIds.map((userId) => ({
        userId,
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

/**
 * Interview events reach BOTH sides (RD-18). The candidate keeps the pinned
 * event dedup key verbatim; the employer-side fan-out scopes the same base
 * key per recipient (`:employer:{userId}`) because `Notification.dedupKey`
 * is GLOBALLY unique (@@unique) — one shared key across recipients would
 * let a later upsert steal the earlier recipient's row (the notify()
 * upsert rewrites the whole row including `userId`). Per-recipient scoping
 * is the minimal faithful implementation of "notify both".
 */
async function notifyInterviewParties(params: {
  room: { id: string; organizationId: string; candidateUserId: string | null };
  interviewId: string;
  event: "proposed" | "confirmed" | "alternate" | "rescheduled" | "cancelled" | "completed";
  actorUserId: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  const baseKey = `hiring:room:${params.room.id}:interview:${params.interviewId}:${params.event}`;
  try {
    if (params.room.candidateUserId) {
      await notify({
        userId: params.room.candidateUserId,
        actorId: params.actorUserId,
        type: "HIRING_INTERVIEW",
        payload: params.payload,
        dedupKey: baseKey,
      });
    }
  } catch {
    // notifications never break the primary action
  }
  try {
    const members = await db.employerMembership.findMany({
      where: { organizationId: params.room.organizationId, status: "ACTIVE", role: { in: [...EMPLOYER_NOTIFY_ROLES] } },
      select: { userId: true },
    });
    const managers = await db.hiringRoomMember.findMany({
      where: { roomId: params.room.id, roomRole: "HIRING_MANAGER", removedAt: null, userId: { not: null } },
      select: { userId: true },
    });
    const recipientIds = [...new Set([...members.map((m) => m.userId), ...managers.map((m) => m.userId as string)])];
    await notifyMany(
      recipientIds.map((userId) => ({
        userId,
        actorId: params.actorUserId,
        type: "HIRING_INTERVIEW",
        payload: params.payload,
        dedupKey: `${baseKey}:employer:${userId}`,
      }))
    );
  } catch {
    // notifications never break the primary action
  }
}

// ---------- Room creation (RD-1/RD-3/RD-19) ----------

/**
 * Spawn a hiring room from an ACCEPTED invitation (RD-1/RD-3/RD-19). ONE
 * transaction: load the invitation (404-deny when unknown, when tenant-
 * misbound, or when not ACCEPTED — an invitation may spawn a room only in
 * the ACCEPTED state; no opportunity-status gate exists, RD-3); copy the
 * frozen accepted snapshot (non-null on ACCEPTED — a null snapshot is a
 * corrupted row and refuses with OX_INVITATION_NOT_ACTIONABLE); freeze the
 * candidate identity (RD-19: the candidate user's CURRENT name at creation,
 * never refreshed afterwards); create the room ACTIVE at
 * INVITATION_ACCEPTED; append the initial stage event with honest
 * provenance (actorRole "CANDIDATE" — the candidate accepted); audit
 * `ox.room.created`. The `@unique(invitationId)` constraint is the
 * concurrency backstop: a racing duplicate create observes P2002 and maps
 * to 409 OX_HIRING_ROOM_EXISTS (RD-1). AFTER commit the candidate is
 * notified (payload: identifiers + opportunity title only, RD-18).
 *
 * `organizationId` is optional defense-in-depth tenant binding for the
 * route layer; when provided, a mismatched invitation 404s.
 */
export async function createRoomForInvitation(params: {
  actorUserId: string;
  invitationId: string;
  candidateTimezone?: string;
  organizationId?: string;
}): Promise<string> {
  if (params.candidateTimezone !== undefined && !isIanaTimezone(params.candidateTimezone)) {
    throw new RoomRuleError("OX_ROOM_INVALID_TIMEZONE", 400, "candidateTimezone must be a valid IANA timezone");
  }
  const roomId = await db.$transaction(async (tx) => {
    const invitation = await tx.opportunityInvitation.findFirst({
      where: {
        id: params.invitationId,
        ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      },
      select: {
        status: true,
        candidateUserId: true,
        opportunityId: true,
        organizationId: true,
        acceptedSalaryMinPaise: true,
        acceptedSalaryMaxPaise: true,
        acceptedCurrency: true,
        acceptedPeriod: true,
      },
    });
    if (!invitation || invitation.status !== "ACCEPTED") {
      // 404-deny: unknown and non-ACCEPTED invitations are indistinguishable
      // to the caller (existence hiding; the ACCEPTED join contract, RD-3).
      throw new RoomRuleError("OX_HIRING_ROOM_NOT_FOUND", 404, "Hiring room not found");
    }
    if (
      invitation.acceptedSalaryMinPaise === null ||
      invitation.acceptedSalaryMaxPaise === null ||
      invitation.acceptedCurrency === null ||
      invitation.acceptedPeriod === null
    ) {
      // An ACCEPTED row always carries the immutable snapshot (RD-10, M-O6);
      // a null field means a corrupted row — refuse honestly, write nothing.
      throw new RoomRuleError("OX_INVITATION_NOT_ACTIONABLE", 409, "The accepted invitation has no frozen terms snapshot");
    }
    if (!invitation.candidateUserId) {
      throw new RoomRuleError("OX_INVITATION_NOT_ACTIONABLE", 409, "The accepted invitation has no candidate to hire");
    }
    const candidate = await tx.user.findUnique({
      where: { id: invitation.candidateUserId },
      select: { name: true },
    });
    if (!candidate) {
      throw new RoomRuleError("OX_INVITATION_NOT_ACTIONABLE", 409, "The accepted invitation has no candidate to hire");
    }
    const room = await tx.hiringRoom
      .create({
        data: {
          invitationId: params.invitationId,
          organizationId: invitation.organizationId,
          opportunityId: invitation.opportunityId,
          candidateUserId: invitation.candidateUserId,
          candidateDisplayName: candidate.name, // RD-19: frozen at creation
          status: "ACTIVE",
          currentStage: "INVITATION_ACCEPTED",
          acceptedSalaryMinPaise: invitation.acceptedSalaryMinPaise,
          acceptedSalaryMaxPaise: invitation.acceptedSalaryMaxPaise,
          acceptedCurrency: invitation.acceptedCurrency,
          acceptedPeriod: invitation.acceptedPeriod,
          candidateTimezone: params.candidateTimezone ?? null,
          createdByUserId: params.actorUserId,
        },
      })
      .catch((e: { code?: string }) => {
        if (e?.code === "P2002") {
          // RD-1: one room per invitation — the DB unique is the concurrency
          // backstop; the racing loser observes the conflict (M-O6
          // OX_INVITATION_DUPLICATE convention).
          throw new RoomRuleError("OX_HIRING_ROOM_EXISTS", 409, "A hiring room already exists for this invitation");
        }
        throw e;
      });
    await tx.hiringStageEvent.create({
      data: {
        roomId: room.id,
        stage: "INVITATION_ACCEPTED",
        fromStage: null,
        actorRole: "CANDIDATE", // honest provenance: the candidate accepted
        actorUserId: invitation.candidateUserId,
        reason: null,
        note: null,
      },
    });
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.roomCreated, OX_TARGET.hiringRoom, room.id, {
      organizationId: invitation.organizationId,
      invitationId: params.invitationId,
      opportunityId: invitation.opportunityId,
    }, tx);
    return room.id;
  });
  const ctx = await loadRoomPublicContext(roomId).catch(() => null);
  if (ctx && ctx.candidateUserId) {
    await notify({
      userId: ctx.candidateUserId,
      actorId: params.actorUserId,
      type: "HIRING_ROOM_CREATED",
      // RD-18: identifiers + public title ONLY — never the frozen terms.
      payload: { roomId, opportunityId: ctx.opportunityId, opportunityTitle: ctx.opportunityTitle },
      dedupKey: `hiring:room:${roomId}:created`,
    }).catch(() => false);
  }
  return roomId;
}

// ---------- Pause / resume (RD-2) ----------

/**
 * OWNER/ADMIN/RECRUITER plus the ACTIVE assigned HIRING_MANAGER may pause
 * (ACTIVE → ON_HOLD) and resume (ON_HOLD → ACTIVE) a room (RD-2). Guarded
 * transitions: a stale/illegal state (already ON_HOLD, already ACTIVE,
 * terminal) matches zero rows → 409 OX_ROOM_NOT_ACTIONABLE, zero writes.
 */
export async function pauseRoom(params: { roomId: string; actorUserId: string }): Promise<void> {
  const { room } = await requireRoomAccess(params.roomId, params.actorUserId, ["EMPLOYER_ROLES", "ASSIGNED_MANAGER"]);
  const now = new Date();
  await db.$transaction(async (tx) => {
    const res = await tx.hiringRoom.updateMany({
      where: { id: params.roomId, status: "ACTIVE" },
      data: { status: "ON_HOLD", pausedAt: now },
    });
    if (res.count !== 1) {
      throw new RoomRuleError("OX_ROOM_NOT_ACTIONABLE", 409, "Only an ACTIVE room can be paused");
    }
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.roomPaused, OX_TARGET.hiringRoom, params.roomId, {
      organizationId: room.organizationId,
      status: "ON_HOLD",
    }, tx);
  });
}

export async function resumeRoom(params: { roomId: string; actorUserId: string }): Promise<void> {
  const { room } = await requireRoomAccess(params.roomId, params.actorUserId, ["EMPLOYER_ROLES", "ASSIGNED_MANAGER"]);
  await db.$transaction(async (tx) => {
    const res = await tx.hiringRoom.updateMany({
      where: { id: params.roomId, status: "ON_HOLD" },
      data: { status: "ACTIVE", pausedAt: null },
    });
    if (res.count !== 1) {
      throw new RoomRuleError("OX_ROOM_NOT_ACTIONABLE", 409, "Only an ON_HOLD room can be resumed");
    }
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.roomResumed, OX_TARGET.hiringRoom, params.roomId, {
      organizationId: room.organizationId,
      status: "ACTIVE",
    }, tx);
  });
}

// ---------- Stage machine (RD-8/RD-9/RD-10/RD-11) ----------

/**
 * Employer-side stage transition (RD-8/RD-9/RD-10/RD-11). The room must be
 * ACTIVE (ON_HOLD → 409 OX_ROOM_NOT_ACTIONABLE). WITHDRAWN is candidate-
 * only and is refused here with OX_STAGE_INVALID_TRANSITION — employers
 * never record WITHDRAWN. Forward-only: the new stage's O0-FIXED index must
 * be strictly greater than the current one (forward skips allowed); any
 * illegal transition returns 409 OX_STAGE_INVALID_TRANSITION with ZERO
 * writes (RD-10). HIRED is reachable only from OFFER (RD-9). REJECTED
 * requires a closed-vocabulary reason (RD-11). Terminal transitions close
 * the room atomically IN THE SAME TRANSACTION as the stage event (RD-8):
 * HIRED → CLOSED + closedOutcome "HIRED"; REJECTED → CLOSED +
 * closedOutcome "REJECTED" + closedReason. The optional `note` is
 * employer-private (≤500, zod-enforced at the route) and is never
 * serialized to the candidate (RD-11). Notifications AFTER commit
 * (RD-18 + clarification C): non-terminal → one HIRING_ROOM_STAGE to the
 * candidate; terminal HIRED/REJECTED → exactly ONE HIRING_ROOM_CLOSED to
 * the candidate and NO stage notification for terminal stages.
 */
export async function transitionStage(params: {
  roomId: string;
  actorUserId: string;
  actorRole: "EMPLOYER";
  stage: string;
  reason?: string;
  note?: string;
}): Promise<void> {
  const { room } = await requireRoomAccess(params.roomId, params.actorUserId, ["EMPLOYER_ROLES", "ASSIGNED_MANAGER"]);
  const now = new Date();
  const stage = params.stage;
  if (!(STAGE_INDEX.get(stage) !== undefined)) {
    throw new RoomRuleError("OX_STAGE_INVALID_TRANSITION", 409, "Unknown stage");
  }
  if (stage === "WITHDRAWN") {
    // Candidate-only terminal event (RD-7): employers never record WITHDRAWN.
    throw new RoomRuleError("OX_STAGE_INVALID_TRANSITION", 409, "WITHDRAWN is recorded by the candidate only");
  }
  const isTerminal = stage === "HIRED" || stage === "REJECTED";
  let rejectionReason: string | null = null;
  if (stage === "REJECTED") {
    if (!params.reason || !(HIRING_REJECT_REASONS as readonly string[]).includes(params.reason)) {
      throw new RoomRuleError("OX_ROOM_INVALID_REASON", 400, "A rejection reason from the approved vocabulary is required");
    }
    rejectionReason = params.reason;
  }
  await db.$transaction(async (tx) => {
    const fresh = await tx.hiringRoom.findFirst({
      where: { id: params.roomId },
      select: { status: true, currentStage: true },
    });
    if (!fresh || fresh.status !== "ACTIVE") {
      throw new RoomRuleError("OX_ROOM_NOT_ACTIONABLE", 409, "The room is not in an actionable state");
    }
    const currentIndex = STAGE_INDEX.get(fresh.currentStage) ?? -1;
    const nextIndex = STAGE_INDEX.get(stage)!;
    if (nextIndex <= currentIndex) {
      // Zero writes — the refusal happens before any statement runs (RD-10).
      throw new RoomRuleError("OX_STAGE_INVALID_TRANSITION", 409, "Stages only move forward");
    }
    if (stage === "HIRED" && fresh.currentStage !== "OFFER") {
      throw new RoomRuleError("OX_STAGE_INVALID_TRANSITION", 409, "HIRED is reachable only from OFFER");
    }
    if (!isTerminal) {
      const res = await tx.hiringRoom.updateMany({
        where: { id: params.roomId, status: "ACTIVE" },
        data: { currentStage: stage },
      });
      if (res.count !== 1) {
        throw new RoomRuleError("OX_ROOM_NOT_ACTIONABLE", 409, "The room changed state concurrently");
      }
      await tx.hiringStageEvent.create({
        data: {
          roomId: params.roomId,
          stage,
          fromStage: fresh.currentStage,
          actorRole: "EMPLOYER",
          actorUserId: params.actorUserId,
          reason: null,
          note: params.note ?? null,
        },
      });
      await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.roomStageAdvanced, OX_TARGET.hiringRoom, params.roomId, {
        organizationId: room.organizationId,
        opportunityId: room.opportunityId,
        stage,
        fromStage: fresh.currentStage,
      }, tx);
      return;
    }
    // Terminal transitions close the room atomically with the stage event.
    if (stage === "HIRED") {
      const res = await tx.hiringRoom.updateMany({
        where: { id: params.roomId, status: "ACTIVE", currentStage: "OFFER" },
        data: { currentStage: "HIRED", status: "CLOSED", closedOutcome: "HIRED", closedAt: now },
      });
      if (res.count !== 1) {
        throw new RoomRuleError("OX_ROOM_NOT_ACTIONABLE", 409, "The room changed state concurrently");
      }
      await tx.hiringStageEvent.create({
        data: {
          roomId: params.roomId,
          stage: "HIRED",
          fromStage: "OFFER",
          actorRole: "EMPLOYER",
          actorUserId: params.actorUserId,
          reason: null,
          note: params.note ?? null,
        },
      });
      await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.roomClosed, OX_TARGET.hiringRoom, params.roomId, {
        organizationId: room.organizationId,
        opportunityId: room.opportunityId,
        outcome: "HIRED",
        stage: "HIRED",
        fromStage: "OFFER",
      }, tx);
      return;
    }
    // REJECTED
    const res = await tx.hiringRoom.updateMany({
      where: { id: params.roomId, status: "ACTIVE" },
      data: {
        currentStage: "REJECTED",
        status: "CLOSED",
        closedOutcome: "REJECTED",
        closedReason: rejectionReason,
        closedAt: now,
      },
    });
    if (res.count !== 1) {
      throw new RoomRuleError("OX_ROOM_NOT_ACTIONABLE", 409, "The room changed state concurrently");
    }
    await tx.hiringStageEvent.create({
      data: {
        roomId: params.roomId,
        stage: "REJECTED",
        fromStage: fresh.currentStage,
        actorRole: "EMPLOYER",
        actorUserId: params.actorUserId,
        reason: rejectionReason,
        note: params.note ?? null,
      },
    });
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.roomClosed, OX_TARGET.hiringRoom, params.roomId, {
      organizationId: room.organizationId,
      opportunityId: room.opportunityId,
      outcome: "REJECTED",
      reason: rejectionReason,
      stage: "REJECTED",
      fromStage: fresh.currentStage,
    }, tx);
  });
  const ctx = await loadRoomPublicContext(params.roomId).catch(() => null);
  if (ctx && ctx.candidateUserId) {
    if (isTerminal) {
      // Clarification C: exactly ONE closure notification per terminal action;
      // NO stage-type notification for terminal stages.
      await notify({
        userId: ctx.candidateUserId,
        actorId: params.actorUserId,
        type: "HIRING_ROOM_CLOSED",
        payload: {
          roomId: params.roomId,
          opportunityId: ctx.opportunityId,
          opportunityTitle: ctx.opportunityTitle,
          outcome: stage,
        },
        dedupKey: `hiring:room:${params.roomId}:closed`,
      }).catch(() => false);
    } else {
      await notify({
        userId: ctx.candidateUserId,
        actorId: params.actorUserId,
        type: "HIRING_ROOM_STAGE",
        payload: {
          roomId: params.roomId,
          opportunityId: ctx.opportunityId,
          opportunityTitle: ctx.opportunityTitle,
          stage,
        },
        dedupKey: `hiring:room:${params.roomId}:stage:${stage}`,
      }).catch(() => false);
    }
  }
}

// ---------- Cancel (RD-2/RD-8/RD-11) ----------

/**
 * Outcome-less employer closure (RD-2/RD-8/RD-11): OWNER/ADMIN/RECRUITER
 * ONLY — the assigned HIRING_MANAGER is explicitly NOT authorized and is
 * 404-denied through the party helper (RD-2/RD-5). The room must be ACTIVE
 * or ON_HOLD; the reason is REQUIRED and drawn from the approved room
 * cancellation vocabulary. Guarded updateMany → CANCELLED + closedReason +
 * closedAt. AFTER commit: exactly ONE closure notification to the candidate.
 */
export async function cancelRoom(params: { roomId: string; actorUserId: string; reason: string }): Promise<void> {
  const { room } = await requireRoomAccess(params.roomId, params.actorUserId, ["EMPLOYER_ROLES"]);
  if (!(HIRING_ROOM_CANCEL_REASONS as readonly string[]).includes(params.reason)) {
    throw new RoomRuleError("OX_ROOM_INVALID_REASON", 400, "A room cancellation reason from the approved vocabulary is required");
  }
  const now = new Date();
  await db.$transaction(async (tx) => {
    const res = await tx.hiringRoom.updateMany({
      where: { id: params.roomId, status: { in: ["ACTIVE", "ON_HOLD"] } },
      data: { status: "CANCELLED", closedReason: params.reason, closedAt: now },
    });
    if (res.count !== 1) {
      throw new RoomRuleError("OX_ROOM_NOT_ACTIONABLE", 409, "The room has already concluded and can no longer be cancelled");
    }
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.roomCancelled, OX_TARGET.hiringRoom, params.roomId, {
      organizationId: room.organizationId,
      reason: params.reason,
      status: "CANCELLED",
    }, tx);
  });
  const ctx = await loadRoomPublicContext(params.roomId).catch(() => null);
  if (ctx && ctx.candidateUserId) {
    await notify({
      userId: ctx.candidateUserId,
      actorId: params.actorUserId,
      type: "HIRING_ROOM_CLOSED",
      payload: {
        roomId: params.roomId,
        opportunityId: ctx.opportunityId,
        opportunityTitle: ctx.opportunityTitle,
        outcome: "CANCELLED",
      },
      dedupKey: `hiring:room:${params.roomId}:closed`,
    }).catch(() => false);
  }
}

// ---------- Candidate withdrawal (RD-7) ----------

/**
 * The candidate withdraws from their own room (RD-7). ANY other actor —
 * including every employer role — is 404-denied. Allowed while ACTIVE or
 * ON_HOLD. ONE transaction: guarded room update → terminal
 * CANDIDATE_WITHDRAWN + closedAt; the WITHDRAWN stage event (actorRole
 * "CANDIDATE", required reason code); ALL PROPOSED/CONFIRMED interviews
 * auto-cancel via updateMany with `cancelReason` left NULL (CANDIDATE_WITHDREW
 * is deliberately NOT in the approved interview cancel vocabulary — the
 * cause is recorded on the audit meta `cause:"CANDIDATE_WITHDREW"`).
 * Audits: `ox.room.withdrawn` plus one `ox.interview.cancelled` per
 * cancelled interview. Zero deletion: interviews keep their rows, history
 * is intact. AFTER commit: HIRING_ROOM_WITHDRAWN to the ACTIVE org
 * OWNER/ADMIN/RECRUITER set plus the ACTIVE assigned HIRING_MANAGER (RD-18
 * employer recipients) — and NO closure notification to the candidate (they
 * performed the action).
 */
export async function withdrawFromRoom(params: { roomId: string; actorUserId: string; reason: string }): Promise<void> {
  const resolved = await resolveRoomParty(params.roomId, params.actorUserId);
  if (resolved.access !== "CANDIDATE" || !resolved.room) {
    throw new RoomRuleError("OX_HIRING_ROOM_NOT_FOUND", 404, "Hiring room not found");
  }
  if (!(HIRING_WITHDRAW_REASONS as readonly string[]).includes(params.reason)) {
    throw new RoomRuleError("OX_ROOM_INVALID_REASON", 400, "A withdrawal reason from the approved vocabulary is required");
  }
  const now = new Date();
  await db.$transaction(async (tx) => {
    const fresh = await tx.hiringRoom.findFirst({
      where: { id: params.roomId },
      select: { status: true, currentStage: true, candidateUserId: true, organizationId: true },
    });
    if (!fresh || fresh.candidateUserId !== params.actorUserId) {
      throw new RoomRuleError("OX_HIRING_ROOM_NOT_FOUND", 404, "Hiring room not found");
    }
    if (fresh.status !== "ACTIVE" && fresh.status !== "ON_HOLD") {
      throw new RoomRuleError("OX_ROOM_NOT_ACTIONABLE", 409, "The room has already concluded");
    }
    const res = await tx.hiringRoom.updateMany({
      where: { id: params.roomId, status: { in: ["ACTIVE", "ON_HOLD"] } },
      data: { status: "CANDIDATE_WITHDRAWN", closedAt: now },
    });
    if (res.count !== 1) {
      throw new RoomRuleError("OX_ROOM_NOT_ACTIONABLE", 409, "The room has already concluded");
    }
    await tx.hiringStageEvent.create({
      data: {
        roomId: params.roomId,
        stage: "WITHDRAWN",
        fromStage: fresh.currentStage,
        actorRole: "CANDIDATE",
        actorUserId: params.actorUserId,
        reason: params.reason,
        note: null,
      },
    });
    // Auto-cancel live interviews WITHOUT touching cancelReason (RD-7):
    // CANDIDATE_WITHDREW is not part of the approved interview vocabulary —
    // the cause travels on the audit meta instead.
    const liveInterviews = await tx.interview.findMany({
      where: { roomId: params.roomId, status: { in: ["PROPOSED", "CONFIRMED"] } },
      select: { id: true, type: true },
    });
    if (liveInterviews.length > 0) {
      await tx.interview.updateMany({
        where: { roomId: params.roomId, status: { in: ["PROPOSED", "CONFIRMED"] } },
        data: { status: "CANCELLED", cancelledByUserId: params.actorUserId },
      });
    }
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.roomWithdrawn, OX_TARGET.hiringRoom, params.roomId, {
      organizationId: fresh.organizationId,
      reason: params.reason,
      status: "CANDIDATE_WITHDRAWN",
    }, tx);
    for (const interview of liveInterviews) {
      await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.interviewCancelled, OX_TARGET.interview, interview.id, {
        roomId: params.roomId,
        type: interview.type,
        cause: "CANDIDATE_WITHDREW",
      }, tx);
    }
  });
  const ctx = await loadRoomPublicContext(params.roomId).catch(() => null);
  if (ctx) {
    await notifyRoomEmployerTeam({
      organizationId: ctx.organizationId,
      roomId: params.roomId,
      actorUserId: params.actorUserId,
      type: "HIRING_ROOM_WITHDRAWN",
      payload: {
        roomId: params.roomId,
        opportunityId: ctx.opportunityId,
        opportunityTitle: ctx.opportunityTitle,
      },
      dedupKey: `hiring:room:${params.roomId}:withdrawn`,
    });
  }
}

// ---------- Room-scoped membership (RD-4/RD-5) ----------

/**
 * Assign the room HIRING_MANAGER (RD-4). Actor: OWNER/ADMIN/RECRUITER (the
 * assigned HIRING_MANAGER may NOT manage members — 404-deny). Target: an
 * ACTIVE member of the SAME org whose role is assignable (OWNER/ADMIN/
 * RECRUITER/HIRING_MANAGER); org VIEWERs are not assignable and non-ACTIVE
 * members refuse with 409 OX_MEMBER_NOT_ACTIVE (the message distinguishes
 * VIEWERs). Member management deliberately proceeds while the room is
 * ON_HOLD: pause pauses hiring WORK, not access administration (RD-2
 * governs workflow writes; membership rows are access control, and
 * blocking them mid-hold would leave a room with no manager to resume it).
 * At most ONE active HIRING_MANAGER per room (RD-5): assigning over an
 * existing active manager soft-removes them first (removedAt stamped +
 * audited) — the previous manager is notified of the removal. A previously
 * removed (roomId, userId) row is REACTIVATED through a guarded
 * updateMany (removedAt → null), keeping the pair unique forever.
 * Notifications AFTER commit.
 */
export async function assignRoomManager(params: {
  roomId: string;
  actorUserId: string;
  targetUserId: string;
}): Promise<{ memberId: string; replacedMemberId: string | null }> {
  const { room } = await requireRoomAccess(params.roomId, params.actorUserId, ["EMPLOYER_ROLES"]);
  const now = new Date();
  const assignableRoles = ["OWNER", "ADMIN", "RECRUITER", "HIRING_MANAGER"];
  const result = await db.$transaction(async (tx): Promise<{ memberId: string; replacedMemberId: string | null }> => {
    const target = await tx.employerMembership.findUnique({
      where: { organizationId_userId: { organizationId: room.organizationId, userId: params.targetUserId } },
      select: { status: true, role: true },
    });
    if (!target || target.status !== "ACTIVE") {
      throw new RoomRuleError("OX_MEMBER_NOT_ACTIVE", 409, "The target member is not an ACTIVE member of this organization");
    }
    if (target.role === "VIEWER") {
      throw new RoomRuleError("OX_MEMBER_NOT_ACTIVE", 409, "Organization VIEWERs cannot be assigned as room hiring managers");
    }
    if (!assignableRoles.includes(target.role)) {
      throw new RoomRuleError("OX_MEMBER_NOT_ACTIVE", 409, "The target member's role is not assignable to a hiring room");
    }
    // Replacing keeps "the assigned HIRING_MANAGER" singular (RD-5).
    let replacedMemberId: string | null = null;
    const previous = await tx.hiringRoomMember.findFirst({
      where: { roomId: params.roomId, roomRole: "HIRING_MANAGER", removedAt: null, userId: { not: params.targetUserId } },
      select: { id: true, userId: true },
    });
    if (previous) {
      const removed = await tx.hiringRoomMember.updateMany({
        where: { id: previous.id, roomId: params.roomId, removedAt: null },
        data: { removedAt: now },
      });
      if (removed.count === 1) {
        replacedMemberId = previous.id;
        // Membership audits target the ROOM row (targetType HIRING_ROOM,
        // targetId roomId, vocabulary-only meta) — this is what makes the
        // server-derived activity timeline reconstructable per RD-16/§3 of
        // the timeline contract (membership + status actions).
        await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.roomMemberRemoved, OX_TARGET.hiringRoom, params.roomId, {
          roomId: params.roomId,
          roomRole: "HIRING_MANAGER",
          userId: previous.userId,
        }, tx);
      }
      // count 0 = the row was soft-removed concurrently; nothing to replace.
    }
    const existing = await tx.hiringRoomMember.findFirst({
      where: { roomId: params.roomId, userId: params.targetUserId, roomRole: "HIRING_MANAGER" },
      select: { id: true, removedAt: true },
    });
    let memberId: string;
    if (existing) {
      // Reactivate the same row (append-only: the pair stays unique forever).
      const res = await tx.hiringRoomMember.updateMany({
        where: { id: existing.id, roomId: params.roomId, userId: params.targetUserId, roomRole: "HIRING_MANAGER" },
        data: { removedAt: null, assignedByUserId: params.actorUserId },
      });
      if (res.count !== 1) {
        throw new RoomRuleError("OX_ROOM_NOT_ACTIONABLE", 409, "The membership row changed concurrently; retry");
      }
      memberId = existing.id;
    } else {
      const created = await tx.hiringRoomMember
        .create({
          data: {
            roomId: params.roomId,
            userId: params.targetUserId,
            roomRole: "HIRING_MANAGER",
            assignedByUserId: params.actorUserId,
          },
        })
        .catch((e: { code?: string }) => {
          if (e?.code === "P2002") {
            // Concurrent assignment of the same target: deterministic loser.
            throw new RoomRuleError("OX_ROOM_NOT_ACTIONABLE", 409, "The membership row changed concurrently; retry");
          }
          throw e;
        });
      memberId = created.id;
    }
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.roomMemberAssigned, OX_TARGET.hiringRoom, params.roomId, {
      roomId: params.roomId,
      roomRole: "HIRING_MANAGER",
      userId: params.targetUserId,
      memberId,
    }, tx);
    return { memberId, replacedMemberId };
  });
  await notify({
    userId: params.targetUserId,
    actorId: params.actorUserId,
    type: "HIRING_ROOM_MEMBER",
    payload: { roomId: params.roomId, roomRole: "HIRING_MANAGER" },
    dedupKey: `hiring:room:${params.roomId}:member:${result.memberId}:assigned`,
  }).catch(() => false);
  if (result.replacedMemberId) {
    const replaced = await db.hiringRoomMember.findUnique({
      where: { id: result.replacedMemberId },
      select: { userId: true },
    });
    if (replaced?.userId) {
      await notify({
        userId: replaced.userId,
        actorId: params.actorUserId,
        type: "HIRING_ROOM_MEMBER",
        payload: { roomId: params.roomId, roomRole: "HIRING_MANAGER" },
        dedupKey: `hiring:room:${params.roomId}:member:${result.replacedMemberId}:removed`,
      }).catch(() => false);
    }
  }
  return result;
}

/**
 * Soft-remove a room member (RD-4). Actor: OWNER/ADMIN/RECRUITER. A missing
 * or already-removed member is a NOT-FOUND situation (404-deny in the M-O6
 * OX_NEGOTIATION_NOT_FOUND image) — rows are never deleted, `removedAt` is
 * stamped instead. AFTER commit the affected member is notified.
 */
export async function removeRoomMember(params: { roomId: string; actorUserId: string; memberId: string }): Promise<void> {
  await requireRoomAccess(params.roomId, params.actorUserId, ["EMPLOYER_ROLES"]);
  const now = new Date();
  const affected = await db.$transaction(async (tx) => {
    const row = await tx.hiringRoomMember.findFirst({
      where: { id: params.memberId, roomId: params.roomId },
      select: { id: true, userId: true, roomRole: true, removedAt: true },
    });
    if (!row || row.removedAt !== null) {
      throw new RoomRuleError("OX_ROOM_MEMBER_NOT_FOUND", 404, "Room member not found");
    }
    const res = await tx.hiringRoomMember.updateMany({
      where: { id: params.memberId, roomId: params.roomId, removedAt: null },
      data: { removedAt: now },
    });
    if (res.count !== 1) {
      throw new RoomRuleError("OX_ROOM_MEMBER_NOT_FOUND", 404, "Room member not found");
    }
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.roomMemberRemoved, OX_TARGET.hiringRoom, params.roomId, {
      roomId: params.roomId,
      roomRole: row.roomRole,
      userId: row.userId,
      memberId: params.memberId,
    }, tx);
    return row;
  });
  if (affected.userId) {
    await notify({
      userId: affected.userId,
      actorId: params.actorUserId,
      type: "HIRING_ROOM_MEMBER",
      payload: { roomId: params.roomId, roomRole: affected.roomRole },
      dedupKey: `hiring:room:${params.roomId}:member:${params.memberId}:removed`,
    }).catch(() => false);
  }
}

// ---------- Interviews (RD-12/RD-13/RD-15) ----------

/**
 * Interview time-window validation (RD-13): endsAt strictly after startsAt,
 * duration 15 min–4 h inclusive. The strictly-future check lives in
 * `assertInterviewStartsInFuture` because recording a COMPLETED interview is
 * the one operation allowed to touch past times — it never calls either
 * helper on new times. Violations: 400 OX_INTERVIEW_INVALID_WINDOW.
 */
export function validateInterviewWindow(startsAt: Date, endsAt: Date): void {
  const invalid = (message: string) => new RoomRuleError("OX_INTERVIEW_INVALID_WINDOW", 400, message);
  if (!(startsAt instanceof Date) || !(endsAt instanceof Date) || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw invalid("Interview times must be valid dates");
  }
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw invalid("The interview window must end after it starts");
  }
  const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  if (minutes < OX_INTERVIEW_MIN_MINUTES || minutes > OX_INTERVIEW_MAX_MINUTES) {
    throw invalid(`Interview duration must be between ${OX_INTERVIEW_MIN_MINUTES} and ${OX_INTERVIEW_MAX_MINUTES} minutes`);
  }
}

/** RD-13: `startsAt` strictly in the future for propose/alternate/reschedule. */
export function assertInterviewStartsInFuture(startsAt: Date): void {
  if (!(startsAt instanceof Date) || Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= Date.now()) {
    throw new RoomRuleError("OX_INTERVIEW_INVALID_WINDOW", 400, "The interview must start in the future");
  }
}

type InterviewSide = (typeof HIRING_PARTIES)[number];

/** Employer side = OWNER/ADMIN/RECRUITER + ACTIVE assigned HIRING_MANAGER;
 * candidate side = the room's own candidate; everyone else → 404-deny. */
function sideForAccess(access: Exclude<RoomPartyAccess, null>): InterviewSide {
  return access === "CANDIDATE" ? "CANDIDATE" : "EMPLOYER";
}

/**
 * Employer-side interview proposal (RD-12): EMPLOYER side only (OWNER/
 * ADMIN/RECRUITER/assigned HIRING_MANAGER) — the candidate proposing is a
 * 404-deny. Window + strictly-future validation (RD-13). Creates the
 * PROPOSED row with proposedByRole "EMPLOYER"; the confirmation right
 * belongs to the OTHER side. Audit + both-party notifications AFTER commit
 * (payload: identifiers, type and the ISO UTC start — no links, RD-18).
 *
 * `meetingLink` (RD-15): stored exactly as supplied (zod-enforced https/≤500
 * at the route boundary), persisted on the `Interview.meetingLink` column,
 * never rewritten and never liveness-tested here; the serializer layer
 * (room-dto.ts) enforces the recipient allowlist (room candidate + employer
 * roles with room mutation rights) and omits the link for CANCELLED/COMPLETED
 * interviews for every audience.
 */
export async function proposeInterview(params: {
  roomId: string;
  actorUserId: string;
  type: string;
  startsAt: Date;
  endsAt: Date;
  meetingLink?: string;
}): Promise<{ interviewId: string }> {
  const { room } = await requireRoomAccess(params.roomId, params.actorUserId, ["EMPLOYER_ROLES", "ASSIGNED_MANAGER"]);
  validateInterviewWindow(params.startsAt, params.endsAt);
  assertInterviewStartsInFuture(params.startsAt);
  const interviewId = await db.$transaction(async (tx) => {
    await assertRoomActiveInTx(tx, params.roomId);
    const created = await tx.interview.create({
      data: {
        roomId: params.roomId,
        type: params.type,
        status: "PROPOSED",
        startsAt: params.startsAt,
        endsAt: params.endsAt,
        proposedByRole: "EMPLOYER",
        proposedByUserId: params.actorUserId,
        schedulingUserId: params.actorUserId,
        meetingLink: params.meetingLink ?? null,
      },
    });
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.interviewProposed, OX_TARGET.interview, created.id, {
      roomId: params.roomId,
      type: params.type,
      status: "PROPOSED",
      proposedByRole: "EMPLOYER",
    }, tx);
    return created.id;
  });
  await notifyInterviewParties({
    room: { id: room.id, organizationId: room.organizationId, candidateUserId: room.candidateUserId },
    interviewId,
    event: "proposed",
    actorUserId: params.actorUserId,
    payload: {
      roomId: params.roomId,
      interviewId,
      type: params.type,
      startsAt: params.startsAt.toISOString(), // ISO UTC strings — no links (RD-18)
    },
  });
  return { interviewId };
}

/**
 * Confirmation (RD-12): ONLY the party OPPOSITE `proposedByRole` may
 * confirm — confirming your own proposal is a 409 (the confirmation right
 * belongs to the other side). Guarded PROPOSED → CONFIRMED; a racing or
 * stale confirmation matches zero rows → 409 OX_INTERVIEW_NOT_ACTIONABLE.
 */
export async function confirmInterview(params: {
  roomId: string;
  interviewId: string;
  actorUserId: string;
}): Promise<void> {
  const { room, access } = await requireRoomAccess(params.roomId, params.actorUserId, ["EMPLOYER_ROLES", "ASSIGNED_MANAGER", "CANDIDATE"]);
  const side = sideForAccess(access);
  await db.$transaction(async (tx) => {
    await assertRoomActiveInTx(tx, params.roomId);
    const interview = await tx.interview.findFirst({
      where: { id: params.interviewId, roomId: params.roomId },
      select: { id: true, status: true, proposedByRole: true, type: true },
    });
    if (!interview) {
      throw new RoomRuleError("OX_INTERVIEW_NOT_FOUND", 404, "Interview not found");
    }
    if (interview.proposedByRole === side) {
      throw new RoomRuleError("OX_INTERVIEW_NOT_ACTIONABLE", 409, "The confirmation right belongs to the other party");
    }
    const res = await tx.interview.updateMany({
      where: { id: params.interviewId, roomId: params.roomId, status: "PROPOSED" },
      data: { status: "CONFIRMED" },
    });
    if (res.count !== 1) {
      throw new RoomRuleError("OX_INTERVIEW_NOT_ACTIONABLE", 409, "The interview is no longer in PROPOSED state");
    }
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.interviewConfirmed, OX_TARGET.interview, params.interviewId, {
      roomId: params.roomId,
      type: interview.type,
      status: "CONFIRMED",
      proposedByRole: interview.proposedByRole,
      confirmedByRole: side,
    }, tx);
  });
  await notifyInterviewParties({
    room: { id: room.id, organizationId: room.organizationId, candidateUserId: room.candidateUserId },
    interviewId: params.interviewId,
    event: "confirmed",
    actorUserId: params.actorUserId,
    payload: {
      roomId: params.roomId,
      interviewId: params.interviewId,
      status: "CONFIRMED",
    },
  });
}

/**
 * Alternate slot (RD-12): PROPOSED only; ONLY the non-proposer may counter.
 * The countering party's times replace the standing ones AND
 * `proposedByRole` flips to the countering party while the row STAYS
 * PROPOSED — the original proposer now holds the confirmation right.
 * Window + strictly-future validation (RD-13). Guarded write; race loser
 * → 409.
 */
export async function alternateInterview(params: {
  roomId: string;
  interviewId: string;
  actorUserId: string;
  startsAt: Date;
  endsAt: Date;
}): Promise<void> {
  const { room, access } = await requireRoomAccess(params.roomId, params.actorUserId, ["EMPLOYER_ROLES", "ASSIGNED_MANAGER", "CANDIDATE"]);
  const side = sideForAccess(access);
  validateInterviewWindow(params.startsAt, params.endsAt);
  assertInterviewStartsInFuture(params.startsAt);
  await db.$transaction(async (tx) => {
    await assertRoomActiveInTx(tx, params.roomId);
    const interview = await tx.interview.findFirst({
      where: { id: params.interviewId, roomId: params.roomId },
      select: { id: true, status: true, proposedByRole: true, type: true },
    });
    if (!interview) {
      throw new RoomRuleError("OX_INTERVIEW_NOT_FOUND", 404, "Interview not found");
    }
    if (interview.status !== "PROPOSED") {
      throw new RoomRuleError("OX_INTERVIEW_NOT_ACTIONABLE", 409, "Only a PROPOSED interview can be countered with an alternate slot");
    }
    if (interview.proposedByRole === side) {
      throw new RoomRuleError("OX_INTERVIEW_NOT_ACTIONABLE", 409, "Only the non-proposing party may counter with an alternate slot");
    }
    const res = await tx.interview.updateMany({
      where: { id: params.interviewId, roomId: params.roomId, status: "PROPOSED" },
      data: {
        startsAt: params.startsAt,
        endsAt: params.endsAt,
        proposedByRole: side,
        proposedByUserId: params.actorUserId,
        schedulingUserId: params.actorUserId,
      },
    });
    if (res.count !== 1) {
      throw new RoomRuleError("OX_INTERVIEW_NOT_ACTIONABLE", 409, "The interview changed state concurrently");
    }
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.interviewAlternate, OX_TARGET.interview, params.interviewId, {
      roomId: params.roomId,
      type: interview.type,
      status: "PROPOSED",
      proposedByRole: side,
    }, tx);
  });
  await notifyInterviewParties({
    room: { id: room.id, organizationId: room.organizationId, candidateUserId: room.candidateUserId },
    interviewId: params.interviewId,
    event: "alternate",
    actorUserId: params.actorUserId,
    payload: {
      roomId: params.roomId,
      interviewId: params.interviewId,
      startsAt: params.startsAt.toISOString(),
    },
  });
}

/**
 * Reschedule (RD-12): CONFIRMED only; either party; window + strictly-
 * future validation. The interview returns to PROPOSED under the
 * RESCHEDULING party's role — the other side now holds the confirmation
 * right. Guarded write; race loser → 409.
 */
export async function rescheduleInterview(params: {
  roomId: string;
  interviewId: string;
  actorUserId: string;
  startsAt: Date;
  endsAt: Date;
}): Promise<void> {
  const { room, access } = await requireRoomAccess(params.roomId, params.actorUserId, ["EMPLOYER_ROLES", "ASSIGNED_MANAGER", "CANDIDATE"]);
  const side = sideForAccess(access);
  validateInterviewWindow(params.startsAt, params.endsAt);
  assertInterviewStartsInFuture(params.startsAt);
  await db.$transaction(async (tx) => {
    await assertRoomActiveInTx(tx, params.roomId);
    const interview = await tx.interview.findFirst({
      where: { id: params.interviewId, roomId: params.roomId },
      select: { id: true, status: true, type: true },
    });
    if (!interview) {
      throw new RoomRuleError("OX_INTERVIEW_NOT_FOUND", 404, "Interview not found");
    }
    if (interview.status !== "CONFIRMED") {
      throw new RoomRuleError("OX_INTERVIEW_NOT_ACTIONABLE", 409, "Only a CONFIRMED interview can be rescheduled");
    }
    const res = await tx.interview.updateMany({
      where: { id: params.interviewId, roomId: params.roomId, status: "CONFIRMED" },
      data: {
        status: "PROPOSED",
        startsAt: params.startsAt,
        endsAt: params.endsAt,
        proposedByRole: side,
        proposedByUserId: params.actorUserId,
        schedulingUserId: params.actorUserId,
      },
    });
    if (res.count !== 1) {
      throw new RoomRuleError("OX_INTERVIEW_NOT_ACTIONABLE", 409, "The interview changed state concurrently");
    }
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.interviewRescheduled, OX_TARGET.interview, params.interviewId, {
      roomId: params.roomId,
      type: interview.type,
      status: "PROPOSED",
      proposedByRole: side,
    }, tx);
  });
  await notifyInterviewParties({
    room: { id: room.id, organizationId: room.organizationId, candidateUserId: room.candidateUserId },
    interviewId: params.interviewId,
    event: "rescheduled",
    actorUserId: params.actorUserId,
    payload: {
      roomId: params.roomId,
      interviewId: params.interviewId,
      startsAt: params.startsAt.toISOString(),
    },
  });
}

/**
 * Cancel (RD-12/RD-11): PROPOSED or CONFIRMED; either party; reason
 * REQUIRED from the approved interview vocabulary. Guarded write stamps
 * cancelledByUserId + cancelReason; race/stale → 409. The payload carries
 * the reason CODE only (RD-18).
 */
export async function cancelInterview(params: {
  roomId: string;
  interviewId: string;
  actorUserId: string;
  reason: string;
}): Promise<void> {
  const { room, access } = await requireRoomAccess(params.roomId, params.actorUserId, ["EMPLOYER_ROLES", "ASSIGNED_MANAGER", "CANDIDATE"]);
  const side = sideForAccess(access);
  if (!(HIRING_INTERVIEW_CANCEL_REASONS as readonly string[]).includes(params.reason)) {
    throw new RoomRuleError("OX_ROOM_INVALID_REASON", 400, "An interview cancellation reason from the approved vocabulary is required");
  }
  await db.$transaction(async (tx) => {
    await assertRoomActiveInTx(tx, params.roomId);
    const interview = await tx.interview.findFirst({
      where: { id: params.interviewId, roomId: params.roomId },
      select: { id: true, status: true, type: true },
    });
    if (!interview) {
      throw new RoomRuleError("OX_INTERVIEW_NOT_FOUND", 404, "Interview not found");
    }
    if (interview.status !== "PROPOSED" && interview.status !== "CONFIRMED") {
      throw new RoomRuleError("OX_INTERVIEW_NOT_ACTIONABLE", 409, "Only a PROPOSED or CONFIRMED interview can be cancelled");
    }
    const res = await tx.interview.updateMany({
      where: { id: params.interviewId, roomId: params.roomId, status: { in: ["PROPOSED", "CONFIRMED"] } },
      data: { status: "CANCELLED", cancelledByUserId: params.actorUserId, cancelReason: params.reason },
    });
    if (res.count !== 1) {
      throw new RoomRuleError("OX_INTERVIEW_NOT_ACTIONABLE", 409, "The interview changed state concurrently");
    }
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.interviewCancelled, OX_TARGET.interview, params.interviewId, {
      roomId: params.roomId,
      type: interview.type,
      status: "CANCELLED",
      cancelReason: params.reason,
      cancelledByRole: side,
    }, tx);
  });
  await notifyInterviewParties({
    room: { id: room.id, organizationId: room.organizationId, candidateUserId: room.candidateUserId },
    interviewId: params.interviewId,
    event: "cancelled",
    actorUserId: params.actorUserId,
    payload: {
      roomId: params.roomId,
      interviewId: params.interviewId,
      status: "CANCELLED",
      cancelReason: params.reason, // reason CODE only (RD-18)
    },
  });
}

/**
 * Complete (RD-12): EMPLOYER side only (candidate → 404-deny);
 * CONFIRMED → COMPLETED via guarded write with `completedAt` — the ONLY
 * operation allowed to record a past-time event, and it NEVER edits
 * startsAt/endsAt. Race/stale → 409.
 */
export async function completeInterview(params: {
  roomId: string;
  interviewId: string;
  actorUserId: string;
}): Promise<void> {
  const { room } = await requireRoomAccess(params.roomId, params.actorUserId, ["EMPLOYER_ROLES", "ASSIGNED_MANAGER"]);
  const now = new Date();
  await db.$transaction(async (tx) => {
    await assertRoomActiveInTx(tx, params.roomId);
    const interview = await tx.interview.findFirst({
      where: { id: params.interviewId, roomId: params.roomId },
      select: { id: true, status: true, type: true },
    });
    if (!interview) {
      throw new RoomRuleError("OX_INTERVIEW_NOT_FOUND", 404, "Interview not found");
    }
    if (interview.status !== "CONFIRMED") {
      throw new RoomRuleError("OX_INTERVIEW_NOT_ACTIONABLE", 409, "Only a CONFIRMED interview can be completed");
    }
    const res = await tx.interview.updateMany({
      where: { id: params.interviewId, roomId: params.roomId, status: "CONFIRMED" },
      data: { status: "COMPLETED", completedAt: now },
    });
    if (res.count !== 1) {
      throw new RoomRuleError("OX_INTERVIEW_NOT_ACTIONABLE", 409, "The interview changed state concurrently");
    }
    await auditOX(params.actorUserId, OX_AUDIT_ACTIONS.interviewCompleted, OX_TARGET.interview, params.interviewId, {
      roomId: params.roomId,
      type: interview.type,
      status: "COMPLETED",
    }, tx);
  });
  await notifyInterviewParties({
    room: { id: room.id, organizationId: room.organizationId, candidateUserId: room.candidateUserId },
    interviewId: params.interviewId,
    event: "completed",
    actorUserId: params.actorUserId,
    payload: {
      roomId: params.roomId,
      interviewId: params.interviewId,
      status: "COMPLETED",
    },
  });
}

// ---------- Activity timeline (RD-16 + clarification B) ----------

/** Room-status + membership audit actions surfaced on the timeline (RD-16).
 * Stage events cover created/stage_advanced/closed; the timeline adds the
 * paused/resumed/cancelled/withdrawn status actions and membership changes. */
const TIMELINE_ROOM_ACTIONS = [
  "ox.room.paused",
  "ox.room.resumed",
  "ox.room.cancelled",
  "ox.room.member_assigned",
  "ox.room.member_removed",
  "ox.room.withdrawn",
] as const;

const TIMELINE_ROOM_LABELS: Readonly<Record<string, string>> = {
  "ox.room.paused": "room:paused",
  "ox.room.resumed": "room:resumed",
  "ox.room.cancelled": "room:cancelled",
  "ox.room.member_assigned": "member:assigned",
  "ox.room.member_removed": "member:removed",
  "ox.room.withdrawn": "room:withdrawn",
};

/** Allowlisted detail keys — vocabulary and ids ONLY. Note content, meeting
 * links and money can never reach the timeline through this filter. */
const TIMELINE_DETAIL_KEYS = [
  "roomId",
  "roomRole",
  "memberId",
  "type",
  "status",
  "cause",
  "cancelReason",
  "proposedByRole",
  "confirmedByRole",
  "cancelledByRole",
  "fromStage",
  "reason",
] as const;

function parseTimelineMeta(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function timelineDetail(meta: Record<string, unknown> | null, extra: Record<string, unknown> = {}): string | undefined {
  // Vocabulary-only STRING (the documented timeline contract: labels + ids,
  // never note text, links or money — RD-16/RD-18). Values are stringified
  // vocabulary codes; raw objects never reach serializer output.
  const parts: string[] = [];
  const extras = Object.entries(extra).filter(([, v]) => v !== undefined && v !== null);
  for (const [k, v] of extras) parts.push(`${k}:${String(v)}`);
  if (meta) {
    for (const key of TIMELINE_DETAIL_KEYS) {
      if (meta[key] !== undefined && meta[key] !== null) parts.push(`${key}:${String(meta[key])}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export type RoomActivityEvent = {
  at: string;
  kind: "STAGE" | "INTERVIEW_EVENT" | "ROOM_EVENT";
  label: string;
  actorUserId: string | null;
  actorRole?: string;
  detail?: string;
};

/**
 * The server-derived room activity timeline (RD-16 + clarification B). NO
 * new models, no new transport: (1) HiringStageEvent rows (STAGE); (2)
 * interview state history rebuilt from the APPEND-ONLY AuditEvent rows —
 * NEVER from the mutable Interview row (clarification B) — as
 * INTERVIEW_EVENT entries; (3) room-status + membership audit rows as
 * ROOM_EVENT entries. Merged and sorted by createdAt ascending. Labels are
 * vocabulary-derived; detail carries ONLY vocabulary/ids — never note
 * content, never links, never money. The propose/alternate/confirm/
 * reschedule/cancel/complete sequence is reconstructable from the audit
 * rows alone.
 */
export async function getRoomActivityTimeline(params: { roomId: string }): Promise<{ events: RoomActivityEvent[] }> {
  const room = await db.hiringRoom.findFirst({ where: { id: params.roomId }, select: { id: true } });
  if (!room) {
    throw new RoomRuleError("OX_HIRING_ROOM_NOT_FOUND", 404, "Hiring room not found");
  }
  const [stages, interviewIds, roomAudits] = await Promise.all([
    db.hiringStageEvent.findMany({ where: { roomId: params.roomId }, orderBy: { createdAt: "asc" } }),
    db.interview.findMany({ where: { roomId: params.roomId }, select: { id: true } }),
    db.auditEvent.findMany({
      where: { targetType: OX_TARGET.hiringRoom, targetId: params.roomId, action: { in: [...TIMELINE_ROOM_ACTIONS] } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const interviewAudits =
    interviewIds.length > 0
      ? await db.auditEvent.findMany({
          where: { targetType: OX_TARGET.interview, targetId: { in: interviewIds.map((i) => i.id) } },
          orderBy: { createdAt: "asc" },
        })
      : [];
  const events: RoomActivityEvent[] = [];
  for (const stage of stages) {
    events.push({
      at: stage.createdAt.toISOString(),
      kind: "STAGE",
      label: `stage:${stage.stage}`,
      actorUserId: stage.actorUserId, // null-safe (RD-20 SetNull)
      actorRole: stage.actorRole,
      detail: timelineDetail(null, { fromStage: stage.fromStage, reason: stage.reason }),
    });
  }
  const INTERVIEW_ACTION_PREFIX = "ox.interview.";
  for (const audit of interviewAudits) {
    const meta = parseTimelineMeta(audit.meta);
    events.push({
      at: audit.createdAt.toISOString(),
      kind: "INTERVIEW_EVENT",
      label: `interview:${audit.action.startsWith(INTERVIEW_ACTION_PREFIX) ? audit.action.slice(INTERVIEW_ACTION_PREFIX.length) : audit.action}`,
      actorUserId: audit.actorUserId, // null-safe (RD-20 SetNull)
      detail: timelineDetail(meta, { interviewId: audit.targetId }),
    });
  }
  for (const audit of roomAudits) {
    const meta = parseTimelineMeta(audit.meta);
    events.push({
      at: audit.createdAt.toISOString(),
      kind: "ROOM_EVENT",
      label: TIMELINE_ROOM_LABELS[audit.action] ?? audit.action,
      actorUserId: audit.actorUserId, // null-safe (RD-20 SetNull)
      detail: timelineDetail(meta),
    });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  return { events };
}
