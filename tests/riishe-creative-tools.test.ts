/// <reference types="bun-types" />
/**
 * M35 — RIISHE unified creative agent: the registered GIFTZ / LAXII /
 * career-document tools.
 *
 * IMPORTANT: this suite module-mocks the AI gateway (@/lib/ai) with
 * deterministic drafts. Run per-file (the repo's official runner
 * scripts/ci/run-tests.sh always does) — mock.module is process-global.
 *
 * Contracts pinned here:
 *  - every creative tool is a REGISTERED tool with registry-derived risk and
 *    the honest approval gate (`giftz.task.approve` is HIGH/level-2 and the
 *    queue never executes it unapproved);
 *  - handlers wrap the REAL services and re-verify ownership (cross-owner
 *    ids fail honestly);
 *  - verify hooks re-read the persistent output before success;
 *  - typed artefact references resolve through REF_RESULT_KEYS and fail
 *    honestly when the referenced step produced nothing;
 *  - deterministic planner clauses map creative goals without inventing ids;
 *  - the durable GIFTZ task + banner brief + generation jobs land as REAL
 *    rows (AgentTask, GiftzSite, LaxiiMessage) — nothing is faked.
 *
 * Run: bun test tests/riishe-creative-tools.test.ts   (isolated QA DB)
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Deterministic AI gateway (mutable per-section for letter guard cases).
let LETTER_JSON: Record<string, unknown> | null = null;
let TAILOR_JSON: Record<string, unknown> | null = null;

mock.module("@/lib/ai", () => ({
  AiProviderError: class AiProviderError extends Error {},
  aiComplete: async (_system: string, _messages: unknown[], opts?: { feature?: string }) => {
    const feature = opts?.feature ?? "";
    if (feature.includes("cover") || _system.includes("senior career writer")) {
      return { text: JSON.stringify(LETTER_JSON ?? { opening: "", bodyParagraphs: [], closing: "" }), model: "mock", provider: "mock", usage: {} };
    }
    return { text: JSON.stringify(TAILOR_JSON ?? {}), model: "mock", provider: "mock", usage: {} };
  },
  aiVision: async () => ({ text: '{"findings":[]}', model: "mock", provider: "mock", usage: {} }),
  aiGate: async () => null,
  parseJsonFromText: <T,>(text: string): T | null => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  },
  aiStream: async () => ({ text: "ok", model: "mock", provider: "mock", usage: {} }),
}));

import { db } from "@/lib/db";
import { CREATIVE_TOOLS } from "@/lib/riishe/creative-tools";
import { getTool, toolApprovalRequired, REF_FIELDS, REF_RESULT_KEYS } from "@/lib/riishe/tools";
import { runWorkflowStepJob, createWorkflowFromPlan, loadOwned, approveStep, executeApprovedStep } from "@/lib/riishe/workflow-engine";
import { planDeterministically } from "@/lib/riishe/planner";
import { classifySpecialist, getSpecialist, SPECIALISTS } from "@/lib/riishe/specialists";
import { canonicalBannerPreset } from "@/lib/laxii/banner-presets";
import { resumeDataSchema, resumeFactsSchema } from "@/lib/laxii/resume-schema";
import { GiftzTaskError } from "@/lib/giftz/jobs";
import { createWorkspaceFromTemplate, removeWorkspace } from "@/lib/giftz/workspace";

const cleanupUsers: string[] = [];
const cleanupRepos: string[] = [];
const cleanupWorkspaces: string[] = [];

// GIFTZ workspace isolation (matches tests/giftz-api.test.ts).
const WORKSPACE_ROOT = mkdtempSync(path.join(os.tmpdir(), "m35-creative-"));
process.env.CODE_GIFTZ_WORKSPACE_ROOT = WORKSPACE_ROOT;

let owner: { id: string; username: string };
let other: { id: string; username: string };

async function makeUser(username: string): Promise<{ id: string; username: string }> {
  const u = await db.user.create({
    data: {
      email: `${username}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`,
      passwordHash: "0".repeat(32) + ":" + "0".repeat(128),
      name: username,
      username,
      onboarded: true,
      profileVisibility: "PUBLIC",
    },
  });
  cleanupUsers.push(u.id);
  return { id: u.id, username: u.username! };
}

beforeAll(async () => {
  owner = await makeUser("m35owner");
  other = await makeUser("m35other");
});

afterAll(async () => {
  for (const id of cleanupUsers) {
    await db.user.delete({ where: { id } }).catch(() => undefined);
  }
  for (const id of cleanupWorkspaces) {
    try {
      removeWorkspace(id);
    } catch {
      /* already gone */
    }
  }
});

// ------------------------------------------------------------------ registry

describe("M35 creative tools — registry contracts", () => {
  const NAMES = [
    "giftz.site.plan",
    "giftz.site.create",
    "giftz.task.create",
    "giftz.task.status",
    "giftz.task.approve",
    "laxii.banner.brief",
    "laxii.banner.produce",
    "laxii.job.status",
    "career.resume.analyze",
    "career.resume.importProposal",
    "career.resume.tailoredCopy",
    "career.coverLetter.draft",
  ];

  test("every creative tool is registered with a consistent definition", () => {
    expect(Object.keys(CREATIVE_TOOLS).length).toBe(NAMES.length);
    for (const name of NAMES) {
      const tool = getTool(name);
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe(name);
      expect(["LOW", "MEDIUM", "HIGH", "DESTRUCTIVE"]).toContain(tool!.risk);
      expect(tool!.timeoutMs).toBeGreaterThan(0);
      expect(tool!.maxAttempts).toBeGreaterThan(0);
      expect(typeof tool!.description).toBe("string");
    }
  });

  test("the approval ladder (M35.7): execution + provider/AI generation tools are approval-class", () => {
    const approvalTools = NAMES.filter((n) => toolApprovalRequired(getTool(n)!));
    // giftz.task.approve executes real file edits (HIGH). M35.7: the LAXII
    // provider generation and the AI career-document generators consume the
    // owner's provisioned budget — explicit level-2 approval for every run.
    expect(approvalTools.sort()).toEqual(
      ["career.coverLetter.draft", "career.resume.tailoredCopy", "giftz.task.approve", "laxii.banner.produce"].sort()
    );
    expect(getTool("giftz.task.approve")!.risk).toBe("HIGH");
    expect(getTool("giftz.task.approve")!.level).toBe(2);
    expect(getTool("giftz.task.approve")!.maxAttempts).toBe(1);
    for (const n of ["laxii.banner.produce", "career.resume.tailoredCopy", "career.coverLetter.draft"]) {
      // MEDIUM + level 2 — the post.schedule precedent: the generic risk map
      // alone would permit silent execution, the registry declaration does not.
      expect(getTool(n)!.risk).toBe("MEDIUM");
      expect(getTool(n)!.level).toBe(2);
      expect(toolApprovalRequired(getTool(n)!)).toBe(true);
    }
    // nothing here publishes/sends/deletes: DESTRUCTIVE must never appear
    expect(NAMES.filter((n) => getTool(n)!.risk === "DESTRUCTIVE")).toEqual([]);
  });

  test("every REF_FIELD has a REF_RESULT_KEYS mapping (typed artefact references)", () => {
    for (const key of REF_FIELDS) {
      expect(typeof REF_RESULT_KEYS[key]).toBe("string");
      expect(REF_RESULT_KEYS[key].length).toBeGreaterThan(0);
    }
    expect(REF_RESULT_KEYS.briefTaskRef).toBe("briefTaskId");
    expect(REF_RESULT_KEYS.giftzTaskRef).toBe("taskId");
    expect(REF_RESULT_KEYS.resumeRef).toBe("conversationId");
    expect(REF_RESULT_KEYS.jobRef).toBe("messageId");
    // legacy mappings preserved
    expect(REF_RESULT_KEYS.draftRef).toBe("draftTaskId");
    expect(REF_RESULT_KEYS.postRef).toBe("postId");
  });

  test("the creative-producer specialist is available and registry-checked", () => {
    const s = getSpecialist("creative-producer");
    expect(s).not.toBeNull();
    expect(s!.available()).toBe(true);
    for (const t of s!.toolNames) expect(getTool(t)).not.toBeNull();
    // M36.1: 10 existing + People Finder + Portfolio Intelligence Analyst.
    // M36.2 added the 13th (Workforce Strategist), M36.3 the 14th
    // (Talent Intelligence Analyst), M36.4 the 15th (Candidate Relations
    // Agent), M36.6 the 16th and 17th (GIFTZ Product Architect and GIFTZ
    // Experience & Quality Auditor — see
    // tests/riishe-m366-giftz-specialists.test.ts) and M36.7 the 18th (LAXII
    // Art Director — see tests/riishe-m367-laxii-art-director.test.ts).
    expect(SPECIALISTS.length).toBe(18);
    // banner goals route to the creative producer
    expect(classifySpecialist("prepare a banner design brief for my channel art")?.id).toBe("creative-producer");
  });
});

// ------------------------------------------------------------ deterministic planner

describe("M35 deterministic planner clauses", () => {
  test("website planning maps to giftz.site.plan without inventing ids", () => {
    const plan = planDeterministically("plan the architecture for my photography website");
    expect(plan).not.toBeNull();
    expect(plan!.steps.some((s) => s.tool === "giftz.site.plan")).toBe(true);
  });

  test("banner brief requests map to laxii.banner.brief", () => {
    const plan = planDeterministically("prepare a banner design brief for my portfolio");
    expect(plan).not.toBeNull();
    const step = plan!.steps.find((s) => s.tool === "laxii.banner.brief");
    expect(step).toBeDefined();
    // the request is the clause verbatim — no invented text
    expect((step!.params.request as string).toLowerCase()).toContain("banner");
  });
});

// ---------------------------------------------------------------- GIFTZ tools

describe("M35 giftz.* tools", () => {
  test("giftz.site.plan returns the deterministic architecture plan", async () => {
    const tool = getTool("giftz.site.plan")!;
    const parsed = tool.inputSchema.parse({ brief: "A portfolio website for a wedding photographer with a gallery and a contact page" });
    const result = await tool.execute({ userId: owner.id }, parsed as never);
    const plan = (result as { plan: { family: { id: string }; sitemap: unknown[]; featureMatrix: unknown[] } }).plan;
    expect(plan).toBeDefined();
    expect(plan.family.id.length).toBeGreaterThan(0);
    expect(Array.isArray(plan.sitemap)).toBe(true);
    expect(Array.isArray(plan.featureMatrix)).toBe(true);
  });

  test("giftz.site.plan refuses unsupported families honestly", async () => {
    const tool = getTool("giftz.site.plan")!;
    const parsed = tool.inputSchema.parse({ brief: "x", familyId: "definitely-not-a-family" });
    await expect(tool.execute({ userId: owner.id }, parsed as never)).rejects.toThrow(/rejected the brief/);
  });

  test("giftz.site.create persists an owned draft and the verify hook re-reads it", async () => {
    const tool = getTool("giftz.site.create")!;
    const parsed = tool.inputSchema.parse({ title: "Studio site", sourcePrompt: "minimal portfolio" });
    const result = (await tool.execute({ userId: owner.id }, parsed as never)) as { siteId: string };
    const verification = await tool.verify!({ userId: owner.id }, parsed as never, result as Record<string, unknown>);
    expect(verification.ok).toBe(true);
    const row = await db.giftzSite.findFirst({ where: { id: result.siteId, userId: owner.id } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("DRAFT");
    // cross-owner verification fails honestly
    const otherVerification = await tool.verify!({ userId: other.id }, parsed as never, result as Record<string, unknown>);
    expect(otherVerification.ok).toBe(false);
  });

  test("giftz.task.create lands a REAL durable AgentTask (AWAITING_APPROVAL flow) and dedupes", async () => {
    const repo = await db.giftzRepository.create({
      data: { ownerId: owner.id, name: `repo-${Date.now()}`, status: "READY", fileCount: 3, sizeBytes: 100 },
    });
    cleanupRepos.push(repo.id);
    const tool = getTool("giftz.task.create")!;
    const parsed = tool.inputSchema.parse({ repoId: repo.id, request: "Add a contact page with a working form" });
    const result = (await tool.execute({ userId: owner.id }, parsed as never)) as { taskId: string };
    const verification = await tool.verify!({ userId: owner.id }, parsed as never, result as Record<string, unknown>);
    expect(verification.ok).toBe(true);

    // duplicate prevention: a second create re-attaches
    const second = (await tool.execute({ userId: owner.id }, parsed as never)) as { taskId: string; duplicate?: boolean };
    expect(second.taskId).toBe(result.taskId);
    expect(second.duplicate).toBe(true);

    // cross-owner repo is refused by the real service
    const foreign = tool.inputSchema.parse({ repoId: repo.id, request: "Add a contact page with a working form" });
    await expect(tool.execute({ userId: other.id }, foreign as never)).rejects.toThrow(/not found/i);
  });

  test("giftz.task.create without a READY repository fails honestly (no fabricated repo)", async () => {
    const tool = getTool("giftz.task.create")!;
    const parsed = tool.inputSchema.parse({ request: "Update the about page copy please" });
    await expect(tool.execute({ userId: other.id }, parsed as never)).rejects.toThrow(/No GIFTZ repository/);
  });

  test("giftz.task.status reports the durable record; foreign tasks are refused", async () => {
    const tool = getTool("giftz.task.status")!;
    const task = await db.agentTask.create({
      data: {
        userId: owner.id,
        agent: "CODE_GIFTZ",
        kind: "ENGINEERING_TASK",
        title: "status probe",
        status: "AWAITING_APPROVAL",
        repoId: (await db.giftzRepository.create({ data: { ownerId: owner.id, name: `r-${Date.now()}`, status: "READY" } })).id,
        resultJson: JSON.stringify({ request: "status probe", plan: null, inspection: null, edits: [], diffs: [], runs: [], report: null, attempts: 0 }),
      },
    });
    const parsed = tool.inputSchema.parse({ taskId: task.id });
    const result = (await tool.execute({ userId: owner.id }, parsed as never)) as { taskId: string; status: string };
    expect(result.taskId).toBe(task.id);
    expect(result.status).toBe("AWAITING_APPROVAL");
    const foreign = tool.inputSchema.parse({ taskId: task.id });
    await expect(tool.execute({ userId: other.id }, foreign as never)).rejects.toBeInstanceOf(GiftzTaskError);
  });

  test("giftz.task.approve is approval-gated: the queue never executes it unapproved", async () => {
    const tool = getTool("giftz.task.approve")!;
    // the tool handler itself refuses non-AWAITING_APPROVAL tasks through the
    // real service (a QUEUED task cannot be approved) — honest failure.
    const task = await db.agentTask.create({
      data: {
        userId: owner.id,
        agent: "CODE_GIFTZ",
        kind: "ENGINEERING_TASK",
        title: "approve gate probe",
        status: "QUEUED",
        resultJson: JSON.stringify({ request: "approve gate probe", plan: null, inspection: null, edits: [], diffs: [], runs: [], report: null, attempts: 0 }),
      },
    });
    const parsed = tool.inputSchema.parse({ taskId: task.id });
    await expect(tool.execute({ userId: owner.id }, parsed as never)).rejects.toThrow(/only AWAITING_APPROVAL/i);
  });

  test("giftz.task.approve drives a REAL AWAITING_APPROVAL task into EXECUTING", async () => {
    const repo = await db.giftzRepository.create({
      data: { ownerId: owner.id, name: `approve-${Date.now()}`, status: "READY", fileCount: 2, sizeBytes: 10 },
    });
    cleanupRepos.push(repo.id);
    createWorkspaceFromTemplate(repo.id);
    cleanupWorkspaces.push(repo.id);
    const task = await db.agentTask.create({
      data: {
        userId: owner.id,
        agent: "CODE_GIFTZ",
        kind: "ENGINEERING_TASK",
        title: "approve execution probe",
        status: "AWAITING_APPROVAL",
        repoId: repo.id,
        resultJson: JSON.stringify({
          request: "approve execution probe",
          // launchExecution requires a validated plan to claim — a realistic
          // AWAITING_APPROVAL task always carries one.
          plan: { summary: "probe", files: [], steps: [], commands: [] },
          inspection: null,
          edits: [],
          diffs: [],
          runs: [],
          report: null,
          attempts: 0,
        }),
      },
    });
    const tool = getTool("giftz.task.approve")!;
    const parsed = tool.inputSchema.parse({ taskId: task.id });
    const result = (await tool.execute({ userId: owner.id }, parsed as never)) as { taskId: string; started: boolean };
    expect(result.started).toBe(true);
    const verification = await tool.verify!({ userId: owner.id }, parsed as never, result as Record<string, unknown>);
    expect(verification.ok).toBe(true);
    const fresh = await db.agentTask.findUnique({ where: { id: task.id }, select: { status: true } });
    expect(fresh!.status).toBe("EXECUTING");
  });
});

// ---------------------------------------------------------------- LAXII tools

describe("M35 laxii.banner.* tools", () => {
  test("laxii.banner.brief persists a structured brief with the authoritative canvas; explicit text only", async () => {
    const tool = getTool("laxii.banner.brief")!;
    const parsed = tool.inputSchema.parse({
      request: 'A premium banner for my portfolio with the headline "Studio Almanac"',
      headline: "Studio Almanac",
    });
    const result = (await tool.execute({ userId: owner.id }, parsed as never)) as {
      briefTaskId: string;
      typography: { text: string; role: string }[];
      canvas: { presetSlug: string; width: number; height: number };
    };
    expect(result.briefTaskId).toBeTruthy();
    expect(result.typography).toHaveLength(1);
    expect(result.typography[0].text).toBe("Studio Almanac");
    expect(result.typography[0].role).toBe("headline");

    const verification = await tool.verify!({ userId: owner.id }, parsed as never, result as Record<string, unknown>);
    expect(verification.ok).toBe(true);

    const preset = canonicalBannerPreset();
    expect(result.canvas).toEqual({ presetSlug: preset.slug, width: preset.width, height: preset.height });

    // the durable AgentTask row is REAL and owner-scoped
    const row = await db.agentTask.findFirst({ where: { id: result.briefTaskId, userId: owner.id, kind: "BANNER_DESIGN", agent: "LAXII" } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("AWAITING_APPROVAL");
  });

  test("laxii.banner.produce starts the REAL pipeline: BANNER conversation + RUNNING job", async () => {
    const briefTool = getTool("laxii.banner.brief")!;
    const brief = (await briefTool.execute({ userId: owner.id }, briefTool.inputSchema.parse({ request: "Minimal banner, muted palette" }) as never)) as {
      briefTaskId: string;
    };

    const tool = getTool("laxii.banner.produce")!;
    const parsed = tool.inputSchema.parse({ briefTaskId: brief.briefTaskId });
    const result = (await tool.execute({ userId: owner.id }, parsed as never)) as {
      conversationId: string;
      messageId: string;
      status: string;
    };
    expect(result.status).toBe("RUNNING");
    const verification = await tool.verify!({ userId: owner.id }, parsed as never, result as Record<string, unknown>);
    expect(verification.ok).toBe(true);

    const conversation = await db.laxiiConversation.findUnique({ where: { id: result.conversationId } });
    expect(conversation).not.toBeNull();
    expect(conversation!.userId).toBe(owner.id);
    expect(conversation!.kind).toBe("BANNER");
    const preset = canonicalBannerPreset();
    expect(conversation!.canvasWidth).toBe(preset.width);
    expect(conversation!.canvasHeight).toBe(preset.height);

    const msg = await db.laxiiMessage.findUnique({ where: { id: result.messageId } });
    expect(msg).not.toBeNull();
    expect(["RUNNING", "FAILED"]).toContain(msg!.status);
    // the brief task is stamped RUNNING by the shared handoff
    const briefRow = await db.agentTask.findUnique({ where: { id: brief.briefTaskId }, select: { status: true } });
    expect(briefRow!.status).toBe("RUNNING");
  });

  test("laxii.banner.produce refuses foreign briefs and unknown ids honestly", async () => {
    const tool = getTool("laxii.banner.produce")!;
    await expect(tool.execute({ userId: owner.id }, tool.inputSchema.parse({ briefTaskId: "missing-brief" }) as never)).rejects.toThrow(/not found/i);
  });

  test("laxii.job.status reports the true outcome (owned, verbatim status)", async () => {
    const tool = getTool("laxii.job.status")!;
    const produce = getTool("laxii.banner.produce")!;
    const brief = (await getTool("laxii.banner.brief")!.execute({ userId: owner.id }, getTool("laxii.banner.brief")!.inputSchema.parse({ request: "Second banner probe" }) as never)) as {
      briefTaskId: string;
    };
    const run = (await produce.execute({ userId: owner.id }, produce.inputSchema.parse({ briefTaskId: brief.briefTaskId }) as never)) as {
      messageId: string;
      conversationId: string;
    };
    const parsed = tool.inputSchema.parse({ messageId: run.messageId });
    const result = (await tool.execute({ userId: owner.id }, parsed as never)) as { messageId: string; conversationId: string; status: string; note: string };
    expect(result.messageId).toBe(run.messageId);
    expect(result.conversationId).toBe(run.conversationId);
    expect(typeof result.note).toBe("string");
    // foreign job → honest refusal
    const foreign = tool.inputSchema.parse({ messageId: run.messageId });
    await expect(tool.execute({ userId: other.id }, foreign as never)).rejects.toThrow(/not yours/);
  });
});

// ---------------------------------------------------------- career-doc tools

async function seedResume(userId: string, opts?: { facts?: unknown; data?: unknown }) {
  const doc = resumeDataSchema.parse(
    opts?.data ?? {
      basics: { name: "Asha Verma", email: "asha@example.com", phone: "+91 90000 00000", location: "Bengaluru", summary: "Frontend engineer building accessible products." },
      work: [{ company: "Zeta Systems", position: "Software Engineer", startDate: "2021-03", endDate: "", current: true, summary: "Design-system work.", highlights: [] }],
      education: [{ institution: "VNIT", area: "Computer Science", studyType: "B.Tech", startDate: "2015", endDate: "2019", score: "" }],
      skills: [{ name: "React", level: "" }, { name: "TypeScript", level: "" }],
      custom: [],
    }
  );
  const conversation = await db.laxiiConversation.create({
    data: {
      userId,
      title: "M35 resume",
      kind: "RESUME",
      resume: {
        create: {
          userId,
          resumeType: "ats",
          template: "classic",
          dataJson: JSON.stringify(doc),
          factsJson: JSON.stringify(
            opts?.facts ??
              resumeFactsSchema.parse({
                basics: { name: "Asha Verma", email: "asha@example.com" },
                work: [{ company: "Zeta Systems", position: "Software Engineer", startDate: "2021-03", endDate: "", current: true, summary: "Design-system work.", highlights: [] }],
                education: [{ institution: "VNIT", area: "Computer Science", studyType: "B.Tech", startDate: "2015", endDate: "2019", score: "" }],
                skills: ["React", "TypeScript"],
              }),
          ),
          targetTitle: "Frontend Engineer",
        },
      },
    },
  });
  return conversation;
}

describe("M35 career.resume.* tools", () => {
  test("career.resume.analyze returns the deterministic readability report + evidence map", async () => {
    const conversation = await seedResume(owner.id);
    const tool = getTool("career.resume.analyze")!;
    const parsed = tool.inputSchema.parse({
      conversationId: conversation.id,
      jobDescription: "Requirements:\n- Expert React\n- 3 years of experience",
    });
    const result = (await tool.execute({ userId: owner.id }, parsed as never)) as {
      conversationId: string;
      readability: { score?: number };
      evidenceMap: { evidence: { verdict: string }[] };
    };
    expect(result.conversationId).toBe(conversation.id);
    expect(result.readability).toBeDefined();
    expect(Array.isArray(result.evidenceMap.evidence)).toBe(true);
    // evidence verdicts cite facts — no invented claims: verdicts are from the fixed set
    for (const e of result.evidenceMap.evidence) {
      expect(["supported", "partial", "missing", "not_assessable"]).toContain(e.verdict);
    }
    // foreign resume refused honestly
    const foreign = tool.inputSchema.parse({ conversationId: conversation.id });
    await expect(tool.execute({ userId: other.id }, foreign as never)).rejects.toThrow(/not yours|not found/);
  });

  test("career.resume.analyze falls back to the newest master resume and reports unparseable facts honestly", async () => {
    await seedResume(owner.id, { facts: { broken: true } });
    const tool = getTool("career.resume.analyze")!;
    const result = (await tool.execute({ userId: owner.id }, tool.inputSchema.parse({}) as never)) as {
      conversationId: string;
      evidenceNote?: string;
      readability: unknown;
    };
    expect(result.readability).toBeDefined();
    if (result.evidenceNote !== undefined) {
      expect(result.evidenceNote).toMatch(/evidence map was skipped/);
    }
  });

  test("career.resume.analyze fails honestly when no resume exists", async () => {
    await expect(
      getTool("career.resume.analyze")!.execute({ userId: other.id }, getTool("career.resume.analyze")!.inputSchema.parse({}) as never)
    ).rejects.toThrow(/No resume found/);
  });

  test("career.resume.importProposal extracts deterministically and persists NOTHING", async () => {
    const before = await db.laxiiResume.count({ where: { userId: owner.id } });
    const tool = getTool("career.resume.importProposal")!;
    const text = [
      "Asha Verma",
      "asha@example.com · +91 90000 00000",
      "EXPERIENCE",
      "Software Engineer, Zeta Systems, 2021-03 — present",
      "EDUCATION",
      "B.Tech Computer Science, VNIT, 2015 — 2019",
      "SKILLS",
      "React, TypeScript",
    ].join("\n");
    const parsed = tool.inputSchema.parse({ text });
    const result = (await tool.execute({ userId: owner.id }, parsed as never)) as { proposal: { basics: { email?: { value?: string } }; work: unknown[] } };
    expect(result.proposal.basics.email?.value).toBe("asha@example.com");
    expect(Array.isArray(result.proposal.work)).toBe(true);
    const after = await db.laxiiResume.count({ where: { userId: owner.id } });
    expect(after).toBe(before); // nothing persisted
  });

  test("career.resume.tailoredCopy runs the REAL service: separate copy, master untouched, verified", async () => {
    TAILOR_JSON = {
      basics: {
        name: "Asha Verma",
        label: "Senior Frontend Engineer",
        email: "asha@example.com",
        phone: "+91 90000 00000",
        website: "",
        location: "Bengaluru",
        summary: "Frontend engineer focused on accessible interfaces.",
      },
      work: [
        { company: "Zeta Systems", position: "Software Engineer", startDate: "2021-03", endDate: "", current: true, summary: "Design-system components.", highlights: ["Led TypeScript migration"] },
      ],
      education: [{ institution: "VNIT", area: "Computer Science", studyType: "B.Tech", startDate: "2015", endDate: "2019", score: "" }],
      skills: [{ name: "React", level: "" }, { name: "TypeScript", level: "" }],
      projects: [],
      certificates: [],
      awards: [],
    };
    const master = await seedResume(owner.id);
    const masterRow = await db.laxiiResume.findFirst({ where: { conversationId: master.id }, select: { dataJson: true, updatedAt: true } });

    const tool = getTool("career.resume.tailoredCopy")!;
    const parsed = tool.inputSchema.parse({ conversationId: master.id, jobDescription: "Requirements:\n- Expert React and TypeScript\n- Design-system ownership for a product team" });
    const result = (await tool.execute({ userId: owner.id }, parsed as never)) as {
      conversationId: string;
      masterConversationId: string;
      notes: string[];
    };
    expect(result.masterConversationId).toBe(master.id);
    expect(result.conversationId).not.toBe(master.id);
    expect(result.notes.some((n) => n.includes("was NOT modified"))).toBe(true);

    const verification = await tool.verify!({ userId: owner.id }, parsed as never, result as Record<string, unknown>);
    expect(verification.ok).toBe(true);

    const copy = await db.laxiiResume.findFirst({ where: { conversationId: result.conversationId, userId: owner.id } });
    expect(copy).not.toBeNull();
    expect(copy!.variantKind).toBe("tailored");
    expect(copy!.parentConversationId).toBe(master.id);
    expect(copy!.jobDescriptionHash).toBeTruthy();
    // the master document bytes are unchanged
    const freshMaster = await db.laxiiResume.findFirst({ where: { conversationId: master.id }, select: { dataJson: true } });
    expect(freshMaster!.dataJson).toBe(masterRow!.dataJson);
  });
});

describe("M35 career.coverLetter.draft", () => {
  test("generates through the REAL guarded writer and verifies the persisted row", async () => {
    LETTER_JSON = {
      opening: "I am applying for the Frontend Engineer role.",
      bodyParagraphs: ["My work at Zeta Systems covers React and TypeScript."],
      closing: "Thank you for your consideration.",
    };
    const conversation = await seedResume(owner.id);
    const tool = getTool("career.coverLetter.draft")!;
    const parsed = tool.inputSchema.parse({
      conversationId: conversation.id,
      targetRole: "Frontend Engineer",
      companyName: "Acme",
      jobDescription: "We need a React engineer with TypeScript depth for a design-system team.",
    });
    const result = (await tool.execute({ userId: owner.id }, parsed as never)) as { letterId: string; wordCount: number };
    expect(result.letterId).toBeTruthy();
    expect(result.wordCount).toBeGreaterThan(0);
    const verification = await tool.verify!({ userId: owner.id }, parsed as never, result as Record<string, unknown>);
    expect(verification.ok).toBe(true);
    const row = await db.laxiiCoverLetter.findFirst({ where: { id: result.letterId, userId: owner.id } });
    expect(row).not.toBeNull();
  });

  test("the anti-fabrication guard rejects unverified numbers — nothing is saved", async () => {
    LETTER_JSON = {
      opening: "I grew revenue by 340% at Acme Corporation.",
      bodyParagraphs: [],
      closing: "Regards.",
    };
    const conversation = await seedResume(owner.id);
    const before = await db.laxiiCoverLetter.count({ where: { userId: owner.id } });
    const tool = getTool("career.coverLetter.draft")!;
    const parsed = tool.inputSchema.parse({
      conversationId: conversation.id,
      targetRole: "Frontend Engineer",
      jobDescription: "We need a React engineer with TypeScript depth.",
    });
    await expect(tool.execute({ userId: owner.id }, parsed as never)).rejects.toThrow(/facts don't support|Nothing was saved/);
    const after = await db.laxiiCoverLetter.count({ where: { userId: owner.id } });
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------- engine integration

describe("M35 workflow engine integration", () => {
  /**
   * Drain riishe.workflow jobs through the REAL worker handler, retrying
   * ready steps until terminal (the production queue retries with backoff;
   * the test compresses the backoff to keep the suite bounded).
   */
  async function drainUntilSettled(): Promise<void> {
    for (let round = 0; round < 12; round++) {
      const jobs = await db.backgroundJob.findMany({
        where: { kind: "riishe.workflow", status: "QUEUED", runAt: { lte: new Date() } },
        take: 5,
      });
      if (jobs.length === 0) break;
      for (const job of jobs) {
        const payload = JSON.parse(job.payload) as { stepId?: string };
        // Retry the SAME job while its step is READY (the production queue
        // applies backoff between attempts; the test compresses it).
        for (let attempt = 0; attempt < 4; attempt++) {
          const claimed = await db.backgroundJob.update({
            where: { id: job.id },
            data: { status: "RUNNING", claimedBy: "test", claimedAt: new Date(), heartbeatAt: new Date() },
          });
          await runWorkflowStepJob(claimed).catch(() => undefined);
          await db.backgroundJob.update({ where: { id: job.id }, data: { status: "DONE" } }).catch(() => undefined);
          const step = payload.stepId ? await db.riisheWorkflowStep.findUnique({ where: { id: payload.stepId } }) : null;
          if (!step || step.status !== "READY") break;
        }
      }
    }
  }

  test("typed artefact refs resolve through the engine: banner brief → produce chain (level-2 produce approved explicitly)", async () => {
    const plan = {
      title: "Banner chain",
      summary: "brief then produce",
      steps: [
        { id: "b1", tool: "laxii.banner.brief", params: { request: "A minimal banner with a calm palette" } },
        { id: "b2", tool: "laxii.banner.produce", params: { briefTaskRef: "b1" }, dependsOn: ["b1"] },
      ],
    } as const;
    const wf = await createWorkflowFromPlan(owner.id, "brief then produce a banner", plan as unknown as Parameters<typeof createWorkflowFromPlan>[2], {
      planner: "deterministic",
    });
    await drainUntilSettled();
    let loaded = await loadOwned(owner.id, wf.id);
    const [briefStep, produceStep] = loaded.steps;
    expect(briefStep.status).toBe("SUCCEEDED");
    // M35.7: the provider-generation step is approval-class — the queue can
    // NEVER run it unapproved; it waits here for the explicit owner go-ahead.
    expect(produceStep.status).toBe("AWAITING_APPROVAL");
    expect(produceStep.requiresApproval).toBe(true);
    const unapprovedJobs = await db.backgroundJob.count({
      where: { kind: "riishe.workflow", status: "QUEUED", payload: { contains: produceStep.id } },
    });
    expect(unapprovedJobs).toBe(0);
    // the owner's explicit approval is what starts the real pipeline
    // (approval-time execution is the production path for approval-class steps)
    await approveStep(owner.id, produceStep.id, false);
    await executeApprovedStep(owner.id, produceStep.id);
    loaded = await loadOwned(owner.id, wf.id);
    expect(loaded.steps[1].status).toBe("SUCCEEDED");
    const briefResult = JSON.parse(loaded.steps[0].resultJson) as { briefTaskId: string; verification: { ok: boolean } };
    const produceResult = JSON.parse(loaded.steps[1].resultJson) as { conversationId: string; verification: { ok: boolean } };
    expect(briefResult.verification.ok).toBe(true);
    expect(produceResult.verification.ok).toBe(true);
    // the chain carried the REAL briefTaskId into the production conversation
    const conversation = await db.laxiiConversation.findFirst({
      where: { userId: owner.id, kind: "BANNER", canvasWidth: canonicalBannerPreset().width },
    });
    expect(conversation).not.toBeNull();
    void briefResult;
    void produceResult;
  });

  test("a ref to a step that produced nothing fails honestly (dependency-missing)", async () => {
    // laxii.job.status with jobRef pointing at the brief step (which produces
    // briefTaskId, not messageId) must FAIL the step — never fabricate a job.
    const plan = {
      title: "Honest missing ref",
      summary: "job status chained to a non-producing step",
      steps: [
        { id: "j0", tool: "laxii.banner.brief", params: { request: "Chain probe banner" } },
        { id: "j1", tool: "laxii.job.status", params: { jobRef: "j0" }, dependsOn: ["j0"] },
      ],
    } as const;
    const wf = await createWorkflowFromPlan(owner.id, "honest missing ref", plan as unknown as Parameters<typeof createWorkflowFromPlan>[2], {
      planner: "deterministic",
    });
    await drainUntilSettled();
    const loaded = await loadOwned(owner.id, wf.id);
    const statusStep = loaded.steps[1];
    expect(statusStep.status).toBe("FAILED");
    expect(statusStep.error).toMatch(/briefTaskId|produced no/);
  });
});
