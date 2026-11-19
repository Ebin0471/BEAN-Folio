import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

/**
 * M-O6 — invitation privacy & authorization suite (attack scenarios
 * IX-1…IX-7, IX-10, IX-11, IX-13, IX-14, IX-18, IX-20 + the RD-1/2/15/16/17
 * boundary pins and owner override B).
 *
 * The load-bearing invariant everywhere: invitation response rights are
 * recipient-identity rights, NOT discovery rights. A sent invitation never
 * becomes a profile backdoor, and employer-side candidate exposure is always
 * re-derived through the M-O4 boundary in the same request.
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
import { POST as createInvitationRoute, GET as listInvitationsRoute } from "@/app/api/opportunities/invitations/route";
import { GET as invitationDetailRoute } from "@/app/api/opportunities/invitations/[invitationId]/route";
import { GET as inboxRoute } from "@/app/api/opportunities/me/invitations/route";
import { GET as candidateDetailRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/route";
import { POST as candidateAcceptRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/accept/route";
import { POST as candidateDeclineRoute } from "@/app/api/opportunities/me/invitations/[invitationId]/decline/route";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

function req(path: string, method: string, body?: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `203.0.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
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

const PWD = await hashPassword("ox-priv-password-1");

async function makeUser(name: string, opts: { isDemo?: boolean } = {}) {
  return db.user.create({
    data: { email: `ox-priv-${randomUUID()}@beanfolio.test`, passwordHash: PWD, name, ...(opts.isDemo ? { isDemo: true } : {}) },
  });
}

async function makeVerifiedOrg(displayName: string, verificationStatus = "VERIFIED") {
  const owner = await makeUser(`${displayName} Owner`);
  await loginAs(owner.id);
  const org = await db.employerOrganization.create({
    data: {
      legalName: `${displayName} Pvt Ltd`,
      displayName,
      slug: `${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}`,
      verificationStatus,
      verificationMethod: verificationStatus === "VERIFIED" ? "MANUAL_REVIEW" : null,
      verifiedAt: verificationStatus === "VERIFIED" ? new Date() : null,
      createdByUserId: owner.id,
    },
  });
  await db.employerMembership.create({ data: { organizationId: org.id, userId: owner.id, role: "OWNER", status: "ACTIVE", joinedAt: new Date() } });
  return { owner, org };
}

async function addMember(orgId: string, userId: string, role: string, status = "ACTIVE") {
  await db.employerMembership.create({ data: { organizationId: orgId, userId, role, status, joinedAt: status === "ACTIVE" ? new Date() : null } });
}

async function makeOpportunity(orgId: string, ownerId: string, status = "PUBLISHED") {
  return db.opportunity.create({
    data: {
      organizationId: orgId,
      createdByUserId: ownerId,
      title: "Privacy opportunity",
      description: "An opportunity used to exercise invitation privacy behavior in tests.",
      status,
      employmentType: "FULL_TIME",
      workMode: "REMOTE",
      submittedAt: new Date(),
      publishedAt: status === "PUBLISHED" || status === "PAUSED" ? new Date() : null,
      salaryMinPaise: 500_000_00,
      salaryMaxPaise: 900_000_00,
      salaryCurrency: "INR",
      compensationPeriod: "YEAR",
    },
  });
}

/** Candidate rows written directly; `overrides` shapes the M-O4 boundary
 * outcome (visibility, consent, compensation policy, blocks). */
async function makeCandidate(
  name: string,
  opportunityId: string,
  opts: {
    visibility?: string;
    consent?: "CURRENT" | "REVOKED" | "EXPIRED" | "NONE";
    compensationVisibility?: string;
    withSalary?: boolean;
    withMatch?: boolean;
    shortlisted?: boolean;
    orgId?: string;
    blockedByCandidateAgainst?: string;
    blockedByUserAgainstCandidate?: string;
    deleted?: boolean;
    isDemo?: boolean;
  } = {}
) {
  const user = await makeUser(name, { isDemo: opts.isDemo });
  if (!opts.deleted) {
    await db.candidateOpportunityProfile.create({
      data: {
        userId: user.id,
        visibilityStatus: opts.visibility ?? "ACTIVE",
        employmentTypes: '["FULL_TIME"]',
        workModes: '["REMOTE"]',
        ...(opts.withSalary
          ? {
              salaryMinPaise: BigInt("180000000"),
              salaryMaxPaise: BigInt("240000000"),
              salaryCurrency: "INR",
              compensationPeriod: "YEAR",
              compensationVisibility: opts.compensationVisibility ?? "AFTER_INVITE",
            }
          : {}),
      },
    });
    if (opts.consent !== "NONE") {
      await db.candidateVisibilityConsent.create({
        data: {
          userId: user.id,
          scope: "DISCOVERY",
          status: opts.consent === "REVOKED" ? "REVOKED" : "GRANTED",
          consentVersion: "O2-CONSENT-V1",
          source: "CANDIDATE_UI",
          ...(opts.consent === "EXPIRED" ? { expiresAt: new Date(Date.now() - 60_000) } : {}),
          ...(opts.consent === "REVOKED" ? { revokedAt: new Date() } : {}),
        },
      });
    }
    if (opts.withMatch !== false) {
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
    }
    if (opts.shortlisted && opts.orgId) {
      await db.candidateShortlist.create({
        data: { organizationId: opts.orgId, opportunityId, candidateUserId: user.id, status: "ACTIVE", addedByUserId: null },
      });
    }
    if (opts.blockedByCandidateAgainst) {
      await db.block.create({ data: { blockerId: user.id, blockedId: opts.blockedByCandidateAgainst } });
    }
    if (opts.blockedByUserAgainstCandidate) {
      await db.block.create({ data: { blockerId: opts.blockedByUserAgainstCandidate, blockedId: user.id } });
    }
  }
  return user;
}

function offerTerms(min = 1_200_000_00, max = 1_500_000_00) {
  return { offerSalaryMinPaise: min, offerSalaryMaxPaise: max, offerCurrency: "INR", offerPeriod: "YEAR" };
}

async function invite(orgId: string, opportunityId: string, candidateUserId: string, actorUserId: string) {
  await loginAs(actorUserId);
  memoryBackend.resetForTests();
  return createInvitationRoute(
    req("/api/opportunities/invitations", "POST", { organizationId: orgId, opportunityId, candidateUserId, offer: offerTerms() })
  );
}

describe("M-O6 invitations — privacy, authorization & attack scenarios", () => {
  test("IX-1: anonymous inbox/detail/mutation attempts are 401", async () => {
    jar.clear();
    expect((await inboxRoute(req("/api/opportunities/me/invitations", "GET"))).status).toBe(401);
    expect((await candidateDetailRoute(req("/api/opportunities/me/invitations/cmwnfake", "GET"), { params: Promise.resolve({ invitationId: "cmwnfake" }) })).status).toBe(401);
    expect((await createInvitationRoute(req("/api/opportunities/invitations", "POST", { organizationId: "x", opportunityId: "x", candidateUserId: "x", offer: offerTerms() }))).status).toBe(401);
  });

  test("IX-2/IX-3: cross-tenant reads are 404 existence-hides (employer + candidate)", async () => {
    const orgA = await makeVerifiedOrg(`PRV Org A ${randomUUID().slice(0, 8)}`);
    const orgB = await makeVerifiedOrg(`PRV Org B ${randomUUID().slice(0, 8)}`);
    const oppA = await makeOpportunity(orgA.org.id, orgA.owner.id);
    const candidate = await makeCandidate("PRV Candidate X", oppA.id);
    const candidateB = await makeCandidate("PRV Candidate B-other", oppA.id);

    const inv = ((await resBody(await invite(orgA.org.id, oppA.id, candidate.id, orgA.owner.id))) as { invitation: { id: string } }).invitation.id;

    // Foreign org reads the invitation by id → 404.
    await loginAs(orgB.owner.id);
    expect(
      (await invitationDetailRoute(req(`/api/opportunities/invitations/${inv}?organizationId=${orgB.org.id}`, "GET"), { params: Promise.resolve({ invitationId: inv }) })).status
    ).toBe(404);
    // Foreign org list never contains it.
    const foreignList = (await resBody(await listInvitationsRoute(req(`/api/opportunities/invitations?organizationId=${orgB.org.id}`, "GET")))) as { invitations: { id: string }[] };
    expect(foreignList.invitations.find((i) => i.id === inv)).toBeUndefined();

    // Another candidate guesses the invitation id → 404; own inbox is empty.
    await loginAs(candidateB.id);
    expect(
      (await candidateDetailRoute(req(`/api/opportunities/me/invitations/${inv}`, "GET"), { params: Promise.resolve({ invitationId: inv }) })).status
    ).toBe(404);
    expect((await candidateAcceptRoute(req(`/api/opportunities/me/invitations/${inv}/accept`, "POST", {}), { params: Promise.resolve({ invitationId: inv }) })).status).toBe(404);
    expect((await candidateDeclineRoute(req(`/api/opportunities/me/invitations/${inv}/decline`, "POST", {}), { params: Promise.resolve({ invitationId: inv }) })).status).toBe(404);
    const otherInbox = (await resBody(await inboxRoute(req("/api/opportunities/me/invitations", "GET")))) as { invitations: { id: string }[] };
    expect(otherInbox.invitations.find((i) => i.id === inv)).toBeUndefined();
    // Zero writes happened to the row.
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: inv } })).status).toBe("SENT");
  });

  test("IX-4: HIRING_MANAGER and VIEWER are 404-deny on every invitation route", async () => {
    const { owner, org } = await makeVerifiedOrg(`PRV Org C ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeCandidate("PRV Candidate C", opp.id);
    const inv = ((await resBody(await invite(org.id, opp.id, candidate.id, owner.id))) as { invitation: { id: string } }).invitation.id;

    const hm = await makeUser("PRV HM");
    const viewer = await makeUser("PRV Viewer");
    await addMember(org.id, hm.id, "HIRING_MANAGER");
    await addMember(org.id, viewer.id, "VIEWER");

    for (const member of [hm, viewer]) {
      await loginAs(member.id);
      expect((await listInvitationsRoute(req(`/api/opportunities/invitations?organizationId=${org.id}`, "GET"))).status).toBe(404);
      expect((await invitationDetailRoute(req(`/api/opportunities/invitations/${inv}?organizationId=${org.id}`, "GET"), { params: Promise.resolve({ invitationId: inv }) })).status).toBe(404);
      expect((await createInvitationRoute(req("/api/opportunities/invitations", "POST", { organizationId: org.id, opportunityId: opp.id, candidateUserId: candidate.id, offer: offerTerms() }))).status).toBe(404);
    }
    expect(await db.opportunityInvitation.count({ where: { organizationId: org.id } })).toBe(1);
  });

  test("IX-5: UNVERIFIED org 403 OX_ORG_NOT_VERIFIED; SUSPENDED org 403 OX_ORG_SUSPENDED; non-ACTIVE member 404", async () => {
    const unverified = await makeVerifiedOrg(`PRV Org U ${randomUUID().slice(0, 8)}`, "UNVERIFIED");
    const suspended = await makeVerifiedOrg(`PRV Org S ${randomUUID().slice(0, 8)}`, "SUSPENDED");
    const oppU = await makeOpportunity(unverified.org.id, unverified.owner.id);
    const oppS = await makeOpportunity(suspended.org.id, suspended.owner.id);
    const cu = await makeCandidate("PRV Candidate U", oppU.id);
    const cs = await makeCandidate("PRV Candidate S", oppS.id);

    await loginAs(unverified.owner.id);
    memoryBackend.resetForTests();
    const r1 = await createInvitationRoute(req("/api/opportunities/invitations", "POST", { organizationId: unverified.org.id, opportunityId: oppU.id, candidateUserId: cu.id, offer: offerTerms() }));
    expect(r1.status).toBe(403);
    expect(((await resBody(r1)) as Record<string, unknown>).code).toBe("OX_ORG_NOT_VERIFIED");

    await loginAs(suspended.owner.id);
    memoryBackend.resetForTests();
    const r2 = await createInvitationRoute(req("/api/opportunities/invitations", "POST", { organizationId: suspended.org.id, opportunityId: oppS.id, candidateUserId: cs.id, offer: offerTerms() }));
    expect(r2.status).toBe(403);
    expect(((await resBody(r2)) as Record<string, unknown>).code).toBe("OX_ORG_SUSPENDED");

    // SUSPENDED membership of a VERIFIED org → 404 (requireOrgRole null).
    const org = await makeVerifiedOrg(`PRV Org V ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.org.id, org.owner.id);
    const cand = await makeCandidate("PRV Candidate V", opp.id);
    const recruiter = await makeUser("PRV Suspended Recruiter");
    await addMember(org.org.id, recruiter.id, "RECRUITER", "SUSPENDED");
    await loginAs(recruiter.id);
    memoryBackend.resetForTests();
    expect(
      (await createInvitationRoute(req("/api/opportunities/invitations", "POST", { organizationId: org.org.id, opportunityId: opp.id, candidateUserId: cand.id, offer: offerTerms() }))).status
    ).toBe(404);
    expect(await db.opportunityInvitation.count({ where: { candidateUserId: { in: [cu.id, cs.id, cand.id] } } })).toBe(0);
  });

  test("IX-6 + RD-1/RD-2: sends to ineligible candidates are generic 409 OX_CANDIDATE_NOT_ELIGIBLE with zero writes — revoked/expired consent, PAUSED, HIDDEN, INVITE_ONLY, blocks both ways, deleted/demo, and no source pointer", async () => {
    const { owner, org } = await makeVerifiedOrg(`PRV Org D ${randomUUID().slice(0, 8)}`);
    const member = await makeUser("PRV Member D");
    await addMember(org.id, member.id, "RECRUITER");
    const opp = await makeOpportunity(org.id, owner.id);

    const cases: { name: string; user: Awaited<ReturnType<typeof makeCandidate>> }[] = [];
    cases.push({ name: "consent revoked", user: await makeCandidate("PRV D revoked", opp.id, { consent: "REVOKED" }) });
    cases.push({ name: "consent expired", user: await makeCandidate("PRV D expired", opp.id, { consent: "EXPIRED" }) });
    cases.push({ name: "no consent row", user: await makeCandidate("PRV D noconsent", opp.id, { consent: "NONE" }) });
    cases.push({ name: "PAUSED profile", user: await makeCandidate("PRV D paused", opp.id, { visibility: "PAUSED" }) });
    cases.push({ name: "HIDDEN profile", user: await makeCandidate("PRV D hidden", opp.id, { visibility: "HIDDEN" }) });
    // RD-1: INVITE_ONLY behaves as HIDDEN — not discoverable, not invitable.
    cases.push({ name: "INVITE_ONLY profile", user: await makeCandidate("PRV D inviteonly", opp.id, { visibility: "INVITE_ONLY" }) });
    cases.push({ name: "candidate blocked a member", user: await makeCandidate("PRV D blockout", opp.id, { blockedByCandidateAgainst: member.id }) });
    cases.push({ name: "member blocked the candidate", user: await makeCandidate("PRV D blockin", opp.id, { blockedByUserAgainstCandidate: member.id }) });
    cases.push({ name: "deleted account", user: await makeCandidate("PRV D deleted", opp.id, { deleted: true }) });
    cases.push({ name: "demo account", user: await makeCandidate("PRV D demo", opp.id, { isDemo: true }) });

    for (const c of cases) {
      const res = await invite(org.id, opp.id, c.user.id, owner.id);
      expect(res.status).toBe(409);
      const body = (await resBody(res)) as Record<string, unknown>;
      expect(body.code).toBe("OX_CANDIDATE_NOT_ELIGIBLE");
      // Generic refusal — never reveals WHY (no consent/visibility/salary detail).
      expect(String(body.error)).not.toContain(c.name);
      expect(String(body.error).toLowerCase()).not.toContain("consent");
      expect(String(body.error).toLowerCase()).not.toContain("block");
      expect(String(body.error).toLowerCase()).not.toContain("hidden");
    }

    // RD-2: an eligible-by-boundary candidate with NO current TalentMatch and
    // NO active shortlist entry is not invitable (stored pointers are only
    // entry evidence — and they must be CURRENT for THIS opportunity).
    const noPointer = await makeCandidate("PRV D nopointer", opp.id, { withMatch: false });
    const res = await invite(org.id, opp.id, noPointer.id, owner.id);
    expect(res.status).toBe(409);
    expect(((await resBody(res)) as Record<string, unknown>).code).toBe("OX_CANDIDATE_NOT_ELIGIBLE");

    // A stale (expired) match pointer is equally insufficient.
    const stale = await makeCandidate("PRV D stale", opp.id);
    await db.talentMatch.updateMany({
      where: { opportunityId: opp.id, candidateUserId: stale.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const res2 = await invite(org.id, opp.id, stale.id, owner.id);
    expect(res2.status).toBe(409);
    expect(((await resBody(res2)) as Record<string, unknown>).code).toBe("OX_CANDIDATE_NOT_ELIGIBLE");

    // The shortlist path DOES admit an otherwise-pointerless candidate (RD-2
    // source B) — and the boundary still runs fresh.
    const shortlisted = await makeCandidate("PRV D shortlisted", opp.id, { withMatch: false, shortlisted: true, orgId: org.id });
    const ok = await invite(org.id, opp.id, shortlisted.id, owner.id);
    expect(ok.status).toBe(201);

    // Zero invitation rows for every refused candidate.
    expect(await db.opportunityInvitation.count({ where: { organizationId: org.id } })).toBe(1);
  });

  test("IX-10 + override B: consent revoked AFTER send — candidate retains read+respond; employer card fully masked with NO compensation; new sends refused", async () => {
    const { owner, org } = await makeVerifiedOrg(`PRV Org E ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    // AFTER_INVITE policy + disclosed salary: pre-revocation the employer
    // card must show it only after the boundary passes WITH a live invite.
    const candidate = await makeCandidate("PRV Candidate E", opp.id, { withSalary: true, compensationVisibility: "AFTER_INVITE" });
    const inv = ((await resBody(await invite(org.id, opp.id, candidate.id, owner.id))) as { invitation: { id: string } }).invitation.id;

    // While everything is live: the employer list card is LIVE and — RD-14 —
    // AFTER_INVITE compensation is disclosed (boundary passed + live invite).
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const liveList = (await resBody(await listInvitationsRoute(req(`/api/opportunities/invitations?organizationId=${org.id}`, "GET")))) as {
      invitations: { id: string; candidateState: string; candidate?: { compensation?: { minPaise: number } | null } | null }[];
    };
    const liveCard = liveList.invitations.find((i) => i.id === inv)!;
    expect(liveCard.candidateState).toBe("LIVE");
    expect(liveCard.candidate?.compensation?.minPaise).toBe(1_800_000_00);

    // Revoke DISCOVERY consent (the O2 route force-hides the profile too).
    await db.candidateVisibilityConsent.updateMany({
      where: { userId: candidate.id, scope: "DISCOVERY" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    await db.candidateOpportunityProfile.update({ where: { userId: candidate.id }, data: { visibilityStatus: "HIDDEN" } });

    // Employer side: the card is masked and carries NO candidate content and
    // NO compensation — a live invitation is not a backdoor (override B).
    memoryBackend.resetForTests();
    const maskedList = (await resBody(await listInvitationsRoute(req(`/api/opportunities/invitations?organizationId=${org.id}`, "GET")))) as {
      invitations: { id: string; candidateState: string; candidate?: unknown }[];
    };
    const maskedCard = maskedList.invitations.find((i) => i.id === inv)!;
    expect(maskedCard.candidateState).toBe("MASKED_CONSENT");
    expect(maskedCard.candidate).toBeUndefined();
    expect(JSON.stringify(maskedList.invitations.find((i) => i.id === inv))).not.toContain("compensation");
    // The invitation's own record (offer snapshot, state) remains — employer data.
    expect(maskedCard.candidateState).toBe("MASKED_CONSENT");

    // New invitations to that candidate are refused (consent revoked).
    const candidate2 = await makeCandidate("PRV Candidate E2", opp.id, { consent: "REVOKED" });
    memoryBackend.resetForTests();
    const refused = await invite(org.id, opp.id, candidate2.id, owner.id);
    expect(refused.status).toBe(409);
    expect(((await resBody(refused)) as Record<string, unknown>).code).toBe("OX_CANDIDATE_NOT_ELIGIBLE");

    // Candidate side: recipient rights survive (override B) — inbox shows
    // the invitation, detail renders, accept works.
    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    const inbox = (await resBody(await inboxRoute(req("/api/opportunities/me/invitations", "GET")))) as { invitations: { id: string }[] };
    expect(inbox.invitations.find((i) => i.id === inv)).toBeDefined();
    const detail = (await resBody(await candidateDetailRoute(req(`/api/opportunities/me/invitations/${inv}`, "GET"), { params: Promise.resolve({ invitationId: inv }) }))) as {
      invitation: { status: string; offer: { salaryMinPaise: number } };
    };
    expect(detail.invitation.status).toBe("VIEWED");
    expect(detail.invitation.offer.salaryMinPaise).toBe(1_200_000_00);
    memoryBackend.resetForTests();
    const accepted = await candidateAcceptRoute(req(`/api/opportunities/me/invitations/${inv}/accept`, "POST", {}), { params: Promise.resolve({ invitationId: inv }) });
    expect(accepted.status).toBe(200);
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: inv } })).status).toBe("ACCEPTED");
  });

  test("IX-11: editing the opportunity's salary after send leaves the invitation offer AND accepted terms byte-identical", async () => {
    const { owner, org } = await makeVerifiedOrg(`PRV Org F ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeCandidate("PRV Candidate F", opp.id);
    const inv = ((await resBody(await invite(org.id, opp.id, candidate.id, owner.id))) as { invitation: { id: string } }).invitation.id;
    const before = await db.opportunityInvitation.findUniqueOrThrow({ where: { id: inv } });

    // Direct accept (stamps accepted terms), then edit the opportunity salary.
    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    await candidateAcceptRoute(req(`/api/opportunities/me/invitations/${inv}/accept`, "POST", {}), { params: Promise.resolve({ invitationId: inv }) });
    await db.opportunity.update({
      where: { id: opp.id },
      data: { salaryMinPaise: BigInt("900000000"), salaryMaxPaise: BigInt("950000000"), salaryCurrency: "USD", compensationPeriod: "MONTH" },
    });

    const after = await db.opportunityInvitation.findUniqueOrThrow({ where: { id: inv } });
    expect(after.offerSalaryMinPaise).toBe(before.offerSalaryMinPaise);
    expect(after.offerSalaryMaxPaise).toBe(before.offerSalaryMaxPaise);
    expect(after.offerCurrency).toBe(before.offerCurrency);
    expect(after.offerPeriod).toBe(before.offerPeriod);
    expect(after.acceptedSalaryMinPaise).toBe(before.offerSalaryMinPaise);
    expect(after.acceptedSalaryMaxPaise).toBe(before.offerSalaryMaxPaise);
    expect(after.acceptedCurrency).toBe("INR");
    expect(after.acceptedPeriod).toBe("YEAR");
  });

  test("IX-18: AFTER_INVITE disclosure tracks the live-invitation state exactly — off before, on with a live invite, off after withdrawal", async () => {
    const { owner, org } = await makeVerifiedOrg(`PRV Org G ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeCandidate("PRV Candidate G", opp.id, { withSalary: true, compensationVisibility: "AFTER_INVITE" });

    // BEFORE any invitation: the candidate's match card must withhold the
    // salary (AFTER_INVITE requires a live invite — hasActiveInvite false).
    const { GET: matchDetailRoute } = await import("@/app/api/employers/[id]/opportunities/[opportunityId]/matches/[candidateUserId]/route");
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const cardBefore = (await resBody(
      await matchDetailRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches/${candidate.id}`, "GET"), { params: Promise.resolve({ id: org.id, opportunityId: opp.id, candidateUserId: candidate.id }) })
    )) as { state: string; candidate?: { compensation?: unknown } | null };
    expect(cardBefore.state).toBe("LIVE");
    expect(cardBefore.candidate?.compensation ?? null).toBeNull();

    // Send the invitation → disclosure activates on employer surfaces.
    const inv = ((await resBody(await invite(org.id, opp.id, candidate.id, owner.id))) as { invitation: { id: string } }).invitation.id;
    memoryBackend.resetForTests();
    const list = (await resBody(await listInvitationsRoute(req(`/api/opportunities/invitations?organizationId=${org.id}`, "GET")))) as {
      invitations: { id: string; candidate?: { compensation?: unknown } | null }[];
    };
    expect(list.invitations.find((i) => i.id === inv)!.candidate?.compensation).not.toBeNull();

    // Withdraw → the invitation is no longer live → disclosure reverts.
    const { POST: withdrawRoute } = await import("@/app/api/opportunities/invitations/[invitationId]/withdraw/route");
    memoryBackend.resetForTests();
    expect((await withdrawRoute(req(`/api/opportunities/invitations/${inv}/withdraw`, "POST", { organizationId: org.id }), { params: Promise.resolve({ invitationId: inv }) })).status).toBe(200);
    memoryBackend.resetForTests();
    const listAfter = (await resBody(await listInvitationsRoute(req(`/api/opportunities/invitations?organizationId=${org.id}`, "GET")))) as {
      invitations: { id: string; candidate?: { compensation?: unknown } | null }[];
    };
    expect(listAfter.invitations.find((i) => i.id === inv)!.candidate?.compensation ?? null).toBeNull();
  });

  test("IX-13: notification payloads, audit metas and error bodies never carry compensation values, contact fields or profile content", async () => {
    const { owner, org } = await makeVerifiedOrg(`PRV Org H ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeCandidate("PRV Candidate H", opp.id, { withSalary: true, compensationVisibility: "AFTER_INVITE" });
    const inv = ((await resBody(await invite(org.id, opp.id, candidate.id, owner.id))) as { invitation: { id: string } }).invitation.id;

    // Advance the thread so every notification type fires.
    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    const { POST: negotiationRequestRoute } = await import("@/app/api/opportunities/me/invitations/[invitationId]/negotiation-request/route");
    await negotiationRequestRoute(req(`/api/opportunities/me/invitations/${inv}/negotiation-request`, "POST", {}), { params: Promise.resolve({ invitationId: inv }) });
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const { POST: employerProposeRoute } = await import("@/app/api/opportunities/invitations/[invitationId]/negotiations/route");
    await employerProposeRoute(
      req(`/api/opportunities/invitations/${inv}/negotiations`, "POST", { organizationId: org.id, terms: { proposedSalaryMinPaise: 1_300_000_00, proposedSalaryMaxPaise: 1_600_000_00, proposedCurrency: "INR", proposedPeriod: "YEAR" } }),
      { params: Promise.resolve({ invitationId: inv }) }
    );

    // Every notification touching this invitation.
    const notes = await db.notification.findMany({ where: { dedupKey: { contains: `hiring:invitation:${inv}` } } });
    expect(notes.length).toBeGreaterThanOrEqual(2);
    const forbidden = ["180000000", "240000000", "130000000", "160000000", "contact", "contactEmail", "salaryMinPaise", "salaryMaxPaise", "compensationVisibility", "email"];
    for (const n of notes) {
      const payload = JSON.stringify(JSON.parse(n.payload));
      for (const token of forbidden) expect(payload).not.toContain(token);
    }

    // Every audit row touching this invitation.
    const audits = await db.auditEvent.findMany({ where: { targetId: inv } });
    expect(audits.length).toBeGreaterThanOrEqual(3);
    for (const a of audits) {
      const meta = JSON.stringify(JSON.parse(a.meta));
      for (const token of forbidden) expect(meta).not.toContain(token);
    }
  });

  test("IX-14: quotas bind at SEND only — drafts consume no quota and stay invisible; a draft send runs all gates", async () => {
    const { owner, org } = await makeVerifiedOrg(`PRV Org I ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeCandidate("PRV Candidate I", opp.id);
    await loginAs(owner.id);

    memoryBackend.resetForTests();
    const draft = await createInvitationRoute(
      req("/api/opportunities/invitations", "POST", { organizationId: org.id, opportunityId: opp.id, candidateUserId: candidate.id, send: false, offer: offerTerms() })
    );
    expect(draft.status).toBe(201);
    const draftId = ((await resBody(draft)) as { invitation: { id: string } }).invitation.id;

    // The candidate can neither see the draft in the inbox nor open it by id.
    await loginAs(candidate.id);
    expect(
      (await candidateDetailRoute(req(`/api/opportunities/me/invitations/${draftId}`, "GET"), { params: Promise.resolve({ invitationId: draftId }) })).status
    ).toBe(404);
    const inbox = (await resBody(await inboxRoute(req("/api/opportunities/me/invitations", "GET")))) as { invitations: { id: string }[] };
    expect(inbox.invitations.find((i) => i.id === draftId)).toBeUndefined();
    expect(await db.notification.count({ where: { userId: candidate.id } })).toBe(0);

    // A draft can NEVER be responded to (transitions are guarded on
    // SENT/VIEWED; the recipient-only binding 404s first anyway).
    expect((await candidateAcceptRoute(req(`/api/opportunities/me/invitations/${draftId}/accept`, "POST", {}), { params: Promise.resolve({ invitationId: draftId }) })).status).toBe(404);
  });

  test("IX-20: candidate account deletion anonymizes the hiring history (SetNull) without dangling FKs; employer renders a content-free row", async () => {
    const { owner, org } = await makeVerifiedOrg(`PRV Org J ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeCandidate("PRV Candidate J", opp.id);
    const inv = ((await resBody(await invite(org.id, opp.id, candidate.id, owner.id))) as { invitation: { id: string } }).invitation.id;

    // Candidate counter-proposal first (proposerUserId provenance).
    await loginAs(candidate.id);
    memoryBackend.resetForTests();
    const { POST: negotiationRequestRoute } = await import("@/app/api/opportunities/me/invitations/[invitationId]/negotiation-request/route");
    await negotiationRequestRoute(
      req(`/api/opportunities/me/invitations/${inv}/negotiation-request`, "POST", { terms: { proposedSalaryMinPaise: 1_400_000_00, proposedSalaryMaxPaise: 1_700_000_00, proposedCurrency: "INR", proposedPeriod: "YEAR" } }),
      { params: Promise.resolve({ invitationId: inv }) }
    );

    // Delete the candidate account (schema-level SetNull on recipient +
    // proposer; matches/shortlists keep their existing Cascade behavior).
    await db.user.delete({ where: { id: candidate.id } });

    const row = await db.opportunityInvitation.findUniqueOrThrow({ where: { id: inv } });
    expect(row.candidateUserId).toBeNull();
    const proposals = await db.invitationNegotiation.findMany({ where: { invitationId: inv } });
    expect(proposals.length).toBe(1);
    expect(proposals[0].proposerUserId).toBeNull();
    // No dangling references anywhere.
    expect(await db.user.count({ where: { id: candidate.id } })).toBe(0);
    // Employer list renders the anonymized row with no candidate content.
    await loginAs(owner.id);
    memoryBackend.resetForTests();
    const list = (await resBody(await listInvitationsRoute(req(`/api/opportunities/invitations?organizationId=${org.id}`, "GET")))) as {
      invitations: { id: string; candidateUserId: string | null; candidateState: string; candidate?: unknown }[];
    };
    const anon = list.invitations.find((i) => i.id === inv)!;
    expect(anon.candidateUserId).toBeNull();
    expect(anon.candidate).toBeUndefined();
    expect(JSON.stringify(anon)).not.toContain("PRV Candidate J");
  });

  test("BigInt boundaries: ₹10 crore ceiling accepted exactly; over-ceiling and min>max refused 400", async () => {
    const { owner, org } = await makeVerifiedOrg(`PRV Org K ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id);
    const candidate = await makeCandidate("PRV Candidate K", opp.id);
    await loginAs(owner.id);

    // Exactly at the approved ceiling: 10_000_000_000 paise = ₹10 crore.
    memoryBackend.resetForTests();
    const atCeiling = await createInvitationRoute(
      req("/api/opportunities/invitations", "POST", {
        organizationId: org.id,
        opportunityId: opp.id,
        candidateUserId: candidate.id,
        offer: { offerSalaryMinPaise: 10_000_000_000, offerSalaryMaxPaise: 10_000_000_000, offerCurrency: "INR", offerPeriod: "YEAR" },
      })
    );
    expect(atCeiling.status).toBe(201);
    const invId = ((await resBody(atCeiling)) as { invitation: { id: string } }).invitation.id;
    expect((await db.opportunityInvitation.findUniqueOrThrow({ where: { id: invId } })).offerSalaryMaxPaise).toBe(BigInt("10000000000"));

    // Over the ceiling → 400 before any write.
    const other = await makeCandidate("PRV Candidate K2", opp.id);
    memoryBackend.resetForTests();
    const overCeiling = await createInvitationRoute(
      req("/api/opportunities/invitations", "POST", {
        organizationId: org.id,
        opportunityId: opp.id,
        candidateUserId: other.id,
        offer: { offerSalaryMinPaise: 0, offerSalaryMaxPaise: 10_000_000_001, offerCurrency: "INR", offerPeriod: "YEAR" },
      })
    );
    expect(overCeiling.status).toBe(400);

    // min > max → 400.
    memoryBackend.resetForTests();
    const minAboveMax = await createInvitationRoute(
      req("/api/opportunities/invitations", "POST", {
        organizationId: org.id,
        opportunityId: opp.id,
        candidateUserId: other.id,
        offer: { offerSalaryMinPaise: 1_500_000_00, offerSalaryMaxPaise: 1_200_000_00, offerCurrency: "INR", offerPeriod: "YEAR" },
      })
    );
    expect(minAboveMax.status).toBe(400);
    expect(await db.opportunityInvitation.count({ where: { candidateUserId: other.id } })).toBe(0);

    // Free text is structurally impossible (RD-8): strict zod refuses extra keys.
    memoryBackend.resetForTests();
    const withFreeText = await createInvitationRoute(
      req("/api/opportunities/invitations", "POST", {
        organizationId: org.id,
        opportunityId: opp.id,
        candidateUserId: other.id,
        offer: { ...offerTerms(), termsNote: "please call me" },
      })
    );
    expect(withFreeText.status).toBe(400);
  });
});
