/// <reference types="bun-types" />
/**
 * M36.7 — LAXII Art Director + the ONE real `laxii.art.direction` tool over
 * the EXISTING LAXII services, registries and quality-evaluation results.
 *
 * Isolated QA database (qa-db-env.sh guard). The AI gateway is module-mocked
 * with a recording SPY so the zero-AI proofs can assert exactly zero gateway
 * calls on every path.
 *
 * Contracts pinned here (docs/M36_MULTI_AGENT_WORKFORCE_ARCHITECTURE.md
 * §3-19, §5.9, §14; milestone M36.7):
 *  - Registry: the 18th specialist (PERSONAL + ORGANIZATION); live counts
 *    derive to 18 specialists / 44 tools; EXACTLY ONE new tool is registered
 *    (laxii.art.direction, LOW / level 1, read-only, idempotent, no verify
 *    hook, null undo); the existing generation tool laxii.banner.produce
 *    keeps MEDIUM / level 2 with the existing explicit approval requirement.
 *  - Direction & recommendations: the existing seven-direction classifier is
 *    used (all seven resolvable; ambiguous/weak prompts produce NO invented
 *    direction); style recommendations reference ONLY real STYLE_PRESETS
 *    slugs (public metadata — the server-side promptFragment never leaks);
 *    typography comes from the EXISTING provisioned-font recommender (real
 *    font ids only); explicit user typography stays authoritative; explicit
 *    palette data is preserved verbatim and missing palette is honest; the
 *    brand kit surfaces its actual rejections and warnings (unknown ids are
 *    rejections, never substitutions). No site, brief or config is modified.
 *  - Ownership: briefs load through the EXISTING owner-scoped loadBriefTask;
 *    jobs read through the owning conversation; foreign and missing records
 *    receive the SAME generic refusal (existence-hiding); ORGANIZATION
 *    workspace never widens ownership; typed briefTaskRef / jobRef stay
 *    pointers re-authorized at consumption (M35.7 engine rules).
 *  - Quality review: a DONE job's ALREADY-RECORDED pipeline quality report is
 *    validated and returned with actual finding ids/statuses and the EXISTING
 *    refinementDirectives mapping; AI-review findings stay explicitly
 *    advisory; RUNNING and FAILED jobs never get a fabricated verdict; absent
 *    or malformed reports are honestly unavailable; raw metadata, provider
 *    internals and private artifact data are never returned.
 *  - Revision preview: appendRevision + compileRevisionAddenda produce a
 *    correctly-scoped IN-MEMORY preview; unrelated brief fields are
 *    unchanged; the third-revision limit is honoured; nothing persists.
 *  - Zero effects: no AI/provider generation calls, no image spending, no new
 *    AgentTask, no LAXII message/version/media/conversation creation, no
 *    updates to an existing brief or job, no site/config writes, no
 *    deployments or builds — on EVERY path.
 *  - Preservation: Creative Producer, M36.6 GIFTZ specialists, existing LAXII
 *    banner tools/pipeline contracts, approval/quota boundaries, the avatar
 *    identity-lock flow (NOT a tool) and the OX/workforce suites stay intact.
 *
 * Run: bun test tests/riishe-m367-laxii-art-director.test.ts   (isolated QA DB)
 */
import { describe, expect, test, afterAll, mock, beforeEach } from "bun:test";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------- gateway spy
// Declared BEFORE the source imports so every module under test binds the spy.

const AI_CALLS: { system: string; messages: unknown[]; feature?: string }[] = [];

mock.module("@/lib/ai", () => ({
  AI_FEATURES: ["chat"],
  AI_DAILY_LIMIT: 30,
  AI_BURST_LIMIT: 6,
  AI_DEEP_TIMEOUT_MS: 120_000,
  AiProviderError: class AiProviderError extends Error {},
  aiCapabilities: () => ({ available: true, provider: "mock", features: ["chat"], dailyLimit: 30, consentRequired: false }),
  aiGate: async () => null,
  recordAiUsage: async () => undefined,
  aiComplete: async (system: string, messages: unknown[], opts?: { feature?: string }) => {
    AI_CALLS.push({ system, messages, feature: opts?.feature });
    throw new (class AiProviderError extends Error {})("gateway unavailable (spy default)");
  },
  aiStream: async () => ({ text: "ok", model: "mock", provider: "mock", usage: {} }),
  aiVision: async () => ({ text: "{}", model: "mock", provider: "mock", usage: {} }),
  parseJsonFromText: <T,>(text: string): T | null => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  },
}));

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { RIISHE_TOOLS, getTool, REF_FIELDS, REF_RESULT_KEYS } from "@/lib/riishe/tools";
import {
  SPECIALISTS,
  getSpecialist,
  classifySpecialist,
  specialistAllowsWorkspace,
} from "@/lib/riishe/specialists";
import { LAXII_ART_DIRECTION_TOOLS } from "@/lib/riishe/laxii-art-direction-tools";
import { detectArtDirection, artDirections } from "@/lib/laxii/art-direction";
import { STYLE_PRESETS, findStylePreset } from "@/lib/laxii/styles";
import { recommendBannerFontPairing, PROVISIONED_BANNER_FONTS } from "@/lib/laxii/font-assets";
import { designBriefSchema, type DesignBriefInput } from "@/lib/laxii/design-brief";
import { persistStructuredBriefTask } from "@/lib/intelligence/delegation";
import { planDeterministically } from "@/lib/riishe/planner";
import { createWorkflowFromPlan, resolveStepParams } from "@/lib/riishe/workflow-engine";
import { toolApprovalRequired, type ToolContext } from "@/lib/riishe/tool-contracts";

const RUN = randomUUID().slice(0, 8);
const cleanupUserIds: string[] = [];
const cleanupWorkflowIds: string[] = [];

async function makeUser(name: string) {
  const u = await db.user.create({
    data: {
      email: `m367-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("laxii-password-1"),
      name,
      username: `m367-${randomUUID().slice(0, 10)}`,
      onboarded: true,
    },
  });
  cleanupUserIds.push(u.id);
  return u;
}

/** A REAL structured brief persisted through the REAL delegation service. */
async function makeBriefTask(
  userId: string,
  spec?: { request?: string; toneWords?: string[]; palette?: string[]; typography?: DesignBriefInput["typography"]; revisions?: DesignBriefInput["revisions"]; targetAudience?: string; direction?: string }
) {
  const briefInput: DesignBriefInput = {
    schemaVersion: 1,
    request: spec?.request ?? "A calm professional banner for my photography portfolio",
    profession: "photographer",
    targetAudience: spec?.targetAudience ?? null,
    portfolio: { permission: "self", used: false, summary: [] },
    visualIdentity: { toneWords: spec?.toneWords ?? [], notes: [] },
    direction: spec?.direction ?? "",
    subject: { description: "The photographer at work", focalPoint: "The photographer's hands on the camera" },
    background: "A softly blurred studio environment",
    composition: { hierarchy: "Subject left, text zone right", textPlacement: "right", notes: [] },
    palette: spec?.palette ?? [],
    typography: spec?.typography ?? { items: [], notes: [] },
    canvas: { presetSlug: "bean-folio-banner", width: 2048, height: 687 },
    safeArea: { x: 143, y: 34, width: 1761, height: 618 },
    referenceMediaIds: [],
    preserve: [],
    avoid: ["harsh neon glow"],
    export: { format: "png", exactDimensions: true },
    revisions: spec?.revisions ?? [],
    source: "RIISHE",
    sourceTaskId: "temporary",
    createdAt: new Date().toISOString(),
  };
  const brief = designBriefSchema.parse(briefInput);
  const { taskId } = await persistStructuredBriefTask(
    { id: userId },
    brief,
    "Structured design brief (M36.7 QA fixture).",
    { url: "#/laxii", label: "Open LAXII banner studio" }
  );
  return { taskId, brief: designBriefSchema.parse({ ...briefInput, sourceTaskId: taskId }) };
}

async function makeConversation(userId: string, kind: "BANNER" | "IMAGE" = "BANNER") {
  return db.laxiiConversation.create({
    data: { userId, title: `M36.7 QA conversation ${RUN}`, kind },
  });
}

type JobSpec = {
  status?: "RUNNING" | "DONE" | "FAILED";
  operation?: string;
  error?: string | null;
  metaJson?: string | null;
};

async function makeJob(conversationId: string, spec: JobSpec = {}) {
  return db.laxiiMessage.create({
    data: {
      conversationId,
      role: "ASSISTANT",
      text: "",
      operation: spec.operation ?? "BANNER",
      status: spec.status ?? "DONE",
      error: spec.error ?? null,
      metaJson: spec.metaJson ?? null,
    },
  });
}

/** A REALISTIC stored pipeline quality report (the shape the worker persists). */
const STORED_REPORT = {
  overall: "warn",
  evaluator: "deterministic+ai-review",
  evaluatedAt: "2026-01-15T10:00:00.000Z",
  findings: [
    { id: "tech.decode", area: "technical", status: "pass", check: "Image decodes to a real, complete file", measured: "image/png, 123456 bytes" },
    { id: "vis.sharpness", area: "visual", status: "warn", check: "Perceived sharpness (Laplacian variance)", measured: "0.0032", note: "Render looks soft/blurry — try a refinement pass." },
    { id: "typ.ink-final", area: "typography", status: "fail", check: 'Text visibly present on the final image: "BEAN"', measured: "mean pixel change 0.0", note: "The text layer did not survive compositing — this attempt must not be trusted for text." },
  ],
  aiReview: {
    ran: true,
    findings: [{ area: "typography", severity: "major", note: "Headline overlaps the subject's face." }],
    note: "Advisory AI visual review — non-deterministic, may be wrong. Judge with your own eyes before exporting.",
  },
};

/** Metadata payload mimicking the worker's DONE write (with provider-internal fields). */
const DONE_META = JSON.stringify({
  aspect: "21:9",
  refs: [],
  warnings: [],
  estimatedCostUsd: 42,
  durationMs: 98765,
  interactionIds: ["provider-interaction-secret-1"],
  outputMediaIds: ["media-secret-1"],
  inputAssetIds: ["asset-secret-1"],
  briefTaskId: "brief-task-internal",
  qualityReport: STORED_REPORT,
  stage: "done",
});

function ctx(userId: string, workspace?: ToolContext["workspace"]): ToolContext {
  return { userId, workflowId: "qa-workflow", stepId: "qa-step", auditTraceId: `m367-${RUN}`, workspace };
}

async function execTool(
  tool: { inputSchema: { parse: (i: unknown) => unknown }; execute: (c: ToolContext, i: never) => Promise<Record<string, unknown>> },
  c: ToolContext,
  input: Record<string, unknown>
) {
  return tool.execute(c, tool.inputSchema.parse(input) as never);
}

const artTool = () => getTool("laxii.art.direction")!;

/** Snapshot of every LAXII/agent row type the tool must never touch. */
async function mutationSnapshot(userId: string, briefTaskId: string, messageId: string) {
  const task = await db.agentTask.findUnique({ where: { id: briefTaskId } });
  const msg = await db.laxiiMessage.findUnique({ where: { id: messageId } });
  return {
    agentTasks: await db.agentTask.count({ where: { userId } }),
    conversations: await db.laxiiConversation.count({ where: { userId } }),
    messages: await db.laxiiMessage.count({ where: { conversation: { userId } } }),
    versions: await db.laxiiImageVersion.count({ where: { conversation: { userId } } }),
    mediaAssets: await db.mediaAsset.count({ where: { ownerId: userId } }),
    usage: await db.laxiiUsage.count({ where: { userId } }),
    taskResultJson: task?.resultJson ?? null,
    taskStatus: task?.status ?? null,
    taskUpdatedAt: task?.updatedAt.getTime() ?? null,
    msgMetaJson: msg?.metaJson ?? null,
    msgStatus: msg?.status ?? null,
  };
}

beforeEach(() => {
  AI_CALLS.length = 0;
});

afterAll(async () => {
  for (const id of cleanupWorkflowIds) {
    await db.riisheWorkflowStep.deleteMany({ where: { workflowId: id } }).catch(() => undefined);
    await db.riisheWorkflow.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of cleanupUserIds) {
    await db.user.delete({ where: { id } }).catch(() => undefined);
  }
});

// =====================================================================================
// A. Registry and specialist
// =====================================================================================

describe("M36.7 registry contract — the 18th specialist over the ONE registry", () => {
  test("the specialist is registered with its stable id, display name and scopes", () => {
    const ad = getSpecialist("laxii-art-director");
    expect(ad).not.toBeNull();
    expect(ad!.name).toBe("LAXII Art Director");
    expect(ad!.available()).toBe(true);
    expect(specialistAllowsWorkspace(ad!, "PERSONAL")).toBe(true);
    expect(specialistAllowsWorkspace(ad!, "ORGANIZATION")).toBe(true);
    // Every referenced tool exists in the live registry.
    for (const t of ad!.toolNames) expect(getTool(t)).not.toBeNull();
    // The display-name record is registered for the UI.
    // (imported lazily to keep this block independent)
  });

  test("live counts derive to 18 specialists and 44 tools (no hard-coding in runtime)", () => {
    expect(SPECIALISTS.length).toBe(18);
    expect(Object.keys(RIISHE_TOOLS).length).toBe(44);
    // Every tool referenced by ANY specialist exists in the registry.
    for (const s of SPECIALISTS) {
      for (const t of s.toolNames) expect(getTool(t)).not.toBeNull();
    }
  });

  test("exactly one new tool is registered, with the honest read-only contract", () => {
    expect(Object.keys(LAXII_ART_DIRECTION_TOOLS)).toEqual(["laxii.art.direction"]);
    expect(Object.keys(RIISHE_TOOLS).filter((k) => k === "laxii.art.direction").length).toBe(1);
    const tool = artTool();
    expect(tool.risk).toBe("LOW");
    expect(tool.level).toBe(1);
    expect(tool.idempotent).toBe(true);
    expect(tool.verify).toBeUndefined(); // no fake verification hook
    expect(tool.undo).toBeNull(); // no persistence, no undo
    expect(tool.auditAction).toBe("riishe.tool.art_direction");
    expect(toolApprovalRequired(tool)).toBe(false); // LOW/level 1 stays approval-free
    // The laxii.* registry surface is exactly the three existing tools + the one new one.
    expect(Object.keys(RIISHE_TOOLS).filter((k) => k.startsWith("laxii.")).sort()).toEqual(
      ["laxii.art.direction", "laxii.banner.brief", "laxii.banner.produce", "laxii.job.status"].sort()
    );
  });

  test("the existing generation tool stays MEDIUM / level 2 with explicit approval; job status stays LOW / level 1", () => {
    const produce = getTool("laxii.banner.produce")!;
    expect(produce.risk).toBe("MEDIUM");
    expect(produce.level).toBe(2);
    expect(toolApprovalRequired(produce)).toBe(true);
    const status = getTool("laxii.job.status")!;
    expect(status.risk).toBe("LOW");
    expect(status.level).toBe(1);
    const brief = getTool("laxii.banner.brief")!;
    expect(brief.level).toBe(1);
    expect(brief.verify).not.toBeUndefined(); // existing durable-brief verify hook intact
  });

  test("the typed briefTaskRef / jobRef registry entries are unchanged (no duplicate reference key)", () => {
    expect(REF_FIELDS.has("briefTaskRef")).toBe(true);
    expect(REF_RESULT_KEYS["briefTaskRef"]).toBe("briefTaskId");
    expect(REF_FIELDS.has("jobRef")).toBe(true);
    expect(REF_RESULT_KEYS["jobRef"]).toBe("messageId");
    // The direct-id params are NOT reference keys.
    expect(REF_FIELDS.has("briefTaskId")).toBe(false);
    expect(REF_FIELDS.has("messageId")).toBe(false);
  });

  test("all seven directions are supported by the existing classifier", () => {
    expect(artDirections().length).toBe(7);
    const prompts: Record<string, string> = {
      "photorealistic-photography": "photorealistic portrait photography with natural light and depth of field",
      cinematic: "a cinematic film still key art poster with dramatic lighting",
      "commercial-advertising": "product photography packshot for an e-commerce catalog",
      "luxury-editorial": "a luxury editorial high-end scene with elegant negative space",
      "graphic-design": "graphic design layout with flat vector shapes and typography poster",
      "3d-render": "an isometric 3d blender render of a studio scene",
      "illustration-concept-art": "concept art illustration with watercolor painting style",
    };
    for (const d of artDirections()) {
      expect(detectArtDirection(prompts[d.id])?.id).toBe(d.id);
    }
  });

  test("specialist display names include the Art Director (UI identity honesty)", async () => {
    const { SPECIALIST_NAME_BY_ID } = await import("@/lib/riishe/specialists-ui");
    expect(SPECIALIST_NAME_BY_ID["laxii-art-director"]).toBe("LAXII Art Director");
  });
});

// =====================================================================================
// B. Direction and recommendations — real registries, honest limitations
// =====================================================================================

describe("M36.7 direction and recommendations — registry-backed, advisory only", () => {
  test("a resolved brief keeps the stored fields verbatim and recommends only real registered presets", async () => {
    const owner = await makeUser("Direction Owner");
    const { taskId } = await makeBriefTask(owner.id, {
      request: "A cinematic film still key art poster for my portfolio with dramatic lighting",
      palette: ["#1a1a2e", "#e94560", "#ffffff"],
      toneWords: ["premium", "elegant"],
      typography: { items: [{ text: "BEAN", role: "headline", font: "sans", fontId: "inter" }], notes: [] },
    });
    const result = (await execTool(artTool(), ctx(owner.id), { briefTaskId: taskId })) as Record<string, any>;
    expect(result.status).toBe("ART_DIRECTION");
    expect(result.source).toMatchObject({ kind: "brief", briefTaskId: taskId });
    // Direction resolved by the EXISTING classifier.
    expect(result.direction.resolved).toBe(true);
    expect(result.direction.id).toBe("cinematic");
    // Style recommendations: only real registered slugs, public metadata, explicit basis.
    expect(result.styleRecommendations.length).toBeGreaterThan(0);
    for (const rec of result.styleRecommendations) {
      expect(findStylePreset(rec.slug)).toBeDefined();
      expect(rec.basis).toContain("registered style preset");
      expect(typeof rec.label).toBe("string");
      // The server-side promptFragment never leaks into the response.
      expect(JSON.stringify(rec)).not.toContain("promptFragment");
      const preset = findStylePreset(rec.slug)!;
      expect(JSON.stringify(result)).not.toContain(preset.settings.composition.slice(0, 40));
    }
    // The brief's exact palette is preserved verbatim.
    expect(result.palette.provided).toBe(true);
    expect(result.palette.colors).toEqual(["#1a1a2e", "#e94560", "#ffffff"]);
    // Explicit user typography stays authoritative.
    expect(result.typographyRecommendation.userSelectedAuthoritative.items[0].fontId).toBe("inter");
    expect(result.typographyRecommendation.userSelectedAuthoritative.note).toContain("authoritative");
    // Composition evidence is the brief's own stored data.
    expect(result.compositionEvidence.canvas).toEqual({ presetSlug: "bean-folio-banner", width: 2048, height: 687 });
    expect(result.compositionEvidence.safeArea).toEqual({ x: 143, y: 34, width: 1761, height: 618 });
    expect(result.compositionEvidence.basis).toContain("verbatim");
    expect(AI_CALLS.length).toBe(0);
  });

  test("every recommended font id comes from the real provisioned-font recommender", async () => {
    const owner = await makeUser("Font Owner");
    const { taskId } = await makeBriefTask(owner.id, {
      toneWords: ["premium", "luxury"],
      targetAudience: "gallery clients",
    });
    const result = (await execTool(artTool(), ctx(owner.id), { briefTaskId: taskId })) as Record<string, any>;
    const rec = result.typographyRecommendation.recommendation;
    const provisionedIds = PROVISIONED_BANNER_FONTS.map((f) => f.fontId);
    expect(provisionedIds).toContain(rec.primary.headline.fontId);
    expect(provisionedIds).toContain(rec.primary.body.fontId);
    expect(provisionedIds).toContain(rec.alternate.headline.fontId);
    // Cross-check with the existing recommender for identical explicit inputs.
    const direct = recommendBannerFontPairing({ toneWords: ["premium", "luxury"], audience: "gallery clients" });
    expect(rec.primary.headline.fontId).toBe(direct.primary.headline.fontId);
    expect(rec.primary.body.fontId).toBe(direct.primary.body.fontId);
    // The rationale references the stated tone (no invention).
    expect(rec.primary.rationale).toContain("premium");
  });

  test("a weak/ambiguous request produces NO invented direction and NO style recommendation", async () => {
    const owner = await makeUser("Ambiguous Owner");
    const result = (await execTool(artTool(), ctx(owner.id), {
      request: "something clean and nice for my page",
    })) as Record<string, any>;
    expect(result.status).toBe("ART_DIRECTION");
    expect(result.source.kind).toBe("request");
    expect(result.direction.resolved).toBe(false);
    expect(result.direction.note).toContain("no confident art-direction signal");
    expect(result.direction.note).toContain("none was invented");
    expect(result.styleRecommendations).toEqual([]);
    expect(result.styleLimitation).toContain("never invented");
    expect(AI_CALLS.length).toBe(0);
  });

  test("an explicit request without palette or brief data reports the absence honestly", async () => {
    const owner = await makeUser("No-Palette Request Owner");
    const result = (await execTool(artTool(), ctx(owner.id), {
      request: "a cinematic wide shot of a mountain studio",
    })) as Record<string, any>;
    expect(result.palette.provided).toBe(false);
    expect(result.palette.note).toContain("none are invented");
    expect(result.compositionEvidence.note).toContain("laxii.banner.brief");
    expect(/#[0-9a-fA-F]{6}/.test(JSON.stringify(result))).toBe(false); // no invented hex anywhere
  });

  test("brand-kit rejections and warnings remain visible; unknown ids are never substituted", async () => {
    const owner = await makeUser("Brand Kit Owner");
    // Unknown explicit font id → the existing rejection shape, visible.
    const rejected = (await execTool(artTool(), ctx(owner.id), {
      request: "a premium editorial banner",
      toneWords: ["premium"],
      brandKitContext: { fontOverride: { heading: "not-a-real-font-id", body: "inter" } },
    })) as Record<string, any>;
    expect(rejected.brandKit.ok).toBe(false);
    expect(rejected.brandKit.rejection.field).toBe("fontOverride.heading");
    expect(rejected.brandKit.rejection.reason).toContain("never silently substitute");
    expect(rejected.brandKit.rejection.suggestions.length).toBeGreaterThan(0);
    expect(JSON.stringify(rejected.brandKit)).not.toContain('"not-a-real-font-id":'); // not substituted

    // Valid explicit attributes → the actual proposal with its assumptions/warnings.
    const ok = (await execTool(artTool(), ctx(owner.id), {
      request: "a premium editorial banner",
      toneWords: ["premium", "editorial"],
      brandKitContext: { sector: "photography", paletteDirection: "auto" },
    })) as Record<string, any>;
    expect(ok.brandKit.ok).toBe(true);
    expect(ok.brandKit.proposal.pairings.length).toBeGreaterThan(0);
    expect(Array.isArray(ok.brandKit.proposal.assumptions)).toBe(true);
    expect(ok.brandKit.proposal.assumptions.join(" ")).toContain("explicit attributes");
    expect(Array.isArray(ok.brandKit.proposal.warnings)).toBe(true);
    expect(ok.brandKit.basis).toContain("registry-backed proposal only");
    expect(AI_CALLS.length).toBe(0);
  });
});

// =====================================================================================
// C. Ownership — user-scoped in both workspace types; refs are pointers
// =====================================================================================

describe("M36.7 ownership — the same generic refusal for foreign and missing records", () => {
  test("an owner can advise from their own brief", async () => {
    const owner = await makeUser("Brief Owner");
    const { taskId } = await makeBriefTask(owner.id, {});
    const result = (await execTool(artTool(), ctx(owner.id), { briefTaskId: taskId })) as Record<string, any>;
    expect(result.status).toBe("ART_DIRECTION");
    expect(result.source.briefTaskId).toBe(taskId);
  });

  test("a foreign brief and a missing brief receive the SAME generic refusal (existence-hiding)", async () => {
    const owner = await makeUser("Foreign-Brief Owner");
    const attacker = await makeUser("Foreign-Brief Caller");
    const { taskId } = await makeBriefTask(owner.id, { request: "Secret cinematic banner wording" });

    const foreign = (await execTool(artTool(), ctx(attacker.id), { briefTaskId: taskId })) as Record<string, any>;
    const missing = (await execTool(artTool(), ctx(attacker.id), { briefTaskId: "cmnotarealbrief0000000" })) as Record<string, any>;
    expect(foreign.status).toBe("UNAUTHORIZED");
    expect(missing.status).toBe("UNAUTHORIZED");
    expect(foreign.reason).toBe(missing.reason);
    // Nothing about the foreign brief leaks.
    expect(JSON.stringify(foreign)).not.toContain(taskId);
    expect(JSON.stringify(foreign)).not.toContain("Secret cinematic");
    expect(AI_CALLS.length).toBe(0);
  });

  test("an owner's generation job can be reviewed; foreign and missing jobs receive the same refusal", async () => {
    const owner = await makeUser("Job Owner");
    const attacker = await makeUser("Job Attacker");
    const convo = await makeConversation(owner.id);
    const job = await makeJob(convo.id, { status: "DONE", metaJson: DONE_META });

    const own = (await execTool(artTool(), ctx(owner.id), { messageId: job.id })) as Record<string, any>;
    expect(own.status).toBe("JOB_REVIEW");

    const foreign = (await execTool(artTool(), ctx(attacker.id), { messageId: job.id })) as Record<string, any>;
    const missing = (await execTool(artTool(), ctx(attacker.id), { messageId: "cmnotarealjob00000000" })) as Record<string, any>;
    expect(foreign.status).toBe("UNAUTHORIZED");
    expect(missing.status).toBe("UNAUTHORIZED");
    expect(foreign.reason).toBe(missing.reason);
    expect(JSON.stringify(foreign)).not.toContain(job.id);
    expect(AI_CALLS.length).toBe(0);
  });

  test("ORGANIZATION workspace context never grants another member's private LAXII records", async () => {
    const memberA = await makeUser("Org Member A");
    const memberB = await makeUser("Org Member B");
    const { taskId } = await makeBriefTask(memberA.id, { request: "Member A private brief" });
    const convo = await makeConversation(memberA.id);
    const job = await makeJob(convo.id, { status: "DONE", metaJson: DONE_META });
    const orgCtx = { type: "ORGANIZATION" as const, organizationId: "cmdorgcontext000000000", membershipRole: "OWNER" as const };

    const briefResult = (await execTool(artTool(), ctx(memberB.id, orgCtx), { briefTaskId: taskId })) as Record<string, any>;
    const jobResult = (await execTool(artTool(), ctx(memberB.id, orgCtx), { messageId: job.id })) as Record<string, any>;
    expect(briefResult.status).toBe("UNAUTHORIZED");
    expect(jobResult.status).toBe("UNAUTHORIZED");
    expect(JSON.stringify(briefResult)).not.toContain("Member A private brief");
    // And the owner in the same workspace shape still gets their own records.
    const own = (await execTool(artTool(), ctx(memberA.id, orgCtx), { briefTaskId: taskId })) as Record<string, any>;
    expect(own.status).toBe("ART_DIRECTION");
  });

  test("typed briefTaskRef and jobRef remain pointers and are re-authorized at consumption", async () => {
    const owner = await makeUser("Ref Owner");
    const attacker = await makeUser("Ref Attacker");
    const { taskId } = await makeBriefTask(owner.id, {});
    const convo = await makeConversation(owner.id);
    const job = await makeJob(convo.id, { status: "DONE", metaJson: DONE_META });

    const ownBrief = (await execTool(artTool(), ctx(owner.id), { briefTaskRef: taskId })) as Record<string, any>;
    const ownJob = (await execTool(artTool(), ctx(owner.id), { jobRef: job.id })) as Record<string, any>;
    expect(ownBrief.status).toBe("ART_DIRECTION");
    expect(ownJob.status).toBe("JOB_REVIEW");

    const foreignBrief = (await execTool(artTool(), ctx(attacker.id), { briefTaskRef: taskId })) as Record<string, any>;
    const foreignJob = (await execTool(artTool(), ctx(attacker.id), { jobRef: job.id })) as Record<string, any>;
    expect(foreignBrief.status).toBe("UNAUTHORIZED");
    expect(foreignJob.status).toBe("UNAUTHORIZED");

    // Schema-level: exactly one source; brief+job combinations rejected; context fields bound to request.
    const schema = artTool().inputSchema;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ briefTaskId: taskId, messageId: job.id }).success).toBe(false);
    expect(schema.safeParse({ briefTaskId: taskId, request: "x" }).success).toBe(false);
    expect(schema.safeParse({ request: "x", toneWords: ["premium"] }).success).toBe(true);
    expect(schema.safeParse({ briefTaskId: taskId, toneWords: ["premium"] }).success).toBe(false);
    expect(schema.safeParse({ request: "x", brandKitContext: { sector: "s" } }).success).toBe(true);
    expect(schema.safeParse({ briefTaskId: taskId, proposedRevision: { area: "palette", instruction: "warmer" } }).success).toBe(true);
    expect(schema.safeParse({ request: "x", proposedRevision: { area: "palette", instruction: "warmer" } }).success).toBe(false);
  });

  test("briefTaskRef and jobRef flow through the M35.7 engine rules and are re-authorized at execution", async () => {
    const owner = await makeUser("Ref-Chain Owner");
    const { taskId } = await makeBriefTask(owner.id, {});
    const convo = await makeConversation(owner.id);
    const job = await makeJob(convo.id, { status: "DONE", metaJson: DONE_META });
    const wf = await createWorkflowFromPlan(
      owner.id,
      "advise from my brief and review my generation",
      {
        title: "M36.7 ref chain",
        steps: [
          { id: "s1", tool: "laxii.banner.brief", params: { request: "chain seed" } },
          { id: "s2", tool: "laxii.art.direction", params: { briefTaskRef: "s1" }, dependsOn: ["s1"] },
        ],
      },
      { autoStart: false, specialistId: "laxii-art-director" }
    );
    cleanupWorkflowIds.push(wf.id);
    const s1 = wf.steps.find((s) => s.ref === "s1")!;
    const s2 = wf.steps.find((s) => s.ref === "s2")!;

    // Unsuccessful producer → honest dependency-failed.
    await db.riisheWorkflowStep.update({ where: { id: s1.id }, data: { status: "FAILED" } });
    await expect(resolveStepParams(wf.id, s2)).rejects.toThrow(/has not completed successfully \(status: FAILED\)/);

    // The REAL producer result stamps the step; the resolved pointer is the task id.
    await db.riisheWorkflowStep.update({
      where: { id: s1.id },
      data: { status: "SUCCEEDED", resultJson: JSON.stringify({ briefTaskId: taskId }) },
    });
    const resolved = await resolveStepParams(wf.id, s2);
    expect(resolved.briefTaskRef).toBe(taskId);

    // The resolved pointer still gets ownership re-checked on execution.
    const result = (await execTool(artTool(), ctx(owner.id), { briefTaskRef: resolved.briefTaskRef as string })) as Record<string, any>;
    expect(result.status).toBe("ART_DIRECTION");
    // And a workflow owner cannot consume another user's brief through the ref either.
    const attacker = await makeUser("Ref-Chain Attacker");
    const foreign = (await execTool(artTool(), ctx(attacker.id), { briefTaskRef: taskId })) as Record<string, any>;
    expect(foreign.status).toBe("UNAUTHORIZED");
    void job;
  });
});

// =====================================================================================
// D. Quality review — the recorded report is the only admissible evidence
// =====================================================================================

describe("M36.7 quality review — recorded findings, honest gaps, no fabrication", () => {
  test("a DONE job with a stored report returns actual finding ids/statuses and existing refinement directives", async () => {
    const owner = await makeUser("Report Owner");
    const convo = await makeConversation(owner.id);
    const job = await makeJob(convo.id, { status: "DONE", metaJson: DONE_META });
    const result = (await execTool(artTool(), ctx(owner.id), { messageId: job.id })) as Record<string, any>;
    expect(result.status).toBe("JOB_REVIEW");
    expect(result.job).toMatchObject({ messageId: job.id, status: "DONE", operation: "BANNER" });
    expect(result.qualityEvidence.available).toBe(true);
    const findings = result.qualityEvidence.report.findings;
    expect(findings.map((f: { id: string }) => f.id)).toContain("tech.decode");
    expect(findings.map((f: { id: string }) => f.id)).toContain("vis.sharpness");
    expect(findings.map((f: { id: string }) => f.id)).toContain("typ.ink-final");
    const sharp = findings.find((f: { id: string }) => f.id === "vis.sharpness");
    expect(sharp.status).toBe("warn");
    const ink = findings.find((f: { id: string }) => f.id === "typ.ink-final");
    expect(ink.status).toBe("fail");
    // refinementDirectives() reflects the stored findings (existing mapping).
    expect(result.qualityEvidence.refinementDirectives).toContain(
      "Render with noticeably finer detail and crisper focus; avoid soft or muddy textures."
    );
    // AI-review findings remain explicitly advisory.
    expect(result.qualityEvidence.evaluatorNote).toContain("ADVISORY");
    expect(result.qualityEvidence.aiReviewNote).toContain("Advisory AI visual review");
    // Raw metadata and provider internals never leak.
    const raw = JSON.stringify(result);
    expect(raw).not.toContain("interactionIds");
    expect(raw).not.toContain("estimatedCostUsd");
    expect(raw).not.toContain("outputMediaIds");
    expect(raw).not.toContain("inputAssetIds");
    expect(raw).not.toContain("provider-interaction-secret-1");
    expect(raw).not.toContain("media-secret-1");
    expect(raw).not.toContain("metaJson");
    expect(AI_CALLS.length).toBe(0);
  });

  test("a RUNNING job never gets a fabricated quality verdict", async () => {
    const owner = await makeUser("Running Owner");
    const convo = await makeConversation(owner.id);
    const job = await makeJob(convo.id, {
      status: "RUNNING",
      metaJson: JSON.stringify({ pending: true, startedAt: new Date().toISOString() }),
    });
    const result = (await execTool(artTool(), ctx(owner.id), { messageId: job.id })) as Record<string, any>;
    expect(result.status).toBe("JOB_REVIEW");
    expect(result.job.status).toBe("RUNNING");
    expect(result.qualityEvidence.available).toBe(false);
    expect(result.qualityEvidence.reason).toContain("still RUNNING");
    expect(result.qualityEvidence.reason).toContain("never invents findings");
    expect(result.qualityEvidence.report).toBeUndefined();
    expect(AI_CALLS.length).toBe(0);
  });

  test("a FAILED job reports the recorded error and invents no findings", async () => {
    const owner = await makeUser("Failed Owner");
    const convo = await makeConversation(owner.id);
    const job = await makeJob(convo.id, { status: "FAILED", error: "The image provider returned an error (recorded)." });
    const result = (await execTool(artTool(), ctx(owner.id), { messageId: job.id })) as Record<string, any>;
    expect(result.status).toBe("JOB_REVIEW");
    expect(result.job.status).toBe("FAILED");
    expect(result.job.error).toContain("recorded");
    expect(result.qualityEvidence.available).toBe(false);
    expect(result.qualityEvidence.reason).toContain("FAILED");
    expect(result.qualityEvidence.reason).toContain("no quality verdict is invented");
    expect(result.qualityEvidence.report).toBeUndefined();
  });

  test("a DONE job without a readable report states that quality evidence is unavailable", async () => {
    const owner = await makeUser("No-Report Owner");
    const convo = await makeConversation(owner.id);
    const job = await makeJob(convo.id, { status: "DONE", metaJson: JSON.stringify({ aspect: "1:1", warnings: [] }) });
    const result = (await execTool(artTool(), ctx(owner.id), { messageId: job.id })) as Record<string, any>;
    expect(result.qualityEvidence.available).toBe(false);
    expect(result.qualityEvidence.reason).toContain("no structurally valid quality report");
    expect(result.qualityEvidence.reason).toContain("evidence is unavailable");
  });

  test("malformed metadata and malformed reports are refused — never guessed at", async () => {
    const owner = await makeUser("Malformed Owner");
    const convo = await makeConversation(owner.id);
    const badMeta = await makeJob(convo.id, { status: "DONE", metaJson: "{not-json-at-all" });
    const badReport = await makeJob(convo.id, {
      status: "DONE",
      metaJson: JSON.stringify({ qualityReport: { overall: "excellent", findings: "all good!" } }),
    });
    const r1 = (await execTool(artTool(), ctx(owner.id), { messageId: badMeta.id })) as Record<string, any>;
    const r2 = (await execTool(artTool(), ctx(owner.id), { messageId: badReport.id })) as Record<string, any>;
    expect(r1.qualityEvidence.available).toBe(false);
    expect(r1.qualityEvidence.reason).toContain("no structurally valid quality report");
    expect(r2.qualityEvidence.available).toBe(false);
    expect(r2.qualityEvidence.reason).toContain("no structurally valid quality report");
    // Neither response claims any overall verdict.
    expect(r1.qualityEvidence.report).toBeUndefined();
    expect(r2.qualityEvidence.report).toBeUndefined();
    expect(AI_CALLS.length).toBe(0);
  });
});

// =====================================================================================
// E. Revision preview — in-memory only, existing schema, existing limit
// =====================================================================================

describe("M36.7 revision preview — compiled in memory, never persisted", () => {
  test("appendRevision + compileRevisionAddenda produce a correctly scoped preview; the brief row is untouched", async () => {
    const owner = await makeUser("Preview Owner");
    const { taskId } = await makeBriefTask(owner.id, { palette: ["#112233", "#445566"] });
    const before = await db.agentTask.findUnique({ where: { id: taskId } });

    const result = (await execTool(artTool(), ctx(owner.id), {
      briefTaskId: taskId,
      proposedRevision: { area: "palette", instruction: "Shift the palette toward warmer dusk tones" },
    })) as Record<string, any>;

    expect(result.status).toBe("ART_DIRECTION");
    expect(result.revisionPreview.produced).toBe(true);
    expect(result.revisionPreview.preview).toBe(true);
    expect(result.revisionPreview.revision.area).toBe("palette");
    expect(result.revisionPreview.revision.instruction).toBe("Shift the palette toward warmer dusk tones");
    // The compiled addendum is correctly scoped to the named area only.
    expect(result.revisionPreview.compiledAddendum).toContain("COLOR PALETTE treatment only");
    expect(result.revisionPreview.compiledAddendum).toContain("Shift the palette toward warmer dusk tones");
    expect(result.revisionPreview.compiledAddendum).toContain("Everything not named above must stay");
    expect(result.revisionPreview.scopeNote).toContain("IN-MEMORY PREVIEW");
    expect(result.revisionPreview.scopeNote).toContain("explicit action in the existing LAXII workflow");
    // The persisted brief is byte-identical (resultJson, status, updatedAt).
    const after = await db.agentTask.findUnique({ where: { id: taskId } });
    expect(after!.resultJson).toBe(before!.resultJson);
    expect(after!.status).toBe(before!.status);
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    expect(AI_CALLS.length).toBe(0);
  });

  test("the third-revision limit is honoured honestly", async () => {
    const owner = await makeUser("Limit Owner");
    const rev = (area: "subject" | "palette" | "overall", instruction: string) => ({
      area,
      instruction,
      at: new Date().toISOString(),
    });
    const { taskId } = await makeBriefTask(owner.id, {
      revisions: [rev("subject", "first"), rev("palette", "second"), rev("overall", "third")],
    });
    const before = await db.agentTask.findUnique({ where: { id: taskId } });
    const result = (await execTool(artTool(), ctx(owner.id), {
      briefTaskId: taskId,
      proposedRevision: { area: "composition", instruction: "a fourth revision" },
    })) as Record<string, any>;
    expect(result.revisionPreview.produced).toBe(false);
    expect(result.revisionPreview.reason).toContain("maximum of 3 targeted revisions");
    expect(result.revisionPreview.reason).toContain("existing LAXII workflow");
    // Still nothing persisted.
    const after = await db.agentTask.findUnique({ where: { id: taskId } });
    expect(after!.resultJson).toBe(before!.resultJson);
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });
});

// =====================================================================================
// F. Zero effects — no AI, no spending, no writes, on EVERY path
// =====================================================================================

describe("M36.7 zero effects — nothing is generated, spent, written or built", () => {
  test("successful paths mutate nothing and call no gateway", async () => {
    const owner = await makeUser("Zero-Write Owner");
    const { taskId } = await makeBriefTask(owner.id, {});
    const convo = await makeConversation(owner.id);
    const job = await makeJob(convo.id, { status: "DONE", metaJson: DONE_META });
    const before = await mutationSnapshot(owner.id, taskId, job.id);

    await execTool(artTool(), ctx(owner.id), { briefTaskId: taskId, proposedRevision: { area: "overall", instruction: "calmer" } });
    await execTool(artTool(), ctx(owner.id), { messageId: job.id });
    await execTool(artTool(), ctx(owner.id), { request: "a cinematic product hero shot" });

    const after = await mutationSnapshot(owner.id, taskId, job.id);
    expect(after.agentTasks).toBe(before.agentTasks);
    expect(after.conversations).toBe(before.conversations);
    expect(after.messages).toBe(before.messages);
    expect(after.versions).toBe(before.versions);
    expect(after.mediaAssets).toBe(before.mediaAssets);
    expect(after.usage).toBe(before.usage); // no image spending, no cost rows
    expect(after.taskResultJson).toBe(before.taskResultJson);
    expect(after.taskStatus).toBe(before.taskStatus);
    expect(after.taskUpdatedAt).toBe(before.taskUpdatedAt);
    expect(after.msgMetaJson).toBe(before.msgMetaJson);
    expect(after.msgStatus).toBe(before.msgStatus);
    expect(AI_CALLS.length).toBe(0);
  });

  test("refusal paths mutate nothing and call no gateway", async () => {
    const owner = await makeUser("Refusal Zero Owner");
    const attacker = await makeUser("Refusal Zero Attacker");
    const { taskId } = await makeBriefTask(owner.id, {});
    const convo = await makeConversation(owner.id);
    const job = await makeJob(convo.id, { status: "DONE", metaJson: DONE_META });
    const before = await mutationSnapshot(owner.id, taskId, job.id);

    const r1 = (await execTool(artTool(), ctx(attacker.id), { briefTaskId: taskId })) as Record<string, any>;
    const r2 = (await execTool(artTool(), ctx(attacker.id), { messageId: job.id })) as Record<string, any>;
    expect(r1.status).toBe("UNAUTHORIZED");
    expect(r2.status).toBe("UNAUTHORIZED");

    const after = await mutationSnapshot(owner.id, taskId, job.id);
    expect(after.agentTasks).toBe(before.agentTasks);
    expect(after.conversations).toBe(before.conversations);
    expect(after.messages).toBe(before.messages);
    expect(after.taskUpdatedAt).toBe(before.taskUpdatedAt);
    expect(after.msgStatus).toBe(before.msgStatus);
    expect(AI_CALLS.length).toBe(0);
  });
});

// =====================================================================================
// G. Routing and preservation
// =====================================================================================

describe("M36.7 routing — Art Director owns its language; nothing else is stolen", () => {
  test("art-direction, style and typography language routes to the LAXII Art Director", () => {
    expect(classifySpecialist("recommend an art direction for my banner")?.id).toBe("laxii-art-director");
    expect(classifySpecialist("what style preset fits a cinematic look")?.id).toBe("laxii-art-director");
    expect(classifySpecialist("I need a typography recommendation for my banner")?.id).toBe("laxii-art-director");
    expect(classifySpecialist("suggest a font pairing for a luxury editorial cover")?.id).toBe("laxii-art-director");
    expect(classifySpecialist("review my banner generation cmd1234567890abcdefgh")?.id).toBe("laxii-art-director");
    // Both workspace scopes.
    expect(classifySpecialist("advise on the visual direction for our campaign banner", "ORGANIZATION")?.id).toBe("laxii-art-director");
    expect(classifySpecialist("advise on the visual direction for my banner", "PERSONAL")?.id).toBe("laxii-art-director");
  });

  test("banner production and cross-studio chains stay with Creative Producer; career language stays with Career Guide", () => {
    expect(classifySpecialist("produce the banner for my channel", "PERSONAL")?.id).toBe("creative-producer");
    expect(classifySpecialist("prepare a banner design brief for my channel art", "PERSONAL")?.id).toBe("creative-producer");
    expect(classifySpecialist("plan my website and produce the banner for it", "PERSONAL")?.id).toBe("creative-producer");
    // Generic career/resume analysis is not stolen.
    expect(classifySpecialist("help me prepare for interviews")?.id).toBe("career-guide");
    expect(classifySpecialist("analyze my resume")?.id).toBe("career-guide");
  });

  test("M36.6 GIFTZ routing is unchanged; the M36.7 planner clause plans honest steps only", () => {
    // GIFTZ audit + architecture language keep their owners.
    expect(classifySpecialist("run a quality report for my site")?.id).toBe("giftz-quality-auditor");
    expect(classifySpecialist("plan the website architecture for my portfolio")?.id).toBe("giftz-product-architect");
    const auditPlan = planDeterministically("run a quality audit on site cmd1234567890abcdefgh");
    expect(auditPlan!.steps.some((s) => s.tool === "giftz.quality.report")).toBe(true);
    expect(auditPlan!.steps.some((s) => s.tool === "laxii.art.direction")).toBe(false);

    // Direction language plans an explicit-request step (the user's own words, bounded).
    const directionPlan = planDeterministically("recommend an art direction for a cinematic product hero shot");
    expect(directionPlan).not.toBeNull();
    const step = directionPlan!.steps.find((s) => s.tool === "laxii.art.direction");
    expect(step).toBeDefined();
    expect((step!.params as { request: string }).request).toContain("cinematic product hero shot");

    // Review language plans a step ONLY with an explicit identifier.
    const reviewPlan = planDeterministically("review my banner job cmd1234567890abcdefgh");
    const reviewStep = reviewPlan!.steps.find((s) => s.tool === "laxii.art.direction");
    expect(reviewStep).toBeDefined();
    expect((reviewStep!.params as { messageId: string }).messageId).toBe("cmd1234567890abcdefgh");
    // Review language WITHOUT an identifier produces no step (never the newest record).
    expect(planDeterministically("review my banner")).toBeNull();
  });

  test("existing LAXII banner tool contracts and the M36.6 GIFTZ behavior are untouched", () => {
    // Creative Producer keeps its exact tool set (no art-direction tool added to it).
    const cp = getSpecialist("creative-producer")!;
    expect(cp.toolNames.sort()).toEqual(
      ["giftz.site.plan", "giftz.site.create", "giftz.task.create", "giftz.task.status", "giftz.task.approve", "laxii.banner.brief", "laxii.banner.produce", "laxii.job.status"].sort()
    );
    // The Art Director owns exactly its four tools.
    const ad = getSpecialist("laxii-art-director")!;
    expect(ad.toolNames.sort()).toEqual(
      ["laxii.art.direction", "laxii.banner.brief", "laxii.banner.produce", "laxii.job.status"].sort()
    );
    // M36.6 GIFTZ specialists keep their contracts.
    const qa = getSpecialist("giftz-quality-auditor")!;
    expect(qa.available()).toBe(true);
    expect(getTool("giftz.quality.report")!.risk).toBe("LOW");
    expect(getTool("giftz.quality.report")!.level).toBe(1);
    expect(getTool("giftz.quality.report")!.undo).toBeNull();
    const pa = getSpecialist("giftz-product-architect")!;
    expect(pa.available()).toBe(true);
    expect(specialistAllowsWorkspace(pa, "ORGANIZATION")).toBe(true);
    // OX/workforce tools keep their registry contracts.
    expect(getTool("ox.invitation.prepare")!.level).toBe(1);
    expect(getTool("ox.room.brief")!.undo).toBeNull();
    expect(specialistAllowsWorkspace(getSpecialist("candidate-relations")!, "PERSONAL")).toBe(false);
    expect(specialistAllowsWorkspace(getSpecialist("people-finder")!, "ORGANIZATION")).toBe(false);
  });

  test("the avatar identity-lock flow is still NOT a registered tool", () => {
    for (const name of Object.keys(RIISHE_TOOLS)) {
      expect(name.includes("avatar")).toBe(false);
    }
    // And the style registry's public projection still hides the server-side fragment.
    const pub = STYLE_PRESETS.map(({ promptFragment: _f, ...rest }) => rest);
    expect(pub.length).toBe(STYLE_PRESETS.length);
    expect(JSON.stringify(pub)).not.toContain("promptFragment");
  });
});
