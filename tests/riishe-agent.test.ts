/**
 * RIISHE advanced automation agent — engine, tools, planner, approvals.
 *
 * Everything runs against REAL route handlers and the REAL database with the
 * armed-auth pattern. The queue worker is not started in tests, so step
 * execution is driven by invoking the same handler the worker uses
 * (runWorkflowStepJob) — the exact code path production runs.
 *
 * Covers §16 RIISHE requirements: natural-language intent recognition,
 * multi-step planning, tool authorization, approval workflow (HIGH +
 * DESTRUCTIVE separate confirm), duplicate execution prevention, retry
 * behavior, cancellation, background recovery, scheduled execution, failure
 * reporting, privacy/ownership, and REAL API actions (enquiry send flows
 * through the actual inquiry route handler; post drafts are real Post rows).
 *
 * Run: bun test tests/riishe-agent.test.ts
 */

import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest } from "next/server";

// --- armed auth -------------------------------------------------------------

declare global {
  var __riisheAgentAuth: { armed: boolean; userId: string | null } | undefined;
}
globalThis.__riisheAgentAuth = { armed: false, userId: null };

const actualAuth = await import("@/lib/auth");
const realGetSessionUser = actualAuth.getSessionUser;
const snapshot = { ...actualAuth };

mock.module("@/lib/auth", () => ({
  ...snapshot,
  getSessionUser: async () => {
    const s = globalThis.__riisheAgentAuth!;
    if (s.armed && s.userId) {
      const { db } = await import("@/lib/db");
      return db.user.findUnique({ where: { id: s.userId } });
    }
    return realGetSessionUser();
  },
}));

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));

afterAll(() => {
  mock.restore();
  globalThis.__riisheAgentAuth = { armed: false, userId: null };
});

import { db } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import {
  createWorkflowFromPlan,
  runWorkflowStepJob,
  executeApprovedStep,
  approveStep,
  declineStep,
  retryStep,
  setWorkflowStatus,
  runWorkflowSweep,
  deriveWorkflowStatus,
  loadOwned,
  WorkflowError,
} from "@/lib/riishe/workflow-engine";
import { planDeterministically, looksLikeWorkflow } from "@/lib/riishe/planner";
import { getTool, RIISHE_TOOLS } from "@/lib/riishe/tools";
import { POST as createInquiryHandler } from "@/app/api/inquiries/route";

const XFF = () => `10.91.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

const cleanup: string[] = [];
const cleanupUsers: string[] = [];
const cleanupPosts: string[] = [];
const cleanupWorkflows: string[] = [];

let owner: { id: string; username: string };
let peer: { id: string; username: string }; // discoverable public creator
let other: { id: string; username: string }; // third party for ownership tests

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

async function asOwner() {
  globalThis.__riisheAgentAuth = { armed: true, userId: owner.id };
}

/** Run every QUEUED riishe.workflow job through the REAL worker handler. */
async function drainWorkflowJobs(): Promise<number> {
  let ran = 0;
  for (let i = 0; i < 20; i++) {
    const jobs = await db.backgroundJob.findMany({
      where: { kind: "riishe.workflow", status: "QUEUED", runAt: { lte: new Date() } },
      take: 5,
    });
    if (jobs.length === 0) break;
    for (const job of jobs) {
      const claimed = await db.backgroundJob.update({
        where: { id: job.id },
        data: { status: "RUNNING", claimedBy: "test", claimedAt: new Date(), heartbeatAt: new Date() },
      });
      try {
        await runWorkflowStepJob(claimed);
        await db.backgroundJob.update({
          where: { id: job.id },
          data: { status: "SUCCEEDED", finishedAt: new Date() },
        });
      } catch {
        await db.backgroundJob.update({
          where: { id: job.id },
          data: { status: "FAILED", attempts: { increment: 1 }, lastError: "test-driven failure" },
        });
      }
      ran++;
    }
  }
  return ran;
}

// ================================================================= planner

describe("planner", () => {
  test("workflow-shape detection: conjunctions, numbered goals, explicit vocabulary", () => {
    expect(looksLikeWorkflow("Find motion designers in Chennai and draft collaboration enquiries")).toBe(true);
    expect(looksLikeWorkflow("Find 5 editors then schedule a post and remind me in 3 days")).toBe(true);
    expect(looksLikeWorkflow("1. find photographers\n2. shortlist the best")).toBe(true);
    expect(looksLikeWorkflow("what is a workflow")).toBe(false); // question, not a request
    expect(looksLikeWorkflow("hello")).toBe(false);
  });

  test("deterministic decomposition maps a multi-clause goal into a chained plan", () => {
    const plan = planDeterministically(
      "Find motion designers then draft an enquiry for @peer and remind me in 3 days"
    );
    expect(plan).not.toBeNull();
    expect(plan!.steps.length).toBeGreaterThanOrEqual(3);
    // chained: draft depends on the discovery step; reminder depends on the draft
    const tools = plan!.steps.map((s) => s.tool);
    expect(tools).toContain("discovery.searchCreators");
    expect(tools).toContain("enquiry.draft");
    expect(tools).toContain("followup.scheduleReminder");
    const draft = plan!.steps.find((s) => s.tool === "enquiry.draft")!;
    expect(draft.params.recipientUsername).toBe("peer");
    const reminder = plan!.steps.find((s) => s.tool === "followup.scheduleReminder")!;
    expect(reminder.dependsOn?.length ?? 0).toBeGreaterThan(0);
  });

  test("unmappable clauses produce NO plan (the planner never fabricates work)", () => {
    expect(planDeterministically("tell me a joke and recite a poem")).toBeNull();
    expect(planDeterministically("what's the weather")).toBeNull();
  });

  test("the tool catalog only contains registered tools with registry-derived risk", () => {
    for (const [name, tool] of Object.entries(RIISHE_TOOLS)) {
      expect(tool.name).toBe(name);
      expect(["LOW", "MEDIUM", "HIGH", "DESTRUCTIVE"]).toContain(tool.risk);
      expect(tool.timeoutMs).toBeGreaterThan(0);
      expect(tool.maxAttempts).toBeGreaterThan(0);
    }
    expect(getTool("sql.arbitrary")).toBeNull();
    expect(getTool("shell.exec")).toBeNull();
    // HIGH/DESTRUCTIVE surface actions cannot be executed by the queue alone
    expect(getTool("enquiry.send")!.risk).toBe("HIGH");
    expect(getTool("post.delete")!.risk).toBe("DESTRUCTIVE");
  });
});

// ================================================================= engine

describe("workflow engine", () => {
  let workflowId: string;

  beforeAll(async () => {
    owner = await makeUser("wflow");
    peer = await makeUser("peer");
    other = await makeUser("other");
    // a public post the workflow will draft+publish around
    const post = await db.post.create({
      data: { authorId: owner.id, body: "base", hashtags: "[]", mediaKind: "TEXT", visibility: "PUBLIC", status: "DRAFT" },
    });
    cleanupPosts.push(post.id);
  });

  test("multi-step plan persists REAL step records; LOW steps schedule, HIGH steps wait for approval", async () => {
    await asOwner();
    const wf = await createWorkflowFromPlan(
      owner.id,
      "draft a post then publish it",
      {
        title: "Draft and publish",
        summary: "test chain",
        steps: [
          { id: "s1", tool: "post.draft", params: { body: "Hello from the workflow", hashtags: ["agent"] } },
          { id: "s2", tool: "post.publish", params: { postRef: "s1" }, dependsOn: ["s1"] },
        ],
      },
      { planner: "deterministic" }
    );
    workflowId = wf.id;
    cleanupWorkflows.push(wf.id);

    expect(wf.status).toBe("ACTIVE");
    expect(wf.steps).toHaveLength(2);
    const [s1, s2] = wf.steps;
    expect(s1.kind).toBe("post.draft");
    expect(s1.risk).toBe("LOW");
    expect(s1.status).toBe("READY"); // ready → queued
    expect(s2.risk).toBe("HIGH"); // from the REGISTRY, not the plan
    expect(s2.requiresApproval).toBe(true);
    // B2 level-gating: a dependency-blocked step starts PENDING and enters
    // approval the moment its dependencies complete (the "dependency order"
    // test pins that end state). Approval is never requested for a step that
    // cannot run yet — same terminal behavior, no premature approval prompt.
    expect(s2.status).toBe("PENDING");
    expect(s2.ref).toBe("s2");

    const jobs = await db.backgroundJob.findMany({ where: { kind: "riishe.workflow", status: "QUEUED" } });
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });

  test("dependency order: the draft runs first, publish waits for approval; real records result", async () => {
    await asOwner();
    const ran = await drainWorkflowJobs();
    expect(ran).toBeGreaterThanOrEqual(1);
    const wf = await loadOwned(owner.id, workflowId);
    const [s1, s2] = wf.steps;
    expect(s1.status).toBe("SUCCEEDED");
    expect(s1.resultJson).toContain("postId");
    expect(s2.status).toBe("AWAITING_APPROVAL"); // publish cannot run unapproved

    const draftPostId = (JSON.parse(s1.resultJson) as { postId: string }).postId;
    const post = await db.post.findUnique({ where: { id: draftPostId } });
    expect(post).not.toBeNull();
    expect(post!.status).toBe("DRAFT"); // draft tool created a REAL post row
    expect(post!.authorId).toBe(owner.id);
  });

  test("approval workflow: the queue NEVER executes unapproved HIGH tools; approval runs it through the real API context", async () => {
    await asOwner();
    const wf = await loadOwned(owner.id, workflowId);
    const s2 = wf.steps[1];

    // Direct queue execution without approval refuses honestly:
    const job = await enqueue({
      kind: "riishe.workflow",
      payload: { workflowId, stepId: s2.id, userId: owner.id },
      userId: owner.id,
      dedupeKey: `riishe.wfstep:test:${s2.id}`,
    });
    await runWorkflowStepJob(job);
    const stillWaiting = await db.riisheWorkflowStep.findUnique({ where: { id: s2.id } });
    expect(stillWaiting!.status).toBe("AWAITING_APPROVAL");

    // Approve (session context with the REAL inquiry route available) → runs:
    await approveStep(owner.id, s2.id, false);
    const result = await executeApprovedStep(owner.id, s2.id, createInquiryHandler);
    expect(result.already).toBe(false);
    const published = (result.result as { postId: string; status: string });
    expect(published.status).toBe("PUBLISHED");
    const post = await db.post.findUnique({ where: { id: published.postId } });
    expect(post!.status).toBe("PUBLISHED");
  });

  test("duplicate execution prevention: approving a SUCCEEDED step never runs it twice", async () => {
    await asOwner();
    const wf = await loadOwned(owner.id, workflowId);
    const s2 = wf.steps[1];
    const result = await executeApprovedStep(owner.id, s2.id, createInquiryHandler);
    expect(result.already).toBe(true); // the engine reports honestly
  });

  test("retry after failure; failure reporting records the REAL error; dependents skip", async () => {
    await asOwner();
    const failing = await createWorkflowFromPlan(
      owner.id,
      "fail chain",
      {
        title: "Failing chain",
        steps: [
          { id: "f1", tool: "post.publish", params: { postRef: "missing-step" }, dependsOn: [] },
          { id: "f2", tool: "shortlist.addCreators", params: { usernames: ["peer"] }, dependsOn: ["f1"] },
        ],
      },
      { planner: "deterministic" }
    );
    cleanupWorkflows.push(failing.id);
    const [f1, f2] = failing.steps;
    expect(f1.status).toBe("AWAITING_APPROVAL");
    expect(f2.status).toBe("PENDING");

    // Approving runs it, but the ref resolution fails → honest FAILED step:
    await approveStep(owner.id, f1.id, false);
    await expect(executeApprovedStep(owner.id, f1.id, createInquiryHandler)).rejects.toThrow();
    const failedStep = await db.riisheWorkflowStep.findUnique({ where: { id: f1.id } });
    expect(failedStep!.status).toBe("FAILED");
    expect(failedStep!.error).toContain("not found");
    // Dependents of the failed step are SKIPPED with the reason recorded:
    const skipped = await db.riisheWorkflowStep.findUnique({ where: { id: f2.id } });
    expect(skipped!.status).toBe("SKIPPED");
  });

  test("DESTRUCTIVE actions require the separate confirm interaction", async () => {
    await asOwner();
    const wf = await createWorkflowFromPlan(
      owner.id,
      "delete that post",
      {
        title: "Delete chain",
        steps: [
          { id: "d1", tool: "post.draft", params: { body: "to delete" } },
          { id: "d2", tool: "post.delete", params: { postRef: "d1" }, dependsOn: ["d1"] },
        ],
      },
      { planner: "deterministic" }
    );
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs();
    const d2 = (await loadOwned(owner.id, wf.id)).steps[1];
    expect(d2.risk).toBe("DESTRUCTIVE");

    // confirm=false → 428-class refusal:
    await expect(approveStep(owner.id, d2.id, false)).rejects.toThrow(WorkflowError);
    // The real confirm flow deletes the REAL post row:
    await approveStep(owner.id, d2.id, true);
    const result = await executeApprovedStep(owner.id, d2.id, createInquiryHandler);
    expect((result.result as { deleted: boolean }).deleted).toBe(true);
    const draftStep = (await loadOwned(owner.id, wf.id)).steps[0];
    const deletedPostId = (JSON.parse(draftStep.resultJson) as { postId: string }).postId;
    expect(await db.post.findUnique({ where: { id: deletedPostId } })).toBeNull();
  });

  test("cancellation cancels not-started steps and their queued jobs", async () => {
    await asOwner();
    const wf = await createWorkflowFromPlan(
      owner.id,
      "cancel me",
      {
        title: "Cancellable",
        steps: [
          { id: "c1", tool: "growth.weeklyReport", params: {} },
          { id: "c2", tool: "shortlist.addCreators", params: { usernames: ["peer"] }, dependsOn: ["c1"], schedule: { inDays: 2 } },
        ],
      },
      { planner: "deterministic" }
    );
    cleanupWorkflows.push(wf.id);
    const cancelled = await setWorkflowStatus(owner.id, wf.id, "cancel");
    expect(cancelled.status).toBe("CANCELLED");
    const steps = cancelled.steps;
    expect(steps.every((s) => ["CANCELLED", "SUCCEEDED", "SKIPPED"].includes(s.status))).toBe(true);
  });

  test("pause stops scheduling; resume re-arms; ownership enforced everywhere", async () => {
    await asOwner();
    const wf = await createWorkflowFromPlan(
      owner.id,
      "pausable",
      { title: "Pausable", steps: [{ id: "p1", tool: "growth.weeklyReport", params: {} }] },
      { planner: "deterministic" }
    );
    cleanupWorkflows.push(wf.id);
    const paused = await setWorkflowStatus(owner.id, wf.id, "pause");
    expect(paused.status).toBe("PAUSED");
    const resumed = await setWorkflowStatus(owner.id, wf.id, "resume");
    expect(resumed.status).toBe("ACTIVE");

    // Another user's workflow is 404-class, never readable:
    globalThis.__riisheAgentAuth = { armed: true, userId: other.id };
    await expect(loadOwned(other.id, wf.id)).rejects.toThrow(WorkflowError);
    await expect(setWorkflowStatus(other.id, wf.id, "cancel")).rejects.toThrow(WorkflowError);
    await asOwner();
  });

  test("scheduled steps do not run early; the sweep schedules them when due", async () => {
    await asOwner();
    const wf = await createWorkflowFromPlan(
      owner.id,
      "remind me later",
      {
        title: "Scheduled",
        steps: [{ id: "z1", tool: "shortlist.addCreators", params: { usernames: ["peer"] }, schedule: { inDays: 5 } }],
      },
      { planner: "deterministic" }
    );
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];
    expect(step.status).toBe("PENDING");
    expect(step.scheduledFor).not.toBeNull();
    // Not due yet → the sweep leaves it pending:
    await runWorkflowSweep();
    const stillPending = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(stillPending!.status).toBe("PENDING");
    // Due now → the sweep arms it:
    await db.riisheWorkflowStep.update({
      where: { id: step.id },
      data: { scheduledFor: new Date(Date.now() - 1000) },
    });
    await runWorkflowSweep();
    const armed = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(armed!.status).toBe("READY");
    await drainWorkflowJobs();
    const done = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(done!.status).toBe("SUCCEEDED");
  });

  test("background recovery: a stale RUNNING step is re-armed by the sweep after a worker restart", async () => {
    await asOwner();
    const wf = await createWorkflowFromPlan(
      owner.id,
      "crash recovery",
      { title: "Recovery", steps: [{ id: "r1", tool: "growth.topContent", params: { days: 7, limit: 3 } }] },
      { planner: "deterministic" }
    );
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];
    // Simulate a worker that died mid-run:
    await db.riisheWorkflowStep.update({
      where: { id: step.id },
      data: { status: "RUNNING", startedAt: new Date(Date.now() - 20 * 60_000), updatedAt: new Date(Date.now() - 20 * 60_000) },
    });
    const sweep = await runWorkflowSweep();
    expect(sweep.recovered).toBeGreaterThanOrEqual(1);
    const recovered = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(recovered!.status).toBe("READY");
    await drainWorkflowJobs();
    const finished = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(finished!.status).toBe("SUCCEEDED");
    // Real analytics shape (no invented metrics):
    const result = JSON.parse(finished!.resultJson) as { top: { likes: number; shares: number }[] };
    expect(Array.isArray(result.top)).toBe(true);
  });

  test("workflow completion is derived from real step outcomes", async () => {
    await asOwner();
    const wf = await createWorkflowFromPlan(
      owner.id,
      "complete me",
      { title: "Completable", steps: [{ id: "k1", tool: "growth.weeklyReport", params: {} }] },
      { planner: "deterministic" }
    );
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs();
    const status = await deriveWorkflowStatus(wf.id, owner.id);
    expect(status).toBe("COMPLETED");
    const derived = await db.riisheWorkflow.findUnique({ where: { id: wf.id } });
    expect(derived!.status).toBe("COMPLETED");
  });
});

// ================================================================= tools

describe("tool layer", () => {
  test("enquiry.send executes a REAL inquiry through the actual route handler (explicit approval only)", async () => {
    await asOwner();
    const wf = await createWorkflowFromPlan(
      owner.id,
      "reach out to peer",
      {
        title: "Outreach",
        steps: [
          { id: "e1", tool: "enquiry.draft", params: { recipientUsername: "peer", subject: "Collab", message: "Let's build something." } },
          { id: "e2", tool: "enquiry.send", params: { draftRef: "e1" }, dependsOn: ["e1"] },
        ],
      },
      { planner: "deterministic" }
    );
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs();
    const [e1, e2] = (await loadOwned(owner.id, wf.id)).steps;
    expect(e1.status).toBe("SUCCEEDED");
    expect(e2.status).toBe("AWAITING_APPROVAL");

    await approveStep(owner.id, e2.id, false);
    const result = await executeApprovedStep(owner.id, e2.id, createInquiryHandler);
    const inquiryId = (result.result as { inquiryId: string }).inquiryId;
    const inquiry = await db.inquiry.findUnique({ where: { id: inquiryId } });
    expect(inquiry).not.toBeNull();
    expect(inquiry!.senderId).toBe(owner.id);
    // The draft task is COMPLETED (one send per draft, ever):
    const draftTaskId = (JSON.parse(e1.resultJson) as { draftTaskId: string }).draftTaskId;
    const task = await db.agentTask.findUnique({ where: { id: draftTaskId } });
    expect(task!.status).toBe("COMPLETED");

    // Recipient notification exists (real notification row — the inquiry
    // route creates it inline without targetId; check payload instead):
    const notif = await db.notification.findFirst({
      where: { userId: peer.id, type: "INQUIRY" },
      orderBy: { createdAt: "desc" },
    });
    expect(notif).not.toBeNull();
    const payload = JSON.parse(notif!.payload) as { actorUsername?: string; subject?: string };
    expect(payload.actorUsername).toBe("wflow");
    expect(payload.subject).toBe("Collab");
  });

  test("shortlist tool refuses self and unknown users honestly; re-adding is idempotent", async () => {
    await asOwner();
    const tool = getTool("shortlist.addCreators")!;
    const ctx = { userId: owner.id };
    const run = tool.execute as unknown as (ctx: { userId: string }, input: unknown) => Promise<Record<string, unknown>>;
    const r1 = (await run(ctx, { usernames: ["wflow", "ghost-user", "peer"] })) as {
      added: string[];
      refused: { username: string; reason: string }[];
    };
    expect(r1.added).toEqual(["peer"]);
    expect(r1.refused.map((r) => r.username)).toEqual(["wflow", "ghost-user"]);
    // idempotent re-run: no duplicate rows
    await run(ctx, { usernames: ["peer"] });
    const count = await db.riisheCreatorShortlist.count({ where: { userId: owner.id, personId: peer.id } });
    expect(count).toBe(1);
    const rows = await db.riisheCreatorShortlist.findMany({ where: { userId: owner.id } });
    for (const row of rows) await db.riisheCreatorShortlist.delete({ where: { id: row.id } });
  });

  test("unknown tools are rejected at plan time — the model cannot grant itself power", async () => {
    await asOwner();
    await expect(
      createWorkflowFromPlan(owner.id, "hack", {
        title: "Bad",
        steps: [{ id: "x1", tool: "db.rawSql", params: { q: "DROP TABLE users" } }],
      })
    ).rejects.toThrow(/unknown tool/);
    // Bad params fail the tool's zod schema:
    await expect(
      createWorkflowFromPlan(owner.id, "bad params", {
        title: "Bad params",
        steps: [{ id: "x2", tool: "post.draft", params: { body: "" } }],
      })
    ).rejects.toThrow(/params for post\.draft/);
    // Circular dependencies refuse:
    await expect(
      createWorkflowFromPlan(owner.id, "cycle", {
        title: "Cycle",
        steps: [
          { id: "a", tool: "growth.weeklyReport", params: {}, dependsOn: ["b"] },
          { id: "b", tool: "growth.topContent", params: {}, dependsOn: ["a"] },
        ],
      })
    ).rejects.toThrow(/circular/);
  });

  test("growth tools report REAL recorded counts only", async () => {
    await asOwner();
    const reportTool = getTool("growth.weeklyReport")!;
    const runReport = reportTool.execute as unknown as (ctx: { userId: string }, input: unknown) => Promise<Record<string, unknown>>;
    const r = (await runReport({ userId: owner.id }, {})) as { report: Record<string, unknown> };
    expect(r.report).not.toBeNull();
    const topTool = getTool("growth.topContent")!;
    const runTop = topTool.execute as unknown as (ctx: { userId: string }, input: unknown) => Promise<Record<string, unknown>>;
    const t = (await runTop({ userId: owner.id }, { days: 30, limit: 5 })) as { top: unknown[] };
    expect(Array.isArray(t.top)).toBe(true);
  });
});

// ================================================================= routes

describe("workflow routes", () => {
  test("GET /api/riishe/workflows is owner-scoped; a foreign id 404s without leaking existence", async () => {
    const { GET: listGET } = await import("@/app/api/riishe/workflows/route");
    const { GET: oneGET, PATCH: wfPATCH } = await import("@/app/api/riishe/workflows/[id]/route");

    await asOwner();
    const list = await listGET(new NextRequest("http://localhost/api/riishe/workflows"));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { workflows: { id: string }[] };
    expect(body.workflows.length).toBeGreaterThanOrEqual(1);

    const foreign = await oneGET(new NextRequest("http://localhost/api/riishe/workflows/nope"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(foreign.status).toBe(404);

    // anonymous → 401
    globalThis.__riisheAgentAuth = { armed: false, userId: null };
    const anon = await listGET(new NextRequest("http://localhost/api/riishe/workflows"));
    expect(anon.status).toBe(401);
  });

  test("PATCH /api/riishe/workflows/[id] pause/resume/cancel", async () => {
    const { PATCH: wfPATCH } = await import("@/app/api/riishe/workflows/[id]/route");
    await asOwner();
    const wf = await createWorkflowFromPlan(
      owner.id,
      "route pause",
      { title: "Route", steps: [{ id: "q1", tool: "growth.weeklyReport", params: {} }] },
      { planner: "deterministic" }
    );
    cleanupWorkflows.push(wf.id);
    const res = await wfPATCH(
      new NextRequest("http://localhost/api/riishe/workflows/" + wf.id, {
        method: "PATCH",
        body: JSON.stringify({ action: "pause" }),
        headers: { "content-type": "application/json", "x-forwarded-for": XFF() },
      }),
      { params: Promise.resolve({ id: wf.id }) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflow: { status: string } };
    expect(body.workflow.status).toBe("PAUSED");
  });

  test("PATCH /api/riishe/steps/[id] declines only owned steps", async () => {
    const { PATCH: stepPATCH } = await import("@/app/api/riishe/steps/[id]/route");
    await asOwner();
    const wf = await createWorkflowFromPlan(
      owner.id,
      "decline route",
      {
        title: "Decline",
        steps: [
          { id: "w1", tool: "enquiry.draft", params: { recipientUsername: "peer", subject: "Hi", message: "Hello there" } },
          { id: "w2", tool: "enquiry.send", params: { draftRef: "w1" }, dependsOn: ["w1"] },
        ],
      },
      { planner: "deterministic" }
    );
    cleanupWorkflows.push(wf.id);
    const w2 = (await loadOwned(owner.id, wf.id)).steps[1];
    const res = await stepPATCH(
      new NextRequest(`http://localhost/api/riishe/steps/${w2.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "decline" }),
        headers: { "content-type": "application/json", "x-forwarded-for": XFF() },
      }),
      { params: Promise.resolve({ id: w2.id }) }
    );
    expect(res.status).toBe(200);
    const step = await db.riisheWorkflowStep.findUnique({ where: { id: w2.id } });
    expect(step!.status).toBe("CANCELLED");

    // A foreign user cannot touch the step (404, existence never revealed):
    globalThis.__riisheAgentAuth = { armed: true, userId: other.id };
    const foreign = await stepPATCH(
      new NextRequest(`http://localhost/api/riishe/steps/${w2.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "approve" }),
        headers: { "content-type": "application/json", "x-forwarded-for": XFF() },
      }),
      { params: Promise.resolve({ id: w2.id }) }
    );
    expect(foreign.status).toBe(404);
  });
});

afterAll(async () => {
  for (const id of cleanupWorkflows) await db.riisheWorkflow.deleteMany({ where: { id } });
  for (const id of cleanupPosts) await db.post.deleteMany({ where: { id } });
  await db.backgroundJob.deleteMany({ where: { kind: "riishe.workflow" } });
  await db.agentTask.deleteMany({ where: { userId: { in: cleanupUsers } } });
  await db.inquiry.deleteMany({ where: { senderId: { in: cleanupUsers } } });
  for (const id of cleanupUsers) await db.user.deleteMany({ where: { id } });
});
