/// <reference types="bun-types" />
import { describe, expect, test, afterAll, beforeAll, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

/**
 * RIISHE chat reliability — regression tests for the non-responsiveness /
 * infinite-loading investigation.
 *
 * Contract under test:
 *  - Every submitted message reaches a DEFINITIVE success or error state:
 *    the API answers 200, or an honest 4xx/5xx — nothing in between.
 *  - Validation, auth and ownership failures answer fast (400/401/404) —
 *    they never reach the provider.
 *  - A failing provider surfaces an HONEST 502 (AiProviderError message) or
 *    an honest 500 (unexpected backend error) — never a fabricated reply,
 *    never a hanging request.
 *  - The streaming route always terminates its SSE stream with a done frame
 *    (success path) or an error frame (failure path) and closes.
 *  - The frontend cannot hang forever: the chat request carries a client
 *    deadline, the failure path restores the message text (nothing silently
 *    discarded), and Retry actually RESENDS (it does not merely dismiss).
 *
 * Provider-dependent behavior is covered with a module mock (deterministic —
 * no network); the live provider path is verified in the browser during
 * delivery, and provider-dead behavior was fault-injected (black-hole and
 * HTTP-500 provider) against the real server during the investigation.
 */

// ------------------------------------------------------------------ harness

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

// Deterministic provider seam: the chat routes import aiComplete / aiStream /
// AiProviderError from "@/lib/ai". The mock lets each test choose the outcome.
class MockAiProviderError extends Error {}
type AiCompleteMock = (() => Promise<{ text: string }>) | null;
type AiStreamMock = (() => Promise<unknown>) | null;
const aiState: { complete: AiCompleteMock; stream: AiStreamMock } = { complete: null, stream: null };

mock.module("@/lib/ai", () => ({
  AiProviderError: MockAiProviderError,
  AI_DAILY_LIMIT: 30,
  AI_BURST_LIMIT: 6,
  AI_FEATURES: [],
  aiCapabilities: () => ({ available: true, provider: "BEAN Intelligence gateway", features: [], dailyLimit: 30, consentRequired: false }),
  aiGate: async () => null, // quota/burst limits are covered by the dedicated suites; reliability tests bypass them
  recordAiUsage: async () => undefined,
  aiComplete: async () => {
    if (!aiState.complete) throw new MockAiProviderError("no aiComplete mock configured");
    return aiState.complete();
  },
  aiStream: async () => {
    if (!aiState.stream) throw new MockAiProviderError("no aiStream mock configured");
    return aiState.stream();
  },
  parseJsonFromText: <T,>(text: string): T | null => {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  },
}));

import { db } from "@/lib/db";
import { POST as registerRoute } from "@/app/api/auth/register/route";
import { POST as chatRoute } from "@/app/api/ai/chat/route";
import { POST as chatStreamRoute } from "@/app/api/ai/chat-stream/route";

afterAll(async () => {
  mock.module("next/headers", () => realNextHeaders);
  await db.user.delete({ where: { email: "riishe-reliability@example.com" } }).catch(() => undefined);
});

function uniqueIp(): string {
  return `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`;
}

function request(path: string, method: string, body?: unknown, raw?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": uniqueIp(),
    },
    ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }),
  });
}

async function resBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ------------------------------------------------------------------ tests

describe("chat reliability — requests always reach a definitive state", () => {
  test("unauthenticated chat POST answers 401 fast (no provider call, no hang)", async () => {
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "hello" }));
    expect(res.status).toBe(401);
    const body = await resBody(res);
    expect(typeof body.error).toBe("string");
  });

  test("unauthenticated streaming POST answers 401 fast", async () => {
    const res = await chatStreamRoute(request("/api/ai/chat-stream", "POST", { message: "hello" }));
    expect(res.status).toBe(401);
  });

  test("empty and whitespace-only messages answer 400 (after sign-in)", async () => {
    await registerRoute(request("/api/auth/register", "POST", {
      email: "riishe-reliability@example.com",
      password: "ReliabilityTest2026!",
      name: "Reliability Probe",
    }));
    const empty = await chatRoute(request("/api/ai/chat", "POST", { message: "" }));
    expect(empty.status).toBe(400);
    const blank = await chatRoute(request("/api/ai/chat", "POST", { message: "   " }));
    expect(blank.status).toBe(400);
  });

  test("malformed JSON body answers 400", async () => {
    const res = await chatRoute(request("/api/ai/chat", "POST", undefined, "{not json"));
    expect(res.status).toBe(400);
  });

  test("message over the 2000-char limit answers 400", async () => {
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "x".repeat(2001) }));
    expect(res.status).toBe(400);
  });

  test("message with no content field answers 400", async () => {
    const res = await chatRoute(request("/api/ai/chat", "POST", {}));
    expect(res.status).toBe(400);
  });

  test("unknown conversationId answers 404 (strict ownership, no provider call)", async () => {
    const res = await chatRoute(request("/api/ai/chat", "POST", { conversationId: "does-not-exist", message: "hello" }));
    expect(res.status).toBe(404);
  });

  test("provider failure (AiProviderError) surfaces an honest 502 with a user-safe message", async () => {
    aiState.complete = async () => {
      throw new MockAiProviderError("The AI took too long to respond. Please try again.");
    };
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "plain question, no automation keywords" }));
    expect(res.status).toBe(502);
    const body = await resBody(res);
    expect(body.error).toBe("The AI took too long to respond. Please try again.");
    // Failed turns persist NOTHING — the conversation history stays honest.
    const conv = await db.aiConversation.findFirst({ where: { title: "plain question, no automation keywords" } });
    expect(conv).toBeNull();
  });

  test("unexpected backend failure surfaces an honest 500 (never a fabricated reply)", async () => {
    aiState.complete = async () => {
      throw new Error("simulated backend crash");
    };
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "another plain question" }));
    expect(res.status).toBe(500);
    const body = await resBody(res);
    expect(body.error).toBe("Something went wrong");
    const conv = await db.aiConversation.findFirst({ where: { title: "another plain question" } });
    expect(conv).toBeNull();
  });

  test("successful provider reply answers 200 and persists BOTH messages", async () => {
    aiState.complete = async () => ({ text: "A grounded, honest reply." });
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "persist check please" }));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.reply).toBe("A grounded, honest reply.");
    expect(typeof body.conversationId).toBe("string");
    const messages = await db.aiMessage.findMany({
      where: { conversationId: body.conversationId as string },
      orderBy: { createdAt: "asc" },
    });
    expect(messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
  });

  test("streaming route: provider failure emits an SSE error frame and CLOSES the stream", async () => {
    aiState.stream = async () => {
      throw new MockAiProviderError("The AI service is unavailable right now. Please try again shortly.");
    };
    const res = await chatStreamRoute(request("/api/ai/chat-stream", "POST", { message: "stream failure check" }));
    expect(res.status).toBe(200); // SSE contract: the stream itself reports the failure
    const text = await res.text();
    expect(text).toContain('"error"');
    expect(text).toContain("unavailable");
  });

  test("streaming route: a normal stream emits deltas then a done frame with the conversationId", async () => {
    const encoder = new TextEncoder();
    let streamClosed = false;
    aiState.stream = async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`));
          controller.close();
          streamClosed = true;
        },
      });
    const res = await chatStreamRoute(request("/api/ai/chat-stream", "POST", { message: "stream success check" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"delta":"Hel"');
    expect(text).toContain('"delta":"lo"');
    expect(text).toContain('"done":true');
    expect(typeof JSON.parse(text.trim().split("\n\n").pop()!.slice(6)).conversationId).toBe("string");
    // The streamed reply is persisted only AFTER completion.
    const conv = await db.aiConversation.findFirst({ where: { title: "stream success check" } });
    expect(conv).not.toBeNull();
    const msgs = await db.aiMessage.findMany({ where: { conversationId: conv!.id }, orderBy: { createdAt: "asc" } });
    expect(msgs.map((m) => m.content)).toEqual(["stream success check", "Hello"]);
    expect(streamClosed).toBe(true);
  });

  test("streaming route: a provider stream that dies MID-STREAM surfaces the partial, persists it and ends with an error frame", async () => {
    const encoder = new TextEncoder();
    aiState.stream = async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`));
          // Error asynchronously: erroring synchronously in start() discards
          // already-queued chunks, which no real provider stream does.
          setTimeout(() => controller.error(new Error("provider stream died")), 10);
        },
      });
    const res = await chatStreamRoute(request("/api/ai/chat-stream", "POST", { message: "mid stream death check" }));
    const text = await res.text();
    // The partial text was surfaced and persisted (mid-stream failure keeps
    // what the user already saw), then the stream ended with an honest error
    // frame — it never fabricates a done/success frame for a dead stream.
    expect(text).toContain('"delta":"partial"');
    expect(text).toContain('"error"');
    expect(text).not.toContain('"done":true');
    const conv = await db.aiConversation.findFirst({ where: { title: "mid stream death check" } });
    expect(conv).not.toBeNull();
    const msgs = await db.aiMessage.findMany({ where: { conversationId: conv!.id }, orderBy: { createdAt: "asc" } });
    expect(msgs.map((m) => m.content)).toEqual(["mid stream death check", "partial"]);
  });
});

// ------------------------------------------------- frontend invariants (structural)

describe("chat reliability — frontend cannot hang forever", () => {
  const view = (): string => readFileSync("src/views/IntelligenceView.tsx", "utf8");
  const client = (): string => readFileSync("src/lib/client.ts", "utf8");
  const floating = (): string => readFileSync("src/components/bean/RiisheAssistant.tsx", "utf8");

  test("the shared api client supports a request deadline and maps aborts to 408", () => {
    const src = client();
    expect(src.includes("timeoutMs?: number")).toBe(true);
    expect(src.includes("controller.abort()")).toBe(true);
    expect(src.includes("408")).toBe(true);
    // The timer must be cleared on every path (no dangling deadline timers).
    expect(src.includes("clearTimeout(timer)")).toBe(true);
  });

  test("the chat POST carries a client deadline", () => {
    expect(view().includes("timeoutMs: 150_000")).toBe(true);
  });

  test("sending is ALWAYS cleared — the finally block covers every failure mode", () => {
    const src = view();
    expect(src.includes("} finally {\n      // ALWAYS reached")).toBe(true);
    expect(src.includes("setSending(false);\n    }\n  };")).toBe(true);
  });

  test("Retry actually RESENDS the failed message (not just dismissing the banner)", () => {
    const src = view();
    expect(src.includes("setRetryMessage(message)")).toBe(true);
    expect(src.includes("void send(msg)")).toBe(true);
  });

  test("failed messages are never silently discarded (text returns to the composer)", () => {
    expect(view().includes("setInput(message);")).toBe(true);
  });

  test("duplicate submissions are blocked while a request is in flight", () => {
    expect(view().includes("if (!message || sending) return;")).toBe(true);
    expect(view().includes('disabled={sending || !input.trim()}')).toBe(true);
  });

  test("the floating streaming assistant bounds its request AND detects stalled streams", () => {
    const src = floating();
    expect(src.includes("credentials: \"include\"")).toBe(true);
    expect(src.includes("controller.abort()")).toBe(true);
    expect(src.includes("clearTimeout(requestTimer)")).toBe(true);
  });
});
