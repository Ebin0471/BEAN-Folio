import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// O1 authorization & tenant-isolation tests: every employer operation is
// bound to (organizationId, caller); foreign-org access is a uniform 404
// (existence hiding); INVITED members are not managers; anonymous callers
// are 401. Role vocabulary is validated at the boundary (no client-supplied
// roles/statuses are ever trusted).
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
import { PATCH as patchOrgRoute } from "@/app/api/employers/[id]/route";
import { POST as inviteRoute, GET as listMembersRoute } from "@/app/api/employers/[id]/members/route";
import { PATCH as patchMemberRoute } from "@/app/api/employers/[id]/members/[memberId]/route";
import { POST as submitVerificationRoute } from "@/app/api/employers/[id]/verification/route";
import { POST as transferRoute } from "@/app/api/employers/[id]/transfer-ownership/route";
import { GET as adminListRoute } from "@/app/api/admin/ox/verifications/route";

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

async function makeUser(name: string) {
  return db.user.create({
    data: {
      email: `ox-tenant-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("ox-tenant-password-1"),
      name,
    },
  });
}

async function loginAs(userId: string) {
  jar.set("bean_session", (await createSession(userId)));
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

/** Org A with OWNER + ACTIVE VIEWER + INVITED member; org B with its own owner. */
async function seedTwoOrgs() {
  const ownerA = await makeUser("Tenant Owner A");
  await loginAs(ownerA.id);
  const createdA = await createOrgRoute(req("/api/employers", "POST", { legalName: "Tenant A Ltd", displayName: "Tenant A" }));
  const orgA = ((await resBody(createdA)).organization as Record<string, unknown>).id as string;

  const viewerA = await makeUser("Tenant Viewer A");
  const viewerRow = await db.employerMembership.create({
    data: { organizationId: orgA, userId: viewerA.id, role: "VIEWER", status: "ACTIVE" },
  });
  const invitedA = await makeUser("Tenant Invited A");
  const invitedRow = await db.employerMembership.create({
    data: { organizationId: orgA, userId: invitedA.id, role: "RECRUITER", status: "INVITED" },
  });

  const ownerB = await makeUser("Tenant Owner B");
  await loginAs(ownerB.id);
  const createdB = await createOrgRoute(req("/api/employers", "POST", { legalName: "Tenant B Ltd", displayName: "Tenant B" }));
  const orgB = ((await resBody(createdB)).organization as Record<string, unknown>).id as string;

  const memberB = await makeUser("Tenant Member B");
  const memberBRow = await db.employerMembership.create({
    data: { organizationId: orgB, userId: memberB.id, role: "RECRUITER", status: "ACTIVE" },
  });

  return { orgA, orgB, ownerA, viewerA, viewerRow, invitedA, invitedRow, ownerB, memberB, memberBRow };
}

describe("tenant isolation — org A operations against callers from org B", () => {
  test("ownerB cannot read members, update, invite, verify or transfer within org A (uniform 404)", async () => {
    const { orgA, ownerA, ownerB, memberBRow } = await seedTwoOrgs();
    await loginAs(ownerB.id);

    expect((await listMembersRoute(req(`/api/employers/${orgA}/members`, "GET"), orgParams(orgA))).status).toBe(404);
    expect(
      (await patchOrgRoute(req(`/api/employers/${orgA}`, "PATCH", { description: "intrusion" }), orgParams(orgA))).status
    ).toBe(404);
    expect(
      (
        await inviteRoute(
          req(`/api/employers/${orgA}/members`, "POST", { username: "some-username", role: "VIEWER" }),
          orgParams(orgA)
        )
      ).status
    ).toBe(404);
    expect(
      (await patchMemberRoute(req(`/api/employers/${orgA}/members/${memberBRow.id}`, "PATCH", { status: "SUSPENDED" }), memberParams(orgA, memberBRow.id))).status
    ).toBe(404);
    expect(
      (await submitVerificationRoute(req(`/api/employers/${orgA}/verification`, "POST", { evidenceReference: "ref-x-1234" }), orgParams(orgA))).status
    ).toBe(404);
    expect(
      (await transferRoute(req(`/api/employers/${orgA}/transfer-ownership`, "POST", { toMemberId: memberBRow.id, currentPassword: "x" }), orgParams(orgA))).status
    ).toBe(404);
    void ownerA;
  });

  test("a foreign member ROW id under org A's path is a 404 (no cross-tenant member ids)", async () => {
    const { orgA, ownerA, memberBRow } = await seedTwoOrgs();
    await loginAs(ownerA.id);
    // memberBRow belongs to org B — addressing it through org A must 404.
    expect(
      (await patchMemberRoute(req(`/api/employers/${orgA}/members/${memberBRow.id}`, "PATCH", { status: "SUSPENDED" }), memberParams(orgA, memberBRow.id))).status
    ).toBe(404);
  });

  test("non-manager members of org A cannot manage org A (uniform 404 for VIEWER and INVITED)", async () => {
    const { orgA, ownerA, viewerA, viewerRow, invitedA, invitedRow } = await seedTwoOrgs();

    await loginAs(viewerA.id);
    expect((await listMembersRoute(req(`/api/employers/${orgA}/members`, "GET"), orgParams(orgA))).status).toBe(404);
    expect(
      (await patchOrgRoute(req(`/api/employers/${orgA}`, "PATCH", { description: "nope" }), orgParams(orgA))).status
    ).toBe(404);
    expect(
      (
        await inviteRoute(
          req(`/api/employers/${orgA}/members`, "POST", { username: "another-user-1", role: "VIEWER" }),
          orgParams(orgA)
        )
      ).status
    ).toBe(404);
    expect(
      (await submitVerificationRoute(req(`/api/employers/${orgA}/verification`, "POST", { evidenceReference: "ref-v-1234" }), orgParams(orgA))).status
    ).toBe(404);

    await loginAs(invitedA.id);
    // An INVITED member is not yet a member for management purposes.
    expect((await listMembersRoute(req(`/api/employers/${orgA}/members`, "GET"), orgParams(orgA))).status).toBe(404);
    expect(
      (await patchOrgRoute(req(`/api/employers/${orgA}`, "PATCH", { description: "nope" }), orgParams(orgA))).status
    ).toBe(404);
    // …and cannot touch anyone else's membership row (not even as "self-management"
    // of a different row).
    expect(
      (await patchMemberRoute(req(`/api/employers/${orgA}/members/${viewerRow.id}`, "PATCH", { status: "REMOVED" }), memberParams(orgA, viewerRow.id))).status
    ).toBe(404);
    void ownerA;
  });

  test("anonymous callers get 401 on every OX endpoint (never 403/404 leaks)", async () => {
    const { orgA, ownerA, viewerRow } = await seedTwoOrgs();
    jar.delete("bean_session");
    expect((await createOrgRoute(req("/api/employers", "POST", { legalName: "Anon Ltd", displayName: "Anon" }))).status).toBe(401);
    expect((await listMembersRoute(req(`/api/employers/${orgA}/members`, "GET"), orgParams(orgA))).status).toBe(401);
    expect((await patchOrgRoute(req(`/api/employers/${orgA}`, "PATCH", { description: "x" }), orgParams(orgA))).status).toBe(401);
    expect(
      (await patchMemberRoute(req(`/api/employers/${orgA}/members/${viewerRow.id}`, "PATCH", { status: "REMOVED" }), memberParams(orgA, viewerRow.id))).status
    ).toBe(401);
    expect(
      (await submitVerificationRoute(req(`/api/employers/${orgA}/verification`, "POST", { evidenceReference: "ref-a-1234" }), orgParams(orgA))).status
    ).toBe(401);
    expect(
      (await transferRoute(req(`/api/employers/${orgA}/transfer-ownership`, "POST", { toMemberId: viewerRow.id, currentPassword: "x" }), orgParams(orgA))).status
    ).toBe(401);
    expect((await adminListRoute(req("/api/admin/ox/verifications", "GET"))).status).toBe(403);
    void ownerA;
  });
});
