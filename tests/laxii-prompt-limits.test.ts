/**
 * LAXII — prompt budget consistency tests (composer/flow fix).
 *
 * Verifies the 16,000-character prompt budget end-to-end on the REAL routes
 * with a QA account (same armed-auth + scripted-engine pattern as
 * tests/laxii-brief-api.test.ts):
 *   - cleanPrompt accepts exactly 16,000 chars and truncates beyond it
 *   - POST /api/laxii/generate accepts 16,000 chars (202) and rejects 16,001 (400)
 *   - the EXACT submitted prompt is persisted verbatim as the USER message
 *   - the legacy conversational messages route enforces the same budget
 *
 * Run: bun test tests/laxii-prompt-limits.test.ts
 */

import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { randomUUID } from "crypto";

declare global {
  var __laxiiP3Auth: { armed: boolean; userId: string | null } | undefined;
  var __laxiiP3Engine: { impl: ((req: unknown, opts?: unknown) => Promise<unknown>) | null } | undefined;
}

globalThis.__laxiiP3Auth = { armed: false, userId: null };
globalThis.__laxiiP3Engine = { impl: null };

const realNextHeaders = await import("next/headers");
const realLaxiiRouter = await import("@/lib/laxii/router");

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

mock.module("@/lib/laxii/router", () => ({
  runLaxiiOperation: async (req: unknown, opts?: unknown) => {
    const impl = globalThis.__laxiiP3Engine!.impl;
    if (!impl) return realLaxiiRouter.runLaxiiOperation(req as never, opts as never);
    return impl(req);
  },
  laxiiCapabilities: () => realLaxiiRouter.laxiiCapabilities(),
}));

// No advisory AI review calls in tests.
process.env.LAXII_AI_VISUAL_REVIEW = "0";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
  mock.module("@/lib/auth", () => realAuthSnapshot);
});

const { POST: generateRoute } = await import("@/app/api/laxii/generate/route");
const { POST: messagesRoute } = await import("@/app/api/laxii/conversations/[id]/messages/route");
const { POST: conversationsRoute } = await import("@/app/api/laxii/conversations/route");

import { db } from "@/lib/db";
import { cleanPrompt } from "@/lib/laxii/service";
import { LAXII_PROMPT_MAX } from "@/lib/laxii-client";

function req(path: string, init?: { method?: string; json?: unknown }): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "content-type": "application/json",
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

async function scriptedScene(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#5a4a3a"/><circle cx="512" cy="512" r="380" fill="#8a6d3b"/><rect x="120" y="120" width="300" height="200" fill="#c8a15a"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const PASSWORD_DUMMY = "scrypt$fake$hash$for$qa";

describe("LAXII prompt budget — 16,000 characters end-to-end", () => {
  let user: { id: string; email: string };

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    user = await db.user.create({
      data: { email: `qa-laxii-limit-${suffix}@beanfolio.test`, passwordHash: PASSWORD_DUMMY, name: "QA Laxii Prompt Limit", username: `qa-laxii-limit-${suffix}`, aiConsent: true },
    });
    globalThis.__laxiiP3Engine!.impl = async () => ({
      images: [{ bytes: await scriptedScene(), mime: "image/png", width: 1024, height: 1024 }],
      provider: "managed",
      model: "scripted-test-engine",
      warnings: [],
      estimatedCostUsd: 0,
      durationMs: 4,
      interactionIds: undefined,
    });
  });

  afterAll(async () => {
    asAnonymous();
    globalThis.__laxiiP3Engine!.impl = null;
    if (user?.id) {
      const assets = await db.mediaAsset.findMany({ where: { ownerId: user.id }, select: { storagePath: true } });
      for (const a of assets) {
        const { unlink } = await import("fs/promises");
        const path = await import("path");
        await unlink(path.join(process.cwd(), "uploads", a.storagePath)).catch(() => undefined);
      }
      await db.user.deleteMany({ where: { id: user.id } });
    }
  });

  test("client/server shared budget constant is 16,000", () => {
    expect(LAXII_PROMPT_MAX).toBe(16000);
  });

  test("cleanPrompt keeps exactly 16,000 chars and truncates beyond", () => {
    const at = "x".repeat(16000);
    const over = `y${"x".repeat(16000)}`;
    expect(cleanPrompt(at)).toHaveLength(16000);
    expect(cleanPrompt(over)).toHaveLength(16000);
    expect(cleanPrompt(`  ${at}  `)).toHaveLength(16000);
    expect(cleanPrompt("ok")).toBe("ok");
    expect(cleanPrompt(42)).toBe("");
  });

  test("POST /api/laxii/generate accepts a 16,000-char prompt and rejects 16,001", async () => {
    asUser(user.id);
    const exact = "A".repeat(16000);
    const ok = await generateRoute(req("/api/laxii/generate", { method: "POST", json: { prompt: exact, operation: "GENERATE", provider: "managed" } }));
    expect(ok.status).toBe(202);
    const okBody = (await ok.json()) as { conversationId: string; messageId: string };
    expect(okBody.messageId).toBeTruthy();

    // The EXACT prompt must be persisted verbatim as the USER message.
    const userMsg = await db.laxiiMessage.findFirst({
      where: { conversationId: okBody.conversationId, role: "USER" },
      orderBy: { createdAt: "desc" },
      select: { text: true },
    });
    expect(userMsg?.text).toBe(exact);

    const over = "B".repeat(16001);
    const bad = await generateRoute(req("/api/laxii/generate", { method: "POST", json: { prompt: over, operation: "GENERATE", provider: "managed" } }));
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error?: string };
    expect(String(badBody.error)).toContain("16000");
  });

  test("legacy conversational messages route enforces the same budget", async () => {
    asUser(user.id);
    const conv = await conversationsRoute(req("/api/laxii/conversations", { method: "POST", json: {} }));
    expect([200, 201]).toContain(conv.status);
    const { conversation } = (await conv.json()) as { conversation: { id: string } };

    const ok = await messagesRoute(req(`/api/laxii/conversations/${conversation.id}/messages`, {
      method: "POST",
      json: { text: "C".repeat(16000), operation: "GENERATE" },
    }), { params: Promise.resolve({ id: conversation.id }) });
    if (ok.status !== 201) console.error("messages route body:", JSON.stringify(await ok.json()));
    expect(ok.status).toBe(201);

    const bad = await messagesRoute(req(`/api/laxii/conversations/${conversation.id}/messages`, {
      method: "POST",
      json: { text: "D".repeat(16001), operation: "GENERATE" },
    }), { params: Promise.resolve({ id: conversation.id }) });
    expect(bad.status).toBe(400);
  });
});
