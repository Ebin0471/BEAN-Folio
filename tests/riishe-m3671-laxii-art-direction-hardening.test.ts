/// <reference types="bun-types" />
/**
 * M36.7.1 — LAXII Art Direction Security Hardening (two targeted defensive
 * fixes over the EXISTING M36.7 implementation; no redesign, no expansion).
 *
 * Isolated QA database (qa-db-env.sh guard). The AI gateway is module-mocked
 * with a recording SPY so every path is proven to make zero gateway calls.
 *
 * Fix A — stored quality reports are ALLOWLIST-REBUILT at every nesting level.
 *   The stored `qualityReport` validation previously checked required fields
 *   but returned the RAW stored object, so unexpected properties at the
 *   top level, inside a finding, or inside the optional `aiReview` block (and
 *   its findings) could survive validation and enter the tool response.
 *   Pinned here: hostile extras planted at all three nesting levels are
 *   ABSENT from the final tool result; legitimate report data (findings,
 *   measured values, notes, aiReview advisory semantics, refinement
 *   directives) remains available field-for-field; valid reports reconstruct
 *   exactly (key sets pinned); malformed reports remain honestly refused —
 *   no verdict is invented.
 *
 * Fix B — only an ASSISTANT-generated LAXII job is reviewable.
 *   The owner-scoped message lookup now enforces the SAME `role: "ASSISTANT"`
 *   constraint the existing LAXII job lookups use (src/lib/laxii/service.ts),
 *   so a user's own USER/SYSTEM message can never be interpreted as a
 *   completed generation job even if its metadata carries a plausible
 *   quality report. Pinned here: an owned assistant job stays reviewable;
 *   an owned USER-role message (and a SYSTEM-role message) is refused with
 *   the ONE generic refusal; foreign/missing jobs remain inaccessible with
 *   the same refusal; RUNNING and FAILED assistant jobs retain their existing
 *   honest no-fabrication behavior; ownership is never weakened.
 *
 * Run: bun test tests/riishe-m3671-laxii-art-direction-hardening.test.ts   (isolated QA DB)
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
import { getTool } from "@/lib/riishe/tools";
import type { ToolContext } from "@/lib/riishe/tool-contracts";

const RUN = randomUUID().slice(0, 8);
const cleanupUserIds: string[] = [];

async function makeUser(name: string) {
  const u = await db.user.create({
    data: {
      email: `m3671-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("laxii-password-1"),
      name,
      username: `m3671-${randomUUID().slice(0, 10)}`,
      onboarded: true,
    },
  });
  cleanupUserIds.push(u.id);
  return u;
}

async function makeConversation(userId: string, kind: "BANNER" | "IMAGE" = "BANNER") {
  return db.laxiiConversation.create({
    data: { userId, title: `M36.7.1 QA conversation ${RUN}`, kind },
  });
}

type MessageSpec = {
  role?: "USER" | "ASSISTANT" | "SYSTEM";
  status?: "RUNNING" | "DONE" | "FAILED";
  operation?: string;
  error?: string | null;
  metaJson?: string | null;
};

async function makeMessage(conversationId: string, spec: MessageSpec = {}) {
  return db.laxiiMessage.create({
    data: {
      conversationId,
      role: spec.role ?? "ASSISTANT",
      text: "",
      operation: spec.operation ?? "BANNER",
      status: spec.status ?? "DONE",
      error: spec.error ?? null,
      metaJson: spec.metaJson ?? null,
    },
  });
}

function ctx(userId: string, workspace?: ToolContext["workspace"]): ToolContext {
  return { userId, workflowId: "qa-workflow", stepId: "qa-step", auditTraceId: `m3671-${RUN}`, workspace };
}

async function execTool(
  tool: { inputSchema: { parse: (i: unknown) => unknown }; execute: (c: ToolContext, i: never) => Promise<Record<string, unknown>> },
  c: ToolContext,
  input: Record<string, unknown>
) {
  return tool.execute(c, tool.inputSchema.parse(input) as never);
}

const artTool = () => getTool("laxii.art.direction")!;

const OWNERSHIP_REFUSAL =
  "No accessible LAXII record exists for this request — nothing was analyzed.";

/** A legitimate stored pipeline quality report (the shape the worker persists). */
const CLEAN_REPORT = {
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

const DONE_META_CLEAN = JSON.stringify({ aspect: "21:9", refs: [], warnings: [], qualityReport: CLEAN_REPORT, stage: "done" });

beforeEach(() => {
  AI_CALLS.length = 0;
});

afterAll(async () => {
  for (const id of cleanupUserIds) {
    await db.user.delete({ where: { id } }).catch(() => undefined);
  }
});

// =====================================================================================
// Fix A — the stored quality report is allowlist-rebuilt at every nesting level
// =====================================================================================

describe("M36.7.1 Fix A — stored quality-report output is allowlisted at every nesting level", () => {
  test("hostile TOP-LEVEL extras in the stored report never reach the tool result; legitimate data survives", async () => {
    const owner = await makeUser("FixA Top-Level Owner");
    const convo = await makeConversation(owner.id);
    const hostileReport: Record<string, unknown> = {
      ...CLEAN_REPORT,
      // Malicious / unexpected extra properties at the TOP level of the report.
      providerRequestId: "prov-req-secret-42",
      internalDebugPrompt: "SYSTEM PROMPT — never ship this",
      interactionSecret: "interaction-secret-top",
      estimatedCostUsd: 999,
    };
    // The realistic stored-metadata attack: hostile JSON parsed by the tool
    // creates an OWN enumerable "__proto__" property (JSON.parse does not
    // trigger the object-literal prototype setter).
    Object.defineProperty(hostileReport, "__proto__", {
      value: { polluted: true }, enumerable: true, configurable: true, writable: true,
    });
    const job = await makeMessage(convo.id, { status: "DONE", metaJson: JSON.stringify({ qualityReport: hostileReport }) });

    const result = (await execTool(artTool(), ctx(owner.id), { messageId: job.id })) as Record<string, any>;
    expect(result.status).toBe("JOB_REVIEW");
    expect(result.qualityEvidence.available).toBe(true);

    // Legitimate report data remains available.
    const report = result.qualityEvidence.report;
    expect(report.overall).toBe("warn");
    expect(report.evaluator).toBe("deterministic+ai-review");
    expect(report.evaluatedAt).toBe("2026-01-15T10:00:00.000Z");
    expect(report.findings.map((f: { id: string }) => f.id)).toEqual(["tech.decode", "vis.sharpness", "typ.ink-final"]);
    expect(result.qualityEvidence.refinementDirectives).toContain(
      "Render with noticeably finer detail and crisper focus; avoid soft or muddy textures."
    );
    expect(result.qualityEvidence.aiReviewNote).toContain("Advisory AI visual review");

    // Every unapproved top-level property is absent from the final result.
    const raw = JSON.stringify(result);
    expect(raw).not.toContain("providerRequestId");
    expect(raw).not.toContain("prov-req-secret-42");
    expect(raw).not.toContain("internalDebugPrompt");
    expect(raw).not.toContain("SYSTEM PROMPT — never ship this");
    expect(raw).not.toContain("interactionSecret");
    expect(raw).not.toContain("interaction-secret-top");
    expect(raw).not.toContain("estimatedCostUsd");
    expect(raw).not.toContain("polluted");

    // The rebuilt report carries EXACTLY the approved top-level keys.
    expect(Object.keys(report).sort()).toEqual(["aiReview", "evaluatedAt", "evaluator", "findings", "overall"]);
    expect(AI_CALLS.length).toBe(0);
  });

  test("hostile extras inside a nested FINDING are dropped; the finding's legitimate fields survive", async () => {
    const owner = await makeUser("FixA Finding Owner");
    const convo = await makeConversation(owner.id);
    const hostileReport = {
      overall: "fail",
      evaluator: "deterministic",
      evaluatedAt: "2026-01-16T09:30:00.000Z",
      findings: [
        {
          id: "vis.contrast",
          area: "visual",
          status: "fail",
          check: "Subject/background tonal separation",
          measured: "laplacian 0.41",
          note: "Flat, washed-out composition.",
          // Malicious extras INSIDE the finding object.
          promptFragment: "you are a secret system prompt",
          providerMeta: { model: "internal-model", traceId: "trace-secret" },
          escalationHint: "rerun with elevated provider budget",
        },
        {
          id: "tech.readable",
          area: "technical",
          status: "pass",
          check: "Full pixel read-back (corrupt/incomplete output rejected)",
          // No measured/note — optional fields legitimately absent, and no
          // reconstructed phantom keys may appear for them.
          smuggled: "unexpected-property-on-clean-finding",
        },
      ],
    };
    const job = await makeMessage(convo.id, { status: "DONE", metaJson: JSON.stringify({ qualityReport: hostileReport }) });

    const result = (await execTool(artTool(), ctx(owner.id), { messageId: job.id })) as Record<string, any>;
    expect(result.status).toBe("JOB_REVIEW");
    expect(result.qualityEvidence.available).toBe(true);
    const findings = result.qualityEvidence.report.findings;
    expect(findings).toHaveLength(2);

    const contrast = findings.find((f: { id: string }) => f.id === "vis.contrast");
    // Legitimate finding fields survive field-for-field.
    expect(contrast.area).toBe("visual");
    expect(contrast.status).toBe("fail");
    expect(contrast.check).toBe("Subject/background tonal separation");
    expect(contrast.measured).toBe("laplacian 0.41");
    expect(contrast.note).toBe("Flat, washed-out composition.");
    // The refinement mapping still sees the reconstructed finding.
    expect(result.qualityEvidence.refinementDirectives).toContain(
      "Increase tonal separation between subject and background; avoid a flat, washed-out look."
    );

    const readable = findings.find((f: { id: string }) => f.id === "tech.readable");
    expect(readable.status).toBe("pass");
    expect("measured" in readable).toBe(false);
    expect("note" in readable).toBe(false);

    // Unapproved properties are absent everywhere in the final result, and
    // each reconstructed finding carries EXACTLY its approved keys.
    const raw = JSON.stringify(result);
    expect(raw).not.toContain("promptFragment");
    expect(raw).not.toContain("you are a secret system prompt");
    expect(raw).not.toContain("providerMeta");
    expect(raw).not.toContain("trace-secret");
    expect(raw).not.toContain("escalationHint");
    expect(raw).not.toContain("smuggled");
    // Each reconstructed finding carries EXACTLY its approved keys.
    expect(Object.keys(contrast).sort()).toEqual(["area", "check", "id", "measured", "note", "status"]);
    expect(Object.keys(readable).sort()).toEqual(["area", "check", "id", "status"]);
    expect(AI_CALLS.length).toBe(0);
  });

  test("hostile extras inside the nested aiReview block (and its findings) are dropped; advisory semantics preserved", async () => {
    const owner = await makeUser("FixA AiReview Owner");
    const convo = await makeConversation(owner.id);
    const hostileReport = {
      overall: "warn",
      evaluator: "deterministic+ai-review",
      evaluatedAt: "2026-01-17T11:11:11.111Z",
      findings: [
        { id: "typ.contrast", area: "typography", status: "warn", check: "Contrast behind the text block", measured: "0.22", note: "Region behind text is busy." },
      ],
      aiReview: {
        ran: true,
        findings: [
          { area: "composition", severity: "minor", note: "Logo crowds the lower safe-area edge.", providerModel: "secret-internal-vision-model", rawScore: 0.987 },
        ],
        note: "Advisory AI visual review — non-deterministic, may be wrong. Judge with your own eyes before exporting.",
        // Malicious extras INSIDE the aiReview object.
        internalVisionTrace: "vision-trace-secret",
        usage: { tokens: 4242, costUsd: 0.42 },
        followUpAction: "auto-schedule a regeneration",
      },
    };
    const job = await makeMessage(convo.id, { status: "DONE", metaJson: JSON.stringify({ qualityReport: hostileReport }) });

    const result = (await execTool(artTool(), ctx(owner.id), { messageId: job.id })) as Record<string, any>;
    expect(result.status).toBe("JOB_REVIEW");
    expect(result.qualityEvidence.available).toBe(true);

    // Legitimate aiReview data and the advisory semantics survive.
    const ai = result.qualityEvidence.report.aiReview;
    expect(ai.ran).toBe(true);
    expect(ai.note).toContain("Advisory AI visual review");
    expect(ai.findings).toHaveLength(1);
    expect(ai.findings[0].area).toBe("composition");
    expect(ai.findings[0].severity).toBe("minor");
    expect(ai.findings[0].note).toContain("safe-area edge");
    expect(result.qualityEvidence.aiReviewNote).toContain("Advisory AI visual review");
    expect(result.qualityEvidence.evaluatorNote).toContain("ADVISORY");

    // Unapproved aiReview properties (and finding extras) are absent.
    const raw = JSON.stringify(result);
    expect(raw).not.toContain("internalVisionTrace");
    expect(raw).not.toContain("vision-trace-secret");
    expect(raw).not.toContain("usage");
    expect(raw).not.toContain("followUpAction");
    expect(raw).not.toContain("auto-schedule");
    expect(raw).not.toContain("providerModel");
    expect(raw).not.toContain("secret-internal-vision-model");
    expect(raw).not.toContain("rawScore");
    // Rebuilt aiReview carries EXACTLY the approved keys.
    expect(Object.keys(ai).sort()).toEqual(["findings", "note", "ran"]);
    expect(Object.keys(ai.findings[0]).sort()).toEqual(["area", "note", "severity"]);
    expect(AI_CALLS.length).toBe(0);
  });

  test("a valid report WITHOUT aiReview reconstructs exactly — no phantom keys, honest evaluator note", async () => {
    const owner = await makeUser("FixA Deterministic Owner");
    const convo = await makeConversation(owner.id);
    const cleanDeterministic = {
      overall: "pass",
      evaluator: "deterministic",
      evaluatedAt: "2026-01-18T08:00:00.000Z",
      findings: [
        { id: "tech.decode", area: "technical", status: "pass", check: "Image decodes to a real, complete file", measured: "image/png, 2048 bytes" },
      ],
    };
    const job = await makeMessage(convo.id, { status: "DONE", metaJson: JSON.stringify({ qualityReport: cleanDeterministic }) });

    const result = (await execTool(artTool(), ctx(owner.id), { messageId: job.id })) as Record<string, any>;
    expect(result.qualityEvidence.available).toBe(true);
    const report = result.qualityEvidence.report;
    expect(Object.keys(report).sort()).toEqual(["evaluatedAt", "evaluator", "findings", "overall"]);
    expect("aiReview" in report).toBe(false);
    expect(result.qualityEvidence.aiReviewNote).toBeNull();
    expect(result.qualityEvidence.evaluatorNote).toContain("deterministic measurements only");
    expect(result.qualityEvidence.refinementDirectivesNote).toContain("No failed or warning findings were recorded");
    expect(AI_CALLS.length).toBe(0);
  });

  test("malformed stored reports remain refused — the honest unavailability path is unchanged", async () => {
    const owner = await makeUser("FixA Malformed Owner");
    const convo = await makeConversation(owner.id);
    const badMeta = await makeMessage(convo.id, { status: "DONE", metaJson: "{broken-json" });
    const badReport = await makeMessage(convo.id, {
      status: "DONE",
      metaJson: JSON.stringify({ qualityReport: { overall: "excellent", findings: "all good!", smuggledTop: "x" } }),
    });
    const badFinding = await makeMessage(convo.id, {
      status: "DONE",
      metaJson: JSON.stringify({
        qualityReport: {
          overall: "pass",
          evaluator: "deterministic",
          evaluatedAt: "2026-01-19T00:00:00.000Z",
          findings: [{ id: "tech.decode", area: "not-a-real-area", status: "pass", check: "x" }],
        },
      }),
    });
    for (const job of [badMeta, badReport, badFinding]) {
      const result = (await execTool(artTool(), ctx(owner.id), { messageId: job.id })) as Record<string, any>;
      expect(result.status).toBe("JOB_REVIEW");
      expect(result.qualityEvidence.available).toBe(false);
      expect(result.qualityEvidence.reason).toContain("no structurally valid quality report");
      expect(result.qualityEvidence.reason).toContain("no verdict is inferred");
      expect(result.qualityEvidence.report).toBeUndefined();
    }
    expect(AI_CALLS.length).toBe(0);
  });
});

// =====================================================================================
// Fix B — only an ASSISTANT-generated LAXII job is reviewable
// =====================================================================================

describe("M36.7.1 Fix B — only assistant-generated LAXII jobs are reviewable", () => {
  test("an owned ASSISTANT-generated job remains reviewable with its stored report", async () => {
    const owner = await makeUser("FixB Assistant Owner");
    const convo = await makeConversation(owner.id);
    const job = await makeMessage(convo.id, { role: "ASSISTANT", status: "DONE", metaJson: DONE_META_CLEAN });
    const result = (await execTool(artTool(), ctx(owner.id), { messageId: job.id })) as Record<string, any>;
    expect(result.status).toBe("JOB_REVIEW");
    expect(result.job).toMatchObject({ messageId: job.id, status: "DONE", operation: "BANNER" });
    expect(result.qualityEvidence.available).toBe(true);
    expect(result.qualityEvidence.report.findings.map((f: { id: string }) => f.id)).toContain("vis.sharpness");
    expect(AI_CALLS.length).toBe(0);
  });

  test("an owned USER-role message is rejected — even when its metadata carries a plausible quality report", async () => {
    const owner = await makeUser("FixB User-Role Owner");
    const convo = await makeConversation(owner.id);
    // A user's own message row: never a generation job, no matter what its
    // metadata happens to contain.
    const userMsg = await makeMessage(convo.id, {
      role: "USER",
      status: "DONE",
      metaJson: JSON.stringify({ qualityReport: CLEAN_REPORT, stage: "done" }),
    });
    const result = (await execTool(artTool(), ctx(owner.id), { messageId: userMsg.id })) as Record<string, any>;
    expect(result.status).toBe("UNAUTHORIZED");
    expect(result.reason).toBe(OWNERSHIP_REFUSAL);
    // No job view, no report, no metadata echo — nothing was interpreted.
    expect(result.job).toBeUndefined();
    expect(result.qualityEvidence).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("vis.sharpness");
    expect(JSON.stringify(result)).not.toContain("Advisory AI visual review");
    expect(AI_CALLS.length).toBe(0);
  });

  test("an owned SYSTEM-role message is rejected the same way", async () => {
    const owner = await makeUser("FixB System-Role Owner");
    const convo = await makeConversation(owner.id);
    const sysMsg = await makeMessage(convo.id, {
      role: "SYSTEM",
      status: "DONE",
      metaJson: JSON.stringify({ qualityReport: CLEAN_REPORT, stage: "done" }),
    });
    const result = (await execTool(artTool(), ctx(owner.id), { messageId: sysMsg.id })) as Record<string, any>;
    expect(result.status).toBe("UNAUTHORIZED");
    expect(result.reason).toBe(OWNERSHIP_REFUSAL);
    expect(result.qualityEvidence).toBeUndefined();
    expect(AI_CALLS.length).toBe(0);
  });

  test("inaccessible and unowned messages remain inaccessible with the SAME generic refusal", async () => {
    const owner = await makeUser("FixB Foreign-Job Owner");
    const attacker = await makeUser("FixB Foreign Caller");
    const convo = await makeConversation(owner.id);
    const job = await makeMessage(convo.id, { role: "ASSISTANT", status: "DONE", metaJson: DONE_META_CLEAN });

    const foreign = (await execTool(artTool(), ctx(attacker.id), { messageId: job.id })) as Record<string, any>;
    const missing = (await execTool(artTool(), ctx(attacker.id), { messageId: "cmnotarealm3671job0000" })) as Record<string, any>;
    expect(foreign.status).toBe("UNAUTHORIZED");
    expect(missing.status).toBe("UNAUTHORIZED");
    expect(foreign.reason).toBe(missing.reason);
    expect(foreign.reason).toBe(OWNERSHIP_REFUSAL);
    // Nothing about the foreign job leaks.
    expect(JSON.stringify(foreign)).not.toContain(job.id);
    expect(JSON.stringify(foreign)).not.toContain("vis.sharpness");
    expect(AI_CALLS.length).toBe(0);
  });

  test("a RUNNING assistant job retains its honest no-verdict behavior", async () => {
    const owner = await makeUser("FixB Running Owner");
    const convo = await makeConversation(owner.id);
    const job = await makeMessage(convo.id, {
      role: "ASSISTANT",
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

  test("a FAILED assistant job retains its honest recorded-error behavior", async () => {
    const owner = await makeUser("FixB Failed Owner");
    const convo = await makeConversation(owner.id);
    const job = await makeMessage(convo.id, {
      role: "ASSISTANT",
      status: "FAILED",
      error: "The image provider returned an error (recorded).",
    });
    const result = (await execTool(artTool(), ctx(owner.id), { messageId: job.id })) as Record<string, any>;
    expect(result.status).toBe("JOB_REVIEW");
    expect(result.job.status).toBe("FAILED");
    expect(result.job.error).toContain("recorded");
    expect(result.qualityEvidence.available).toBe(false);
    expect(result.qualityEvidence.reason).toContain("FAILED");
    expect(result.qualityEvidence.reason).toContain("no quality verdict is invented");
    expect(result.qualityEvidence.report).toBeUndefined();
    expect(AI_CALLS.length).toBe(0);
  });

  test("jobRef typed-reference flow honors the same assistant-only rule", async () => {
    const owner = await makeUser("FixB JobRef Owner");
    const convo = await makeConversation(owner.id);
    const job = await makeMessage(convo.id, { role: "ASSISTANT", status: "DONE", metaJson: DONE_META_CLEAN });
    const userMsg = await makeMessage(convo.id, { role: "USER", status: "DONE", metaJson: JSON.stringify({ qualityReport: CLEAN_REPORT }) });

    const viaJobRef = (await execTool(artTool(), ctx(owner.id), { jobRef: job.id })) as Record<string, any>;
    expect(viaJobRef.status).toBe("JOB_REVIEW");
    const userViaJobRef = (await execTool(artTool(), ctx(owner.id), { jobRef: userMsg.id })) as Record<string, any>;
    expect(userViaJobRef.status).toBe("UNAUTHORIZED");
    expect(userViaJobRef.reason).toBe(OWNERSHIP_REFUSAL);
    expect(AI_CALLS.length).toBe(0);
  });
});
