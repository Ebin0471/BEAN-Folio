import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// M31 QA — active workspace context + server-enforced resolution. The
// bean_org cookie is UNTRUSTED input: every resolution re-verifies ACTIVE
// membership server-side and fails safe to the PERSONAL workspace.
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
import { resolveWorkspace } from "@/lib/workspace";
import { GET as workspaceRoute } from "@/app/api/me/workspace/route";
import { POST as switchRoute } from "@/app/api/me/workspace/switch/route";
import { POST as createOrgRoute } from "@/app/api/employers/route";

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

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

const RUN = randomUUID().slice(0, 8);

async function makeUser(name: string) {
  return db.user.create({
    data: {
      email: `ws-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("workspace-password-1"),
      name,
    },
  });
}

async function loginAs(userId: string) {
  const token = await createSession(userId);
  jar.set("bean_session", token);
}

async function createOrgAsOwner(ownerId: string, displayName: string) {
  await loginAs(ownerId);
  const res = await createOrgRoute(
    req("/api/employers", "POST", {
      legalName: `${displayName} Legal Private Limited`,
      displayName: `${displayName} ${RUN}`,
      industry: "Software",
      companySize: "STARTUP_1_10",
    })
  );
  expect(res.status).toBe(201);
  const body = await resBody(res);
  const org = (body.organization ?? body.org) as Record<string, unknown> | undefined;
  const orgId = (org?.id ?? body.id) as string;
  expect(orgId).toBeTruthy();
  return orgId;
}

describe("M31 resolveWorkspace — cookie is never an authorization", () => {
  test("no cookie → PERSONAL workspace", async () => {
    const user = await makeUser("No Cookie");
    jar.delete("bean_org");
    const ctx = await resolveWorkspace(user.id);
    expect(ctx).toEqual({ type: "PERSONAL", organizationId: null });
  });

  test("cookie pointing at a FOREIGN organization (non-member) fails safe to PERSONAL", async () => {
    const outsider = await makeUser("Outsider");
    const owner = await makeUser("Org Owner Foreign");
    const orgId = await createOrgAsOwner(owner.id, "Foreign Org");
    jar.set("bean_org", orgId);
    const ctx = await resolveWorkspace(outsider.id);
    // Fail-safe to least privilege — never an error, never access.
    expect(ctx.type).toBe("PERSONAL");
    expect((ctx as { organizationId: string | null }).organizationId).toBeNull();
  });

  test("cookie pointing at a nonexistent organization fails safe to PERSONAL", async () => {
    const user = await makeUser("Ghost Cookie");
    jar.set("bean_org", "nonexistent-org-id-xyz");
    const ctx = await resolveWorkspace(user.id);
    expect(ctx.type).toBe("PERSONAL");
  });

  test("ACTIVE member resolves to the ORGANIZATION workspace with role + org metadata", async () => {
    const owner = await makeUser("Org Owner Active");
    const orgId = await createOrgAsOwner(owner.id, "Active Org");
    jar.set("bean_org", orgId);
    const ctx = await resolveWorkspace(owner.id);
    expect(ctx.type).toBe("ORGANIZATION");
    const orgCtx = ctx as Extract<typeof ctx, { type: "ORGANIZATION" }>;
    expect(orgCtx.organizationId).toBe(orgId);
    expect(orgCtx.membershipRole).toBe("OWNER");
    expect(orgCtx.organization.displayName).toContain("Active Org");
    expect(typeof orgCtx.organization.verificationStatus).toBe("string");
  });

  test("SUSPENDED membership fails safe to PERSONAL (status re-verified on every call)", async () => {
    const member = await makeUser("Suspended Member");
    const owner = await makeUser("Susp Owner");
    const orgId = await createOrgAsOwner(owner.id, "Susp Org");
    const membership = await db.employerMembership.findFirst({ where: { organizationId: orgId, userId: owner.id } });
    expect(membership).toBeTruthy();
    // Invite + then suspend a second member.
    await db.employerMembership.create({
      data: { organizationId: orgId, userId: member.id, role: "VIEWER", status: "ACTIVE" },
    });
    jar.set("bean_org", orgId);
    const before = await resolveWorkspace(member.id);
    expect(before.type).toBe("ORGANIZATION");
    await db.employerMembership.update({
      where: { id: (await db.employerMembership.findFirst({ where: { organizationId: orgId, userId: member.id } }))!.id },
      data: { status: "SUSPENDED" },
    });
    const after = await resolveWorkspace(member.id);
    expect(after.type).toBe("PERSONAL");
  });
});

describe("M31 POST /api/me/workspace/switch — server-verified membership before cookie write", () => {
  test("401 anonymous", async () => {
    jar.delete("bean_session");
    jar.delete("bean_org");
    const res = await switchRoute(req("/api/me/workspace/switch", "POST", { organizationId: null }));
    expect(res.status).toBe(401);
  });

  test("non-member switching to a foreign organization → 404 deny (no existence disclosure)", async () => {
    const outsider = await makeUser("Switch Outsider");
    const owner = await makeUser("Switch Owner");
    const orgId = await createOrgAsOwner(owner.id, "Switch Foreign");
    await loginAs(outsider.id);
    const res = await switchRoute(req("/api/me/workspace/switch", "POST", { organizationId: orgId }));
    expect(res.status).toBe(404);
    // Cookie was NOT written.
    expect(jar.has("bean_org")).toBe(false);
  });

  test("INVITED-only membership cannot activate the workspace", async () => {
    const invited = await makeUser("Invited Only");
    const owner = await makeUser("Inv Owner");
    const orgId = await createOrgAsOwner(owner.id, "Invited Org");
    await db.employerMembership.create({
      data: { organizationId: orgId, userId: invited.id, role: "VIEWER", status: "INVITED" },
    });
    await loginAs(invited.id);
    const res = await switchRoute(req("/api/me/workspace/switch", "POST", { organizationId: orgId }));
    expect(res.status).toBe(404);
    expect(jar.has("bean_org")).toBe(false);
  });

  test("ACTIVE member switches successfully; cookie + audit event written; workspace route reflects it", async () => {
    const member = await makeUser("Active Switcher");
    const owner = await makeUser("Active Owner");
    const orgId = await createOrgAsOwner(owner.id, "Active Switch Org");
    await db.employerMembership.create({
      data: { organizationId: orgId, userId: member.id, role: "HIRING_MANAGER", status: "ACTIVE" },
    });
    await loginAs(member.id);
    const res = await switchRoute(req("/api/me/workspace/switch", "POST", { organizationId: orgId }));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    const ws = body.workspace as Record<string, unknown>;
    expect(ws.type).toBe("ORGANIZATION");
    expect(ws.membershipRole).toBe("HIRING_MANAGER");
    expect(jar.get("bean_org")).toBe(orgId);

    const listRes = await workspaceRoute();
    expect(listRes.status).toBe(200);
    const listBody = await resBody(listRes);
    const active = listBody.workspace as Record<string, unknown>;
    expect(active.type).toBe("ORGANIZATION");
    const memberships = listBody.memberships as Array<Record<string, unknown>>;
    expect(memberships.length).toBeGreaterThanOrEqual(1);
    expect(memberships.every((m) => ["ACTIVE", "INVITED"].includes(m.status as string))).toBe(true);

    const audit = await db.auditEvent.findFirst({
      where: { actorUserId: member.id, action: "workspace.switched", targetId: orgId },
    });
    expect(audit).toBeTruthy();
  });

  test("switching back to null clears the cookie → PERSONAL", async () => {
    const owner = await makeUser("Back Owner");
    const orgId = await createOrgAsOwner(owner.id, "Back Org");
    await loginAs(owner.id);
    await switchRoute(req("/api/me/workspace/switch", "POST", { organizationId: orgId }));
    expect(jar.get("bean_org")).toBe(orgId);
    const res = await switchRoute(req("/api/me/workspace/switch", "POST", { organizationId: null }));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect((body.workspace as Record<string, unknown>).type).toBe("PERSONAL");
    expect(jar.has("bean_org")).toBe(false);
    const ctx = await resolveWorkspace(owner.id);
    expect(ctx.type).toBe("PERSONAL");
  });
});

describe("M31 cross-organization isolation", () => {
  test("a member of org A cannot resolve or switch into org B they are not a member of", async () => {
    const memberA = await makeUser("Member A");
    const ownerA = await makeUser("Owner A");
    const orgA = await createOrgAsOwner(ownerA.id, "Org A Side");
    await db.employerMembership.create({
      data: { organizationId: orgA, userId: memberA.id, role: "RECRUITER", status: "ACTIVE" },
    });
    const ownerB = await makeUser("Owner B");
    const orgB = await createOrgAsOwner(ownerB.id, "Org B Side");

    // Direct resolution with a forged org-B cookie fails safe.
    await loginAs(memberA.id);
    jar.set("bean_org", orgB);
    const ctx = await resolveWorkspace(memberA.id);
    expect(ctx.type).toBe("PERSONAL");

    // Switch attempt → 404 deny.
    const res = await switchRoute(req("/api/me/workspace/switch", "POST", { organizationId: orgB }));
    expect(res.status).toBe(404);
    expect(jar.get("bean_org")).toBe(orgB); // stale cookie untouched, still resolves PERSONAL

    // Legitimate own organization still resolves.
    jar.set("bean_org", orgA);
    const own = await resolveWorkspace(memberA.id);
    expect(own.type).toBe("ORGANIZATION");
    expect((own as { organizationId: string }).organizationId).toBe(orgA);
  });
});
