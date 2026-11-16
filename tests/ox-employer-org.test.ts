import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// O1 employer-organization + membership tests. Same stateful cookie-jar mock
// as tests/auth-routes.test.ts: the route handlers are unchanged; only the
// cookie transport is simulated. Sessions are created directly through
// createSession (writes the row; the jar carries the token).
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
import { GET as myOrgsRoute } from "@/app/api/employers/me/route";
import { PATCH as patchOrgRoute } from "@/app/api/employers/[id]/route";
import { POST as inviteRoute, GET as listMembersRoute } from "@/app/api/employers/[id]/members/route";
import { PATCH as patchMemberRoute } from "@/app/api/employers/[id]/members/[memberId]/route";
import { POST as transferRoute } from "@/app/api/employers/[id]/transfer-ownership/route";

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

const orgParams = (id: string) => ({ params: Promise.resolve({ id }) });
const memberParams = (id: string, memberId: string) => ({
  params: Promise.resolve({ id, memberId }),
});

async function makeUser(name: string, opts?: { username?: string; isDemo?: boolean; deletedAt?: Date }) {
  return db.user.create({
    data: {
      email: `ox-org-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("ox-org-password-1"),
      name,
      username: opts?.username ?? null,
      isDemo: opts?.isDemo ?? false,
      ...(opts?.deletedAt ? { deletedAt: opts.deletedAt } : {}),
    },
  });
}

/** Create a session row for the user and point the cookie jar at it. */
async function loginAs(userId: string) {
  const token = await createSession(userId);
  jar.set("bean_session", token);
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

// Slug assertions must be unique PER RUN: the isolated test DB persists
// across local runs, so every created organization name carries a run
// suffix and the expected slugs are derived from it.
const RUN = randomUUID().slice(0, 8);

// ------------------------------------------------------------- organization

describe("POST /api/employers (create organization)", () => {
  test("401 for anonymous callers", async () => {
    jar.delete("bean_session");
    const res = await createOrgRoute(req("/api/employers", "POST", { legalName: "X", displayName: "Y" }));
    expect(res.status).toBe(401);
  });

  test("201 creates org + OWNER membership in ONE transaction; slug auto-derived; audited", async () => {
    const owner = await makeUser("Org Owner One");
    await loginAs(owner.id);
    const res = await createOrgRoute(
      req("/api/employers", "POST", {
        legalName: "Acme Studios Private Limited",
        displayName: `Acme Studios ${RUN}`,
        industry: "Design",
        companySize: "SMB_11_50",
        headquarters: "Bengaluru",
        website: "https://acme.example",
      })
    );
    expect(res.status).toBe(201);
    const body = await resBody(res);
    const org = body.organization as Record<string, unknown>;
    const membership = body.membership as Record<string, unknown>;
    expect(org.slug).toBe(`acme-studios-${RUN}`);
    expect(org.verificationStatus).toBe("UNVERIFIED");
    expect(membership.role).toBe("OWNER");
    expect(membership.status).toBe("ACTIVE");
    expect(membership.joinedAt).not.toBeNull();

    const orgRow = await db.employerOrganization.findUnique({ where: { id: org.id as string } });
    expect(orgRow).not.toBeNull();
    const memRow = await db.employerMembership.findUnique({
      where: { organizationId_userId: { organizationId: org.id as string, userId: owner.id } },
    });
    expect(memRow?.role).toBe("OWNER");
    expect(memRow?.status).toBe("ACTIVE");

    const audit = await db.auditEvent.findFirst({
      where: { action: "ox.org.created", targetId: org.id as string },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(owner.id);
  });

  test("explicit slug collision → 409; duplicate memberships prevented by the transaction", async () => {
    const owner = await makeUser("Org Owner Two");
    await loginAs(owner.id);
    const first = await createOrgRoute(req("/api/employers", "POST", { legalName: "Northwind Ltd", displayName: "Northwind", slug: `northwind-taken-${RUN}` }));
    expect(first.status).toBe(201);
    const second = await createOrgRoute(req("/api/employers", "POST", { legalName: "Other Ltd", displayName: "Other", slug: `northwind-taken-${RUN}` }));
    expect(second.status).toBe(409);
  });

  test("same display name from two owners → uniquified slugs, never a collision", async () => {
    const a = await makeUser("Slug Owner A");
    const b = await makeUser("Slug Owner B");
    await loginAs(a.id);
    const ra = await createOrgRoute(req("/api/employers", "POST", { legalName: "Dup Name Ltd", displayName: `Dup Name ${RUN}` }));
    await loginAs(b.id);
    const rb = await createOrgRoute(req("/api/employers", "POST", { legalName: "Dup Name Ltd", displayName: `Dup Name ${RUN}` }));
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    const slugA = ((await resBody(ra)).organization as Record<string, unknown>).slug as string;
    const slugB = ((await resBody(rb)).organization as Record<string, unknown>).slug as string;
    expect(slugA).toBe(`dup-name-${RUN}`);
    expect(slugB).toBe(`dup-name-${RUN}-2`);
  });

  test("invalid body → 400 (strict zod: unknown keys rejected, OWNER role never invitable)", async () => {
    const owner = await makeUser("Org Owner Three");
    await loginAs(owner.id);
    const bad = await createOrgRoute(req("/api/employers", "POST", { legalName: "X Ltd", displayName: "X", hacker: true }));
    expect(bad.status).toBe(400);
    const shortLegal = await createOrgRoute(req("/api/employers", "POST", { legalName: "X", displayName: "Y" }));
    expect(shortLegal.status).toBe(400);
  });
});

describe("GET /api/employers/me", () => {
  test("lists the caller's memberships with the org and own role; REMOVED rows are hidden", async () => {
    const owner = await makeUser("Me Owner");
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "Me Org Ltd", displayName: "Me Org" }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
    // simulate a removed membership on a second org
    const other = await db.employerOrganization.create({
      data: { legalName: "Gone Ltd", displayName: "Gone", slug: `gone-${randomUUID().slice(0, 8)}` },
    });
    await db.employerMembership.create({
      data: { organizationId: other.id, userId: owner.id, role: "VIEWER", status: "REMOVED" },
    });
    const res = await myOrgsRoute(req("/api/employers/me", "GET"));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    const list = body.memberships as Record<string, unknown>[];
    expect(list.some((m) => (m.organization as Record<string, unknown>).id === orgId)).toBe(true);
    expect(list.some((m) => (m.organization as Record<string, unknown>).id === other.id)).toBe(false);
    const mine = list.find((m) => (m.organization as Record<string, unknown>).id === orgId)!;
    expect(mine.role).toBe("OWNER");
  });
});

describe("PATCH /api/employers/[id]", () => {
  test("OWNER updates the profile; slug immutable; audit written", async () => {
    const owner = await makeUser("Patch Owner");
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "Patch Ltd", displayName: `Patch Org ${RUN}` }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
    const res = await patchOrgRoute(
      req(`/api/employers/${orgId}`, "PATCH", { displayName: "Patch Org Renamed", description: "Updated" }),
      orgParams(orgId)
    );
    expect(res.status).toBe(200);
    const body = await resBody(res);
    const org = body.organization as Record<string, unknown>;
    expect(org.displayName).toBe("Patch Org Renamed");
    expect(org.slug).toBe(`patch-org-${RUN}`);
    const audit = await db.auditEvent.findFirst({ where: { action: "ox.org.updated", targetId: orgId } });
    expect(audit).not.toBeNull();
  });

  test("404-deny: anonymous, foreign owner, and VIEWER members cannot update", async () => {
    const owner = await makeUser("Patch Owner 2");
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "Isolation Ltd", displayName: "Isolation" }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;

    jar.delete("bean_session");
    expect((await patchOrgRoute(req(`/api/employers/${orgId}`, "PATCH", { description: "x" }), orgParams(orgId))).status).toBe(401);

    const foreign = await makeUser("Foreign Owner");
    await loginAs(foreign.id);
    expect((await patchOrgRoute(req(`/api/employers/${orgId}`, "PATCH", { description: "x" }), orgParams(orgId))).status).toBe(404);

    const viewer = await makeUser("Org Viewer 2");
    await db.employerMembership.create({
      data: { organizationId: orgId, userId: viewer.id, role: "VIEWER", status: "ACTIVE" },
    });
    await loginAs(viewer.id);
    expect((await patchOrgRoute(req(`/api/employers/${orgId}`, "PATCH", { description: "x" }), orgParams(orgId))).status).toBe(404);
  });
});

// ------------------------------------------------------------- membership

describe("POST /api/employers/[id]/members (invites)", () => {
  async function seedOrg(name: string) {
    const owner = await makeUser(`${name} Owner`);
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: `${name} Ltd`, displayName: name }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
    return { owner, orgId };
  }

  test("201 invites by username → INVITED row; duplicate invite → 409; reactivating REMOVED reuses the row", async () => {
    const { orgId } = await seedOrg("Invite Org");
    const invitee = await makeUser("Invitee One", { username: `invitee-${randomUUID().slice(0, 8)}` });
    const username = invitee.username!;
    await loginAs(await db.user.findFirstOrThrow({ where: { id: invitee.id } }).then((u) => u.id));
    // invite as the org owner (jar currently holds invitee — switch back below)
    const ownerId = (
      await db.employerMembership.findFirstOrThrow({ where: { organizationId: orgId, role: "OWNER" } })
    ).userId;
    await loginAs(ownerId);
    const res = await inviteRoute(req(`/api/employers/${orgId}/members`, "POST", { username, role: "RECRUITER" }), orgParams(orgId));
    expect(res.status).toBe(201);
    const row = (await resBody(res)).membership as Record<string, unknown>;
    expect(row.status).toBe("INVITED");
    expect(row.role).toBe("RECRUITER");

    const dup = await inviteRoute(req(`/api/employers/${orgId}/members`, "POST", { username, role: "VIEWER" }), orgParams(orgId));
    expect(dup.status).toBe(409);

    // decline (self-service) then re-invite: SAME row reactivated, never a second row
    await loginAs(invitee.id);
    const declined = await patchMemberRoute(
      req(`/api/employers/${orgId}/members/${row.id}`, "PATCH", { status: "REMOVED" }),
      memberParams(orgId, row.id as string)
    );
    expect(declined.status).toBe(200);
    await loginAs(ownerId);
    const again = await inviteRoute(req(`/api/employers/${orgId}/members`, "POST", { username, role: "ADMIN" }), orgParams(orgId));
    expect(again.status).toBe(201);
    const row2 = (await resBody(again)).membership as Record<string, unknown>;
    expect(row2.id).toBe(row.id);
    expect(row2.status).toBe("INVITED");
    expect(row2.role).toBe("ADMIN");
  });

  test("404-deny for unknown usernames, demo accounts and deleted accounts", async () => {
    const { owner, orgId } = await seedOrg("Deny Org");
    await loginAs(owner.id);
    expect(
      (await inviteRoute(req(`/api/employers/${orgId}/members`, "POST", { username: "no-such-user", role: "VIEWER" }), orgParams(orgId))).status
    ).toBe(404);
    const demo = await makeUser("Demo Person", { username: `demo-${randomUUID().slice(0, 8)}`, isDemo: true });
    expect(
      (await inviteRoute(req(`/api/employers/${orgId}/members`, "POST", { username: demo.username!, role: "VIEWER" }), orgParams(orgId))).status
    ).toBe(404);
    const gone = await makeUser("Gone Person", { username: `gone-${randomUUID().slice(0, 8)}`, deletedAt: new Date() });
    expect(
      (await inviteRoute(req(`/api/employers/${orgId}/members`, "POST", { username: gone.username!, role: "VIEWER" }), orgParams(orgId))).status
    ).toBe(404);
  });

  test("ownership is never granted through an invite → 400", async () => {
    const { owner, orgId } = await seedOrg("NoOwnerInvite Org");
    await loginAs(owner.id);
    const res = await inviteRoute(
      req(`/api/employers/${orgId}/members`, "POST", { username: `someone-${randomUUID().slice(0, 8)}`, role: "OWNER" }),
      orgParams(orgId)
    );
    expect(res.status).toBe(400);
  });

  test("GET members is OWNER/ADMIN only; foreign owner → 404", async () => {
    const { owner, orgId } = await seedOrg("List Org");
    await loginAs(owner.id);
    expect((await listMembersRoute(req(`/api/employers/${orgId}/members`, "GET"), orgParams(orgId))).status).toBe(200);
    const foreign = await makeUser("List Foreign");
    await loginAs(foreign.id);
    expect((await listMembersRoute(req(`/api/employers/${orgId}/members`, "GET"), orgParams(orgId))).status).toBe(404);
  });
});

describe("PATCH /api/employers/[id]/members/[memberId] (role + status management)", () => {
  test("manager changes role and status; invalid transitions rejected", async () => {
    const owner = await makeUser("Mgr Owner");
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "Mgr Ltd", displayName: "Mgr Org" }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
    const member = await makeUser("Mgr Member");
    const mem = await db.employerMembership.create({
      data: { organizationId: orgId, userId: member.id, role: "VIEWER", status: "ACTIVE" },
    });

    await loginAs(owner.id);
    const roleChange = await patchMemberRoute(
      req(`/api/employers/${orgId}/members/${mem.id}`, "PATCH", { role: "HIRING_MANAGER" }),
      memberParams(orgId, mem.id)
    );
    expect(roleChange.status).toBe(200);
    expect(((await resBody(roleChange)).membership as Record<string, unknown>).role).toBe("HIRING_MANAGER");

    const suspend = await patchMemberRoute(
      req(`/api/employers/${orgId}/members/${mem.id}`, "PATCH", { status: "SUSPENDED" }),
      memberParams(orgId, mem.id)
    );
    expect(suspend.status).toBe(200);
    const reactivate = await patchMemberRoute(
      req(`/api/employers/${orgId}/members/${mem.id}`, "PATCH", { status: "ACTIVE" }),
      memberParams(orgId, mem.id)
    );
    expect(reactivate.status).toBe(200);

    // INVITED→ACTIVE by a manager is not the accept flow — invalid transition
    const invited = await makeUser("Invited Person");
    const invRow = await db.employerMembership.create({
      data: { organizationId: orgId, userId: invited.id, role: "VIEWER", status: "INVITED" },
    });
    const bad = await patchMemberRoute(
      req(`/api/employers/${orgId}/members/${invRow.id}`, "PATCH", { status: "ACTIVE" }),
      memberParams(orgId, invRow.id)
    );
    expect(bad.status).toBe(400);

    const audit = await db.auditEvent.findFirst({ where: { action: "ox.member.updated", targetId: mem.id } });
    expect(audit).not.toBeNull();
  });

  test("role=OWNER through PATCH is always refused (ownership moves via transfer only)", async () => {
    const owner = await makeUser("OwnerRoute Owner");
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "OwnerRoute Ltd", displayName: "OwnerRoute" }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
    const member = await makeUser("OwnerRoute Member");
    const mem = await db.employerMembership.create({
      data: { organizationId: orgId, userId: member.id, role: "ADMIN", status: "ACTIVE" },
    });
    await loginAs(owner.id);
    const res = await patchMemberRoute(
      req(`/api/employers/${orgId}/members/${mem.id}`, "PATCH", { role: "OWNER" }),
      memberParams(orgId, mem.id)
    );
    expect(res.status).toBe(400);
    expect((await db.employerMembership.findUniqueOrThrow({ where: { id: mem.id } })).role).toBe("ADMIN");
  });

  test("the final active owner cannot be demoted or removed → 409", async () => {
    const owner = await makeUser("Last Owner");
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "Last Ltd", displayName: "Last Org" }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
    const ownerRow = await db.employerMembership.findFirstOrThrow({ where: { organizationId: orgId, role: "OWNER" } });

    const demote = await patchMemberRoute(
      req(`/api/employers/${orgId}/members/${ownerRow.id}`, "PATCH", { role: "ADMIN" }),
      memberParams(orgId, ownerRow.id)
    );
    expect(demote.status).toBe(409);
    const remove = await patchMemberRoute(
      req(`/api/employers/${orgId}/members/${ownerRow.id}`, "PATCH", { status: "REMOVED" }),
      memberParams(orgId, ownerRow.id)
    );
    expect(remove.status).toBe(409);
    const suspend = await patchMemberRoute(
      req(`/api/employers/${orgId}/members/${ownerRow.id}`, "PATCH", { status: "SUSPENDED" }),
      memberParams(orgId, ownerRow.id)
    );
    expect(suspend.status).toBe(409);
    // state unchanged
    expect((await db.employerMembership.findUniqueOrThrow({ where: { id: ownerRow.id } })).role).toBe("OWNER");
    expect((await db.employerMembership.findUniqueOrThrow({ where: { id: ownerRow.id } })).status).toBe("ACTIVE");
  });

  test("an ADMIN cannot modify an OWNER row → 403", async () => {
    const owner = await makeUser("AdminLimit Owner");
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "AdminLimit Ltd", displayName: "AdminLimit" }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
    const admin = await makeUser("AdminLimit Admin");
    await db.employerMembership.create({
      data: { organizationId: orgId, userId: admin.id, role: "ADMIN", status: "ACTIVE" },
    });
    const ownerRow = await db.employerMembership.findFirstOrThrow({ where: { organizationId: orgId, role: "OWNER" } });
    await loginAs(admin.id);
    const res = await patchMemberRoute(
      req(`/api/employers/${orgId}/members/${ownerRow.id}`, "PATCH", { status: "SUSPENDED" }),
      memberParams(orgId, ownerRow.id)
    );
    expect(res.status).toBe(403);
  });

  test("self-service: a pending member accepts their own invite; a member cannot manage others", async () => {
    const owner = await makeUser("SelfSvc Owner");
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "SelfSvc Ltd", displayName: "SelfSvc" }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
    const invitee = await makeUser("SelfSvc Invitee");
    const inv = await db.employerMembership.create({
      data: { organizationId: orgId, userId: invitee.id, role: "RECRUITER", status: "INVITED" },
    });
    const other = await db.employerMembership.findFirstOrThrow({ where: { organizationId: orgId, role: "OWNER" } });

    await loginAs(invitee.id);
    // foreign member row → 404
    expect(
      (await patchMemberRoute(req(`/api/employers/${orgId}/members/${other.id}`, "PATCH", { status: "SUSPENDED" }), memberParams(orgId, other.id))).status
    ).toBe(404);
    // role change on own row → 403
    expect(
      (await patchMemberRoute(req(`/api/employers/${orgId}/members/${inv.id}`, "PATCH", { role: "ADMIN" }), memberParams(orgId, inv.id))).status
    ).toBe(403);
    // accept → 200, joinedAt set
    const accept = await patchMemberRoute(
      req(`/api/employers/${orgId}/members/${inv.id}`, "PATCH", { status: "ACTIVE" }),
      memberParams(orgId, inv.id)
    );
    expect(accept.status).toBe(200);
    const row = (await resBody(accept)).membership as Record<string, unknown>;
    expect(row.status).toBe("ACTIVE");
    expect(row.joinedAt).not.toBeNull();
    const audit = await db.auditEvent.findFirst({ where: { action: "ox.member.accepted", targetId: inv.id } });
    expect(audit).not.toBeNull();
    // after accepting, self-service status changes are no longer allowed → 403
    expect(
      (await patchMemberRoute(req(`/api/employers/${orgId}/members/${inv.id}`, "PATCH", { status: "REMOVED" }), memberParams(orgId, inv.id))).status
    ).toBe(403);
  });
});

// ------------------------------------------------- ownership transfer

describe("POST /api/employers/[id]/transfer-ownership", () => {
  async function seedTransfer() {
    const owner = await makeUser("Transfer Owner");
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "Transfer Ltd", displayName: "Transfer Org" }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
    const admin = await makeUser("Transfer Admin");
    const adminRow = await db.employerMembership.create({
      data: { organizationId: orgId, userId: admin.id, role: "ADMIN", status: "ACTIVE" },
    });
    return { owner, orgId, admin, adminRow };
  }

  test("happy path: re-authenticated transfer swaps roles atomically and audits", async () => {
    const { owner, orgId, adminRow } = await seedTransfer();
    await loginAs(owner.id);
    const res = await transferRoute(
      req(`/api/employers/${orgId}/transfer-ownership`, "POST", {
        toMemberId: adminRow.id,
        currentPassword: "ox-org-password-1",
      }),
      orgParams(orgId)
    );
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect((body.membership as Record<string, unknown>).role).toBe("ADMIN"); // previous owner
    expect((body.newOwner as Record<string, unknown>).role).toBe("OWNER");

    const adminAfter = await db.employerMembership.findUniqueOrThrow({ where: { id: adminRow.id } });
    expect(adminAfter.role).toBe("OWNER");
    const ownerAfter = await db.employerMembership.findFirstOrThrow({ where: { organizationId: orgId, userId: owner.id } });
    expect(ownerAfter.role).toBe("ADMIN");
    const audit = await db.auditEvent.findFirst({ where: { action: "ox.ownership.transferred", targetId: orgId } });
    expect(audit).not.toBeNull();
  });

  test("wrong password → 403, no state change", async () => {
    const { owner, orgId, adminRow } = await seedTransfer();
    await loginAs(owner.id);
    const res = await transferRoute(
      req(`/api/employers/${orgId}/transfer-ownership`, "POST", { toMemberId: adminRow.id, currentPassword: "wrong-password" }),
      orgParams(orgId)
    );
    expect(res.status).toBe(403);
    expect((await db.employerMembership.findUniqueOrThrow({ where: { id: adminRow.id } })).role).toBe("ADMIN");
    expect((await db.employerMembership.findFirstOrThrow({ where: { organizationId: orgId, userId: owner.id } })).role).toBe("OWNER");
  });

  test("404-deny: non-owners and anonymous callers; INVITED target ineligible", async () => {
    const { owner, orgId, admin, adminRow } = await seedTransfer();
    const foreign = await makeUser("Transfer Foreign");
    await loginAs(foreign.id);
    expect(
      (await transferRoute(req(`/api/employers/${orgId}/transfer-ownership`, "POST", { toMemberId: adminRow.id, currentPassword: "x" }), orgParams(orgId))).status
    ).toBe(404);

    jar.delete("bean_session");
    expect(
      (await transferRoute(req(`/api/employers/${orgId}/transfer-ownership`, "POST", { toMemberId: adminRow.id, currentPassword: "x" }), orgParams(orgId))).status
    ).toBe(401);

    await loginAs(owner.id);
    const invited = await makeUser("Transfer Invited");
    const invRow = await db.employerMembership.create({
      data: { organizationId: orgId, userId: invited.id, role: "VIEWER", status: "INVITED" },
    });
    expect(
      (await transferRoute(req(`/api/employers/${orgId}/transfer-ownership`, "POST", { toMemberId: invRow.id, currentPassword: "ox-org-password-1" }), orgParams(orgId))).status
    ).toBe(404);
    void admin;
  });
});
