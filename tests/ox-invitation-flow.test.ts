import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

/**
 * M-O6 — invitation lifecycle suite (state machine, quotas, cooldown,
 * duplicates, drafts, expiry sweep, races, notifications, audit).
 *
 * Approved decisions RD-4…RD-6, RD-9…RD-12, RD-17, RD-18 + owner override A
 * (one non-terminal invitation per (org, opportunity, candidate), DB-enforced
 * via the activeInvitationToken partial-unique emulation).
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
import type { User } from "@prisma/client";
import { memoryBackend } from "@/lib/rate-limit-backend";
import { hashPassword, createSession } from "@/lib/auth";
import { sweepExpiredInvitations } from "@/lib/ox/invitation";
import { POST as createInvitationRoute, GET as listInvitationsRoute } from "@/app/api/opportunities/invitations/route";
import { GET as invitationDetailRoute, PATCH as patchDraftRoute, DELETE as deleteDraftRoute } from "@/app/api/opportunities/invitations/[invitationId]/route";
import { POST as sendDraftRoute } from "@/app/api/opportunities/invitations/[invitationId]/send/route";
import { POST as withdrawRoute } from "@/app/api/opportunities/invitations/[invitationId]/withdraw/route";
import { POST as employerProposeRoute } from "@/app/api/opportunities/invitations/[invitationId]/negotiations/route";
import { POST as employerAcceptProposalRoute } from "@/app/api/opportunities/invitations/[invitationId]/negotiations/[negotiationId]/accept/route";
import { GET as inboxRoute } from "@/app/api/opportunities/me/invitations/route";
import { GET as candidateDetailRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/route";
import { POST as candidateAcceptRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/accept/route";
import { POST as candidateDeclineRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/decline/route";
import { POST as negotiationRequestRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/negotiation-request/route";
import { POST as candidateCounterRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/negotiations/route";
import { POST as candidateAcceptProposalRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/negotiations/[negotiationId]/accept/route";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

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

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

const PWD = await hashPassword("ox-inv-password-1");

async function makeUser(name: string) {
  return db.user.create({
    data: { email: `ox-inv-${randomUUID()}@beanfolio.test`, passwordHash: PWD, name },
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

async function makeOpportunity(orgId: string, ownerId: string, status = "PUBLISHED") {
  return db.opportunity.create({
    data: {
      organizationId: orgId,
      createdByUserId: ownerId,
      title: "Invitation opportunity",
      description: "An opportunity used to exercise the invitation API in tests.",
      status,
      employmentType: "FULL_TIME",
      workMode: "REMOTE",
      submittedAt: new Date(),
      publishedAt: status === "PUBLISHED" || status === "PAUSED" || status === "FILLED" || status === "CLOSED" ? new Date() : null,
      salaryMinPaise: 500_000_00,
      salaryMaxPaise: 900_000_00,
      salaryCurrency: "INR",
      compensationPeriod: "YEAR",
    },
  });
}

/** A candidate that passes the live discovery boundary AND holds a current
 * eligible TalentMatch pointer for the opportunity (RD-2 source A). */
async function makeEligibleCandidate(name: string, opportunityId: string) {
  const user = await makeUser(name);
  await db.candidateOpportunityProfile.create({
    data: { userId: user.id, visibilityStatus: "ACTIVE", employmentTypes: '["FULL_TIME"]', workModes: '["REMOTE"]' },
  });
  await db.candidateVisibilityConsent.create({
    data: { userId: user.id, scope: "DISCOVERY", status: "GRANTED", consentVersion: "O2-CONSENT-V1", source: "CANDIDATE_UI" },
  });
  await db.talentMatch.create({
    data: {
      opportunityId,
      candidateUserId: user.id,
      matchVersion: "O4-MATCH-V1",
      score: 80,
      eligible: true,
      generatedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    },
  });
  return user;
}

function offerTerms(min = 1_200_000_00, max = 1_500_000_00) {
  return {
    offerSalaryMinPaise: min,
    offerSalaryMaxPaise: max,
    offerCurrency: "INR",
    offerPeriod: "YEAR",
  };
}

/** Create + send an invitation through the API (default RD-17 path). */
async function invite(orgId: string, opportunityId: string, candidateUserId: string, actorUserId: string) {
  await loginAs(actorUserId);
  memoryBackend.resetForTests(); // the burst bucket must not mask quota behavior
  return createInvitationRoute(
    req("/api/opportunities/invitations", "POST", {
      organizationId: orgId,
      opportunityId,
      candidateUserId,
      offer: offerTerms(),
    })
  );
}

describe("M-O6 invitations — lifecycle & state machine", () => {
  test("create+send → unread inbox → first read auto-VIEWED → direct accept stamps the offer snapshot exactly once", async () => {
    const { owner, org } = await makeVerifiedOrg(`INV Flow A ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeEligibleCandidate("INV Flow Candidate A", opp.id);

    const created = await invite(org.id, opp.id, candidate.id, owner.id);
    expect(created.status).toBe(201);
    const invitationId = ((await resBody(created)) as { invitation: { id: string } }).invitation.id;

    const row = await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(row.status).toBe("SENT");
    expect(row.activeInvitationToken).toBe("ACTIVE");
    expect(row.sentAt).not.toBeNull();
    expect(row.expiresAt).not.toBeNull();
    // 14-day TTL (RD-6)
    const ttlDays = (row.expiresAt!.getTime() - row.sentAt!.getTime()) / 24 / 60 / 60_000;
    expect(ttlDays).toBe(14);
    // The original offer snapshot is frozen with the sent values.
    expect(row.offerSalaryMinPaise).toBe(BigInt("120000000"));
    expect(row.offerCurrency).toBe("INR");
    expect(row.offerPeriod).toBe("YEAR");

    // Candidate inbox: unread = SENT with viewedAt null (RD-18).
    await loginAs(candidate.id);
    const inbox1 = (await resBody(await inboxRoute(req("/api/opportunities/me/invitations", "GET")))) as {
      unreadCount: number;
      invitations: { id: string; unread: boolean; organization: { displayName: string }; opportunity: { title: string } }[];
    };
    expect(inbox1.unreadCount).toBe(1);
    const mine = inbox1.invitations.find((i) => i.id === invitationId)!;
    expect(mine.unread).toBe(true);
    expect(mine.organization.displayName).toBe(org.displayName);
    expect(mine.opportunity.title).toBe(opp.title);
    // No candidate-profile content on the shape (the OFFER snapshot is
    // employer-authored data the recipient legitimately sees — Part L).
    const mineJson = JSON.stringify(mine);
    expect(mineJson).not.toContain("compensationVisibility");
    expect(mineJson).not.toContain("contactEmail");
    expect(mineJson).not.toContain("passwordHash");

    // First authorized read performs the automatic SENT → VIEWED transition.
    const detail1 = (await resBody(await candidateDetailRoute(req(`/api/opportunities/me/invitations/${invitationId}`, "GET"), { params: Promise.resolve({ invitationId }) }))) as {
      invitation: { status: string; viewedAt: string | null; unread: boolean };
    };
    expect(detail1.invitation.status).toBe("VIEWED");
    expect(detail1.invitation.viewedAt).not.toBeNull();
    const afterView = await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(afterView.status).toBe("VIEWED");

    // The employer is NEVER notified for viewing (RD-18): the candidate holds
    // exactly one HIRING_INVITATION notification (the dedup-keyed SENT event)
    // and no other HIRING_* notification for this invitation.
    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_INVITATION", dedupKey: `hiring:invitation:${invitationId}:sent` } })).toBe(1);
    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_INVITATION" } })).toBe(1);
    // …and the audit row exists with the candidate as actor.
    const viewedAudit = await db.auditEvent.findFirst({ where: { action: "ox.invitation.viewed", targetId: invitationId } });
    expect(viewedAudit).not.toBeNull();
    expect(viewedAudit!.actorUserId).toBe(candidate.id);

    // Second read is idempotent (no second transition, no extra write).
    await candidateDetailRoute(req(`/api/opportunities/me/invitations/${invitationId}`, "GET"), { params: Promise.resolve({ invitationId }) });
    expect(await db.auditEvent.count({ where: { action: "ox.invitation.viewed", targetId: invitationId } })).toBe(1);

    // Direct accept stamps the accepted snapshot from the ORIGINAL OFFER.
    memoryBackend.resetForTests();
    const accepted = await candidateAcceptRoute(req(`/api/opportunities/me/invitations/${invitationId}/accept`, "POST", {}), { params: Promise.resolve({ invitationId }) });
    expect(accepted.status).toBe(200);
    const acceptedRow = await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(acceptedRow.status).toBe("ACCEPTED");
    expect(acceptedRow.activeInvitationToken).toBeNull();
    expect(acceptedRow.acceptedAt).not.toBeNull();
    expect(acceptedRow.acceptedSalaryMinPaise).toBe(BigInt("120000000"));
    expect(acceptedRow.acceptedSalaryMaxPaise).toBe(BigInt("150000000"));
    expect(acceptedRow.acceptedCurrency).toBe("INR");
    expect(acceptedRow.acceptedPeriod).toBe("YEAR");

    // The employer team got exactly ONE decision notification (RD-13).
    expect(await db.notification.count({ where: { type: "HIRING_INVITATION_DECISION", dedupKey: `hiring:invitation:${invitationId}:decision:ACCEPTED` } })).toBe(1);
    // Audits for both transitions exist.
    expect(await db.auditEvent.count({ where: { action: "ox.invitation.sent", targetId: invitationId } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "ox.invitation.accepted", targetId: invitationId } })).toBe(1);
    const acceptedAudit = await db.auditEvent.findFirst({ where: { action: "ox.invitation.accepted", targetId: invitationId } });
    expect(JSON.parse(acceptedAudit!.meta).source).toBe("DIRECT");

    // IX-7: responding to a terminal invitation is a truthful 409, zero writes.
    memoryBackend.resetForTests();
    const lateDecline = await candidateDeclineRoute(req(`/api/opportunities/me/invitations/${invitationId}/decline`, "POST", {}), { params: Promise.resolve({ invitationId }) });
    expect(lateDecline.status).toBe(409);
    expect(((await resBody(lateDecline)) as Record<string, unknown>).code).toBe("OX_INVITATION_NOT_ACTIONABLE");
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invitationId } })).status).toBe("ACCEPTED");
  });

  test("double-accept race: exactly one winner, loser 409 with zero extra writes (IX-8)", async () => {
    const { owner, org } = await makeVerifiedOrg(`INV Flow B ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeEligibleCandidate("INV Flow Candidate B", opp.id);
    const created = await invite(org.id, opp.id, candidate.id, owner.id);
    const invitationId = ((await resBody(created)) as { invitation: { id: string } }).invitation.id;

    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    const [a, b] = await Promise.all([
      candidateAcceptRoute(req(`/api/opportunities/me/invitations/${invitationId}/accept`, "POST", {}), { params: Promise.resolve({ invitationId }) }),
      candidateAcceptRoute(req(`/api/opportunities/me/invitations/${invitationId}/accept`, "POST", {}), { params: Promise.resolve({ invitationId }) }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await db.opportunityInvitation.count({ where: { id: invitationId, status: "ACCEPTED" } })).toBe(1);
    // Exactly one accepted-terms snapshot write; the loser wrote nothing.
    expect(await db.auditEvent.count({ where: { action: "ox.invitation.accepted", targetId: invitationId } })).toBe(1);
    // Exactly one decision notification (dedup key collapses retries).
    expect(await db.notification.count({ where: { dedupKey: `hiring:invitation:${invitationId}:decision:ACCEPTED` } })).toBe(1);
  });

  test("accept-vs-withdraw race: exactly one winner, loser 409, zero side effects (IX-9)", async () => {
    const { owner, org } = await makeVerifiedOrg(`INV Flow C ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeEligibleCandidate("INV Flow Candidate C", opp.id);
    const created = await invite(org.id, opp.id, candidate.id, owner.id);
    const invitationId = ((await resBody(created)) as { invitation: { id: string } }).invitation.id;

    // Candidate accepts first → the employer's withdrawal must lose.
    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    expect((await candidateAcceptRoute(req(`/api/opportunities/me/invitations/${invitationId}/accept`, "POST", {}), { params: Promise.resolve({ invitationId }) })).status).toBe(200);
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const withdraw = await withdrawRoute(req(`/api/opportunities/invitations/${invitationId}/withdraw`, "POST", { organizationId: org.id }), { params: Promise.resolve({ invitationId }) });
    expect(withdraw.status).toBe(409);
    expect(((await resBody(withdraw)) as Record<string, unknown>).code).toBe("OX_INVITATION_NOT_ACTIONABLE");
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invitationId } })).status).toBe("ACCEPTED");

    // Mirror order: withdraw first → the candidate's accept must lose.
    const candidate2 = await makeEligibleCandidate("INV Flow Candidate C2", opp.id);
    const created2 = await invite(org.id, opp.id, candidate2.id, owner.id);
    const invitationId2 = ((await resBody(created2)) as { invitation: { id: string } }).invitation.id;
    memoryBackend.resetForTests();
    expect((await withdrawRoute(req(`/api/opportunities/invitations/${invitationId2}/withdraw`, "POST", { organizationId: org.id }), { params: Promise.resolve({ invitationId: invitationId2 }) })).status).toBe(200);
    await loginAs(candidate2.id);
    memoryBackend.resetForTests();
    const lateAccept = await candidateAcceptRoute(req(`/api/opportunities/me/invitations/${invitationId2}/accept`, "POST", {}), { params: Promise.resolve({ invitationId: invitationId2 }) });
    expect(lateAccept.status).toBe(409);
    expect(((await resBody(lateAccept)) as Record<string, unknown>).code).toBe("OX_INVITATION_NOT_ACTIONABLE");
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invitationId2 } })).status).toBe("WITHDRAWN");
    // Withdrawal notified the candidate (RD-12).
    expect(await db.notification.count({ where: { type: "HIRING_INVITATION_WITHDRAWN", dedupKey: `hiring:invitation:${invitationId2}:withdrawn` } })).toBe(1);
  });

  test("duplicate invitations: same tuple 409; different opportunity allowed after cooldown; re-invite after terminal + cooldown (override A, IX-19/IX-16)", async () => {
    const { owner, org } = await makeVerifiedOrg(`INV Flow D ${randomUUID().slice(0, 8)}`);
    const oppA = await makeOpportunity(org.id, owner.id);
    const oppB = await makeOpportunity(org.id, owner.id);
    const candidate = await makeEligibleCandidate("INV Flow Candidate D", oppA.id);

    const first = await invite(org.id, oppA.id, candidate.id, owner.id);
    expect(first.status).toBe(201);
    const firstId = ((await resBody(first)) as { invitation: { id: string } }).invitation.id;

    // Same opportunity + candidate while non-terminal → 409 (zero writes).
    memoryBackend.resetForTests();
    await loginAs(owner.id);
    const dupSame = await createInvitationRoute(
      req("/api/opportunities/invitations", "POST", { organizationId: org.id, opportunityId: oppA.id, candidateUserId: candidate.id, offer: offerTerms() })
    );
    expect(dupSame.status).toBe(409);
    expect(((await resBody(dupSame)) as Record<string, unknown>).code).toBe("OX_INVITATION_DUPLICATE");
    expect(await db.opportunityInvitation.count({ where: { candidateUserId: candidate.id } })).toBe(1);

    // Different opportunity, SAME candidate: allowed by override A's key —
    // but only once the 7-day cooldown has passed. Within the cooldown the
    // refusal is the cooldown (IX-16), not the uniqueness rule.
    memoryBackend.resetForTests();
    const second = await createInvitationRoute(
      req("/api/opportunities/invitations", "POST", { organizationId: org.id, opportunityId: oppB.id, candidateUserId: candidate.id, offer: offerTerms() })
    );
    expect(second.status).toBe(409);
    expect(((await resBody(second)) as Record<string, unknown>).code).toBe("OX_INVITATION_COOLDOWN");
    expect(await db.opportunityInvitation.count({ where: { candidateUserId: candidate.id } })).toBe(1);

    // Backdate the first send beyond the cooldown; withdraw it (terminal).
    await db.opportunityInvitation.update({
      where: { id: firstId },
      data: { sentAt: new Date(Date.now() - 8 * 24 * 60 * 60_000), status: "WITHDRAWN", withdrawnAt: new Date(), withdrawnByUserId: owner.id, activeInvitationToken: null },
    });
    // RD-2: the source pointer is per-opportunity — give the candidate a
    // current eligible match for oppB before re-inviting there.
    await db.talentMatch.create({
      data: {
        opportunityId: oppB.id,
        candidateUserId: candidate.id,
        matchVersion: "O4-MATCH-V1",
        score: 75,
        eligible: true,
        generatedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      },
    });
    memoryBackend.resetForTests();
    const third = await createInvitationRoute(
      req("/api/opportunities/invitations", "POST", { organizationId: org.id, opportunityId: oppB.id, candidateUserId: candidate.id, offer: offerTerms(1_000_000_00, 1_100_000_00) })
    );
    expect(third.status).toBe(201);
    // History preserved: each invitation is its own row; threads never merge.
    expect(await db.opportunityInvitation.count({ where: { candidateUserId: candidate.id } })).toBe(2);
  });

  test("daily quota (20/day) and monthly quota (200/fixed-30d-window) refuse with 429 (IX-15)", async () => {
    const { owner, org } = await makeVerifiedOrg(`INV Flow E ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidates: User[] = [];
    for (let i = 0; i < 21; i++) {
      candidates.push(await makeEligibleCandidate(`INV Flow E Candidate ${i}`, opp.id));
    }
    for (let i = 0; i < 20; i++) {
      const res = await invite(org.id, opp.id, candidates[i].id, owner.id);
      expect(res.status).toBe(201);
    }
    // The 21st send of the UTC day exceeds the daily quota (RD-4).
    memoryBackend.resetForTests();
    const overDaily = await invite(org.id, opp.id, candidates[20].id, owner.id);
    expect(overDaily.status).toBe(429);
    expect(((await resBody(overDaily)) as Record<string, unknown>).code).toBe("OX_INVITATION_QUOTA_EXCEEDED");
    expect(await db.opportunityInvitation.count({ where: { organizationId: org.id } })).toBe(20);

    // Monthly quota: 200 SENT rows inside the fixed 30-day window but outside
    // the UTC day (sentAt 2 days ago, all terminal → no uniqueness conflict),
    // then any fresh send is refused by the monthly gate.
    const fillerCandidate = await makeUser("INV Flow E Filler");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    const fillers = Array.from({ length: 200 }, () => ({
      organizationId: org.id,
      opportunityId: opp.id,
      candidateUserId: fillerCandidate.id,
      status: "EXPIRED",
      offerSalaryMinPaise: BigInt("100"),
      offerSalaryMaxPaise: BigInt("200"),
      offerCurrency: "INR",
      offerPeriod: "YEAR",
      sentAt: twoDaysAgo,
      expiresAt: twoDaysAgo,
      activeInvitationToken: null,
    }));
    await db.opportunityInvitation.createMany({ data: fillers });
    const freshCandidate = await makeEligibleCandidate("INV Flow E Fresh", opp.id);
    memoryBackend.resetForTests();
    const overMonthly = await invite(org.id, opp.id, freshCandidate.id, owner.id);
    expect(overMonthly.status).toBe(429);
    expect(((await resBody(overMonthly)) as Record<string, unknown>).code).toBe("OX_INVITATION_QUOTA_EXCEEDED");
    expect(await db.opportunityInvitation.count({ where: { organizationId: org.id, candidateUserId: freshCandidate.id } })).toBe(0);
  });

  test("draft lifecycle: save draft (RD-17), candidate invisible, edit, send via draft path; non-draft edits are 409", async () => {
    const { owner, org } = await makeVerifiedOrg(`INV Flow F ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeEligibleCandidate("INV Flow Candidate F", opp.id);
    await loginAs(owner.id);

    // Save a draft (send:false).
    memoryBackend.resetForTests();
    const draft = await createInvitationRoute(
      req("/api/opportunities/invitations", "POST", { organizationId: org.id, opportunityId: opp.id, candidateUserId: candidate.id, send: false, offer: offerTerms() })
    );
    expect(draft.status).toBe(201);
    const draftBody = (await resBody(draft)) as { invitation: { id: string; status: string } };
    const draftId = draftBody.invitation.id;
    expect(draftBody.invitation.status).toBe("DRAFT");
    expect(await db.auditEvent.count({ where: { action: "ox.invitation.drafted", targetId: draftId } })).toBe(1);

    // IX-14: the draft is invisible to the candidate (no inbox row, no notification).
    await loginAs(candidate.id);
    const inbox = (await resBody(await inboxRoute(req("/api/opportunities/me/invitations", "GET")))) as { invitations: { id: string }[] };
    expect(inbox.invitations.find((i) => i.id === draftId)).toBeUndefined();
    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_INVITATION" } })).toBe(0);

    // Edit the draft offer terms.
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const patched = await patchDraftRoute(
      req(`/api/opportunities/invitations/${draftId}`, "PATCH", { organizationId: org.id, offer: offerTerms(2_000_000_00, 2_500_000_00) }),
      { params: Promise.resolve({ invitationId: draftId }) }
    );
    expect(patched.status).toBe(200);
    const editedRow = await db.opportunityInvitation.findUniqueOrThrow({ where: { id: draftId } });
    expect(editedRow.offerSalaryMinPaise).toBe(BigInt("200000000"));
    expect(await db.auditEvent.count({ where: { action: "ox.invitation.draft_updated", targetId: draftId } })).toBe(1);

    // Send the draft through the draft path (all gates run at send).
    memoryBackend.resetForTests();
    const sent = await sendDraftRoute(req(`/api/opportunities/invitations/${draftId}/send`, "POST", { organizationId: org.id }), { params: Promise.resolve({ invitationId: draftId }) });
    expect(sent.status).toBe(200);
    const sentRow = await db.opportunityInvitation.findUniqueOrThrow({ where: { id: draftId } });
    expect(sentRow.status).toBe("SENT");
    expect(sentRow.sentByUserId).toBe(owner.id);
    // The frozen offer snapshot carries the EDITED draft values.
    expect(sentRow.offerSalaryMinPaise).toBe(BigInt("200000000"));
    // The candidate was notified exactly once (dedup key on the sent event).
    expect(await db.notification.count({ where: { userId: candidate.id, type: "HIRING_INVITATION", dedupKey: `hiring:invitation:${draftId}:sent` } })).toBe(1);

    // Post-send edit/discard are 409 (no path rewrites a sent offer).
    memoryBackend.resetForTests();
    expect((await patchDraftRoute(req(`/api/opportunities/invitations/${draftId}`, "PATCH", { organizationId: org.id, offer: offerTerms() }), { params: Promise.resolve({ invitationId: draftId }) })).status).toBe(409);
    expect((await deleteDraftRoute(req(`/api/opportunities/invitations/${draftId}?organizationId=${org.id}`, "DELETE"), { params: Promise.resolve({ invitationId: draftId }) })).status).toBe(409);
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: draftId } })).offerSalaryMinPaise).toBe(BigInt("200000000"));
  });

  test("draft discard deletes only the pre-send artifact (audited)", async () => {
    const { owner, org } = await makeVerifiedOrg(`INV Flow G ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeEligibleCandidate("INV Flow Candidate G", opp.id);
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const draft = await createInvitationRoute(
      req("/api/opportunities/invitations", "POST", { organizationId: org.id, opportunityId: opp.id, candidateUserId: candidate.id, send: false, offer: offerTerms() })
    );
    const draftId = ((await resBody(draft)) as { invitation: { id: string } }).invitation.id;
    memoryBackend.resetForTests();
    const del = await deleteDraftRoute(req(`/api/opportunities/invitations/${draftId}?organizationId=${org.id}`, "DELETE"), { params: Promise.resolve({ invitationId: draftId }) });
    expect(del.status).toBe(200);
    expect(await db.opportunityInvitation.count({ where: { id: draftId } })).toBe(0);
    expect(await db.auditEvent.count({ where: { action: "ox.invitation.draft_discarded", targetId: draftId } })).toBe(1);
  });

  test("expiry sweep is transition-only and idempotent; terminal rows are never resurrected (IX-17)", async () => {
    const { owner, org } = await makeVerifiedOrg(`INV Flow H ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const c1 = await makeEligibleCandidate("INV Flow Candidate H1", opp.id);
    const c2 = await makeEligibleCandidate("INV Flow Candidate H2", opp.id);
    const i1 = ((await resBody(await invite(org.id, opp.id, c1.id, owner.id))) as { invitation: { id: string } }).invitation.id;
    const i2 = ((await resBody(await invite(org.id, opp.id, c2.id, owner.id))) as { invitation: { id: string } }).invitation.id;

    // Lapse i1 (SENT past its window); i2 was already ACCEPTED (terminal).
    await db.opportunityInvitation.update({ where: { id: i1 }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await db.opportunityInvitation.update({ where: { id: i2 }, data: { status: "ACCEPTED", acceptedAt: new Date(), activeInvitationToken: null, respondedAt: new Date() } });

    const firstRun = await sweepExpiredInvitations();
    expect(firstRun.expiredInvitations).toBe(1);
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: i1 } })).status).toBe("EXPIRED");
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: i1 } })).activeInvitationToken).toBeNull();

    // Second run matches zero rows (idempotent).
    const secondRun = await sweepExpiredInvitations();
    expect(secondRun.expiredInvitations).toBe(0);

    // Terminal rows are structurally unreachable: i2 stays ACCEPTED.
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: i2 } })).status).toBe("ACCEPTED");
    // Expiry notified the EMPLOYER team, never the candidate (RD-12/RD-13).
    expect(await db.notification.count({ where: { type: "HIRING_INVITATION_EXPIRED", dedupKey: `hiring:invitation:${i1}:expired` } })).toBe(1);
    expect(await db.notification.count({ where: { userId: c1.id, type: "HIRING_INVITATION_EXPIRED" } })).toBe(0);
    // The sweep never deletes hiring history.
    expect(await db.opportunityInvitation.count({ where: { id: { in: [i1, i2] } } })).toBe(2);
  });

  test("proposal-TTL sweep expires proposal AND invitation; stalled negotiations expire after 14d inactivity", async () => {
    const { owner, org } = await makeVerifiedOrg(`INV Flow I ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeEligibleCandidate("INV Flow Candidate I", opp.id);
    const invId = ((await resBody(await invite(org.id, opp.id, candidate.id, owner.id))) as { invitation: { id: string } }).invitation.id;

    // Candidate requests negotiation; employer proposes; backdate the
    // proposal past its 7-day window.
    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    expect((await negotiationRequestRoute(req(`/api/opportunities/me/invitations/${invId}/negotiation-request`, "POST", {}), { params: Promise.resolve({ invitationId: invId }) })).status).toBe(200);
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const proposal = await employerProposeRoute(
      req(`/api/opportunities/invitations/${invId}/negotiations`, "POST", { organizationId: org.id, terms: { proposedSalaryMinPaise: 1_300_000_00, proposedSalaryMaxPaise: 1_600_000_00, proposedCurrency: "INR", proposedPeriod: "YEAR" } }),
      { params: Promise.resolve({ invitationId: invId }) }
    );
    expect(proposal.status).toBe(201);
    const proposalId = ((await resBody(proposal)) as { proposal: { id: string } }).proposal.id;
    await db.invitationNegotiation.update({
      where: { id: proposalId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const run1 = await sweepExpiredInvitations();
    expect(run1.expiredProposals).toBe(1);
    expect((await db.invitationNegotiation.findUniqueOrThrow({ where: { id: proposalId } })).status).toBe("EXPIRED");
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invId } })).status).toBe("EXPIRED");
    const run2 = await sweepExpiredInvitations();
    expect(run2.expiredProposals).toBe(0);

    // Stalled negotiation: NEGOTIATION_REQUESTED, no pending proposal, no
    // activity for 14 days → EXPIRED by the same sweep (RD-6).
    const candidate2 = await makeEligibleCandidate("INV Flow Candidate I2", opp.id);
    const invId2 = ((await resBody(await invite(org.id, opp.id, candidate2.id, owner.id))) as { invitation: { id: string } }).invitation.id;
    await loginAs(candidate2.id);
    memoryBackend.resetForTests();
    await negotiationRequestRoute(req(`/api/opportunities/me/invitations/${invId2}/negotiation-request`, "POST", {}), { params: Promise.resolve({ invitationId: invId2 }) });
    await db.opportunityInvitation.update({
      where: { id: invId2 },
      data: { respondedAt: new Date(Date.now() - 15 * 24 * 60 * 60_000) },
    });
    const run3 = await sweepExpiredInvitations();
    expect(run3.stalledNegotiations).toBe(1);
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invId2 } })).status).toBe("EXPIRED");
    const run4 = await sweepExpiredInvitations();
    expect(run4.stalledNegotiations).toBe(0);
  });

  test("RD-17: PAUSED and terminal opportunities refuse NEW sends but keep existing invitations interactive", async () => {
    const { owner, org } = await makeVerifiedOrg(`INV Flow J ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const liveCandidate = await makeEligibleCandidate("INV Flow Candidate J1", opp.id);
    const existingCandidate = await makeEligibleCandidate("INV Flow Candidate J2", opp.id);
    const invId = ((await resBody(await invite(org.id, opp.id, existingCandidate.id, owner.id))) as { invitation: { id: string } }).invitation.id;

    await db.opportunity.update({ where: { id: opp.id }, data: { status: "PAUSED" } });
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const pausedSend = await createInvitationRoute(
      req("/api/opportunities/invitations", "POST", { organizationId: org.id, opportunityId: opp.id, candidateUserId: liveCandidate.id, offer: offerTerms() })
    );
    expect(pausedSend.status).toBe(409);
    expect(((await resBody(pausedSend)) as Record<string, unknown>).code).toBe("OX_OPPORTUNITY_NOT_DISCOVERABLE");

    // The existing invitation stays fully interactive (candidate agency).
    await loginAs(existingCandidate.id);
    memoryBackend.resetForTests();
    const detail = (await resBody(await candidateDetailRoute(req(`/api/opportunities/me/invitations/${invId}`, "GET"), { params: Promise.resolve({ invitationId: invId }) }))) as { invitation: { status: string } };
    expect(detail.invitation.status).toBe("VIEWED");
    memoryBackend.resetForTests();
    expect((await candidateAcceptRoute(req(`/api/opportunities/me/invitations/${invId}/accept`, "POST", {}), { params: Promise.resolve({ invitationId: invId }) })).status).toBe(200);

    // Terminal opportunity: same rules.
    await db.opportunity.update({ where: { id: opp.id }, data: { status: "FILLED" } });
    const c3 = await makeEligibleCandidate("INV Flow Candidate J3", opp.id);
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const terminalSend = await createInvitationRoute(
      req("/api/opportunities/invitations", "POST", { organizationId: org.id, opportunityId: opp.id, candidateUserId: c3.id, offer: offerTerms() })
    );
    expect(terminalSend.status).toBe(409);
    expect(((await resBody(terminalSend)) as Record<string, unknown>).code).toBe("OX_OPPORTUNITY_NOT_DISCOVERABLE");
  });

  test("notifications: candidate notified on sent exactly once (dedup upsert); no compensation amounts in any payload (IX-13 partial)", async () => {
    const { owner, org } = await makeVerifiedOrg(`INV Flow K ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeEligibleCandidate("INV Flow Candidate K", opp.id);
    const invId = ((await resBody(await invite(org.id, opp.id, candidate.id, owner.id))) as { invitation: { id: string } }).invitation.id;

    const notes = await db.notification.findMany({ where: { dedupKey: `hiring:invitation:${invId}:sent` } });
    expect(notes.length).toBe(1);
    const payload = JSON.parse(notes[0].payload) as Record<string, unknown>;
    expect(payload.invitationId).toBe(invId);
    expect(payload.organizationDisplayName).toBe(org.displayName);
    expect(payload.opportunityTitle).toBe(opp.title);
    // Payload minimality: no salary/paise values, no contact fields.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("Paise");
    expect(serialized).not.toContain("120000000");
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("contact");
  });
});
