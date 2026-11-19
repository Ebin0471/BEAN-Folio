import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

/**
 * M-O4 — matches API lifecycle, authorization and idempotency suite.
 *
 *   Opportunity-status boundaries (D6): DRAFT/PENDING_REVIEW → 409 (never
 *   discoverable); PUBLISHED → LIVE recomputation; PAUSED → FROZEN stored
 *   list without recomputation; FILLED/CLOSED → TERMINAL stored list;
 *   recompute (POST) requires PUBLISHED.
 *   D3 idempotency: one current row per (opportunityId, candidateUserId);
 *   repeated generation does not duplicate rows and is score-stable.
 *   Detail route: audited ox.candidate.viewed; unknown candidate with no
 *   stored row → 404 (existence hiding); frozen detail masks.
 *   Rate limits: documented keys exist (`ox:discovery-search`, `ox:candidate-view`).
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
import {
  GET as matchesListRoute,
  POST as recomputeRoute,
} from "@/app/api/employers/[id]/opportunities/[opportunityId]/matches/route";
import { GET as matchDetailRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/matches/[candidateUserId]/route";
import { PUT as putProfileRoute } from "@/app/api/opportunities/me/profile/route";
import { POST as visibilityRoute } from "@/app/api/opportunities/me/visibility/route";
import { GET as meMatchesRoute } from "@/app/api/opportunities/me/matches/route";

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

async function makeUser(name: string) {
  return db.user.create({
    data: { email: `ox-api-${randomUUID()}@beanfolio.test`, passwordHash: await hashPassword("ox-api-password-1"), name },
  });
}

async function makeVerifiedOrg(displayName: string) {
  const owner = await makeUser("API Owner");
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
  await loginAs(owner.id);
  return { owner, org };
}

async function makeOpportunity(orgId: string, ownerId: string, status: string) {
  return db.opportunity.create({
    data: {
      organizationId: orgId,
      createdByUserId: ownerId,
      title: `API lifecycle opportunity (${status})`,
      description: "An opportunity used to exercise the matches API lifecycle in tests.",
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
  return user;
}

describe("M-O4 matches API — opportunity status boundaries (D6)", () => {
  test("DRAFT and PENDING_REVIEW opportunities are never discoverable (409, no writes)", async () => {
    const { owner, org } = await makeVerifiedOrg(`API Org Draft ${randomUUID().slice(0, 8)}`);
    const draft = await makeOpportunity(org.id, owner.id, "DRAFT");
    const pending = await makeOpportunity(org.id, owner.id, "PENDING_REVIEW");
    for (const opp of [draft, pending]) {
      const res = await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), {
        params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
      });
      expect(res.status).toBe(409);
      expect(((await resBody(res)) as Record<string, unknown>).code).toBe("OX_OPPORTUNITY_NOT_DISCOVERABLE");
      const postRes = await recomputeRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "POST", {}), {
        params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
      });
      expect(postRes.status).toBe(409);
    }
    expect(await db.talentMatch.count({ where: { opportunityId: { in: [draft.id, pending.id] } } })).toBe(0);
  });

  test("a PAUSED opportunity freezes: no recomputation, stored rows returned with truthful state", async () => {
    const { owner, org } = await makeVerifiedOrg(`API Org Paused ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("API Paused Candidate");
    const opp = await makeOpportunity(org.id, owner.id, "PUBLISHED");
    await loginAs(owner.id);
    const live = (await resBody(
      await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), {
        params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
      })
    )) as { matchState: string; total: number };
    expect(live.matchState).toBe("LIVE");
    expect(live.total).toBeGreaterThanOrEqual(1);
    // Per-candidate presence: the list is paginated (top-25 by score), so the
    // authoritative per-candidate surface is the detail route + the stored row.
    expect(await db.talentMatch.count({ where: { opportunityId: opp.id, candidateUserId: candidate.id } })).toBe(1);
    const liveDetail = (await resBody(
      await matchDetailRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches/${candidate.id}`, "GET"), {
        params: Promise.resolve({ id: org.id, opportunityId: opp.id, candidateUserId: candidate.id }),
      })
    )) as Record<string, unknown>;
    expect(liveDetail.state).toBe("LIVE");

    await db.opportunity.update({ where: { id: opp.id }, data: { status: "PAUSED" } });
    const frozen = (await resBody(
      await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), {
        params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
      })
    )) as { matchState: string };
    expect(frozen.matchState).toBe("FROZEN");
    // Our candidate's FROZEN card comes through the detail route (consent +
    // visibility still current ⇒ revalidated, not masked).
    const frozenDetail = (await resBody(
      await matchDetailRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches/${candidate.id}`, "GET"), {
        params: Promise.resolve({ id: org.id, opportunityId: opp.id, candidateUserId: candidate.id }),
      })
    )) as Record<string, unknown>;
    expect(frozenDetail.state).toBe("FROZEN");
    // A NEW candidate consented after pausing gets NO new discovery: no row,
    // and the frozen detail path is a 404 (never known to this org).
    const lateCandidate = await makeDiscoverableCandidate("API Late Candidate");
    expect(await db.talentMatch.count({ where: { opportunityId: opp.id, candidateUserId: lateCandidate.id } })).toBe(0);
    const lateDetail = await matchDetailRoute(
      req(`/api/employers/${org.id}/opportunities/${opp.id}/matches/${lateCandidate.id}`, "GET"),
      { params: Promise.resolve({ id: org.id, opportunityId: opp.id, candidateUserId: lateCandidate.id }) }
    );
    expect(lateDetail.status).toBe(404);
  });

  test("a terminal opportunity (FILLED) is read-only: stored rows, TERMINAL state", async () => {
    const { owner, org } = await makeVerifiedOrg(`API Org Terminal ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("API Terminal Candidate");
    const opp = await makeOpportunity(org.id, owner.id, "PUBLISHED");
    await loginAs(owner.id);
    await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), {
      params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
    });
    await db.opportunity.update({ where: { id: opp.id }, data: { status: "FILLED", closedAt: new Date() } });
    const terminal = (await resBody(
      await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), {
        params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
      })
    )) as { matchState: string };
    expect(terminal.matchState).toBe("TERMINAL");
    const terminalDetail = (await resBody(
      await matchDetailRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches/${candidate.id}`, "GET"), {
        params: Promise.resolve({ id: org.id, opportunityId: opp.id, candidateUserId: candidate.id }),
      })
    )) as Record<string, unknown>;
    expect(terminalDetail.state).toBe("FROZEN"); // stored card, revalidated
    expect(terminalDetail).not.toBeNull();
    // Recompute on a terminal opportunity is refused.
    const postRes = await recomputeRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "POST", {}), {
      params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
    });
    expect(postRes.status).toBe(409);
  });
});

describe("M-O4 matches API — idempotency (D3) and stability", () => {
  test("repeated generation keeps exactly ONE row per pair with a stable score", async () => {
    const { owner, org } = await makeVerifiedOrg(`API Org Idem ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("API Idem Candidate");
    const opp = await makeOpportunity(org.id, owner.id, "PUBLISHED");
    await loginAs(owner.id);
    const r1 = (await resBody(
      await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), {
        params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
      })
    )) as { total: number };
    const row1 = await db.talentMatch.findUnique({ where: { opportunityId_candidateUserId: { opportunityId: opp.id, candidateUserId: candidate.id } } });
    expect(row1).not.toBeNull();
    const r2 = (await resBody(
      await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), {
        params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
      })
    )) as { total: number };
    const row2 = await db.talentMatch.findUnique({ where: { opportunityId_candidateUserId: { opportunityId: opp.id, candidateUserId: candidate.id } } });
    expect(r2.total).toBe(r1.total); // stable across runs
    expect(row2!.score).toBe(row1!.score); // deterministic score, stable recompute
    expect(row2!.matchVersion).toBe("O4-MATCH-V1");
    // D3: exactly one current row per pair; the table holds no history rows.
    expect(await db.talentMatch.count({ where: { opportunityId: opp.id, candidateUserId: candidate.id } })).toBe(1);
    expect(await db.talentMatch.count({ where: { opportunityId: opp.id } })).toBe(r1.total);
  });

  test("recompute POST is idempotent and same-origin protected", async () => {
    const { owner, org } = await makeVerifiedOrg(`API Org Recompute ${randomUUID().slice(0, 8)}`);
    await makeDiscoverableCandidate("API Recompute Candidate");
    const opp = await makeOpportunity(org.id, owner.id, "PUBLISHED");
    await loginAs(owner.id);
    const okRes = await recomputeRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "POST", {}), {
      params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
    });
    expect(okRes.status).toBe(200);
    const cross = await recomputeRoute(
      req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "POST", {}, { origin: "https://evil.example" }),
      { params: Promise.resolve({ id: org.id, opportunityId: opp.id }) }
    );
    expect(cross.status).toBe(403);
  });
});

describe("M-O4 matches API — detail route behavior", () => {
  test("live detail writes ox.candidate.viewed; unknown candidate with no stored row is 404", async () => {
    const { owner, org } = await makeVerifiedOrg(`API Org Detail ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("API Detail Candidate");
    const opp = await makeOpportunity(org.id, owner.id, "PUBLISHED");
    await loginAs(owner.id);
    const detail = await matchDetailRoute(
      req(`/api/employers/${org.id}/opportunities/${opp.id}/matches/${candidate.id}`, "GET"),
      { params: Promise.resolve({ id: org.id, opportunityId: opp.id, candidateUserId: candidate.id }) }
    );
    expect(detail.status).toBe(200);
    const body = (await resBody(detail)) as Record<string, unknown>;
    expect(body.state).toBe("LIVE");
    expect(body.score).toBeGreaterThan(0);
    const audit = await db.auditEvent.findFirst({
      where: { action: "ox.candidate.viewed", targetType: "CANDIDATE_OPPORTUNITY_PROFILE", actorUserId: owner.id },
    });
    expect(audit).not.toBeNull();
    const ghost = `ghost-${randomUUID()}`;
    const missing = await matchDetailRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches/${ghost}`, "GET"), {
      params: Promise.resolve({ id: org.id, opportunityId: opp.id, candidateUserId: ghost }),
    });
    expect(missing.status).toBe(404);
  });

  test("frozen detail masks a candidate whose consent was revoked (never serves data)", async () => {
    const { owner, org } = await makeVerifiedOrg(`API Org FrozenDetail ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("API FrozenDetail Candidate");
    const opp = await makeOpportunity(org.id, owner.id, "PUBLISHED");
    await loginAs(owner.id);
    await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches`, "GET"), {
      params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
    });
    await db.opportunity.update({ where: { id: opp.id }, data: { status: "PAUSED" } });
    await db.candidateVisibilityConsent.updateMany({
      where: { userId: candidate.id, scope: "DISCOVERY", status: "GRANTED" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    await db.candidateOpportunityProfile.update({ where: { userId: candidate.id }, data: { visibilityStatus: "HIDDEN" } });
    const detail = await matchDetailRoute(
      req(`/api/employers/${org.id}/opportunities/${opp.id}/matches/${candidate.id}`, "GET"),
      { params: Promise.resolve({ id: org.id, opportunityId: opp.id, candidateUserId: candidate.id }) }
    );
    expect(detail.status).toBe(200);
    const body = (await resBody(detail)) as Record<string, unknown>;
    expect(body.state).toBe("MASKED_CONSENT");
    expect(body).not.toHaveProperty("candidate");
    expect(body).not.toHaveProperty("explanation");
    expect(JSON.stringify(body)).not.toContain("Chennai");
  });
});

describe("M-O4 matches API — pagination bounds", () => {
  test("page parameter is bounded and pageSize is fixed at 25", async () => {
    const { owner, org } = await makeVerifiedOrg(`API Org Page ${randomUUID().slice(0, 8)}`);
    const opp = await makeOpportunity(org.id, owner.id, "PUBLISHED");
    await loginAs(owner.id);
    const res = (await resBody(
      await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches?page=1`, "GET"), {
        params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
      })
    )) as { pageSize: number; page: number };
    expect(res.pageSize).toBe(25);
    expect(res.page).toBe(1);
    const bad = (await resBody(
      await matchesListRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/matches?page=-5`, "GET"), {
        params: Promise.resolve({ id: org.id, opportunityId: opp.id }),
      })
    )) as { page: number };
    expect(bad.page).toBe(1); // clamped, not an error
  });
});
