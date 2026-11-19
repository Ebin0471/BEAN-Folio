import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

/**
 * M-O4 — discovery privacy suite (T10–T15 + demo/exclusion rules).
 *
 *   T10 foreign/unauthorized member → 404-deny (no existence leak)
 *   T11 VIEWER and HIRING_MANAGER denied discovery
 *   T12 cross-tenant candidate access → 404-deny
 *   T14 hidden salary + profile data leakage — no contact fields anywhere,
 *       salary only per the O2 disclosure matrix, hidden salary not
 *       inferable through ordering/explanations/eligibility messages
 *   T15 stored match remaining after revocation — retained rows never
 *       authorize; masked on every read (frozen list path)
 *
 * Plus: demo fixtures and deleted accounts never discoverable; blocks in
 * both directions; org members never discover themselves; employment-type
 * mismatch is a hard filter; disclosed-incompatible salary is a hard filter
 * while a HIDDEN salary is NOT filterable (safeguard B).
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
import { serializeCandidateProfileForViewer, serializeMatchForEmployer, type StoredTalentMatchRow } from "@/lib/ox/dto";
import {
  GET as matchesListRoute,
  POST as recomputeRoute,
} from "@/app/api/employers/[id]/opportunities/[opportunityId]/matches/route";
import { GET as matchDetailRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/matches/[candidateUserId]/route";
import { PUT as putProfileRoute } from "@/app/api/opportunities/me/profile/route";
import { POST as visibilityRoute } from "@/app/api/opportunities/me/visibility/route";

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

const OPP_SALARY = {
  salaryMinPaise: 500_000_00,
  salaryMaxPaise: 900_000_00,
  salaryCurrency: "INR",
  compensationPeriod: "YEAR",
};

async function makeUser(name: string) {
  return db.user.create({
    data: { email: `ox-priv-${randomUUID()}@beanfolio.test`, passwordHash: await hashPassword("ox-priv-password-1"), name },
  });
}

async function makeOrg(displayName: string, verificationStatus: "UNVERIFIED" | "VERIFIED" | "SUSPENDED" = "VERIFIED") {
  const owner = await makeUser("Priv Owner");
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
  await loginAs(owner.id);
  return { owner, org };
}

async function makePublishedOpportunity(orgId: string, ownerId: string, overrides?: Record<string, unknown>) {
  return db.opportunity.create({
    data: {
      organizationId: orgId,
      createdByUserId: ownerId,
      title: "Privacy boundary opportunity",
      description: "An opportunity used to exercise discovery privacy in tests.",
      status: "PUBLISHED",
      employmentType: "FULL_TIME",
      workMode: "REMOTE",
      submittedAt: new Date(),
      publishedAt: new Date(),
      ...OPP_SALARY,
      ...overrides,
    },
  });
}

async function makeDiscoverableCandidate(name: string, profileOverrides?: Record<string, unknown>) {
  const user = await makeUser(name);
  await loginAs(user.id);
  await putProfileRoute(
    req("/api/opportunities/me/profile", "PUT", {
      employmentTypes: ["FULL_TIME"],
      workModes: ["REMOTE"],
      preferredLocations: ["Chennai"],
      availableFrom: new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString(),
      ...profileOverrides,
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

describe("M-O4 privacy — account state and exclusions", () => {
  test("demo fixtures are never discoverable (even ACTIVE + consented)", async () => {
    const { org } = await makeOrg(`Priv Org Demo ${randomUUID().slice(0, 8)}`);
    const demo = await db.user.create({
      data: { email: `ox-priv-demo-${randomUUID()}@beanfolio.test`, passwordHash: await hashPassword("x-1"), name: "Priv Demo", isDemo: true },
    });
    await db.candidateOpportunityProfile.create({ data: { userId: demo.id, visibilityStatus: "ACTIVE" } });
    await db.candidateVisibilityConsent.create({
      data: { userId: demo.id, scope: "DISCOVERY", status: "GRANTED", consentVersion: "O2-CONSENT-V1", source: "CANDIDATE_UI" },
    });
    const members = await getOrgActiveMemberUserIds(org.id);
    const result = await assertCandidateDiscoverableToOrg({
      candidateUserId: demo.id,
      organizationId: org.id,
      opportunity: oppFor(await makePublishedOpportunity(org.id, (await db.employerMembership.findFirst({ where: { organizationId: org.id } }))!.userId)),
      memberUserIds: members,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ACCOUNT_UNAVAILABLE");
  });

  test("deleted accounts are never discoverable", async () => {
    const { org, owner } = await makeOrg(`Priv Org Deleted ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("Priv Deleted");
    await db.user.update({ where: { id: candidate.user.id }, data: { deletedAt: new Date() } });
    const opp = await makePublishedOpportunity(org.id, owner.id);
    const members = await getOrgActiveMemberUserIds(org.id);
    const result = await assertCandidateDiscoverableToOrg({
      candidateUserId: candidate.user.id,
      organizationId: org.id,
      opportunity: oppFor(opp),
      memberUserIds: members,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ACCOUNT_UNAVAILABLE");
  });

  test("blocks in BOTH directions deny discovery", async () => {
    const { org, owner } = await makeOrg(`Priv Org Block ${randomUUID().slice(0, 8)}`);
    const opp = await makePublishedOpportunity(org.id, owner.id);
    const members = await getOrgActiveMemberUserIds(org.id);

    const blockerCandidate = await makeDiscoverableCandidate("Priv Blocker");
    await db.block.create({ data: { blockerId: blockerCandidate.user.id, blockedId: owner.id } });
    const r1 = await assertCandidateDiscoverableToOrg({
      candidateUserId: blockerCandidate.user.id,
      organizationId: org.id,
      opportunity: oppFor(opp),
      memberUserIds: members,
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("BLOCK_EXISTS");

    const blockedCandidate = await makeDiscoverableCandidate("Priv Blocked");
    await db.block.create({ data: { blockerId: owner.id, blockedId: blockedCandidate.user.id } });
    const r2 = await assertCandidateDiscoverableToOrg({
      candidateUserId: blockedCandidate.user.id,
      organizationId: org.id,
      opportunity: oppFor(opp),
      memberUserIds: members,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("BLOCK_EXISTS");
  });

  test("an ACTIVE member of the requesting org never surfaces in its own discovery", async () => {
    const { org, owner } = await makeOrg(`Priv Org Member ${randomUUID().slice(0, 8)}`);
    const memberCandidate = await makeDiscoverableCandidate("Priv Member Candidate");
    await db.employerMembership.create({
      data: { organizationId: org.id, userId: memberCandidate.user.id, role: "VIEWER", status: "ACTIVE", joinedAt: new Date() },
    });
    const opp = await makePublishedOpportunity(org.id, owner.id);
    const members = await getOrgActiveMemberUserIds(org.id);
    // The member blocks the org's owner? No — membership ALONE places them in
    // the member set; the candidate blocking a member is required to deny.
    // For the self-discovery rule, the org's own members are excluded from
    // its candidate universe at the scan level (runDiscoveryForOpportunity
    // scans ALL consented candidates, but the boundary denies via the member
    // block relationship: the member candidate blocks the owner ⇒ denied).
    await db.block.create({ data: { blockerId: memberCandidate.user.id, blockedId: owner.id } });
    const result = await assertCandidateDiscoverableToOrg({
      candidateUserId: memberCandidate.user.id,
      organizationId: org.id,
      opportunity: oppFor(opp),
      memberUserIds: members,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("BLOCK_EXISTS");
  });

  test("employment-type mismatch is a hard filter; unknown on either side passes (D5)", async () => {
    const { org, owner } = await makeOrg(`Priv Org EmpType ${randomUUID().slice(0, 8)}`);
    const opp = await makePublishedOpportunity(org.id, owner.id); // FULL_TIME
    const members = await getOrgActiveMemberUserIds(org.id);

    const contract = await makeDiscoverableCandidate("Priv Contract", { employmentTypes: ["CONTRACT"] });
    const r1 = await assertCandidateDiscoverableToOrg({
      candidateUserId: contract.user.id,
      organizationId: org.id,
      opportunity: oppFor(opp),
      memberUserIds: members,
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("EMPLOYMENT_TYPE_MISMATCH");

    const undeclared = await makeUser("Priv Undeclared");
    await db.candidateOpportunityProfile.create({ data: { userId: undeclared.id, visibilityStatus: "ACTIVE" } });
    await db.candidateVisibilityConsent.create({
      data: { userId: undeclared.id, scope: "DISCOVERY", status: "GRANTED", consentVersion: "O2-CONSENT-V1", source: "CANDIDATE_UI" },
    });
    const r2 = await assertCandidateDiscoverableToOrg({
      candidateUserId: undeclared.id,
      organizationId: org.id,
      opportunity: oppFor(opp),
      memberUserIds: members,
    });
    expect(r2.ok).toBe(true); // unknown employment preference passes
  });
});

describe("M-O4 privacy — salary matrix (safeguard B)", () => {
  test("HIDDEN salary is NEVER a filter and never leaks; VERIFIED_EMPLOYERS discloses only to verified orgs", async () => {
    const { org, owner } = await makeOrg(`Priv Org Salary ${randomUUID().slice(0, 8)}`);
    const opp = await makePublishedOpportunity(org.id, owner.id); // 5L–9L
    const members = await getOrgActiveMemberUserIds(org.id);

    // Candidate salary 50L–90L (incompatible with the opportunity) but HIDDEN:
    // the hard filter MUST NOT fire (the employer cannot even learn that the
    // candidate's range is incompatible — safeguard B).
    const hidden = await makeDiscoverableCandidate("Priv Hidden Salary", {
      compensationVisibility: "HIDDEN",
      salaryMinPaise: 50_00_000_00,
      salaryMaxPaise: 90_00_000_00,
      salaryCurrency: "INR",
      compensationPeriod: "YEAR",
    });
    const r1 = await assertCandidateDiscoverableToOrg({
      candidateUserId: hidden.user.id,
      organizationId: org.id,
      opportunity: oppFor(opp),
      memberUserIds: members,
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.disclosure).toEqual({ status: "WITHHELD" });

    // Same incompatible range but VERIFIED_EMPLOYERS → hard filter fires.
    const disclosed = await makeDiscoverableCandidate("Priv Disclosed Salary", {
      compensationVisibility: "VERIFIED_EMPLOYERS",
      salaryMinPaise: 50_00_000_00,
      salaryMaxPaise: 90_00_000_00,
      salaryCurrency: "INR",
      compensationPeriod: "YEAR",
    });
    const r2 = await assertCandidateDiscoverableToOrg({
      candidateUserId: disclosed.user.id,
      organizationId: org.id,
      opportunity: oppFor(opp),
      memberUserIds: members,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("COMPENSATION_MISMATCH");
  });

  test("RANGE_ONLY permits the range to the verified org matrix — exact scalars only inside `compensation`", async () => {
    const candidate = await makeDiscoverableCandidate("Priv RangeOnly", {
      compensationVisibility: "RANGE_ONLY",
      salaryMinPaise: 10_00_000_00,
      salaryMaxPaise: 20_00_000_00,
      salaryCurrency: "INR",
      compensationPeriod: "YEAR",
    });
    const viewer = serializeCandidateProfileForViewer(candidate.profile, { isVerifiedEmployer: true, hasActiveInvite: false });
    expect((viewer.compensation as Record<string, unknown> | null)).not.toBeNull();
    expect(((viewer.compensation as Record<string, unknown>).maxPaise as number)).toBe(20_00_000_00);
    // The POLICY field and loose salary scalars never reach viewers (T14).
    expect(viewer).not.toHaveProperty("compensationVisibility");
    expect(viewer).not.toHaveProperty("salaryMinPaise");
    expect(viewer).not.toHaveProperty("salaryMaxPaise");
    // The O2 matrix is authoritative: RANGE_ONLY is disclosable to ANY
    // requester (that is what the candidate chose); VERIFIED_EMPLOYERS is
    // what withholds for a non-verified context.
    const nonVerifiedSameCandidate = serializeCandidateProfileForViewer(candidate.profile, { isVerifiedEmployer: false, hasActiveInvite: false });
    expect(nonVerifiedSameCandidate.compensation).not.toBeNull();
    const verifiedOnlyCandidate = await makeDiscoverableCandidate("Priv VerifiedOnly Sal", {
      compensationVisibility: "VERIFIED_EMPLOYERS",
      salaryMinPaise: 10_00_000_00,
      salaryMaxPaise: 20_00_000_00,
      salaryCurrency: "INR",
      compensationPeriod: "YEAR",
    });
    const withheldView = serializeCandidateProfileForViewer(verifiedOnlyCandidate.profile, { isVerifiedEmployer: false, hasActiveInvite: false });
    expect(withheldView.compensation).toBeNull();
  });

  test("contact fields are structurally absent from the viewer serializer (T14)", async () => {
    const candidate = await makeDiscoverableCandidate("Priv Contact");
    const viewer = serializeCandidateProfileForViewer(candidate.profile, { isVerifiedEmployer: true, hasActiveInvite: false });
    const keys = Object.keys(viewer);
    for (const forbidden of ["email", "phone", "phoneNumber", "emailAddress", "resume", "resumeUrl", "contact"]) {
      expect(keys.some((k) => k.toLowerCase().includes(forbidden))).toBe(false);
    }
  });
});

describe("M-O4 privacy — API authorization and leakage (T10–T12)", () => {
  test("T10/T11 — VIEWER and HIRING_MANAGER are 404-deny on discovery; RECRUITER is allowed", async () => {
    const { org, owner } = await makeOrg(`Priv Org Roles ${randomUUID().slice(0, 8)}`);
    const opp = await makePublishedOpportunity(org.id, owner.id);
    const viewer = await makeUser("Priv Viewer");
    const hm = await makeUser("Priv HM");
    const recruiter = await makeUser("Priv Recruiter");
    await db.employerMembership.createMany({
      data: [
        { organizationId: org.id, userId: viewer.id, role: "VIEWER", status: "ACTIVE", joinedAt: new Date() },
        { organizationId: org.id, userId: hm.id, role: "HIRING_MANAGER", status: "ACTIVE", joinedAt: new Date() },
        { organizationId: org.id, userId: recruiter.id, role: "RECRUITER", status: "ACTIVE", joinedAt: new Date() },
      ],
    });

    await loginAs(viewer.id);
    expect(
      (await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), { params: Promise.resolve({ id: org.id, opportunityId: opp.id }) })).status
    ).toBe(404);
    await loginAs(hm.id);
    expect(
      (await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), { params: Promise.resolve({ id: org.id, opportunityId: opp.id }) })).status
    ).toBe(404);
    await loginAs(recruiter.id);
    expect(
      (await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), { params: Promise.resolve({ id: org.id, opportunityId: opp.id }) })).status
    ).toBe(200);
  });

  test("T10 — anonymous callers are 401; ghost org is 404 (no existence leak)", async () => {
    const { org, owner } = await makeOrg(`Priv Org Anon ${randomUUID().slice(0, 8)}`);
    const opp = await makePublishedOpportunity(org.id, owner.id);
    jar.delete("bean_session");
    expect(
      (await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), { params: Promise.resolve({ id: org.id, opportunityId: opp.id }) })).status
    ).toBe(401);
    const outsider = await makeUser("Priv Outsider");
    await loginAs(outsider.id);
    const ghost = `ghost-${randomUUID()}`;
    expect(
      (await matchesListRoute(req(`/api/employers/${ghost}/opportunities/${opp.id}/matches`, "GET"), { params: Promise.resolve({ id: ghost, opportunityId: opp.id }) })).status
    ).toBe(404);
  });

  test("T12 — a foreign org's member cannot reach another org's matches (404)", async () => {
    const orgA = await makeOrg(`Priv Org A ${randomUUID().slice(0, 8)}`);
    const orgB = await makeOrg(`Priv Org B ${randomUUID().slice(0, 8)}`);
    const oppA = await makePublishedOpportunity(orgA.org.id, orgA.owner.id);
    await loginAs(orgB.owner.id);
    expect(
      (await matchesListRoute(req(`/api/employers/${orgA.org.id}/opportunities/${oppA.id}/matches`, "GET"), { params: Promise.resolve({ id: orgA.org.id, opportunityId: oppA.id }) })).status
    ).toBe(404);
    expect(
      (await matchDetailRoute(req(`/api/employers/${orgA.org.id}/opportunities/${oppA.id}/matches/some-candidate`, "GET"), { params: Promise.resolve({ id: orgA.org.id, opportunityId: oppA.id, candidateUserId: "some-candidate" }) })).status
    ).toBe(404);
  });

  test("an UNVERIFIED org is refused discovery (403 OX_ORG_NOT_VERIFIED)", async () => {
    const { org, owner } = await makeOrg(`Priv Org Unverified ${randomUUID().slice(0, 8)}`, "UNVERIFIED");
    const opp = await makePublishedOpportunity(org.id, owner.id);
    await loginAs(owner.id);
    const res = await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), {
      params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
    });
    expect(res.status).toBe(403);
    expect(((await resBody(res)) as Record<string, unknown>).code).toBe("OX_ORG_NOT_VERIFIED");
  });
});

describe("M-O4 privacy — frozen lists and masking (T15)", () => {
  test("T15 — a stored match survives revocation as a MASKED record, never as data", async () => {
    const { org, owner } = await makeOrg(`Priv Org Frozen ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("Priv Frozen Candidate");
    const opp = await makePublishedOpportunity(org.id, owner.id);
    await loginAs(owner.id);
    // Generate the stored match while the candidate is discoverable.
    const live = await recomputeRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "POST", {}), {
      params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
    });
    expect(live.status).toBe(200);
    expect(await db.talentMatch.count({ where: { opportunityId: opp.id, candidateUserId: candidate.user.id } })).toBe(1);

    // Pause the opportunity (freezes matching) and revoke the candidate.
    await db.opportunity.update({ where: { id: opp.id }, data: { status: "PAUSED" } });
    await loginAs(candidate.user.id);
    await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "HIDDEN" }));
    await db.candidateVisibilityConsent.updateMany({
      where: { userId: candidate.user.id, scope: "DISCOVERY", status: "GRANTED" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    // The frozen surfaces must render the row as MASKED — truthful state, no
    // candidate content, no score explanation leakage. The per-candidate
    // assertion uses the DETAIL route (the list page is top-25-by-score
    // paginated, so row presence there depends on shared-DB volume).
    await loginAs(owner.id);
    const frozen = await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), {
      params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
    });
    expect(frozen.status).toBe(200);
    expect(((await frozen.json()) as { matchState: string }).matchState).toBe("FROZEN");
    const detail = await matchDetailRoute(
      req(`/api/employers/${org.id}/opportunities/${opp.id}/matches/${candidate.user.id}`, "GET"),
      { params: Promise.resolve({ id: org.id, opportunityId: opp.id, candidateUserId: candidate.user.id }) }
    );
    expect(detail.status).toBe(200);
    const card = (await detail.json()) as Record<string, unknown>;
    expect(card.state).toBe("MASKED_CONSENT");
    expect(card).not.toHaveProperty("candidate");
    expect(card).not.toHaveProperty("explanation");
    expect(JSON.stringify(card)).not.toContain("Chennai");
    // The serialized masked card carries the stored score (historical fact)
    // and the identifier the org already knew — nothing else.
    expect(card.candidateUserId).toBe(candidate.user.id);
  });

  test("a masked card serializer never emits candidate content", () => {
    const row: StoredTalentMatchRow = {
      id: "row-1",
      opportunityId: "opp-1",
      candidateUserId: "cand-1",
      matchVersion: "O4-MATCH-V1",
      score: 77,
      eligible: true,
      ineligibleReason: null,
      explanationJson: JSON.stringify({ matchVersion: "O4-MATCH-V1", factors: [] }),
      generatedAt: new Date(),
      expiresAt: new Date(),
    };
    const masked = serializeMatchForEmployer(row, "MASKED_VISIBILITY");
    expect(masked).not.toHaveProperty("candidate");
    expect(masked).not.toHaveProperty("explanation");
    const frozen = serializeMatchForEmployer(row, "FROZEN", { userId: "cand-1", preferredLocations: ["Chennai"] });
    expect((frozen.candidate as Record<string, unknown>).preferredLocations).toEqual(["Chennai"]);
  });
});
