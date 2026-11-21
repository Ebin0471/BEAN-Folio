import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

/**
 * M-O6 — negotiation engine suite (append-only invariants, RD-9 one-active
 * protocol, RD-7 cap + decline semantics, RD-10 accepted-terms stamping,
 * proposal races, IX-12 tamper-resistance).
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
import { POST as createInvitationRoute } from "@/app/api/opportunities/invitations/route";
import { POST as withdrawRoute } from "@/app/api/opportunities/invitations/[invitationId]/withdraw/route";
import { POST as employerProposeRoute } from "@/app/api/opportunities/invitations/[invitationId]/negotiations/route";
import { POST as employerAcceptProposalRoute } from "@/app/api/opportunities/invitations/[invitationId]/negotiations/[negotiationId]/accept/route";
import { POST as employerDeclineProposalRoute } from "@/app/api/opportunities/invitations/[invitationId]/negotiations/[negotiationId]/decline/route";
import { POST as employerWithdrawProposalRoute } from "@/app/api/opportunities/invitations/[invitationId]/negotiations/[negotiationId]/withdraw/route";
import { GET as candidateDetailRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/route";
import { POST as negotiationRequestRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/negotiation-request/route";
import { POST as candidateCounterRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/negotiations/route";
import { POST as candidateAcceptProposalRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/negotiations/[negotiationId]/accept/route";
import { POST as candidateDeclineProposalRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/negotiations/[negotiationId]/decline/route";
import { POST as candidateWithdrawProposalRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/negotiations/[negotiationId]/withdraw/route";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

function req(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `192.0.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
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

const PWD = await hashPassword("ox-neg-password-1");

async function makeUser(name: string) {
  return db.user.create({
    data: { email: `ox-neg-${randomUUID()}@beanfolio.test`, passwordHash: PWD, name },
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

async function makeOpportunity(orgId: string, ownerId: string) {
  return db.opportunity.create({
    data: {
      organizationId: orgId,
      createdByUserId: ownerId,
      title: "Negotiation opportunity",
      description: "An opportunity used to exercise the negotiation engine in tests.",
      status: "PUBLISHED",
      employmentType: "FULL_TIME",
      workMode: "REMOTE",
      submittedAt: new Date(),
      publishedAt: new Date(),
      salaryMinPaise: 500_000_00,
      salaryMaxPaise: 900_000_00,
      salaryCurrency: "INR",
      compensationPeriod: "YEAR",
    },
  });
}

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

const OFFER = { offerSalaryMinPaise: 1_200_000_00, offerSalaryMaxPaise: 1_500_000_00, offerCurrency: "INR", offerPeriod: "YEAR" };
const PROPOSAL = (min: number, max: number) => ({ proposedSalaryMinPaise: min, proposedSalaryMaxPaise: max, proposedCurrency: "INR", proposedPeriod: "YEAR" });

/** A live invitation already in NEGOTIATION_REQUESTED (candidate requested,
 * no proposals yet). Returns { invId, candidate }. */
async function makeNegotiatingInvitation(name: string) {
  const { owner, org } = await makeVerifiedOrg(`NEG Org ${name} ${randomUUID().slice(0, 8)}`);
  const opp = await makeOpportunity(org.id, owner.id);
  const candidate = await makeEligibleCandidate(`NEG Candidate ${name}`, opp.id);
  await loginAs(owner.id);
  memoryBackend.resetForTests();
  const created = await createInvitationRoute(
    req("/api/opportunities/invitations", "POST", { organizationId: org.id, opportunityId: opp.id, candidateUserId: candidate.id, offer: OFFER })
  );
  const invId = ((await resBody(created)) as { invitation: { id: string } }).invitation.id;
  await loginAs(candidate.id);
  memoryBackend.resetForTests();
  const requested = await negotiationRequestRoute(req(`/api/opportunities/me/invitations/${invId}/negotiation-request`, "POST", {}), { params: Promise.resolve({ invitationId: invId }) });
  expect(requested.status).toBe(200);
  return { owner, org, opp, candidate, invId };
}

const pParams = (invId: string, nid: string) => ({ params: Promise.resolve({ invitationId: invId, negotiationId: nid }) });

describe("M-O6 negotiation engine — append-only protocol (RD-9/RD-7/RD-10)", () => {
  test("immediate proposal at negotiation-request becomes seq 1; 7-day window stamped", async () => {
    const { owner, org } = await makeVerifiedOrg(`NEG Imm ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeEligibleCandidate("NEG Imm Candidate", opp.id);
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const invId = ((await resBody(await createInvitationRoute(req("/api/opportunities/invitations", "POST", { organizationId: org.id, opportunityId: opp.id, candidateUserId: candidate.id, offer: OFFER })))) as { invitation: { id: string } }).invitation.id;

    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    const requested = (await resBody(
      await negotiationRequestRoute(req(`/api/opportunities/me/invitations/${invId}/negotiation-request`, "POST", { terms: PROPOSAL(1_400_000_00, 1_700_000_00) }), { params: Promise.resolve({ invitationId: invId }) })
    )) as { proposalSeq: number };
    expect(requested.proposalSeq).toBe(1);

    const row = await db.invitationNegotiation.findUniqueOrThrow({ where: { invitationId_seq: { invitationId: invId, seq: 1 } } });
    expect(row.status).toBe("PENDING");
    expect(row.proposerRole).toBe("CANDIDATE");
    expect(row.proposerUserId).toBe(candidate.id);
    expect(row.proposedSalaryMinPaise).toBe(BigInt("140000000"));
    const windowDays = (row.expiresAt.getTime() - row.createdAt.getTime()) / 24 / 60 / 60_000;
    expect(windowDays).toBeCloseTo(7, 4);
    // The employer team got both the decision AND the proposal notification.
    expect(await db.notification.count({ where: { dedupKey: `hiring:invitation:${invId}:decision:NEGOTIATION_REQUESTED` } })).toBe(1);
    expect(await db.notification.count({ where: { dedupKey: `hiring:invitation:${invId}:negotiation:seq-1` } })).toBe(1);
  });

  test("RD-9: employer propose → candidate counter supersedes (old SUPERSEDED, untouched) → employer re-counter supersedes again; seq monotonic; terms never rewritten (IX-12)", async () => {
    const { owner, org, candidate, invId } = await makeNegotiatingInvitation("Supersede");
    const orgId_holder = org.id;

    // Employer proposes seq 1.
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const p1 = (await resBody(await employerProposeRoute(req(`/api/opportunities/invitations/${invId}/negotiations`, "POST", { organizationId: orgId_holder, terms: PROPOSAL(1_300_000_00, 1_600_000_00) }), { params: Promise.resolve({ invitationId: invId }) }))) as { proposal: { id: string; seq: number } };
    expect(p1.proposal.seq).toBe(1);
    const p1Row = await db.invitationNegotiation.findUniqueOrThrow({ where: { id: p1.proposal.id } });
    expect(p1Row.status).toBe("PENDING");

    // Candidate counters → seq 2 supersedes seq 1 in the same transaction.
    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    const c1 = (await resBody(await candidateCounterRoute(req(`/api/opportunities/me/invitations/${invId}/negotiations`, "POST", PROPOSAL(1_500_000_00, 1_800_000_00)), { params: Promise.resolve({ invitationId: invId }) }))) as { proposal: { id: string; seq: number } };
    expect(c1.proposal.seq).toBe(2);
    const p1After = await db.invitationNegotiation.findUniqueOrThrow({ where: { id: p1.proposal.id } });
    expect(p1After.status).toBe("SUPERSEDED");
    expect(p1After.decidedAt).not.toBeNull();
    // Append-only: the superseded row's terms are untouched.
    expect(p1After.proposedSalaryMinPaise).toBe(BigInt("130000000"));
    expect(p1After.proposedSalaryMaxPaise).toBe(BigInt("160000000"));

    // Employer counters again → seq 3; exactly one PENDING at any time.
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const p2 = (await resBody(await employerProposeRoute(req(`/api/opportunities/invitations/${invId}/negotiations`, "POST", { organizationId: orgId_holder, terms: PROPOSAL(1_450_000_00, 1_650_000_00) }), { params: Promise.resolve({ invitationId: invId }) }))) as { proposal: { id: string; seq: number } };
    expect(p2.proposal.seq).toBe(3);
    const all = await db.invitationNegotiation.findMany({ where: { invitationId: invId }, orderBy: { seq: "asc" } });
    expect(all.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(all.filter((r) => r.status === "PENDING")).toHaveLength(1);
    expect(all.find((r) => r.status === "PENDING")!.seq).toBe(3);
    // Terms of every historical row are exactly what was proposed.
    expect(all.find((r) => r.seq === 2)!.proposedSalaryMinPaise).toBe(BigInt("150000000"));

    // Audit trail: proposed events carry seq + supersedesSeq, never amounts.
    const audits = await db.auditEvent.findMany({ where: { action: "ox.negotiation.proposed", targetId: invId } });
    expect(audits.length).toBe(3);
    const metas = audits.map((a) => JSON.stringify(JSON.parse(a.meta)));
    for (const meta of metas) {
      expect(meta).not.toContain("Paise");
      expect(meta).not.toContain("145000000");
    }
    const lastMeta = JSON.parse(audits.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[2].meta) as Record<string, unknown>;
    expect(lastMeta.seq).toBe(3);
    expect(lastMeta.supersedesSeq).toBe(2);
  });

  test("RD-9 race: two concurrent same-side proposals collapse deterministically — at most one PENDING, seq unique", async () => {
    const { owner, org, invId } = await makeNegotiatingInvitation("Race");
    const orgId_holder = org.id;
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const orgId = orgId_holder;
    const [a, b] = await Promise.all([
      employerProposeRoute(req(`/api/opportunities/invitations/${invId}/negotiations`, "POST", { organizationId: orgId, terms: PROPOSAL(1_300_000_00, 1_600_000_00) }), { params: Promise.resolve({ invitationId: invId }) }),
      employerProposeRoute(req(`/api/opportunities/invitations/${invId}/negotiations`, "POST", { organizationId: orgId, terms: PROPOSAL(1_320_000_00, 1_620_000_00) }), { params: Promise.resolve({ invitationId: invId }) }),
    ]);
    // Both requests resolve; the thread holds exactly one PENDING proposal
    // (the later writer superseded the first's row) or the loser got a 409.
    const rows = await db.invitationNegotiation.findMany({ where: { invitationId: invId } });
    const seqs = rows.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // unique seq under races
    expect(rows.filter((r) => r.status === "PENDING")).toHaveLength(1);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
  });

  test("RD-10: accepting a proposal stamps accepted terms EXACTLY from the winning proposal; accepting your own is refused; double-accept races collapse", async () => {
    const { owner, org, candidate, invId } = await makeNegotiatingInvitation("Accept");
    const orgId_holder = org.id;
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const orgId = org.id;
    const p1 = (await resBody(await employerProposeRoute(req(`/api/opportunities/invitations/${invId}/negotiations`, "POST", { organizationId: orgId, terms: PROPOSAL(1_450_000_00, 1_700_000_00) }), { params: Promise.resolve({ invitationId: invId }) }))) as { proposal: { id: string } };

    // Candidate cannot withdraw the EMPLOYER's proposal (only the proposer
    // can withdraw their own pending proposal).
    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    expect((await candidateWithdrawProposalRoute(req(`/api/opportunities/me/invitations/${invId}/negotiations/${p1.proposal.id}/withdraw`, "POST", {}), pParams(invId, p1.proposal.id))).status).toBe(409);

    // Employer accepting their own proposal → 409.
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    expect((await employerAcceptProposalRoute(req(`/api/opportunities/invitations/${invId}/negotiations/${p1.proposal.id}/accept`, "POST", { organizationId: orgId }), pParams(invId, p1.proposal.id))).status).toBe(409);

    // Candidate accepts the employer proposal — raced twice.
    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    const [a, b] = await Promise.all([
      candidateAcceptProposalRoute(req(`/api/opportunities/me/invitations/${invId}/negotiations/${p1.proposal.id}/accept`, "POST", {}), pParams(invId, p1.proposal.id)),
      candidateAcceptProposalRoute(req(`/api/opportunities/me/invitations/${invId}/negotiations/${p1.proposal.id}/accept`, "POST", {}), pParams(invId, p1.proposal.id)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const inv = await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invId } });
    expect(inv.status).toBe("ACCEPTED");
    expect(inv.activeInvitationToken).toBeNull();
    // RD-10: the snapshot is copied EXACTLY from the winning proposal.
    const proposal = await db.invitationNegotiation.findUniqueOrThrow({ where: { id: p1.proposal.id } });
    expect(proposal.status).toBe("ACCEPTED");
    expect(inv.acceptedSalaryMinPaise).toBe(proposal.proposedSalaryMinPaise);
    expect(inv.acceptedSalaryMaxPaise).toBe(proposal.proposedSalaryMaxPaise);
    expect(inv.acceptedCurrency).toBe(proposal.proposedCurrency);
    expect(inv.acceptedPeriod).toBe(proposal.proposedPeriod);
    expect(inv.acceptedAt).not.toBeNull();
    // Exactly one accepted-terms write: one audit line, one decision notification.
    expect(await db.auditEvent.count({ where: { action: "ox.invitation.accepted", targetId: invId } })).toBe(1);
    const acceptedAudit = await db.auditEvent.findFirst({ where: { action: "ox.invitation.accepted", targetId: invId } });
    expect(JSON.parse(acceptedAudit!.meta).source).toBe("SEQ_1");
    expect(await db.notification.count({ where: { dedupKey: `hiring:invitation:${invId}:decision:ACCEPTED` } })).toBe(1);
  });

  test("RD-7: declining the standing proposal declines the invitation — symmetric for both parties", async () => {
    // Candidate rejects the employer's proposal.
    const a = await makeNegotiatingInvitation("DeclineC");
    await loginAs(a.owner.id);
    memoryBackend.resetForTests();
    const p1 = (await resBody(await employerProposeRoute(req(`/api/opportunities/invitations/${a.invId}/negotiations`, "POST", { organizationId: a.org.id, terms: PROPOSAL(1_300_000_00, 1_600_000_00) }), { params: Promise.resolve({ invitationId: a.invId }) }))) as { proposal: { id: string } };
    await loginAs(a.candidate.id);
    memoryBackend.resetForTests();
    expect((await candidateDeclineProposalRoute(req(`/api/opportunities/me/invitations/${a.invId}/negotiations/${p1.proposal.id}/decline`, "POST", {}), pParams(a.invId, p1.proposal.id))).status).toBe(200);
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: a.invId } })).status).toBe("DECLINED");
    expect((await db.invitationNegotiation.findUniqueOrThrow({ where: { id: p1.proposal.id } })).status).toBe("DECLINED");
    expect(await db.notification.count({ where: { dedupKey: `hiring:invitation:${a.invId}:decision:DECLINED` } })).toBe(1);

    // Employer declines the candidate's proposal (symmetric rule).
    const b = await makeNegotiatingInvitation("DeclineE");
    await loginAs(b.candidate.id);
    memoryBackend.resetForTests();
    const c1 = (await resBody(await candidateCounterRoute(req(`/api/opportunities/me/invitations/${b.invId}/negotiations`, "POST", PROPOSAL(1_600_000_00, 1_900_000_00)), { params: Promise.resolve({ invitationId: b.invId }) }))) as { proposal: { id: string } };
    await loginAs(b.owner.id);
    memoryBackend.resetForTests();
    expect((await employerDeclineProposalRoute(req(`/api/opportunities/invitations/${b.invId}/negotiations/${c1.proposal.id}/decline`, "POST", { organizationId: b.org.id }), pParams(b.invId, c1.proposal.id))).status).toBe(200);
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: b.invId } })).status).toBe("DECLINED");
    expect((await db.invitationNegotiation.findUniqueOrThrow({ where: { id: c1.proposal.id } })).status).toBe("DECLINED");
  });

  test("RD-9: withdrawing your own pending proposal keeps the thread open (invitation stays NEGOTIATION_REQUESTED); employer withdrawal during negotiation freezes the thread intact", async () => {
    const { owner, org, candidate, invId } = await makeNegotiatingInvitation("Withdraw");
    const orgId_holder = org.id;
    // Employer proposes, then withdraws their own pending proposal.
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const p1 = (await resBody(await employerProposeRoute(req(`/api/opportunities/invitations/${invId}/negotiations`, "POST", { organizationId: org.id, terms: PROPOSAL(1_300_000_00, 1_600_000_00) }), { params: Promise.resolve({ invitationId: invId }) }))) as { proposal: { id: string } };
    memoryBackend.resetForTests();
    expect((await employerWithdrawProposalRoute(req(`/api/opportunities/invitations/${invId}/negotiations/${p1.proposal.id}/withdraw`, "POST", { organizationId: org.id }), pParams(invId, p1.proposal.id))).status).toBe(200);
    expect((await db.invitationNegotiation.findUniqueOrThrow({ where: { id: p1.proposal.id } })).status).toBe("WITHDRAWN");
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invId } })).status).toBe("NEGOTIATION_REQUESTED");

    // The candidate can still counter (thread open).
    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    const c1 = (await resBody(await candidateCounterRoute(req(`/api/opportunities/me/invitations/${invId}/negotiations`, "POST", PROPOSAL(1_500_000_00, 1_800_000_00)), { params: Promise.resolve({ invitationId: invId }) }))) as { proposal: { seq: number } };
    expect(c1.proposal.seq).toBe(2);

    // Employer withdraws the whole invitation mid-negotiation (RD-11): the
    // pending proposal freezes AS-IS (append-only), the candidate is notified.
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    expect((await withdrawRoute(req(`/api/opportunities/invitations/${invId}/withdraw`, "POST", { organizationId: org.id }), { params: Promise.resolve({ invitationId: invId }) })).status).toBe(200);
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invId } })).status).toBe("WITHDRAWN");
    expect((await db.invitationNegotiation.findUniqueOrThrow({ where: { invitationId_seq: { invitationId: invId, seq: 2 } } })).status).toBe("PENDING");
    expect(await db.notification.count({ where: { type: "HIRING_INVITATION_WITHDRAWN", dedupKey: `hiring:invitation:${invId}:withdrawn` } })).toBe(1);
    // History rows all survive.
    expect(await db.invitationNegotiation.count({ where: { invitationId: invId } })).toBe(2);
  });

  test("RD-7: the 6-proposal cap refuses proposal 7 with 409 OX_NEGOTIATION_LIMIT while accept/decline/withdraw remain possible", async () => {
    const { owner, org, candidate, invId } = await makeNegotiatingInvitation("Cap");
    const orgId_holder = org.id;
    const orgId = org.id;
    // Alternate proposals to reach exactly 6.
    for (let i = 1; i <= 6; i++) {
      await loginAs(i % 2 === 1 ? owner.id : candidate.id);
      memoryBackend.resetForTests();
      const res =
        i % 2 === 1
          ? await employerProposeRoute(req(`/api/opportunities/invitations/${invId}/negotiations`, "POST", { organizationId: orgId, terms: PROPOSAL(1_000_000_00 + i * 10_000_00, 1_100_000_00 + i * 10_000_00) }), { params: Promise.resolve({ invitationId: invId }) })
          : await candidateCounterRoute(req(`/api/opportunities/me/invitations/${invId}/negotiations`, "POST", PROPOSAL(1_000_000_00 + i * 10_000_00, 1_100_000_00 + i * 10_000_00)), { params: Promise.resolve({ invitationId: invId }) });
      expect(res.status).toBe(201);
    }
    expect(await db.invitationNegotiation.count({ where: { invitationId: invId } })).toBe(6);

    // Proposal 7 is refused with the approved code.
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const seventh = await employerProposeRoute(req(`/api/opportunities/invitations/${invId}/negotiations`, "POST", { organizationId: orgId, terms: PROPOSAL(2_000_000_00, 2_100_000_00) }), { params: Promise.resolve({ invitationId: invId }) });
    expect(seventh.status).toBe(409);
    expect(((await resBody(seventh)) as Record<string, unknown>).code).toBe("OX_NEGOTIATION_LIMIT");

    // But the standing proposal can still be accepted (no dead-end lock).
    // After the alternation the pending proposal (seq 6) belongs to the
    // CANDIDATE — the EMPLOYER accepts it.
    const pending = await db.invitationNegotiation.findFirst({ where: { invitationId: invId, status: "PENDING" } });
    expect(pending).not.toBeNull();
    expect(pending!.proposerRole).toBe("CANDIDATE");
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    expect((await employerAcceptProposalRoute(req(`/api/opportunities/invitations/${invId}/negotiations/${pending!.id}/accept`, "POST", { organizationId: orgId }), pParams(invId, pending!.id))).status).toBe(200);
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invId } })).status).toBe("ACCEPTED");
    expect(await db.invitationNegotiation.count({ where: { invitationId: invId } })).toBe(6); // append-only, nothing deleted
  });

  test("proposals are only possible during NEGOTIATION_REQUESTED; the candidate's counter on a SENT invitation is a 409 with zero writes", async () => {
    const { owner, org } = await makeVerifiedOrg(`NEG Sent ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeEligibleCandidate("NEG Sent Candidate", opp.id);
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const invId = ((await resBody(await createInvitationRoute(req("/api/opportunities/invitations", "POST", { organizationId: org.id, opportunityId: opp.id, candidateUserId: candidate.id, offer: OFFER })))) as { invitation: { id: string } }).invitation.id;

    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    const early = await candidateCounterRoute(req(`/api/opportunities/me/invitations/${invId}/negotiations`, "POST", PROPOSAL(1_400_000_00, 1_700_000_00)), { params: Promise.resolve({ invitationId: invId }) });
    expect(early.status).toBe(409);
    expect(((await resBody(early)) as Record<string, unknown>).code).toBe("OX_INVITATION_NOT_ACTIONABLE");
    expect(await db.invitationNegotiation.count({ where: { invitationId: invId } })).toBe(0);
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invId } })).status).toBe("SENT");

    // Employer proposing on a SENT invitation is equally refused.
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    expect((await employerProposeRoute(req(`/api/opportunities/invitations/${invId}/negotiations`, "POST", { organizationId: org.id, terms: PROPOSAL(1_400_000_00, 1_700_000_00) }), { params: Promise.resolve({ invitationId: invId }) })).status).toBe(409);
    expect(await db.invitationNegotiation.count({ where: { invitationId: invId } })).toBe(0);
  });

  test("candidate detail renders the full append-only thread with truthful statuses (recipients see the same history the employer sees)", async () => {
    const { owner, org, candidate, invId } = await makeNegotiatingInvitation("Thread");
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    await employerProposeRoute(req(`/api/opportunities/invitations/${invId}/negotiations`, "POST", { organizationId: org.id, terms: PROPOSAL(1_300_000_00, 1_600_000_00) }), { params: Promise.resolve({ invitationId: invId }) });
    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    await candidateCounterRoute(req(`/api/opportunities/me/invitations/${invId}/negotiations`, "POST", PROPOSAL(1_500_000_00, 1_800_000_00)), { params: Promise.resolve({ invitationId: invId }) });

    const detail = (await resBody(await candidateDetailRoute(req(`/api/opportunities/me/invitations/${invId}`, "GET"), { params: Promise.resolve({ invitationId: invId }) }))) as {
      invitation: { status: string; negotiations: { seq: number; proposerRole: string; status: string; proposedSalaryMinPaise: number | null }[]; offer: { salaryMinPaise: number } };
    };
    expect(detail.invitation.status).toBe("NEGOTIATION_REQUESTED");
    expect(detail.invitation.negotiations).toHaveLength(2);
    expect(detail.invitation.negotiations[0].seq).toBe(1);
    expect(detail.invitation.negotiations[0].proposerRole).toBe("EMPLOYER");
    expect(detail.invitation.negotiations[0].status).toBe("SUPERSEDED");
    expect(detail.invitation.negotiations[0].proposedSalaryMinPaise).toBe(1_300_000_00);
    expect(detail.invitation.negotiations[1].seq).toBe(2);
    expect(detail.invitation.negotiations[1].status).toBe("PENDING");
    // The original offer is rendered above the thread (Part L) and unchanged.
    expect(detail.invitation.offer.salaryMinPaise).toBe(1_200_000_00);
  });
});
