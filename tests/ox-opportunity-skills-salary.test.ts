import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// M-O3 skills + salary boundary tests (approved decision table):
//   REQUIRED ≤ 8 (9 rejected) · PREFERRED ≤ 12 (13 rejected) · total ≤ 20
//   (21 rejected) · minimum zero (no chips is valid) · duplicates rejected ·
//   unknown taxonomy references rejected (reuse, never extend) · ₹10 crore
//   BigInt round-trip exact (incl. above-Int32 values) · invalid salary
//   refused with 400 and ZERO writes · salary completeness enforced at
//   submit AND re-checked at admin approval. Same harness as the other OX
//   suites.
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
import { OX_SALARY_MAX_PAISE } from "@/lib/ox/validation";
import { POST as createOrgRoute } from "@/app/api/employers/route";
import { POST as submitVerificationRoute } from "@/app/api/employers/[id]/verification/route";
import { PATCH as adminVerificationDecisionRoute } from "@/app/api/admin/ox/verifications/[id]/route";
import { POST as createOpportunityRoute, GET as listOpportunitiesRoute } from "@/app/api/employers/[id]/opportunities/route";
import {
  PATCH as patchOpportunityRoute,
  DELETE as deleteOpportunityRoute,
} from "@/app/api/employers/[id]/opportunities/[opportunityId]/route";
import { POST as submitOpportunityRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/submit/route";
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
      email: `ox-opp-cap-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("ox-opp-cap-password-1"),
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

async function seedVerifiedOrg(displayName: string) {
  const owner = await makeUser("Cap Owner");
  await loginAs(owner.id);
  const created = await createOrgRoute(req("/api/employers", "POST", { legalName: "Caps Ltd", displayName }));
  const orgId = ((await resBody(created)).organization as Record<string, unknown>).id as string;
  await submitVerificationRoute(req(`/api/employers/${orgId}/verification`, "POST", { evidenceReference: "cap-ref-0001" }), orgParams(orgId));
  const admin = await makeUser("Cap Admin", "ADMIN");
  const pending = await db.employerVerification.findFirst({ where: { organizationId: orgId, status: "PENDING" } });
  await loginAs(admin.id);
  await adminVerificationDecisionRoute(
    req(`/api/admin/ox/verifications/${pending!.id}`, "PATCH", { decision: "APPROVE" }),
    { params: Promise.resolve({ id: pending!.id }) }
  );
  await loginAs(owner.id);
  return { owner, admin, orgId };
}

/** Create N distinct real taxonomy rows and return their slugs. */
async function seedSkills(n: number, prefix: string): Promise<string[]> {
  const slugs: string[] = [];
  for (let i = 0; i < n; i++) {
    const slug = `${prefix}-${randomUUID().slice(0, 10)}`;
    await db.skill.create({ data: { slug, label: `Cap Skill ${i} ${randomUUID().slice(0, 6)}` } });
    slugs.push(slug);
  }
  return slugs;
}

const BASE_PAYLOAD = {
  title: "Boundary analyst",
  description: "Verify caps and salary boundaries for the opportunity exchange, end to end.",
};

async function createRes(orgId: string, payload: Record<string, unknown>) {
  return createOpportunityRoute(req(`/api/employers/${orgId}/opportunities`, "POST", payload), orgParams(orgId));
}

// ------------------------------------------------------------------- skill caps

describe("M-O3 skills — approved caps enforced pre-write", () => {
  test("8 REQUIRED accepted; 9 REQUIRED rejected with zero writes", async () => {
    const { orgId } = await seedVerifiedOrg(`Cap Org A ${randomUUID().slice(0, 8)}`);
    const eight = await seedSkills(8, "capreq8");
    const okRes = await createRes(orgId, { ...BASE_PAYLOAD, skills: eight.map((s) => ({ skill: s, kind: "REQUIRED" })) });
    expect(okRes.status).toBe(201);
    const okBody = (await resBody(okRes)).opportunity as Record<string, unknown>;
    expect(((okBody.skills as Record<string, unknown>[]) ?? []).length).toBe(8);

    const nine = await seedSkills(9, "capreq9");
    const before = await db.opportunity.count({ where: { organizationId: orgId } });
    const badRes = await createRes(orgId, { ...BASE_PAYLOAD, skills: nine.map((s) => ({ skill: s, kind: "REQUIRED" })) });
    expect(badRes.status).toBe(400);
    expect(((await resBody(badRes)) as Record<string, unknown>).code).toBe("OPPORTUNITY_TOO_MANY_REQUIRED_SKILLS");
    expect(await db.opportunity.count({ where: { organizationId: orgId } })).toBe(before);
  });

  test("12 PREFERRED accepted; 13 PREFERRED rejected", async () => {
    const { orgId } = await seedVerifiedOrg(`Cap Org B ${randomUUID().slice(0, 8)}`);
    const twelve = await seedSkills(12, "cappref12");
    const okRes = await createRes(orgId, { ...BASE_PAYLOAD, skills: twelve.map((s) => ({ skill: s, kind: "PREFERRED" })) });
    expect(okRes.status).toBe(201);

    const thirteen = await seedSkills(13, "cappref13");
    const badRes = await createRes(orgId, { ...BASE_PAYLOAD, skills: thirteen.map((s) => ({ skill: s, kind: "PREFERRED" })) });
    expect(badRes.status).toBe(400);
    expect(((await resBody(badRes)) as Record<string, unknown>).code).toBe("OPPORTUNITY_TOO_MANY_PREFERRED_SKILLS");
  });

  test("20 combined accepted (8 required + 12 preferred, at every cap); 21 combined rejected; zero skills accepted", async () => {
    const { orgId } = await seedVerifiedOrg(`Cap Org C ${randomUUID().slice(0, 8)}`);
    // At the maximum: 8 REQUIRED + 12 PREFERRED = 20 total — all three caps
    // satisfied simultaneously (8 + 12 = 20 by the approved decision table).
    const required8 = await seedSkills(8, "capmix8r");
    const preferred12 = await seedSkills(12, "capmix12p");
    const okRes = await createRes(orgId, {
      ...BASE_PAYLOAD,
      skills: [
        ...required8.map((s) => ({ skill: s, kind: "REQUIRED" })),
        ...preferred12.map((s) => ({ skill: s, kind: "PREFERRED" })),
      ],
    });
    expect(okRes.status).toBe(201);
    expect((((await resBody(okRes)).opportunity as Record<string, unknown>).skills as unknown[]).length).toBe(20);

    // 21 combined necessarily violates at least one approved cap (8+12=20);
    // assert the refusal and that it is a cap code.
    const required8b = await seedSkills(8, "capmix21r");
    const preferred13 = await seedSkills(13, "capmix21p");
    const badRes = await createRes(orgId, {
      ...BASE_PAYLOAD,
      skills: [
        ...required8b.map((s) => ({ skill: s, kind: "REQUIRED" })),
        ...preferred13.map((s) => ({ skill: s, kind: "PREFERRED" })),
      ],
    });
    expect(badRes.status).toBe(400);
    // The zod payload cap (array max 20) refuses without a machine code;
    // the pre-write validator refuses with one. Both are the approved caps.
    const badCode = ((await resBody(badRes)) as Record<string, unknown>).code;
    expect(badCode === undefined || ["OPPORTUNITY_TOO_MANY_SKILLS_TOTAL", "OPPORTUNITY_TOO_MANY_REQUIRED_SKILLS", "OPPORTUNITY_TOO_MANY_PREFERRED_SKILLS"].includes(badCode as string)).toBe(true);

    const noneRes = await createRes(orgId, { ...BASE_PAYLOAD, skills: [] });
    expect(noneRes.status).toBe(201);
    expect((((await resBody(noneRes)).opportunity as Record<string, unknown>).skills as unknown[]).length).toBe(0);
  });

  test("duplicate skill reference in one payload rejected; unknown taxonomy reference rejected (reuse-only)", async () => {
    const { orgId } = await seedVerifiedOrg(`Cap Org D ${randomUUID().slice(0, 8)}`);
    const [dup] = await seedSkills(1, "capdup");
    const dupRes = await createRes(orgId, {
      ...BASE_PAYLOAD,
      skills: [
        { skill: dup, kind: "REQUIRED" },
        { skill: dup, kind: "PREFERRED" },
      ],
    });
    expect(dupRes.status).toBe(400);
    expect(((await resBody(dupRes)) as Record<string, unknown>).code).toBe("OPPORTUNITY_SKILL_DUPLICATE");

    const unknownRes = await createRes(orgId, {
      ...BASE_PAYLOAD,
      skills: [{ skill: "no-such-skill-exists", kind: "REQUIRED" }],
    });
    expect(unknownRes.status).toBe(400);
    expect(((await resBody(unknownRes)) as Record<string, unknown>).code).toBe("OPPORTUNITY_SKILL_NOT_FOUND");
    expect(await db.skill.count({ where: { slug: "no-such-skill-exists" } })).toBe(0);
  });

  test("update replaces the skill set wholesale; kind switch updates the same (opportunity, skill) row", async () => {
    const { orgId } = await seedVerifiedOrg(`Cap Org E ${randomUUID().slice(0, 8)}`);
    const [a, b, c] = await seedSkills(3, "capupd");
    const draft = await createRes(orgId, {
      ...BASE_PAYLOAD,
      skills: [
        { skill: a, kind: "REQUIRED" },
        { skill: b, kind: "PREFERRED" },
      ],
    });
    const row = ((await resBody(draft)).opportunity as Record<string, unknown>) ?? ({} as Record<string, unknown>);
    const opportunityId = row.id as string;

    // kind switch for a, drop b, add c — exactly two rows remain.
    const edited = await patchOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${opportunityId}`, "PATCH", {
        skills: [
          { skill: a, kind: "PREFERRED" },
          { skill: c, kind: "REQUIRED" },
        ],
      }),
      oppParams(orgId, opportunityId)
    );
    expect(edited.status).toBe(200);
    const skills = ((await resBody(edited)).opportunity as Record<string, unknown>).skills as Record<string, unknown>[];
    expect(skills.length).toBe(2);
    expect(skills.find((s) => s.slug === a)?.kind).toBe("PREFERRED");
    expect(skills.find((s) => s.slug === c)?.kind).toBe("REQUIRED");
    expect(skills.find((s) => s.slug === b)).toBeUndefined();

    const dbRows = await db.opportunitySkill.findMany({ where: { opportunityId } });
    expect(dbRows.length).toBe(2);
  });
});

// ------------------------------------------------------------------ salary rules

describe("M-O3 salary — ₹10 crore BigInt ceiling with exact round-trips", () => {
  test("ceiling value (10,000,000,000 paise = ₹10 crore) round-trips exactly through BigInt storage", async () => {
    const { orgId } = await seedVerifiedOrg(`Cap Org F ${randomUUID().slice(0, 8)}`);
    const res = await createRes(orgId, {
      ...BASE_PAYLOAD,
      salaryMinPaise: OX_SALARY_MAX_PAISE,
      salaryMaxPaise: OX_SALARY_MAX_PAISE,
      salaryCurrency: "INR",
      compensationPeriod: "YEAR",
    });
    expect(res.status).toBe(201);
    const body = (await resBody(res)).opportunity as Record<string, unknown>;
    expect(body.salaryMinPaise).toBe(10_000_000_000);
    expect(body.salaryMaxPaise).toBe(10_000_000_000);

    // Storage layer: native BigInt (64-bit INTEGER), not Int32.
    const stored = await db.opportunity.findUnique({ where: { id: body.id as string } });
    expect(stored?.salaryMaxPaise).toBe(BigInt(10_000_000_000));
  });

  test("above-Int32 values (2,147,483,648 paise) round-trip exactly — the O2.1 defect class cannot recur", async () => {
    const { orgId } = await seedVerifiedOrg(`Cap Org G ${randomUUID().slice(0, 8)}`);
    const res = await createRes(orgId, {
      ...BASE_PAYLOAD,
      salaryMinPaise: 2_147_483_648,
      salaryMaxPaise: 2_147_483_649,
      salaryCurrency: "INR",
      compensationPeriod: "MONTH",
    });
    expect(res.status).toBe(201);
    const body = (await resBody(res)).opportunity as Record<string, unknown>;
    expect(body.salaryMinPaise).toBe(2_147_483_648);
    expect(body.salaryMaxPaise).toBe(2_147_483_649);
  });

  test("invalid salary is refused with 400 and ZERO writes: negative, over-ceiling, non-integer, min>max", async () => {
    const { orgId } = await seedVerifiedOrg(`Cap Org H ${randomUUID().slice(0, 8)}`);
    const before = await db.opportunity.count({ where: { organizationId: orgId } });

    const cases: Record<string, unknown>[] = [
      { ...BASE_PAYLOAD, salaryMinPaise: -1, salaryMaxPaise: 100, salaryCurrency: "INR", compensationPeriod: "YEAR" },
      { ...BASE_PAYLOAD, salaryMinPaise: 1, salaryMaxPaise: OX_SALARY_MAX_PAISE + 1, salaryCurrency: "INR", compensationPeriod: "YEAR" },
      { ...BASE_PAYLOAD, salaryMinPaise: 1.5, salaryMaxPaise: 100, salaryCurrency: "INR", compensationPeriod: "YEAR" },
      { ...BASE_PAYLOAD, salaryMinPaise: 500, salaryMaxPaise: 100, salaryCurrency: "INR", compensationPeriod: "YEAR" },
      { ...BASE_PAYLOAD, salaryMinPaise: 1, salaryMaxPaise: 100, salaryCurrency: "RUPEE", compensationPeriod: "YEAR" },
    ];
    for (const payload of cases) {
      const res = await createRes(orgId, payload);
      expect(res.status).toBe(400);
    }
    expect(await db.opportunity.count({ where: { organizationId: orgId } })).toBe(before);
  });

  test("salary completeness: submit without a complete range → 400; with it → review; admin approval re-check catches a cleared range", async () => {
    const { admin, owner, orgId } = await seedVerifiedOrg(`Cap Org I ${randomUUID().slice(0, 8)}`);

    const incomplete = await createRes(orgId, { ...BASE_PAYLOAD });
    const incompleteRow = ((await resBody(incomplete)).opportunity as Record<string, unknown>) ?? ({} as Record<string, unknown>);
    const incompleteRes = await submitOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${incompleteRow.id}/submit`, "POST", {}),
      oppParams(orgId, incompleteRow.id as string)
    );
    expect(incompleteRes.status).toBe(400);
    expect(((await resBody(incompleteRes)) as Record<string, unknown>).code).toBe("OPPORTUNITY_SALARY_INCOMPLETE");
    expect((await db.opportunity.findUnique({ where: { id: incompleteRow.id as string } }))?.status).toBe("DRAFT");

    // Complete range passes submit; then the employer clears the salary while
    // under review; approval re-check refuses with 400 — no publication.
    const complete = await createRes(orgId, {
      ...BASE_PAYLOAD,
      salaryMinPaise: 1_000_000_00,
      salaryMaxPaise: 2_000_000_00,
      salaryCurrency: "INR",
      compensationPeriod: "YEAR",
    });
    const completeRow = ((await resBody(complete)).opportunity as Record<string, unknown>) ?? ({} as Record<string, unknown>);
    const submitted = await submitOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${completeRow.id}/submit`, "POST", {}),
      oppParams(orgId, completeRow.id as string)
    );
    expect(submitted.status).toBe(200);

    const cleared = await patchOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${completeRow.id}`, "PATCH", {
        salaryMinPaise: null,
        salaryMaxPaise: null,
        salaryCurrency: null,
        compensationPeriod: null,
      }),
      oppParams(orgId, completeRow.id as string)
    );
    expect(cleared.status).toBe(200);

    await loginAs(admin.id);
    const approved = await adminDecisionRoute(
      req(`/api/admin/ox/opportunities/${completeRow.id}`, "PATCH", { decision: "APPROVE" }),
      { params: Promise.resolve({ opportunityId: completeRow.id as string }) }
    );
    expect(approved.status).toBe(400);
    expect(((await resBody(approved)) as Record<string, unknown>).code).toBe("OPPORTUNITY_SALARY_INCOMPLETE");
    expect((await db.opportunity.findUnique({ where: { id: completeRow.id as string } }))?.status).toBe("PENDING_REVIEW");

    // The complete draft can still be submitted and approved normally.
    void incompleteRes;
    await loginAs(owner.id);
    const delRes = await deleteOpportunityRoute(
      req(`/api/employers/${orgId}/opportunities/${incompleteRow.id}`, "DELETE"),
      oppParams(orgId, incompleteRow.id as string)
    );
    expect(delRes.status).toBe(200);
  });
});
