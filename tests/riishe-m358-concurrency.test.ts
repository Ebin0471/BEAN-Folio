/// <reference types="bun-types" />
/**
 * M35.8 — RIISHE atomic execution & concurrency control.
 *
 * Every scenario runs against the REAL engine, REAL registry and REAL
 * database (no handler mocks, no hand-set RUNNING statuses for the races).
 * Controlled concurrency barriers release two real call paths into the same
 * event-loop tick so the tests exercise actual simultaneous execution:
 *
 *  1. Two workers simultaneously receiving the same READY step — the atomic
 *     conditional claim admits exactly one; the loser never executes.
 *  2. Two simultaneous approval requests for one Level-2 step — exactly one
 *     claim + execution, one artifact, one execution audit.
 *  3. Duplicate delivery while another attempt is RUNNING — quiet no-op.
 *  4. A worker racing with cancellation or pause — the control pass never
 *     clobbers a live claim, the worker never bypasses the control action.
 *  5. A stale worker being recovered without concurrent double-writes —
 *     the ownership token (post-claim attempts) refuses the stale outcome.
 *  6. Exactly one execution attempt, one resulting artifact and one
 *     applicable execution audit record (asserted in every race).
 *  7. No duplicate provider/AI generation or unnecessary budget consumption
 *     (stamped artifact tools + the LAXII produce pipeline start once).
 *
 * Run: bun test tests/riishe-m358-concurrency.test.ts   (isolated QA DB)
 */

import { describe, expect, test, afterAll } from "bun:test";

import { db } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import {
  APPROVAL_CLAIM_STATUSES,
  QUEUE_CLAIM_STATUSES,
  approveStep,
  claimStepExecution,
  createWorkflowFromPlan,
  executeApprovedStep,
  finishClaimedStep,
  loadOwned,
  releaseClaimIfWorkflowInactive,
  runWorkflowStepJob,
  runWorkflowSweep,
  setWorkflowStatus,
  WorkflowError,
} from "@/lib/riishe/workflow-engine";

const cleanupUsers: string[] = [];
const cleanupWorkflows: string[] = [];
const cleanupPosts: string[] = [];

async function makeUser(tag: string): Promise<{ id: string; username: string }> {
  const u = await db.user.create({
    data: {
      email: `riishe-m358-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`,
      passwordHash: "0".repeat(32) + ":" + "0".repeat(128),
      name: `M35.8 QA ${tag}`,
      username: `qam358${tag}${Math.floor(Math.random() * 100000)}`,
      onboarded: true,
      profileVisibility: "PUBLIC",
    },
  });
  cleanupUsers.push(u.id);
  return { id: u.id, username: u.username! };
}

/** Enqueue a manual job for one step exactly the way the engine does. */
async function enqueueStepJob(workflowId: string, stepId: string, userId: string, tag: string) {
  return enqueue({
    kind: "riishe.workflow",
    payload: { workflowId, stepId, userId },
    userId,
    runAt: new Date(),
    maxAttempts: 3,
    dedupeKey: `riishe.wfstep:m358-${tag}:${stepId}`,
  });
}

/** Claim a QUEUED job row the way the real worker's status guard does. */
async function claim(jobId: string) {
  return db.backgroundJob.update({
    where: { id: jobId },
    data: { status: "RUNNING", claimedBy: "test", claimedAt: new Date(), heartbeatAt: new Date() },
  });
}

/** Mark a manually driven job row finished (the worker's post-handler step). */
async function finishJob(jobId: string) {
  await db.backgroundJob.update({ where: { id: jobId }, data: { status: "SUCCEEDED", finishedAt: new Date() } }).catch(() => undefined);
}

/** Claim + run every QUEUED riishe.workflow job through the REAL worker handler. */
async function drainWorkflowJobs(): Promise<number> {
  let ran = 0;
  for (let i = 0; i < 30; i++) {
    const jobs = await db.backgroundJob.findMany({
      where: { kind: "riishe.workflow", status: "QUEUED", runAt: { lte: new Date() } },
      take: 10,
    });
    if (jobs.length === 0) break;
    for (const job of jobs) {
      const claimed = await claim(job.id);
      try {
        await runWorkflowStepJob(claimed);
        await finishJob(job.id);
      } catch {
        await db.backgroundJob.update({
          where: { id: job.id },
          data: { status: "FAILED", attempts: { increment: 1 }, lastError: "test-driven" },
        });
      }
      ran++;
    }
  }
  return ran;
}

/**
 * Controlled concurrency barrier: every party registers, and the LAST one
 * releases all of them into the same event-loop tick — the calls after the
 * barrier genuinely race instead of running sequentially.
 */
function barrier(parties: number) {
  let remaining = parties;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async wait(): Promise<void> {
      remaining -= 1;
      if (remaining === 0) release();
      else await gate;
    },
  };
}

function audits(userId: string, action: string, stepId: string) {
  return db.auditEvent.count({
    where: { actorUserId: userId, action, targetType: "RiisheWorkflowStep", targetId: stepId },
  });
}

afterAll(async () => {
  for (const id of cleanupWorkflows) {
    await db.riisheWorkflow.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of cleanupPosts) {
    await db.post.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of cleanupUsers) {
    await db.user.deleteMany({ where: { id } }).catch(() => undefined);
  }
});

// =====================================================================
// 1 — atomic claiming of READY steps (queue path)
// =====================================================================

describe("M35.8 — atomic workflow-step claiming", () => {
  test("two workers claim the same READY step simultaneously — exactly one atomic claim wins", async () => {
    const u = await makeUser("claim-race");
    const wf = await createWorkflowFromPlan(u.id, "draft a post", {
      title: "claim race",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "claim race probe", hashtags: [] } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];
    expect(step.status).toBe("READY");

    const gate = barrier(2);
    const attempt = () => gate.wait().then(() => claimStepExecution(step.id, u.id, QUEUE_CLAIM_STATUSES, new Date()));
    const [a, b] = await Promise.all([attempt(), attempt()]);
    const wins = [a, b].filter((r) => r.ok);
    expect(wins).toHaveLength(1);

    const winner = a.ok ? a : b;
    expect(winner.ok).toBe(true);
    const row = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(row!.status).toBe("RUNNING");
    expect(row!.attempts).toBe(1);
    // a claim alone never executes the tool
    expect(await db.post.count({ where: { authorId: u.id } })).toBe(0);

    // the ownership token decides who may record an outcome: a wrong token is
    // refused even though the row is RUNNING, the true owner's token lands.
    const token = winner.ok ? winner.step.attempts : 0;
    expect(await finishClaimedStep(step.id, u.id, token + 1, { status: "SUCCEEDED", resultJson: "{}", error: null, finishedAt: new Date() })).toBe(false);
    expect(await finishClaimedStep(step.id, u.id, token, { status: "SUCCEEDED", resultJson: JSON.stringify({ via: "claim-owner" }), error: null, finishedAt: new Date() })).toBe(true);
    const done = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(done!.status).toBe("SUCCEEDED");
    expect(JSON.parse(done!.resultJson)).toEqual({ via: "claim-owner" });
  });

  test("two workers executing the same READY step through the real queue entrypoint run the tool exactly once", async () => {
    const u = await makeUser("exec-race");
    const wf = await createWorkflowFromPlan(u.id, "draft a post", {
      title: "duplicate execution race",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "exec race probe", hashtags: [] } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];
    // two queue rows for the SAME step (a redelivery + a fresh job)
    const jobA = await enqueueStepJob(wf.id, step.id, u.id, "exec-race-a");
    const jobB = await enqueueStepJob(wf.id, step.id, u.id, "exec-race-b");

    const gate = barrier(2);
    const run = async (jobId: string) => {
      await gate.wait();
      await runWorkflowStepJob(await claim(jobId));
      await finishJob(jobId);
    };
    await Promise.all([run(jobA.id), run(jobB.id)]);

    const after = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(after!.status).toBe("SUCCEEDED");
    expect(after!.attempts).toBe(1); // exactly ONE execution attempt
    expect(await db.post.count({ where: { authorId: u.id } })).toBe(1); // exactly ONE artifact
    expect(await audits(u.id, "riishe.workflow.step_succeeded", step.id)).toBe(1);
    expect(await audits(u.id, "riishe.tool.post_draft", step.id)).toBe(1);
  });

  test("duplicate delivery while another attempt is RUNNING is a quiet no-op — recovery then completes it honestly", async () => {
    const u = await makeUser("dup-running");
    const wf = await createWorkflowFromPlan(u.id, "draft a post", {
      title: "duplicate while running",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "duplicate while running probe", hashtags: [] } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];

    // Attempt 1 claims through the REAL atomic claim path and holds the row
    // mid-flight (a slow/stuck worker) — not a hand-set RUNNING status.
    const held = await claimStepExecution(step.id, u.id, QUEUE_CLAIM_STATUSES, new Date());
    expect(held.ok).toBe(true);

    // A duplicate delivery arrives while the attempt is in flight:
    const dupJob = await enqueueStepJob(wf.id, step.id, u.id, "dup-running");
    await runWorkflowStepJob(await claim(dupJob.id)); // quiet no-op
    await finishJob(dupJob.id);
    let row = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(row!.status).toBe("RUNNING");
    expect(row!.attempts).toBe(1);
    expect(await db.post.count({ where: { authorId: u.id } })).toBe(0);

    // The holder's worker dies: the REAL sweep recovers the stale RUNNING row.
    await db.riisheWorkflowStep.update({
      where: { id: step.id },
      data: { updatedAt: new Date(Date.now() - 11 * 60_000) },
    });
    const sweep = await runWorkflowSweep();
    expect(sweep.recovered).toBeGreaterThanOrEqual(1);
    expect((await db.riisheWorkflowStep.findUnique({ where: { id: step.id } }))!.status).toBe("READY");

    // The recovered step is delivered to a live worker and executes exactly once.
    const jobs = await db.backgroundJob.findMany({
      where: { kind: "riishe.workflow", status: "QUEUED", payload: { contains: step.id } },
    });
    expect(jobs).toHaveLength(1);
    await runWorkflowStepJob(await claim(jobs[0].id));
    await finishJob(jobs[0].id);
    row = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(row!.status).toBe("SUCCEEDED");
    expect(row!.attempts).toBe(2);
    expect(await db.post.count({ where: { authorId: u.id } })).toBe(1);
  });
});

// =====================================================================
// 2 — atomic approval claims (level-2 approval-class steps)
// =====================================================================

describe("M35.8 — atomic approval claiming", () => {
  test("two simultaneous approval requests for one level-2 step — exactly one execution, one artifact, one audit", async () => {
    const u = await makeUser("approval-race");
    const wf = await createWorkflowFromPlan(u.id, "draft then publish", {
      title: "approval race",
      steps: [
        { id: "s1", tool: "post.draft", params: { body: "approval race producer", hashtags: [] } },
        { id: "s2", tool: "post.publish", params: { postRef: "s1" }, dependsOn: ["s1"] },
      ],
    });
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs();
    let after = await loadOwned(u.id, wf.id);
    expect(after.steps[1].status).toBe("AWAITING_APPROVAL");
    const publishStep = after.steps[1];
    const postId = (JSON.parse(after.steps[0].resultJson) as { postId: string }).postId;

    // Two owner approval requests hit the route sequence simultaneously
    // (approveStep → executeApprovedStep, exactly what PATCH does).
    const gate = barrier(2);
    const request = async () => {
      await gate.wait();
      await approveStep(u.id, publishStep.id, false);
      return executeApprovedStep(u.id, publishStep.id);
    };
    const settled = await Promise.allSettled([request(), request()]);

    const row = await db.riisheWorkflowStep.findUnique({ where: { id: publishStep.id } });
    expect(row!.status).toBe("SUCCEEDED");
    expect(row!.attempts).toBe(1); // exactly ONE claim across both requests
    expect(await audits(u.id, "riishe.workflow.step_succeeded", publishStep.id)).toBe(1);
    expect(await audits(u.id, "riishe.tool.post_publish", publishStep.id)).toBe(1);
    // the draft was published exactly once — a losing request never executed
    expect(await db.post.count({ where: { id: postId, status: "PUBLISHED" } })).toBe(1);
    cleanupPosts.push(postId);

    // outcomes: exactly one request executed; the other either conflicted
    // with the live claim or honestly reported the concurrent completion.
    const fulfilled = settled.filter((s) => s.status === "fulfilled") as PromiseFulfilledResult<{ already: boolean }>[];
    const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled.length + rejected.length).toBe(2);
    expect(fulfilled.filter((s) => s.value.already === false)).toHaveLength(1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(WorkflowError);
      expect((r.reason as WorkflowError).reason).toBe("conflict");
    }
  });

  test("two simultaneous approvals of a level-2 provider generation step start the LAXII pipeline exactly once", async () => {
    const u = await makeUser("produce-race");
    const wf = await createWorkflowFromPlan(u.id, "brief then produce", {
      title: "produce race",
      steps: [
        { id: "p1", tool: "laxii.banner.brief", params: { request: "A calm minimal banner" } },
        { id: "p2", tool: "laxii.banner.produce", params: { briefTaskRef: "p1" }, dependsOn: ["p1"] },
      ],
    });
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs();
    let after = await loadOwned(u.id, wf.id);
    expect(after.steps[1].status).toBe("AWAITING_APPROVAL");
    const produce = after.steps[1];

    const gate = barrier(2);
    const request = async () => {
      await gate.wait();
      await approveStep(u.id, produce.id, false);
      return executeApprovedStep(u.id, produce.id);
    };
    await Promise.allSettled([request(), request()]);

    after = await loadOwned(u.id, wf.id);
    expect(after.steps[1].status).toBe("SUCCEEDED");
    expect(after.steps[1].attempts).toBe(1);
    // exactly ONE pipeline start — no duplicate provider generation or spend.
    // (startGenerationJob writes the USER turn + the ASSISTANT generation row
    // in one transaction, so ONE execution = one ASSISTANT RUNNING record.)
    expect(await db.laxiiConversation.count({ where: { userId: u.id, kind: "BANNER" } })).toBe(1);
    expect(await db.laxiiMessage.count({ where: { conversation: { userId: u.id }, role: "ASSISTANT" } })).toBe(1);
    expect(await audits(u.id, "riishe.tool.banner_produce", produce.id)).toBe(1);
  });
});

// =====================================================================
// 3 — worker races with cancellation / pause
// =====================================================================

describe("M35.8 — control-action races", () => {
  test("cancel never clobbers a live claim and a stale worker cannot bypass cancellation", async () => {
    const u = await makeUser("cancel-race");
    const wf = await createWorkflowFromPlan(u.id, "draft a post", {
      title: "cancel race",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "cancel race probe", hashtags: [] } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];

    const held = await claimStepExecution(step.id, u.id, QUEUE_CLAIM_STATUSES, new Date());
    expect(held.ok).toBe(true);

    // The creation-time queue row is retired: its stalled worker is modelled
    // by the held atomic claim above (in production both are the SAME job —
    // a worker claims the row, then the engine claims the step).
    await db.backgroundJob.updateMany({
      where: { kind: "riishe.workflow", status: "QUEUED", payload: { contains: step.id } },
      data: { status: "CANCELLED" },
    });

    // The owner cancels the workflow while the attempt holds the claim:
    const cancelled = await setWorkflowStatus(u.id, wf.id, "cancel");
    expect(cancelled.status).toBe("CANCELLED");
    // The cancel pass did NOT flip the claimed (RUNNING) step:
    let row = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(row!.status).toBe("RUNNING");
    expect(await db.post.count({ where: { authorId: u.id } })).toBe(0);

    // A delivery racing the cancellation cannot resurrect execution:
    const job = await enqueueStepJob(wf.id, step.id, u.id, "cancel-race");
    await runWorkflowStepJob(await claim(job.id));
    await finishJob(job.id);
    expect(await db.post.count({ where: { authorId: u.id } })).toBe(0);

    // The dead worker is recovered by the REAL sweep — but the recovered
    // READY step is never scheduled (the workflow is CANCELLED):
    await db.riisheWorkflowStep.update({
      where: { id: step.id },
      data: { updatedAt: new Date(Date.now() - 11 * 60_000) },
    });
    await runWorkflowSweep();
    row = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(row!.status).toBe("READY");
    expect(await db.backgroundJob.count({ where: { kind: "riishe.workflow", status: "QUEUED", payload: { contains: step.id } } })).toBe(0);

    // A stale delivery of the recovered step is refused (workflow inactive):
    const staleJob = await enqueueStepJob(wf.id, step.id, u.id, "cancel-stale");
    await runWorkflowStepJob(await claim(staleJob.id));
    await finishJob(staleJob.id);
    expect((await db.riisheWorkflowStep.findUnique({ where: { id: step.id } }))!.status).toBe("READY");
    expect(await db.post.count({ where: { authorId: u.id } })).toBe(0);

    // And the stale attempt can never record its outcome:
    expect(await finishClaimedStep(step.id, u.id, held.ok ? held.step.attempts : 0, { status: "SUCCEEDED", resultJson: "{}", error: null, finishedAt: new Date() })).toBe(false);
  });

  test("pause never clobbers a live claim — the post-claim re-verification releases it without executing", async () => {
    const u = await makeUser("pause-race");
    const wf = await createWorkflowFromPlan(u.id, "draft a post", {
      title: "pause race",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "pause race probe", hashtags: [] } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];

    const held = await claimStepExecution(step.id, u.id, QUEUE_CLAIM_STATUSES, new Date());
    expect(held.ok).toBe(true);
    const token = held.ok ? held.step.attempts : 0;

    // The owner pauses while the attempt holds the claim:
    const paused = await setWorkflowStatus(u.id, wf.id, "pause");
    expect(paused.status).toBe("PAUSED");
    // The pause pass did NOT flip the claimed step (conditional READY→PENDING):
    let row = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(row!.status).toBe("RUNNING");

    // The worker's post-claim control re-verification (the REAL engine helper
    // both entrypoints call) releases the claim honestly — PENDING, no tool:
    expect(await releaseClaimIfWorkflowInactive(step.id, u.id, wf.id, token)).toBe(true);
    row = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(row!.status).toBe("PENDING");
    expect(await db.post.count({ where: { authorId: u.id } })).toBe(0);
    expect(await audits(u.id, "riishe.workflow.step_succeeded", step.id)).toBe(0);
    expect(await audits(u.id, "riishe.tool.post_draft", step.id)).toBe(0);

    // Re-release is a no-op; the claim is already gone:
    expect(await releaseClaimIfWorkflowInactive(step.id, u.id, wf.id, token)).toBe(true);
    expect((await db.riisheWorkflowStep.findUnique({ where: { id: step.id } }))!.status).toBe("PENDING");
  });

  test("engine-level race: a queue delivery and a workflow cancellation keep the single-execution invariants", async () => {
    const u = await makeUser("live-cancel");
    const wf = await createWorkflowFromPlan(u.id, "draft a post", {
      title: "live cancel race",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "live cancel probe", hashtags: [] } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];
    const job = await enqueueStepJob(wf.id, step.id, u.id, "live-cancel");

    const gate = barrier(2);
    const delivery = gate.wait().then(async () => {
      await runWorkflowStepJob(await claim(job.id));
      await finishJob(job.id);
    });
    const control = gate.wait().then(async () => {
      await new Promise((r) => setTimeout(r, 5)); // the delivery starts first
      return setWorkflowStatus(u.id, wf.id, "cancel");
    });
    const [, workflowAfter] = await Promise.all([delivery, control]);

    const row = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    const posts = await db.post.count({ where: { authorId: u.id } });
    expect(workflowAfter!.status).toBe("CANCELLED");
    // invariants under ANY interleaving:
    expect(posts).toBeLessThanOrEqual(1);
    expect(row!.attempts).toBeLessThanOrEqual(1);
    if (row!.status === "SUCCEEDED") {
      // the claim won before the cancel pass — exactly one execution, one audit
      expect(posts).toBe(1);
      expect(await audits(u.id, "riishe.workflow.step_succeeded", step.id)).toBe(1);
      expect(await audits(u.id, "riishe.tool.post_draft", step.id)).toBe(1);
    } else {
      // the cancel pass won — no execution, no artifact, no success audit
      expect(posts).toBe(0);
      expect(await audits(u.id, "riishe.workflow.step_succeeded", step.id)).toBe(0);
      expect(await audits(u.id, "riishe.tool.post_draft", step.id)).toBe(0);
    }
  });

  test("engine-level race: a queue delivery and a workflow pause keep the single-execution invariants", async () => {
    const u = await makeUser("live-pause");
    const wf = await createWorkflowFromPlan(u.id, "draft a post", {
      title: "live pause race",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "live pause probe", hashtags: [] } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];
    const job = await enqueueStepJob(wf.id, step.id, u.id, "live-pause");

    const gate = barrier(2);
    const delivery = gate.wait().then(async () => {
      await runWorkflowStepJob(await claim(job.id));
      await finishJob(job.id);
    });
    const control = gate.wait().then(async () => {
      await new Promise((r) => setTimeout(r, 5)); // the delivery starts first
      return setWorkflowStatus(u.id, wf.id, "pause");
    });
    const [, workflowAfter] = await Promise.all([delivery, control]);

    const row = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    const posts = await db.post.count({ where: { authorId: u.id } });
    expect(workflowAfter!.status).toBe("PAUSED");
    // invariants under ANY interleaving:
    expect(posts).toBeLessThanOrEqual(1);
    expect(row!.attempts).toBeLessThanOrEqual(1);
    if (row!.status === "SUCCEEDED") {
      expect(posts).toBe(1);
      expect(await audits(u.id, "riishe.workflow.step_succeeded", step.id)).toBe(1);
    } else {
      expect(posts).toBe(0);
      expect(await audits(u.id, "riishe.workflow.step_succeeded", step.id)).toBe(0);
    }
  });
});

// =====================================================================
// 4 — stale worker recovery without concurrent double-writes
// =====================================================================

describe("M35.8 — stale worker recovery", () => {
  test("a stale worker recovered by the sweep cannot overwrite the live attempt — one artifact, one audit", async () => {
    const u = await makeUser("stale-owner");
    const wf = await createWorkflowFromPlan(u.id, "create a site draft", {
      title: "stale owner",
      steps: [{ id: "s1", tool: "giftz.site.create", params: { title: "Stale owner probe", sourcePrompt: "minimal portfolio" } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];

    // Attempt 1 claims through the REAL claim path, then its worker stalls.
    const held = await claimStepExecution(step.id, u.id, QUEUE_CLAIM_STATUSES, new Date());
    expect(held.ok).toBe(true);
    const staleToken = held.ok ? held.step.attempts : 0;

    // The stall crosses the staleness boundary (wall-clock compressed): the
    // REAL sweep recovers the row and the recovered step is delivered to a
    // live worker through the REAL queue path.
    await db.riisheWorkflowStep.update({
      where: { id: step.id },
      data: { updatedAt: new Date(Date.now() - 11 * 60_000) },
    });
    const sweep = await runWorkflowSweep();
    expect(sweep.recovered).toBeGreaterThanOrEqual(1);
    const jobs = await db.backgroundJob.findMany({
      where: { kind: "riishe.workflow", status: "QUEUED", payload: { contains: step.id } },
    });
    expect(jobs).toHaveLength(1);
    await runWorkflowStepJob(await claim(jobs[0].id));
    await finishJob(jobs[0].id);

    const live = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(live!.status).toBe("SUCCEEDED");
    expect(live!.attempts).toBe(2);
    const liveResult = JSON.parse(live!.resultJson) as { siteId: string };
    expect(liveResult.siteId).toBeTruthy();

    // The stale worker resuscitates and tries to record ITS outcome:
    expect(
      await finishClaimedStep(step.id, u.id, staleToken, {
        status: "SUCCEEDED",
        resultJson: JSON.stringify({ siteId: "stale-worker-site" }),
        error: null,
        finishedAt: new Date(),
      })
    ).toBe(false);
    const after = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(after!.status).toBe("SUCCEEDED");
    expect(JSON.parse(after!.resultJson)).toEqual(liveResult); // the live outcome stands

    // exactly one stamped artifact and exactly one execution audit:
    const sites = await db.giftzSite.findMany({ where: { userId: u.id } });
    expect(sites).toHaveLength(1);
    expect(sites[0].createdViaStepId).toBe(step.id);
    expect(await audits(u.id, "riishe.workflow.step_succeeded", step.id)).toBe(1);
    expect(await audits(u.id, "riishe.tool.giftz_site_create", step.id)).toBe(1);
  });

  test("duplicate simultaneous deliveries of a stamped artifact tool consume the budget exactly once", async () => {
    const u = await makeUser("stamp-race");
    const wf = await createWorkflowFromPlan(u.id, "create a site draft", {
      title: "stamp race",
      steps: [{ id: "s1", tool: "giftz.site.create", params: { title: "Stamp race probe" } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];
    const jobA = await enqueueStepJob(wf.id, step.id, u.id, "stamp-race-a");
    const jobB = await enqueueStepJob(wf.id, step.id, u.id, "stamp-race-b");

    const gate = barrier(2);
    const run = async (jobId: string) => {
      await gate.wait();
      await runWorkflowStepJob(await claim(jobId));
      await finishJob(jobId);
    };
    await Promise.all([run(jobA.id), run(jobB.id)]);

    const row = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(row!.status).toBe("SUCCEEDED");
    expect(row!.attempts).toBe(1);
    const sites = await db.giftzSite.findMany({ where: { userId: u.id } });
    expect(sites).toHaveLength(1);
    expect(sites[0].createdViaStepId).toBe(step.id);
    expect(await audits(u.id, "riishe.tool.giftz_site_create", step.id)).toBe(1);
    expect(await audits(u.id, "riishe.workflow.step_succeeded", step.id)).toBe(1);
  });
});

// =====================================================================
// 5 — approval-claim status surface (regression pins)
// =====================================================================

describe("M35.8 — claim status surfaces", () => {
  test("the queue claims READY only; approval-time keeps its accepted set; terminal states are refused", async () => {
    expect([...QUEUE_CLAIM_STATUSES]).toEqual(["READY"]);
    expect([...APPROVAL_CLAIM_STATUSES]).toEqual(["PENDING", "AWAITING_APPROVAL", "READY", "FAILED"]);

    const u = await makeUser("claim-status");
    const wf = await createWorkflowFromPlan(u.id, "scheduled draft", {
      title: "claim status probe",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "claim status probe", hashtags: [] }, schedule: { inDays: 30 } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];
    expect(step.status).toBe("PENDING");
    // a queue delivery for a PENDING (scheduled) step can NEVER claim it:
    expect(await claimStepExecution(step.id, u.id, QUEUE_CLAIM_STATUSES, new Date())).toEqual({ ok: false });
    expect((await db.riisheWorkflowStep.findUnique({ where: { id: step.id } }))!.status).toBe("PENDING");
    expect(await db.post.count({ where: { authorId: u.id } })).toBe(0);
  });
});
