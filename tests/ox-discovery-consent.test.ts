import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

/**
 * M-O4 — consent + visibility boundary tests (T1–T7, T13).
 *
 * The authoritative boundary `assertCandidateDiscoverableToOrg` must deny:
 *   T1 missing consent · T2 stale consent vocabulary · T3 expired consent ·
 *   T4 revoked consent · T5 HIDDEN · T6 PAUSED · T7 INVITE_ONLY (v1: HIDDEN)
 * and allow only current-consent + ACTIVE candidates. Purpose isolation is
 * pinned (PROFILE_ANALYTICS never satisfies DISCOVERY). T13: the boundary
 * re-reads the ledger on EVERY call — a revocation between two calls flips
 * the answer within one request cycle.
 *
 * API-level: the live match list reflects the same states through truthful
 * masked cards, never through errors that leak existence.
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
import { hashPassword, createSession } from "@/lib/auth";
import { assertCandidateDiscoverableToOrg, getOrgActiveMemberUserIds } from "@/lib/ox/discovery";
import { grantConsent, revokeConsent } from "@/lib/ox/consent";
import { PUT as putProfileRoute } from "@/app/api/opportunities/me/profile/route";
import { POST as visibilityRoute } from "@/app/api/opportunities/me/visibility/route";
import { GET as matchesListRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/matches/route";

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

const COMPLETE_SALARY = {
  salaryMinPaise: 500_000_00,
  salaryMaxPaise: 900_000_00,
  salaryCurrency: "INR",
  compensationPeriod: "YEAR",
};

async function makeUser(name: string) {
  return db.user.create({
    data: {
      email: `ox-disc-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("ox-disc-password-1"),
      name,
    },
  });
}

async function makeVerifiedOrgWithPublishedOpportunity(displayName: string) {
  const owner = await makeUser("Disc Owner");
  await loginAs(owner.id);
  const org = await db.employerOrganization.create({
    data: { legalName: `${displayName} Pvt Ltd`, displayName, slug: `${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}`, verificationStatus: "VERIFIED", verificationMethod: "MANUAL_REVIEW", verifiedAt: new Date(), createdByUserId: owner.id },
  });
  await db.employerMembership.create({ data: { organizationId: org.id, userId: owner.id, role: "OWNER", status: "ACTIVE", joinedAt: new Date() } });
  const opportunity = await db.opportunity.create({
    data: {
      organizationId: org.id,
      createdByUserId: owner.id,
      title: "Discovery boundary opportunity",
      description: "An opportunity used to exercise the discovery boundary in tests.",
      status: "PUBLISHED",
      employmentType: "FULL_TIME",
      workMode: "REMOTE",
      submittedAt: new Date(),
      publishedAt: new Date(),
      ...COMPLETE_SALARY,
    },
  });
  await loginAs(owner.id);
  return { owner, org, opportunity };
}

/** Give a candidate a fully ACTIVE, consented profile through the O2 API. */
async function makeDiscoverableCandidate(name: string) {
  const user = await makeUser(name);
  await loginAs(user.id);
  await putProfileRoute(
    req("/api/opportunities/me/profile", "PUT", {
      employmentTypes: ["FULL_TIME"],
      workModes: ["REMOTE"],
      preferredLocations: ["Chennai"],
      availableFrom: new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString(),
    })
  );
  await db.candidateVisibilityConsent.create({
    data: { userId: user.id, scope: "DISCOVERY", status: "GRANTED", consentVersion: "O2-CONSENT-V1", source: "CANDIDATE_UI" },
  });
  await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" }));
  const profile = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
  return { user, profile: profile! };
}

const oppFor = (o: { id: string; status: string; employmentType: string | null; workMode: string | null; location: string | null; professionId: string | null; salaryMinPaise: bigint | null; salaryMaxPaise: bigint | null; salaryCurrency: string | null; compensationPeriod: string | null }) => ({
  id: o.id,
  status: o.status,
  employmentType: o.employmentType,
  workMode: o.workMode,
  location: o.location,
  professionId: o.professionId,
  salaryMinPaise: o.salaryMinPaise,
  salaryMaxPaise: o.salaryMaxPaise,
  salaryCurrency: o.salaryCurrency,
  compensationPeriod: o.compensationPeriod,
});

describe("M-O4 consent boundary — T1..T7 (the one authoritative function)", () => {
  let ctx: Awaited<ReturnType<typeof makeVerifiedOrgWithPublishedOpportunity>>;

  test("setup", async () => {
    ctx = await makeVerifiedOrgWithPublishedOpportunity(`Disc Org ${randomUUID().slice(0, 8)}`);
  });

  test("T1 — missing consent is denial, never permission", async () => {
    const candidate = await makeUser("T1 No Consent");
    await db.candidateOpportunityProfile.create({
      data: { userId: candidate.id, visibilityStatus: "ACTIVE", employmentTypes: JSON.stringify(["FULL_TIME"]) },
    });
    const members = await getOrgActiveMemberUserIds(ctx.org.id);
    const result = await assertCandidateDiscoverableToOrg({
      candidateUserId: candidate.id,
      organizationId: ctx.org.id,
      opportunity: oppFor(ctx.opportunity),
      memberUserIds: members,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("CONSENT_INVALID");
  });

  test("T2 — a stale-vocabulary consent grant is not a current DISCOVERY consent", async () => {
    const candidate = await makeUser("T2 Stale Version");
    await db.candidateOpportunityProfile.create({
      data: { userId: candidate.id, visibilityStatus: "ACTIVE" },
    });
    await db.candidateVisibilityConsent.create({
      data: { userId: candidate.id, scope: "DISCOVERY", status: "GRANTED", consentVersion: "O0-CONSENT-DRAFT", source: "CANDIDATE_UI" },
    });
    const members = await getOrgActiveMemberUserIds(ctx.org.id);
    const result = await assertCandidateDiscoverableToOrg({
      candidateUserId: candidate.id,
      organizationId: ctx.org.id,
      opportunity: oppFor(ctx.opportunity),
      memberUserIds: members,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("CONSENT_INVALID");
  });

  test("T3 — an expired consent grant is not a current consent", async () => {
    const candidate = await makeUser("T3 Expired");
    await db.candidateOpportunityProfile.create({
      data: { userId: candidate.id, visibilityStatus: "ACTIVE" },
    });
    await db.candidateVisibilityConsent.create({
      data: {
        userId: candidate.id,
        scope: "DISCOVERY",
        status: "GRANTED",
        consentVersion: "O2-CONSENT-V1",
        source: "CANDIDATE_UI",
        grantedAt: new Date(Date.now() - 10 * 24 * 60 * 60_000),
        expiresAt: new Date(Date.now() - 24 * 60 * 60_000),
      },
    });
    const members = await getOrgActiveMemberUserIds(ctx.org.id);
    const result = await assertCandidateDiscoverableToOrg({
      candidateUserId: candidate.id,
      organizationId: ctx.org.id,
      opportunity: oppFor(ctx.opportunity),
      memberUserIds: members,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("CONSENT_INVALID");
  });

  test("T4 — revocation is immediate: granted then revoked flips eligibility", async () => {
    const candidate = await makeDiscoverableCandidate("T4 Revoked");
    const members = await getOrgActiveMemberUserIds(ctx.org.id);
    const before = await assertCandidateDiscoverableToOrg({
      candidateUserId: candidate.user.id,
      organizationId: ctx.org.id,
      opportunity: oppFor(ctx.opportunity),
      memberUserIds: members,
    });
    expect(before.ok).toBe(true);

    await loginAs(candidate.user.id);
    await revokeConsent({ userId: candidate.user.id, scope: "DISCOVERY", actorUserId: candidate.user.id });
    // Consent revocation also forces the profile to HIDDEN (O2 invariant).
    const profileAfter = await db.candidateOpportunityProfile.findUnique({ where: { userId: candidate.user.id } });
    expect(profileAfter?.visibilityStatus).toBe("HIDDEN");

    const after = await assertCandidateDiscoverableToOrg({
      candidateUserId: candidate.user.id,
      organizationId: ctx.org.id,
      opportunity: oppFor(ctx.opportunity),
      memberUserIds: members,
    });
    expect(after.ok).toBe(false);
  });

  test("T5 — HIDDEN visibility is never discoverable even with a current grant", async () => {
    const candidate = await makeDiscoverableCandidate("T5 Hidden");
    await loginAs(candidate.user.id);
    await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "HIDDEN" }));
    const members = await getOrgActiveMemberUserIds(ctx.org.id);
    const result = await assertCandidateDiscoverableToOrg({
      candidateUserId: candidate.user.id,
      organizationId: ctx.org.id,
      opportunity: oppFor(ctx.opportunity),
      memberUserIds: members,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("VISIBILITY_NOT_DISCOVERABLE");
  });

  test("T6 — PAUSED visibility is masked immediately (display stops, data preserved)", async () => {
    const candidate = await makeDiscoverableCandidate("T6 Paused");
    await loginAs(candidate.user.id);
    await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "PAUSED" }));
    const members = await getOrgActiveMemberUserIds(ctx.org.id);
    const result = await assertCandidateDiscoverableToOrg({
      candidateUserId: candidate.user.id,
      organizationId: ctx.org.id,
      opportunity: oppFor(ctx.opportunity),
      memberUserIds: members,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("VISIBILITY_NOT_DISCOVERABLE");
    // Data preserved: profile + consent ledger rows still exist.
    expect(await db.candidateOpportunityProfile.findUnique({ where: { userId: candidate.user.id } })).not.toBeNull();
    const ledger = await db.candidateVisibilityConsent.findMany({ where: { userId: candidate.user.id, scope: "DISCOVERY" } });
    expect(ledger.length).toBe(1);
    expect(ledger[0].status).toBe("GRANTED");
  });

  test("T7 — INVITE_ONLY behaves as HIDDEN in v1 (D8)", async () => {
    const candidate = await makeDiscoverableCandidate("T7 InviteOnly");
    await loginAs(candidate.user.id);
    await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "INVITE_ONLY" }));
    const members = await getOrgActiveMemberUserIds(ctx.org.id);
    const result = await assertCandidateDiscoverableToOrg({
      candidateUserId: candidate.user.id,
      organizationId: ctx.org.id,
      opportunity: oppFor(ctx.opportunity),
      memberUserIds: members,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("VISIBILITY_NOT_DISCOVERABLE");
  });

  test("purpose isolation — a PROFILE_ANALYTICS grant never satisfies DISCOVERY", async () => {
    const candidate = await makeUser("T8 Purpose Isolation");
    await db.candidateOpportunityProfile.create({ data: { userId: candidate.id, visibilityStatus: "ACTIVE" } });
    await db.candidateVisibilityConsent.create({
      data: { userId: candidate.id, scope: "PROFILE_ANALYTICS", status: "GRANTED", consentVersion: "O2-CONSENT-V1", source: "CANDIDATE_UI" },
    });
    const members = await getOrgActiveMemberUserIds(ctx.org.id);
    const result = await assertCandidateDiscoverableToOrg({
      candidateUserId: candidate.id,
      organizationId: ctx.org.id,
      opportunity: oppFor(ctx.opportunity),
      memberUserIds: members,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("CONSENT_INVALID");
  });

  test("T13 — the boundary re-reads the ledger on every call (no TOCTOU flag)", async () => {
    const candidate = await makeDiscoverableCandidate("T13 MidRequest");
    const members = await getOrgActiveMemberUserIds(ctx.org.id);
    const first = await assertCandidateDiscoverableToOrg({
      candidateUserId: candidate.user.id,
      organizationId: ctx.org.id,
      opportunity: oppFor(ctx.opportunity),
      memberUserIds: members,
    });
    expect(first.ok).toBe(true);
    // Revoke "during the request" and re-check through the SAME function.
    await revokeConsent({ userId: candidate.user.id, scope: "DISCOVERY", actorUserId: candidate.user.id });
    const second = await assertCandidateDiscoverableToOrg({
      candidateUserId: candidate.user.id,
      organizationId: ctx.org.id,
      opportunity: oppFor(ctx.opportunity),
      memberUserIds: members,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("CONSENT_INVALID");
  });
});

describe("M-O4 consent boundary — API truthfulness", () => {
  test("a candidate who revokes mid-stream masks in the employer match list in the SAME request", async () => {
    const ctx = await makeVerifiedOrgWithPublishedOpportunity(`Disc Org API ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("T13 API Candidate");
    await loginAs(ctx.owner.id);
    const list1 = await matchesListRoute(
      req(`/api/employers/${ctx.org.id}/opportunities/${ctx.opportunity.id}/matches`, "GET"),
      { params: Promise.resolve({ id: ctx.org.id, opportunityId: ctx.opportunity.id }) }
    );
    expect(list1.status).toBe(200);
    const body1 = (await list1.json()) as { matchState: string; total: number; matches: Record<string, unknown>[] };
    expect(body1.matchState).toBe("LIVE");
    // (The QA database is shared across the per-file suite: other tests'
    // consented candidates may legitimately appear; the list page is the
    // top-25 by score, so per-candidate presence is asserted on the STORED
    // row — the authoritative D3 record.)
    expect(body1.total).toBeGreaterThanOrEqual(1);
    expect(
      await db.talentMatch.count({ where: { opportunityId: ctx.opportunity.id, candidateUserId: candidate.user.id } })
    ).toBe(1);

    // Candidate revokes (forces HIDDEN) — next employer request must mask.
    await loginAs(candidate.user.id);
    await revokeConsent({ userId: candidate.user.id, scope: "DISCOVERY", actorUserId: candidate.user.id });
    await loginAs(ctx.owner.id);
    const list2 = await matchesListRoute(
      req(`/api/employers/${ctx.org.id}/opportunities/${ctx.opportunity.id}/matches`, "GET"),
      { params: Promise.resolve({ id: ctx.org.id, opportunityId: ctx.opportunity.id }) }
    );
    const body2 = (await list2.json()) as { matchState: string; total: number; matches: Record<string, unknown>[] };
    // LIVE recomputation surfaces ONLY currently-consented candidates — the
    // revoked candidate is gone entirely (no masked card in a live list,
    // no data, no identifier).
    expect(body2.matchState).toBe("LIVE");
    expect(body2.matches.some((m) => m.candidateUserId === candidate.user.id)).toBe(false);
    expect(JSON.stringify(body2)).not.toContain(candidate.user.id);
  });
});
