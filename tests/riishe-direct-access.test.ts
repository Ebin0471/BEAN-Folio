/// <reference types="bun-types" />
import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

/**
 * RIISHE direct access — regression tests for the consent-toggle removal.
 *
 * Contract under test (owner directive — the standalone "BEAN Intelligence
 * consent" toggle is GONE):
 *  - The RIISHE navigation target is the assistant interface itself (chat,
 *    composer, history, empty state). No consent toggle or gate exists
 *    anywhere: not in Settings, not in the view, not in the floating assistant.
 *  - BEAN Intelligence is available to EVERY authenticated user out of the
 *    box — authorization comes from the session, never from a toggle. The
 *    server still refuses UNAUTHENTICATED requests (401) and every query
 *    stays owner-scoped (another user's conversation id is a 404).
 *  - Rate limits + the daily quota still apply to every AI route.
 *  - The persisted `User.aiConsent` field remains (export/audit history) but
 *    gates nothing; PATCH /api/me/privacy still accepts it for compatibility.
 *
 * Route tests call the real handlers with the same stateful-cookie harness the
 * auth suite uses. Provider-dependent chat routes are NOT invoked here (tests
 * must stay deterministic); the streaming path is covered by the automation
 * suite with a live gateway call. UI contracts that bun cannot render (no DOM
 * runner in this repo) are asserted structurally against the view source AND
 * re-verified in the browser during delivery.
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
import { GET as publicProfileRoute } from "@/app/api/profiles/[username]/route";
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
    request("/api/auth/register", "POST", { email: EMAIL, password: "riishe-password-1", name: "Riishe Direct", identity: "CAREER_PROFESSIONAL" })
  );
  expect(res.status).toBe(200);
  const body = await resBody(res);
  userAId = (body.user as Record<string, unknown>).id as string;
}

// ------------------------------------------------------------------ 2 — AI access needs a session, not a toggle

describe("BEAN Intelligence access without any consent toggle", () => {
  test("registration does not require or set any consent switch (field kept for history only)", async () => {
    await register();
    const user = await db.user.findUnique({ where: { id: userAId } });
    // The legacy field stays at its schema default; it no longer gates anything.
    expect(user?.aiConsent).toBe(false);
  });

  test("capabilities report consentRequired=false while the service is available", async () => {
    const res = await capabilitiesRoute();
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.consentRequired).toBe(false);
    expect(body.available).toBe(true);
  });

  test("conversation history is accessible WITHOUT any consent flag (owner-scoped)", async () => {
    const res = await conversationsRoute();
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(Array.isArray(body.conversations)).toBe(true);
  });

  test("aiGate admits every authenticated user (only rate limit + daily quota apply)", async () => {
    const user = await db.user.findUnique({ where: { id: userAId } });
    expect(user).not.toBeNull();
    const verdict = await aiGate(user!);
    expect(verdict).toBeNull(); // 403 consent branch is gone; quota/rate checks run
  });
});

// ------------------------------------------------------------------ 5 — private data stays owner-scoped (authorization, not consent)

describe("private portfolio data never crosses user boundaries", () => {
  test("seeded private project exists for the owner but is invisible through the public profile", async () => {
    // Private, unreleased work — the privacy boundary is ownership + the
    // visibility ladder, enforced independently of any AI toggle.
    await db.project.create({
      data: {
        ownerId: userAId,
        title: seededPrivateProjectTitle,
        description: "PRIVATE-NDA unreleased client campaign work",
        visibility: "PRIVATE",
        status: "DRAFT",
      },
    });

    // AI history stays empty (no chat route calls here — provider calls are
    // covered in the automation suite); the point of this test is the
    // AUTHORIZATION boundary below.
    expect(await db.aiConversation.count({ where: { userId: userAId } })).toBe(0);

    // The public profile payload (what every OTHER visitor sees) never
    // contains the private project or its text.
    const username = (await db.user.findUnique({ where: { id: userAId } }))?.username ?? "";
    const prof = await publicProfileRoute(request(`/api/profiles/${username}`, "GET"), {
      params: Promise.resolve({ username }),
    });
    const profBody = await text(prof);
    expect(profBody.includes(seededPrivateProjectTitle)).toBe(false);
    expect(profBody.includes("PRIVATE-NDA")).toBe(false);
  });

  test("another user's conversation id is a 404 — ownership is the privacy boundary", async () => {
    const other = await db.user.create({
      data: {
        email: `riishe-other-${randomUUID()}@beanfolio.test`,
        passwordHash: "x",
        name: "Other Account",
      },
    });
    const otherConversation = await db.aiConversation.create({
      data: { userId: other.id, title: "Someone else's thread" },
    });
    try {
      const detail = await conversationDetailRoute(request(`/api/ai/conversations/${otherConversation.id}`, "GET"), {
        params: Promise.resolve({ id: otherConversation.id }),
      });
      expect(detail.status).toBe(404);
    } finally {
      await db.user.delete({ where: { id: other.id } }).catch(() => undefined);
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
    // NO consent gating remains anywhere: no disabled-by-consent controls, no
    // client-side consent guard, no ConsentNotice component.
    expect(src.includes("consented")).toBe(false);
    expect(src.includes("ConsentNotice")).toBe(false);
    expect(src.includes("consentPrompted")).toBe(false);
  });

  test("no consent UI exists in the view at all", () => {
    const src = view();
    expect(src.includes("Enable in Settings → Privacy")).toBe(false);
    expect(src.includes("Consent is on")).toBe(false);
    expect(src.includes("Consent is off")).toBe(false);
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

  test("the floating assistant has NO consent gate: send is never disabled by a flag", () => {
    const src = floating();
    expect(src.includes('navigate("/intelligence")')).toBe(false);
    // The old consent plumbing is fully gone.
    expect(src.includes("consentBlocked")).toBe(false);
    expect(src.includes("isConsented")).toBe(false);
    expect(src.includes("user.aiConsent")).toBe(false);
    expect(src.includes("Open Settings → Privacy")).toBe(false);
  });

  test("the standalone Settings consent toggle is REMOVED", () => {
    const src = settings();
    expect(src.includes('id="ai-consent-switch"')).toBe(false);
    expect(src.includes("BEAN Intelligence consent")).toBe(false);
    expect(src.includes("aiConsentBusy")).toBe(false);
    // The visibility Select (patchPrivacy) survives — privacy settings remain.
    expect(src.includes("patchPrivacy")).toBe(true);
  });

  test("global navigation is untouched: RIISHE still routes to the assistant view", () => {
    const shell = readFileSync("src/components/bean/SiteShell.tsx", "utf8");
    expect(shell.includes('href: "/intelligence", label: "RIISHE"')).toBe(true);
    expect(shell.includes("<IntelligenceView />")).toBe(true);
  });
});

// ------------------------------------------------------------------ 1 — the legacy field stays compatible, gates nothing

describe("the legacy aiConsent field stays compatible but gates nothing", () => {
  test("PATCH /api/me/privacy still accepts the field and audit-logs it (API compatibility)", async () => {
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

  test("capabilities + history are accessible regardless of the flag value", async () => {
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

// ------------------------------------------------------------------ 8 — conversation history is preserved

describe("conversation history is preserved and served", () => {
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

// ------------------------------------------------------------------ 7 — revoking the legacy flag changes nothing (no gate exists)

describe("revoking the legacy flag has no effect on AI access (no gate exists)", () => {
  test("PATCH /api/me/privacy still accepts the flag for compatibility", async () => {
    const res = await privacyRoute(request("/api/me/privacy", "PATCH", { aiConsent: false }));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.aiConsent).toBe(false);
  });

  test("history stays fully accessible with the flag off — the toggle never gates anything", async () => {
    const list = await conversationsRoute();
    expect(list.status).toBe(200);

    const detail = await conversationDetailRoute(request(`/api/ai/conversations/${seededConversationId}`, "GET"), {
      params: Promise.resolve({ id: seededConversationId }),
    });
    expect(detail.status).toBe(200);
    const body = await resBody(detail);
    const messages = (body.conversation as { messages: unknown[] }).messages;
    expect(messages).toHaveLength(2);
  });

  test("revocation never deletes data — history survives unchanged", async () => {
    expect(await db.aiConversation.count({ where: { id: seededConversationId } })).toBe(1);
    expect(await db.aiMessage.count({ where: { conversationId: seededConversationId } })).toBe(2);
  });
});
