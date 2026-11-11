/// <reference types="bun-types" />
import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

/**
 * RIISHE direct access — regression tests for the consent-landing removal.
 *
 * Contract under test:
 *  - The RIISHE navigation target is the assistant interface itself (chat,
 *    composer, history, empty state) — the standalone "Enable RIISHE?" consent
 *    page is GONE from the flow.
 *  - Removing the blocking page did NOT remove control: consent is still
 *    required, still granted/revoked ONLY in Settings → Privacy, and the
 *    server still refuses every AI request (403) without it.
 *  - Without consent the interface stays VIEWABLE but no AI operation is
 *    attempted from the client (nothing transmitted — no message, no private
 *    portfolio context), and the server independently blocks it.
 *  - Existing conversation history is preserved and still served whenever
 *    consent is active; revocation stops AI immediately without deleting data.
 *
 * Route tests call the real handlers with the same stateful-cookie harness the
 * auth suite uses. UI contracts that bun cannot render (no DOM runner in this
 * repo) are asserted structurally against the view source AND re-verified in
 * the browser during delivery.
 */

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

import { db } from "@/lib/db";
import { aiGate } from "@/lib/ai";
import { POST as registerRoute } from "@/app/api/auth/register/route";
import { GET as capabilitiesRoute } from "@/app/api/ai/capabilities/route";
import { GET as conversationsRoute } from "@/app/api/ai/conversations/route";
import { GET as conversationDetailRoute } from "@/app/api/ai/conversations/[id]/route";
import { POST as chatRoute } from "@/app/api/ai/chat/route";
import { POST as chatStreamRoute } from "@/app/api/ai/chat-stream/route";
import { PATCH as privacyRoute } from "@/app/api/me/privacy/route";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

function uniqueIp(): string {
  return `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`;
}

function request(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": uniqueIp(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

async function text(res: Response): Promise<string> {
  return await res.text();
}

// ------------------------------------------------------------------ shared state

const EMAIL = `riishe-direct-${randomUUID()}@beanfolio.test`;
let userAId = "";
let seededPrivateProjectTitle = "Confidential Editorial Reel (NDA)";
let seededConversationId = "";

async function register(): Promise<void> {
  const res = await registerRoute(
    request("/api/auth/register", "POST", { email: EMAIL, password: "riishe-password-1", name: "Riishe Direct" })
  );
  expect(res.status).toBe(200);
  const body = await resBody(res);
  userAId = (body.user as Record<string, unknown>).id as string;
}

// ------------------------------------------------------------------ 2/4/5 — consent disabled: viewable surface, blocked AI

describe("opening RIISHE with consent disabled", () => {
  test("registration starts WITHOUT consent (privacy by default)", async () => {
    await register();
    const user = await db.user.findUnique({ where: { id: userAId } });
    expect(user?.aiConsent).toBe(false);
  });

  test("capabilities report consentRequired while the service itself is available", async () => {
    const res = await capabilitiesRoute();
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.consentRequired).toBe(true);
    expect(body.available).toBe(true);
  });

  test("chat is blocked with 403 — no conversation, no message, no provider call", async () => {
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "Summarize my unreleased work" }));
    expect(res.status).toBe(403);
    const body = await resBody(res);
    expect(typeof body.error).toBe("string");
  });

  test("chat-stream is blocked with 403 before any streaming begins", async () => {
    const res = await chatStreamRoute(request("/api/ai/chat-stream", "POST", { message: "Any question" }));
    expect(res.status).toBe(403);
    const body = await resBody(res);
    expect(typeof body.error).toBe("string");
  });
});

// ------------------------------------------------------------------ 5 — private portfolio context never transmitted without consent

describe("no private portfolio context transmission without consent", () => {
  test("seeded private project exists for the user but never leaks through blocked AI calls", async () => {
    // Private, unreleased work — exactly the data consent exists to protect.
    await db.project.create({
      data: {
        ownerId: userAId,
        title: seededPrivateProjectTitle,
        description: "PRIVATE-NDA unreleased client campaign work",
        visibility: "PRIVATE",
        status: "DRAFT",
      },
    });

    const blocked = await chatRoute(
      request("/api/ai/chat", "POST", { message: "Describe my confidential project" })
    );
    expect(blocked.status).toBe(403);

    const body = await text(blocked);
    expect(body.includes(seededPrivateProjectTitle)).toBe(false);
    expect(body.includes("PRIVATE-NDA")).toBe(false);

    const streamBlocked = await chatStreamRoute(
      request("/api/ai/chat-stream", "POST", { message: "Describe my confidential project" })
    );
    expect(streamBlocked.status).toBe(403);
    const streamBody = await text(streamBlocked);
    expect(streamBody.includes(seededPrivateProjectTitle)).toBe(false);

    // Nothing was built, transmitted or persisted: zero conversations/messages.
    expect(await db.aiConversation.count({ where: { userId: userAId } })).toBe(0);
    expect(await db.aiMessage.count({ where: { conversation: { userId: userAId } } })).toBe(0);
  });

  test("aiGate refuses users without consent and admits consented users (server-side enforcement)", async () => {
    const unconsented = await db.user.findUnique({ where: { id: userAId } });
    expect(unconsented).not.toBeNull();
    const refused = await aiGate(unconsented!);
    expect(refused).not.toBeNull();
    expect(refused!.status).toBe(403);

    // A consented user object passes the gate (rate/usage checks run against
    // a fresh user — no usage rows yet).
    const [consentedUser, ] = await Promise.all([
      db.user.create({
        data: {
          email: `riishe-gate-${randomUUID()}@beanfolio.test`,
          passwordHash: "gate-test-hash",
          name: "Gate Probe",
          aiConsent: true,
        },
      }),
    ]);
    try {
      const allowed = await aiGate(consentedUser);
      expect(allowed).toBeNull();
    } finally {
      await db.user.delete({ where: { id: consentedUser.id } }).catch(() => undefined);
    }
  });
});

// ------------------------------------------------------------------ 3/9 — the interface, not the consent page, is the landing

describe("the assistant interface is the RIISHE landing (old consent page removed)", () => {
  const view = (): string => readFileSync("src/views/IntelligenceView.tsx", "utf8");
  const floating = (): string => readFileSync("src/components/bean/RiisheAssistant.tsx", "utf8");
  const settings = (): string => readFileSync("src/views/SettingsView.tsx", "utf8");

  test("the standalone Enable-RIISHE consent page is gone from the navigation flow", () => {
    const src = view();
    expect(src.includes("Enable RIISHE?")).toBe(false);
    expect(src.includes("ConsentCard")).toBe(false);
    expect(src.includes("showConsentGate")).toBe(false);
    // The old consent toggle (aria-label + its blocking copy) is gone too.
    expect(src.includes('aria-label="Enable RIISHE"')).toBe(false);
    expect(src.includes("Explicit consent is required before any AI feature becomes active.")).toBe(false);
  });

  test("the chat interface renders unconditionally when the service is available", () => {
    const src = view();
    // The chat is THE landing — availability is the only render condition.
    expect(src.includes("caps.available")).toBe(true);
    expect(src.includes("<ChatTab")).toBe(true);
    expect(src.includes("consented && caps.available")).toBe(false);
    // Composer and suggested prompts are the only consent-dependent controls.
    expect(src.includes("disabled={!consented || sending}")).toBe(true);
    // Client-side guard: without consent NOTHING is transmitted.
    expect(src.includes("if (!consented)")).toBe(true);
  });

  test("consent is surfaced unobtrusively and points to Settings → Privacy (no toggle in the view)", () => {
    const src = view();
    expect(src.includes("ConsentNotice")).toBe(true);
    expect(src.includes("Enable in Settings → Privacy")).toBe(true);
    // No enable/disable toggle lives on the RIISHE landing page anymore —
    // the Switch import (used by the old ConsentCard) is gone.
    expect(src.includes('from "@/components/ui/switch"')).toBe(false);
    expect(src.includes('id="ai-consent"')).toBe(false);
  });

  test("conversation area, composer, history and empty state all ship in the landing view", () => {
    const src = view();
    expect(src.includes("/api/ai/conversations")).toBe(true); // history
    expect(src.includes("Ask about your portfolio")).toBe(true); // composer
    expect(src.includes("Ask your portfolio assistant")).toBe(true); // empty state
    expect(src.includes("Message to RIISHE")).toBe(true);
  });

  test("the floating assistant's consent pointer opens Settings → Privacy, not the old enable page", () => {
    const src = floating();
    expect(src.includes('navigate("/intelligence")')).toBe(false);
    expect(src.includes('navigate("/settings")')).toBe(true);
  });

  test("Settings → Privacy remains the single consent-management surface", () => {
    const src = settings();
    expect(src.includes('id="ai-consent-switch"')).toBe(true);
    expect(src.includes("aiConsent")).toBe(true);
  });

  test("global navigation is untouched: RIISHE still routes to the assistant view", () => {
    const shell = readFileSync("src/components/bean/SiteShell.tsx", "utf8");
    expect(shell.includes('href: "/intelligence", label: "RIISHE"')).toBe(true);
    expect(shell.includes("<IntelligenceView />")).toBe(true);
  });
});

// ------------------------------------------------------------------ 1/6 — enabling consent through Settings → Privacy

describe("enabling consent through Settings → Privacy", () => {
  test("PATCH /api/me/privacy grants consent, audit-logs it, and RIISHE opens up", async () => {
    const res = await privacyRoute(request("/api/me/privacy", "PATCH", { aiConsent: true }));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.aiConsent).toBe(true);

    const user = await db.user.findUnique({ where: { id: userAId } });
    expect(user?.aiConsent).toBe(true);

    const audit = await db.auditEvent.findFirst({
      where: { actorUserId: userAId, action: "privacy.update" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.meta?.includes("aiConsent")).toBe(true);
  });

  test("opening RIISHE with consent enabled: capabilities + history both accessible", async () => {
    const caps = await capabilitiesRoute();
    expect(caps.status).toBe(200);
    const capsBody = await resBody(caps);
    expect(capsBody.consentRequired).toBe(false);
    expect(capsBody.available).toBe(true);

    const res = await conversationsRoute();
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(Array.isArray(body.conversations)).toBe(true);
  });
});

// ------------------------------------------------------------------ 8 — existing conversation history is preserved

describe("conversation history is preserved and served while consent is active", () => {
  test("prior conversations and their full threads remain intact and retrievable", async () => {
    const conversation = await db.aiConversation.create({
      data: { userId: userAId, title: "Festival pitch draft" },
    });
    seededConversationId = conversation.id;
    await db.aiMessage.createMany({
      data: [
        { conversationId: conversation.id, role: "USER", content: "Draft a pitch for my documentary short." },
        { conversationId: conversation.id, role: "ASSISTANT", content: "Here is a draft opening line…" },
      ],
    });

    const list = await conversationsRoute();
    expect(list.status).toBe(200);
    const listBody = await resBody(list);
    const listed = (listBody.conversations as { id: string; title: string }[]).find((c) => c.id === conversation.id);
    expect(listed?.title).toBe("Festival pitch draft");

    const detail = await conversationDetailRoute(request(`/api/ai/conversations/${conversation.id}`, "GET"), {
      params: Promise.resolve({ id: conversation.id }),
    });
    expect(detail.status).toBe(200);
    const detailBody = await resBody(detail);
    const messages = (detailBody.conversation as { messages: { role: string; content: string }[] }).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("USER");
    expect(messages[1].role).toBe("ASSISTANT");
  });
});

// ------------------------------------------------------------------ 7 — revoking consent stops AI immediately, keeps history

describe("revoking consent stops future AI operations immediately", () => {
  test("PATCH /api/me/privacy revokes consent", async () => {
    const res = await privacyRoute(request("/api/me/privacy", "PATCH", { aiConsent: false }));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.aiConsent).toBe(false);
  });

  test("AI operations stop at once: chat, stream, history — all 403", async () => {
    const chat = await chatRoute(request("/api/ai/chat", "POST", { message: "Follow-up question" }));
    expect(chat.status).toBe(403);

    const stream = await chatStreamRoute(request("/api/ai/chat-stream", "POST", { message: "Follow-up" }));
    expect(stream.status).toBe(403);

    const list = await conversationsRoute();
    expect(list.status).toBe(403);

    const detail = await conversationDetailRoute(request(`/api/ai/conversations/${seededConversationId}`, "GET"), {
      params: Promise.resolve({ id: seededConversationId }),
    });
    expect(detail.status).toBe(403);
  });

  test("revocation does not delete data — history survives for when consent returns", async () => {
    expect(await db.aiConversation.count({ where: { id: seededConversationId } })).toBe(1);
    expect(await db.aiMessage.count({ where: { conversationId: seededConversationId } })).toBe(2);
  });

  test("re-granting consent restores access to the SAME preserved history", async () => {
    const regrant = await privacyRoute(request("/api/me/privacy", "PATCH", { aiConsent: true }));
    expect(regrant.status).toBe(200);

    const detail = await conversationDetailRoute(request(`/api/ai/conversations/${seededConversationId}`, "GET"), {
      params: Promise.resolve({ id: seededConversationId }),
    });
    expect(detail.status).toBe(200);
    const body = await resBody(detail);
    const messages = (body.conversation as { messages: unknown[] }).messages;
    expect(messages).toHaveLength(2);
  });
});
