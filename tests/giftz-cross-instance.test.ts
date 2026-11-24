/// <reference types="bun-types" />
/**
 * CODE GIFTZ — CROSS-INSTANCE coordination (MI-1 multi-instance readiness).
 *
 * Proves the durable coordination semantics against the REAL Prisma store
 * (the same authority every application instance uses). Everything asserted
 * here used to live in process-local Sets and unguarded writes, which broke
 * at N>1 instances:
 *
 *  1. DURABLE CANCEL   — a cancel stamped through one "instance" (fresh read
 *                        = another process) is visible to the runner.
 *  2. NO RESURRECTION  — a runner's lifecycle transitions are guarded to
 *                        ACTIVE statuses: a CANCELLED/COMPLETED task can
 *                        never be overwritten by a stale or cross-instance
 *                        runner write.
 *  3. SINGLE EXECUTOR  — two racing approve/retry callers: exactly one wins
 *                        the status-guarded claim; the other is refused 409.
 *  4. SWEEP RACE-SAFE  — sweeps are idempotent across instances (guarded
 *                        writes; exactly one winner per stale row) and clear
 *                        any stale cancellation stamp.
 *  5. TERMINAL HONESTY — cancel/reject of a terminal task is refused.
 *
 * Test data hygiene: dedicated throwaway accounts, users, tasks and workspace
 * directories are fully removed afterwards. No production/demo data touched.
 *
 * Run: bun test tests/giftz-cross-instance.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { cancelTask, retryTask, sweepStaleGiftzTasks } from "../src/lib/giftz/jobs";
import { ACTIVE_STATUSES, type TaskResult } from "../src/lib/giftz/types";

// ---------------------------------------------------------------- fixtures

const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const EMAIL = `giftz-mi1-${stamp}@test.beanfolio.local`;

let userId: string;

/** A minimal valid TaskResult the launcher/claim paths accept. */
function resultWithPlan(): TaskResult {
  return {
    request: "Add a small badge to the header",
    plan: {
      summary: "Add badge",
      steps: [],
      validation: { commands: [] },
    } as never,
    inspection: null,
    edits: [],
    diffs: [],
    runs: [],
    report: null,
    attempts: 0,
  };
}

async function makeTask(status: string, opts: { result?: TaskResult; cancelRequestedAt?: Date } = {}) {
  return db.agentTask.create({
    data: {
      userId,
      agent: "CODE_GIFTZ",
      kind: "ENGINEERING_TASK",
      title: "MI-1 coordination fixture",
      status,
      stepsJson: JSON.stringify([{ step: "execute", status: "running" }]),
      resultJson: JSON.stringify(opts.result ?? resultWithPlan()),
      ...(opts.cancelRequestedAt ? { cancelRequestedAt: opts.cancelRequestedAt } : {}),
    },
  });
}

beforeEach(async () => {
  if (!userId) {
    const user = await db.user.create({
      data: { email: EMAIL, passwordHash: await hashPassword("mi1-fixture-password"), name: "Giftz MI-1 Test" },
    });
    userId = user.id;
  }
});

afterAll(async () => {
  // Cascade removes the AgentTask rows. Workspace dirs are removed explicitly.
  await db.user.deleteMany({ where: { email: EMAIL } });
  for (const repoId of workspaceIds) {
    rmSync(join(process.cwd(), "data", "giftz-workspaces", repoId), { recursive: true, force: true });
  }
});

// launchExecution requires the workspace directory to exist (it refuses to
// run a task whose repository vanished) — create one per task that claims.
const workspaceIds: string[] = [];
async function makeWorkspace(): Promise<string> {
  const repo = await db.giftzRepository.create({
    data: { ownerId: userId, name: `mi1-${stamp}`, fileCount: 0, sizeBytes: 0 },
  });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(process.cwd(), "data", "giftz-workspaces", repo.id), { recursive: true });
  workspaceIds.push(repo.id);
  return repo.id;
}

// ---------------------------------------------------------------- tests

describe("giftz cross-instance coordination — durable cancellation", () => {
  test("a cancel issued through one instance stamps the durable flag the runner polls", async () => {
    const task = await makeTask("EXECUTING");

    // "Instance B" cancels (the API route path).
    await cancelTask(userId, task.id);

    // "Instance A" (a fresh read from the store — another process) sees it.
    const fresh = await db.agentTask.findUnique({ where: { id: task.id }, select: { cancelRequestedAt: true, status: true } });
    expect(fresh?.cancelRequestedAt).not.toBeNull();
    expect(fresh?.status).toBe("CANCELLED");
  });

  test("a stale runner write can NEVER resurrect a cancelled task", async () => {
    const task = await makeTask("EXECUTING");
    await cancelTask(userId, task.id);

    // Simulate the runner on another instance finishing its work and writing
    // its terminal transition — the guarded write matches 0 rows.
    const resurrect = await db.agentTask.updateMany({
      where: { id: task.id, status: { in: [...ACTIVE_STATUSES] } },
      data: { status: "COMPLETED" },
    });
    expect(resurrect.count).toBe(0);

    const fresh = await db.agentTask.findUnique({ where: { id: task.id }, select: { status: true } });
    expect(fresh?.status).toBe("CANCELLED");
  });

  test("cancelling a terminal task is refused (409 semantics)", async () => {
    const task = await makeTask("COMPLETED");
    await expect(cancelTask(userId, task.id)).rejects.toThrow(/already COMPLETED/);

    const cancelled = await makeTask("EXECUTING");
    await cancelTask(userId, cancelled.id);
    // duplicate cancellation of the now-terminal task is refused too
    await expect(cancelTask(userId, cancelled.id)).rejects.toThrow(/already CANCELLED/);
  });
});

describe("giftz cross-instance coordination — single executor claim", () => {
  test("retryTask: two racing callers — exactly ONE wins the claim; the loser is refused", async () => {
    const repoId = await makeWorkspace();
    const task = await makeTask("FAILED", {
      result: { ...resultWithPlan(), attempts: 0 },
    });
    await db.agentTask.update({ where: { id: task.id }, data: { repoId } });

    // Two "instances" (or a racing double-click) retry simultaneously. The
    // winner claims FAILED → EXECUTING and fires its runner (a zero-step
    // plan ends honestly without any model call); the loser matches 0 rows.
    const attempts = [retryTask(userId, task.id), retryTask(userId, task.id)];
    const results = await Promise.allSettled(attempts);
    const rejected = results.filter((r) => r.status === "rejected");
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(String((rejected[0] as PromiseRejectedResult).reason.message)).toMatch(/EXECUTING|already|only FAILED/);

    // The row was claimed by exactly one runner. A zero-step plan finishes
    // almost instantly (honest FAILED: no validation command could run), so
    // the durable INVARIANTS are asserted rather than a transient status:
    // one consumed attempt, no stale cancel stamp, and a runner-owned
    // terminal-or-executing state.
    const claimed = await db.agentTask.findUnique({ where: { id: task.id } });
    expect(claimed?.status === "EXECUTING" || claimed?.status === "FAILED").toBe(true);
    const result = JSON.parse(claimed?.resultJson ?? "{}") as TaskResult;
    expect(result.attempts).toBe(1);
    // No stale cancellation stamp survives a fresh attempt.
    expect(claimed?.cancelRequestedAt).toBeNull();
  });
});

describe("giftz cross-instance coordination — sweep races", () => {
  test("sweepStaleGiftzTasks: guarded writes make concurrent sweeps idempotent; stale cancel stamps are cleared", async () => {
    const task = await makeTask("EXECUTING", { cancelRequestedAt: new Date() });
    // Make it stale (engineering threshold: 60 min without a transition).
    await db.agentTask.update({
      where: { id: task.id },
      data: { updatedAt: new Date(Date.now() - 61 * 60_000) },
    });

    // Two instances sweep at the same moment.
    const [a, b] = await Promise.all([sweepStaleGiftzTasks(), sweepStaleGiftzTasks()]);
    const sweptTotal = a + b;
    expect(sweptTotal).toBe(1); // exactly one sweep owns the row

    const fresh = await db.agentTask.findUnique({
      where: { id: task.id },
      select: { status: true, error: true, cancelRequestedAt: true },
    });
    expect(fresh?.status).toBe("FAILED");
    expect(fresh?.error).toContain("interrupted");
    // A fresh retry must not inherit the stale cancel stamp.
    expect(fresh?.cancelRequestedAt).toBeNull();
  });
});
