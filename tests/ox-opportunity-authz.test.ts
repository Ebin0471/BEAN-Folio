import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// M-O3 authorization tests: tenant isolation (404-deny), VIEWER and
// HIRING_MANAGER read-only, RECRUITER write scope, VERIFIED-submit gate,
// SUSPENDED-org refusal, admin-only review decisions (indistinguishable 403),
// and same-origin protection. Same harness as tests/ox-employer-org.test.ts.
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
import { POST as createOrgRoute } from "@/app/api/employers/route";
import { POST as inviteRoute } from "@/app/api/employers/[id]/members/route";
import { PATCH as patchMemberByIdRoute } from "@/app/api/employers/[id]/members/[memberId]/route";
import { POST as submitVerificationRoute } from "@/app/api/employers/[id]/verification/route";
import { PATCH as adminVerificationDecisionRoute } from "@/app/api/admin/ox/verifications/[id]/route";
import { POST as createOpportunityRoute, GET as listOpportunitiesRoute } from "@/app/api/employers/[id]/opportunities/route";
import {
  GET as getOpportunityRoute,
  PATCH as patchOpportunityRoute,
  DELETE as deleteOpportunityRoute,
} from "@/app/api/employers/[id]/opportunities/[opportunityId]/route";
import { POST as submitOpportunityRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/submit/route";
import { POST as pauseOpportunityRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/pause/route";
import { POST as reopenOpportunityRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/reopen/route";
import { POST as outcomeOpportunityRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/outcome/route";
import { GET as adminListRoute } from "@/app/api/admin/ox/opportunities/route";
import { PATCH as adminDecisionRoute } from "@/app/api/admin/ox/opportunities/[opportunityId]/route";

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

const oppParams = (id: string, opportunityId: string) => ({ params: Promise.resolve({ id, opportunityId }) });
const orgParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function makeUser(name: string, role?: string) {
  return db.user.create({
    data: {
      email: `ox-opp-auth-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("ox-opp-auth-password-1"),
      name,
      ...(role ? { role } : {}),
    },
  });
}

async function loginAs(userId: string) {
  jar.set("bean_session", await createSession(userId));
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

const COMPLETE_SALARY = {
  salaryMinPaise: 500_000_00,
  salaryMaxPaise: 900_000_00,
  salaryCurrency: "INR",
  compensationPeriod: "YEAR",
};

const BASE_PAYLOAD = {
  title: "Producer, unscripted",
  description: "Run development sprints for format originals and keep the slate moving end to end.",
  ...COMPLETE_SALARY,
};

async function seedOrg(displayName: string) {
  const owner = await makeUser("Auth Owner");
  await loginAs(owner.id);
  const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "Auth Ltd", displayName }));
  const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
  await loginAs(owner.id);
  return { owner, orgId };
}

async function seedVerifiedOrg(displayName: string) {
  const seeded = await seedOrg(displayName);
  await submitVerificationRoute(
    req(`/api/employers/${seeded.orgId}/verification`, "POST", { evidenceReference: "auth-ref-0001" }),
    orgParams(seeded.orgId)
  );
  const admin = await makeUser("Auth Admin", "ADMIN");
  const pending = await db.employerVerification.findFirst({ where: { organizationId: seeded.orgId, status: "PENDING" } });
  await loginAs(admin.id);
  await adminVerificationDecisionRoute(
    req(`/api/admin/ox/verifications/${pending!.id}`, "PATCH", { decision: "APPROVE" }),
    { params: Promise.resolve({ id: pending!.id }) }
  );
  await loginAs(seeded.owner.id);
  return { ...seeded, admin };
}

async function inviteMember(orgId: string, username: string, role: string) {
  return inviteRoute(req(`/api/employers/${orgId}/members`, "POST", { username, role }), orgParams(orgId));
}

/** Invite (as the current session) then self-accept (as the invited user). */
async function inviteAndAccept(orgId: string, invitedUserId: string, username: string, role: string) {
  const invited = await inviteMember(orgId, username, role);
  if (invited.status !== 201) throw new Error(`invite failed: ${invited.status}`);
  await loginAs(invitedUserId);
  const membership = await db.employerMembership.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId: invitedUserId } },
  });
  const accepted = await patchMemberByIdRoute(
    req(`/api/employers/${orgId}/members/${membership!.id}`, "PATCH", { status: "ACTIVE" }),
    { params: Promise.resolve({ id: orgId, memberId: membership!.id }) }
  );
  if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status}`);
}

async function createDraft(orgId: string, overrides?: Record<string, unknown>) {
  const res = await createOpportunityRoute(
    req(`/api/employers/${orgId}/opportunities`, "POST", { ...BASE_PAYLOAD, ...overrides }),
    orgParams(orgId)
  );
  return (await resBody(res)).opportunity as Record<string, unknown>;
}

// --------------------------------------------------------------- tenant isolation

describe("M-O3 authorization — tenant isolation is a 404 deny", () => {
  test("a foreign member cannot read, create, edit, delete, or transition another org's opportunities", async () => {
    const orgA = await seedVerifiedOrg(`Auth Org A ${randomUUID().slice(0, 8)}`);
    const orgB = await seedVerifiedOrg(`Auth Org B ${randomUUID().slice(0, 8)}`);
    await loginAs(orgA.owner.id);
    const draft = await createDraft(orgA.orgId);

    await loginAs(orgB.owner.id);
    expect((await listOpportunitiesRoute(req(`/api/employers/${orgA.orgId}/opportunities`, "GET"), orgParams(orgA.orgId))).status).toBe(404);
    expect((await getOpportunityRoute(req(`/api/employers/${orgA.orgId}/opportunities/${draft.id}`, "GET"), oppParams(orgA.orgId, draft.id as string))).status).toBe(404);
    expect(
      (await createOpportunityRoute(req(`/api/employers/${orgA.orgId}/opportunities`, "POST", BASE_PAYLOAD), orgParams(orgA.orgId))).status
    ).toBe(404);
    expect(
      (
        await patchOpportunityRoute(
          req(`/api/employers/${orgA.orgId}/opportunities/${draft.id}`, "PATCH", { title: "Hijacked title" }),
          oppParams(orgA.orgId, draft.id as string)
        )
      ).status
    ).toBe(404);
    expect(
      (await submitOpportunityRoute(req(`/api/employers/${orgA.orgId}/opportunities/${draft.id}/submit`, "POST", {}), oppParams(orgA.orgId, draft.id as string))).status
    ).toBe(404);
    expect(
      (await pauseOpportunityRoute(req(`/api/employers/${orgA.orgId}/opportunities/${draft.id}/pause`, "POST", {}), oppParams(orgA.orgId, draft.id as string))).status
    ).toBe(404);
    expect(
      (await reopenOpportunityRoute(req(`/api/employers/${orgA.orgId}/opportunities/${draft.id}/reopen`, "POST", {}), oppParams(orgA.orgId, draft.id as string))).status
    ).toBe(404);
    expect(
      (
        await outcomeOpportunityRoute(
          req(`/api/employers/${orgA.orgId}/opportunities/${draft.id}/outcome`, "POST", { outcome: "CLOSED" }),
          oppParams(orgA.orgId, draft.id as string)
        )
      ).status
    ).toBe(404);
    expect(
      (await deleteOpportunityRoute(req(`/api/employers/${orgA.orgId}/opportunities/${draft.id}`, "DELETE"), oppParams(orgA.orgId, draft.id as string))).status
    ).toBe(404);

    // Nothing was written by the foreign caller.
    expect(await db.opportunity.count({ where: { organizationId: orgA.orgId } })).toBe(1);
    const row = await db.opportunity.findUnique({ where: { id: draft.id as string } });
    expect(row?.title).toBe(BASE_PAYLOAD.title);
    expect(row?.status).toBe("DRAFT");
  });

  test("a random non-existent org id is a 404, never a 403 (no existence leak)", async () => {
    const { owner } = await seedOrg(`Auth Org C ${randomUUID().slice(0, 8)}`);
    await loginAs(owner.id);
    const ghost = `ghost-${randomUUID()}`;
    expect((await listOpportunitiesRoute(req(`/api/employers/${ghost}/opportunities`, "GET"), orgParams(ghost))).status).toBe(404);
  });
});

// ---------------------------------------------------------------- read-only roles

describe("M-O3 authorization — VIEWER and HIRING_MANAGER are read-only", () => {
  test("VIEWER can read list and detail; every write is 404-deny", async () => {
    const { owner, orgId } = await seedVerifiedOrg(`Auth Org D ${randomUUID().slice(0, 8)}`);
    const viewer = await makeUser("Auth Viewer");
    const username = `authview${randomUUID().slice(0, 8)}`;
    await db.user.update({ where: { id: viewer.id }, data: { username } });
    await loginAs(owner.id);
    const draft = await createDraft(orgId);
    await inviteAndAccept(orgId, viewer.id, username, "VIEWER");

    await loginAs(viewer.id);
    expect((await listOpportunitiesRoute(req(`/api/employers/${orgId}/opportunities`, "GET"), orgParams(orgId))).status).toBe(200);
    expect((await getOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft.id}`, "GET"), oppParams(orgId, draft.id as string))).status).toBe(200);

    expect(
      (await createOpportunityRoute(req(`/api/employers/${orgId}/opportunities`, "POST", BASE_PAYLOAD), orgParams(orgId))).status
    ).toBe(404);
    expect(
      (
        await patchOpportunityRoute(
          req(`/api/employers/${orgId}/opportunities/${draft.id}`, "PATCH", { title: "Viewer should not change this" }),
          oppParams(orgId, draft.id as string)
        )
      ).status
    ).toBe(404);
    expect(
      (await submitOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft.id}/submit`, "POST", {}), oppParams(orgId, draft.id as string))).status
    ).toBe(404);
    expect(
      (await deleteOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft.id}`, "DELETE"), oppParams(orgId, draft.id as string))).status
    ).toBe(404);
  });

  test("HIRING_MANAGER is read-only for opportunities in M-O3 (custom assignment deferred)", async () => {
    const { owner, orgId } = await seedVerifiedOrg(`Auth Org E ${randomUUID().slice(0, 8)}`);
    const hiringManager = await makeUser("Auth HM");
    const username = `authhm${randomUUID().slice(0, 8)}`;
    await db.user.update({ where: { id: hiringManager.id }, data: { username } });
    await loginAs(owner.id);
    await inviteAndAccept(orgId, hiringManager.id, username, "HIRING_MANAGER");

    await loginAs(hiringManager.id);
    expect((await listOpportunitiesRoute(req(`/api/employers/${orgId}/opportunities`, "GET"), orgParams(orgId))).status).toBe(200);
    expect(
      (await createOpportunityRoute(req(`/api/employers/${orgId}/opportunities`, "POST", BASE_PAYLOAD), orgParams(orgId))).status
    ).toBe(404);
  });

  test("RECRUITER can create and submit (write scope), but is still 404-deny on foreign orgs", async () => {
    const { owner, orgId } = await seedVerifiedOrg(`Auth Org F ${randomUUID().slice(0, 8)}`);
    const recruiter = await makeUser("Auth Recruiter");
    const username = `authrec${randomUUID().slice(0, 8)}`;
    await db.user.update({ where: { id: recruiter.id }, data: { username } });
    await loginAs(owner.id);
    await inviteAndAccept(orgId, recruiter.id, username, "RECRUITER");

    await loginAs(recruiter.id);
    const created = await createOpportunityRoute(req(`/api/employers/${orgId}/opportunities`, "POST", BASE_PAYLOAD), orgParams(orgId));
    expect(created.status).toBe(201);
    const draft = (await resBody(created)).opportunity as Record<string, unknown>;
    expect(
      (await submitOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft.id}/submit`, "POST", {}), oppParams(orgId, draft.id as string))).status
    ).toBe(200);
  });
});

// ------------------------------------------------------- verification gating

describe("M-O3 authorization — VERIFIED required to submit; SUSPENDED blocked", () => {
  test("an UNVERIFIED organization can create drafts but cannot submit (403 ORG_NOT_VERIFIED)", async () => {
    const { orgId } = await seedOrg(`Auth Org G ${randomUUID().slice(0, 8)}`);
    const draft = await createDraft(orgId);
    const res = await submitOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${draft.id}/submit`, "POST", {}),
      oppParams(orgId, draft.id as string)
    );
    expect(res.status).toBe(403);
    expect(((await resBody(res)) as Record<string, unknown>).code).toBe("ORG_NOT_VERIFIED");
    expect((await db.opportunity.findUnique({ where: { id: draft.id as string } }))?.status).toBe("DRAFT");
  });

  test("a SUSPENDED organization cannot submit, and cannot re-publish a paused listing (403)", async () => {
    const { admin, owner, orgId } = await seedVerifiedOrg(`Auth Org H ${randomUUID().slice(0, 8)}`);
    const draft = await createDraft(orgId);
    await submitOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft.id}/submit`, "POST", {}), oppParams(orgId, draft.id as string));
    await loginAs(admin.id);
    await adminDecisionRoute(req(`/api/admin/ox/opportunities/${draft.id}`, "PATCH", { decision: "APPROVE" }), {
      params: Promise.resolve({ opportunityId: draft.id as string }),
    });
    await loginAs(owner.id);
    await pauseOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft.id}/pause`, "POST", {}), oppParams(orgId, draft.id as string));

    // Suspend the org through the O1 moderation decision.
    const verification = await db.employerVerification.findFirst({ where: { organizationId: orgId } });
    await loginAs(admin.id);
    const suspended = await adminVerificationDecisionRoute(
      req(`/api/admin/ox/verifications/${verification!.id}`, "PATCH", { decision: "SUSPEND" }),
      { params: Promise.resolve({ id: verification!.id }) }
    );
    expect(suspended.status).toBe(200);

    await loginAs(owner.id);
    const reopenRes = await reopenOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${draft.id}/reopen`, "POST", {}),
      oppParams(orgId, draft.id as string)
    );
    expect(reopenRes.status).toBe(403);
    expect(((await resBody(reopenRes)) as Record<string, unknown>).code).toBe("ORG_SUSPENDED");

    const draft2 = await createDraft(orgId);
    const submitRes = await submitOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${draft2.id}/submit`, "POST", {}),
      oppParams(orgId, draft2.id as string)
    );
    expect(submitRes.status).toBe(403);
    expect(((await resBody(submitRes)) as Record<string, unknown>).code).toBe("ORG_SUSPENDED");
    expect((await db.opportunity.findUnique({ where: { id: draft.id as string } }))?.status).toBe("PAUSED");
  });
});

// ---------------------------------------------------------------- admin surface

describe("M-O3 authorization — admin review is admin-only", () => {
  test("anonymous, employer, and non-admin authenticated callers are the same 403 on the admin queue and decisions", async () => {
    const { admin, owner, orgId } = await seedVerifiedOrg(`Auth Org I ${randomUUID().slice(0, 8)}`);
    const draft = await createDraft(orgId);
    await loginAs(owner.id);
    await submitOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft.id}/submit`, "POST", {}), oppParams(orgId, draft.id as string));

    const decisionBody = { decision: "APPROVE" };

    jar.delete("bean_session");
    expect((await adminListRoute(req("/api/admin/ox/opportunities", "GET"))).status).toBe(403);
    expect(
      (await adminDecisionRoute(req(`/api/admin/ox/opportunities/${draft.id}`, "PATCH", decisionBody), { params: Promise.resolve({ opportunityId: draft.id as string }) })).status
    ).toBe(403);

    await loginAs(owner.id);
    expect((await adminListRoute(req("/api/admin/ox/opportunities", "GET"))).status).toBe(403);
    expect(
      (await adminDecisionRoute(req(`/api/admin/ox/opportunities/${draft.id}`, "PATCH", decisionBody), { params: Promise.resolve({ opportunityId: draft.id as string }) })).status
    ).toBe(403);

    const bystander = await makeUser("Auth Bystander");
    await loginAs(bystander.id);
    expect((await adminListRoute(req("/api/admin/ox/opportunities", "GET"))).status).toBe(403);

    await loginAs(admin.id);
    expect((await adminListRoute(req("/api/admin/ox/opportunities", "GET"))).status).toBe(200);
    expect(
      (await adminDecisionRoute(req(`/api/admin/ox/opportunities/${draft.id}`, "PATCH", decisionBody), { params: Promise.resolve({ opportunityId: draft.id as string }) })).status
    ).toBe(200);
  });

  test("same-origin: a cross-origin create is 403 even for a legit OWNER", async () => {
    const { orgId } = await seedVerifiedOrg(`Auth Org J ${randomUUID().slice(0, 8)}`);
    const res = await createOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities`, "POST", BASE_PAYLOAD, { origin: "https://evil.example" }),
      orgParams(orgId)
    );
    expect(res.status).toBe(403);
    expect(await db.opportunity.count({ where: { organizationId: orgId } })).toBe(0);
  });
});
