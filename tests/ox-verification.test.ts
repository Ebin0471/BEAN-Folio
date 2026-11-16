import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// O1 employer verification tests: submission state machine, admin manual
// review (approve/reject/suspend/reinstate), audit trail, evidence-reference
// bounds, and requireAdmin authorization.
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
import { POST as submitVerificationRoute } from "@/app/api/employers/[id]/verification/route";
import { GET as adminListRoute } from "@/app/api/admin/ox/verifications/route";
import { GET as adminDetailRoute, PATCH as adminDecisionRoute } from "@/app/api/admin/ox/verifications/[id]/route";

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

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function makeUser(name: string, role?: string) {
  return db.user.create({
    data: {
      email: `ox-ver-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("ox-ver-password-1"),
      name,
      ...(role ? { role } : {}),
    },
  });
}

async function loginAs(userId: string) {
  jar.set("bean_session", (await createSession(userId)));
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

async function seedOrg() {
  const owner = await makeUser("Ver Owner");
  await loginAs(owner.id);
  const created = await createOrgRoute(req("/api/employers", "POST", {
    legalName: "Verify Ltd",
    displayName: `Verify Org ${randomUUID().slice(0, 8)}`,
  }));
  const body = await resBody(created);
  return { owner, orgId: (body.organization as Record<string, unknown>).id as string };
}

// ------------------------------------------------------------- submission

describe("POST /api/employers/[id]/verification (submission)", () => {
  test("401 anonymous; 404-deny foreign owner; VIEWER denied", async () => {
    const { orgId } = await seedOrg();

    jar.delete("bean_session");
    expect(
      (await submitVerificationRoute(req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "ref-0001" }), params(orgId))).status
    ).toBe(401);

    const foreign = await makeUser("Ver Foreign");
    await loginAs(foreign.id);
    expect(
      (await submitVerificationRoute(req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "ref-0001" }), params(orgId))).status
    ).toBe(404);

    const viewer = await makeUser("Ver Viewer");
    await db.employerMembership.create({
      data: { organizationId: orgId, userId: viewer.id, role: "VIEWER", status: "ACTIVE" },
    });
    await loginAs(viewer.id);
    expect(
      (await submitVerificationRoute(req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "ref-0001" }), params(orgId))).status
    ).toBe(404);
  });

  test("201: OWNER submits → PENDING row + org PENDING, audited; evidence reference stored as a REFERENCE", async () => {
    const { owner, orgId } = await seedOrg();
    await loginAs(owner.id);
    const res = await submitVerificationRoute(
      req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "registry-case-2026-0440" }),
      params(orgId)
    );
    expect(res.status).toBe(201);
    const body = await resBody(res);
    const verification = body.verification as Record<string, unknown>;
    expect(verification.status).toBe("PENDING");
    expect(verification.method).toBe("MANUAL_REVIEW");
    expect(verification.evidenceReference).toBe("registry-case-2026-0440");
    expect((body.organization as Record<string, unknown>).verificationStatus).toBe("PENDING");

    const org = await db.employerOrganization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.verificationStatus).toBe("PENDING");
    const audit = await db.auditEvent.findFirst({
      where: { action: "ox.verification.submitted", targetId: verification.id as string },
    });
    expect(audit?.actorUserId).toBe(owner.id);
  });

  test("409 while PENDING; 400 when the evidence reference is missing/too long", async () => {
    const { owner, orgId } = await seedOrg();
    await loginAs(owner.id);
    const first = await submitVerificationRoute(
      req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "case-ref-0001" }),
      params(orgId)
    );
    expect(first.status).toBe(201);
    const second = await submitVerificationRoute(
      req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "case-ref-0002" }),
      params(orgId)
    );
    expect(second.status).toBe(409);

    const org2 = await seedOrg();
    await loginAs(org2.owner.id);
    const tooShort = await submitVerificationRoute(req(`/api/employers/${org2.orgId}/verification`, "POST", { evidenceReference: "ab" }), params(org2.orgId));
    expect(tooShort.status).toBe(400);
    const tooLong = await submitVerificationRoute(
      req(`/api/employers/${org2.orgId}/verification`, "POST", { evidenceReference: "x".repeat(257) }),
      params(org2.orgId)
    );
    expect(tooLong.status).toBe(400);
    const strict = await submitVerificationRoute(
      req(`/api/employers/${org2.orgId}/verification`, "POST", { evidenceReference: "case-1", sneaky: "field" }),
      params(org2.orgId)
    );
    expect(strict.status).toBe(400);
  });
});

// ------------------------------------------------------------ admin review

describe("GET /api/admin/ox/verifications (queue + detail)", () => {
  test("403 for anonymous and non-admin callers (indistinguishable)", async () => {
    jar.delete("bean_session");
    expect((await adminListRoute(req("/api/admin/ox/verifications", "GET"))).status).toBe(403);
    const user = await makeUser("Plain User");
    await loginAs(user.id);
    expect((await adminListRoute(req("/api/admin/ox/verifications", "GET"))).status).toBe(403);
  });

  test("admin queue lists PENDING submissions with org context; detail returns the audit trail", async () => {
    const { owner, orgId } = await seedOrg();
    await loginAs(owner.id);
    const submitted = await submitVerificationRoute(
      req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "queue-case-0007" }),
      params(orgId)
    );
    const verificationId = ((await resBody(submitted)).verification as Record<string, unknown>).id as string;

    const admin = await makeUser("Ver Admin", "ADMIN");
    await loginAs(admin.id);
    const list = await adminListRoute(req("/api/admin/ox/verifications?status=PENDING", "GET"));
    expect(list.status).toBe(200);
    const items = ((await resBody(list)).verifications as Record<string, unknown>[]);
    const mine = items.find((v) => v.id === verificationId);
    expect(mine).toBeDefined();
    expect(((mine?.organization as Record<string, unknown>) ?? {}).slug).toBeDefined();

    const detail = await adminDetailRoute(req(`/api/admin/ox/verifications/${verificationId}`, "GET"), params(verificationId));
    expect(detail.status).toBe(200);
    const dBody = await resBody(detail);
    expect((dBody.verification as Record<string, unknown>).id).toBe(verificationId);
    expect(((dBody.organization as Record<string, unknown>) ?? {}).memberCount).toBe(1);
    expect((dBody.auditTrail as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("PATCH /api/admin/ox/verifications/[id] (decisions)", () => {
  async function seedPending() {
    const { owner, orgId } = await seedOrg();
    await loginAs(owner.id);
    const submitted = await submitVerificationRoute(
      req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "decision-case-0009" }),
      params(orgId)
    );
    const verificationId = ((await resBody(submitted)).verification as Record<string, unknown>).id as string;
    const admin = await makeUser(`Ver Admin ${randomUUID().slice(0, 8)}`, "ADMIN");
    await loginAs(admin.id);
    return { orgId, verificationId };
  }

  test("403 non-admin; APPROVE flips row + org (method + verifiedAt) and audits", async () => {
    const { orgId, verificationId } = await seedPending();
    const user = await makeUser("Not Admin Decision");
    await loginAs(user.id);
    expect(
      (await adminDecisionRoute(req(`/api/admin/ox/verifications/${verificationId}`, "PATCH", { decision: "APPROVE" }), params(verificationId))).status
    ).toBe(403);

    const admin = await db.user.findFirstOrThrow({ where: { role: "ADMIN", deletedAt: null } });
    await loginAs(admin.id);
    const res = await adminDecisionRoute(
      req(`/api/admin/ox/verifications/${verificationId}`, "PATCH", { decision: "APPROVE" }),
      params(verificationId)
    );
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect((body.verification as Record<string, unknown>).status).toBe("VERIFIED");
    expect((body.verification as Record<string, unknown>).reviewedAt).not.toBeNull();
    const orgOut = body.organization as Record<string, unknown>;
    expect(orgOut.verificationStatus).toBe("VERIFIED");
    expect(orgOut.verificationMethod).toBe("MANUAL_REVIEW");
    expect(orgOut.verifiedAt).not.toBeNull();

    const audit = await db.auditEvent.findFirst({
      where: { action: "ox.verification.approved", targetId: verificationId },
    });
    expect(audit).not.toBeNull();

    // decided rows are terminal → 409
    const again = await adminDecisionRoute(
      req(`/api/admin/ox/verifications/${verificationId}`, "PATCH", { decision: "REJECT", rejectionReason: "second try" }),
      params(verificationId)
    );
    expect(again.status).toBe(409);
    void orgId;
  });

  test("REJECT requires a reason; org → REJECTED and can re-submit", async () => {
    const { orgId, verificationId } = await seedPending();
    const admin = await db.user.findFirstOrThrow({ where: { role: "ADMIN", deletedAt: null } });
    await loginAs(admin.id);
    const noReason = await adminDecisionRoute(
      req(`/api/admin/ox/verifications/${verificationId}`, "PATCH", { decision: "REJECT" }),
      params(verificationId)
    );
    expect(noReason.status).toBe(400);
    const res = await adminDecisionRoute(
      req(`/api/admin/ox/verifications/${verificationId}`, "PATCH", { decision: "REJECT", rejectionReason: "Registry reference does not resolve" }),
      params(verificationId)
    );
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect((body.verification as Record<string, unknown>).status).toBe("REJECTED");
    expect((body.organization as Record<string, unknown>).verificationStatus).toBe("REJECTED");
    const audit = await db.auditEvent.findFirst({
      where: { action: "ox.verification.rejected", targetId: verificationId },
    });
    expect(audit).not.toBeNull();

    // re-submission after rejection is allowed (state machine: REJECTED → PENDING)
    const ownerRow = await db.employerMembership.findFirstOrThrow({ where: { organizationId: orgId, role: "OWNER" } });
    await loginAs(ownerRow.userId);
    const resubmit = await submitVerificationRoute(
      req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "decision-case-0010-fixed" }),
      params(orgId)
    );
    expect(resubmit.status).toBe(201);
  });

  test("SUSPEND + REINSTATE org moderation; suspended orgs cannot re-apply", async () => {
    const { orgId, verificationId } = await seedPending();
    const admin = await db.user.findFirstOrThrow({ where: { role: "ADMIN", deletedAt: null } });
    await loginAs(admin.id);

    const suspend = await adminDecisionRoute(
      req(`/api/admin/ox/verifications/${verificationId}`, "PATCH", { decision: "SUSPEND" }),
      params(verificationId)
    );
    expect(suspend.status).toBe(200);
    expect(
      (await db.employerOrganization.findUniqueOrThrow({ where: { id: orgId } })).verificationStatus
    ).toBe("SUSPENDED");
    const suspendAudit = await db.auditEvent.findFirst({
      where: { action: "ox.org.suspended", targetType: "EMPLOYER_ORGANIZATION", targetId: orgId },
    });
    expect(suspendAudit).not.toBeNull();

    // suspended orgs cannot submit → 403
    const ownerRow = await db.employerMembership.findFirstOrThrow({ where: { organizationId: orgId, role: "OWNER" } });
    await loginAs(ownerRow.userId);
    expect(
      (await submitVerificationRoute(req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "case-susp-01" }), params(orgId))).status
    ).toBe(403);

    // REINSTATE only from SUSPENDED
    await loginAs(admin.id);
    const reinstate = await adminDecisionRoute(
      req(`/api/admin/ox/verifications/${verificationId}`, "PATCH", { decision: "REINSTATE" }),
      params(verificationId)
    );
    expect(reinstate.status).toBe(200);
    expect(
      (await db.employerOrganization.findUniqueOrThrow({ where: { id: orgId } })).verificationStatus
    ).toBe("UNVERIFIED");
    const reinstateAgain = await adminDecisionRoute(
      req(`/api/admin/ox/verifications/${verificationId}`, "PATCH", { decision: "REINSTATE" }),
      params(verificationId)
    );
    expect(reinstateAgain.status).toBe(409);
  });
});
