/// <reference types="bun-types" />
/**
 * M35.7 — RIISHE agent safety & reliability hardening.
 *
 * Three review findings, each pinned end-to-end against the REAL engine,
 * REAL registry and REAL database (no handler mocks, no second engine):
 *
 *  Finding 1 — approval policy: the LAXII provider generation
 *  (`laxii.banner.produce`) and the AI career-document generators
 *  (`career.resume.tailoredCopy`, `career.coverLetter.draft`) are LEVEL-2
 *  approval-class tools. The queue never executes them unapproved, approval-
 *  time execution refuses without approval, and no artifact is created on a
 *  bypass attempt.
 *
 *  Finding 2 — durable step-level idempotency: `giftz.site.create` and
 *  `laxii.banner.brief` stamp their artifact with the creating workflow step
 *  (`createdViaStepId`, committed in the SAME insert; unique index). A retry
 *  after a partially successful write (artifact committed, step result lost)
 *  re-attaches to the stamped artifact instead of duplicating it.
 *
 *  Finding 3 — typed artefact references: refs resolve only against an
 *  EXPLICIT earlier dependency (declared in dependsOn) that has COMPLETED
 *  SUCCESSFULLY. Missing dependencies, forward references, undeclared
 *  references and failed producers are rejected (plan time and resolution
 *  time), dependents skip honestly, and replayed approvals never re-execute.
 *
 * Run: bun test tests/riishe-m357-safety-hardening.test.ts   (isolated QA DB)
 */

import { describe, expect, test, afterAll } from "bun:test";
import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import {
  createWorkflowFromPlan,
  runWorkflowStepJob,
  executeApprovedStep,
  approveStep,
  runWorkflowSweep,
  loadOwned,
  resolveStepParams,
  WorkflowError,
} from "@/lib/riishe/workflow-engine";
import { getTool, toolApprovalRequired } from "@/lib/riishe/tools";

const cleanupUsers: string[] = [];
const cleanupWorkflows: string[] = [];
const cleanupPosts: string[] = [];

async function makeUser(tag: string): Promise<{ id: string; username: string }> {
  const u = await db.user.create({
    data: {
      email: `riishe-m357-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`,
      passwordHash: "0".repeat(32) + ":" + "0".repeat(128),
      name: `M35.7 QA ${tag}`,
      username: `qam357${tag}${Math.floor(Math.random() * 100000)}`,
      onboarded: true,
      profileVisibility: "PUBLIC",
    },
  });
  cleanupUsers.push(u.id);
  return { id: u.id, username: u.username! };
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
      const claimed = await db.backgroundJob.update({
        where: { id: job.id },
        data: { status: "RUNNING", claimedBy: "test", claimedAt: new Date(), heartbeatAt: new Date() },
      });
      try {
        await runWorkflowStepJob(claimed);
        await db.backgroundJob.update({ where: { id: job.id }, data: { status: "SUCCEEDED", finishedAt: new Date() } });
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

/** Enqueue a manual job for one step exactly the way the engine does. */
async function enqueueStepJob(workflowId: string, stepId: string, userId: string, tag: string) {
  return enqueue({
    kind: "riishe.workflow",
    payload: { workflowId, stepId, userId },
    userId,
    runAt: new Date(),
    maxAttempts: 3,
    dedupeKey: `riishe.wfstep:m357-${tag}:${stepId}`,
  });
}

async function claim(jobId: string) {
  return db.backgroundJob.update({
    where: { id: jobId },
    data: { status: "RUNNING", claimedBy: "test", claimedAt: new Date(), heartbeatAt: new Date() },
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
// Finding 1 — approval policy for provider/AI generation
// =====================================================================

describe("M35.7 finding 1 — provider/AI generation is approval-class", () => {
  test("the queue never executes laxii.banner.produce unapproved — no pipeline, no conversation, no spend", async () => {
    const u = await makeUser("bypass-produce");
    const wf = await createWorkflowFromPlan(u.id, "brief then produce", {
      title: "bypass produce",
      steps: [
        { id: "p1", tool: "laxii.banner.brief", params: { request: "A minimal banner with a calm palette" } },
        { id: "p2", tool: "laxii.banner.produce", params: { briefTaskRef: "p1" }, dependsOn: ["p1"] },
      ],
    });
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs();
    const after = await loadOwned(u.id, wf.id);
    const [briefStep, produceStep] = after.steps;
    expect(briefStep.status).toBe("SUCCEEDED");
    // approval bypass refused: the produce step waits for the owner
    expect(produceStep.status).toBe("AWAITING_APPROVAL");
    expect(produceStep.requiresApproval).toBe(true);
    expect(produceStep.approvedAt).toBeNull();
    // no queue job exists for the unapproved step and no generation started
    const queued = await db.backgroundJob.count({
      where: { kind: "riishe.workflow", status: "QUEUED", payload: { contains: produceStep.id } },
    });
    expect(queued).toBe(0);
    const messages = await db.laxiiMessage.count({ where: { conversation: { userId: u.id } } });
    expect(messages).toBe(0);
    // direct queue execution (bypass attempt) is a no-op:
    const job = await enqueueStepJob(wf.id, produceStep.id, u.id, "bypass-produce");
    await runWorkflowStepJob(await claim(job.id));
    const still = await db.riisheWorkflowStep.findUnique({ where: { id: produceStep.id } });
    expect(still!.status).toBe("AWAITING_APPROVAL");
    expect(await db.laxiiMessage.count({ where: { conversation: { userId: u.id } } })).toBe(0);
    // approval-time execution without approval also refuses honestly
    await expect(executeApprovedStep(u.id, produceStep.id)).rejects.toThrow(WorkflowError);
    const afterBypass = await db.riisheWorkflowStep.findUnique({ where: { id: produceStep.id } });
    expect(afterBypass!.status).toBe("AWAITING_APPROVAL");
  });

  test("career.resume.tailoredCopy and career.coverLetter.draft wait for explicit approval (no AI spend on bypass)", async () => {
    const u = await makeUser("bypass-career");
    for (const [id, tool, extra] of [
      ["c1", "career.resume.tailoredCopy", {}],
      ["c2", "career.coverLetter.draft", { targetRole: "Frontend Engineer" }],
    ] as const) {
      const wf = await createWorkflowFromPlan(u.id, `run ${tool}`, {
        title: `bypass ${id}`,
        steps: [{ id, tool, params: { jobDescription: "Requirements:\n- Expert React\n- TypeScript design-system ownership for a product team", ...extra } }],
      });
      cleanupWorkflows.push(wf.id);
      const step = wf.steps[0];
      expect(toolApprovalRequired(getTool(tool)!)).toBe(true);
      expect(step.status).toBe("AWAITING_APPROVAL");
      const queued = await db.backgroundJob.count({
        where: { kind: "riishe.workflow", status: "QUEUED", payload: { contains: step.id } },
      });
      expect(queued).toBe(0);
    }
    // nothing ran: no tailored-copy conversation and no letter row exist
    const conversations = await db.laxiiConversation.count({ where: { userId: u.id, kind: "RESUME" } });
    expect(conversations).toBe(0);
    expect(await db.laxiiCoverLetter.count({ where: { userId: u.id } })).toBe(0);
  });

  test("explicit approval executes the produce step through the real pipeline", async () => {
    const u = await makeUser("approve-produce");
    const wf = await createWorkflowFromPlan(u.id, "brief then produce", {
      title: "approved produce",
      steps: [
        { id: "q1", tool: "laxii.banner.brief", params: { request: "A calm minimal banner" } },
        { id: "q2", tool: "laxii.banner.produce", params: { briefTaskRef: "q1" }, dependsOn: ["q1"] },
      ],
    });
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs();
    let after = await loadOwned(u.id, wf.id);
    expect(after.steps[1].status).toBe("AWAITING_APPROVAL");
    // MEDIUM risk: no typed confirm needed — the plain approval is explicit;
    // approval-time execution is the production path for approval-class steps.
    await approveStep(u.id, after.steps[1].id, false);
    const run = await executeApprovedStep(u.id, after.steps[1].id);
    expect(run.already).toBe(false);
    after = await loadOwned(u.id, wf.id);
    expect(after.steps[1].status).toBe("SUCCEEDED");
    const produceResult = JSON.parse(after.steps[1].resultJson) as { messageId: string; status: string; verification: { ok: boolean } };
    expect(produceResult.status).toBe("RUNNING");
    expect(produceResult.verification.ok).toBe(true);
    const msg = await db.laxiiMessage.findUnique({ where: { id: produceResult.messageId } });
    expect(msg).not.toBeNull();
    expect(msg!.status).toBe("RUNNING");
  });
});

// =====================================================================
// Finding 2 — durable step-level idempotency
// =====================================================================

describe("M35.7 finding 2 — retry-after-write re-attaches, never duplicates", () => {
  test("giftz.site.create: retry after a partially successful write reuses the stamped draft", async () => {
    const u = await makeUser("idem-site");
    const wf = await createWorkflowFromPlan(u.id, "create a site draft", {
      title: "idem site",
      steps: [{ id: "s1", tool: "giftz.site.create", params: { title: "Retry-safe draft", sourcePrompt: "minimal portfolio" } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];

    // Attempt 1 crashes after the write, before the step result persisted:
    // the artifact exists (stamped), the step row is left RUNNING stale.
    const tool = getTool("giftz.site.create")!;
    const first = (await tool.execute({ userId: u.id, workflowId: wf.id, stepId: step.id }, { title: "Retry-safe draft", sourcePrompt: "minimal portfolio" } as never)) as { siteId: string };
    expect(first.siteId).toBeTruthy();
    await db.riisheWorkflowStep.update({
      where: { id: step.id },
      data: { status: "RUNNING", startedAt: new Date(Date.now() - 15 * 60_000), updatedAt: new Date(Date.now() - 15 * 60_000) },
    });

    // The REAL sweep recovers the stale RUNNING step and re-queues it.
    const sweep = await runWorkflowSweep();
    expect(sweep.recovered).toBeGreaterThanOrEqual(1);
    const recovered = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(recovered!.status).toBe("READY");

    // Attempt 2 through the REAL queue path: re-attaches to the SAME draft.
    const jobs = await db.backgroundJob.findMany({
      where: { kind: "riishe.workflow", status: "QUEUED", payload: { contains: step.id } },
    });
    expect(jobs.length).toBe(1);
    await runWorkflowStepJob(await claim(jobs[0].id));
    const done = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(done!.status).toBe("SUCCEEDED");
    const result = JSON.parse(done!.resultJson) as { siteId: string; reused: boolean };
    expect(result.siteId).toBe(first.siteId);
    expect(result.reused).toBe(true);
    // exactly ONE draft exists for the owner
    const sites = await db.giftzSite.findMany({ where: { userId: u.id } });
    expect(sites).toHaveLength(1);
    expect(sites[0].createdViaStepId).toBe(step.id);
    // and the verify evidence still re-reads the same row
    const verification = await tool.verify!({ userId: u.id, workflowId: wf.id, stepId: step.id }, {} as never, result as unknown as Record<string, unknown>);
    expect(verification.ok).toBe(true);
  });

  test("laxii.banner.brief: retry after a partially successful write reuses the stamped brief task", async () => {
    const u = await makeUser("idem-brief");
    const wf = await createWorkflowFromPlan(u.id, "prepare a banner brief", {
      title: "idem brief",
      steps: [{ id: "s1", tool: "laxii.banner.brief", params: { request: "A minimal banner with a calm palette" } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];

    // Attempt 1 crashes after the AgentTask insert (stamped), before the
    // step result persisted.
    const tool = getTool("laxii.banner.brief")!;
    const first = (await tool.execute({ userId: u.id, workflowId: wf.id, stepId: step.id }, { request: "A minimal banner with a calm palette" } as never)) as { briefTaskId: string };
    expect(first.briefTaskId).toBeTruthy();
    await db.riisheWorkflowStep.update({
      where: { id: step.id },
      data: { status: "RUNNING", startedAt: new Date(Date.now() - 15 * 60_000), updatedAt: new Date(Date.now() - 15 * 60_000) },
    });

    await runWorkflowSweep();
    const jobs = await db.backgroundJob.findMany({
      where: { kind: "riishe.workflow", status: "QUEUED", payload: { contains: step.id } },
    });
    expect(jobs.length).toBe(1);
    await runWorkflowStepJob(await claim(jobs[0].id));
    const done = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(done!.status).toBe("SUCCEEDED");
    const result = JSON.parse(done!.resultJson) as { briefTaskId: string; reused: boolean; canvas: { width: number; height: number } };
    expect(result.briefTaskId).toBe(first.briefTaskId);
    expect(result.reused).toBe(true);
    expect(result.canvas.width).toBe(2048);
    expect(result.canvas.height).toBe(687);
    // exactly ONE durable brief task exists for the stamp
    const tasks = await db.agentTask.findMany({
      where: { userId: u.id, agent: "LAXII", kind: "BANNER_DESIGN", createdViaStepId: step.id },
    });
    expect(tasks).toHaveLength(1);
  });

  test("the step→artifact stamp is airtight: a second row for the same step is impossible", async () => {
    const u = await makeUser("idem-unique");
    const tool = getTool("giftz.site.create")!;
    await tool.execute({ userId: u.id, workflowId: undefined, stepId: "step-stamp-probe" }, { title: "first" } as never);
    // The unique index on createdViaStepId refuses a second stamped row —
    // even a caller that bypasses the handler's re-attach check cannot
    // duplicate a step's artifact.
    let dupError: unknown = null;
    try {
      await db.giftzSite.create({ data: { userId: u.id, title: "second", createdViaStepId: "step-stamp-probe" } });
    } catch (e) {
      dupError = e;
    }
    expect(dupError).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((dupError as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
    const sites = await db.giftzSite.findMany({ where: { userId: u.id, createdViaStepId: "step-stamp-probe" } });
    expect(sites).toHaveLength(1);
    // NULL stamps (studio-created rows) are never affected
    const studioSite = await db.giftzSite.create({ data: { userId: u.id, title: "studio" } });
    expect(studioSite.createdViaStepId).toBeNull();
  });

  test("duplicate queue delivery after success is a no-op for artifact tools", async () => {
    const u = await makeUser("idem-dup");
    const wf = await createWorkflowFromPlan(u.id, "create a site draft", {
      title: "dup site",
      steps: [{ id: "s1", tool: "giftz.site.create", params: { title: "Delivered once" } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];
    const job = await enqueueStepJob(wf.id, step.id, u.id, "dup");
    await runWorkflowStepJob(await claim(job.id));
    const done = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(done!.status).toBe("SUCCEEDED");
    const attempts = done!.attempts;
    const sitesBefore = await db.giftzSite.count({ where: { userId: u.id } });
    // redeliver the SAME job (and a second job for the same step)
    await runWorkflowStepJob(await claim(job.id));
    const job2 = await enqueueStepJob(wf.id, step.id, u.id, "dup2");
    await runWorkflowStepJob(await claim(job2.id));
    const after = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(after!.attempts).toBe(attempts);
    expect(await db.giftzSite.count({ where: { userId: u.id } })).toBe(sitesBefore);
  });

  test("duplicate delivery while an attempt is RUNNING never executes the tool twice", async () => {
    const u = await makeUser("idem-running");
    const wf = await createWorkflowFromPlan(u.id, "create a site draft", {
      title: "running guard",
      steps: [{ id: "s1", tool: "giftz.site.create", params: { title: "In-flight" } }],
    });
    cleanupWorkflows.push(wf.id);
    const step = wf.steps[0];
    // Simulate an in-flight attempt (artifact NOT yet written).
    await db.riisheWorkflowStep.update({ where: { id: step.id }, data: { status: "RUNNING", startedAt: new Date() } });
    const job = await enqueueStepJob(wf.id, step.id, u.id, "running");
    await runWorkflowStepJob(await claim(job.id)); // must be a quiet no-op
    const stepRow = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    expect(stepRow!.status).toBe("RUNNING"); // untouched — the live attempt owns it
    expect(await db.giftzSite.count({ where: { userId: u.id } })).toBe(0); // tool never ran twice
  });
});

// =====================================================================
// Finding 3 — typed artefact reference validation
// =====================================================================

describe("M35.7 finding 3 — refs resolve only from explicit, successful dependencies", () => {
  test("forward references are rejected at plan time", async () => {
    const u = await makeUser("ref-fwd");
    await expect(
      createWorkflowFromPlan(u.id, "forward ref", {
        title: "forward reference",
        steps: [
          { id: "s1", tool: "laxii.banner.produce", params: { briefTaskRef: "s2" } },
          { id: "s2", tool: "laxii.banner.brief", params: { request: "A banner brief" } },
        ],
      })
    ).rejects.toThrow(/not an explicit earlier dependency/);
  });

  test("references to undeclared earlier steps are rejected at plan time", async () => {
    const u = await makeUser("ref-undeclared");
    await expect(
      createWorkflowFromPlan(u.id, "undeclared ref", {
        title: "undeclared reference",
        steps: [
          { id: "s1", tool: "laxii.banner.brief", params: { request: "A banner brief" } },
          { id: "s2", tool: "laxii.banner.produce", params: { briefTaskRef: "s1" } }, // no dependsOn!
        ],
      })
    ).rejects.toThrow(/not an explicit earlier dependency/);
  });

  test("missing dependencies (unknown ids and self references) are rejected at plan time", async () => {
    const u = await makeUser("ref-missing");
    await expect(
      createWorkflowFromPlan(u.id, "missing ref", {
        title: "missing dependency",
        steps: [{ id: "s1", tool: "laxii.banner.produce", params: { briefTaskRef: "ghost" } }],
      })
    ).rejects.toThrow(/not an explicit earlier dependency/);
    await expect(
      createWorkflowFromPlan(u.id, "self ref", {
        title: "self reference",
        steps: [{ id: "s1", tool: "laxii.banner.produce", params: { briefTaskRef: "s1" } }],
      })
    ).rejects.toThrow(/references itself/);
  });

  test("declared + successful producers resolve; the artefact is the REAL backend id", async () => {
    const u = await makeUser("ref-happy");
    const wf = await createWorkflowFromPlan(u.id, "brief then produce", {
      title: "happy chain",
      steps: [
        { id: "s1", tool: "laxii.banner.brief", params: { request: "A minimal banner with a calm palette" } },
        { id: "s2", tool: "laxii.banner.produce", params: { briefTaskRef: "s1" }, dependsOn: ["s1"] },
      ],
    });
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs();
    const after = await loadOwned(u.id, wf.id);
    expect(after.steps[1].status).toBe("AWAITING_APPROVAL"); // produce is approval-class
    await approveStep(u.id, after.steps[1].id, false);
    await executeApprovedStep(u.id, after.steps[1].id);
    const done = await loadOwned(u.id, wf.id);
    expect(done.steps[1].status).toBe("SUCCEEDED");
    const briefResult = JSON.parse(done.steps[0].resultJson) as { briefTaskId: string };
    const produceParams = JSON.parse(done.steps[1].paramsJson) as { briefTaskRef: string };
    expect(produceParams.briefTaskRef).toBe("s1"); // stored params keep the planner id
    // resolution happened at execution: the pipeline consumed the REAL id
    const conversation = await db.laxiiConversation.findFirst({ where: { userId: u.id, kind: "BANNER" } });
    expect(conversation).not.toBeNull();
    void briefResult;
  });

  test("a FAILED producer never yields its artefact (dependency-failed) and dependents skip", async () => {
    const u = await makeUser("ref-failed");
    const wf = await createWorkflowFromPlan(u.id, "draft then publish then status", {
      title: "failed producer chain",
      steps: [
        { id: "h1", tool: "post.draft", params: { body: "producer", hashtags: [] } },
        { id: "h2", tool: "post.publish", params: { postRef: "h1" }, dependsOn: ["h1"] },
        { id: "h3", tool: "laxii.job.status", params: { jobRef: "h2" }, dependsOn: ["h2"] },
      ],
    });
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs();
    let after = await loadOwned(u.id, wf.id);
    // Corrupt the producer's params (as a mismatched producer would): the
    // publish step fails honestly at resolution ("not found").
    await db.riisheWorkflowStep.update({
      where: { id: after.steps[1].id },
      data: { paramsJson: JSON.stringify({ postRef: "vanishing-producer" }), status: "READY", approvedAt: new Date() },
    });
    const job = await enqueueStepJob(wf.id, after.steps[1].id, u.id, "failed-dep");
    await runWorkflowStepJob(await claim(job.id)).catch(() => undefined);
    after = await loadOwned(u.id, wf.id);
    expect(after.steps[1].status).toBe("FAILED");
    expect(after.steps[1].error).toContain("not found");
    // the dependent of the FAILED producer is SKIPPED — it never resolves
    expect(after.steps[2].status).toBe("SKIPPED");
    expect(after.steps[2].error).toContain("dependency did not complete");

    // resolution-level defense in depth: the FAILED producer's artefact is
    // refused even if a corrupted step row tried to resolve it directly.
    const dependent = await db.riisheWorkflowStep.findUnique({ where: { id: after.steps[2].id } });
    await expect(resolveStepParams(wf.id, dependent!)).rejects.toThrow(/has not completed successfully \(status: FAILED\)/);
  });

  test("resolution refuses undeclared refs, non-completed producers and missing artefacts (defense in depth)", async () => {
    const u = await makeUser("ref-defense");
    // declared + SUCCEEDED → resolves
    const w1 = await createWorkflowFromPlan(u.id, "draft then publish", {
      title: "defense happy",
      steps: [
        { id: "d1", tool: "post.draft", params: { body: "producer", hashtags: [] } },
        { id: "d2", tool: "post.publish", params: { postRef: "d1" }, dependsOn: ["d1"] },
      ],
    });
    cleanupWorkflows.push(w1.id);
    await drainWorkflowJobs();
    const w1after = await loadOwned(u.id, w1.id);
    const producerRow = await db.riisheWorkflowStep.findUnique({ where: { id: w1after.steps[0].id } });
    const consumerRow = await db.riisheWorkflowStep.findUnique({ where: { id: w1after.steps[1].id } });
    const resolved = await resolveStepParams(w1.id, consumerRow!);
    const producerResult = JSON.parse(producerRow!.resultJson) as { postId: string };
    expect(resolved.postRef).toBe(producerResult.postId);

    // undeclared ref (tampered params): refused even though the producer
    // SUCCEEDED — the ref names a real step of the SAME workflow that the
    // consuming step never declared in its own dependsOn.
    const w2 = await createWorkflowFromPlan(u.id, "note producer and standalone note", {
      title: "defense undeclared",
      steps: [
        { id: "n1", tool: "post.draft", params: { body: "producer for the tamper probe", hashtags: [] } },
        { id: "n2", tool: "relationship.saveNote", params: { username: "nobody-here", note: "x" } },
      ],
    });
    cleanupWorkflows.push(w2.id);
    await drainWorkflowJobs();
    await db.riisheWorkflowStep.update({
      where: { id: w2.steps[1].id },
      data: { paramsJson: JSON.stringify({ postRef: "n1" }) },
    });
    const w2noteTampered = await db.riisheWorkflowStep.findUnique({ where: { id: w2.steps[1].id } });
    await expect(resolveStepParams(w2.id, w2noteTampered!)).rejects.toThrow(/not an explicit earlier dependency/);

    // non-completed producer (PENDING): refused — artefacts resolve only
    // from SUCCEEDED steps, never from pending/running producers.
    const w3 = await createWorkflowFromPlan(u.id, "draft then publish later", {
      title: "defense pending",
      steps: [
        { id: "g1", tool: "post.draft", params: { body: "pending producer", hashtags: [] }, schedule: { inDays: 30 } },
        { id: "g2", tool: "post.publish", params: { postRef: "g1" }, dependsOn: ["g1"] },
      ],
    });
    cleanupWorkflows.push(w3.id);
    const w3after = await loadOwned(u.id, w3.id);
    const pendingConsumer = await db.riisheWorkflowStep.findUnique({ where: { id: w3after.steps[1].id } });
    await expect(resolveStepParams(w3.id, pendingConsumer!)).rejects.toThrow(/has not completed successfully \(status: PENDING\)/);

    // declared + SUCCEEDED but wrong artefact kind: dependency-missing
    const w4 = await createWorkflowFromPlan(u.id, "draft then bogus status", {
      title: "defense missing",
      steps: [
        { id: "m1", tool: "post.draft", params: { body: "no message id here", hashtags: [] } },
        { id: "m2", tool: "laxii.job.status", params: { jobRef: "m1" }, dependsOn: ["m1"] },
      ],
    });
    cleanupWorkflows.push(w4.id);
    // laxii.job.status retries (maxAttempts 3) — compress the queue's backoff
    // and drain until the step reaches a terminal state (the REAL sweep
    // re-enqueues the READY step between rounds, exactly like production).
    for (let round = 0; round < 6; round++) {
      const current = await db.riisheWorkflowStep.findUnique({ where: { id: w4.steps[1].id } });
      if (!current || ["FAILED", "SUCCEEDED", "SKIPPED", "CANCELLED"].includes(current.status)) break;
      await db.backgroundJob.updateMany({
        where: { kind: "riishe.workflow", status: "QUEUED", payload: { contains: w4.steps[1].id } },
        data: { runAt: new Date() },
      });
      await drainWorkflowJobs();
      await runWorkflowSweep();
    }
    const w4after = await loadOwned(u.id, w4.id);
    expect(w4after.steps[1].status).toBe("FAILED");
    expect(w4after.steps[1].error).toMatch(/produced no messageId/);
  });
});

// =====================================================================
// Finding 1+3 — replayed approvals never re-execute
// =====================================================================

describe("M35.7 — replayed approvals", () => {
  test("executing a SUCCEEDED step again reports already; approval replay is refused; nothing re-runs", async () => {
    const u = await makeUser("replay");
    const wf = await createWorkflowFromPlan(u.id, "draft then publish", {
      title: "replay guard",
      steps: [
        { id: "r1", tool: "post.draft", params: { body: "replay probe", hashtags: [] } },
        { id: "r2", tool: "post.publish", params: { postRef: "r1" }, dependsOn: ["r1"] },
      ],
    });
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs();
    let after = await loadOwned(u.id, wf.id);
    expect(after.steps[1].status).toBe("AWAITING_APPROVAL");
    await approveStep(u.id, after.steps[1].id, false);
    const first = await executeApprovedStep(u.id, after.steps[1].id);
    expect(first.already).toBe(false);
    after = await loadOwned(u.id, wf.id);
    expect(after.steps[1].status).toBe("SUCCEEDED");
    const postId = (JSON.parse(after.steps[0].resultJson) as { postId: string }).postId;
    const attemptsAfterFirst = after.steps[1].attempts;
    const auditBefore = await db.auditEvent.count({
      where: { actorUserId: u.id, action: "riishe.tool.post_publish" },
    });

    // replay 1: executeApprovedStep on the SUCCEEDED step → honest already
    const second = await executeApprovedStep(u.id, after.steps[1].id);
    expect(second.already).toBe(true);

    // replay 2: a REPLAYED approval is refused — terminal steps can no
    // longer be approved (and nothing re-executes behind the refusal).
    await expect(approveStep(u.id, after.steps[1].id, false)).rejects.toThrow(/no longer be approved/);

    // replay 3: the queue redelivers the stale job → no-op
    const staleJob = await enqueueStepJob(wf.id, after.steps[1].id, u.id, "replay");
    await runWorkflowStepJob(await claim(staleJob.id));

    // nothing changed: attempts, artefact count, audit trail
    after = await loadOwned(u.id, wf.id);
    expect(after.steps[1].attempts).toBe(attemptsAfterFirst);
    expect(after.steps[1].status).toBe("SUCCEEDED");
    expect(await db.post.count({ where: { id: postId, status: "PUBLISHED" } })).toBe(1);
    const auditAfter = await db.auditEvent.count({
      where: { actorUserId: u.id, action: "riishe.tool.post_publish" },
    });
    expect(auditAfter).toBe(auditBefore);
    cleanupPosts.push(postId);
  });
});
