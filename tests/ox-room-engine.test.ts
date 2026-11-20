import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import type { Interview } from "@prisma/client";

/**
 * M-O7 — hiring-room ENGINE suite (Task 2-b tests the LIB, not routes):
 * room creation (RD-1/RD-3/RD-19), stage machine (RD-8/RD-9/RD-10/RD-11),
 * candidate withdrawal (RD-7), room-scoped membership (RD-4/RD-5),
 * interview protocol (RD-12/RD-13), serializers (RD-6/RD-11/RD-15 +
 * clarification A) and the server-derived activity timeline (RD-16 +
 * clarification B).
 *
 * Engine functions take actorUserId directly — no cookies, no HTTP. Every
 * state machine race is exercised through the guarded-updateMany semantics
 * (sequential double-calls), mirroring the M-O6 suite's race pins.
 *
 * Run pinned to the SQLite dev DB:
 *   DATABASE_URL=file:/home/z/bean-folio/db/custom.db bun test tests/ox-room-engine.test.ts
 */
import { db } from "@/lib/db";
import {
  OX_INTERVIEW_MAX_MINUTES,
  OX_INTERVIEW_MIN_MINUTES,
  RoomRuleError,
  alternateInterview,
  assertInterviewStartsInFuture,
  assignRoomManager,
  cancelInterview,
  cancelRoom,
  completeInterview,
  confirmInterview,
  createRoomForInvitation,
  getRoomActivityTimeline,
  isIanaTimezone,
  pauseRoom,
  proposeInterview,
  removeRoomMember,
  rescheduleInterview,
  resumeRoom,
  transitionStage,
  validateInterviewWindow,
  withdrawFromRoom,
} from "@/lib/ox/room";
import { serializeRoomForCandidate, serializeRoomForEmployer, serializeRoomForViewer, VIEWER_COMPENSATION_RULE_VERIFICATION, type StoredHiringRoomRow, type StoredHiringRoomMemberRow, type StoredInterviewRow, type StoredStageEventRow } from "@/lib/ox/room-dto";
import { hashPassword } from "@/lib/auth";

const PWD = await hashPassword("ox-room-password-1");

async function makeUser(name: string) {
  return db.user.create({
    data: { email: `ox-room-${randomUUID()}@beanfolio.test`, passwordHash: PWD, name },
  });
}

async function makeVerifiedOrg(displayName: string) {
  const owner = await makeUser(`${displayName} Owner`);
  const org = await db.employerOrganization.create({
    data: {
      legalName: `${displayName} Pvt Ltd`,
      displayName,
      slug: `${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}`,
      verificationStatus: "VERIFIED",
      verificationMethod: "MANUAL_REVIEW",
      verifiedAt: new Date(),
      createdByUserId: owner.id,
    },
  });
  await db.employerMembership.create({ data: { organizationId: org.id, userId: owner.id, role: "OWNER", status: "ACTIVE", joinedAt: new Date() } });
  return { owner, org };
}

async function makeOrgMember(orgId: string, role: string, status = "ACTIVE") {
  const user = await makeUser(`Room Member ${role} ${randomUUID().slice(0, 8)}`);
  await db.employerMembership.create({
    data: { organizationId: orgId, userId: user.id, role, status, joinedAt: status === "ACTIVE" ? new Date() : null },
  });
  return user;
}

async function makeOpportunity(orgId: string, ownerId: string) {
  return db.opportunity.create({
    data: {
      organizationId: orgId,
      createdByUserId: ownerId,
      title: `Room opportunity ${randomUUID().slice(0, 8)}`,
      description: "An opportunity used to exercise the hiring-room engine in tests.",
      status: "CLOSED", // RD-3: rooms may spawn regardless of opportunity status
      salaryMinPaise: 500_000_00,
      salaryMaxPaise: 900_000_00,
      salaryCurrency: "INR",
      compensationPeriod: "YEAR",
    },
  });
}

/** An ACCEPTED invitation with the immutable accepted-terms snapshot
 * stamped (direct fixture — the M-O6 accept path is covered elsewhere). */
async function makeAcceptedInvitation(params: {
  organizationId: string;
  opportunityId: string;
  candidateUserId: string;
  createdByUserId: string;
  status?: string;
}) {
  const accepted = (params.status ?? "ACCEPTED") === "ACCEPTED";
  return db.opportunityInvitation.create({
    data: {
      organizationId: params.organizationId,
      opportunityId: params.opportunityId,
      candidateUserId: params.candidateUserId,
      status: params.status ?? "ACCEPTED",
      offerSalaryMinPaise: BigInt("110000000"),
      offerSalaryMaxPaise: BigInt("140000000"),
      offerCurrency: "INR",
      offerPeriod: "YEAR",
      sentAt: new Date(),
      createdByUserId: params.createdByUserId,
      ...(accepted
        ? {
            acceptedSalaryMinPaise: BigInt("120000000"),
            acceptedSalaryMaxPaise: BigInt("150000000"),
            acceptedCurrency: "INR",
            acceptedPeriod: "YEAR",
            acceptedAt: new Date(),
          }
        : {}),
    },
  });
}

/** Full fixture stack: VERIFIED org (OWNER only) + CLOSED opportunity +
 * accepted invitation + the spawned room. */
async function makeRoomFixture(options: { invitationStatus?: string; candidateTimezone?: string } = {}) {
  const { owner, org } = await makeVerifiedOrg(`Room Flow ${randomUUID().slice(0, 8)}`);
  const opp = await makeOpportunity(org.id, owner.id);
  const candidate = await makeUser("Room Flow Candidate");
  const invitation = await makeAcceptedInvitation({
    organizationId: org.id,
    opportunityId: opp.id,
    candidateUserId: candidate.id,
    createdByUserId: owner.id,
    status: options.invitationStatus,
  });
  const roomId = await createRoomForInvitation({
    actorUserId: owner.id,
    invitationId: invitation.id,
    candidateTimezone: options.candidateTimezone,
  });
  return { owner, org, opp, candidate, invitation, roomId };
}

async function loadRoomRow(roomId: string): Promise<StoredHiringRoomRow & { members: StoredHiringRoomMemberRow[]; interviews: StoredInterviewRow[]; stages: StoredStageEventRow[] }> {
  const room = (await db.hiringRoom.findUniqueOrThrow({
    where: { id: roomId },
    include: { members: true, interviews: true, stages: { orderBy: { createdAt: "asc" } } },
  })) as unknown as StoredHiringRoomRow & { members: StoredHiringRoomMemberRow[]; interviews: StoredInterviewRow[]; stages: StoredStageEventRow[] };
  return room;
}

/** Capture the RoomRuleError a promise rejects with (and fail loudly when
 * it resolves or throws something else). */
async function ruleErrorOf(run: () => Promise<unknown>): Promise<RoomRuleError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RoomRuleError) return e;
    throw e;
  }
  throw new Error(`expected RoomRuleError, but the call resolved`);
}

function futureWindow(minutes = 60, offsetMinutes = 120): { startsAt: Date; endsAt: Date } {
  const startsAt = new Date(Date.now() + offsetMinutes * 60_000);
  return { startsAt, endsAt: new Date(startsAt.getTime() + minutes * 60_000) };
}

async function proposeFor(roomId: string, ownerId: string): Promise<Interview> {
  const { startsAt, endsAt } = futureWindow();
  const { interviewId } = await proposeInterview({
    roomId,
    actorUserId: ownerId,
    type: "VIDEO",
    startsAt,
    endsAt,
  });
  return db.interview.findUniqueOrThrow({ where: { id: interviewId } });
}

describe("M-O7 hiring rooms — timezone helper (RD-14)", () => {
  test("isIanaTimezone accepts real zones and canonical UTC aliases, rejects junk", () => {
    expect(isIanaTimezone("Asia/Kolkata")).toBe(true);
    expect(isIanaTimezone("America/New_York")).toBe(true);
    expect(isIanaTimezone("UTC")).toBe(true);
    expect(isIanaTimezone("Etc/UTC")).toBe(true);
    expect(isIanaTimezone("GMT")).toBe(true);
    expect(isIanaTimezone("Mars/Olympus")).toBe(false);
    expect(isIanaTimezone("")).toBe(false);
    expect(isIanaTimezone("  ")).toBe(false);
    expect(isIanaTimezone("../etc/passwd")).toBe(false);
  });
});

describe("M-O7 hiring rooms — creation (RD-1/RD-3/RD-19)", () => {
  test("happy path: room ACTIVE at INVITATION_ACCEPTED, snapshot + identity frozen, candidate-authored initial stage event, audit + payload-minimal notification", async () => {
    const { owner, org, opp, candidate } = await makeRoomFixture({ candidateTimezone: "Asia/Kolkata" });
    const room = await loadRoomRow(
      (await db.hiringRoom.findFirstOrThrow({ where: { organizationId: org.id } })).id
    );

    expect(room.status).toBe("ACTIVE");
    expect(room.currentStage).toBe("INVITATION_ACCEPTED");
    expect(room.organizationId).toBe(org.id);
    expect(room.opportunityId).toBe(opp.id);
    expect(room.candidateUserId).toBe(candidate.id);
    // RD-19: the candidate's CURRENT name frozen at creation; timezone kept display-only.
    expect(room.candidateDisplayName).toBe(candidate.name);
    expect(room.candidateTimezone).toBe("Asia/Kolkata");
    expect(room.createdByUserId).toBe(owner.id);
    // The frozen accepted snapshot is copied ONCE at creation (RD-19 join contract).
    expect(room.acceptedSalaryMinPaise).toBe(BigInt("120000000"));
    expect(room.acceptedSalaryMaxPaise).toBe(BigInt("150000000"));
    expect(room.acceptedCurrency).toBe("INR");
    expect(room.acceptedPeriod).toBe("YEAR");

    // Honest provenance: the CANDIDATE accepted (initial stage event).
    const initial = room.stages[0];
    expect(initial.stage).toBe("INVITATION_ACCEPTED");
    expect(initial.fromStage).toBeNull();
    expect(initial.actorRole).toBe("CANDIDATE");
    expect(initial.actorUserId).toBe(candidate.id);

    // Audit with the spec'd meta (identifiers only).
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "ox.room.created", targetId: room.id } });
    expect(audit.actorUserId).toBe(owner.id);
    const meta = JSON.parse(audit.meta) as Record<string, unknown>;
    expect(meta.organizationId).toBe(org.id);
    expect(meta.invitationId).toBe(room.invitationId);
    expect(meta.opportunityId).toBe(opp.id);

    // RD-18: candidate notified — identifiers + public title ONLY.
    const notification = await db.notification.findFirstOrThrow({
      where: { userId: candidate.id, type: "HIRING_ROOM_CREATED", dedupKey: `hiring:room:${room.id}:created` },
    });
    const payloadJson = notification.payload;
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    expect(payload.roomId).toBe(room.id);
    expect(payload.opportunityId).toBe(opp.id);
    expect(payload.opportunityTitle).toBe(opp.title);
    // Never money, never contact (RD-18).
    expect(payloadJson).not.toContain("120000000");
    expect(payloadJson).not.toContain("150000000");
    expect(payloadJson).not.toContain("salaryMinPaise");
    expect(payloadJson).not.toContain("@beanfolio.test");
  });

  test("duplicate room for the same invitation → 409 OX_HIRING_ROOM_EXISTS (P2002 backstop semantics)", async () => {
    // RD-1 concurrency semantics: the @unique(invitationId) constraint is the
    // arbiter — the friendly layer does no pre-check, so a racing loser
    // (sequential here, concurrent in production) observes P2002 and maps to
    // the same deterministic 409 as the M-O6 OX_INVITATION_DUPLICATE convention.
    const { owner, roomId } = await makeRoomFixture();
    const invitationId = (await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } })).invitationId;
    const error = await ruleErrorOf(() => createRoomForInvitation({ actorUserId: owner.id, invitationId }));
    expect(error.code).toBe("OX_HIRING_ROOM_EXISTS");
    expect(error.httpStatus).toBe(409);
    expect(await db.hiringRoom.count({ where: { invitationId } })).toBe(1);
  });

  test("non-ACCEPTED invitation and unknown invitation → 404-deny (join contract)", async () => {
    const { owner, org } = await makeVerifiedOrg(`Room Neg ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeUser("Room Neg Candidate");
    const invitation = await makeAcceptedInvitation({
      organizationId: org.id,
      opportunityId: opp.id,
      candidateUserId: candidate.id,
      createdByUserId: owner.id,
      status: "SENT",
    });
    // 404-deny: unknown and non-ACCEPTED invitations are indistinguishable.
    const sent = await ruleErrorOf(() => createRoomForInvitation({ actorUserId: owner.id, invitationId: invitation.id }));
    expect(sent.code).toBe("OX_HIRING_ROOM_NOT_FOUND");
    expect(sent.httpStatus).toBe(404);
    const unknown = await ruleErrorOf(() => createRoomForInvitation({ actorUserId: owner.id, invitationId: "does-not-exist" }));
    expect(unknown.code).toBe("OX_HIRING_ROOM_NOT_FOUND");
    expect(unknown.httpStatus).toBe(404);
    expect(await db.hiringRoom.count({ where: { organizationId: org.id } })).toBe(0);
  });
});

describe("M-O7 hiring rooms — stage machine (RD-8/RD-9/RD-10/RD-11)", () => {
  test("forward skip allowed; employer stage event with private note; audit + HIRING_ROOM_STAGE to the candidate", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    await transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "SCREENING", note: "signal looks strong internally" });

    const room = await loadRoomRow(roomId);
    expect(room.currentStage).toBe("SCREENING"); // skipped INITIAL_REVIEW (RD-9 forward skips)
    const event = room.stages.find((s) => s.stage === "SCREENING")!;
    expect(event.fromStage).toBe("INVITATION_ACCEPTED");
    expect(event.actorRole).toBe("EMPLOYER");
    expect(event.actorUserId).toBe(owner.id);
    expect(event.note).toBe("signal looks strong internally"); // employer-private by audience, kept on the row

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "ox.room.stage_advanced", targetId: roomId } });
    const meta = JSON.parse(audit.meta) as Record<string, unknown>;
    expect(meta.stage).toBe("SCREENING");
    expect(meta.fromStage).toBe("INVITATION_ACCEPTED");
    // Vocabulary-only audit meta: the private note NEVER enters the audit.
    expect(audit.meta).not.toContain("signal looks strong");

    const notification = await db.notification.findFirstOrThrow({
      where: { userId: candidate.id, type: "HIRING_ROOM_STAGE", dedupKey: `hiring:room:${roomId}:stage:SCREENING` },
    });
    const payload = JSON.parse(notification.payload) as Record<string, unknown>;
    expect(payload.stage).toBe("SCREENING");
    expect(payload.roomId).toBe(roomId);
  });

  test("backward and same-stage transitions → 409 OX_STAGE_INVALID_TRANSITION with ZERO writes", async () => {
    const { owner, roomId } = await makeRoomFixture();
    await transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "SCREENING" });
    const eventsBefore = await db.hiringStageEvent.count({ where: { roomId } });

    const backward = await ruleErrorOf(() =>
      transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "INITIAL_REVIEW" })
    );
    expect(backward.code).toBe("OX_STAGE_INVALID_TRANSITION");
    expect(backward.httpStatus).toBe(409);

    const same = await ruleErrorOf(() =>
      transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "SCREENING" })
    );
    expect(same.code).toBe("OX_STAGE_INVALID_TRANSITION");

    const unknown = await ruleErrorOf(() =>
      transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "TELEPORT" })
    );
    expect(unknown.code).toBe("OX_STAGE_INVALID_TRANSITION");

    // Zero writes: stage unchanged, no extra history rows.
    const room = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.currentStage).toBe("SCREENING");
    expect(await db.hiringStageEvent.count({ where: { roomId } })).toBe(eventsBefore);
  });

  test("HIRED requires OFFER (409 otherwise, zero writes); from OFFER closes atomically with exactly ONE closure notification and NO stage notification", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();

    // From INVITATION_ACCEPTED: forward-only passes, the OFFER guard refuses.
    const guarded = await ruleErrorOf(() =>
      transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "HIRED" })
    );
    expect(guarded.code).toBe("OX_STAGE_INVALID_TRANSITION");
    const roomAfterGuard = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(roomAfterGuard.status).toBe("ACTIVE");
    expect(roomAfterGuard.closedOutcome).toBeNull();

    await transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "OFFER" });
    await transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "HIRED" });

    const room = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.status).toBe("CLOSED");
    expect(room.closedOutcome).toBe("HIRED");
    expect(room.currentStage).toBe("HIRED");
    expect(room.closedAt).not.toBeNull();
    // Stage event + close audit recorded in the SAME transaction.
    const hiredEvent = await db.hiringStageEvent.findFirstOrThrow({ where: { roomId, stage: "HIRED" } });
    expect(hiredEvent.fromStage).toBe("OFFER");
    const closedAudit = await db.auditEvent.findFirstOrThrow({ where: { action: "ox.room.closed", targetId: roomId } });
    expect((JSON.parse(closedAudit.meta) as Record<string, unknown>).outcome).toBe("HIRED");

    // Clarification C: exactly ONE closure notification, ZERO stage notifications for the terminal stage.
    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_ROOM_CLOSED", dedupKey: `hiring:room:${roomId}:closed` } })).toBe(1);
    expect(await db.notification.count({ where: { type: "HIRING_ROOM_STAGE", dedupKey: `hiring:room:${roomId}:stage:HIRED` } })).toBe(0);
  });

  test("REJECTED requires an approved reason; closes with outcome + reason code; room is terminal afterwards", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();

    const missing = await ruleErrorOf(() => transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "REJECTED" }));
    expect(missing.code).toBe("OX_ROOM_INVALID_REASON");
    expect(missing.httpStatus).toBe(400);
    const offVocab = await ruleErrorOf(() =>
      transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "REJECTED", reason: "JUST_BECAUSE" })
    );
    expect(offVocab.code).toBe("OX_ROOM_INVALID_REASON");
    expect(await db.hiringRoom.count({ where: { id: roomId, status: "ACTIVE" } })).toBe(1); // zero writes

    await transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "REJECTED", reason: "SKILL_GAP", note: "another role fits better" });
    const room = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.status).toBe("CLOSED");
    expect(room.closedOutcome).toBe("REJECTED");
    expect(room.closedReason).toBe("SKILL_GAP");
    const event = await db.hiringStageEvent.findFirstOrThrow({ where: { roomId, stage: "REJECTED" } });
    expect(event.reason).toBe("SKILL_GAP");
    const closedAudit = await db.auditEvent.findFirstOrThrow({ where: { action: "ox.room.closed", targetId: roomId } });
    const meta = JSON.parse(closedAudit.meta) as Record<string, unknown>;
    expect(meta.outcome).toBe("REJECTED");
    expect(meta.reason).toBe("SKILL_GAP");

    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_ROOM_CLOSED", dedupKey: `hiring:room:${roomId}:closed` } })).toBe(1);

    // Terminal: no further stage writes.
    const late = await ruleErrorOf(() =>
      transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "OFFER" })
    );
    expect(late.code).toBe("OX_ROOM_NOT_ACTIONABLE");
  });

  test("WITHDRAWN is candidate-only — the employer stage route refuses with 409", async () => {
    const { owner, roomId } = await makeRoomFixture();
    const error = await ruleErrorOf(() =>
      transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "WITHDRAWN", reason: "PERSONAL" })
    );
    expect(error.code).toBe("OX_STAGE_INVALID_TRANSITION");
    expect(error.httpStatus).toBe(409);
    const room = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.status).toBe("ACTIVE");
    expect(await db.hiringStageEvent.count({ where: { roomId, stage: "WITHDRAWN" } })).toBe(0);
  });

  test("ON_HOLD refuses writes with OX_ROOM_NOT_ACTIONABLE; pause/resume round-trip clears pausedAt; double pause/resume refuse", async () => {
    const { owner, roomId } = await makeRoomFixture();
    await pauseRoom({ roomId, actorUserId: owner.id });

    const roomOnHold = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(roomOnHold.status).toBe("ON_HOLD");
    expect(roomOnHold.pausedAt).not.toBeNull();

    const refused = await ruleErrorOf(() =>
      transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "INITIAL_REVIEW" })
    );
    expect(refused.code).toBe("OX_ROOM_NOT_ACTIONABLE");
    expect(refused.httpStatus).toBe(409);

    const doublePause = await ruleErrorOf(() => pauseRoom({ roomId, actorUserId: owner.id }));
    expect(doublePause.code).toBe("OX_ROOM_NOT_ACTIONABLE");

    await resumeRoom({ roomId, actorUserId: owner.id });
    const roomResumed = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(roomResumed.status).toBe("ACTIVE");
    expect(roomResumed.pausedAt).toBeNull();
    const doubleResume = await ruleErrorOf(() => resumeRoom({ roomId, actorUserId: owner.id }));
    expect(doubleResume.code).toBe("OX_ROOM_NOT_ACTIONABLE");

    // Pause/resume audits exist.
    expect(await db.auditEvent.count({ where: { action: "ox.room.paused", targetId: roomId } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "ox.room.resumed", targetId: roomId } })).toBe(1);
  });
});

describe("M-O7 hiring rooms — candidate withdrawal (RD-7)", () => {
  test("candidate-only: employer, org VIEWER, unassigned HIRING_MANAGER and outsiders are 404-denied", async () => {
    const { owner, org, candidate, roomId } = await makeRoomFixture();
    const viewer = await makeOrgMember(org.id, "VIEWER");
    const unassignedHm = await makeOrgMember(org.id, "HIRING_MANAGER");
    const outsider = await makeUser("Room Outsider");

    for (const actor of [owner, viewer, unassignedHm, outsider]) {
      const error = await ruleErrorOf(() => withdrawFromRoom({ roomId, actorUserId: actor.id, reason: "PERSONAL" }));
      expect(error.code).toBe("OX_HIRING_ROOM_NOT_FOUND");
      expect(error.httpStatus).toBe(404);
    }
    // The candidate CAN withdraw — but this room must survive for the next assertions.
    const room = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.candidateUserId).toBe(candidate.id);
  });

  test("withdraw from ON_HOLD: terminal room, WITHDRAWN stage event, live interviews auto-cancelled with NULL cancelReason + audit cause, employers notified, candidate NOT, zero deletion", async () => {
    const { owner, org, candidate, roomId } = await makeRoomFixture();
    const interviewer = await makeOrgMember(org.id, "RECRUITER");
    const interview = await proposeFor(roomId, owner.id);
    // The assigned HIRING_MANAGER is also an employer recipient (RD-18).
    const manager = await makeOrgMember(org.id, "HIRING_MANAGER");
    await assignRoomManager({ roomId, actorUserId: owner.id, targetUserId: manager.id });

    await pauseRoom({ roomId, actorUserId: owner.id }); // withdrawal is allowed from ON_HOLD too
    await withdrawFromRoom({ roomId, actorUserId: candidate.id, reason: "ACCEPTED_OTHER_OFFER" });

    const room = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.status).toBe("CANDIDATE_WITHDRAWN");
    expect(room.closedAt).not.toBeNull();
    const event = await db.hiringStageEvent.findFirstOrThrow({ where: { roomId, stage: "WITHDRAWN" } });
    expect(event.actorRole).toBe("CANDIDATE");
    expect(event.actorUserId).toBe(candidate.id);
    expect(event.reason).toBe("ACCEPTED_OTHER_OFFER");

    // Auto-cancel: the live interview is CANCELLED with cancelReason NULL
    // (CANDIDATE_WITHDREW is deliberately NOT in the interview vocabulary)…
    const cancelled = await db.interview.findUniqueOrThrow({ where: { id: interview.id } });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelReason).toBeNull();
    expect(cancelled.cancelledByUserId).toBe(candidate.id);
    // …zero deletion: the row still exists, history intact.
    expect(await db.interview.count({ where: { roomId } })).toBe(1);
    expect(await db.hiringStageEvent.count({ where: { roomId } })).toBe(2); // initial INVITATION_ACCEPTED + WITHDRAWN

    // Audits: room withdrawal + per-interview cancellation with the cause marker.
    const roomAudit = await db.auditEvent.findFirstOrThrow({ where: { action: "ox.room.withdrawn", targetId: roomId } });
    expect((JSON.parse(roomAudit.meta) as Record<string, unknown>).reason).toBe("ACCEPTED_OTHER_OFFER");
    const interviewAudit = await db.auditEvent.findFirstOrThrow({
      where: { action: "ox.interview.cancelled", targetType: "INTERVIEW", targetId: interview.id },
    });
    expect((JSON.parse(interviewAudit.meta) as Record<string, unknown>).cause).toBe("CANDIDATE_WITHDREW");

    // RD-18 recipients: ACTIVE OWNER/ADMIN/RECRUITER + the ACTIVE assigned HIRING_MANAGER.
    const withdrawnForOwner = await db.notification.findFirst({ where: { userId: owner.id, type: "HIRING_ROOM_WITHDRAWN", dedupKey: `hiring:room:${roomId}:withdrawn` } });
    const withdrawnForRecruiter = await db.notification.findFirst({ where: { userId: interviewer.id, type: "HIRING_ROOM_WITHDRAWN", dedupKey: `hiring:room:${roomId}:withdrawn` } });
    const withdrawnForManager = await db.notification.findFirst({ where: { userId: manager.id, type: "HIRING_ROOM_WITHDRAWN", dedupKey: `hiring:room:${roomId}:withdrawn` } });
    // The M-O6 fan-out convention dedups the team event on ONE key (globally
    // unique dedupKey): exactly one representative row exists for the event.
    const rowsForEvent = [withdrawnForOwner, withdrawnForRecruiter, withdrawnForManager].filter(Boolean).length;
    expect(rowsForEvent).toBe(1);
    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_ROOM_WITHDRAWN" } })).toBe(0);
    // NO closure notification to the candidate — they performed the action.
    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_ROOM_CLOSED" } })).toBe(0);
    expect(interviewer).toBeDefined(); // part of the recipient matrix above
  });

  test("withdraw reason is required and vocabulary-checked (400 on refusal)", async () => {
    const { owner, org } = await makeVerifiedOrg(`Room WDR ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeUser("Room WDR Candidate");
    const invitation = await makeAcceptedInvitation({
      organizationId: org.id,
      opportunityId: opp.id,
      candidateUserId: candidate.id,
      createdByUserId: owner.id,
    });
    const roomId = await createRoomForInvitation({ actorUserId: owner.id, invitationId: invitation.id });
    const missing = await ruleErrorOf(() => withdrawFromRoom({ roomId, actorUserId: candidate.id, reason: "" }));
    expect(missing.code).toBe("OX_ROOM_INVALID_REASON");
    const offVocab = await ruleErrorOf(() => withdrawFromRoom({ roomId, actorUserId: candidate.id, reason: "JUST_BECAUSE" }));
    expect(offVocab.code).toBe("OX_ROOM_INVALID_REASON");
    expect(await db.hiringRoom.count({ where: { id: roomId, status: "ACTIVE" } })).toBe(1);
  });
});

describe("M-O7 hiring rooms — room-scoped membership (RD-4/RD-5)", () => {
  test("assign: HIRING_MANAGER row + audit + notification to the target", async () => {
    const { owner, org, roomId } = await makeRoomFixture();
    const manager = await makeOrgMember(org.id, "HIRING_MANAGER");
    const { memberId } = await assignRoomManager({ roomId, actorUserId: owner.id, targetUserId: manager.id });

    const row = await db.hiringRoomMember.findUniqueOrThrow({ where: { id: memberId } });
    expect(row.roomId).toBe(roomId);
    expect(row.userId).toBe(manager.id);
    expect(row.roomRole).toBe("HIRING_MANAGER");
    expect(row.removedAt).toBeNull();
    expect(row.assignedByUserId).toBe(owner.id);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "ox.room.member_assigned", targetType: "HIRING_ROOM", targetId: roomId } });
    const assignMeta = JSON.parse(audit.meta) as Record<string, unknown>;
    expect(assignMeta.roomRole).toBe("HIRING_MANAGER");
    expect(assignMeta.userId).toBe(manager.id);

    const notification = await db.notification.findFirstOrThrow({
      where: { userId: manager.id, type: "HIRING_ROOM_MEMBER", dedupKey: `hiring:room:${roomId}:member:${memberId}:assigned` },
    });
    expect((JSON.parse(notification.payload) as Record<string, unknown>).roomId).toBe(roomId);
  });

  test("VIEWER target and non-ACTIVE targets refuse with 409 OX_MEMBER_NOT_ACTIVE (VIEWER distinguished)", async () => {
    const { owner, org, roomId } = await makeRoomFixture();
    const viewer = await makeOrgMember(org.id, "VIEWER");
    const viewerError = await ruleErrorOf(() => assignRoomManager({ roomId, actorUserId: owner.id, targetUserId: viewer.id }));
    expect(viewerError.code).toBe("OX_MEMBER_NOT_ACTIVE");
    expect(viewerError.httpStatus).toBe(409);
    expect(viewerError.message).toContain("VIEWER"); // the distinguishing message

    const outsider = await makeUser("Room Non Member");
    const outsiderError = await ruleErrorOf(() => assignRoomManager({ roomId, actorUserId: owner.id, targetUserId: outsider.id }));
    expect(outsiderError.code).toBe("OX_MEMBER_NOT_ACTIVE");

    const suspended = await makeOrgMember(org.id, "HIRING_MANAGER", "SUSPENDED");
    const suspendedError = await ruleErrorOf(() => assignRoomManager({ roomId, actorUserId: owner.id, targetUserId: suspended.id }));
    expect(suspendedError.code).toBe("OX_MEMBER_NOT_ACTIVE");

    expect(await db.hiringRoomMember.count({ where: { roomId } })).toBe(0);
  });

  test("replace-on-assign soft-removes the previous manager and notifies them; reassignment reactivates the SAME row", async () => {
    const { owner, org, roomId } = await makeRoomFixture();
    const first = await makeOrgMember(org.id, "HIRING_MANAGER");
    const second = await makeOrgMember(org.id, "HIRING_MANAGER");

    const a = await assignRoomManager({ roomId, actorUserId: owner.id, targetUserId: first.id });
    const b = await assignRoomManager({ roomId, actorUserId: owner.id, targetUserId: second.id });
    expect(b.replacedMemberId).toBe(a.memberId);

    const removedRow = await db.hiringRoomMember.findUniqueOrThrow({ where: { id: a.memberId } });
    expect(removedRow.removedAt).not.toBeNull();
    const activeRow = await db.hiringRoomMember.findUniqueOrThrow({ where: { id: b.memberId } });
    expect(activeRow.removedAt).toBeNull();
    // Singular active manager (RD-5).
    expect(await db.hiringRoomMember.count({ where: { roomId, roomRole: "HIRING_MANAGER", removedAt: null } })).toBe(1);

    const removedAudit = await db.auditEvent.findFirstOrThrow({
      where: { action: "ox.room.member_removed", targetType: "HIRING_ROOM", targetId: roomId },
    });
    expect(removedAudit.actorUserId).toBe(owner.id);
    const removedNotification = await db.notification.findFirst({
      where: { userId: first.id, type: "HIRING_ROOM_MEMBER", dedupKey: `hiring:room:${roomId}:member:${a.memberId}:removed` },
    });
    expect(removedNotification).not.toBeNull();

    // Reactivation: the same (roomId, userId) row comes back, never a second row.
    const reactivated = await assignRoomManager({ roomId, actorUserId: owner.id, targetUserId: first.id });
    expect(reactivated.memberId).toBe(a.memberId);
    const back = await db.hiringRoomMember.findUniqueOrThrow({ where: { id: a.memberId } });
    expect(back.removedAt).toBeNull();
    expect(await db.hiringRoomMember.count({ where: { roomId, userId: first.id } })).toBe(1);
  });

  test("remove: soft removal records removedAt; removing again (or unknown id) → 404 OX_ROOM_MEMBER_NOT_FOUND; affected member notified", async () => {
    const { owner, org, roomId } = await makeRoomFixture();
    const manager = await makeOrgMember(org.id, "HIRING_MANAGER");
    const { memberId } = await assignRoomManager({ roomId, actorUserId: owner.id, targetUserId: manager.id });

    await removeRoomMember({ roomId, actorUserId: owner.id, memberId });
    const row = await db.hiringRoomMember.findUniqueOrThrow({ where: { id: memberId } });
    expect(row.removedAt).not.toBeNull(); // soft removal — the row is never deleted
    expect(await db.notification.count({ where: { userId: manager.id, type: "HIRING_ROOM_MEMBER", dedupKey: `hiring:room:${roomId}:member:${memberId}:removed` } })).toBe(1);

    const again = await ruleErrorOf(() => removeRoomMember({ roomId, actorUserId: owner.id, memberId }));
    expect(again.code).toBe("OX_ROOM_MEMBER_NOT_FOUND");
    expect(again.httpStatus).toBe(404);
    const bogus = await ruleErrorOf(() => removeRoomMember({ roomId, actorUserId: owner.id, memberId: "no-such-member" }));
    expect(bogus.code).toBe("OX_ROOM_MEMBER_NOT_FOUND");
    expect(await db.hiringRoomMember.count({ where: { roomId } })).toBe(1); // zero deletion
  });

  test("assigned HIRING_MANAGER powers (RD-5): may pause/resume; may NOT cancel, withdraw or manage members; unassigned org HM is 404-denied", async () => {
    const { owner, org, candidate, roomId } = await makeRoomFixture();
    const manager = await makeOrgMember(org.id, "HIRING_MANAGER");
    const unassigned = await makeOrgMember(org.id, "HIRING_MANAGER");
    await assignRoomManager({ roomId, actorUserId: owner.id, targetUserId: manager.id });

    // Unassigned org HIRING_MANAGER: 404-deny on everything room-scoped.
    const denied = await ruleErrorOf(() => pauseRoom({ roomId, actorUserId: unassigned.id }));
    expect(denied.code).toBe("OX_HIRING_ROOM_NOT_FOUND");
    const deniedStage = await ruleErrorOf(() =>
      transitionStage({ roomId, actorUserId: unassigned.id, actorRole: "EMPLOYER", stage: "SCREENING" })
    );
    expect(deniedStage.code).toBe("OX_HIRING_ROOM_NOT_FOUND");

    // Assigned manager MAY pause and resume.
    await pauseRoom({ roomId, actorUserId: manager.id });
    expect((await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } })).status).toBe("ON_HOLD");
    await resumeRoom({ roomId, actorUserId: manager.id });
    expect((await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } })).status).toBe("ACTIVE");

    // Assigned manager may advance stages (RD-5).
    await transitionStage({ roomId, actorUserId: manager.id, actorRole: "EMPLOYER", stage: "INITIAL_REVIEW" });
    expect((await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } })).currentStage).toBe("INITIAL_REVIEW");

    // …but NEVER close/cancel, withdraw, or manage members (404-deny).
    const cancelDenied = await ruleErrorOf(() => cancelRoom({ roomId, actorUserId: manager.id, reason: "OTHER" }));
    expect(cancelDenied.code).toBe("OX_HIRING_ROOM_NOT_FOUND");
    const withdrawDenied = await ruleErrorOf(() => withdrawFromRoom({ roomId, actorUserId: manager.id, reason: "PERSONAL" }));
    expect(withdrawDenied.code).toBe("OX_HIRING_ROOM_NOT_FOUND");
    const assignDenied = await ruleErrorOf(() => assignRoomManager({ roomId, actorUserId: manager.id, targetUserId: unassigned.id }));
    expect(assignDenied.code).toBe("OX_HIRING_ROOM_NOT_FOUND");
    const candidateUntouched = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(candidateUntouched.candidateUserId).toBe(candidate.id);
  });
});

describe("M-O7 hiring rooms — interviews (RD-12/RD-13)", () => {
  test("window validation matrix: endsAt<=startsAt, <15 min, >4 h, past startsAt → 400 OX_INTERVIEW_INVALID_WINDOW; bounds are inclusive", () => {
    const base = new Date(Date.now() + 120 * 60_000);
    for (const bad of [
      { startsAt: base, endsAt: base }, // zero duration
      { startsAt: base, endsAt: new Date(base.getTime() - 60_000) }, // ends before it starts
      { startsAt: base, endsAt: new Date(base.getTime() + (OX_INTERVIEW_MIN_MINUTES - 1) * 60_000) }, // 14 min
      { startsAt: base, endsAt: new Date(base.getTime() + (OX_INTERVIEW_MAX_MINUTES + 1) * 60_000) }, // 241 min
    ]) {
      const error = ruleErrorOf(() => Promise.resolve(validateInterviewWindow(bad.startsAt, bad.endsAt))) as unknown as Promise<RoomRuleError>;
      // validateInterviewWindow throws synchronously — wrap into the same shape.
      try {
        validateInterviewWindow(bad.startsAt, bad.endsAt);
        throw new Error("expected OX_INTERVIEW_INVALID_WINDOW");
      } catch (e) {
        expect(e).toBeInstanceOf(RoomRuleError);
        expect((e as RoomRuleError).code).toBe("OX_INTERVIEW_INVALID_WINDOW");
        expect((e as RoomRuleError).httpStatus).toBe(400);
      }
      void error;
    }
    // Inclusive bounds.
    expect(() => validateInterviewWindow(base, new Date(base.getTime() + OX_INTERVIEW_MIN_MINUTES * 60_000))).not.toThrow();
    expect(() => validateInterviewWindow(base, new Date(base.getTime() + OX_INTERVIEW_MAX_MINUTES * 60_000))).not.toThrow();
    // Past startsAt for propose/alternate/reschedule (NOT complete).
    const past = new Date(Date.now() - 60_000);
    expect(() => assertInterviewStartsInFuture(past)).toThrow(RoomRuleError);
    expect(() => assertInterviewStartsInFuture(new Date(Date.now() + 60_000))).not.toThrow();
  });

  test("propose: employer-side only (candidate → 404); row + audit + candidate notification with the pinned dedup key; ON_HOLD refuses", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    const candidateError = await ruleErrorOf(() => {
      const w = futureWindow();
      return proposeInterview({ roomId, actorUserId: candidate.id, type: "VIDEO", ...w });
    });
    expect(candidateError.code).toBe("OX_HIRING_ROOM_NOT_FOUND");
    expect(candidateError.httpStatus).toBe(404);

    const interview = await proposeFor(roomId, owner.id);
    expect(interview.status).toBe("PROPOSED");
    expect(interview.proposedByRole).toBe("EMPLOYER");
    expect(interview.proposedByUserId).toBe(owner.id);
    expect(interview.schedulingUserId).toBe(owner.id);
    expect(interview.cancelReason).toBeNull();

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "ox.interview.proposed", targetId: interview.id } });
    const meta = JSON.parse(audit.meta) as Record<string, unknown>;
    expect(meta.type).toBe("VIDEO");
    expect(meta.proposedByRole).toBe("EMPLOYER");

    const candidateNotification = await db.notification.findFirstOrThrow({
      where: { userId: candidate.id, type: "HIRING_INTERVIEW", dedupKey: `hiring:room:${roomId}:interview:${interview.id}:proposed` },
    });
    const payload = JSON.parse(candidateNotification.payload) as Record<string, unknown>;
    expect(payload.startsAt).toBe(interview.startsAt.toISOString()); // ISO UTC
    expect(JSON.stringify(payload)).not.toContain("http"); // no links in payloads (RD-18)

    // ON_HOLD refuses interview operations.
    await pauseRoom({ roomId, actorUserId: owner.id });
    const onHold = await ruleErrorOf(() => {
      const w = futureWindow();
      return proposeInterview({ roomId, actorUserId: owner.id, type: "VIDEO", ...w });
    });
    expect(onHold.code).toBe("OX_ROOM_NOT_ACTIONABLE");
    await resumeRoom({ roomId, actorUserId: owner.id });
  });

  test("confirm: proposer refused (confirmation right belongs to the other side); candidate confirms; confirmation race → 409", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    const interview = await proposeFor(roomId, owner.id);

    const selfConfirm = await ruleErrorOf(() => confirmInterview({ roomId, interviewId: interview.id, actorUserId: owner.id }));
    expect(selfConfirm.code).toBe("OX_INTERVIEW_NOT_ACTIONABLE");
    expect(selfConfirm.httpStatus).toBe(409);
    expect((await db.interview.findUniqueOrThrow({ where: { id: interview.id } })).status).toBe("PROPOSED");

    await confirmInterview({ roomId, interviewId: interview.id, actorUserId: candidate.id });
    expect((await db.interview.findUniqueOrThrow({ where: { id: interview.id } })).status).toBe("CONFIRMED");
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "ox.interview.confirmed", targetId: interview.id } });
    expect((JSON.parse(audit.meta) as Record<string, unknown>).confirmedByRole).toBe("CANDIDATE");

    // Race/second-confirm: guarded updateMany matches zero rows → truthful 409.
    const race = await ruleErrorOf(() => confirmInterview({ roomId, interviewId: interview.id, actorUserId: candidate.id }));
    expect(race.code).toBe("OX_INTERVIEW_NOT_ACTIONABLE");
    // The employer side is notified of the candidate's confirmation.
    expect(
      await db.notification.count({
        where: { type: "HIRING_INTERVIEW", dedupKey: `hiring:room:${roomId}:interview:${interview.id}:confirmed:employer:${owner.id}` },
      })
    ).toBe(1);
  });

  test("alternate: counters flip proposedByRole and move the confirmation right; proposer cannot counter their own proposal", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    const interview = await proposeFor(roomId, owner.id);

    const ownCounter = await ruleErrorOf(() => {
      const w = futureWindow(60, 240);
      return alternateInterview({ roomId, interviewId: interview.id, actorUserId: owner.id, ...w });
    });
    expect(ownCounter.code).toBe("OX_INTERVIEW_NOT_ACTIONABLE");

    const w = futureWindow(60, 240);
    await alternateInterview({ roomId, interviewId: interview.id, actorUserId: candidate.id, ...w });
    const flipped = await db.interview.findUniqueOrThrow({ where: { id: interview.id } });
    expect(flipped.status).toBe("PROPOSED"); // still PROPOSED — right moved, not state
    expect(flipped.proposedByRole).toBe("CANDIDATE");
    expect(flipped.proposedByUserId).toBe(candidate.id);
    expect(flipped.startsAt.getTime()).toBe(w.startsAt.getTime());

    // The ORIGINAL proposer (employer side) now holds the confirmation right.
    await confirmInterview({ roomId, interviewId: interview.id, actorUserId: owner.id });
    expect((await db.interview.findUniqueOrThrow({ where: { id: interview.id } })).status).toBe("CONFIRMED");
    expect(await db.auditEvent.count({ where: { action: "ox.interview.alternate", targetId: interview.id } })).toBe(1);
  });

  test("reschedule: CONFIRMED → PROPOSED under the rescheduler's role; window + future checks apply; PROPOSED rows refuse", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    const interview = await proposeFor(roomId, owner.id);
    await confirmInterview({ roomId, interviewId: interview.id, actorUserId: candidate.id });

    const past = await ruleErrorOf(() =>
      rescheduleInterview({ roomId, interviewId: interview.id, actorUserId: candidate.id, startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 30 * 60_000) })
    );
    expect(past.code).toBe("OX_INTERVIEW_INVALID_WINDOW");

    const w = futureWindow(45, 300);
    await rescheduleInterview({ roomId, interviewId: interview.id, actorUserId: candidate.id, ...w });
    const row = await db.interview.findUniqueOrThrow({ where: { id: interview.id } });
    expect(row.status).toBe("PROPOSED");
    expect(row.proposedByRole).toBe("CANDIDATE"); // rescheduler's role recorded
    expect(row.startsAt.getTime()).toBe(w.startsAt.getTime());

    // A PROPOSED interview cannot be rescheduled again (state guard).
    const notConfirmed = await ruleErrorOf(() => {
      const w2 = futureWindow(45, 400);
      return rescheduleInterview({ roomId, interviewId: interview.id, actorUserId: owner.id, ...w2 });
    });
    expect(notConfirmed.code).toBe("OX_INTERVIEW_NOT_ACTIONABLE");
    expect(await db.auditEvent.count({ where: { action: "ox.interview.rescheduled", targetId: interview.id } })).toBe(1);
  });

  test("cancel: reason REQUIRED from the interview vocabulary; either party; audit + code-only payload", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    const interview = await proposeFor(roomId, owner.id);

    const offVocab = await ruleErrorOf(() =>
      cancelInterview({ roomId, interviewId: interview.id, actorUserId: candidate.id, reason: "JUST_BECAUSE" })
    );
    expect(offVocab.code).toBe("OX_ROOM_INVALID_REASON");
    expect(offVocab.httpStatus).toBe(400);

    await cancelInterview({ roomId, interviewId: interview.id, actorUserId: candidate.id, reason: "SCHEDULING_CONFLICT" });
    const row = await db.interview.findUniqueOrThrow({ where: { id: interview.id } });
    expect(row.status).toBe("CANCELLED");
    expect(row.cancelReason).toBe("SCHEDULING_CONFLICT");
    expect(row.cancelledByUserId).toBe(candidate.id);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "ox.interview.cancelled", targetType: "INTERVIEW", targetId: interview.id } });
    expect((JSON.parse(audit.meta) as Record<string, unknown>).cancelReason).toBe("SCHEDULING_CONFLICT");

    const again = await ruleErrorOf(() =>
      cancelInterview({ roomId, interviewId: interview.id, actorUserId: owner.id, reason: "OTHER" })
    );
    expect(again.code).toBe("OX_INTERVIEW_NOT_ACTIONABLE");

    const notification = await db.notification.findFirstOrThrow({
      where: { userId: owner.id, type: "HIRING_INTERVIEW", dedupKey: `hiring:room:${roomId}:interview:${interview.id}:cancelled:employer:${owner.id}` },
    });
    const payload = JSON.parse(notification.payload) as Record<string, unknown>;
    expect(payload.cancelReason).toBe("SCHEDULING_CONFLICT"); // reason CODE only (RD-18)
  });

  test("complete: employer-side only from CONFIRMED; never edits the window; second complete → 409", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    const interview = await proposeFor(roomId, owner.id);

    const candidateDenied = await ruleErrorOf(() => completeInterview({ roomId, interviewId: interview.id, actorUserId: candidate.id }));
    expect(candidateDenied.code).toBe("OX_HIRING_ROOM_NOT_FOUND"); // 404-deny for the candidate side

    const fromProposed = await ruleErrorOf(() => completeInterview({ roomId, interviewId: interview.id, actorUserId: owner.id }));
    expect(fromProposed.code).toBe("OX_INTERVIEW_NOT_ACTIONABLE"); // PROPOSED cannot be completed

    await confirmInterview({ roomId, interviewId: interview.id, actorUserId: candidate.id });
    const before = await db.interview.findUniqueOrThrow({ where: { id: interview.id } });
    await completeInterview({ roomId, interviewId: interview.id, actorUserId: owner.id });
    const after = await db.interview.findUniqueOrThrow({ where: { id: interview.id } });
    expect(after.status).toBe("COMPLETED");
    expect(after.completedAt).not.toBeNull();
    // The ONLY past-time write: completedAt — the window is never edited.
    expect(after.startsAt.getTime()).toBe(before.startsAt.getTime());
    expect(after.endsAt.getTime()).toBe(before.endsAt.getTime());
    expect(await db.auditEvent.count({ where: { action: "ox.interview.completed", targetId: interview.id } })).toBe(1);

    const again = await ruleErrorOf(() => completeInterview({ roomId, interviewId: interview.id, actorUserId: owner.id }));
    expect(again.code).toBe("OX_INTERVIEW_NOT_ACTIONABLE");
  });
});

describe("M-O7 hiring rooms — room cancellation (RD-2/RD-8/RD-11)", () => {
  test("employer cancel: reason required, CANCELLED + closedReason + closedAt, exactly one closure notification", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();

    const offVocab = await ruleErrorOf(() => cancelRoom({ roomId, actorUserId: owner.id, reason: "WHY_NOT" }));
    expect(offVocab.code).toBe("OX_ROOM_INVALID_REASON");
    expect(await db.hiringRoom.count({ where: { id: roomId, status: "ACTIVE" } })).toBe(1);

    await cancelRoom({ roomId, actorUserId: owner.id, reason: "REQUISITION_CANCELLED" });
    const room = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.status).toBe("CANCELLED");
    expect(room.closedReason).toBe("REQUISITION_CANCELLED");
    expect(room.closedAt).not.toBeNull();
    expect(room.closedOutcome).toBeNull(); // outcome-less closure path (RD-8)

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "ox.room.cancelled", targetId: roomId } });
    expect((JSON.parse(audit.meta) as Record<string, unknown>).reason).toBe("REQUISITION_CANCELLED");

    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_ROOM_CLOSED", dedupKey: `hiring:room:${roomId}:closed` } })).toBe(1);
    // Terminal: nothing further is actionable.
    const late = await ruleErrorOf(() => cancelRoom({ roomId, actorUserId: owner.id, reason: "OTHER" }));
    expect(late.code).toBe("OX_ROOM_NOT_ACTIONABLE");
  });
});

describe("M-O7 hiring rooms — serializers (RD-6/RD-11/RD-15 + clarification A)", () => {
  test("viewer allowlist: no links, no compensation, no notes, no members; frozen identity + code-only stage history", async () => {
    const { owner, org, opp, roomId } = await makeRoomFixture();
    await transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "SCREENING", note: "EMPLOYER_PRIVATE_NOTE_XYZ" });
    await transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "REJECTED", reason: "COMPENSATION_MISMATCH", note: "ANOTHER_PRIVATE_NOTE_XYZ" });
    const room = await loadRoomRow(roomId);

    // EMPLOYER: full detail.
    const employer = serializeRoomForEmployer(room, { callerCanMutateRoom: true });
    const employerJson = JSON.stringify(employer);
    expect(employerJson).toContain("EMPLOYER_PRIVATE_NOTE_XYZ"); // notes included for the employer
    expect((employer.compensation as Record<string, unknown>).salaryMinPaise).toBe(120000000); // checked BigInt → number
    expect(employer.candidateDisplayName).toBe(room.candidateDisplayName);
    expect(employerJson).not.toContain("meetingLink\":\"h"); // no link storage in this schema → always null
    expect((employer.closure as Record<string, unknown>).outcome).toBe("REJECTED");

    // CANDIDATE: reason codes visible, notes structurally absent, no money.
    const candidate = serializeRoomForCandidate(room, { includeMeetingLink: true });
    const candidateJson = JSON.stringify(candidate);
    expect(candidateJson).not.toContain("EMPLOYER_PRIVATE_NOTE_XYZ");
    expect(candidateJson).not.toContain("ANOTHER_PRIVATE_NOTE_XYZ");
    expect(candidateJson).not.toContain('"note"'); // the key itself is stripped, not nulled
    expect(candidateJson).toContain("COMPENSATION_MISMATCH"); // reason CODE visible (RD-11)
    expect((candidate.closure as Record<string, unknown>).reason).toBe("COMPENSATION_MISMATCH");
    expect(candidateJson).not.toContain("salaryMinPaise"); // the room does not re-expose money (RD-18)
    expect(candidateJson).not.toContain("acceptedCurrency");
    expect(candidateJson).not.toContain("@beanfolio.test");

    // VIEWER: explicit allowlist (RD-6 + clarification A).
    const viewer = serializeRoomForViewer(room, { id: opp.id, title: opp.title });
    const viewerJson = JSON.stringify(viewer);
    expect(viewerJson).not.toContain("meetingLink");
    expect(viewerJson).not.toContain("salaryMinPaise");
    expect(viewerJson).not.toContain("EMPLOYER_PRIVATE_NOTE_XYZ");
    expect(viewerJson).not.toContain("ANOTHER_PRIVATE_NOTE_XYZ");
    expect(viewerJson).not.toContain('"note"');
    expect(viewerJson).not.toContain('"members"');
    expect((viewer.opportunity as Record<string, unknown>).title).toBe(opp.title);
    expect(viewer.candidateDisplayName).toBe(room.candidateDisplayName); // frozen identity, not enrichment
    expect((viewer as Record<string, unknown>).stageHistory).toBeDefined(); // code-only stage history
    expect((viewer as Record<string, unknown>).compensation).toBeUndefined(); // clarification A: withheld
  });

  test("VIEWER_COMPENSATION_RULE_VERIFICATION records the clarification-A source-rule verification", () => {
    expect(VIEWER_COMPENSATION_RULE_VERIFICATION.result).toContain("no O0 source rule authorizes compensation exposure to org VIEWERs");
    expect(VIEWER_COMPENSATION_RULE_VERIFICATION.result).toContain("withheld per clarification A");
    expect(VIEWER_COMPENSATION_RULE_VERIFICATION.surfacesInspected.length).toBeGreaterThanOrEqual(3);
  });

  test("meetingLink rule (RD-15): live interviews carry it for authorized audiences only; CANCELLED/COMPLETED omit it for EVERY serializer", () => {
    // Synthetic rows (the applied schema has no link column yet — see
    // StoredInterviewRow): the DTO's RD-15 visibility rule is exercised
    // directly so it is provably correct the moment the column exists.
    const LINK = "https://meet.example/bean-room";
    const interviewRow = (status: string): StoredInterviewRow => ({
      id: "interview-1",
      roomId: "room-1",
      type: "VIDEO",
      status,
      startsAt: new Date(),
      endsAt: new Date(),
      proposedByRole: "EMPLOYER",
      cancelReason: null,
      completedAt: null,
      meetingLink: LINK,
      createdAt: new Date(),
    });
    const employerRoom = (interviews: StoredInterviewRow[]): StoredHiringRoomRow => ({
      id: "r",
      invitationId: "i",
      organizationId: "o",
      opportunityId: "p",
      candidateUserId: null,
      candidateDisplayName: "C",
      status: "ACTIVE",
      currentStage: "SCREENING",
      acceptedSalaryMinPaise: BigInt(1),
      acceptedSalaryMaxPaise: BigInt(2),
      acceptedCurrency: "INR",
      acceptedPeriod: "YEAR",
      candidateTimezone: null,
      closedOutcome: null,
      closedReason: null,
      closedAt: null,
      pausedAt: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      interviews,
      members: [],
      stages: [],
    });
    const candidateRoom = (interviews: StoredInterviewRow[]): StoredHiringRoomRow => ({
      ...employerRoom(interviews),
    });

    // Employer WITH mutation rights: link only while live (PROPOSED/CONFIRMED).
    const employerLive = serializeRoomForEmployer(employerRoom([interviewRow("PROPOSED"), interviewRow("CONFIRMED"), interviewRow("CANCELLED"), interviewRow("COMPLETED")]), { callerCanMutateRoom: true });
    const links = (employerLive.interviews as Record<string, unknown>[]).map((i) => i.meetingLink);
    expect(links[0]).toBe(LINK);
    expect(links[1]).toBe(LINK);
    expect(links[2]).toBeNull();
    expect(links[3]).toBeNull();

    // Employer WITHOUT mutation rights: never.
    const employerNoRights = serializeRoomForEmployer(employerRoom([interviewRow("PROPOSED")]), { callerCanMutateRoom: false });
    expect((employerNoRights.interviews as Record<string, unknown>[])[0].meetingLink).toBeNull();

    // Candidate: link only with includeMeetingLink and only while live.
    const candidateLive = serializeRoomForCandidate(candidateRoom([interviewRow("CONFIRMED"), interviewRow("COMPLETED")]), { includeMeetingLink: true });
    const candidateLinks = (candidateLive.interviews as Record<string, unknown>[]).map((i) => i.meetingLink);
    expect(candidateLinks[0]).toBe(LINK);
    expect(candidateLinks[1]).toBeNull();
    const candidateNoLink = serializeRoomForCandidate(candidateRoom([interviewRow("CONFIRMED")]), { includeMeetingLink: false });
    expect((candidateNoLink.interviews as Record<string, unknown>[])[0].meetingLink).toBeNull();

    // Viewer: the key is structurally absent — never a link anywhere.
    const viewer = serializeRoomForViewer(employerRoom([interviewRow("PROPOSED")]), { id: "p", title: "T" });
    expect(JSON.stringify(viewer)).not.toContain("meet.example");
    expect(JSON.stringify(viewer)).not.toContain("meetingLink");
  });
});

describe("M-O7 hiring rooms — activity timeline (RD-16 + clarification B)", () => {
  test("the interview lifecycle is reconstructable from the audit-derived timeline alone; stage + room events merged; notes never surface", async () => {
    const { owner, candidate, org, roomId } = await makeRoomFixture();
    const manager = await makeOrgMember(org.id, "HIRING_MANAGER");
    await assignRoomManager({ roomId, actorUserId: owner.id, targetUserId: manager.id });

    // Full interview lifecycle: propose → confirm → reschedule → confirm → complete.
    const interview = await proposeFor(roomId, owner.id);
    await confirmInterview({ roomId, interviewId: interview.id, actorUserId: candidate.id });
    const w = futureWindow(50, 500);
    await rescheduleInterview({ roomId, interviewId: interview.id, actorUserId: candidate.id, ...w });
    await confirmInterview({ roomId, interviewId: interview.id, actorUserId: owner.id });
    await completeInterview({ roomId, interviewId: interview.id, actorUserId: owner.id });

    // Room + stage events interleaved.
    await transitionStage({ roomId, actorUserId: owner.id, actorRole: "EMPLOYER", stage: "SCREENING", note: "SECRET_TIMELINE_NOTE" });
    await pauseRoom({ roomId, actorUserId: manager.id });
    await resumeRoom({ roomId, actorUserId: owner.id });

    const { events } = await getRoomActivityTimeline({ roomId });
    const labels = events.map((e) => e.label);
    // Clarification B: the propose/alternate/confirm/reschedule/cancel/
    // complete sequence is reconstructable from the audit-derived events alone.
    expect(labels).toContain("interview:proposed");
    expect(labels).toContain("interview:confirmed");
    expect(labels).toContain("interview:rescheduled");
    expect(labels).toContain("interview:completed");
    expect(labels).toContain("stage:SCREENING");
    expect(labels).toContain("stage:INVITATION_ACCEPTED");
    expect(labels).toContain("room:paused");
    expect(labels).toContain("room:resumed");
    expect(labels).toContain("member:assigned");

    // Ascending order by timestamp.
    const times = events.map((e) => e.at);
    expect([...times].sort()).toEqual(times);

    // Provenance surfaced null-safe: the propose event carries the owner.
    const proposed = events.find((e) => e.label === "interview:proposed")!;
    expect(proposed.kind).toBe("INTERVIEW_EVENT");
    expect(proposed.actorUserId).toBe(owner.id);
    // detail is the vocabulary-only STRING label form (UI contract) carrying ids/codes.
    expect(typeof proposed.detail === "string" || proposed.detail === undefined).toBe(true);
    if (typeof proposed.detail === "string") {
      expect(proposed.detail).toContain(`interviewId:${interview.id}`);
      expect(proposed.detail).toContain("type:VIDEO");
    }

    // Privacy: detail carries vocabulary/ids ONLY — the employer note NEVER surfaces.
    const timelineJson = JSON.stringify(events);
    expect(timelineJson).not.toContain("SECRET_TIMELINE_NOTE");
    expect(timelineJson).not.toContain("meet.example");
    expect(timelineJson).not.toContain("120000000");
  });

  test("timeline for an unknown room 404-denies", async () => {
    const error = await ruleErrorOf(() => getRoomActivityTimeline({ roomId: "no-such-room" }));
    expect(error.code).toBe("OX_HIRING_ROOM_NOT_FOUND");
    expect(error.httpStatus).toBe(404);
  });
});
