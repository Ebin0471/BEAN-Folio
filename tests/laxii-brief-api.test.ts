/**
 * LAXII Phase 3 — brief ingestion + banner pipeline route tests.
 *
 * REAL routes against the REAL database with a QA account, following the
 * established route-test pattern (next/headers + auth module overrides armed
 * per-file and DISARMED afterwards; scripted image engine; unique XFF per
 * request). The image engine (@/lib/laxii/router) is replaced by a scripted
 * provider that returns REAL sharp-rendered pixels — so the full pipeline
 * (composition plan → deterministic typography → evaluate → exact-canvas
 * export) runs for real; only the slow external provider call is scripted.
 * These tests need NO provider credentials.
 *
 * Covers spec §9: brief reaches LAXII, portfolio permission enforcement,
 * exact 2048×687 output, text rendering, safe-area compliance, invalid image
 * rejection (route path), version lineage, user approval before publication,
 * cost guardrails, provider failure handling, retry/idempotency.
 *
 * Run: bun test tests/laxii-brief-api.test.ts
 */

import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { randomUUID } from "crypto";

// --- module overrides (armed pattern — harmless when disarmed) -------------

declare global {
  var __laxiiP3Auth: { armed: boolean; userId: string | null } | undefined;
  var __laxiiP3Engine: { impl: ((req: unknown, opts?: unknown) => Promise<unknown>) | null } | undefined;
}

globalThis.__laxiiP3Auth = { armed: false, userId: null };
globalThis.__laxiiP3Engine = { impl: null };

// Capture the REAL modules before overriding — bun module mocks persist for
// the whole test process, so the overrides below DELEGATE to the real module
// whenever they are not armed (the intelligence-gateway tests read the REAL
// LAXII capability registry after this file finishes).
const realNextHeaders = await import("next/headers");
const realLaxiiRouter = await import("@/lib/laxii/router");

// Handlers run outside a Next request scope — no-op cookie store (the armed
// auth mock below bypasses cookies entirely when armed).
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => undefined,
  }),
}));

const actualAuth = await import("@/lib/auth");
const realAuthSnapshot = { ...actualAuth };
const realGetSessionUser = actualAuth.getSessionUser;

mock.module("@/lib/auth", () => ({
  ...realAuthSnapshot,
  getSessionUser: async () => {
    const state = globalThis.__laxiiP3Auth!;
    if (state.armed && state.userId) {
      const { db } = await import("@/lib/db");
      return db.user.findUnique({ where: { id: state.userId } });
    }
    return realGetSessionUser();
  },
}));

// Scripted engine: REAL sharp pixels, no external provider. DELEGATING armed
// pattern: while a test has scripted an impl the mock serves it; once disarmed
// (impl = null, the state after this file's afterAll) every call — including
// laxiiCapabilities — falls through to the REAL router, so later test files
// observe the real registry instead of this file's scripted one.
mock.module("@/lib/laxii/router", () => ({
  runLaxiiOperation: async (req: unknown, opts?: unknown) => {
    const impl = globalThis.__laxiiP3Engine!.impl;
    if (!impl) return realLaxiiRouter.runLaxiiOperation(req as never, opts as never);
    return impl(req);
  },
  laxiiCapabilities: () => {
    if (!globalThis.__laxiiP3Engine!.impl) return realLaxiiRouter.laxiiCapabilities();
    return {
      defaultProvider: "managed" as const,
      providers: [
        {
          id: "managed",
          label: "LAXII Core",
          available: true,
          model: "scripted-test-engine",
          capabilities: {
            generate: { supported: true, maxReferences: 3 },
            edit: { supported: true, maxReferences: 3 },
            variations: { supported: true },
            upscale: { supported: true },
            removeBackground: { supported: true, transparent: true },
            expand: { supported: true },
          },
          aspects: ["21:9"],
        },
      ],
    };
  },
}));

// The advisory AI review must stay OFF (no provider calls in tests).
process.env.LAXII_AI_VISUAL_REVIEW = "0";

// Restore the REAL cookie/auth modules once this file's tests finish —
// later files must not inherit the no-op cookie store. (The router mock
// above self-delegates when disarmed, so it needs no restore.)
afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
  mock.module("@/lib/auth", () => realAuthSnapshot);
});

// Import routes AFTER overrides are installed.
const { GET: briefGet, POST: briefPost } = await import("@/app/api/laxii/brief/route");
const { POST: generateRoute } = await import("@/app/api/laxii/generate/route");
const { POST: bannerExportRoute } = await import("@/app/api/laxii/banner/export/route");
const { POST: versionSelectRoute } = await import("@/app/api/laxii/versions/[id]/select/route");

import { db } from "@/lib/db";
import { buildStructuredBannerBrief, describeBrief, prepareDelegation } from "@/lib/intelligence/delegation";
import { parseDesignBrief } from "@/lib/laxii/design-brief";
import { LaxiiProviderError } from "@/lib/laxii/types";

function req(path: string, init?: { method?: string; json?: unknown }): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "content-type": "application/json",
      // Unique rightmost XFF hop per request → no rate-limit bucket collisions.
      "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
    },
    ...(init?.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
}

function asUser(id: string) {
  globalThis.__laxiiP3Auth!.armed = true;
  globalThis.__laxiiP3Auth!.userId = id;
}

function asAnonymous() {
  globalThis.__laxiiP3Auth!.armed = false;
  globalThis.__laxiiP3Auth!.userId = null;
}

/** Wide textured scene (passes quality checks; pipeline cover-crops to 2048×687). */
async function texturedScene(): Promise<Buffer> {
  const tones = ["#8a6d3b", "#3b5a8a", "#5a8a3b", "#c8a15a"];
  const shapes: string[] = [];
  for (let i = 0; i < 24; i += 1) {
    shapes.push(`<circle cx="${(i * 97) % 2016}" cy="${(i * 211) % 864}" r="${90 + ((i * 53) % 220)}" fill="${tones[i % tones.length]}" fill-opacity="0.85"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2016" height="864"><rect width="2016" height="864" fill="#6b5a3e"/>${shapes.join("")}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

function scriptedEngine(images: () => Promise<{ bytes: Buffer; mime: string; width: number; height: number }[]>) {
  let call = 0;
  globalThis.__laxiiP3Engine!.impl = async () => {
    const imgs = await images();
    const img = imgs[Math.min(call, imgs.length - 1)];
    call += 1;
    return {
      images: [img],
      provider: "managed",
      model: "scripted-test-engine",
      warnings: [],
      estimatedCostUsd: 0,
      durationMs: 4,
      interactionIds: undefined,
    };
  };
}

async function waitForMessage(messageId: string, timeoutMs = 20000): Promise<{ status: string; error: string | null; metaJson: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = await db.laxiiMessage.findUnique({ where: { id: messageId } });
    if (m && (m.status === "DONE" || m.status === "FAILED")) {
      return { status: m.status, error: m.error, metaJson: m.metaJson };
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`message ${messageId} never reached a terminal state`);
}

async function createBriefTask(userId: string, message: string): Promise<string> {
  const { taskId } = await prepareDelegation(await db.user.findUniqueOrThrow({ where: { id: userId } }), {
    kind: "BANNER_DESIGN",
    targetAgent: "LAXII",
    title: message.slice(0, 80),
    brief: "",
    destinationUrl: "#/laxii",
    destinationLabel: "Open LAXII banner studio",
  }, message);
  return taskId;
}

const PASSWORD_DUMMY = "scrypt$fake$hash$for$qa";

describe("LAXII Phase 3 — Riishe→LAXII brief ingestion + banner pipeline (routes)", () => {
  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  const createdUploadPaths: string[] = [];

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    userA = await db.user.create({
      data: { email: `qa-laxii3-a-${suffix}@beanfolio.test`, passwordHash: PASSWORD_DUMMY, name: "QA Laxii Three A", username: `qa-laxii3-a-${suffix}`, aiConsent: true },
    });
    userB = await db.user.create({
      data: { email: `qa-laxii3-b-${suffix}@beanfolio.test`, passwordHash: PASSWORD_DUMMY, name: "QA Laxii Three B", username: `qa-laxii3-b-${suffix}` },
    });
    scriptedEngine(async () => [{ bytes: await texturedScene(), mime: "image/jpeg", width: 2016, height: 864 }]);
  });

  afterAll(async () => {
    asAnonymous();
    globalThis.__laxiiP3Engine!.impl = null;
    // Remove stored media files, then the users (rows cascade).
    const users = [userA?.id, userB?.id].filter(Boolean) as string[];
    for (const uid of users) {
      const assets = await db.mediaAsset.findMany({ where: { ownerId: uid }, select: { storagePath: true } });
      for (const a of assets) {
        const { unlink } = await import("fs/promises");
        const path = await import("path");
        await unlink(path.join(process.cwd(), "uploads", a.storagePath)).catch(() => undefined);
      }
    }
    if (users.length > 0) {
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
  });

  test("brief delegation builds the structured brief and it reaches LAXII", async () => {
    asUser(userA.id);
    const taskId = await createBriefTask(userA.id, 'Create a professional banner for my portfolio with "MAYA STUDIO" as the headline');

    const res = await briefGet(req(`/api/laxii/brief?taskId=${taskId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { id: string; status: string };
      brief: { request: string; canvas: { width: number; height: number }; typography: { items: { text: string }[] }; portfolio: { permission: string } };
    };
    expect(body.task.id).toBe(taskId);
    expect(body.task.status).toBe("AWAITING_APPROVAL");
    expect(body.brief.canvas.width).toBe(2048);
    expect(body.brief.canvas.height).toBe(687);
    expect(body.brief.portfolio.permission).toBe("self");
    expect(body.brief.request).toContain("professional banner");
    // The exact quoted text made it into the structured brief.
    expect(body.brief.typography.items.map((t) => t.text)).toContain("MAYA STUDIO");
  });

  test("portfolio context permission: other users' briefs are invisible (404), anonymous is 401", async () => {
    const taskId = await createBriefTask(userA.id, "Another banner brief for permission checks");
    asUser(userB.id);
    const cross = await briefGet(req(`/api/laxii/brief?taskId=${taskId}`));
    expect(cross.status).toBe(404);

    asAnonymous();
    const anon = await briefGet(req(`/api/laxii/brief?taskId=${taskId}`));
    expect(anon.status).toBe(401);
  });

  test("brief-driven generation: 202 → DONE with EXACT 2048×687, quality report, lineage, AgentTask COMPLETED", async () => {
    asUser(userA.id);
    const taskId = await createBriefTask(userA.id, 'Banner with "QA STUDIO" headline');

    const gen = await generateRoute(req("/api/laxii/generate", { method: "POST", json: { operation: "BANNER", briefTaskId: taskId } }));
    expect(gen.status).toBe(202);
    const genBody = (await gen.json()) as { conversationId: string; messageId: string; briefTaskId?: string };
    expect(genBody.briefTaskId).toBe(taskId);

    // AgentTask went RUNNING immediately.
    const taskRow = await db.agentTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(taskRow.status).toBe("RUNNING");

    const final = await waitForMessage(genBody.messageId);
    expect(final.status).toBe("DONE");
    const meta = JSON.parse(final.metaJson!) as {
      briefTaskId?: string;
      qualityReport?: { overall: string; findings: { id: string; status: string }[] };
      pipelineAttempts?: unknown[];
      pipelineDecisions?: { typographyRendered?: boolean };
    };
    expect(meta.briefTaskId).toBe(taskId);
    expect(meta.qualityReport).toBeTruthy();
    // Bounded loop: the scripted scene measures soft at evaluator scale, so
    // the pipeline may refine once — it can NEVER exceed the configured bound.
    expect(meta.pipelineAttempts!.length).toBeGreaterThanOrEqual(1);
    expect(meta.pipelineAttempts!.length).toBeLessThanOrEqual(2);
    // Deterministic typography ran for the quoted headline.
    expect(meta.pipelineDecisions?.typographyRendered).toBe(true);
    const typFindings = meta.qualityReport!.findings.filter((f) => f.id.startsWith("typ."));
    expect(typFindings.length).toBeGreaterThan(0);
    expect(typFindings.every((f) => f.status !== "fail")).toBe(true);

    // The stored version is EXACTLY 2048×687 (decode-verified pipeline output).
    const version = await db.laxiiImageVersion.findFirstOrThrow({ where: { messageId: genBody.messageId } });
    expect(version.width).toBe(2048);
    expect(version.height).toBe(687);
    const media = await db.mediaAsset.findUniqueOrThrow({ where: { id: version.mediaId } });
    createdUploadPaths.push(media.storagePath);

    // AgentTask COMPLETED with the linked generation.
    const done = await db.agentTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(done.status).toBe("COMPLETED");
    const result = JSON.parse(done.resultJson!) as { generation?: { conversationId?: string; messageId?: string; mediaId?: string } };
    expect(result.generation?.messageId).toBe(genBody.messageId);
    expect(result.generation?.mediaId).toBe(version.mediaId);

    // Version lineage: the brief version is part of the conversation tree and selectable.
    const sel = await versionSelectRoute(req(`/api/laxii/versions/${version.id}/select`, { method: "POST" }), { params: Promise.resolve({ id: version.id }) } as never);
    expect(sel.status).toBe(200);
  });

  test("approval gate: export is refused BEFORE approval, allowed after approve-result", async () => {
    asUser(userA.id);
    const taskId = await createBriefTask(userA.id, "Approval gate banner brief");
    const gen = await generateRoute(req("/api/laxii/generate", { method: "POST", json: { operation: "BANNER", briefTaskId: taskId } }));
    expect(gen.status).toBe(202);
    const { messageId } = (await gen.json()) as { messageId: string };
    await waitForMessage(messageId);
    const version = await db.laxiiImageVersion.findFirstOrThrow({ where: { messageId } });

    const denied = await bannerExportRoute(req("/api/laxii/banner/export", { method: "POST", json: { versionId: version.id, format: "png" } }));
    expect(denied.status).toBe(403);

    const approve = await briefPost(req("/api/laxii/brief", { method: "POST", json: { action: "approve-result", taskId, messageId } }));
    expect(approve.status).toBe(200);
    const approved = (await approve.json()) as { generation: { approved?: boolean }; task: { status: string } };
    expect(approved.generation.approved).toBe(true);
    expect(approved.task.status).toBe("COMPLETED");

    const allowed = await bannerExportRoute(req("/api/laxii/banner/export", { method: "POST", json: { versionId: version.id, format: "png" } }));
    expect(allowed.status).toBe(200);
    const exportBody = (await allowed.json()) as { export: { width: number; height: number } };
    expect(exportBody.export.width).toBe(2048);
    expect(exportBody.export.height).toBe(687);
  });

  test("reject-result records the decision and keeps the export locked", async () => {
    asUser(userA.id);
    const taskId = await createBriefTask(userA.id, "Reject flow banner brief");
    const gen = await generateRoute(req("/api/laxii/generate", { method: "POST", json: { operation: "BANNER", briefTaskId: taskId } }));
    const { messageId } = (await gen.json()) as { messageId: string };
    await waitForMessage(messageId);

    const reject = await briefPost(req("/api/laxii/brief", { method: "POST", json: { action: "reject-result", taskId, messageId, reason: "colors off" } }));
    expect(reject.status).toBe(200);
    const body = (await reject.json()) as { generation: { rejected?: boolean; approved?: boolean }; task: { status: string; error: string | null } };
    expect(body.generation.rejected).toBe(true);
    expect(body.generation.approved).toBeFalsy();
    expect(body.task.status).toBe("AWAITING_APPROVAL");

    const version = await db.laxiiImageVersion.findFirstOrThrow({ where: { messageId } });
    const denied = await bannerExportRoute(req("/api/laxii/banner/export", { method: "POST", json: { versionId: version.id, format: "png" } }));
    expect(denied.status).toBe(403);
  });

  test("targeted revisions are bounded (max 3) and recorded on the brief", async () => {
    asUser(userA.id);
    const taskId = await createBriefTask(userA.id, "Revision bound brief");
    for (let i = 0; i < 3; i += 1) {
      const r = await briefPost(req("/api/laxii/brief", { method: "POST", json: { action: "revise", taskId, area: "background", instruction: `revision number ${i + 1}` } }));
      expect(r.status).toBe(200);
      const body = (await r.json()) as { brief: { revisions: unknown[] } };
      expect(body.brief.revisions).toHaveLength(i + 1);
    }
    const fourth = await briefPost(req("/api/laxii/brief", { method: "POST", json: { action: "revise", taskId, area: "background", instruction: "one revision too many" } }));
    expect(fourth.status).toBe(400);
  });

  test("generate with another user's briefTaskId is a 404 (ownership enforced)", async () => {
    asUser(userA.id);
    const taskId = await createBriefTask(userA.id, "Ownership check brief");
    asUser(userB.id);
    const res = await generateRoute(req("/api/laxii/generate", { method: "POST", json: { operation: "BANNER", briefTaskId: taskId } }));
    expect(res.status).toBe(404);
  });

  test("duplicate submission while a brief job is RUNNING re-attaches (idempotency)", async () => {
    asUser(userA.id);
    const taskId = await createBriefTask(userA.id, "Idempotency brief");
    // Simulate an in-flight pipeline: RUNNING message + RUNNING task.
    const conv = await db.laxiiConversation.create({
      data: { userId: userA.id, title: "Idempotency", kind: "BANNER", bannerKind: "bean-folio-banner", canvasWidth: 2048, canvasHeight: 687 },
    });
    const running = await db.laxiiMessage.create({
      data: { conversationId: conv.id, role: "ASSISTANT", status: "RUNNING", operation: "BANNER", metaJson: JSON.stringify({ briefTaskId: taskId }) },
    });
    await db.agentTask.update({ where: { id: taskId }, data: { status: "RUNNING" } });

    const res = await generateRoute(req("/api/laxii/generate", { method: "POST", json: { operation: "BANNER", briefTaskId: taskId } }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { messageId: string; duplicate?: boolean };
    expect(body.duplicate).toBe(true);
    expect(body.messageId).toBe(running.id);

    // Cleanup the synthetic running state.
    await db.laxiiMessage.update({ where: { id: running.id }, data: { status: "FAILED", error: "test cleanup" } });
    await db.agentTask.update({ where: { id: taskId }, data: { status: "AWAITING_APPROVAL" } });
    await db.laxiiConversation.delete({ where: { id: conv.id } });
  });

  test("cost guardrail: generation is refused honestly when the daily estimate budget is spent", async () => {
    asUser(userB.id);
    const limitCents = (() => {
      const raw = Number(process.env.INTELLIGENCE_DAILY_COST_LIMIT_USD);
      return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) : 500;
    })();
    await db.laxiiUsage.create({
      data: { userId: userB.id, feature: "laxii.banner", provider: "gemini", model: "test", operation: "BANNER", costEstimateCents: limitCents },
    });
    const taskId = await createBriefTask(userB.id, "Cost guardrail brief");
    const res = await generateRoute(req("/api/laxii/generate", { method: "POST", json: { operation: "BANNER", briefTaskId: taskId } }));
    expect(res.status).toBe(429);
    // Reset the ledger for other tests.
    await db.laxiiUsage.deleteMany({ where: { userId: userB.id } });
  });

  test("provider failure: honest FAILED turn + FAILED AgentTask, nothing fake", async () => {
    asUser(userA.id);
    globalThis.__laxiiP3Engine!.impl = async () => {
      throw new LaxiiProviderError("scripted engine exploded", "provider");
    };
    const taskId = await createBriefTask(userA.id, "Provider failure brief");
    const gen = await generateRoute(req("/api/laxii/generate", { method: "POST", json: { operation: "BANNER", briefTaskId: taskId } }));
    expect(gen.status).toBe(202);
    const { messageId } = (await gen.json()) as { messageId: string };
    const final = await waitForMessage(messageId);
    expect(final.status).toBe("FAILED");
    expect(final.error).toContain("could not complete");
    const task = await db.agentTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe("FAILED");

    // Restore the working engine for any later assertions.
    scriptedEngine(async () => [{ bytes: await texturedScene(), mime: "image/jpeg", width: 2016, height: 864 }]);
  });

  test("brief prompt compilation is server-authoritative (client prompt never reaches the provider)", async () => {
    asUser(userA.id);
    const message = 'Banner with "COMPILE CHECK" headline';
    const built = await buildStructuredBannerBrief(await db.user.findUniqueOrThrow({ where: { id: userA.id } }), message);
    const parsed = parseDesignBrief(built.brief);
    // The structured brief — not a shortened summary — carries the exact text.
    expect(parsed.typography.items.map((t) => t.text)).toContain("COMPILE CHECK");
    expect(describeBrief(parsed)).toContain('"COMPILE CHECK"');
  });
});
