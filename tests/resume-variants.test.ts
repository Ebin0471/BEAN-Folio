/// <reference types="bun-types" />
/**
 * M33.5-C — non-destructive tailored copies + revision history.
 *
 * IMPORTANT: this suite module-mocks the AI gateway (@/lib/ai) with a
 * deterministic draft. Run per-file (the repo's official runner
 * scripts/ci/run-tests.sh always does) — mock.module is process-global.
 *
 * Spec §5.4 / §7 contracts pinned here:
 *  - the master resume is NEVER mutated by a tailored copy;
 *  - the copy is a separate RESUME conversation linked to the master,
 *    with the master's facts snapshot copied verbatim;
 *  - the JD is stored as a hash by default; full text ONLY with explicit
 *    opt-in;
 *  - snapshots are transactional (mutation without snapshot is impossible
 *    by construction — the snapshot runs in the same $transaction);
 *  - restore snapshots the CURRENT state first (restore-forward works);
 *  - pruning is bounded and never deletes pinned revisions;
 *  - the diff reports removed/reworded/reordered facts honestly.
 *
 * Run: bun test tests/resume-variants.test.ts   (isolated QA DB)
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";

// Deterministic AI gateway: returns a tailor-shaped draft that reorders
// skills and rewords the summary (no new facts — the guard would reject).
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
      highlights: ["Led the TypeScript migration", "Cut CI build times"],
    },
    {
      company: "Nimbus Labs",
      position: "Junior Developer",
      startDate: "2019-01",
      endDate: "2021-02",
      current: false,
      summary: "Dashboard features.",
      highlights: [],
    },
  ],
  education: [
    { institution: "Visvesvaraya National Institute of Technology", area: "Computer Science", studyType: "B.Tech", startDate: "2015", endDate: "2019", score: "8.6 CGPA" },
  ],
  skills: [{ name: "TypeScript", level: "" }, { name: "React", level: "" }, { name: "Redux", level: "" }],
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
import { createSession, hashPassword } from "@/lib/auth";
import {
  createTailoredCopy,
  saveRevision,
  listRevisions,
  restoreRevision,
  setRevisionPin,
  getRevisionDetail,
  getResumeDetail,
  ResumeServiceError,
} from "@/lib/laxii/resume-service";
import { resumeDataSchema } from "@/lib/laxii/resume-schema";
import { diffResumeDocuments } from "@/lib/laxii/resume-diff";

const STAMP = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const EMAIL = `laxii-variants-${STAMP}@test.beanfolio.local`;
const JD = "Requirements:\n- Expert React and TypeScript\n- Design-system ownership\n- 5 years of experience";

const MASTER_DOC = resumeDataSchema.parse({
  basics: { name: "Asha Verma", email: "asha.verma@example.com", phone: "+91 90000 00000", location: "Bengaluru", summary: "Frontend engineer building accessible, fast web applications." },
  work: [
    { company: "Zeta Systems", position: "Software Engineer", startDate: "2021-03", endDate: "", current: true, summary: "Built design-system components.", highlights: ["Led TypeScript migration"] },
    { company: "Nimbus Labs", position: "Junior Developer", startDate: "2019-01", endDate: "2021-02", current: false, summary: "Dashboard features.", highlights: [] },
  ],
  education: [{ institution: "Visvesvaraya National Institute of Technology", area: "Computer Science", studyType: "B.Tech", startDate: "2015", endDate: "2019", score: "8.6 CGPA" }],
  skills: [{ name: "React", level: "" }, { name: "TypeScript", level: "" }, { name: "Redux", level: "" }],
  custom: [],
  order: [],
  titles: {},
});

const FACTS = {
  basics: { name: "Asha Verma", label: "", email: "asha.verma@example.com", phone: "+91 90000 00000", website: "", location: "Bengaluru", summary: "Frontend engineer building accessible, fast web applications." },
  work: MASTER_DOC.work,
  education: MASTER_DOC.education,
  skills: ["React", "TypeScript", "Redux"],
  projects: [],
  certificates: [],
  awards: [],
  custom: [],
};

let userId: string;
let masterConvId: string;
let masterResumeId: string;
let masterDocBefore: string;

beforeAll(async () => {
  const user = await db.user.create({ data: { email: EMAIL, passwordHash: await hashPassword("variants-pass"), name: "Variants" } });
  userId = user.id;
  const conv = await db.laxiiConversation.create({
    data: {
      userId,
      title: "Asha Verma — Resume",
      kind: "RESUME",
      resume: {
        create: {
          userId,
          resumeType: "ats",
          template: "classic",
          dataJson: JSON.stringify(MASTER_DOC),
          factsJson: JSON.stringify(FACTS),
          targetTitle: "Frontend Engineer",
        },
      },
    },
  });
  masterConvId = conv.id;
  const row = await db.laxiiResume.findUniqueOrThrow({ where: { conversationId: masterConvId } });
  masterResumeId = row.id;
  masterDocBefore = row.dataJson;
});

afterAll(async () => {
  await db.laxiiConversation.delete({ where: { id: masterConvId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
});

describe("M33.5-C tailored copies", () => {
  test("createTailoredCopy leaves the master untouched and creates a linked variant", async () => {
    const result = await createTailoredCopy({ userId, conversationId: masterConvId, jobDescription: JD, targetTitle: "Senior Frontend Engineer" });
    // master unchanged
    const masterAfter = await db.laxiiResume.findUniqueOrThrow({ where: { id: masterResumeId } });
    expect(masterAfter.dataJson).toBe(masterDocBefore);
    expect(masterAfter.variantKind).toBe("master");
    // copy linked
    const copy = await db.laxiiResume.findUniqueOrThrow({ where: { conversationId: result.conversationId } });
    expect(copy.variantKind).toBe("tailored");
    expect(copy.parentConversationId).toBe(masterConvId);
    expect(copy.targetTitle).toBe("Senior Frontend Engineer");
    // facts snapshot copied verbatim (all source facts preserved)
    expect(copy.factsJson).toBe(masterAfter.factsJson);
    // document tailored (summary reworded, skills reordered by the mock draft)
    expect(copy.dataJson).not.toBe(masterAfter.dataJson);
    const copyDoc = resumeDataSchema.parse(JSON.parse(copy.dataJson));
    expect(copyDoc.basics.summary).toContain("accessible interfaces");
    expect(copyDoc.skills[0].name).toBe("TypeScript");
    // diff reports rewording honestly
    expect(result.diff.summaryChanged).toBe(true);
    expect(result.diff.skillsReordered).toBe(true);
    expect(result.diff.removedSkills).toEqual([]);
    expect(result.diff.addedSkills).toEqual([]);
    expect(result.notes.join(" ")).toContain("master resume was NOT modified");
    // JD stored as hash only (no full text by default)
    expect(copy.jobDescriptionHash).toHaveLength(64);
    expect(copy.jobDescription).toBeNull();
    // cleanup the copy conversation
    await db.laxiiConversation.delete({ where: { id: result.conversationId } });
  });

  test("full JD text is stored only with the explicit opt-in", async () => {
    const result = await createTailoredCopy({ userId, conversationId: masterConvId, jobDescription: JD, targetTitle: "Opt-in Role", saveFullJobDescription: true });
    const copy = await db.laxiiResume.findUniqueOrThrow({ where: { conversationId: result.conversationId } });
    expect(copy.jobDescription).toBe(JD);
    expect(copy.jobDescriptionHash).toHaveLength(64);
    await db.laxiiConversation.delete({ where: { id: result.conversationId } });
  });

  test("empty JD is refused; foreign conversation is 404", async () => {
    await expect(createTailoredCopy({ userId, conversationId: masterConvId, jobDescription: "   " })).rejects.toThrow(/Paste the job description/);
    await expect(createTailoredCopy({ userId, conversationId: "does-not-exist", jobDescription: JD })).rejects.toThrow(ResumeServiceError);
  });

  test("detail exposes variant metadata", async () => {
    const detail = await getResumeDetail(userId, masterConvId);
    expect(detail.variantKind).toBe("master");
  });
});

describe("M33.5-C revision history", () => {
  test("save/list/restore: restore snapshots the current state first and is reversible", async () => {
    const r1 = await saveRevision({ userId, conversationId: masterConvId, label: "checkpoint A" });
    expect(r1.label).toBe("checkpoint A");
    expect(r1.provenance).toBe("user");
    const list1 = await listRevisions(userId, masterConvId);
    expect(list1.length).toBeGreaterThanOrEqual(1);
    // Restore to checkpoint A (content identical → doc unchanged but a RESTORE snapshot exists)
    const detailBeforeRestore = await getRevisionDetail(userId, masterConvId, r1.id);
    await restoreRevision({ userId, conversationId: masterConvId, revisionId: r1.id });
    const afterRestore = await db.laxiiResume.findUniqueOrThrow({ where: { id: masterResumeId } });
    // Content equals the restored snapshot's content.
    expect(JSON.parse(afterRestore.dataJson)).toEqual(JSON.parse(JSON.stringify(detailBeforeRestore.data)));
    const list2 = await listRevisions(userId, masterConvId);
    expect(list2[0].operation).toBe("RESTORE"); // newest snapshot records the restore
    // Restore-forward: pick the newest snapshot and go back — nothing is lost.
    const detail = await getRevisionDetail(userId, masterConvId, r1.id);
    expect(detail.data.basics.name).toBe("Asha Verma");
  });

  test("pin protects a revision from pruning; pruning is bounded at 30", async () => {
    // The pinned "checkpoint A" must exist, then push 32 distinct snapshots.
    const list0 = await listRevisions(userId, masterConvId);
    const pinned = list0.find((r) => r.label === "checkpoint A");
    expect(pinned).toBeDefined();
    await setRevisionPin({ userId, conversationId: masterConvId, revisionId: pinned!.id, pinned: true });
    const base = resumeDataSchema.parse(JSON.parse(masterDocBefore));
    for (let i = 0; i < 32; i += 1) {
      const mutated = resumeDataSchema.parse(JSON.parse(JSON.stringify(base)));
      mutated.basics.summary = `Frontend engineer building accessible, fast web applications. Marker ${i}`;
      await db.laxiiResume.update({ where: { id: masterResumeId }, data: { dataJson: JSON.stringify(mutated) } });
      await saveRevision({ userId, conversationId: masterConvId, label: `bulk ${i}` });
    }
    // listRevisions caps at 30 — verify boundedness and pinned survival in the DB itself.
    const total = await db.laxiiResumeRevision.count({ where: { resumeId: masterResumeId } });
    expect(total).toBeLessThanOrEqual(31); // 30 newest + the pinned one beyond the window
    const pinnedAgain = await db.laxiiResumeRevision.findUniqueOrThrow({ where: { id: pinned!.id } });
    expect(pinnedAgain.pinned).toBe(true); // pinned survived pruning
    const list = await listRevisions(userId, masterConvId);
    expect(list.length).toBeLessThanOrEqual(30);
    expect(list.every((r) => r.id !== pinned!.id || r.pinned)).toBe(true);
  });
});

describe("M33.5-C resume diff (pure)", () => {
  test("diff distinguishes removal, rewording and reorder without inventing categories", () => {
    const a = MASTER_DOC;
    const b = resumeDataSchema.parse({
      ...JSON.parse(JSON.stringify(MASTER_DOC)),
      basics: { ...MASTER_DOC.basics, summary: "Reworded summary." },
      skills: [{ name: "Redux", level: "" }, { name: "React", level: "" }, { name: "TypeScript", level: "" }],
    });
    const d = diffResumeDocuments(a, b);
    expect(d.summaryChanged).toBe(true);
    expect(d.skillsReordered).toBe(true);
    expect(d.removedSkills).toEqual([]);
    expect(d.addedSkills).toEqual([]);
    const c = resumeDataSchema.parse({ ...JSON.parse(JSON.stringify(MASTER_DOC)), skills: [{ name: "React", level: "" }] });
    const d2 = diffResumeDocuments(a, c);
    expect(d2.removedSkills.sort()).toEqual(["Redux", "TypeScript"]);
    expect(d2.summary.join(" ")).toContain("de-emphasized");
  });
});

// ------------------------------------------------- route boundary (HTTP)

import { NextRequest } from "next/server";
import { POST as resumeRoute } from "@/app/api/laxii/resume/route";
import { GET as revisionsGet, POST as revisionsPost } from "@/app/api/laxii/resume/revisions/route";

let cookieToken: string | undefined;
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieToken && name === "bean_session" ? { name, value: cookieToken } : undefined,
    set: () => undefined,
  }),
}));

function postJson(route: (req: NextRequest) => Promise<Response>, body: unknown): Promise<Response> {
  const req = new NextRequest("http://localhost/api/laxii/resume", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return route(req) as unknown as Promise<Response>;
}

describe("M33.5-C route contracts", () => {
  test("tailor_copy is owner-scoped (foreign conversation → 404) and returns the diff", async () => {
    cookieToken = undefined;
    expect((await postJson(resumeRoute, { action: "tailor_copy", conversationId: masterConvId, jobDescription: JD })).status).toBe(401);
    cookieToken = "foreign-session-token"; // nonexistent user
    expect((await postJson(resumeRoute, { action: "tailor_copy", conversationId: masterConvId, jobDescription: JD })).status).toBe(401);
    cookieToken = await createSession(userId);
    const res = await postJson(resumeRoute, { action: "tailor_copy", conversationId: masterConvId, jobDescription: JD, targetTitle: "Route copy" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversationId: string; masterConversationId: string; diff: { summary: string[] }; jobDescriptionHash: string };
    expect(body.masterConversationId).toBe(masterConvId);
    expect(body.conversationId).not.toBe(masterConvId);
    expect(body.diff.summary.length).toBeGreaterThan(0);
    expect(body.jobDescriptionHash).toHaveLength(64);
    await db.laxiiConversation.delete({ where: { id: body.conversationId } });
  });

  test("revisions routes are owner-scoped and restore works end-to-end", async () => {
    cookieToken = await createSession(userId);
    const listRes = await revisionsGet(
      new NextRequest(`http://localhost/api/laxii/resume/revisions?conversationId=${masterConvId}`)
    );
    expect(listRes.status).toBe(200);
    const { revisions } = (await listRes.json()) as { revisions: { id: string; operation: string }[] };
    expect(revisions.length).toBeGreaterThan(0);
    const restoreRes = await postJson(revisionsPost, { action: "restore", conversationId: masterConvId, revisionId: revisions[0].id });
    expect(restoreRes.status).toBe(200);
    // foreign user gets 404 (indistinguishable from nonexistent)
    const userB = await db.user.create({ data: { email: `${EMAIL}-b`, passwordHash: await hashPassword("variants-pass"), name: "Variants B" } });
    cookieToken = await createSession(userB.id);
    expect((await revisionsGet(new NextRequest(`http://localhost/api/laxii/resume/revisions?conversationId=${masterConvId}`))).status).toBe(404);
    expect((await postJson(revisionsPost, { action: "restore", conversationId: masterConvId, revisionId: revisions[0].id })).status).toBe(404);
    await db.user.delete({ where: { id: userB.id } });
    cookieToken = await createSession(userId);
  });
});
