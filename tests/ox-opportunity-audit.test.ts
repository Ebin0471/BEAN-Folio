import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// M-O3 audit persistence tests: every lifecycle/review/deletion action
// writes exactly one AuditEvent with the right action, actor and from→to
// meta; the trail survives a fresh re-read (persistence across requests);
// the O1 organization audit trail stays intact alongside the O3 entries
// (no rewriting of unrelated audit history); admin decisions reuse
// auditModeration and notify() writes real Notification rows via dedupeKey.
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
import { PATCH as adminVerificationDecisionRoute } from "@/app/api/admin/ox/verifications/[id]/route";
import { POST as createOpportunityRoute } from "@/app/api/employers/[id]/opportunities/route";
import {
  PATCH as patchOpportunityRoute,
  DELETE as deleteOpportunityRoute,
} from "@/app/api/employers/[id]/opportunities/[opportunityId]/route";
import { POST as submitOpportunityRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/submit/route";
import { POST as pauseOpportunityRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/pause/route";
import { POST as reopenOpportunityRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/reopen/route";
import { POST as outcomeOpportunityRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/outcome/route";
import { PATCH as adminDecisionRoute } from "@/app/api/admin/ox/opportunities/[opportunityId]/route";

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

const oppParams = (id: string, opportunityId: string) => ({ params: Promise.resolve({ id, opportunityId }) });
const orgParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function makeUser(name: string, role?: string) {
  return db.user.create({
    data: {
      email: `ox-opp-audit-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("ox-opp-audit-password-1"),
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

const BASE_PAYLOAD = {
  title: "Audited role",
  description: "Every action in this lifecycle must leave exactly one matching audit event.",
  salaryMinPaise: 750_000_00,
  salaryMaxPaise: 950_000_00,
  salaryCurrency: "INR",
  compensationPeriod: "YEAR",
};

describe("M-O3 audit — one entry per action, correct actor and from→to meta", () => {
  test("full lifecycle audit trail matches the performed actions 1:1 and persists on re-read", async () => {
    const owner = await makeUser("Audit Owner");
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "Audit Ltd", displayName: `Audit Org ${randomUUID().slice(0, 8)}` }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
    await submitVerificationRoute(req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "audit-ref-0001" }), orgParams(orgId));
    const admin = await makeUser("Audit Admin", "ADMIN");
    const pending = await db.employerVerification.findFirst({ where: { organizationId: orgId, status: "PENDING" } });
    await loginAs(admin.id);
    await adminVerificationDecisionRoute(
      req(`/api/admin/ox/verifications/${pending!.id}`, "PATCH", { decision: "APPROVE" }),
      { params: Promise.resolve({ id: pending!.id }) }
    );

    // Employer lifecycle: create → submit → (admin) approve → pause → reopen → outcome FILLED.
    await loginAs(owner.id);
    const draft = await createOpportunityRoute(req(`/api/employers/${orgId}/opportunities`, "POST", BASE_PAYLOAD), orgParams(orgId));
    const opportunityId = ((await resBody(draft)).opportunity as Record<string, unknown>).id as string;
    await submitOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${opportunityId}/submit`, "POST", {}), oppParams(orgId, opportunityId));
    await loginAs(admin.id);
    await adminDecisionRoute(req(`/api/admin/ox/opportunities/${opportunityId}`, "PATCH", { decision: "APPROVE" }), {
      params: Promise.resolve({ opportunityId: opportunityId }),
    });
    await loginAs(owner.id);
    await pauseOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${opportunityId}/pause`, "POST", {}), oppParams(orgId, opportunityId));
    await reopenOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${opportunityId}/reopen`, "POST", {}), oppParams(orgId, opportunityId));
    await outcomeOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${opportunityId}/outcome`, "POST", { outcome: "FILLED" }),
      oppParams(orgId, opportunityId)
    );

    const trail = await db.auditEvent.findMany({
      where: { targetType: "OPPORTUNITY", targetId: opportunityId },
      orderBy: { createdAt: "asc" },
    });
    const actions = trail.map((a) => a.action);
    expect(actions).toEqual([
      "ox.opportunity.created",
      "ox.opportunity.submitted",
      "ox.opportunity.approved",
      "ox.opportunity.paused",
      "ox.opportunity.reopened",
      "ox.opportunity.filled",
    ]);
    expect(trail[0].actorUserId).toBe(owner.id);
    expect(trail[2].actorUserId).toBe(admin.id);
    const submitMeta = JSON.parse(trail[1].meta) as Record<string, unknown>;
    expect(submitMeta.from).toBe("DRAFT");
    expect(submitMeta.to).toBe("PENDING_REVIEW");
    const approveMeta = JSON.parse(trail[2].meta) as Record<string, unknown>;
    expect(approveMeta.to).toBe("PUBLISHED");

    // Persistence: a second, completely fresh read returns the same trail.
    const reread = await db.auditEvent.findMany({
      where: { targetType: "OPPORTUNITY", targetId: opportunityId },
      orderBy: { createdAt: "asc" },
    });
    expect(reread.map((a) => a.id)).toEqual(trail.map((a) => a.id));
  });

  test("a refused transition writes NO audit entry (audit matches committed state only)", async () => {
    const owner = await makeUser("Audit Owner 2");
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "Audit2 Ltd", displayName: `Audit Org2 ${randomUUID().slice(0, 8)}` }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
    const draft = await createOpportunityRoute(req(`/api/employers/${orgId}/opportunities`, "POST", BASE_PAYLOAD), orgParams(orgId));
    const opportunityId = ((await resBody(draft)).opportunity as Record<string, unknown>).id as string;

    // pause on DRAFT is illegal → 409 → no audit entry for that action.
    const refused = await pauseOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${opportunityId}/pause`, "POST", {}),
      oppParams(orgId, opportunityId)
    );
    expect(refused.status).toBe(409);
    const trail = await db.auditEvent.findMany({ where: { targetType: "OPPORTUNITY", targetId: opportunityId } });
    expect(trail.map((a) => a.action)).toEqual(["ox.opportunity.created"]);
    expect(trail.some((a) => a.action === "ox.opportunity.paused")).toBe(false);
  });

  test("rejected decision is audited with the reason and returns to DRAFT; the O1 org audit trail stays intact", async () => {
    const owner = await makeUser("Audit Owner 3");
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "Audit3 Ltd", displayName: `Audit Org3 ${randomUUID().slice(0, 8)}` }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
    await submitVerificationRoute(req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "audit3-ref" }), orgParams(orgId));
    const admin = await makeUser("Audit Admin 3", "ADMIN");
    const pending = await db.employerVerification.findFirst({ where: { organizationId: orgId, status: "PENDING" } });
    await loginAs(admin.id);
    await adminVerificationDecisionRoute(
      req(`/api/admin/ox/verifications/${pending!.id}`, "PATCH", { decision: "APPROVE" }),
      { params: Promise.resolve({ id: pending!.id }) }
    );

    await loginAs(owner.id);
    const draft = await createOpportunityRoute(req(`/api/employers/${orgId}/opportunities`, "POST", BASE_PAYLOAD), orgParams(orgId));
    const opportunityId = ((await resBody(draft)).opportunity as Record<string, unknown>).id as string;
    await submitOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${opportunityId}/submit`, "POST", {}), oppParams(orgId, opportunityId));
    await loginAs(admin.id);
    const rejected = await adminDecisionRoute(
      req(`/api/admin/ox/opportunities/${opportunityId}`, "PATCH", { decision: "REJECT", rejectionReason: "Description must include the review cadence." }),
      { params: Promise.resolve({ opportunityId: opportunityId }) }
    );
    expect(rejected.status).toBe(200);

    const trail = await db.auditEvent.findMany({
      where: { targetType: "OPPORTUNITY", targetId: opportunityId },
      orderBy: { createdAt: "asc" },
    });
    const last = trail[trail.length - 1];
    expect(last.action).toBe("ox.opportunity.rejected");
    expect(last.actorUserId).toBe(admin.id);
    const meta = JSON.parse(last.meta) as Record<string, unknown>;
    expect(meta.to).toBe("DRAFT");
    expect(meta.rejectionReason).toBe("Description must include the review cadence.");
    expect((await db.opportunity.findUnique({ where: { id: opportunityId } }))?.status).toBe("DRAFT");

    // The employer's notification about the decision arrived via notify()
    // (dedupeKey upsert) — never a direct notification-table write path.
    const notification = await db.notification.findFirst({
      where: { userId: owner.id, dedupKey: `ox-opportunity-reject:${opportunityId}` },
    });
    expect(notification).not.toBeNull();

    // O1 preservation: the org's own audit history (org.created +
    // verification.submitted + verification.approved) is untouched.
    const orgTrail = await db.auditEvent.findMany({
      where: { targetType: "EMPLOYER_ORGANIZATION", targetId: orgId },
      orderBy: { createdAt: "asc" },
    });
    expect(orgTrail[0].action).toBe("ox.org.created");
    const verificationTrail = await db.auditEvent.findMany({
      where: { targetType: "EMPLOYER_VERIFICATION", targetId: pending!.id },
    });
    expect(verificationTrail.some((a) => a.action === "ox.verification.approved")).toBe(true);
  });

  test("deletion is audited with a snapshot that survives the row (title + skillCount + actor role)", async () => {
    const owner = await makeUser("Audit Owner 4");
    await loginAs(owner.id);
    const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "Audit4 Ltd", displayName: `Audit Org4 ${randomUUID().slice(0, 8)}` }));
    const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
    const skill = await db.skill.create({ data: { slug: `audit-del-${randomUUID().slice(0, 8)}`, label: "Audit Delete Skill" } });
    const draft = await createOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities`, "POST", { ...BASE_PAYLOAD, skills: [{ skill: skill.slug, kind: "REQUIRED" }] }),
      orgParams(orgId)
    );
    const opportunityId = ((await resBody(draft)).opportunity as Record<string, unknown>).id as string;

    const deleted = await deleteOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${opportunityId}`, "DELETE"),
      oppParams(orgId, opportunityId)
    );
    expect(deleted.status).toBe(200);
    expect(await db.opportunity.findUnique({ where: { id: opportunityId } })).toBeNull();

    const deletionAudit = await db.auditEvent.findFirst({
      where: { targetType: "OPPORTUNITY", targetId: opportunityId, action: "ox.opportunity.deleted" },
    });
    expect(deletionAudit).not.toBeNull();
    expect(deletionAudit?.actorUserId).toBe(owner.id);
    const meta = JSON.parse(deletionAudit!.meta) as Record<string, unknown>;
    expect(meta.title).toBe(BASE_PAYLOAD.title);
    expect(meta.status).toBe("DRAFT");
    expect(meta.skillCount).toBe(1);
  });
});
