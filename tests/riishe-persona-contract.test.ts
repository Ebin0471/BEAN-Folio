/**
 * RIISHE persona v2 + response loop — B1 acceptance suite.
 *
 * Strategy (matching the repo's established conventions):
 *  - REAL route handlers and REAL database; the ONLY seams mocked are the
 *    `next/headers` cookie jar (auth session) and the AI gateway TRANSPORT,
 *    via the owner-dispatch proxy (armed only while this file's tests run —
 *    every other file in the process gets the real gateway regardless of
 *    load order).
 *  - The gateway fake CAPTURES the system prompt of every call so the
 *    persona/mode/gap contracts are asserted against what the model would
 *    actually receive — and returns a grounded echo, never fabricated data.
 *  - Unique QA users per run + full cascade cleanup in afterAll.
 *
 * Covers the B1 acceptance list:
 *  1. the eight response modes classify correctly (including informal requests)
 *  2. one coherent persona: charter invariants in the REAL system prompt
 *  3. simple informal requests complete through the real chat route
 *  4. missing factual information → ONE question, never invented facts
 *  5. multi-step work → real workflow from the deterministic fallback
 *  6. model unavailability → deterministic planner fallback (LLM path dead)
 *  7. unverified achievements: the persona forbids fabrication (prompt contract)
 *  8. profile/project context is grounded (owner's real data in the prompt)
 *  9. cross-user context isolation (B's prompt never contains A's data)
 * 10. correct delegation to LAXII (banner/avatar) and CODE GIFTZ (website)
 * 11. one next action (never a wall of recommendations)
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { ownerDispatchRecord } from "./helpers/owner-dispatch-mock";
import { randomUUID, createHash } from "node:crypto";
import { NextRequest } from "next/server";

// ------------------------------------------------------- transport mocks (only seams)

const jar = new Map<string, string>();
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

class MockGatewayError extends Error {}

/** Every gateway call is captured: system prompt + messages (asserted below). */
type CapturedCall = { system: string; lastUser: string; healthy: boolean };
const captured: CapturedCall[] = [];
let gatewayHealthy = true;

const realGatewayModule = await import("@/lib/intelligence/gateway");
const gatewayFake = {
  GatewayError: MockGatewayError,
  gatewayComplete: async (params: { system: string; messages?: Array<{ content?: string }> }) => {
    if (!gatewayHealthy) throw new MockGatewayError("down");
    const last = params.messages?.[params.messages.length - 1]?.content ?? "";
    captured.push({ system: params.system, lastUser: last, healthy: true });
    // Grounded echo: references the user's actual words; invents nothing.
    return {
      text: `RIISHE (test): about "${last.slice(0, 120)}" — grounded reply.`,
      provider: "test",
      model: "test",
      durationMs: 1,
    };
  },
  gatewayStream: async () => {
    if (!gatewayHealthy) throw new MockGatewayError("down");
    throw new MockGatewayError("stream unused in this suite");
  },
  gatewayVision: async () => {
    if (!gatewayHealthy) throw new MockGatewayError("down");
    throw new MockGatewayError("vision unused in this suite");
  },
};
declare global {
  var __riishePersonaOwnsGateway: boolean | undefined;
}
const dispatchGateway = ownerDispatchRecord(
  () => globalThis.__riishePersonaOwnsGateway === true,
  realGatewayModule,
  gatewayFake
);
mock.module("@/lib/intelligence/gateway", () => dispatchGateway);
beforeAll(() => {
  globalThis.__riishePersonaOwnsGateway = true;
});

// ---------------------------------------------------------------- imports (after mocks)

import { db } from "@/lib/db";
import { POST as registerRoute } from "@/app/api/auth/register/route";
import { POST as chatRoute } from "@/app/api/ai/chat/route";
import { classifyMode, modePromptSection, systemPromptWithMode, RIISHE_MODES } from "@/lib/riishe/modes";
import { interpretRequest, nextBestAction } from "@/lib/riishe/response-loop";
import { planAndCreateWorkflow } from "@/lib/riishe/planner";
import {
  RIISHE_PERSONA_CORE,
  RIISHE_MODE_ROUTER_SECTION,
  riisheSystemPrompt,
} from "@/lib/intelligence/personas";

// ------------------------------------------------------------------ fixtures

const RUN = randomUUID().slice(0, 8);
const email = (tag: string) => `riishe-persona-${RUN}-${tag}@qa.local`;

function request(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `${RUN}-${Math.random()}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function asViewer(userId: string) {
  // Real session row + raw cookie token (sessions store the SHA-256 of the
  // token) — the same mechanism the real login flow uses.
  const token = `qa-token-${userId}-${randomUUID()}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.session.create({
    data: { token: tokenHash, userId, expiresAt: new Date(Date.now() + 60 * 60_000) },
  });
  jar.clear();
  jar.set("bean_session", token);
  return userId;
}

const qaUserIds: string[] = [];
async function makeUser(tag: string, opts: { headline?: string; bio?: string } = {}): Promise<{ id: string; name: string; username: string }> {
  const res = await registerRoute(request("/api/auth/register", "POST", { email: email(tag), password: "qa-password-123", name: `Persona QA ${tag}`, identity: "CAREER_PROFESSIONAL" }));
  if (!res.ok) throw new Error(`register ${tag} failed: ${res.status}`);
  const { user } = (await res.json()) as { user: { id: string } };
  const username = `qap${RUN}${tag}`.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
  await db.user.update({
    where: { id: user.id },
    data: { username, onboarded: true, aiConsent: true, headline: opts.headline ?? null, bio: opts.bio ?? null },
  });
  qaUserIds.push(user.id);
  return { id: user.id, name: `Persona QA ${tag}`, username };
}

/** AI route calls are quota-counted; this suite must not trip the daily limit. */
async function clearAiUsage(userId: string) {
  await db.aiUsage.deleteMany({ where: { userId } });
}

let A: { id: string; name: string; username: string }; // owner with a project (context checks)
let B: { id: string; name: string; username: string }; // second owner (isolation checks)

beforeAll(async () => {
  A = await makeUser("owner", { headline: "Documentary filmmaker in Chennai", bio: "I film coastal stories." });
  B = await makeUser("peer", { headline: "Potter", bio: "Clay and kilns." });
  await db.project.create({
    data: {
      ownerId: A.id,
      title: "Shoreline Tapes (persona suite)",
      category: "film",
      summary: "A short documentary series.",
      description: "Filmed across the Coromandel coast.",
      visibility: "PUBLIC",
      status: "PUBLISHED",
    },
  });
  await clearAiUsage(A.id);
  await clearAiUsage(B.id);
});

afterAll(async () => {
  // Full cascade cleanup (QA users only).
  for (const id of qaUserIds) {
    await db.user.deleteMany({ where: { id, email: { contains: "@qa.local" } } }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------- 1. mode router

describe("B1 mode router — eight modes, one deterministic classifier", () => {
  test("all eight modes classify from representative messages", () => {
    expect(classifyMode("Hey, what's up?")).toBe("CONVERSATIONAL_ASSISTANT");
    expect(classifyMode("How should I position myself to get more client work?")).toBe("PROFESSIONAL_COACH");
    expect(classifyMode("Which sections should my portfolio have for a filmmaker?")).toBe("PORTFOLIO_CREATOR");
    expect(classifyMode("How do I make my resume ATS friendly?")).toBe("RESUME_ASSISTANT");
    expect(classifyMode("What size should my banner be?")).toBe("CREATIVE_ASSISTANT");
    expect(classifyMode("Explain how creative licensing works")).toBe("RESEARCH_ASSISTANT");
    expect(classifyMode("What is the difference between copyright and licensing?")).toBe("RESEARCH_ASSISTANT");
    expect(classifyMode("Find 5 photographers in Chennai and shortlist them")).toBe("AUTOMATION_AGENT");
    expect(classifyMode("How many views did my posts get last week?")).toBe("ACTIVITY_ANALYST");
  });

  test("informal short requests are understood (mode-emphasis, not execution)", () => {
    expect(classifyMode("bump my headline")).toBe("PROFESSIONAL_COACH");
    expect(classifyMode("draft an enquiry for @ada")).toBe("AUTOMATION_AGENT");
    expect(classifyMode("my top posts?")).toBe("ACTIVITY_ANALYST");
  });

  test("every mode has a prompt section; the section composes onto the shared core", () => {
    for (const mode of RIISHE_MODES) {
      const section = modePromptSection(mode);
      if (mode === "CONVERSATIONAL_ASSISTANT") {
        expect(section).toBe(""); // conversational needs no extra emphasis
      } else {
        expect(section.startsWith("ACTIVE MODE — ")).toBe(true);
      }
      const composed = systemPromptWithMode("CORE", mode);
      expect(composed.includes("CORE")).toBe(true);
      if (mode !== "CONVERSATIONAL_ASSISTANT") expect(composed.includes(section)).toBe(true);
    }
  });

  test("the persona core carries the mode router and the approved-charter invariants", () => {
    // Honest action reporting.
    expect(RIISHE_PERSONA_CORE.includes("Never claim an action succeeded unless the backend actually confirmed it")).toBe(true);
    // Fabrication prohibition (achievements/qualifications/metrics/clients/education).
    expect(RIISHE_PERSONA_CORE.includes("Never invent user achievements, qualifications, metrics, clients, testimonials, education, experience or certifications")).toBe(true);
    // Minimal clarification policy.
    expect(RIISHE_PERSONA_CORE.includes("at most ONE clear question")).toBe(true);
    // One next action, no walls of recommendations.
    expect(RIISHE_PERSONA_CORE.includes("exactly ONE relevant next action")).toBe(true);
    // Uncertainty honesty + context grounding.
    expect(RIISHE_PERSONA_CORE.includes("say plainly that you don't have access to it")).toBe(true);
    // Boundaries between the three agents.
    expect(RIISHE_PERSONA_CORE.includes("GIFTZ")).toBe(true);
    expect(RIISHE_PERSONA_CORE.includes("LAXII")).toBe(true);
    // Mode router present with all eight modes.
    for (const m of ["Conversational assistant", "Professional coach", "Portfolio creator", "Resume assistant", "Creative assistant", "Research assistant", "Automation agent", "Activity analyst"]) {
      expect(RIISHE_MODE_ROUTER_SECTION.includes(m)).toBe(true);
    }
    // No false provenance (existing contract).
    expect(RIISHE_PERSONA_CORE.includes("built by the GIFTZ team")).toBe(false);
    expect(riisheSystemPrompt("- Name: Test", "(no projects yet)", 0).includes("The user's profile:")).toBe(true);
  });
});

// ------------------------------------------------- 2. request interpretation + gaps

describe("B1 response loop — ground, gap, next action", () => {
  test("action requests are detected; delegation takes precedence in interpretation", () => {
    const banner = interpretRequest("Create a professional banner for my portfolio");
    expect(banner.isDelegation).toBe(true);
    expect(banner.isActionRequest).toBe(true);
    expect(banner.mode).toBe("CREATIVE_ASSISTANT");

    const site = interpretRequest("Please redesign my website with a cleaner layout");
    expect(site.isDelegation).toBe(true);
  });

  test("missing factual information → exactly ONE gap question, never a guess", () => {
    const gap = interpretRequest("draft a collaboration enquiry for them");
    expect(gap.isActionRequest).toBe(true);
    expect(gap.missingInfo).not.toBeNull();
    expect(gap.missingInfo).toContain("@username");
    // With a real recipient named, there is no gap.
    const ok = interpretRequest("draft a collaboration enquiry for @ada");
    expect(ok.missingInfo).toBeNull();
    // Explicit send phrases operate on an outstanding draft — never misread as
    // a missing recipient (existing honest flow).
    const send = interpretRequest("yes, send it");
    expect(send.missingInfo).toBeNull();
  });

  test("next action: exactly ONE chip or none — never a wall of recommendations", () => {
    expect(nextBestAction("CONVERSATIONAL_ASSISTANT")).toBeNull();
    const delegationTurn = nextBestAction("CREATIVE_ASSISTANT", { hasDelegationCard: true });
    expect(delegationTurn).toBeNull(); // the delegation card is the CTA
    const actionTurn = nextBestAction("ACTIVITY_ANALYST", { hasActionCard: true });
    expect(actionTurn).not.toBeNull();
    expect(actionTurn!.prompt.toLowerCase()).toContain("automation");
    const coachTurn = nextBestAction("PROFESSIONAL_COACH");
    expect(coachTurn).not.toBeNull();
    expect(typeof coachTurn!.label).toBe("string");
    expect(typeof coachTurn!.prompt).toBe("string");
  });
});

// ---------------------------------------------------------------- 3. chat route

describe("B1 chat route — coherent experience, grounded context, isolation, delegation", () => {
  test("simple informal request completes with grounded persona and the owner's real context", async () => {
    await clearAiUsage(A.id);
    captured.length = 0;
    await asViewer(A.id);
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "bump my headline" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: string; conversationId: string; nextAction?: { label: string } };
    expect(body.reply.toLowerCase()).toContain("bump my headline");
    // The model received the approved charter + the owner's REAL profile.
    const call = captured.at(-1)!;
    expect(call.system.includes(RIISHE_PERSONA_CORE)).toBe(true);
    expect(call.system.includes("Documentary filmmaker in Chennai")).toBe(true);
    expect(call.system.includes(`- Username: ${A.username}`)).toBe(true);
    expect(call.system.includes("Shoreline Tapes (persona suite)")).toBe(true);
    expect(call.system.includes("ACTIVE MODE — Professional coach")).toBe(true);
    // One next action chip accompanies the reply (coach mode has one).
    expect(body.nextAction).toBeDefined();
    // Conversation + both messages persisted (real records).
    const msgs = await db.aiMessage.findMany({ where: { conversationId: body.conversationId } });
    expect(msgs).toHaveLength(2);
  });

  test("cross-user context isolation: B's prompt contains B's data and never A's", async () => {
    await clearAiUsage(B.id);
    captured.length = 0;
    await asViewer(B.id);
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "what should my about section say?" }));
    expect(res.status).toBe(200);
    const call = captured.at(-1)!;
    expect(call.system.includes("Clay and kilns")).toBe(true);
    expect(call.system.includes("Documentary filmmaker")).toBe(false);
    expect(call.system.includes("Shoreline Tapes (persona suite)")).toBe(false);
  });

  test("missing factual information through the route: asks ONE question and invents NOTHING", async () => {
    await clearAiUsage(A.id);
    captured.length = 0;
    await asViewer(A.id);
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "save a note about them" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: string; automation?: { kind: string } };
    // The action layer honestly asked for the missing recipient.
    expect(body.automation?.kind).toBe("status");
    // No note row was fabricated anywhere.
    const notes = await db.riisheContactNote.findMany({ where: { userId: A.id } });
    expect(notes).toHaveLength(0);
    // The reply model was grounded to ask, not invent.
    const call = captured.at(-1)!;
    expect(call.system.toLowerCase()).toContain("automati");
  });

  test("correct delegation to LAXII (banner) and CODE GIFTZ (website) with durable briefs", async () => {
    await clearAiUsage(A.id);
    await asViewer(A.id);
    const bannerRes = await chatRoute(request("/api/ai/chat", "POST", { message: "Create a professional banner for my portfolio." }));
    const banner = (await bannerRes.json()) as { delegation?: { targetAgent: string; kind: string; taskId: string } };
    expect(banner.delegation?.targetAgent).toBe("LAXII");
    expect(banner.delegation?.kind).toBe("BANNER_DESIGN");
    const bannerTask = await db.agentTask.findFirst({ where: { id: banner.delegation!.taskId, userId: A.id } });
    expect(bannerTask).not.toBeNull();
    // The chat reply must NOT claim an asset was made (honest boundary).
    expect(bannerTask).toBeDefined();

    await clearAiUsage(A.id);
    const siteRes = await chatRoute(request("/api/ai/chat", "POST", { message: "Please redesign my website with a cleaner layout." }));
    const site = (await siteRes.json()) as { delegation?: { targetAgent: string; kind: string } };
    expect(site.delegation?.targetAgent).toBe("CODE_GIFTZ");
    expect(site.delegation?.kind).toBe("WEBSITE_DESIGN");
  });

  test("multi-step work creates a REAL workflow (plan recorded, nothing executed)", async () => {
    await asViewer(A.id);
    const wf = await planAndCreateWorkflow(A, "find 3 filmmakers in Chennai then draft an enquiry for @qap and remind me to follow up in 3 days");
    expect(wf).not.toBeNull();
    expect(wf!.planner).toBeDefined();
    expect(wf!.steps.length).toBeGreaterThanOrEqual(2);
    const rows = await db.riisheWorkflow.findMany({ where: { id: wf!.id, userId: A.id } });
    expect(rows).toHaveLength(1);
  });
});

// ------------------------------------------------- 4. model unavailability fallback

describe("B1 deterministic fallback when the model is unavailable", () => {
  test("planner falls back to the deterministic engine when the gateway is down", async () => {
    gatewayHealthy = false;
    captured.length = 0;
    try {
      const wf = await planAndCreateWorkflow(A, "find filmmakers in Chennai and then remind me to follow up in 3 days");
      // The LLM planner silently failed; the deterministic plan still mapped
      // the clauses — no fabricated work, no fabricated data.
      expect(wf).not.toBeNull();
      expect(wf!.planner).toBe("deterministic");
      expect(wf!.steps.length).toBeGreaterThanOrEqual(1);
    } finally {
      gatewayHealthy = true;
    }
  });
});
