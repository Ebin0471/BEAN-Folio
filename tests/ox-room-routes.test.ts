import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

/**
 * M-O7 — hiring-room ROUTE suite (Task 2-c tests the API surface, the lib
 * engine is covered by tests/ox-room-engine.test.ts): creation from
 * ACCEPTED invitations only (RD-1/RD-3), the party-aware list/detail
 * serializers (RD-5/RD-6/RD-11/RD-15 + clarification A), the stage machine
 * through the route envelope (RD-8..RD-11), room-scoped membership (RD-4/
 * RD-5), the interview protocol (RD-12/RD-13/RD-15), candidate withdrawal
 * (RD-7) and the cross-cutting notification-privacy + audit pins (RD-18/
 * RD-22, clarification C).
 *
 * Mirrors tests/ox-invitation-flow.test.ts: cookie-jar mock of
 * next/headers + loginAs, direct-DB fixtures, route handlers imported and
 * invoked in-process with `new NextRequest(...)` + resolved params. No
 * cookies beyond the session jar; every rate-limit bucket is reset before
 * each route call (freshBuckets) so quota pins stay deterministic.
 *
 * Run pinned to the SQLite dev DB:
 *   DATABASE_URL=file:/home/z/bean-folio/db/custom.db bun test tests/ox-room-routes.test.ts
 */
const jar = new Map<string, string>();
const realNextHeaders = await import("next/headers");
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));

import { db } from "@/lib/db";
import { memoryBackend } from "@/lib/rate-limit-backend";
import { hashPassword, createSession } from "@/lib/auth";
import { createRoomForInvitation } from "@/lib/ox/room";
import { POST as createRoomRoute, GET as listRoomsRoute } from "@/app/api/opportunities/hiring-rooms/route";
import { GET as roomDetailRoute } from "@/app/api/opportunities/hiring-rooms/[roomId]/route";
import { POST as pauseRoomRoute } from "@/app/api/opportunities/hiring-rooms/[roomId]/pause/route";
import { POST as resumeRoomRoute } from "@/app/api/opportunities/hiring-rooms/[roomId]/resume/route";
import { POST as cancelRoomRoute } from "@/app/api/opportunities/hiring-rooms/[roomId]/cancel/route";
import { POST as stageRoute } from "@/app/api/opportunities/hiring-rooms/[roomId]/stages/route";
import { POST as assignMemberRoute } from "@/app/api/opportunities/hiring-rooms/[roomId]/members/route";
import { DELETE as removeMemberRoute } from "@/app/api/opportunities/hiring-rooms/[roomId]/members/[memberId]/route";
import { POST as proposeInterviewRoute } from "@/app/api/opportunities/hiring-rooms/[roomId]/interviews/route";
import { POST as confirmInterviewRoute } from "@/app/api/opportunities/hiring-rooms/[roomId]/interviews/[interviewId]/confirm/route";
import { POST as alternateInterviewRoute } from "@/app/api/opportunities/hiring-rooms/[roomId]/interviews/[interviewId]/alternate/route";
import { POST as rescheduleInterviewRoute } from "@/app/api/opportunities/hiring-rooms/[roomId]/interviews/[interviewId]/reschedule/route";
import { POST as cancelInterviewRoute } from "@/app/api/opportunities/hiring-rooms/[roomId]/interviews/[interviewId]/cancel/route";
import { POST as completeInterviewRoute } from "@/app/api/opportunities/hiring-rooms/[roomId]/interviews/[interviewId]/complete/route";
import { GET as meRoomsRoute } from "@/app/api/opportunities/me/hiring-rooms/route";
import { GET as meRoomDetailRoute } from "@/app/api/opportunities/me/hiring-rooms/[roomId]/route";
import { POST as meWithdrawRoute } from "@/app/api/opportunities/me/hiring-rooms/[roomId]/withdraw/route";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

// ---------- Suite-wide privacy markers (RD-18 scan) ----------
const suiteStart = new Date();
const NOTE_MARKER = "EMPLOYER-PRIVATE-NOTE-MARKER";
const MEET_HOST = "meet.beanfolio.test";
const OFFER_MIN_PAISE = "120000000"; // accepted snapshot min (paise)
const OFFER_MAX_PAISE = "150000000"; // accepted snapshot max (paise)

/** Room ids created anywhere in this suite (API or fixture) — audit pins. */
const suiteRoomIds: string[] = [];

function req(path: string, method: string, body?: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function loginAs(userId: string) {
  jar.set("bean_session", await createSession(userId));
}

/** Fresh burst buckets before every route call — quota pins stay exact. */
function freshBuckets(): void {
  memoryBackend.resetForTests();
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

const PWD = await hashPassword("ox-room-routes-password-1");

async function makeUser(name: string) {
  return db.user.create({
    data: { email: `ox-room-r-${randomUUID()}@beanfolio.test`, passwordHash: PWD, name },
  });
}

async function makeVerifiedOrg(displayName: string) {
  const owner = await makeUser(`${displayName} Owner`);
  await loginAs(owner.id);
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
  const user = await makeUser(`Room Route Member ${role} ${randomUUID().slice(0, 8)}`);
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
      title: `Room route opportunity ${randomUUID().slice(0, 8)}`,
      description: "An opportunity used to exercise the hiring-room API in tests.",
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
            acceptedSalaryMinPaise: BigInt(OFFER_MIN_PAISE),
            acceptedSalaryMaxPaise: BigInt(OFFER_MAX_PAISE),
            acceptedCurrency: "INR",
            acceptedPeriod: "YEAR",
            acceptedAt: new Date(),
          }
        : {}),
    },
  });
}

/** Full fixture stack: VERIFIED org (OWNER only) + CLOSED opportunity +
 * accepted invitation + the spawned room (lib path). */
async function makeRoomFixture(options: { invitationStatus?: string; candidateTimezone?: string } = {}) {
  const { owner, org } = await makeVerifiedOrg(`Room Route ${randomUUID().slice(0, 8)}`);
  const opp = await makeOpportunity(org.id, owner.id);
  const candidate = await makeUser("Room Route Candidate");
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
  suiteRoomIds.push(roomId);
  return { owner, org, opp, candidate, invitation, roomId };
}

function futureWindow(minutes = 60, offsetMinutes = 120): { startsAt: string; endsAt: string } {
  const startsAt = new Date(Date.now() + offsetMinutes * 60_000);
  return { startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + minutes * 60_000).toISOString() };
}

/** Employer-side interview proposal through the route (fresh window). */
async function proposeViaRoute(roomId: string, owner: { id: string }, type = "VIDEO", link?: string) {
  await loginAs(owner.id);
  freshBuckets();
  const window = futureWindow();
  return proposeInterviewRoute(
    req(`/api/opportunities/hiring-rooms/${roomId}/interviews`, "POST", {
      type,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      ...(link !== undefined ? { meetingLink: link } : {}),
    }),
    { params: Promise.resolve({ roomId }) }
  );
}

describe("M-O7 hiring rooms — creation & collection (routes)", () => {
  test("employer creates a room from an ACCEPTED invitation; frozen snapshot, audit, payload-minimal candidate notification (RD-1/RD-3/RD-14/RD-18/RD-22)", async () => {
    const { owner, org, opp, candidate, invitation } = await makeRoomFixture();
    // The fixture already spawned one room via the lib; build a SECOND
    // accepted invitation on a fresh opportunity so the API POST is the
    // (only) room creator for it.
    const opp2 = await makeOpportunity(org.id, owner.id);
    const invitation2 = await makeAcceptedInvitation({
      organizationId: org.id,
      opportunityId: opp2.id,
      candidateUserId: candidate.id,
      createdByUserId: owner.id,
    });

    await loginAs(owner.id);
    freshBuckets();
    const created = await createRoomRoute(
      req("/api/opportunities/hiring-rooms", "POST", { invitationId: invitation2.id, candidateTimezone: "Asia/Kolkata" })
    );
    expect(created.status).toBe(201);
    const body = (await resBody(created)) as { room: { id: string; status: string; invitationId: string; candidateUserId: string; currentStage: string } };
    const roomId = body.room.id;
    suiteRoomIds.push(roomId);
    expect(body.room.status).toBe("ACTIVE");
    expect(body.room.invitationId).toBe(invitation2.id);
    expect(body.room.candidateUserId).toBe(candidate.id);
    expect(body.room.currentStage).toBe("INVITATION_ACCEPTED");

    const row = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(row.organizationId).toBe(org.id);
    expect(row.opportunityId).toBe(opp2.id);
    expect(row.candidateDisplayName).toBe(candidate.name); // RD-19 frozen identity
    expect(row.candidateTimezone).toBe("Asia/Kolkata"); // RD-14 display-only
    expect(row.acceptedSalaryMinPaise).toBe(BigInt(OFFER_MIN_PAISE)); // RD-19 frozen terms
    expect(row.createdByUserId).toBe(owner.id);

    // Audit: ox.room.created with targetId = roomId and the invitation pointer.
    const audit = await db.auditEvent.findFirst({ where: { action: "ox.room.created", targetId: roomId } });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(owner.id);
    expect((JSON.parse(audit!.meta) as { invitationId: string }).invitationId).toBe(invitation2.id);

    // Exactly one payload-minimal candidate notification (RD-18).
    const note = await db.notification.findFirst({
      where: { userId: candidate.id, type: "HIRING_ROOM_CREATED", dedupKey: `hiring:room:${roomId}:created` },
    });
    expect(note).not.toBeNull();
    const payload = JSON.parse(note!.payload) as Record<string, unknown>;
    expect(payload.roomId).toBe(roomId);
    expect(payload.opportunityTitle).toBe(opp2.title);
    expect(JSON.stringify(payload)).not.toContain("Paise");
    expect(JSON.stringify(payload)).not.toContain(OFFER_MIN_PAISE);

    // Candidate sees the room in their own list (lean rows, no links).
    await loginAs(candidate.id);
    freshBuckets();
    const meList = (await resBody(await meRoomsRoute(req("/api/opportunities/me/hiring-rooms", "GET")))) as {
      rooms: { id: string; status: string }[];
    };
    const mine = meList.rooms.find((r) => r.id === roomId);
    expect(mine).toBeDefined();
    expect(mine!.status).toBe("ACTIVE");
    expect(JSON.stringify(meList)).not.toContain("meetingLink");
  });

  test("creation refusals: duplicate 409 OX_HIRING_ROOM_EXISTS; non-ACCEPTED 404; VIEWER 404; cross-tenant 404; candidate 404; anonymous 401; bad timezone 400; strict body 400 (RD-1/RD-3)", async () => {
    const { owner, org, candidate, invitation } = await makeRoomFixture();
    const viewer = await makeOrgMember(org.id, "VIEWER");
    const foreign = await makeVerifiedOrg(`Foreign ${randomUUID().slice(0, 8)}`);

    // Duplicate create (the fixture room already exists for this invitation).
    await loginAs(owner.id);
    freshBuckets();
    const dup = await createRoomRoute(req("/api/opportunities/hiring-rooms", "POST", { invitationId: invitation.id }));
    expect(dup.status).toBe(409);
    expect(((await resBody(dup)) as Record<string, unknown>).code).toBe("OX_HIRING_ROOM_EXISTS");

    // Non-ACCEPTED invitation → 404-deny (the ACCEPTED join contract).
    const sentInvitation = await makeAcceptedInvitation({
      organizationId: org.id,
      opportunityId: (await makeOpportunity(org.id, owner.id)).id,
      candidateUserId: candidate.id,
      createdByUserId: owner.id,
      status: "SENT",
    });
    freshBuckets();
    const notAccepted = await createRoomRoute(req("/api/opportunities/hiring-rooms", "POST", { invitationId: sentInvitation.id }));
    expect(notAccepted.status).toBe(404);
    expect(((await resBody(notAccepted)) as Record<string, unknown>).code).toBe("OX_HIRING_ROOM_NOT_FOUND");

    // Unknown invitation → same 404 (existence hiding).
    freshBuckets();
    expect((await createRoomRoute(req("/api/opportunities/hiring-rooms", "POST", { invitationId: "does-not-exist" }))).status).toBe(404);

    // Org VIEWER → 404 (no employer role).
    await loginAs(viewer.id);
    freshBuckets();
    expect((await createRoomRoute(req("/api/opportunities/hiring-rooms", "POST", { invitationId: invitation.id }))).status).toBe(404);

    // Cross-tenant employer (different org) → 404 on someone else's invitation.
    await loginAs(foreign.owner.id);
    freshBuckets();
    expect((await createRoomRoute(req("/api/opportunities/hiring-rooms", "POST", { invitationId: invitation.id }))).status).toBe(404);

    // The room's own candidate → 404 (candidates can never create rooms).
    await loginAs(candidate.id);
    freshBuckets();
    expect((await createRoomRoute(req("/api/opportunities/hiring-rooms", "POST", { invitationId: invitation.id }))).status).toBe(404);

    // Anonymous → 401.
    jar.delete("bean_session");
    freshBuckets();
    expect((await createRoomRoute(req("/api/opportunities/hiring-rooms", "POST", { invitationId: invitation.id }))).status).toBe(401);

    // Invalid candidateTimezone → 400 OX_ROOM_INVALID_TIMEZONE (RD-14).
    await loginAs(owner.id);
    freshBuckets();
    const badTz = await createRoomRoute(
      req("/api/opportunities/hiring-rooms", "POST", { invitationId: invitation.id, candidateTimezone: "Mars/Olympus_Mons" })
    );
    expect(badTz.status).toBe(400);
    expect(((await resBody(badTz)) as Record<string, unknown>).code).toBe("OX_ROOM_INVALID_TIMEZONE");

    // Strict body: unknown keys refused.
    freshBuckets();
    const strict = await createRoomRoute(
      req("/api/opportunities/hiring-rooms", "POST", { invitationId: invitation.id, organizationId: org.id })
    );
    expect(strict.status).toBe(400);
  });

  test("room-create burst budget: 10/h then 429 (rate-limit pin)", async () => {
    const { owner, org, candidate } = await makeRoomFixture();
    await loginAs(owner.id);
    // One real creation + duplicate attempts all draw from the same
    // ox:room-create bucket; blocked requests do not consume budget.
    const opp2 = await makeOpportunity(org.id, owner.id);
    const invitation2 = await makeAcceptedInvitation({
      organizationId: org.id,
      opportunityId: opp2.id,
      candidateUserId: candidate.id,
      createdByUserId: owner.id,
    });
    freshBuckets();
    const first = await createRoomRoute(req("/api/opportunities/hiring-rooms", "POST", { invitationId: invitation2.id }));
    expect(first.status).toBe(201);
    const firstRoomId = ((await resBody(first)) as { room: { id: string } }).room.id;
    suiteRoomIds.push(firstRoomId);
    // The next 9 duplicate attempts draw from the SAME bucket (no resets).
    for (let i = 0; i < 9; i++) {
      const dup = await createRoomRoute(req("/api/opportunities/hiring-rooms", "POST", { invitationId: invitation2.id }));
      expect(dup.status).toBe(409); // RD-1 duplicate — still consumes budget
    }
    // 10 allowed requests consumed → the 11th is the honest 429.
    const over = await createRoomRoute(req("/api/opportunities/hiring-rooms", "POST", { invitationId: invitation2.id }));
    expect(over.status).toBe(429);
  });
});

describe("M-O7 hiring rooms — party-aware list & detail (RD-5/RD-6/RD-11/RD-15)", () => {
  test("employer list: compensation on, RD-21 status/opportunity filters, invalid status 400", async () => {
    const { owner, org, candidate, invitation } = await makeRoomFixture();
    const opp2 = await makeOpportunity(org.id, owner.id);
    const invitation2 = await makeAcceptedInvitation({
      organizationId: org.id,
      opportunityId: opp2.id,
      candidateUserId: candidate.id,
      createdByUserId: owner.id,
    });
    const roomB = await createRoomForInvitation({ actorUserId: owner.id, invitationId: invitation2.id });
    suiteRoomIds.push(roomB);
    await db.hiringRoom.update({ where: { id: roomB }, data: { status: "ON_HOLD", pausedAt: new Date() } });

    await loginAs(owner.id);
    freshBuckets();
    const all = (await resBody(
      await listRoomsRoute(req(`/api/opportunities/hiring-rooms?organizationId=${org.id}`, "GET"))
    )) as { rooms: { id: string; compensation: unknown }[] };
    const roomA = await db.hiringRoom.findUniqueOrThrow({ where: { invitationId: invitation.id } });
    const ids = all.rooms.map((r) => r.id);
    expect(ids).toContain(roomA.id);
    expect(ids).toContain(roomB);
    expect(all.rooms.every((r) => r.compensation)).toBe(true);

    freshBuckets();
    const onHold = (await resBody(
      await listRoomsRoute(req(`/api/opportunities/hiring-rooms?organizationId=${org.id}&status=ON_HOLD`, "GET"))
    )) as { rooms: { id: string }[] };
    expect(onHold.rooms.map((r) => r.id)).toEqual([roomB]);

    freshBuckets();
    const byOpp = (await resBody(
      await listRoomsRoute(req(`/api/opportunities/hiring-rooms?organizationId=${org.id}&opportunityId=${opp2.id}`, "GET"))
    )) as { rooms: { id: string }[] };
    expect(byOpp.rooms.map((r) => r.id)).toEqual([roomB]);

    // Invalid status → 400.
    freshBuckets();
    const bad = await listRoomsRoute(req(`/api/opportunities/hiring-rooms?organizationId=${org.id}&status=WAT`, "GET"));
    expect(bad.status).toBe(400);
    expect(((await resBody(bad)) as Record<string, unknown>).code).toBe("OX_ROOM_INVALID_QUERY");

    // Non-member → 404; unknown org → 404.
    const outsider = await makeUser("Room Route Outsider");
    await loginAs(outsider.id);
    freshBuckets();
    expect((await listRoomsRoute(req(`/api/opportunities/hiring-rooms?organizationId=${org.id}`, "GET"))).status).toBe(404);
    freshBuckets();
    expect((await listRoomsRoute(req("/api/opportunities/hiring-rooms?organizationId=nope", "GET"))).status).toBe(404);
  });

  test("employer detail: compensation, members, interviews, activity; employer-private note visible (RD-11/RD-16/RD-22)", async () => {
    const { owner, org, roomId } = await makeRoomFixture();
    await loginAs(owner.id);
    freshBuckets();
    const moved = await stageRoute(
      req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "SCREENING", note: `${NOTE_MARKER} screen done` }),
      { params: Promise.resolve({ roomId }) }
    );
    expect(moved.status).toBe(200);

    freshBuckets();
    const detail = (await resBody(await roomDetailRoute(req(`/api/opportunities/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) }))) as {
      room: {
        id: string;
        organizationId: string;
        compensation: Record<string, unknown>;
        currentStage: string;
        stageHistory: { stage: string; note: string | null }[];
        members?: unknown[];
        interviews?: unknown[];
      };
      activity: { events: { label: string }[] };
    };
    expect(detail.room.id).toBe(roomId);
    expect(detail.room.organizationId).toBe(org.id);
    expect(detail.room.compensation.currency).toBe("INR");
    expect(detail.room.currentStage).toBe("SCREENING");
    const screening = detail.room.stageHistory.find((s) => s.stage === "SCREENING");
    expect(screening!.note).toContain(NOTE_MARKER); // employer audience sees the note
    expect(detail.room.stageHistory[0].stage).toBe("INVITATION_ACCEPTED");
    expect(detail.room.members).toEqual([]); // loaded, empty
    expect(detail.room.interviews).toEqual([]);
    expect(detail.activity.events.length).toBeGreaterThanOrEqual(2);
    expect(detail.activity.events.some((e) => e.label === "stage:SCREENING")).toBe(true);

    // Candidate list stays untouched by the employer-private note (sanity):
    expect(await db.hiringStageEvent.count({ where: { roomId, note: { contains: NOTE_MARKER } } })).toBe(1);
  });

  test("org VIEWER list + detail: read-only allowlist with ZERO compensation/notes/links keys (RD-6 + clarification A)", async () => {
    const { owner, org, roomId } = await makeRoomFixture();
    await loginAs(owner.id);
    freshBuckets();
    await stageRoute(
      req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "SCREENING", note: `${NOTE_MARKER} hidden from viewers` }),
      { params: Promise.resolve({ roomId }) }
    );
    const viewer = await makeOrgMember(org.id, "VIEWER");

    await loginAs(viewer.id);
    freshBuckets();
    const vDetail = await roomDetailRoute(req(`/api/opportunities/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) });
    expect(vDetail.status).toBe(200);
    const vBody = JSON.stringify(await resBody(vDetail));
    // Explicit-allowlist scan: no compensation snapshot, no private note,
    // no meeting links, no member rows, no candidate identity column.
    expect(vBody).not.toContain("compensation");
    expect(vBody).not.toContain(NOTE_MARKER);
    expect(vBody).not.toContain("meetingLink");
    expect(vBody).not.toContain("Paise");
    expect(vBody).not.toContain("salaryMinPaise");
    expect(vBody).not.toContain("members");
    expect(vBody).not.toContain("candidateUserId");
    expect(vBody).toContain("candidateDisplayName"); // frozen identity only
    expect(vBody).toContain("stage:SCREENING"); // activity labels are vocabulary-safe

    freshBuckets();
    const vList = await listRoomsRoute(req(`/api/opportunities/hiring-rooms?organizationId=${org.id}`, "GET"));
    expect(vList.status).toBe(200);
    const vListBody = JSON.stringify(await resBody(vList));
    expect(vListBody).not.toContain("compensation");
    expect(vListBody).not.toContain("meetingLink");
    expect(vListBody).not.toContain(NOTE_MARKER);

    // Zero mutation rights: every employer action is a 404-deny.
    freshBuckets();
    expect((await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "INTERVIEW" }), { params: Promise.resolve({ roomId }) })).status).toBe(404);
    freshBuckets();
    expect((await pauseRoomRoute(req(`/api/opportunities/hiring-rooms/${roomId}/pause`, "POST", {}), { params: Promise.resolve({ roomId }) })).status).toBe(404);
    freshBuckets();
    expect((await assignMemberRoute(req(`/api/opportunities/hiring-rooms/${roomId}/members`, "POST", { userId: viewer.id }), { params: Promise.resolve({ roomId }) })).status).toBe(404);
  });

  test("unassigned HIRING_MANAGER 404-denied on detail/actions and excluded from the list; ASSIGNED manager sees compensation and acts (RD-5)", async () => {
    const { owner, org, roomId } = await makeRoomFixture();
    const unassigned = await makeOrgMember(org.id, "HIRING_MANAGER");
    const assigned = await makeOrgMember(org.id, "HIRING_MANAGER");

    await loginAs(owner.id);
    freshBuckets();
    const member = await assignMemberRoute(req(`/api/opportunities/hiring-rooms/${roomId}/members`, "POST", { userId: assigned.id }), { params: Promise.resolve({ roomId }) });
    expect(member.status).toBe(201);

    // Unassigned manager: per-room 404-deny everywhere.
    await loginAs(unassigned.id);
    freshBuckets();
    expect((await roomDetailRoute(req(`/api/opportunities/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) })).status).toBe(404);
    freshBuckets();
    expect((await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "SCREENING" }), { params: Promise.resolve({ roomId }) })).status).toBe(404);
    freshBuckets();
    const hmList = (await resBody(await listRoomsRoute(req(`/api/opportunities/hiring-rooms?organizationId=${org.id}`, "GET")))) as { rooms: { id: string }[] };
    expect(hmList.rooms.find((r) => r.id === roomId)).toBeUndefined();

    // Assigned manager: employer-style detail WITH compensation + acting rights.
    await loginAs(assigned.id);
    freshBuckets();
    const detail = await roomDetailRoute(req(`/api/opportunities/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) });
    expect(detail.status).toBe(200);
    const dBody = JSON.stringify(await resBody(detail));
    expect(dBody).toContain("compensation");
    expect(dBody).toContain("HIRING_MANAGER");

    freshBuckets();
    const moved = await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "INITIAL_REVIEW" }), { params: Promise.resolve({ roomId }) });
    expect(moved.status).toBe(200);
    freshBuckets();
    const paused = await pauseRoomRoute(req(`/api/opportunities/hiring-rooms/${roomId}/pause`, "POST", {}), { params: Promise.resolve({ roomId }) });
    expect(paused.status).toBe(200);
    expect(((await resBody(paused)) as { room: { status: string } }).room.status).toBe("ON_HOLD");
    freshBuckets();
    const resumed = await resumeRoomRoute(req(`/api/opportunities/hiring-rooms/${roomId}/resume`, "POST", {}), { params: Promise.resolve({ roomId }) });
    expect(resumed.status).toBe(200);
    expect(((await resBody(resumed)) as { room: { status: string } }).room.status).toBe("ACTIVE");

    // Manager power limits: no member management, no room cancellation.
    freshBuckets();
    expect((await assignMemberRoute(req(`/api/opportunities/hiring-rooms/${roomId}/members`, "POST", { userId: unassigned.id }), { params: Promise.resolve({ roomId }) })).status).toBe(404);
    freshBuckets();
    expect((await cancelRoomRoute(req(`/api/opportunities/hiring-rooms/${roomId}/cancel`, "POST", { reason: "DUPLICATE" }), { params: Promise.resolve({ roomId }) })).status).toBe(404);
    expect((await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } })).status).toBe("ACTIVE");
  });

  test("unrelated user 404; candidate through the employer namespace gets the candidate shape (codes visible, note absent, link when live)", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    const stranger = await makeUser("Room Route Stranger");
    await loginAs(owner.id);
    freshBuckets();
    await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "SCREENING", note: `${NOTE_MARKER} private` }), { params: Promise.resolve({ roomId }) });

    await loginAs(stranger.id);
    freshBuckets();
    expect((await roomDetailRoute(req(`/api/opportunities/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) })).status).toBe(404);

    // Candidate via the EMPLOYER namespace: one shared resource.
    await loginAs(candidate.id);
    freshBuckets();
    const cDetail = await roomDetailRoute(req(`/api/opportunities/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) });
    expect(cDetail.status).toBe(200);
    const cBody = JSON.stringify(await resBody(cDetail));
    expect(cBody).toContain("SCREENING");
    expect(cBody).not.toContain(NOTE_MARKER); // note never reaches the candidate
    expect(cBody).not.toContain("compensation"); // the room never re-exposes money
    expect(cBody).not.toContain("members");
  });
});

describe("M-O7 hiring rooms — stage machine through the route (RD-8..RD-11)", () => {
  test("forward transition: room updated, append-only event, audit, exactly one candidate stage notification", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    await loginAs(owner.id);
    freshBuckets();
    const moved = await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "INITIAL_REVIEW" }), { params: Promise.resolve({ roomId }) });
    expect(moved.status).toBe(200);
    expect(((await resBody(moved)) as { room: { currentStage: string } }).room.currentStage).toBe("INITIAL_REVIEW");

    expect(await db.hiringStageEvent.count({ where: { roomId, stage: "INITIAL_REVIEW" } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "ox.room.stage_advanced", targetId: roomId } })).toBe(1);
    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_ROOM_STAGE", dedupKey: `hiring:room:${roomId}:stage:INITIAL_REVIEW` } })).toBe(1);

    // Same stage again → backward/zero-progress refusal with zero writes.
    freshBuckets();
    const again = await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "INVITATION_ACCEPTED" }), { params: Promise.resolve({ roomId }) });
    expect(again.status).toBe(409);
    expect(((await resBody(again)) as Record<string, unknown>).code).toBe("OX_STAGE_INVALID_TRANSITION");
    expect(await db.hiringStageEvent.count({ where: { roomId } })).toBe(2); // initial + INITIAL_REVIEW only
  });

  test("backward/unknown/WITHDRAWN refused 409; REJECTED without reason 400; oversized note 400 — zero writes (RD-10/RD-11)", async () => {
    const { owner, roomId } = await makeRoomFixture();
    await loginAs(owner.id);
    freshBuckets();
    await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "SCREENING" }), { params: Promise.resolve({ roomId }) });

    freshBuckets();
    const back = await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "INITIAL_REVIEW" }), { params: Promise.resolve({ roomId }) });
    expect(back.status).toBe(409);
    expect(((await resBody(back)) as Record<string, unknown>).code).toBe("OX_STAGE_INVALID_TRANSITION");

    freshBuckets();
    const unknownStage = await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "WAT" }), { params: Promise.resolve({ roomId }) });
    expect(unknownStage.status).toBe(409);
    expect(((await resBody(unknownStage)) as Record<string, unknown>).code).toBe("OX_STAGE_INVALID_TRANSITION");

    freshBuckets();
    const withdrawnByEmployer = await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "WITHDRAWN" }), { params: Promise.resolve({ roomId }) });
    expect(withdrawnByEmployer.status).toBe(409);

    freshBuckets();
    const rejectedNoReason = await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "REJECTED" }), { params: Promise.resolve({ roomId }) });
    expect(rejectedNoReason.status).toBe(400);
    expect(((await resBody(rejectedNoReason)) as Record<string, unknown>).code).toBe("OX_ROOM_INVALID_REASON");

    freshBuckets();
    const badReason = await stageRoute(
      req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "REJECTED", reason: "JUST_BECAUSE" }),
      { params: Promise.resolve({ roomId }) }
    );
    expect(badReason.status).toBe(400);
    expect(((await resBody(badReason)) as Record<string, unknown>).code).toBe("OX_ROOM_INVALID_REASON");

    freshBuckets();
    const longNote = await stageRoute(
      req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "INTERVIEW", note: "x".repeat(501) }),
      { params: Promise.resolve({ roomId }) }
    );
    expect(longNote.status).toBe(400);

    // Zero writes for every refusal above.
    expect(await db.hiringStageEvent.count({ where: { roomId } })).toBe(2);
    expect((await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } })).currentStage).toBe("SCREENING");
  });

  test("REJECTED closes the room atomically: outcome + reason, ONE closure notification, ZERO stage notification for the terminal stage (RD-8, clarification C)", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    await loginAs(owner.id);
    freshBuckets();
    const rejected = await stageRoute(
      req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "REJECTED", reason: "NOT_A_FIT", note: `${NOTE_MARKER} final` }),
      { params: Promise.resolve({ roomId }) }
    );
    expect(rejected.status).toBe(200);
    const room = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.status).toBe("CLOSED");
    expect(room.closedOutcome).toBe("REJECTED");
    expect(room.closedReason).toBe("NOT_A_FIT");
    expect(room.closedAt).not.toBeNull();

    expect(await db.hiringStageEvent.count({ where: { roomId, stage: "REJECTED" } })).toBe(1);
    // Clarification C: exactly one candidate closure notification, no stage row.
    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_ROOM_CLOSED", dedupKey: `hiring:room:${roomId}:closed` } })).toBe(1);
    expect(await db.notification.count({ where: { type: "HIRING_ROOM_STAGE", dedupKey: `hiring:room:${roomId}:stage:REJECTED` } })).toBe(0);

    // Closed rooms never reopen; candidate still reads the honest history.
    freshBuckets();
    expect((await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "OFFER" }), { params: Promise.resolve({ roomId }) })).status).toBe(409);
    await loginAs(candidate.id);
    freshBuckets();
    const cDetail = (await resBody(await meRoomDetailRoute(req(`/api/opportunities/me/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) }))) as {
      room: { status: string; closure: { outcome: string | null; reason: string | null }; stageHistory: { stage: string; reason: string | null }[] };
    };
    expect(cDetail.room.status).toBe("CLOSED");
    expect(cDetail.room.closure.outcome).toBe("REJECTED");
    expect(cDetail.room.closure.reason).toBe("NOT_A_FIT"); // reason CODE visible
    expect(JSON.stringify(cDetail)).not.toContain(NOTE_MARKER); // note absent
    expect(JSON.stringify(cDetail)).not.toContain('"note"');
  });

  test("HIRED from OFFER closes the room; exactly one HIRING_ROOM_CLOSED and zero HIRING_ROOM_STAGE rows for the terminal stage (RD-8/RD-9, clarification C)", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    await loginAs(owner.id);
    freshBuckets();
    const offer = await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "OFFER" }), { params: Promise.resolve({ roomId }) });
    expect(offer.status).toBe(200); // forward skip INVITATION_ACCEPTED → OFFER
    freshBuckets();
    const hired = await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "HIRED" }), { params: Promise.resolve({ roomId }) });
    expect(hired.status).toBe(200);
    const room = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.status).toBe("CLOSED");
    expect(room.closedOutcome).toBe("HIRED");
    expect(room.currentStage).toBe("HIRED");

    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_ROOM_CLOSED", dedupKey: `hiring:room:${roomId}:closed` } })).toBe(1);
    expect(await db.notification.count({ where: { type: "HIRING_ROOM_STAGE", dedupKey: `hiring:room:${roomId}:stage:HIRED` } })).toBe(0);
    expect(await db.hiringStageEvent.count({ where: { roomId, stage: "HIRED" } })).toBe(1);
  });

  test("stage while ON_HOLD → 409 OX_ROOM_NOT_ACTIONABLE; pause/resume cycle by the owner (RD-2)", async () => {
    const { owner, roomId } = await makeRoomFixture();
    await loginAs(owner.id);
    freshBuckets();
    const paused = await pauseRoomRoute(req(`/api/opportunities/hiring-rooms/${roomId}/pause`, "POST", {}), { params: Promise.resolve({ roomId }) });
    expect(paused.status).toBe(200);
    freshBuckets();
    const held = await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "SCREENING" }), { params: Promise.resolve({ roomId }) });
    expect(held.status).toBe(409);
    expect(((await resBody(held)) as Record<string, unknown>).code).toBe("OX_ROOM_NOT_ACTIONABLE");
    // Double pause → 409 (already ON_HOLD).
    freshBuckets();
    expect((await pauseRoomRoute(req(`/api/opportunities/hiring-rooms/${roomId}/pause`, "POST", {}), { params: Promise.resolve({ roomId }) })).status).toBe(409);
    freshBuckets();
    const resumed = await resumeRoomRoute(req(`/api/opportunities/hiring-rooms/${roomId}/resume`, "POST", {}), { params: Promise.resolve({ roomId }) });
    expect(resumed.status).toBe(200);
    freshBuckets();
    const after = await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "SCREENING" }), { params: Promise.resolve({ roomId }) });
    expect(after.status).toBe(200);
  });

  test("outcome-less closure: reason-vocabulary enforced; CANCELLED terminal, never reopens (RD-2/RD-8/RD-11)", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    await loginAs(owner.id);
    freshBuckets();
    const bad = await cancelRoomRoute(req(`/api/opportunities/hiring-rooms/${roomId}/cancel`, "POST", { reason: "JUST_BECAUSE" }), { params: Promise.resolve({ roomId }) });
    expect(bad.status).toBe(400);
    expect(((await resBody(bad)) as Record<string, unknown>).code).toBe("OX_ROOM_INVALID_REASON");
    freshBuckets();
    const ok = await cancelRoomRoute(req(`/api/opportunities/hiring-rooms/${roomId}/cancel`, "POST", { reason: "REQUISITION_CANCELLED" }), { params: Promise.resolve({ roomId }) });
    expect(ok.status).toBe(200);
    const room = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.status).toBe("CANCELLED");
    expect(room.closedReason).toBe("REQUISITION_CANCELLED");
    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_ROOM_CLOSED", dedupKey: `hiring:room:${roomId}:closed` } })).toBe(1);
    freshBuckets();
    expect((await cancelRoomRoute(req(`/api/opportunities/hiring-rooms/${roomId}/cancel`, "POST", { reason: "DUPLICATE" }), { params: Promise.resolve({ roomId }) })).status).toBe(409);
  });
});

describe("M-O7 hiring rooms — room-scoped membership through routes (RD-4/RD-5)", () => {
  test("assign happy (notification + audit); VIEWER and non-member targets 409 OX_MEMBER_NOT_ACTIVE", async () => {
    const { owner, org, roomId } = await makeRoomFixture();
    const manager = await makeOrgMember(org.id, "HIRING_MANAGER");
    const viewer = await makeOrgMember(org.id, "VIEWER");
    const ghost = await makeUser("Room Route Ghost Member");

    await loginAs(owner.id);
    freshBuckets();
    const badViewer = await assignMemberRoute(req(`/api/opportunities/hiring-rooms/${roomId}/members`, "POST", { userId: viewer.id }), { params: Promise.resolve({ roomId }) });
    expect(badViewer.status).toBe(409);
    expect(((await resBody(badViewer)) as Record<string, unknown>).code).toBe("OX_MEMBER_NOT_ACTIVE");

    freshBuckets();
    const ghostTarget = await assignMemberRoute(req(`/api/opportunities/hiring-rooms/${roomId}/members`, "POST", { userId: ghost.id }), { params: Promise.resolve({ roomId }) });
    expect(ghostTarget.status).toBe(409);
    expect(((await resBody(ghostTarget)) as Record<string, unknown>).code).toBe("OX_MEMBER_NOT_ACTIVE");

    freshBuckets();
    const ok = await assignMemberRoute(req(`/api/opportunities/hiring-rooms/${roomId}/members`, "POST", { userId: manager.id }), { params: Promise.resolve({ roomId }) });
    expect(ok.status).toBe(201);
    const body = (await resBody(ok)) as { member: { id: string; userId: string; roomRole: string; removedAt: string | null } };
    expect(body.member.userId).toBe(manager.id);
    expect(body.member.roomRole).toBe("HIRING_MANAGER");
    expect(body.member.removedAt).toBeNull();
    expect(await db.hiringRoomMember.count({ where: { id: body.member.id, roomId } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "ox.room.member_assigned", targetId: roomId } })).toBe(1);
    expect(await db.notification.count({ where: { userId: manager.id, type: "HIRING_ROOM_MEMBER", dedupKey: `hiring:room:${roomId}:member:${body.member.id}:assigned` } })).toBe(1);
  });

  test("soft removal: row kept with removedAt stamped + audit; the removed manager immediately loses access (RD-4/RD-5)", async () => {
    const { owner, org, roomId } = await makeRoomFixture();
    const manager = await makeOrgMember(org.id, "HIRING_MANAGER");
    await loginAs(owner.id);
    freshBuckets();
    const assigned = (await resBody(
      await assignMemberRoute(req(`/api/opportunities/hiring-rooms/${roomId}/members`, "POST", { userId: manager.id }), { params: Promise.resolve({ roomId }) })
    )) as { member: { id: string } };
    const memberId = assigned.member.id;

    freshBuckets();
    const removed = await removeMemberRoute(req(`/api/opportunities/hiring-rooms/${roomId}/members/${memberId}`, "DELETE"), { params: Promise.resolve({ roomId, memberId }) });
    expect(removed.status).toBe(200);
    const body = (await resBody(removed)) as { member: { removedAt: string | null } };
    expect(body.member.removedAt).not.toBeNull();
    // Soft removal: the row still exists, never deleted.
    expect(await db.hiringRoomMember.count({ where: { id: memberId } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "ox.room.member_removed", targetId: roomId } })).toBe(1);
    expect(await db.notification.count({ where: { userId: manager.id, type: "HIRING_ROOM_MEMBER", dedupKey: `hiring:room:${roomId}:member:${memberId}:removed` } })).toBe(1);

    // The unassigned manager is 404-denied on detail and action routes.
    await loginAs(manager.id);
    freshBuckets();
    expect((await roomDetailRoute(req(`/api/opportunities/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) })).status).toBe(404);
    freshBuckets();
    expect((await stageRoute(req(`/api/opportunities/hiring-rooms/${roomId}/stages`, "POST", { stage: "SCREENING" }), { params: Promise.resolve({ roomId }) })).status).toBe(404);

    // Removing again (already soft-removed) → 404; unknown member → 404.
    await loginAs(owner.id);
    freshBuckets();
    expect((await removeMemberRoute(req(`/api/opportunities/hiring-rooms/${roomId}/members/${memberId}`, "DELETE"), { params: Promise.resolve({ roomId, memberId }) })).status).toBe(404);
    freshBuckets();
    expect((await removeMemberRoute(req(`/api/opportunities/hiring-rooms/${roomId}/members/ghost`, "DELETE"), { params: Promise.resolve({ roomId, memberId: "ghost" }) })).status).toBe(404);
  });
});

describe("M-O7 hiring rooms — interview protocol through routes (RD-12/RD-13/RD-15)", () => {
  test("propose happy: PROPOSED row, audit, both-side notifications once; candidate propose is a 404-deny", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    const proposed = await proposeViaRoute(roomId, owner);
    expect(proposed.status).toBe(201);
    const body = (await resBody(proposed)) as { interview: { id: string; status: string; proposedByRole: string; type: string } };
    expect(body.interview.status).toBe("PROPOSED");
    expect(body.interview.proposedByRole).toBe("EMPLOYER");
    expect(body.interview.type).toBe("VIDEO");
    const interviewId = body.interview.id;

    expect(await db.interview.count({ where: { id: interviewId, roomId, status: "PROPOSED" } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "ox.interview.proposed", targetId: interviewId } })).toBe(1);
    // The candidate holds the pinned dedup key; the actor (owner) never
    // self-notifies — exactly one notification row for this event.
    expect(await db.notification.count({ where: { type: "HIRING_INTERVIEW", dedupKey: `hiring:room:${roomId}:interview:${interviewId}:proposed` } })).toBe(1);
    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_INTERVIEW", dedupKey: `hiring:room:${roomId}:interview:${interviewId}:proposed` } })).toBe(1);

    // Candidate proposing is a 404-deny (employer-side operation, RD-12).
    await loginAs(candidate.id);
    freshBuckets();
    const window = futureWindow();
    const candidatePropose = await proposeInterviewRoute(
      req(`/api/opportunities/hiring-rooms/${roomId}/interviews`, "POST", { type: "PHONE_SCREEN", startsAt: window.startsAt, endsAt: window.endsAt }),
      { params: Promise.resolve({ roomId }) }
    );
    expect(candidatePropose.status).toBe(404);
  });

  test("window validation (RD-13): past start, zero/negative span, too short, too long → 400 OX_INTERVIEW_INVALID_WINDOW", async () => {
    const { owner, roomId } = await makeRoomFixture();
    const cases: { label: string; minutes: number; offset: number }[] = [
      { label: "past start", minutes: 60, offset: -30 },
      { label: "ends before it starts", minutes: 0, offset: 120 },
      { label: "too short", minutes: 5, offset: 120 },
      { label: "too long", minutes: 300, offset: 120 },
    ];
    for (const c of cases) {
      await loginAs(owner.id);
      freshBuckets();
      const window = futureWindow(c.minutes, c.offset);
      const res = await proposeInterviewRoute(
        req(`/api/opportunities/hiring-rooms/${roomId}/interviews`, "POST", { type: "VIDEO", startsAt: window.startsAt, endsAt: window.endsAt }),
        { params: Promise.resolve({ roomId }) }
      );
      expect(res.status).toBe(400);
      expect(((await resBody(res)) as Record<string, unknown>).code).toBe("OX_INTERVIEW_INVALID_WINDOW");
    }
    expect(await db.interview.count({ where: { roomId } })).toBe(0); // zero writes
  });

  test("meetingLink boundary (RD-15): http:// and >500 chars refused with 400; valid https accepted", async () => {
    const { owner, roomId } = await makeRoomFixture();
    await loginAs(owner.id);
    freshBuckets();
    const http = await proposeViaRoute(roomId, owner, "VIDEO", "http://meet.example.com/room");
    expect(http.status).toBe(400);
    freshBuckets();
    const long = await proposeViaRoute(roomId, owner, "VIDEO", `https://${"a".repeat(600)}.com/x`);
    expect(long.status).toBe(400);
    expect(await db.interview.count({ where: { roomId } })).toBe(0);
    freshBuckets();
    const ok = await proposeViaRoute(roomId, owner, "VIDEO", `https://${MEET_HOST}/accepted`);
    expect(ok.status).toBe(201);
  });

  test("confirmation right (RD-12): the proposer's own confirm is 409; the candidate confirms → CONFIRMED", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    const proposed = (await resBody(await proposeViaRoute(roomId, owner))) as { interview: { id: string } };
    const interviewId = proposed.interview.id;

    await loginAs(owner.id);
    freshBuckets();
    const own = await confirmInterviewRoute(req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/confirm`, "POST", {}), { params: Promise.resolve({ roomId, interviewId }) });
    expect(own.status).toBe(409);
    expect(((await resBody(own)) as Record<string, unknown>).code).toBe("OX_INTERVIEW_NOT_ACTIONABLE");

    await loginAs(candidate.id);
    freshBuckets();
    const confirmed = await confirmInterviewRoute(req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/confirm`, "POST", {}), { params: Promise.resolve({ roomId, interviewId }) });
    expect(confirmed.status).toBe(200);
    expect(((await resBody(confirmed)) as { interview: { status: string } }).interview.status).toBe("CONFIRMED");
    const audit = await db.auditEvent.findFirst({ where: { action: "ox.interview.confirmed", targetId: interviewId } });
    expect((JSON.parse(audit!.meta) as { confirmedByRole: string }).confirmedByRole).toBe("CANDIDATE");
    // Double confirm → 409 (no longer PROPOSED).
    freshBuckets();
    expect((await confirmInterviewRoute(req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/confirm`, "POST", {}), { params: Promise.resolve({ roomId, interviewId }) })).status).toBe(409);
  });

  test("alternate slot flips proposedByRole and moves the confirmation right to the original proposer (RD-12)", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    const proposed = (await resBody(await proposeViaRoute(roomId, owner))) as { interview: { id: string } };
    const interviewId = proposed.interview.id;

    await loginAs(candidate.id);
    freshBuckets();
    const window = futureWindow(45, 240);
    const flipped = await alternateInterviewRoute(
      req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/alternate`, "POST", { startsAt: window.startsAt, endsAt: window.endsAt }),
      { params: Promise.resolve({ roomId, interviewId }) }
    );
    expect(flipped.status).toBe(200);
    const body = (await resBody(flipped)) as { interview: { status: string; proposedByRole: string; startsAt: string } };
    expect(body.interview.status).toBe("PROPOSED");
    expect(body.interview.proposedByRole).toBe("CANDIDATE");
    expect(body.interview.startsAt).toBe(window.startsAt);
    expect(await db.auditEvent.count({ where: { action: "ox.interview.alternate", targetId: interviewId } })).toBe(1);

    // The candidate is now the proposer of the standing times — countering
    // again is refused (only the non-proposing party counters, RD-12).
    await loginAs(candidate.id);
    freshBuckets();
    const ownAlternate = await alternateInterviewRoute(
      req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/alternate`, "POST", { startsAt: window.startsAt, endsAt: window.endsAt }),
      { params: Promise.resolve({ roomId, interviewId }) }
    );
    expect(ownAlternate.status).toBe(409);
    expect(((await resBody(ownAlternate)) as Record<string, unknown>).code).toBe("OX_INTERVIEW_NOT_ACTIONABLE");

    // The flipped confirmation right now belongs to the employer.
    await loginAs(owner.id);
    freshBuckets();
    const confirmed = await confirmInterviewRoute(req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/confirm`, "POST", {}), { params: Promise.resolve({ roomId, interviewId }) });
    expect(confirmed.status).toBe(200);
    expect(((await resBody(confirmed)) as { interview: { status: string } }).interview.status).toBe("CONFIRMED");
  });

  test("reschedule CONFIRMED → PROPOSED under the rescheduler's role; complete CONFIRMED → COMPLETED by the employer only (RD-12)", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    const proposed = (await resBody(await proposeViaRoute(roomId, owner))) as { interview: { id: string } };
    const interviewId = proposed.interview.id;

    await loginAs(candidate.id);
    freshBuckets();
    expect((await confirmInterviewRoute(req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/confirm`, "POST", {}), { params: Promise.resolve({ roomId, interviewId }) })).status).toBe(200);

    // Reschedule by the employer → PROPOSED, proposedByRole EMPLOYER.
    await loginAs(owner.id);
    freshBuckets();
    const window = futureWindow(30, 300);
    const rescheduled = await rescheduleInterviewRoute(
      req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/reschedule`, "POST", { startsAt: window.startsAt, endsAt: window.endsAt }),
      { params: Promise.resolve({ roomId, interviewId }) }
    );
    expect(rescheduled.status).toBe(200);
    const body = (await resBody(rescheduled)) as { interview: { status: string; proposedByRole: string } };
    expect(body.interview.status).toBe("PROPOSED");
    expect(body.interview.proposedByRole).toBe("EMPLOYER");
    expect(await db.auditEvent.count({ where: { action: "ox.interview.rescheduled", targetId: interviewId } })).toBe(1);

    // Complete from PROPOSED → 409; candidate complete → 404-deny.
    freshBuckets();
    expect((await completeInterviewRoute(req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/complete`, "POST", {}), { params: Promise.resolve({ roomId, interviewId }) })).status).toBe(409);
    await loginAs(candidate.id);
    freshBuckets();
    expect((await completeInterviewRoute(req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/complete`, "POST", {}), { params: Promise.resolve({ roomId, interviewId }) })).status).toBe(404);

    // Candidate re-confirms, then the employer completes.
    freshBuckets();
    expect((await confirmInterviewRoute(req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/confirm`, "POST", {}), { params: Promise.resolve({ roomId, interviewId }) })).status).toBe(200);
    await loginAs(owner.id);
    freshBuckets();
    const completed = await completeInterviewRoute(req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/complete`, "POST", {}), { params: Promise.resolve({ roomId, interviewId }) });
    expect(completed.status).toBe(200);
    const done = (await resBody(completed)) as { interview: { status: string; completedAt: string | null } };
    expect(done.interview.status).toBe("COMPLETED");
    expect(done.interview.completedAt).not.toBeNull();
    expect(await db.auditEvent.count({ where: { action: "ox.interview.completed", targetId: interviewId } })).toBe(1);
  });

  test("interview cancellation: reason vocabulary enforced (400 OX_ROOM_INVALID_REASON), vocab reason cancels with audit (RD-11/RD-12)", async () => {
    const { owner, roomId } = await makeRoomFixture();
    const proposed = (await resBody(await proposeViaRoute(roomId, owner))) as { interview: { id: string } };
    const interviewId = proposed.interview.id;

    await loginAs(owner.id);
    freshBuckets();
    const bad = await cancelInterviewRoute(
      req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/cancel`, "POST", { reason: "JUST_BECAUSE" }),
      { params: Promise.resolve({ roomId, interviewId }) }
    );
    expect(bad.status).toBe(400);
    expect(((await resBody(bad)) as Record<string, unknown>).code).toBe("OX_ROOM_INVALID_REASON");
    expect((await db.interview.findUniqueOrThrow({ where: { id: interviewId } })).status).toBe("PROPOSED");

    freshBuckets();
    const ok = await cancelInterviewRoute(
      req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/cancel`, "POST", { reason: "SCHEDULING_CONFLICT" }),
      { params: Promise.resolve({ roomId, interviewId }) }
    );
    expect(ok.status).toBe(200);
    const body = (await resBody(ok)) as { interview: { status: string; cancelReason: string | null } };
    expect(body.interview.status).toBe("CANCELLED");
    expect(body.interview.cancelReason).toBe("SCHEDULING_CONFLICT");
    const audit = await db.auditEvent.findFirst({ where: { action: "ox.interview.cancelled", targetId: interviewId } });
    expect((JSON.parse(audit!.meta) as { cancelReason: string }).cancelReason).toBe("SCHEDULING_CONFLICT");
  });

  test("meetingLink visibility (RD-15): employer+candidate see it while PROPOSED/CONFIRMED; ABSENT (null) after cancel AND complete for BOTH; me-list never carries links", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    const linkA = `https://${MEET_HOST}/live-${randomUUID().slice(0, 8)}`;

    // PROPOSED with a stored link (seeded — see the lib-defect report).
    const first = (await resBody(await proposeViaRoute(roomId, owner, "VIDEO"))) as { interview: { id: string } };
    const ivA = first.interview.id;
    await db.interview.update({ where: { id: ivA }, data: { meetingLink: linkA } });

    await loginAs(owner.id);
    freshBuckets();
    const employerDetail = (await resBody(await roomDetailRoute(req(`/api/opportunities/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) }))) as {
      room: { interviews: { id: string; meetingLink: string | null }[] };
    };
    expect(employerDetail.room.interviews.find((i) => i.id === ivA)!.meetingLink).toBe(linkA);

    await loginAs(candidate.id);
    freshBuckets();
    const cDetail = (await resBody(await meRoomDetailRoute(req(`/api/opportunities/me/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) }))) as {
      room: { interviews: { id: string; meetingLink: string | null }[] };
    };
    expect(cDetail.room.interviews.find((i) => i.id === ivA)!.meetingLink).toBe(linkA);
    freshBuckets();
    expect(JSON.stringify(await resBody(await meRoomsRoute(req("/api/opportunities/me/hiring-rooms", "GET"))))).not.toContain("meetingLink");

    // Candidate cancels → the link is withheld from BOTH audiences.
    freshBuckets();
    expect(
      (await cancelInterviewRoute(req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${ivA}/cancel`, "POST", { reason: "UNAVAILABLE" }), { params: Promise.resolve({ roomId, interviewId: ivA }) })).status
    ).toBe(200);
    await loginAs(owner.id);
    freshBuckets();
    const afterCancelEmployer = (await resBody(await roomDetailRoute(req(`/api/opportunities/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) }))) as {
      room: { interviews: { id: string; meetingLink: string | null }[] };
    };
    expect(afterCancelEmployer.room.interviews.find((i) => i.id === ivA)!.meetingLink).toBeNull();
    await loginAs(candidate.id);
    freshBuckets();
    const afterCancelCandidate = (await resBody(await meRoomDetailRoute(req(`/api/opportunities/me/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) }))) as {
      room: { interviews: { id: string; meetingLink: string | null }[] };
    };
    expect(afterCancelCandidate.room.interviews.find((i) => i.id === ivA)!.meetingLink).toBeNull();

    // CONFIRMED → COMPLETED: same withholding on the completed interview.
    const linkB = `https://${MEET_HOST}/done-${randomUUID().slice(0, 8)}`;
    await loginAs(owner.id);
    const second = (await resBody(await proposeViaRoute(roomId, owner, "ONSITE"))) as { interview: { id: string } };
    const ivB = second.interview.id;
    await db.interview.update({ where: { id: ivB }, data: { meetingLink: linkB } });
    await loginAs(candidate.id);
    freshBuckets();
    expect((await confirmInterviewRoute(req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${ivB}/confirm`, "POST", {}), { params: Promise.resolve({ roomId, interviewId: ivB }) })).status).toBe(200);
    await loginAs(candidate.id);
    freshBuckets();
    const confirmedCandidate = (await resBody(await meRoomDetailRoute(req(`/api/opportunities/me/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) }))) as {
      room: { interviews: { id: string; meetingLink: string | null }[] };
    };
    expect(confirmedCandidate.room.interviews.find((i) => i.id === ivB)!.meetingLink).toBe(linkB); // CONFIRMED still live
    await loginAs(owner.id);
    freshBuckets();
    expect((await completeInterviewRoute(req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${ivB}/complete`, "POST", {}), { params: Promise.resolve({ roomId, interviewId: ivB }) })).status).toBe(200);
    freshBuckets();
    const afterCompleteEmployer = (await resBody(await roomDetailRoute(req(`/api/opportunities/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) }))) as {
      room: { interviews: { id: string; meetingLink: string | null }[] };
    };
    expect(afterCompleteEmployer.room.interviews.find((i) => i.id === ivB)!.meetingLink).toBeNull();
    await loginAs(candidate.id);
    freshBuckets();
    const afterCompleteCandidate = (await resBody(await meRoomDetailRoute(req(`/api/opportunities/me/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) }))) as {
      room: { interviews: { id: string; meetingLink: string | null }[] };
    };
    expect(afterCompleteCandidate.room.interviews.find((i) => i.id === ivB)!.meetingLink).toBeNull();
  });
});

describe("M-O7 hiring rooms — candidate withdrawal through the route (RD-7)", () => {
  test("candidate-only withdrawal: employer 404; vocabulary enforced; terminal room, WITHDRAWN event, live interviews cancelled with cause audits, employer notification, no closure notification to the candidate", async () => {
    const { owner, candidate, roomId } = await makeRoomFixture();
    const iv = (await resBody(await proposeViaRoute(roomId, owner))) as { interview: { id: string } };
    const interviewId = iv.interview.id;
    await loginAs(candidate.id);
    freshBuckets();
    expect((await confirmInterviewRoute(req(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/confirm`, "POST", {}), { params: Promise.resolve({ roomId, interviewId }) })).status).toBe(200);

    // Employer attempt via the candidate-only route → 404 (party deny).
    await loginAs(owner.id);
    freshBuckets();
    const employerTry = await meWithdrawRoute(req(`/api/opportunities/me/hiring-rooms/${roomId}/withdraw`, "POST", { reason: "TIMING" }), { params: Promise.resolve({ roomId }) });
    expect(employerTry.status).toBe(404);
    expect(((await resBody(employerTry)) as Record<string, unknown>).code).toBe("OX_HIRING_ROOM_NOT_FOUND");

    // Vocabulary enforcement: zero writes.
    await loginAs(candidate.id);
    freshBuckets();
    const bad = await meWithdrawRoute(req(`/api/opportunities/me/hiring-rooms/${roomId}/withdraw`, "POST", { reason: "JUST_BECAUSE" }), { params: Promise.resolve({ roomId }) });
    expect(bad.status).toBe(400);
    expect(((await resBody(bad)) as Record<string, unknown>).code).toBe("OX_ROOM_INVALID_REASON");
    expect((await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } })).status).toBe("ACTIVE");

    // Happy withdrawal.
    freshBuckets();
    const withdrawn = await meWithdrawRoute(req(`/api/opportunities/me/hiring-rooms/${roomId}/withdraw`, "POST", { reason: "TIMING" }), { params: Promise.resolve({ roomId }) });
    expect(withdrawn.status).toBe(200);
    expect(((await resBody(withdrawn)) as { room: { status: string } }).room.status).toBe("CANDIDATE_WITHDRAWN");

    const room = await db.hiringRoom.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.status).toBe("CANDIDATE_WITHDRAWN");
    expect(room.closedAt).not.toBeNull();
    const stageRow = await db.hiringStageEvent.findFirst({ where: { roomId, stage: "WITHDRAWN" } });
    expect(stageRow).not.toBeNull();
    expect(stageRow!.actorRole).toBe("CANDIDATE");
    expect(stageRow!.reason).toBe("TIMING");

    // The CONFIRMED interview was auto-cancelled with zero deletion and the
    // cause on the audit meta (cancelReason stays NULL — RD-7).
    const interview = await db.interview.findUniqueOrThrow({ where: { id: interviewId } });
    expect(interview.status).toBe("CANCELLED");
    expect(interview.cancelReason).toBeNull();
    const causeAudit = await db.auditEvent.findFirst({ where: { action: "ox.interview.cancelled", targetId: interviewId } });
    expect((JSON.parse(causeAudit!.meta) as { cause: string }).cause).toBe("CANDIDATE_WITHDREW");
    expect(await db.auditEvent.count({ where: { action: "ox.room.withdrawn", targetId: roomId } })).toBe(1);

    // Employer team notified; the acting candidate is NOT closure-notified.
    expect(await db.notification.count({ where: { userId: owner.id, type: "HIRING_ROOM_WITHDRAWN", dedupKey: `hiring:room:${roomId}:withdrawn` } })).toBe(1);
    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_ROOM_CLOSED", dedupKey: `hiring:room:${roomId}:closed` } })).toBe(0);

    // Terminal: second withdrawal is 409; the candidate keeps read-only history.
    freshBuckets();
    expect((await meWithdrawRoute(req(`/api/opportunities/me/hiring-rooms/${roomId}/withdraw`, "POST", { reason: "OTHER" }), { params: Promise.resolve({ roomId }) })).status).toBe(409);
    freshBuckets();
    const detail = (await resBody(await meRoomDetailRoute(req(`/api/opportunities/me/hiring-rooms/${roomId}`, "GET"), { params: Promise.resolve({ roomId }) }))) as {
      room: { status: string; stageHistory: { stage: string; reason: string | null }[] };
    };
    expect(detail.room.status).toBe("CANDIDATE_WITHDRAWN");
    expect(detail.room.stageHistory.some((s) => s.stage === "WITHDRAWN" && s.reason === "TIMING")).toBe(true);
  });
});

describe("M-O7 hiring rooms — cross-cutting notification privacy + audit (RD-18/RD-22, clarification C)", () => {
  test("every HIRING_ROOM notification created during the suite is payload-minimal: no paise amounts, no meeting links, no note text", async () => {
    const notes = await db.notification.findMany({
      where: {
        type: { in: ["HIRING_ROOM_CREATED", "HIRING_ROOM_STAGE", "HIRING_INTERVIEW", "HIRING_ROOM_WITHDRAWN", "HIRING_ROOM_CLOSED", "HIRING_ROOM_MEMBER"] },
        createdAt: { gte: suiteStart },
      },
    });
    // The suite exercised every one of the six types at least once.
    expect(notes.length).toBeGreaterThanOrEqual(10);
    expect(new Set(notes.map((n) => n.type)).size).toBe(6);
    for (const note of notes) {
      const serialized = JSON.stringify({ type: note.type, payload: note.payload, dedupKey: note.dedupKey });
      expect(serialized).not.toContain(OFFER_MIN_PAISE);
      expect(serialized).not.toContain(OFFER_MAX_PAISE);
      expect(serialized).not.toContain("110000000");
      expect(serialized).not.toContain("140000000");
      expect(serialized).not.toContain(MEET_HOST);
      expect(serialized).not.toContain(NOTE_MARKER);
    }
  });

  test("audit trail: one ox.room.created per room (targetId = roomId); member_assigned/removed rows present", async () => {
    expect(suiteRoomIds.length).toBeGreaterThanOrEqual(5);
    for (const roomId of suiteRoomIds) {
      const rows = await db.auditEvent.findMany({ where: { action: "ox.room.created", targetId: roomId } });
      expect(rows.length).toBe(1);
      expect(rows[0].targetType).toBe("HIRING_ROOM");
    }
    expect(await db.auditEvent.count({ where: { action: "ox.room.member_assigned" } })).toBeGreaterThanOrEqual(1);
    expect(await db.auditEvent.count({ where: { action: "ox.room.member_removed" } })).toBeGreaterThanOrEqual(1);
  });
});
