import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// M-O3 opportunity lifecycle tests: the approved state machine
//   DRAFT → PENDING_REVIEW → PUBLISHED → PAUSED → FILLED | CLOSED
// with admin-only approval, atomic published-edit → PENDING_REVIEW returns,
// audited DRAFT-only deletion, and 409-with-zero-writes on every illegal
// transition. Same stateful cookie-jar harness as tests/ox-employer-org.test.ts.
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

const oppParams = (id: string, opportunityId: string) => ({
  params: Promise.resolve({ id, opportunityId }),
});
const orgParams2 = (id: string) => ({ params: Promise.resolve({ id }) });

async function makeUser(name: string, role?: string) {
  return db.user.create({
    data: {
      email: `ox-opp-life-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("ox-opp-life-password-1"),
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
  salaryMinPaise: 1_000_000_00, // ₹10,00,000 per year
  salaryMaxPaise: 1_800_000_00,
  salaryCurrency: "INR",
  compensationPeriod: "YEAR",
};

const BASE_PAYLOAD = {
  title: "Senior video editor",
  description: "Cut long-form documentary work with a distributed post team across three time zones.",
  ...COMPLETE_SALARY,
};

/** Owner + org + VERIFIED status through the real O1 flows (submit + admin approve). */
async function seedVerifiedOrg(displayName: string) {
  const owner = await makeUser("Life Owner");
  await loginAs(owner.id);
  const created = await createOrgRoute(
    req("/api/employers", "POST", { legalName: "Lifecycle Ltd", displayName })
  );
  const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
  await submitVerificationRoute(req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "life-ref-0001" }), {
    params: Promise.resolve({ id: orgId }),
  });
  const admin = await makeUser("Life Admin", "ADMIN");
  const pending = await db.employerVerification.findFirst({ where: { organizationId: orgId, status: "PENDING" } });
  await loginAs(admin.id);
  await adminVerificationDecisionRoute(
    req(`/api/admin/ox/verifications/${pending!.id}`, "PATCH", { decision: "APPROVE" }),
    { params: Promise.resolve({ id: pending!.id }) }
  );
  await loginAs(owner.id);
  return { owner, admin, orgId };
}

async function createDraft(orgId: string, overrides?: Record<string, unknown>) {
  const res = await createOpportunityRoute(
    req(`/api/employers/${orgId}/opportunities`, "POST", { ...BASE_PAYLOAD, ...overrides }),
    orgParams2(orgId)
  );
  const body = (await resBody(res)).opportunity as Record<string, unknown>;
  return body;
}

async function rowOf(opportunityId: string) {
  return db.opportunity.findUnique({ where: { id: opportunityId } });
}

// ---------------------------------------------------------------- happy path

describe("M-O3 lifecycle — legal transitions", () => {
  test("create → 201 DRAFT; draft is invisible to publication and lands with its skills", async () => {
    const { orgId } = await seedVerifiedOrg(`Life Org A ${randomUUID().slice(0, 8)}`);
    const skill = await db.skill.create({ data: { slug: `life-skill-${randomUUID().slice(0, 8)}`, label: "Lifecycle Skill" } });
    const body = await createDraft(orgId, { skills: [{ skill: skill.slug, kind: "REQUIRED" }] });
    expect(body.status).toBe("DRAFT");
    expect(body.publishedAt).toBeNull();
    expect(body.salaryMinPaise).toBe(COMPLETE_SALARY.salaryMinPaise);
    expect((body.skills as Record<string, unknown>[])[0].slug).toBe(skill.slug);

    const list = await listOpportunitiesRoute(req(`/api/employers/${orgId}/opportunities`, "GET"), orgParams2(orgId));
    expect(list.status).toBe(200);
    expect(((await resBody(list)).opportunities as unknown[]).length).toBe(1);
  });

  test("submit → PENDING_REVIEW (submittedAt set); admin approve → PUBLISHED with publishedBy set", async () => {
    const { admin, orgId } = await seedVerifiedOrg(`Life Org B ${randomUUID().slice(0, 8)}`);
    const draft = await createDraft(orgId);

    const submitted = await submitOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${draft.id}/submit`, "POST", {}),
      oppParams(orgId, draft.id as string)
    );
    expect(submitted.status).toBe(200);
    const afterSubmit = (await resBody(submitted)).opportunity as Record<string, unknown>;
    expect(afterSubmit.status).toBe("PENDING_REVIEW");
    expect(afterSubmit.submittedAt).not.toBeNull();

    await loginAs(admin.id);
    const decided = await adminDecisionRoute(
      req(`/api/admin/ox/opportunities/${draft.id}`, "PATCH", { decision: "APPROVE" }),
      { params: Promise.resolve({ opportunityId: draft.id as string }) }
    );
    expect(decided.status).toBe(200);
    const afterApprove = (await resBody(decided)).opportunity as Record<string, unknown>;
    expect(afterApprove.status).toBe("PUBLISHED");
    expect(afterApprove.publishedAt).not.toBeNull();
    expect(afterApprove.publishedByUserId).toBe(admin.id);
  });

  test("pause → PAUSED; reopen → PUBLISHED (no re-approval needed while content is untouched)", async () => {
    const { admin, owner, orgId } = await seedVerifiedOrg(`Life Org C ${randomUUID().slice(0, 8)}`);
    const draft = await createDraft(orgId);
    await submitOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft.id}/submit`, "POST", {}), oppParams(orgId, draft.id as string));
    await loginAs(admin.id);
    await adminDecisionRoute(req(`/api/admin/ox/opportunities/${draft.id}`, "PATCH", { decision: "APPROVE" }), {
      params: Promise.resolve({ opportunityId: draft.id as string }),
    });
    await loginAs(owner.id);

    const paused = await pauseOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${draft.id}/pause`, "POST", {}),
      oppParams(orgId, draft.id as string)
    );
    expect(paused.status).toBe(200);
    expect(((await resBody(paused)).opportunity as Record<string, unknown>).status).toBe("PAUSED");

    const reopened = await reopenOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${draft.id}/reopen`, "POST", {}),
      oppParams(orgId, draft.id as string)
    );
    expect(reopened.status).toBe(200);
    expect(((await resBody(reopened)).opportunity as Record<string, unknown>).status).toBe("PUBLISHED");
  });

  test("explicit outcome FILLED → terminal (closedAt set); every further transition is 409", async () => {
    const { admin, orgId } = await seedVerifiedOrg(`Life Org D ${randomUUID().slice(0, 8)}`);
    const draft = await createDraft(orgId);
    await submitOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft.id}/submit`, "POST", {}), oppParams(orgId, draft.id as string));
    await loginAs(admin.id);
    await adminDecisionRoute(req(`/api/admin/ox/opportunities/${draft.id}`, "PATCH", { decision: "APPROVE" }), {
      params: Promise.resolve({ opportunityId: draft.id as string }),
    });

    const owner = await db.employerMembership.findFirst({ where: { organizationId: orgId, role: "OWNER" } });
    await loginAs(owner!.userId);
    const filled = await outcomeOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${draft.id}/outcome`, "POST", { outcome: "FILLED" }),
      oppParams(orgId, draft.id as string)
    );
    expect(filled.status).toBe(200);
    const row = (await resBody(filled)).opportunity as Record<string, unknown>;
    expect(row.status).toBe("FILLED");
    expect(row.closedAt).not.toBeNull();

    // Terminal: content edits and further outcomes are refused.
    expect(
      (
        await patchOpportunityRoute(
          req(`/api/employers/${orgId}/opportunities/${draft.id}`, "PATCH", { title: "Should not apply" }),
          oppParams(orgId, draft.id as string)
        )
      ).status
    ).toBe(409);
    expect(
      (
        await outcomeOpportunityRoute(
          req(`/api/employers/${orgId}/opportunities/${draft.id}/outcome`, "POST", { outcome: "CLOSED" }),
          oppParams(orgId, draft.id as string)
        )
      ).status
    ).toBe(409);
    expect(
      (
        await pauseOpportunityRoute(
          req(`/api/employers/${orgId}/opportunities/${draft.id}/pause`, "POST", {}),
          oppParams(orgId, draft.id as string)
        )
      ).status
    ).toBe(409);
    const after = await rowOf(draft.id as string);
    expect(after?.status).toBe("FILLED");
  });
});

// ------------------------------------------------------- published edit path

describe("M-O3 lifecycle — published edit returns atomically to PENDING_REVIEW", () => {
  test("edit while PUBLISHED → PENDING_REVIEW in one step; admin reject → DRAFT with reason; resubmit clears it", async () => {
    const { admin, orgId } = await seedVerifiedOrg(`Life Org E ${randomUUID().slice(0, 8)}`);
    const draft = await createDraft(orgId);
    await submitOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft.id}/submit`, "POST", {}), oppParams(orgId, draft.id as string));
    await loginAs(admin.id);
    await adminDecisionRoute(req(`/api/admin/ox/opportunities/${draft.id}`, "PATCH", { decision: "APPROVE" }), {
      params: Promise.resolve({ opportunityId: draft.id as string }),
    });

    const owner = await db.employerMembership.findFirst({ where: { organizationId: orgId, role: "OWNER" } });
    await loginAs(owner!.userId);
    const edited = await patchOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${draft.id}`, "PATCH", { title: "Senior video editor (night shift)" }),
      oppParams(orgId, draft.id as string)
    );
    expect(edited.status).toBe(200);
    const editedRow = (await resBody(edited)).opportunity as Record<string, unknown>;
    expect(editedRow.status).toBe("PENDING_REVIEW");
    expect(editedRow.title).toBe("Senior video editor (night shift)");
    expect(editedRow.submittedAt).not.toBeNull();

    await loginAs(admin.id);
    const rejected = await adminDecisionRoute(
      req(`/api/admin/ox/opportunities/${draft.id}`, "PATCH", { decision: "REJECT", rejectionReason: "Shift differential must be stated in the body." }),
      { params: Promise.resolve({ opportunityId: draft.id as string }) }
    );
    expect(rejected.status).toBe(200);
    const rejectedRow = (await resBody(rejected)).opportunity as Record<string, unknown>;
    expect(rejectedRow.status).toBe("DRAFT");
    expect(rejectedRow.rejectionReason).toBe("Shift differential must be stated in the body.");

    await loginAs(owner!.userId);
    const resubmitted = await submitOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${draft.id}/submit`, "POST", {}),
      oppParams(orgId, draft.id as string)
    );
    expect(resubmitted.status).toBe(200);
    const resubmittedRow = (await resBody(resubmitted)).opportunity as Record<string, unknown>;
    expect(resubmittedRow.status).toBe("PENDING_REVIEW");
    expect(resubmittedRow.rejectionReason).toBeNull();
  });
});

// ------------------------------------------------------------ deletion rules

describe("M-O3 lifecycle — audited DRAFT-only deletion", () => {
  test("DRAFT deletes; PENDING_REVIEW and PUBLISHED refuse (409); row really gone after delete", async () => {
    const { admin, orgId } = await seedVerifiedOrg(`Life Org F ${randomUUID().slice(0, 8)}`);
    const doomed = await createDraft(orgId, { title: "Disposable draft listing" });

    const deleted = await deleteOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${doomed.id}`, "DELETE"),
      oppParams(orgId, doomed.id as string)
    );
    expect(deleted.status).toBe(200);
    expect((await resBody(deleted)).deleted).toBe(true);
    expect(await rowOf(doomed.id as string)).toBeNull();

    const survivor = await createDraft(orgId);
    await submitOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${survivor.id}/submit`, "POST", {}), oppParams(orgId, survivor.id as string));
    expect(
      (
        await deleteOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${survivor.id}`, "DELETE"), oppParams(orgId, survivor.id as string))
      ).status
    ).toBe(409);
    await loginAs(admin.id);
    await adminDecisionRoute(req(`/api/admin/ox/opportunities/${survivor.id}`, "PATCH", { decision: "APPROVE" }), {
      params: Promise.resolve({ opportunityId: survivor.id as string }),
    });
    const owner = await db.employerMembership.findFirst({ where: { organizationId: orgId, role: "OWNER" } });
    await loginAs(owner!.userId);
    expect(
      (
        await deleteOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${survivor.id}`, "DELETE"), oppParams(orgId, survivor.id as string))
      ).status
    ).toBe(409);
    expect(await rowOf(survivor.id as string)).not.toBeNull();
  });
});

// ------------------------------------------------------- illegal transitions

describe("M-O3 lifecycle — illegal transitions are 409 with ZERO database writes", () => {
  test("refused transitions leave the row byte-identical (status + updatedAt) and create no rows", async () => {
    const { admin, owner, orgId } = await seedVerifiedOrg(`Life Org G ${randomUUID().slice(0, 8)}`);
    const draft = await createDraft(orgId);

    // 1. submit on PENDING_REVIEW → 409, row untouched.
    await submitOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft.id}/submit`, "POST", {}), oppParams(orgId, draft.id as string));
    const pendingRow = await rowOf(draft.id as string);
    expect(
      (
        await submitOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft.id}/submit`, "POST", {}), oppParams(orgId, draft.id as string))
      ).status
    ).toBe(409);
    const afterRefusedSubmit = await rowOf(draft.id as string);
    expect(afterRefusedSubmit!.status).toBe("PENDING_REVIEW");
    expect(afterRefusedSubmit!.updatedAt.getTime()).toBe(pendingRow!.updatedAt.getTime());

    // 2. pause on DRAFT (fresh draft) → 409, row untouched.
    const draft2 = await createDraft(orgId);
    const draft2Row = await rowOf(draft2.id as string);
    expect(
      (
        await pauseOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft2.id}/pause`, "POST", {}), oppParams(orgId, draft2.id as string))
      ).status
    ).toBe(409);
    expect((await rowOf(draft2.id as string))!.status).toBe("DRAFT");
    expect((await rowOf(draft2.id as string))!.updatedAt.getTime()).toBe(draft2Row!.updatedAt.getTime());

    await loginAs(admin.id);
    await adminDecisionRoute(req(`/api/admin/ox/opportunities/${draft.id}`, "PATCH", { decision: "APPROVE" }), {
      params: Promise.resolve({ opportunityId: draft.id as string }),
    });
    await loginAs(owner.id);

    // 3. reopen on PUBLISHED → 409, row untouched.
    const publishedRow = await rowOf(draft.id as string);
    expect(
      (
        await reopenOpportunityRoute(req(`/api/employers/${orgId}/opportunities/${draft.id}/reopen`, "POST", {}), oppParams(orgId, draft.id as string))
      ).status
    ).toBe(409);
    const afterRefusedReopen = await rowOf(draft.id as string);
    expect(afterRefusedReopen!.status).toBe("PUBLISHED");
    expect(afterRefusedReopen!.updatedAt.getTime()).toBe(publishedRow!.updatedAt.getTime());

    // 4. outcome on DRAFT → 409, row untouched.
    expect(
      (
        await outcomeOpportunityRoute(
          req(`/api/employers/${orgId}/opportunities/${draft2.id}/outcome`, "POST", { outcome: "CLOSED" }),
          oppParams(orgId, draft2.id as string)
        )
      ).status
    ).toBe(409);
    expect((await rowOf(draft2.id as string))!.status).toBe("DRAFT");

    // No orphan rows were created by any refused transition.
    const countAfter = await db.opportunity.count({ where: { organizationId: orgId } });
    expect(countAfter).toBe(2);
  });
});
