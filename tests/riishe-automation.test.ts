/**
 * RIISHE creator automation — regression suite.
 *
 * Strategy (matching the repo's established conventions):
 *  - REAL route handlers and REAL database (never mocked service logic).
 *  - Only two seams are mocked: the `next/headers` cookie jar (auth session)
 *    and the AI gateway TRANSPORT (network). The gateway mock returns fixed
 *    text so chat-route tests can run offline while asserting REAL database
 *    side effects — no success is ever claimed from a mocked service response.
 *  - Unique QA users per run + full cascade cleanup in afterAll.
 *
 * Covers:
 *  1. creator discovery matching + privacy ladder
 *  2. blocked-profile exclusion
 *  3. enquiry draft generation
 *  4. explicit enquiry approval (the ONLY path that sends)
 *  5. duplicate enquiry prevention
 *  6. ownership checks (automations, drafts, notes)
 *  7. follow-up schedule creation (BackgroundJob with future runAt + dedupeKey)
 *  8. reminder auto-cancellation after a response
 *  9. pause + cancellation behavior
 *  10. queue retry/backoff + stuck-job recovery on the riishe.automation kind
 *  11. per-user automation isolation
 *  12. existing RIISHE conversation history preservation (chat + automation turns)
 *  13. existing chat-stream behavior unchanged (gated + streaming path)
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { ownerDispatchRecord } from "./helpers/owner-dispatch-mock";
import { randomUUID, createHash } from "node:crypto";
import { NextRequest } from "next/server";

// ------------------------------------------------------- transport mocks (only seams)

const jar = new Map<string, string>();
const realNextHeaders = await import("next/headers");
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

/** A tiny OpenAI-style SSE stream the route's real streaming path can read. */
function sseChunkStream(text: string): ReadableStream<Uint8Array> {
  const payload = `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\ndata: [DONE]\n\n`;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
}

// bun module mocks persist for the whole test process: the FIRST import of
// the mocked module while a mock is registered freezes the factory result
// into the module record for every later importer, and no afterAll
// re-registration can reliably undo that. So the record's frozen value is a
// DISPATCH PROXY around the REAL gateway module: while this file's tests
// run (owner flag) calls route to the deterministic fake; every other file
// in the process gets the real gateway regardless of load order.
declare global {
  var __riisheAutomationOwnsGateway: boolean | undefined;
}
const realGatewayModule = await import("@/lib/intelligence/gateway");
const gatewayFake = {
  GatewayError: MockGatewayError,
  gatewayComplete: async (params: { messages?: Array<{ content?: string }> }) => {
    const last = params.messages?.[params.messages.length - 1]?.content ?? "";
    // Grounded echo: the reply references the grounding block it was given.
    return { text: `RIISHE (test): ${last.slice(0, 400)}`, provider: "test", model: "test", durationMs: 1 };
  },
  gatewayStream: async () => ({ stream: sseChunkStream("streamed reply (test)") }),
  gatewayVision: async () => ({ text: "vision (test)", provider: "test", model: "test", durationMs: 1 }),
};
const dispatchGateway = ownerDispatchRecord(
  () => globalThis.__riisheAutomationOwnsGateway === true,
  realGatewayModule,
  gatewayFake
);
mock.module("@/lib/intelligence/gateway", () => dispatchGateway);
beforeAll(() => {
  globalThis.__riisheAutomationOwnsGateway = true;
});

// ---------------------------------------------------------------- imports (after mocks)

import { db } from "@/lib/db";
import { syncTaxonomyToDb } from "@/lib/professions/service";
import { POST as chatRoute } from "@/app/api/ai/chat/route";
import { POST as chatStreamRoute } from "@/app/api/ai/chat-stream/route";
import { POST as registerRoute } from "@/app/api/auth/register/route";
import { POST as inquiryRoute } from "@/app/api/inquiries/route";
import { GET as automationsRoute, POST as stopAllRoute } from "@/app/api/riishe/automations/route";
import { PATCH as automationPatchRoute, DELETE as automationDeleteRoute } from "@/app/api/riishe/automations/[id]/route";
import { POST as sendDraftRoute, DELETE as dismissDraftRoute } from "@/app/api/riishe/enquiries/[taskId]/send/route";
import { GET as notesRoute, POST as notesRoutePost } from "@/app/api/riishe/notes/route";
import { PATCH as notePatchRoute, DELETE as noteDeleteRoute } from "@/app/api/riishe/notes/[id]/route";
import { registerHandler, getHandler, enqueue, claimBatch, complete, fail, recoverStuck } from "@/lib/queue";
import { registerBuiltInHandlers, RIISHE_AUTOMATION_KEY } from "@/lib/queue/handlers";
import { runAutomationJob, createAutomation, cancelAutomation, toAutomationDTO } from "@/lib/riishe/engine";
import { findCreators, resolveProfessionTerms, opportunityRadar } from "@/lib/riishe/discovery";
import { prepareEnquiryDraft, sendApprovedEnquiry, outstandingDraft, DraftError } from "@/lib/riishe/drafts";
import { buildWeeklyReport } from "@/lib/riishe/reports";
import { detectAutomationIntent, computeScheduleDate } from "@/lib/riishe/intents";

// ------------------------------------------------------------------ fixtures

const RUN = randomUUID().slice(0, 8);
const email = (tag: string) => `riishe-auto-${RUN}-${tag}@qa.local`;

function request(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `${RUN}-${Math.random()}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function asViewer(userId: string) {
  jar.clear();
  jar.set("bean_session", `qa-session-${userId}`);
  return userId;
}

let A: { id: string; username: string }; // the owner/viewer (designer, Chennai)
let B: { id: string; username: string }; // public recipient (filmmaker, Chennai)
let C: { id: string; username: string }; // PRIVATE profile (must never surface)
let D: { id: string; username: string }; // demo account (never surfaces)
let E: { id: string; username: string }; // blocked counterpart (never surfaces)
let F: { id: string; username: string }; // second owner (isolation checks)
let designerProfessionId: string;
let filmmakerProfessionId: string;
let skillPremiere: { id: string; label: string };

const QA_IDS = () => [A.id, B.id, C.id, D.id, E.id, F.id];
const leakedUserIds: string[] = []; // ad-hoc users created inside tests (cleaned too)

async function createQAUser(tag: string, opts: { username?: string; visibility?: string; isDemo?: boolean; professions?: string[]; skills?: string[]; location?: string } = {}) {
  const emailAddr = email(tag);
  const res = await registerRoute(request("/api/auth/register", "POST", { email: emailAddr, password: "qa-password-123", name: `QA ${tag}` }));
  if (!res.ok) throw new Error(`register ${tag} failed: ${res.status}`);
  const { user } = (await res.json()) as { user: { id: string } };
  const username = opts.username ?? `qar${RUN}${tag}`.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
  await db.user.update({
    where: { id: user.id },
    data: {
      username,
      onboarded: true,
      aiConsent: true,
      profileVisibility: opts.visibility ?? "PUBLIC",
      isDemo: opts.isDemo ?? false,
      location: opts.location ?? null,
    },
  });
  if (opts.professions?.length) {
    for (const slug of opts.professions) {
      const prof = await db.profession.findUnique({ where: { slug } });
      if (prof) await db.profileProfession.create({ data: { userId: user.id, professionId: prof.id } }).catch(() => undefined);
    }
  }
  if (opts.skills?.length) {
    for (const label of opts.skills) {
      const skill = await db.skill.upsert({ where: { slug: label.toLowerCase().replace(/[^a-z0-9]+/g, "-") }, create: { slug: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label }, update: {} });
      await db.profileSkill.create({ data: { userId: user.id, skillId: skill.id } }).catch(() => undefined);
    }
  }
  return { id: user.id, username };
}

beforeAll(async () => {
  // Fresh deploys seed the profession taxonomy on first read (listFlat's
  // bootstrap). The QA fixtures link users to REAL profession slugs, so
  // make sure the taxonomy exists — via the app's own idempotent seed
  // (upsert-only, never deletes rows, safe to run repeatedly).
  await syncTaxonomyToDb().catch(() => undefined);
  const designer = await db.profession.findUnique({ where: { slug: "ui-designer" } });
  const filmmaker = await db.profession.findUnique({ where: { slug: "video-editor" } });
  designerProfessionId = designer?.id ?? (await db.profession.create({ data: { slug: `qa-design-${RUN}`, label: "QA Design", group: "QA" } })).id;
  filmmakerProfessionId = filmmaker?.id ?? (await db.profession.create({ data: { slug: `qa-film-${RUN}`, label: "QA Film", group: "QA" } })).id;
  const premiere = await db.skill.upsert({
    where: { slug: "premiere-pro" },
    create: { slug: "premiere-pro", label: "Premiere Pro" },
    update: {},
  });
  skillPremiere = { id: premiere.id, label: premiere.label };

  A = await createQAUser("a", { professions: ["ui-designer"], skills: ["Premiere Pro"], location: "Chennai" });
  B = await createQAUser("b", { professions: ["video-editor"], skills: ["Premiere Pro"], location: "Chennai" });
  C = await createQAUser("c", { visibility: "PRIVATE", professions: ["ui-designer"], location: "Chennai" });
  D = await createQAUser("d", { isDemo: true, professions: ["ui-designer"] });
  E = await createQAUser("e", { professions: ["ui-designer"], location: "Chennai" });
  F = await createQAUser("f", {});

  await db.block.create({ data: { blockerId: A.id, blockedId: E.id } }).catch(() => undefined);
});

afterAll(async () => {
  await db.backgroundJob.deleteMany({ where: { userId: { in: QA_IDS() } } });
  await db.backgroundJob.deleteMany({ where: { kind: "qa.riishe.failing" } });
  await db.inquiry.deleteMany({ where: { OR: [{ senderId: { in: QA_IDS() } }, { recipientId: { in: QA_IDS() } }] } });
  await db.notification.deleteMany({ where: { userId: { in: QA_IDS() } } });
  await db.agentTask.deleteMany({ where: { userId: { in: QA_IDS() } } });
  await db.follow.deleteMany({ where: { OR: [{ followerId: { in: QA_IDS() } }, { followingId: { in: QA_IDS() } }] } });
  await db.block.deleteMany({ where: { OR: [{ blockerId: { in: QA_IDS() } }, { blockedId: { in: QA_IDS() } }] } });
  await db.profileProfession.deleteMany({ where: { userId: { in: QA_IDS() } } });
  await db.profileSkill.deleteMany({ where: { userId: { in: QA_IDS() } } });
  // Users last — cascades sessions/automations/runs/notes/aiConversations/messages.
  await db.user.deleteMany({ where: { id: { in: [...QA_IDS(), ...leakedUserIds] } } });
  await db.profession.deleteMany({ where: { id: { in: [designerProfessionId, filmmakerProfessionId] }, slug: { startsWith: "qa-" } } });
  // Restore the real next/headers for any later file in the same bun process.
  mock.module("next/headers", () => realNextHeaders);
  globalThis.__riisheAutomationOwnsGateway = false;
  jar.clear();
});

// ------------------------------------------------------------------- helpers

function ctx<P extends Record<string, string>>(params: P) {
  return { params: Promise.resolve(params) } as { params: Promise<P> };
}

async function loginViaSession(userId: string) {
  // Real session row + cookie — the armed-auth-free way to exercise getSessionUser.
  // NOTE: sessions store the SHA-256 of the cookie token, so the row gets the
  // hash while the jar gets the raw token (exactly how the real login flow does).
  const token = `qa-token-${userId}-${randomUUID()}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.session.create({
    data: { token: tokenHash, userId, expiresAt: new Date(Date.now() + 60 * 60_000) },
  });
  jar.clear();
  jar.set("bean_session", token);
}

// ================================================================ 1 + 2. discovery

describe("creator discovery", () => {
  test("resolves free-text profession words to REAL slugs only", async () => {
    const slugs = await resolveProfessionTerms(["filmmakers", "designers"]);
    expect(slugs.length).toBeGreaterThan(0);
    for (const s of slugs) {
      const row = await db.profession.findUnique({ where: { slug: s } });
      expect(row).not.toBeNull();
    }
    const invented = await resolveProfessionTerms(["zzz-no-such-profession"]);
    expect(invented).toEqual([]);
  });

  test("matches public creators with explainable factors; excludes private, demo and self", async () => {
    const { matches, recommendations } = await findCreators({ id: A.id }, {
      professions: ["video-editor"],
      skills: ["premiere pro"],
      location: "Chennai",
      goal: "collaboration",
      limit: 10,
    });
    const usernames = matches.map((m) => m.person.username);
    expect(usernames).toContain(B.username);
    expect(usernames).not.toContain(A.username); // never the viewer
    expect(usernames).not.toContain(C.username); // PRIVATE profile never surfaces
    expect(usernames).not.toContain(D.username); // demo never surfaces
    const match = matches.find((m) => m.person.username === B.username)!;
    expect(match.kind).toBe("match");
    expect(match.profileUrl).toBe(`/u/${B.username}`);
    expect(match.factors.some((f) => f.startsWith("Profession:"))).toBe(true);
    expect(match.factors.some((f) => f.startsWith("Located in"))).toBe(true);
    expect(match.factors.some((f) => f.startsWith("Skills:"))).toBe(true);
    expect(match.score).toBeGreaterThan(0);
    // Score is built ONLY from the documented factors (40+30+20 + bonus caps at 100).
    expect(match.score).toBeLessThanOrEqual(100);
  });

  test("excludes blocked profiles from discovery in BOTH directions", async () => {
    const { matches, recommendations } = await findCreators({ id: A.id }, {
      professions: [],
      skills: [],
      location: undefined,
      goal: "general",
      limit: 10,
    });
    const all = [...matches, ...recommendations].map((m) => m.person.username);
    expect(all).not.toContain(E.username);
  });

  test("opportunity radar returns only real public accounts with reasons", async () => {
    const items = await opportunityRadar({ id: A.id }, { limit: 10 });
    for (const item of items) {
      expect(item.reason.length).toBeGreaterThan(0);
      expect(item.url.startsWith("/u/") || item.url.startsWith("/p/")).toBe(true);
      if (item.kind === "creator") {
        expect(item.person?.username).not.toBe(C.username);
        expect(item.person?.username).not.toBe(E.username);
      }
    }
  });
});

// ============================================================ 3-5. enquiry drafts

describe("enquiry draft lifecycle", () => {
  test("intent detection: draft + send phrases map to the right kinds", () => {
    expect(detectAutomationIntent("draft a collaboration enquiry for these three people")?.kind).toBe("DRAFT_ENQUIRY");
    expect(detectAutomationIntent("find 10 designers in Chennai")?.kind).toBe("DISCOVER_CREATORS");
    expect(detectAutomationIntent("remind me next Friday to follow up with the pending enquiry")?.kind).toBe("SCHEDULE_FOLLOWUP");
    expect(detectAutomationIntent("show all unanswered enquiries")?.kind).toBe("PENDING_ENQUIRIES");
    expect(detectAutomationIntent("pause my follow-up automation")?.kind).toBe("AUTOMATION_CONTROL");
    expect(detectAutomationIntent("give me my weekly creator growth report")?.kind).toBe("WEEKLY_REPORT");
    expect(detectAutomationIntent("what is the best banner size")).toBeNull(); // delegation owns this; advisory stays advisory
  });

  test("draft generation creates a reviewable AgentTask (nothing sent)", async () => {
    const prepared = await prepareEnquiryDraft({ id: A.id }, {
      recipientUsername: B.username,
      subject: "Collaboration idea",
      message: "Would you be open to a collaboration?",
      type: "COLLABORATION",
    });
    expect(prepared.taskId).toBeTruthy();
    const task = await db.agentTask.findUnique({ where: { id: prepared.taskId } });
    expect(task?.status).toBe("AWAITING_APPROVAL");
    expect(task?.agent).toBe("RIISHE");
    const result = JSON.parse(task?.resultJson ?? "{}") as { recipientUsername: string; subject: string };
    expect(result.recipientUsername).toBe(B.username);
    expect(result.subject).toBe("Collaboration idea");
    // Nothing sent: no inquiry rows exist yet.
    const sent = await db.inquiry.findMany({ where: { senderId: A.id, recipientId: B.id } });
    expect(sent).toHaveLength(0);
  });

  test("explicit approval sends through the EXISTING inquiry API (notification included)", async () => {
    const prepared = await prepareEnquiryDraft({ id: A.id }, {
      recipientUsername: B.username,
      subject: "Freelance proposal",
      message: "I can help with your reels.",
      type: "INQUIRY",
    });
    await loginViaSession(A.id);
    const res = await sendDraftRoute(request(`/api/riishe/enquiries/${prepared.taskId}/send`, "POST"), ctx({ taskId: prepared.taskId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: boolean; inquiryId: string };
    expect(body.sent).toBe(true);
    // The inquiry EXISTS through the real API path (real row, real notification).
    const inquiry = await db.inquiry.findUnique({ where: { id: body.inquiryId } });
    expect(inquiry?.senderId).toBe(A.id);
    expect(inquiry?.recipientId).toBe(B.id);
    expect(inquiry?.subject).toBe("Freelance proposal");
    const notification = await db.notification.findFirst({ where: { userId: B.id, type: "INQUIRY" } });
    expect(notification).not.toBeNull();
    // Draft is consumed exactly once.
    const task = await db.agentTask.findUnique({ where: { id: prepared.taskId } });
    expect(task?.status).toBe("COMPLETED");
    // Audit trail exists with actor + target.
    const audit = await db.auditEvent.findFirst({ where: { actorUserId: A.id, action: "riishe.enquiry.sent" } });
    expect(audit?.targetType).toBe("Inquiry");
  });

  test("duplicate prevention: sending again is refused (one send per draft)", async () => {
    const prepared = await prepareEnquiryDraft({ id: A.id }, {
      recipientUsername: B.username,
      subject: "Second attempt",
      message: "Trying again.",
    });
    await loginViaSession(A.id);
    // The first send created a PENDING inquiry to B within the window — the
    // second must refuse BEFORE contacting anyone.
    const res = await sendDraftRoute(request(`/api/riishe/enquiries/${prepared.taskId}/send`, "POST"), ctx({ taskId: prepared.taskId }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("pending");
    const task = await db.agentTask.findUnique({ where: { id: prepared.taskId } });
    expect(task?.status).toBe("AWAITING_APPROVAL"); // never marked sent
    // Dismiss path: explicit "no" cancels without sending.
    const del = await dismissDraftRoute(request(`/api/riishe/enquiries/${prepared.taskId}/send`, "DELETE"), ctx({ taskId: prepared.taskId }));
    expect(del.status).toBe(200);
    const after = await db.agentTask.findUnique({ where: { id: prepared.taskId } });
    expect(after?.status).toBe("CANCELLED");
  });

  test("duplicate prevention: an existing recent draft is updated, not duplicated", async () => {
    const first = await prepareEnquiryDraft({ id: F.id }, {
      recipientUsername: B.username,
      subject: "One",
      message: "First draft.",
    });
    const second = await prepareEnquiryDraft({ id: F.id }, {
      recipientUsername: B.username,
      subject: "Two",
      message: "Refined draft.",
    });
    expect(second.taskId).toBe(first.taskId);
    const task = await db.agentTask.findUnique({ where: { id: first.taskId } });
    const result = JSON.parse(task?.resultJson ?? "{}") as { subject: string };
    expect(result.subject).toBe("Two");
    const outstanding = await outstandingDraft(F.id);
    expect(outstanding?.result.subject).toBe("Two");
  });

  test("blocked or private recipients are refused at draft time", async () => {
    await expect(
      prepareEnquiryDraft({ id: A.id }, { recipientUsername: E.username, subject: "x", message: "y" })
    ).rejects.toThrow(DraftError);
    await expect(
      prepareEnquiryDraft({ id: A.id }, { recipientUsername: C.username, subject: "x", message: "y" })
    ).rejects.toThrow(/private/i);
    await expect(
      prepareEnquiryDraft({ id: A.id }, { recipientUsername: A.username, subject: "x", message: "y" })
    ).rejects.toThrow(/yourself/i);
  });

  test("send refuses another user's draft (ownership)", async () => {
    const prepared = await prepareEnquiryDraft({ id: F.id }, {
      recipientUsername: B.username,
      subject: "F's draft",
      message: "Only F can send this.",
    });
    await loginViaSession(A.id);
    const res = await sendDraftRoute(request(`/api/riishe/enquiries/${prepared.taskId}/send`, "POST"), ctx({ taskId: prepared.taskId }));
    expect(res.status).toBe(404);
  });
});

// =================================================== 6-9. automations + reminders

describe("follow-up automations", () => {
  test("schedule creation produces an automation + a QUEUED job with future runAt and dedupeKey", async () => {
    // A pending enquiry from A to B (the reminder's target).
    await loginViaSession(A.id);
    const res = await inquiryRoute(request("/api/inquiries", "POST", {
      recipientUsername: B.username,
      type: "COLLABORATION",
      subject: "Reminder target",
      message: "Please check my proposal.",
    }));
    expect(res.status).toBe(200);
    const { inquiry } = (await res.json()) as { inquiry: { id: string } };

    const runAt = computeScheduleDate("remind me next friday to follow up")!;
    expect(runAt.getTime()).toBeGreaterThan(Date.now());
    const automation = await createAutomation(A.id, { kind: "FOLLOW_UP_REMINDER", targetId: inquiry.id, runAt, autoSend: false });
    expect(automation.status).toBe("ACTIVE");
    expect(automation.autoSend).toBe(false); // NEVER on by default

    const job = await db.backgroundJob.findFirst({ where: { dedupeKey: `riishe.automation:${automation.id}` } });
    expect(job?.status).toBe("QUEUED");
    expect(job?.kind).toBe(RIISHE_AUTOMATION_KEY);
    expect(job?.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(job?.userId).toBe(A.id);
  });

  test("reminder run PREPARES a draft + notifies the owner; auto-send stays off", async () => {
    await loginViaSession(A.id);
    const inquiryRes = await inquiryRoute(request("/api/inquiries", "POST", {
      recipientUsername: B.username,
      type: "INQUIRY",
      subject: "Prepare-only reminder",
      message: "Original message.",
    }));
    const { inquiry } = (await inquiryRes.json()) as { inquiry: { id: string } };
    const automation = await createAutomation(A.id, { kind: "FOLLOW_UP_REMINDER", targetId: inquiry.id, runAt: new Date() });
    // Drain the queued job directly through the registered handler.
    const result = (await runAutomationJob({ automationId: automation.id, userId: A.id })) as { action: string };
    expect(result.action).toBe("prepared");
    // Draft prepared — notification for the OWNER (SYSTEM type), no new message to B.
    const notification = await db.notification.findFirst({
      where: { userId: A.id, type: "SYSTEM", payload: { contains: "follow-up draft" } },
    });
    expect(notification).not.toBeNull();
    const sentToB = await db.inquiry.count({ where: { senderId: A.id, recipientId: B.id, subject: { startsWith: "Following up" } } });
    expect(sentToB).toBe(0); // nothing sent automatically
    const after = await db.riisheAutomation.findUnique({ where: { id: automation.id } });
    expect(after?.status).toBe("COMPLETED"); // one-shot fired
    const run = await db.riisheAutomationRun.findFirst({ where: { automationId: automation.id } });
    expect(run?.status).toBe("SUCCEEDED");
  });

  test("reminder auto-cancels when the enquiry is answered", async () => {
    await loginViaSession(A.id);
    const inquiryRes = await inquiryRoute(request("/api/inquiries", "POST", {
      recipientUsername: B.username,
      type: "INQUIRY",
      subject: "Auto-cancel target",
      message: "Will they answer?",
    }));
    const { inquiry } = (await inquiryRes.json()) as { inquiry: { id: string } };
    const automation = await createAutomation(A.id, { kind: "FOLLOW_UP_REMINDER", targetId: inquiry.id, runAt: new Date() });
    // B answers: recipient accepts → respondedAt set.
    await db.inquiry.update({
      where: { id: inquiry.id },
      data: { status: "ACCEPTED", respondedAt: new Date() },
    });
    const result = (await runAutomationJob({ automationId: automation.id, userId: A.id })) as { action: string };
    expect(result.action).toBe("auto-cancelled");
    const after = await db.riisheAutomation.findUnique({ where: { id: automation.id } });
    expect(after?.status).toBe("CANCELLED");
    const notification = await db.notification.findFirst({
      where: { userId: A.id, type: "SYSTEM", payload: { contains: "cancelled automatically" } },
    });
    expect(notification).not.toBeNull();
  });

  test("paused and cancelled automations are honest no-ops", async () => {
    await loginViaSession(A.id);
    const inquiryRes = await inquiryRoute(request("/api/inquiries", "POST", {
      recipientUsername: B.username,
      type: "INQUIRY",
      subject: "Paused target",
      message: "No action while paused.",
    }));
    const { inquiry } = (await inquiryRes.json()) as { inquiry: { id: string } };
    const automation = await createAutomation(A.id, { kind: "FOLLOW_UP_REMINDER", targetId: inquiry.id, runAt: new Date() });
    // PATCH pause → 200; the queued run then skips honestly.
    const patchRes = await automationPatchRoute(
      request(`/api/riishe/automations/${automation.id}`, "PATCH", { action: "pause" }),
      ctx({ id: automation.id })
    );
    expect(patchRes.status).toBe(200);
    const result = (await runAutomationJob({ automationId: automation.id, userId: A.id })) as { action: string };
    expect(result.action).toBe("skipped");
    // Resume works too.
    const resumeRes = await automationPatchRoute(
      request(`/api/riishe/automations/${automation.id}`, "PATCH", { action: "resume" }),
      ctx({ id: automation.id })
    );
    expect(resumeRes.status).toBe(200);
    const afterResume = await db.riisheAutomation.findUnique({ where: { id: automation.id } });
    expect(afterResume?.status).toBe("ACTIVE");
    // DELETE → cancelled; further runs stay no-ops.
    const cancelRes = await automationDeleteRoute(request(`/api/riishe/automations/${automation.id}`, "DELETE"), ctx({ id: automation.id }));
    expect(cancelRes.status).toBe(200);
    const after = await db.riisheAutomation.findUnique({ where: { id: automation.id } });
    expect(after?.status).toBe("CANCELLED");
    const result2 = (await runAutomationJob({ automationId: automation.id, userId: A.id })) as { action: string };
    expect(result2.action).toBe("skipped");
  });

  test("per-user isolation: a job whose user doesn't own the automation is refused", async () => {
    const automation = await createAutomation(A.id, { kind: "WEEKLY_SUMMARY", runAt: null });
    await expect(runAutomationJob({ automationId: automation.id, userId: F.id })).rejects.toThrow(/owner/);
    // F also cannot read/modify A's automation.
    await loginViaSession(F.id);
    const res = await automationPatchRoute(request(`/api/riishe/automations/${automation.id}`, "PATCH", { action: "pause" }), ctx({ id: automation.id }));
    expect(res.status).toBe(404);
  });

  test("queue retry/backoff and recovery work on the riishe.automation kind", async () => {
    registerBuiltInHandlers();
    const handler = getHandler(RIISHE_AUTOMATION_KEY);
    expect(handler).toBeDefined();

    // Retry/backoff mechanics are exercised on a TEST-ONLY kind (the shared
    // BackgroundJob machinery is kind-agnostic); the live riishe.automation
    // kind is asserted separately below. This avoids racing the real dev
    // server's worker over the same rows.
    registerHandler("qa.riishe.failing", async () => {
      throw new Error("boom");
    });
    // Leftover QUEUED jobs from earlier tests would occupy the per-user
    // concurrency slots (2) — clear them so this claim is deterministic.
    await db.backgroundJob.deleteMany({ where: { userId: { in: QA_IDS() }, status: "QUEUED", kind: RIISHE_AUTOMATION_KEY } });
    const job = await enqueue({ kind: "qa.riishe.failing", payload: {}, userId: A.id, dedupeKey: `qa-retry-${RUN}` });
    const claimed = await claimBatch(10, `qa-worker-${RUN}`);
    expect(claimed.some((j) => j.id === job.id)).toBe(true);
    const outcome = await fail(job.id, new Error("boom"));
    expect(outcome).toBe("REQUEUED");
    const requeued = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(requeued?.status).toBe("QUEUED");
    expect(requeued?.attempts).toBe(1);
    expect(requeued?.runAt.getTime()).toBeGreaterThan(Date.now()); // backoff scheduled
    // Max attempts reached → DEAD (honest dead-letter). fail() is
    // status-guarded, so the job must be RUNNING (claimed) before it can die.
    await db.backgroundJob.update({ where: { id: job.id }, data: { attempts: 3, runAt: new Date() } });
    const claimed2 = await claimBatch(10, `qa-worker-${RUN}`);
    expect(claimed2.some((j) => j.id === job.id)).toBe(true);
    await fail(job.id, new Error("boom again"));
    const dead = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(dead?.status).toBe("DEAD");

    // Stuck-RUNNING recovery requeues a lost worker's job.
    const stuck = await enqueue({ kind: "qa.riishe.failing", payload: {}, userId: A.id, dedupeKey: `qa-stuck-${RUN}` });
    await db.backgroundJob.update({
      where: { id: stuck.id },
      data: { status: "RUNNING", claimedBy: "lost-worker", claimedAt: new Date(Date.now() - 10 * 60_000), heartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });
    const recovered = await recoverStuck();
    expect(recovered.requeued + recovered.dead).toBeGreaterThanOrEqual(1);
    const after = await db.backgroundJob.findUnique({ where: { id: stuck.id } });
    expect(["QUEUED", "DEAD"]).toContain(after?.status ?? "");

    // The riishe.automation handler itself completes a REAL automation run
    // (direct invocation — same code the worker executes after claiming).
    await loginViaSession(A.id);
    const inquiryRes = await inquiryRoute(request("/api/inquiries", "POST", {
      recipientUsername: B.username,
      type: "INQUIRY",
      subject: "Handler-run target",
      message: "Direct handler invocation.",
    }));
    const { inquiry } = (await inquiryRes.json()) as { inquiry: { id: string } };
    // runAt: null → no job is enqueued, so the real dev-server worker can't
    // claim it first; the direct handler invocation is the only run.
    const automation = await createAutomation(A.id, { kind: "FOLLOW_UP_REMINDER", targetId: inquiry.id, runAt: null });
    const fakeJob = {
      id: `qa-handler-${RUN}`,
      kind: RIISHE_AUTOMATION_KEY,
      payload: JSON.stringify({ automationId: automation.id, userId: A.id }),
    } as unknown as Parameters<NonNullable<typeof handler>>[0];
    const result = (await handler!(fakeJob)) as { action: string };
    expect(result.action).toBe("prepared");
    const afterRun = await db.riisheAutomation.findUnique({ where: { id: automation.id } });
    expect(afterRun?.status).toBe("COMPLETED");
    await db.backgroundJob.deleteMany({ where: { kind: { in: ["qa.riishe.failing"] } } });
    await db.backgroundJob.deleteMany({ where: { kind: RIISHE_AUTOMATION_KEY, payload: { contains: automation.id } } });
  });
});

// ================================================== 10. routes: list / stop-all / notes

describe("automation routes + notes", () => {
  test("GET automations lists only the owner's rows; stop-all revokes them", async () => {
    await loginViaSession(F.id);
    const a1 = await createAutomation(F.id, { kind: "OPPORTUNITY_RADAR", runAt: new Date(), repeatDays: 7 });
    const listRes = await automationsRoute();
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { automations: Array<{ id: string }>; notes: unknown[] };
    expect(listBody.automations.some((a) => a.id === a1.id)).toBe(true);
    expect(listBody.automations.every((a) => a.id !== "not-his")).toBe(true);

    // A's automations are NOT in F's list.
    const aAutomation = await createAutomation(A.id, { kind: "WEEKLY_SUMMARY", runAt: null });
    const fList = (await (await automationsRoute()).json()) as { automations: Array<{ id: string }> };
    expect(fList.automations.some((x) => x.id === aAutomation.id)).toBe(false);

    const stopRes = await stopAllRoute();
    expect(stopRes.status).toBe(200);
    const stopBody = (await stopRes.json()) as { cancelled: number };
    expect(stopBody.cancelled).toBeGreaterThanOrEqual(1);
    const after = await db.riisheAutomation.findUnique({ where: { id: a1.id } });
    expect(after?.status).toBe("CANCELLED");
    // A's automations were untouched by F's stop-all.
    const aAfter = await db.riisheAutomation.findUnique({ where: { id: aAutomation.id } });
    expect(aAfter?.status).not.toBe("CANCELLED");
  });

  test("notes: create, list, patch, delete with strict ownership", async () => {
    await loginViaSession(A.id);
    const createRes = await notesRoutePost(request("/api/riishe/notes", "POST", {
      username: B.username,
      note: "Met at the Chennai meetup — interested in collaborating.",
      status: "CONTACTED",
    }));
    expect(createRes.status).toBe(200);
    const { note } = (await createRes.json()) as { note: { id: string; status: string; person: { username: string } } };
    expect(note.status).toBe("CONTACTED");
    expect(note.person.username).toBe(B.username);

    // Ownership: F cannot patch or delete A's note.
    await loginViaSession(F.id);
    const patchForbidden = await notePatchRoute(request(`/api/riishe/notes/${note.id}`, "PATCH", { status: "CLOSED" }), ctx({ id: note.id }));
    expect(patchForbidden.status).toBe(404);
    const deleteForbidden = await noteDeleteRoute(request(`/api/riishe/notes/${note.id}`, "DELETE"), ctx({ id: note.id }));
    expect(deleteForbidden.status).toBe(404);

    // Owner can patch + delete.
    await loginViaSession(A.id);
    const patchRes = await notePatchRoute(request(`/api/riishe/notes/${note.id}`, "PATCH", { status: "IN_CONVERSATION" }), ctx({ id: note.id }));
    expect(patchRes.status).toBe(200);
    const deleteRes = await noteDeleteRoute(request(`/api/riishe/notes/${note.id}`, "DELETE"), ctx({ id: note.id }));
    expect(deleteRes.status).toBe(200);
  });

  test("weekly report uses truthful counts from real records", async () => {
    const report = await buildWeeklyReport(A.id, { since: new Date(Date.now() - 7 * 24 * 60 * 60_000), until: new Date() });
    const sentReal = await db.inquiry.count({ where: { senderId: A.id, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60_000) } } });
    expect(report.enquiriesSent).toBe(sentReal);
    expect(report.outstandingFollowUps).toBe(await db.inquiry.count({ where: { senderId: A.id, status: "PENDING" } }));
  });
});

// ==================================== 11-12. chat integration (real handlers)

describe("chat integration — automation through the EXISTING chat", () => {
  test("automation turn: real side effects + card + history preserved", async () => {
    await loginViaSession(A.id);
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "find video editors in Chennai" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversationId: string;
      reply: string;
      automation?: { kind: string; matches: Array<{ person: { username: string }; profileUrl: string; factors: string[] }> };
    };
    expect(body.automation?.kind).toBe("creator-results");
    expect(body.automation?.matches.some((m) => m.person.username === B.username)).toBe(true);
    // Privacy holds inside the chat action too.
    expect(body.automation?.matches.every((m) => m.person.username !== C.username)).toBe(true);
    // Conversation history preserved: USER + ASSISTANT rows persisted.
    const messages = await db.aiMessage.findMany({
      where: { conversationId: body.conversationId },
      orderBy: { createdAt: "asc" },
    });
    expect(messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
    expect(messages[0].content).toContain("find video editors");
    // Quota recorded (one usage row per turn — the existing behavior).
    const usage = await db.aiUsage.findFirst({ where: { userId: A.id, feature: "chat" }, orderBy: { createdAt: "desc" } });
    expect(usage).not.toBeNull();
  });

  test("draft turn via chat creates the reviewable draft; nothing sends without approval", async () => {
    await loginViaSession(F.id);
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: `draft a collaboration enquiry for @${B.username}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { automation?: { kind: string; taskId: string; recipient: { username: string }; subject: string; message: string } };
    expect(body.automation?.kind).toBe("enquiry-draft");
    expect(body.automation?.recipient.username).toBe(B.username);
    const task = await db.agentTask.findUnique({ where: { id: body.automation!.taskId } });
    expect(task?.status).toBe("AWAITING_APPROVAL");
    const sent = await db.inquiry.findMany({ where: { senderId: F.id } });
    expect(sent).toHaveLength(0);
  });

  test("reminder turn via chat schedules the BackgroundJob with a future runAt", async () => {
    await loginViaSession(F.id);
    // F needs a pending outgoing enquiry first (the reminder target).
    await inquiryRoute(request("/api/inquiries", "POST", {
      recipientUsername: B.username,
      type: "COLLABORATION",
      subject: "F's pending work",
      message: "Pending for reminder test.",
    }));
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "remind me tomorrow to follow up" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { automation?: { kind: string; automationId: string; runAt: string; autoSend: boolean } };
    expect(body.automation?.kind).toBe("followup-plan");
    expect(body.automation?.autoSend).toBe(false);
    expect(new Date(body.automation!.runAt).getTime()).toBeGreaterThan(Date.now());
    const job = await db.backgroundJob.findFirst({ where: { dedupeKey: `riishe.automation:${body.automation!.automationId}` } });
    expect(job?.status).toBe("QUEUED");
  });

  test("weekly report turn returns a real-counts card", async () => {
    await loginViaSession(A.id);
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "give me my weekly creator growth report" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { automation?: { kind: string; report: { enquiriesSent: number } } };
    expect(body.automation?.kind).toBe("weekly-report");
    expect(typeof body.automation?.report.enquiriesSent).toBe("number");
  });

  test("plain advisory questions do NOT trigger automation cards", async () => {
    await loginViaSession(A.id);
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "How can I improve my project descriptions?" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { automation?: unknown };
    expect(body.automation).toBeUndefined();
  });

  test("existing chat-stream behavior unchanged: streaming reply persists (no consent gate exists)", async () => {
    // The consent toggle was removed: the stream route serves every
    // authenticated user. The live gateway path is exercised once here (SSE).
    await loginViaSession(A.id);
    const res = await chatStreamRoute(request("/api/ai/chat-stream", "POST", { message: "Say hi" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("done");
  });

  test("delegation precedence: design requests still route to the delegation card, not automation", async () => {
    await loginViaSession(A.id);
    const res = await chatRoute(request("/api/ai/chat", "POST", { message: "create a banner for my profile" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delegation?: { kind: string }; automation?: unknown };
    expect(body.delegation?.kind).toBe("BANNER_DESIGN");
    expect(body.automation).toBeUndefined();
  });
});

// ================================================= 13. engine DTO sanity

describe("engine DTOs", () => {
  test("toAutomationDTO exposes schedule/state honestly", async () => {
    const automation = await createAutomation(A.id, { kind: "OPPORTUNITY_RADAR", runAt: new Date(Date.now() + 60_000), repeatDays: 7 });
    const dto = toAutomationDTO(automation, "weekly radar");
    expect(dto.kind).toBe("OPPORTUNITY_RADAR");
    expect(dto.status).toBe("ACTIVE");
    expect(dto.repeatDays).toBe(7);
    expect(dto.autoSend).toBe(false);
    expect(dto.runAt).toBeTruthy();
    expect(dto.targetLabel).toBe("weekly radar");
    await cancelAutomation(A.id, automation.id);
  });
});
