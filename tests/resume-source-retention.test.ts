/// <reference types="bun-types" />
/**
 * M33.5-A — source-text retention contract (spec §4.2.5).
 *
 * Extracted upload text is UNTRUSTED SOURCE CONTENT: it is used for the
 * requested generation and then discarded, UNLESS the user explicitly opts
 * in to keeping it in the private facts snapshot. Pinned here against the
 * real service + isolated QA database (AI gateway mocked deterministically):
 *
 *  - retain=false (default)  → sourceText is NEVER persisted;
 *  - retain=true             → sourceText is stored in factsJson;
 *  - a later transient upload REPLACES (discards) retained text;
 *  - a regeneration WITHOUT an upload preserves the earlier retention choice.
 *
 * Run: bun test tests/resume-source-retention.test.ts   (isolated QA DB)
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";

// Deterministic AI gateway: draft strictly derived from the facts below
// (no invented entities — the guard would reject).
const MOCK_DRAFT = {
  basics: {
    name: "Asha Verma",
    label: "Senior Frontend Engineer",
    email: "asha.verma@example.com",
    phone: "+91 90000 00000",
    website: "",
    location: "Bengaluru",
    summary: "Frontend engineer focused on accessible interfaces for product teams.",
  },
  work: [
    {
      company: "Zeta Systems",
      position: "Software Engineer",
      startDate: "2021-03",
      endDate: "",
      current: true,
      summary: "Built design-system components used across product teams.",
      highlights: ["Led the TypeScript migration"],
    },
  ],
  education: [],
  skills: [{ name: "TypeScript", level: "" }, { name: "React", level: "" }],
  projects: [],
  certificates: [],
  awards: [],
};

mock.module("@/lib/ai", () => ({
  AiProviderError: class AiProviderError extends Error {},
  aiComplete: async () => ({ text: JSON.stringify(MOCK_DRAFT), model: "mock", provider: "mock", usage: {} }),
  parseJsonFromText: <T,>(text: string): T | null => (JSON.parse(text) as T) ?? null,
  aiGate: async () => null,
}));

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { generateResume } from "@/lib/laxii/resume-service";

const STAMP = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const EMAIL = `laxii-retain-${STAMP}@test.beanfolio.local`;

const FACTS = {
  basics: { name: "Asha Verma", label: "", email: "asha.verma@example.com", phone: "+91 90000 00000", website: "", location: "Bengaluru", summary: "" },
  work: [{ company: "Zeta Systems", position: "Software Engineer", startDate: "2021-03", endDate: "", current: true, summary: "Built design-system components.", highlights: ["Led the TypeScript migration"] }],
  education: [],
  skills: ["TypeScript", "React"],
  projects: [],
  certificates: [],
  awards: [],
  custom: [],
};

const SOURCE_TEXT = "Asha Verma\nSenior Frontend Engineer\nZeta Systems, 2021-present\nTypeScript, React";

let userId: string;
let conversationId: string | undefined;

async function retainedSourceText(convId: string): Promise<string | null> {
  const row = await db.laxiiResume.findUniqueOrThrow({ where: { conversationId: convId } });
  const raw: unknown = JSON.parse(row.factsJson || "{}");
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).sourceText === "string") {
    return (raw as Record<string, unknown>).sourceText as string;
  }
  return null;
}

beforeAll(async () => {
  const user = await db.user.create({ data: { email: EMAIL, passwordHash: await hashPassword("retain-pass"), name: "Retention" } });
  userId = user.id;
});

afterAll(async () => {
  if (conversationId) await db.laxiiConversation.delete({ where: { id: conversationId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
});

describe("M33.5-A source-text retention (spec §4.2.5)", () => {
  test("default is transient: an upload without opt-in leaves NO sourceText behind", async () => {
    const res = await generateResume({ userId, facts: FACTS, resumeType: "ats", targetTitle: "", jobDescription: "", sourceText: SOURCE_TEXT, retainSourceText: false });
    conversationId = res.conversationId;
    expect(await retainedSourceText(res.conversationId)).toBeNull();
  });

  test("explicit opt-in stores the source text in the private facts snapshot", async () => {
    const res = await generateResume({ userId, conversationId, facts: FACTS, resumeType: "ats", targetTitle: "", jobDescription: "", sourceText: SOURCE_TEXT, retainSourceText: true });
    conversationId = res.conversationId;
    expect(await retainedSourceText(res.conversationId)).toBe(SOURCE_TEXT);
  });

  test("regeneration WITHOUT an upload preserves the earlier retention choice", async () => {
    const res = await generateResume({ userId, conversationId, facts: FACTS, resumeType: "ats", targetTitle: "", jobDescription: "" });
    conversationId = res.conversationId;
    expect(await retainedSourceText(res.conversationId)).toBe(SOURCE_TEXT);
  });

  test("a later transient upload REPLACES (discards) previously retained text", async () => {
    const res = await generateResume({ userId, conversationId, facts: FACTS, resumeType: "ats", targetTitle: "", jobDescription: "", sourceText: "updated text", retainSourceText: false });
    conversationId = res.conversationId;
    expect(await retainedSourceText(res.conversationId)).toBeNull();
  });
});
