/// <reference types="bun-types" />
/**
 * M33.5-B — analyze + export-verify ROUTE contracts (isolated QA DB).
 *
 * Pins: anonymous → 401; another user's conversation → 404 (owner scoping);
 * analyze is deterministic (two identical calls → identical reports modulo
 * evaluatedAt); evidence map only appears when a JD is supplied; export
 * verify returns honest decode results for the saved document.
 *
 * Run: bun test tests/resume-analysis-route.test.ts
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest } from "next/server";

let cookieToken: string | undefined;
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieToken && name === "bean_session" ? { name, value: cookieToken } : undefined,
    set: () => undefined,
  }),
}));

import { db } from "@/lib/db";
import { createSession, hashPassword } from "@/lib/auth";
import { POST as analyzeRoute } from "@/app/api/laxii/resume/analyze/route";
import { POST as exportVerifyRoute } from "@/app/api/laxii/resume/export/verify/route";
import { resumeDataSchema } from "@/lib/laxii/resume-schema";

const STAMP = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const EMAIL_A = `laxii-analyze-a-${STAMP}@test.beanfolio.local`;
const EMAIL_B = `laxii-analyze-b-${STAMP}@test.beanfolio.local`;

const DOC = resumeDataSchema.parse({
  basics: { name: "Asha Verma", email: "asha.verma@example.com", label: "Frontend Engineer", summary: "Frontend engineer." },
  work: [{ company: "Zeta Systems", position: "Software Engineer", startDate: "2021-03", endDate: "", current: true, summary: "Built components.", highlights: [] }],
  education: [{ institution: "VNIT Nagpur", area: "Computer Science", studyType: "B.Tech", startDate: "2015", endDate: "2019", score: "" }],
  skills: [{ name: "React", level: "" }, { name: "TypeScript", level: "" }],
  custom: [],
  order: [],
  titles: {},
});

const FACTS = {
  basics: { name: "Asha Verma", label: "Frontend Engineer", email: "asha.verma@example.com", phone: "", website: "", location: "", summary: "Frontend engineer." },
  work: DOC.work,
  education: DOC.education,
  skills: ["React", "TypeScript"],
  projects: [],
  certificates: [],
  awards: [],
  custom: [],
};

let userAId: string;
let userBId: string;
let convId: string;

function post(route: (req: NextRequest) => Promise<Response>, body: unknown): Promise<Response> {
  const req = new NextRequest("http://localhost/api/laxii/resume/analyze", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return route(req) as unknown as Promise<Response>;
}

beforeAll(async () => {
  const userA = await db.user.create({ data: { email: EMAIL_A, passwordHash: await hashPassword("analyze-pass"), name: "Analyze A" } });
  userAId = userA.id;
  const userB = await db.user.create({ data: { email: EMAIL_B, passwordHash: await hashPassword("analyze-pass"), name: "Analyze B" } });
  userBId = userB.id;
  const conv = await db.laxiiConversation.create({
    data: { userId: userAId, title: "Asha Verma — Resume", kind: "RESUME", resume: { create: { userId: userAId, resumeType: "ats", template: "classic", dataJson: JSON.stringify(DOC), factsJson: JSON.stringify(FACTS) } } },
  });
  convId = conv.id;
});

afterAll(async () => {
  await db.laxiiConversation.delete({ where: { id: convId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userAId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userBId } }).catch(() => undefined);
});

describe("POST /api/laxii/resume/analyze — route contract", () => {
  test("anonymous requests are 401", async () => {
    cookieToken = undefined;
    const res = await post(analyzeRoute, { conversationId: convId });
    expect(res.status).toBe(401);
  });

  test("another user's conversation is indistinguishable from nonexistent (404)", async () => {
    cookieToken = await createSession(userBId);
    const res = await post(analyzeRoute, { conversationId: convId });
    expect(res.status).toBe(404);
  });

  test("owner gets a versioned readability report without JD", async () => {
    cookieToken = await createSession(userAId);
    const res = await post(analyzeRoute, { conversationId: convId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { readability: { reportVersion: number; status: string; checks: { id: string }[]; untested: string[] }; evidenceMap?: unknown };
    expect(body.readability.reportVersion).toBe(1);
    expect(body.readability.checks.length).toBeGreaterThan(5);
    expect(body.readability.untested.length).toBeGreaterThan(2);
    expect(body.evidenceMap).toBeUndefined();
  });

  test("the evidence map appears only with a JD and is deterministic across calls", async () => {
    cookieToken = await createSession(userAId);
    const jd = "Requirements:\n- Expert React and TypeScript\n- 5 years of experience\n- Expert Kubernetes";
    const res1 = await post(analyzeRoute, { conversationId: convId, jobDescription: jd });
    const res2 = await post(analyzeRoute, { conversationId: convId, jobDescription: jd });
    expect(res1.status).toBe(200);
    const b1 = (await res1.json()) as { evidenceMap: { evidence: { requirement: { text: string }; verdict: string }[]; weightedCoverage: { value: number } } };
    const b2 = (await res2.json()) as typeof b1;
    expect(b1.evidenceMap.evidence.length).toBe(b2.evidenceMap.evidence.length);
    expect(b1.evidenceMap.weightedCoverage.value).toBe(b2.evidenceMap.weightedCoverage.value);
    const react = b1.evidenceMap.evidence.find((e) => e.requirement.text.toLowerCase().includes("react"));
    expect(react?.verdict).toBe("supported");
    const k8s = b1.evidenceMap.evidence.find((e) => e.requirement.text.toLowerCase().includes("kubernetes"));
    expect(k8s?.verdict).toBe("missing");
  });
});

describe("POST /api/laxii/resume/export/verify — route contract", () => {
  test("anonymous → 401, foreign conversation → 404", async () => {
    cookieToken = undefined;
    expect((await post(exportVerifyRoute, { conversationId: convId, format: "pdf" })).status).toBe(401);
    cookieToken = await createSession(userBId);
    expect((await post(exportVerifyRoute, { conversationId: convId, format: "pdf" })).status).toBe(404);
  });

  test("owner gets an honest decode verification of the produced bytes", async () => {
    cookieToken = await createSession(userAId);
    const res = await post(exportVerifyRoute, { conversationId: convId, format: "pdf" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verification: { format: string; decodeOk: boolean; missingFacts: string[]; checkedFacts: number; byteLength: number } };
    expect(body.verification.format).toBe("pdf");
    expect(body.verification.decodeOk).toBe(true);
    expect(body.verification.byteLength).toBeGreaterThan(500);
    expect(body.verification.checkedFacts).toBeGreaterThan(4);
    expect(body.verification.missingFacts).toEqual([]);
  }, 30000);
});
