import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

/**
 * M-O4 — candidate transparency suite (approved decision D12).
 *
 *   The candidate sees their OWN stored matches with the verified employer's
 *   PUBLIC identity (displayName + slug), the opportunity title/status and a
 *   TRUTHFUL discoveryState (ACTIVE / PAUSED / HIDDEN / INVITE_ONLY / REVOKED
 *   / EXPIRED / NO_DISCOVERY).
 *   The candidate sees WHO accessed their discoverable information
 *   (ox.candidate.viewed audit trail: org, opportunity, purpose, timestamp,
 *   viewer identity per O0 §6.7) — bound to their own profile id only.
 *   No other candidate's data is reachable on either surface.
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
import { GET as meMatchesRoute } from "@/app/api/opportunities/me/matches/route";
import { GET as meAuditRoute } from "@/app/api/opportunities/me/discovery-audit/route";
import { GET as matchDetailRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/matches/[candidateUserId]/route";
import { PUT as putProfileRoute } from "@/app/api/opportunities/me/profile/route";
import { POST as visibilityRoute } from "@/app/api/opportunities/me/visibility/route";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

function req(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
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
    data: { email: `ox-tr-${randomUUID()}@beanfolio.test`, passwordHash: await hashPassword("ox-tr-password-1"), name },
  });
}

async function makeVerifiedOrgWithPublishedOpportunity(displayName: string) {
  const owner = await makeUser("TR Owner");
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
  const opportunity = await db.opportunity.create({
    data: {
      organizationId: org.id,
      createdByUserId: owner.id,
      title: "Transparency opportunity",
      description: "An opportunity used to exercise candidate transparency in tests.",
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
  await loginAs(owner.id);
  return { owner, org, opportunity };
}

async function makeDiscoverableCandidate(name: string) {
  const user = await makeUser(name);
  await loginAs(user.id);
  await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { employmentTypes: ["FULL_TIME"], workModes: ["REMOTE"] }));
  await db.candidateVisibilityConsent.create({
    data: { userId: user.id, scope: "DISCOVERY", status: "GRANTED", consentVersion: "O2-CONSENT-V1", source: "CANDIDATE_UI" },
  });
  await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" }));
  return user;
}

describe("M-O4 candidate transparency — own matches (D12)", () => {
  test("the candidate sees their own match with employer identity and truthful state", async () => {
    const ctx = await makeVerifiedOrgWithPublishedOpportunity(`TR Org A ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("TR Candidate A");
    await loginAs(ctx.owner.id);
    await matchDetailRoute(req(`/api/employers/${ctx.org.id}/opportunities/${ctx.opportunity.id}/matches/${candidate.id}`, "GET"), {
      params: Promise.resolve({ id: ctx.org.id, opportunityId: ctx.opportunity.id, candidateUserId: candidate.id }),
    });

    await loginAs(candidate.id);
    const res = await meMatchesRoute(req("/api/opportunities/me/matches", "GET"));
    expect(res.status).toBe(200);
    const body = (await resBody(res)) as { discoveryState: string; matches: Record<string, unknown>[] };
    expect(body.discoveryState).toBe("DISCOVERY_ACTIVE");
    const mine = body.matches.find((m) => (m.opportunity as Record<string, unknown>).id === ctx.opportunity.id);
    expect(mine).toBeDefined();
    expect(((mine!.opportunity as Record<string, unknown>).title as string)).toBe("Transparency opportunity");
    const org = mine!.organization as Record<string, unknown>;
    expect(org.displayName).toBe(ctx.org.displayName);
    expect(org.slug).toBe(ctx.org.slug);
    // The candidate's own explanation is visible; nobody else's data exists.
    expect(mine!.explanation).not.toBeNull();
    expect((mine!.explanation as Record<string, unknown>).matchVersion).toBe("O4-MATCH-V1");
  });

  test("discoveryState truthfulness: PAUSED, HIDDEN, REVOKED and NO_DISCOVERY", async () => {
    const ctx = await makeVerifiedOrgWithPublishedOpportunity(`TR Org B ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("TR Candidate B");
    await loginAs(ctx.owner.id);
    await matchDetailRoute(req(`/api/employers/${ctx.org.id}/opportunities/${ctx.opportunity.id}/matches/${candidate.id}`, "GET"), {
      params: Promise.resolve({ id: ctx.org.id, opportunityId: ctx.opportunity.id, candidateUserId: candidate.id }),
    });

    await loginAs(candidate.id);
    await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "PAUSED" }));
    let body = (await resBody(await meMatchesRoute(req("/api/opportunities/me/matches", "GET")))) as { discoveryState: string };
    expect(body.discoveryState).toBe("DISCOVERY_PAUSED");

    await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "HIDDEN" }));
    body = (await resBody(await meMatchesRoute(req("/api/opportunities/me/matches", "GET")))) as { discoveryState: string };
    expect(body.discoveryState).toBe("DISCOVERY_HIDDEN");

    await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "INVITE_ONLY" }));
    body = (await resBody(await meMatchesRoute(req("/api/opportunities/me/matches", "GET")))) as { discoveryState: string };
    expect(body.discoveryState).toBe("DISCOVERY_INVITE_ONLY");

    // Revoke → the DISCOVERY state flips to REVOKED and the profile is forced
    // HIDDEN by the O2 invariant.
    await db.candidateVisibilityConsent.updateMany({
      where: { userId: candidate.id, scope: "DISCOVERY", status: "GRANTED" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    body = (await resBody(await meMatchesRoute(req("/api/opportunities/me/matches", "GET")))) as { discoveryState: string };
    expect(body.discoveryState).toBe("DISCOVERY_REVOKED");

    // A user with no profile at all sees NO_DISCOVERY and an empty list.
    const outsider = await makeUser("TR Outsider");
    await loginAs(outsider.id);
    const empty = (await resBody(await meMatchesRoute(req("/api/opportunities/me/matches", "GET")))) as {
      discoveryState: string;
      matches: unknown[];
    };
    expect(empty.discoveryState).toBe("NO_DISCOVERY");
    expect(empty.matches).toHaveLength(0);
  });

  test("anonymous callers are 401; another candidate's rows are unreachable", async () => {
    jar.delete("bean_session");
    expect((await meMatchesRoute(req("/api/opportunities/me/matches", "GET"))).status).toBe(401);
    expect((await meAuditRoute(req("/api/opportunities/me/discovery-audit", "GET"))).status).toBe(401);
  });
});

describe("M-O4 candidate transparency — discovery-access audit (D12)", () => {
  test("who-viewed trail: org, opportunity, purpose, timestamp, viewer identity", async () => {
    const ctx = await makeVerifiedOrgWithPublishedOpportunity(`TR Org C ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("TR Candidate C");
    // Two employer views (list page-1 does NOT count as a view; the DETAIL
    // route is the audited preview surface).
    await loginAs(ctx.owner.id);
    await matchDetailRoute(req(`/api/employers/${ctx.org.id}/opportunities/${ctx.opportunity.id}/matches/${candidate.id}`, "GET"), {
      params: Promise.resolve({ id: ctx.org.id, opportunityId: ctx.opportunity.id, candidateUserId: candidate.id }),
    });
    await matchDetailRoute(req(`/api/employers/${ctx.org.id}/opportunities/${ctx.opportunity.id}/matches/${candidate.id}`, "GET"), {
      params: Promise.resolve({ id: ctx.org.id, opportunityId: ctx.opportunity.id, candidateUserId: candidate.id }),
    });

    await loginAs(candidate.id);
    const res = await meAuditRoute(req("/api/opportunities/me/discovery-audit", "GET"));
    expect(res.status).toBe(200);
    const body = (await resBody(res)) as { events: Record<string, unknown>[] };
    const mine = body.events.filter((e) => e.opportunityId === ctx.opportunity.id);
    expect(mine.length).toBe(2);
    for (const e of mine) {
      expect(e.organizationId).toBe(ctx.org.id);
      expect(e.purpose).toBe("DISCOVERY");
      expect(e.viewerUserId).toBe(ctx.owner.id);
      expect(typeof e.at).toBe("string");
    }
  });

  test("the audit is bound to the candidate's OWN profile — no cross-candidate access", async () => {
    const ctx = await makeVerifiedOrgWithPublishedOpportunity(`TR Org D ${randomUUID().slice(0, 8)}`);
    const candidateA = await makeDiscoverableCandidate("TR Candidate D1");
    const candidateB = await makeDiscoverableCandidate("TR Candidate D2");
    await loginAs(ctx.owner.id);
    await matchDetailRoute(req(`/api/employers/${ctx.org.id}/opportunities/${ctx.opportunity.id}/matches/${candidateA.id}`, "GET"), {
      params: Promise.resolve({ id: ctx.org.id, opportunityId: ctx.opportunity.id, candidateUserId: candidateA.id }),
    });
    await loginAs(candidateB.id);
    const body = (await resBody(await meAuditRoute(req("/api/opportunities/me/discovery-audit", "GET")))) as {
      events: Record<string, unknown>[];
    };
    // B's audit contains nothing about A's view.
    expect(body.events.filter((e) => e.opportunityId === ctx.opportunity.id)).toHaveLength(0);
  });

  test("a candidate with no profile gets an empty audit list (not an error)", async () => {
    const nobody = await makeUser("TR NoProfile");
    await loginAs(nobody.id);
    const res = await meAuditRoute(req("/api/opportunities/me/discovery-audit", "GET"));
    expect(res.status).toBe(200);
    expect(((await resBody(res)) as { events: unknown[] }).events).toHaveLength(0);
  });
});
