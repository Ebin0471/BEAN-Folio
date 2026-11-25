/// <reference types="bun-types" />
/**
 * M33.5-D — cover letter ROUTE contracts (isolated QA DB, deterministic AI).
 *
 * IMPORTANT: module-mocks @/lib/ai — run per-file (official runner does).
 *
 * Pins spec §11.4:
 *  - anonymous → 401; foreign letter / foreign source resume → 404;
 *  - generate without a JD → 400; the guard rejects invented content with
 *    NOTHING saved (row count unchanged);
 *  - a clean draft persists with provenance (aiTouched) and the JD hash;
 *  - rephrase touches exactly one paragraph (others byte-identical);
 *  - user save removes the AI badge from edited paragraphs (user edits win);
 *  - duplicate creates an independent copy;
 *  - export streams no-store bytes with an honest verification header.
 *
 * Run: bun test tests/cover-letter-route.test.ts
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest } from "next/server";

const CLEAN_DRAFT = {
  opening: "I am writing to apply for the Senior Frontend Engineer role at Meridian Labs.",
  bodyParagraphs: [
    "At Zeta Systems I built design-system components used across product teams.",
    "I work with React and TypeScript every day.",
  ],
  closing: "Thank you for your consideration.",
};
const INVENTED_DRAFT = {
  opening: "I am dying to join Photon Dynamics, the industry's leading innovator.",
  bodyParagraphs: ["Everyone says my 300% improvements are legendary."],
  closing: "Thank you.",
};

let aiCallCount = 0;
let draftToReturn: () => unknown = () => ({ ...CLEAN_DRAFT, paragraph: "I work with React and TypeScript every single day." });

mock.module("@/lib/ai", () => ({
  AiProviderError: class AiProviderError extends Error {},
  aiComplete: async () => {
    aiCallCount += 1;
    return { text: JSON.stringify(draftToReturn()), model: "mock", provider: "mock", usage: {} };
  },
  parseJsonFromText: <T,>(text: string): T | null => (JSON.parse(text) as T) ?? null,
  aiGate: async () => null,
}));

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
import { GET as clGet, POST as clPost, PATCH as clPatch } from "@/app/api/laxii/cover-letter/route";
import { POST as clExport } from "@/app/api/laxii/cover-letter/export/route";
import type { CoverLetterData } from "@/lib/laxii/cover-letter-schema";

const STAMP = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const EMAIL_A = `laxii-cl-a-${STAMP}@test.beanfolio.local`;
const EMAIL_B = `laxii-cl-b-${STAMP}@test.beanfolio.local`;
const JD = "Job Title: Senior Frontend Engineer\nCompany: Meridian Labs\n- Expert React and TypeScript";

const RESUME_DOC = {
  schemaVersion: 1,
  basics: { name: "Asha Verma", label: "Frontend Engineer", email: "asha.verma@example.com", phone: "+91 90000 00000", website: "", location: "Bengaluru", summary: "Frontend engineer." },
  work: [{ company: "Zeta Systems", position: "Software Engineer", startDate: "2021-03", endDate: "", current: true, summary: "Built components.", highlights: [] }],
  education: [],
  skills: [{ name: "React", level: "" }, { name: "TypeScript", level: "" }],
  projects: [],
  certificates: [],
  awards: [],
  custom: [],
  order: [],
  titles: {},
};
const FACTS = {
  basics: { name: "Asha Verma", label: "", email: "asha.verma@example.com", phone: "+91 90000 00000", website: "", location: "Bengaluru", summary: "" },
  work: RESUME_DOC.work,
  education: [],
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
  const req = new NextRequest("http://localhost/api/laxii/cover-letter", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return route(req) as unknown as Promise<Response>;
}
function get(route: (req: NextRequest) => Promise<Response>, query: string): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/laxii/cover-letter${query}`);
  return route(req) as unknown as Promise<Response>;
}

beforeAll(async () => {
  const userA = await db.user.create({ data: { email: EMAIL_A, passwordHash: await hashPassword("cl-pass"), name: "CL A" } });
  userAId = userA.id;
  const userB = await db.user.create({ data: { email: EMAIL_B, passwordHash: await hashPassword("cl-pass"), name: "CL B" } });
  userBId = userB.id;
  const conv = await db.laxiiConversation.create({
    data: { userId: userAId, title: "Asha — Resume", kind: "RESUME", resume: { create: { userId: userAId, resumeType: "ats", template: "classic", dataJson: JSON.stringify(RESUME_DOC), factsJson: JSON.stringify(FACTS) } } },
  });
  convId = conv.id;
});

afterAll(async () => {
  await db.laxiiConversation.delete({ where: { id: convId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userAId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userBId } }).catch(() => undefined);
});

async function letterCount(userId: string): Promise<number> {
  return db.laxiiCoverLetter.count({ where: { userId } });
}

describe("POST /api/laxii/cover-letter — generate", () => {
  test("anonymous → 401; foreign source resume → 404", async () => {
    cookieToken = undefined;
    expect((await post(clPost, { action: "generate", sourceResumeConversationId: convId, jobDescription: JD })).status).toBe(401);
    cookieToken = await createSession(userBId);
    expect((await post(clPost, { action: "generate", sourceResumeConversationId: convId, jobDescription: JD })).status).toBe(404);
    cookieToken = await createSession(userAId);
  });

  test("missing JD → 400", async () => {
    cookieToken = await createSession(userAId);
    const res = await post(clPost, { action: "generate", sourceResumeConversationId: convId, jobDescription: "  " });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("job description");
  });

  test("a clean draft persists with provenance + JD hash", async () => {
    cookieToken = await createSession(userAId);
    const before = await letterCount(userAId);
    const res = await post(clPost, { action: "generate", sourceResumeConversationId: convId, jobDescription: JD, targetRole: "Senior Frontend Engineer", companyName: "Meridian Labs", tone: "formal", length: "standard" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { letterId: string; letter: CoverLetterData; notes: string[] };
    expect(body.letter.opening).toContain("Meridian Labs");
    expect(body.letter.basics.name).toBe("Asha Verma");
    expect(body.letter.aiTouched.length).toBeGreaterThan(0);
    expect(body.letter.jobDescriptionHash).toHaveLength(64);
    expect(body.letter.wordCount).toBeGreaterThan(10);
    expect(await letterCount(userAId)).toBe(before + 1);
  });

  test("the guard rejects invented content — NOTHING is saved, honest 502", async () => {
    cookieToken = await createSession(userAId);
    draftToReturn = () => INVENTED_DRAFT;
    const before = await letterCount(userAId);
    const res = await post(clPost, { action: "generate", sourceResumeConversationId: convId, jobDescription: JD });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("details your facts don't support");
    expect(await letterCount(userAId)).toBe(before);
    draftToReturn = () => ({ ...CLEAN_DRAFT, paragraph: "I work with React and TypeScript every single day." });
  });
});

describe("rephrase / save / duplicate — letter lifecycle", () => {
  let letterId: string;

  beforeAll(async () => {
    cookieToken = await createSession(userAId);
    const res = await post(clPost, { action: "generate", sourceResumeConversationId: convId, jobDescription: JD, targetRole: "Senior Frontend Engineer", companyName: "Meridian Labs" });
    letterId = ((await res.json()) as { letterId: string }).letterId;
  });

  test("rephrase touches EXACTLY one paragraph", async () => {
    cookieToken = await createSession(userAId);
    const detail = (await (await get(clGet, `?letterId=${letterId}`)).json()) as { letter: CoverLetterData };
    const originalBody = detail.letter.bodyParagraphs;
    aiCallCount = 0;
    const res = await post(clPost, { action: "rephrase", letterId, target: "body:1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { letter: CoverLetterData };
    expect(aiCallCount).toBe(1);
    expect(body.letter.bodyParagraphs[0]).toBe(originalBody[0]); // byte-identical
    expect(body.letter.bodyParagraphs[1]).not.toBe(originalBody[1]); // reworded
    expect(body.letter.opening).toBe(detail.letter.opening);
    expect(body.letter.closing).toBe(detail.letter.closing);
    expect(body.letter.aiTouched).toContain("body:1");
  });

  test("user save removes the AI badge from edited paragraphs (user edits win)", async () => {
    cookieToken = await createSession(userAId);
    const detail = (await (await get(clGet, `?letterId=${letterId}`)).json()) as { letter: CoverLetterData };
    const edited: CoverLetterData = {
      ...detail.letter,
      opening: "My own hand-written opening — no AI involved.",
    };
    const res = await clPatch(
      new NextRequest("http://localhost/api/laxii/cover-letter", {
        method: "PATCH",
        body: JSON.stringify({ letterId, data: edited }),
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(res.status).toBe(200);
    const after = (await (await get(clGet, `?letterId=${letterId}`)).json()) as { letter: CoverLetterData };
    expect(after.letter.opening).toBe("My own hand-written opening — no AI involved.");
    expect(after.letter.aiTouched).not.toContain("opening");
    expect(after.letter.aiTouched).toContain("body:0"); // untouched → badge kept
  });

  test("duplicate creates an independent copy", async () => {
    cookieToken = await createSession(userAId);
    const before = await letterCount(userAId);
    const res = await post(clPost, { action: "duplicate", letterId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { letterId: string };
    expect(body.letterId).not.toBe(letterId);
    expect(await letterCount(userAId)).toBe(before + 1);
    const copy = (await (await get(clGet, `?letterId=${body.letterId}`)).json()) as { letter: CoverLetterData };
    const original = (await (await get(clGet, `?letterId=${letterId}`)).json()) as { letter: CoverLetterData };
    expect(copy.letter.label.endsWith("(copy)")).toBe(true);
    expect(copy.letter.opening).toBe(original.letter.opening);
    expect(copy.letter.bodyParagraphs).toEqual(original.letter.bodyParagraphs);
  });

  test("foreign letter is indistinguishable from nonexistent (404) on every branch", async () => {
    cookieToken = await createSession(userBId);
    expect((await get(clGet, `?letterId=${letterId}`)).status).toBe(404);
    expect((await post(clPost, { action: "duplicate", letterId })).status).toBe(404);
    expect((await post(clPost, { action: "rephrase", letterId, target: "opening" })).status).toBe(404);
    cookieToken = await createSession(userAId);
  });
});

describe("POST /api/laxii/cover-letter/export", () => {
  test("streams no-store bytes with an honest verification header", async () => {
    cookieToken = await createSession(userAId);
    const list = (await (await get(clGet, "")).json()) as { letters: { letterId: string }[] };
    const letterId = list.letters[0].letterId;
    const res = await clExport(
      new NextRequest("http://localhost/api/laxii/cover-letter/export", {
        method: "POST",
        body: JSON.stringify({ letterId, format: "pdf" }),
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("X-Bean-Export-Verification")).toBe("passed");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1000);
    // Foreign user cannot export another user's letter.
    cookieToken = await createSession(userBId);
    expect((await clExport(
      new NextRequest("http://localhost/api/laxii/cover-letter/export", {
        method: "POST",
        body: JSON.stringify({ letterId, format: "pdf" }),
        headers: { "Content-Type": "application/json" },
      })
    )).status).toBe(404);
    cookieToken = await createSession(userAId);
  }, 30000);
});
