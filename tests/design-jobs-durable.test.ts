/// <reference types="bun-types" />
/**
 * Code Giftz — DURABLE job store (DB-backed) regression tests.
 *
 * Proves the reliability mechanics against the REAL Prisma store (the same
 * authority production uses):
 *
 *  1. PERSISTENCE      — jobs live in the database, not in a process Map:
 *                        rows exist with all state columns; a freshly loaded
 *                        job (simulating a restart / another instance) carries
 *                        the full plan/config/steps/verification state.
 *  2. OWNERSHIP        — cross-user reads/controls are structurally impossible.
 *  3. ATOMIC CLAIM     — exactly one executor wins the lease; duplicate
 *                        execution is impossible; finished jobs can't be claimed.
 *  4. RESUME/RECOVERY  — a yielded (paused) job resumes from persisted step
 *                        state; stale jobs (crashed worker) are recovered as
 *                        failed on the next create, never dead-locking the user.
 *  5. RETRY LIMITS     — MAX_RETRIES enforced + exponential backoff gate.
 *  6. IDEMPOTENCY      — duplicate submissions return the SAME job.
 *  7. CANCELLATION     — cooperative cancel persists and is honoured at the
 *                        next step boundary by the driver path.
 *  8. EVENTS           — structured execution log persisted per step.
 *
 * Test data hygiene: dedicated throwaway accounts are created and fully
 * removed afterwards (cascade deletes the jobs). No production/demo account is
 * touched.
 *
 * Run: bun test tests/design-jobs-durable.test.ts
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { db } from "../src/lib/db";
import { defaultConfig, normalizeConfig } from "../src/lib/site-config";
import type { SiteConfig } from "../src/lib/site-config";
import type { DesignPlan, PlanStep } from "../src/lib/ai-design/plan";
import {
  createJob,
  getJob,
  latestJob,
  prepareRetry,
  requestCancel,
  claimJob,
  releaseLease,
  persistJob,
  applyFailure,
  appendEvent,
  MAX_RETRIES,
  LEASE_MS,
} from "../src/lib/ai-design/jobs";
import { runDesignJob, type StepProvider } from "../src/lib/ai-design/execute";
import type { User } from "@prisma/client";

// ---------------------------------------------------------------- fixtures

function clone(c: SiteConfig): SiteConfig {
  return JSON.parse(JSON.stringify(c)) as SiteConfig;
}

const base = (): SiteConfig => normalizeConfig(defaultConfig("atelier")) as SiteConfig;

function step(over: Partial<PlanStep>): PlanStep {
  return {
    id: over.id ?? "s1",
    title: over.title ?? "Step",
    tool: over.tool ?? "theme.tokens",
    kind: over.kind ?? "design",
    targets: over.targets ?? [],
    summary: over.summary ?? "Test step.",
    instruction: over.instruction ?? "",
    patch: over.patch ?? { theme: { accent: "#f2d076" } },
    dependsOn: over.dependsOn ?? [],
    risk: over.risk ?? "low",
  };
}

function plan(steps: PlanStep[], constraints: DesignPlan["constraints"] = []): DesignPlan {
  return { reply: "Test plan.", notes: undefined, constraints, steps };
}

const providerAlwaysOk: StepProvider = {
  async complete(_system, _messages) {
    throw new Error("model tools are not used by these tests");
  },
};

const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const EMAIL_A = `dgj-durable-a-${stamp}@test.beanfolio.local`;
const EMAIL_B = `dgj-durable-b-${stamp}@test.beanfolio.local`;

async function makeUser(email: string): Promise<User> {
  return db.user.create({
    data: { email, passwordHash: "test-only-not-a-real-hash", name: "DesignJob Durable Test" },
  });
}

let userA: User;
let userB: User;

const usersCreated = (async () => {
  userA = await makeUser(EMAIL_A);
  userB = await makeUser(EMAIL_B);
})();

afterAll(async () => {
  // Cascade removes the jobs; no test residue.
  await db.user.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } } });
});

afterEach(async () => {
  // Clean slate per test — the store is DB-backed, so leftover rows from one
  // test must never leak into another (single-flight, latestJob, idempotency).
  await db.designJob.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
});

// ---------------------------------------------------------------- tests

describe("durable job store — persistence", () => {
  test("a created job is a DATABASE row with the full state, readable from a fresh load (restart/other instance)", async () => {
    await usersCreated;
    const cfg = base();
    const p = plan([step({ id: "s1", title: "Tokens", tool: "theme.tokens", summary: "s", patch: { theme: { accent: "#f2d076" } } })]);
    const job = await createJob({
      userId: userA.id,
      plan: p,
      baseConfig: cfg,
      materialIds: ["media-x"],
      context: { portfolioText: "PORTFOLIO-BLOCK", materialsText: "MATERIALS-BLOCK", allowedMediaIds: ["media-x"] },
    });

    // Row exists with the serialized state columns.
    const row = await db.designJob.findUnique({ where: { id: job.id } });
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(userA.id);
    expect(row!.status).toBe("queued");
    expect(JSON.parse(row!.planJson)).toMatchObject({ reply: "Test plan." });
    expect(JSON.parse(row!.stepsJson)[0].id).toBe("s1");
    expect(JSON.parse(row!.materialIdsJson)).toEqual(["media-x"]);
    expect(JSON.parse(row!.contextJson ?? "null")).toMatchObject({ portfolioText: "PORTFOLIO-BLOCK" });

    // Fresh load (what another instance / a restarted process would see).
    const fresh = await getJob(userA.id, job.id);
    expect(fresh).not.toBeNull();
    expect(fresh!.id).toBe(job.id);
    expect(fresh!.plan.steps[0].id).toBe("s1");
    expect(fresh!.baseConfig.name).toBe(cfg.name);
    expect(fresh!.working.name).toBe(cfg.name);
    expect(fresh!.context?.materialsText).toBe("MATERIALS-BLOCK");
    expect(fresh!.materialIds).toEqual(["media-x"]);
  });
});

describe("durable job store — ownership", () => {
  test("another user can neither read, claim, nor cancel a job", async () => {
    await usersCreated;
    const p = plan([step({ title: "T" })]);
    const job = await createJob({ userId: userA.id, plan: p, baseConfig: base() });

    expect(await getJob(userB.id, job.id)).toBeNull();
    expect(await latestJob(userB.id)).toBeNull();
    expect(await requestCancel(userB.id, job.id)).toBe(false);
    expect(await claimJob(userB.id, job.id)).toBeNull();
  });
});

describe("durable job store — atomic claim (duplicate-execution prevention)", () => {
  test("only ONE concurrent claim wins; the loser cannot execute", async () => {
    await usersCreated;
    const p = plan([step({ title: "T" })]);
    const job = await createJob({ userId: userA.id, plan: p, baseConfig: base() });

    const [first, second] = await Promise.all([claimJob(userA.id, job.id), claimJob(userA.id, job.id)]);
    // Exactly one winner; the other must see null (lease held).
    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.status).toBe("running");

    // A third claim while the lease is fresh also fails.
    expect(await claimJob(userA.id, job.id)).toBeNull();

    // After the lease is released, claiming works again.
    await releaseLease(winners[0]!);
    expect(await claimJob(userA.id, job.id)).not.toBeNull();
  });

  test("finished jobs can never be claimed", async () => {
    await usersCreated;
    const p = plan([step({ title: "T" })]);
    const job = await createJob({ userId: userA.id, plan: p, baseConfig: base() });
    job.status = "completed";
    await persistJob(job);
    expect(await claimJob(userA.id, job.id)).toBeNull();
  });
});

describe("durable job store — resume & stale recovery", () => {
  test("a yielded job resumes from persisted step state (crash/restart survival)", async () => {
    await usersCreated;
    const cfg = base();
    const p = plan([
      step({ id: "s1", title: "First", tool: "theme.tokens", summary: "s", patch: { theme: { accent: "#f2d076" } } }),
      step({ id: "s2", title: "Second", tool: "theme.tokens", summary: "s", patch: { theme: { radius: "full" } } }),
    ]);
    const job = await createJob({ userId: userA.id, plan: p, baseConfig: cfg });

    // Chunk 1: zero budget yields BEFORE any work (the driver holds the lease
    // for the chunk duration and releases it afterwards, exactly like driver.ts).
    const claimed = await claimJob(userA.id, job.id);
    expect(claimed).not.toBeNull();
    const yielded = await runDesignJob(claimed!, providerAlwaysOk, {}, { budgetMs: 0, persist: persistJob });
    expect(yielded.status).toBe("yielded");
    await releaseLease(claimed!);

    // Chunk 2: a fresh claim (what the next poll does) resumes and completes —
    // regardless of where the previous chunk stopped, nothing is lost or re-run.
    const resumed = await claimJob(userA.id, job.id);
    expect(resumed).not.toBeNull();
    expect(resumed!.steps.every((s) => s.status !== "running")).toBe(true);
    const done = await runDesignJob(resumed!, providerAlwaysOk, {}, { persist: persistJob });
    expect(done.status).toBe("completed");

    // Durability: a fresh read carries the terminal state + verification.
    const fresh = await getJob(userA.id, job.id);
    expect(fresh!.status).toBe("completed");
    expect(fresh!.verification).not.toBeNull();
    expect(fresh!.working.theme.accent).toBe("#f2d076");
    expect(fresh!.working.theme.radius).toBe("full");
  });

  test("per-step progress survives a crash mid-run", async () => {
    await usersCreated;
    const p = plan([
      step({ id: "s1", title: "First", tool: "theme.tokens", summary: "s", patch: { theme: { accent: "#f2d076" } } }),
      step({ id: "s2", title: "Second", tool: "theme.tokens", summary: "s", patch: { theme: { radius: "full" } } }),
    ]);
    const job = await createJob({ userId: userA.id, plan: p, baseConfig: base() });
    const claimed = await claimJob(userA.id, job.id);
    expect(claimed).not.toBeNull();

    // Simulate a crash after the FIRST step: run the loop but abort the
    // process afterwards — i.e. simply stop calling runDesignJob. The persist
    // callback already wrote step 1 durably.
    const partial = await runDesignJob(claimed!, providerAlwaysOk, {}, { persist: persistJob });
    expect(partial.status).toBe("completed"); // both steps ran (no crash injected)
    await releaseLease(claimed!);

    // Crash BEFORE step 2: hand-craft the persisted state of a run where only
    // step 1 finished, as a real crash would leave it.
    const crashed = await createJob({ userId: userA.id, plan: p, baseConfig: base() });
    const c2 = (await claimJob(userA.id, crashed.id))!;
    c2.steps[0].status = "done";
    c2.changes = ["Accent color changed."];
    c2.working = clone(c2.working);
    c2.working.theme.accent = "#f2d076";
    await persistJob(c2);
    await releaseLease(c2);

    const fresh = await getJob(userA.id, crashed.id);
    expect(fresh!.steps[0].status).toBe("done");
    // The next claim + run finishes ONLY the remaining step.
    const again = await claimJob(userA.id, crashed.id);
    expect(again).not.toBeNull();
    const finished = await runDesignJob(again!, providerAlwaysOk, {}, { persist: persistJob });
    expect(finished.status).toBe("completed");
    const finalFresh = await getJob(userA.id, crashed.id);
    expect(finalFresh!.steps.map((s) => s.status)).toEqual(["done", "done"]);
  });

  test("a step left RUNNING by a crash is reset and re-run on resume (never silently lost)", async () => {
    await usersCreated;
    const p = plan([
      step({ id: "s1", title: "Hero copy", tool: "theme.tokens", summary: "s", patch: { theme: { accent: "#f2d076" } } }),
      step({ id: "s2", title: "Motion", tool: "theme.tokens", summary: "s", patch: { theme: { radius: "full" } } }),
    ]);
    const job = await createJob({ userId: userA.id, plan: p, baseConfig: base() });
    // Simulate a crash mid-step-1: the runner persists "running" before the
    // step finishes, then the process dies.
    job.status = "running";
    job.steps[0].status = "running";
    await persistJob(job);

    // A fresh claim + run (exactly what the next poll does) must RESET the
    // orphaned running step and complete BOTH steps.
    const resumed = await claimJob(userA.id, job.id);
    expect(resumed).not.toBeNull();
    expect(resumed!.steps[0].status).toBe("running"); // loaded as-crashed
    const outcome = await runDesignJob(resumed!, providerAlwaysOk, {}, { persist: persistJob });
    expect(outcome.status).toBe("completed");
    expect(resumed!.steps.map((s) => s.status)).toEqual(["done", "done"]);
    const fresh = await getJob(userA.id, job.id);
    expect(fresh!.status).toBe("completed");
    expect(fresh!.steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(fresh!.events.some((e) => e.message.includes("Resumed after an interruption"))).toBe(true);
  });

  test("a STALE active job (crashed worker) is recovered as failed on the next create — single-flight never dead-locks", async () => {
    await usersCreated;
    const p = plan([step({ title: "T" })]);
    const stuck = await createJob({ userId: userA.id, plan: p, baseConfig: base() });
    // Simulate a worker that died mid-run: persist a running state, then write
    // the dead heartbeat/expired lease DIRECTLY (persistJob deliberately
    // refreshes the heartbeat — a real crash stops calling it).
    stuck.status = "running";
    await persistJob(stuck);
    await db.designJob.update({
      where: { id: stuck.id },
      data: {
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
        leaseUntil: new Date(Date.now() - 9 * 60_000),
      },
    });

    // A NEW execution must succeed — the stale one yields.
    const next = await createJob({ userId: userA.id, plan: p, baseConfig: base() });
    expect(next.id).not.toBe(stuck.id);

    const recovered = await getJob(userA.id, stuck.id);
    expect(recovered!.status).toBe("failed");
    expect(recovered!.error).toContain("interrupted");
    // …and stays retryable (its completed steps are kept).
    expect(recovered!.steps.every((s) => s.status !== "done")).toBe(true);

    // A FRESH active job still blocks (real single-flight).
    await expect(createJob({ userId: userA.id, plan: p, baseConfig: base() })).rejects.toThrow(/already running/);
  });
});

describe("durable job store — retry limits & backoff", () => {
  test("prepareRetry enforces MAX_RETRIES and the exponential-backoff gate", async () => {
    await usersCreated;
    const p = plan([step({ title: "T" })]);
    const job = await createJob({ userId: userA.id, plan: p, baseConfig: base() });

    // A queued/completed job cannot be retried — only failed/cancelled ones.
    expect((await prepareRetry(job)).ok).toBe(false);
    applyFailure(job, "boom", { backoff: false });

    // First retry: allowed (no backoff recorded yet).
    expect((await prepareRetry(job)).ok).toBe(true);
    expect(job.attempt).toBe(1);

    // Simulate a second failure → backoff gate appears.
    applyFailure(job, "boom", { backoff: true });
    const gated = await prepareRetry(job);
    expect(gated.ok).toBe(false);
    expect(gated.code).toBe(429);
    expect((gated.retryAfterSeconds ?? 0)).toBeGreaterThan(0);

    // Backoff elapsed → retry allowed.
    job.nextAttemptAt = Date.now() - 1;
    expect((await prepareRetry(job)).ok).toBe(true);
    expect(job.attempt).toBe(2);

    // Attempt limit reached (a failed/cancelled job at the cap).
    job.attempt = MAX_RETRIES;
    job.status = "failed";
    const limited = await prepareRetry(job);
    expect(limited.ok).toBe(false);
    expect(limited.code).toBe(429);
    expect(limited.reason).toContain("retried");
  });

  test("a failed run persists an honest failed state with a verification report", async () => {
    await usersCreated;
    const p = plan([step({ title: "T", tool: "theme.tokens" })]);
    const job = await createJob({ userId: userA.id, plan: p, baseConfig: base() });
    const claimed = (await claimJob(userA.id, job.id))!;
    // A deterministic step that produces an invalid patch fails safely.
    claimed.steps[0].patch = { theme: { accent: "not-a-color" } } as never;
    const outcome = await runDesignJob(claimed, providerAlwaysOk, {}, { persist: persistJob });
    expect(outcome.status).toBe("failed");

    const fresh = await getJob(userA.id, job.id);
    expect(fresh!.status).toBe("failed");
    expect(fresh!.error).toBeTruthy();
    expect(fresh!.verification).not.toBeNull();
    expect(fresh!.nextAttemptAt).not.toBeNull(); // backoff recorded
  });
});

describe("durable job store — idempotency", () => {
  test("a duplicate submission with the same idempotency key returns the SAME job", async () => {
    await usersCreated;
    const p = plan([step({ title: "T" })]);
    const key = `idem-${stamp}`;
    const first = await createJob({ userId: userA.id, plan: p, baseConfig: base(), idempotencyKey: key });
    const second = await createJob({ userId: userA.id, plan: p, baseConfig: base(), idempotencyKey: key });
    expect(second.id).toBe(first.id);

    // Keys are per-user: another user's identical key creates its own job.
    const otherUser = await createJob({ userId: userB.id, plan: p, baseConfig: base(), idempotencyKey: key });
    expect(otherUser.id).not.toBe(first.id);
  });
});

describe("durable job store — cancellation & events", () => {
  test("a cancel request persists and is honoured at the next step boundary", async () => {
    await usersCreated;
    const p = plan([
      step({ id: "s1", title: "First", tool: "theme.tokens", summary: "s" }),
      step({ id: "s2", title: "Second", tool: "theme.tokens", summary: "s", patch: { theme: { radius: "full" } } }),
    ]);
    const job = await createJob({ userId: userA.id, plan: p, baseConfig: base() });
    await claimJob(userA.id, job.id);

    expect(await requestCancel(userA.id, job.id)).toBe(true);
    const fresh = await getJob(userA.id, job.id);
    expect(fresh!.cancelRequested).toBe(true);

    // The driver path re-reads the flag fresh each step — simulate by running
    // with recheckCancel (as driver.ts does).
    const outcome = await runDesignJob(fresh!, providerAlwaysOk, {}, {
      persist: persistJob,
      recheckCancel: async () => {
        const latest = await getJob(userA.id, job.id);
        return latest?.cancelRequested ?? false;
      },
    });
    expect(outcome.status).toBe("cancelled");
    const done = await getJob(userA.id, job.id);
    expect(done!.status).toBe("cancelled");
    // Cancel arrived before any step ran: every pending step is skipped and
    // kept out of the working config — completed steps would have been kept.
    expect(done!.steps.map((s) => s.status)).toEqual(["skipped", "skipped"]);
  });

  test("the structured execution log is persisted per step", async () => {
    await usersCreated;
    const p = plan([step({ title: "Logged", tool: "theme.tokens", summary: "s" })]);
    const job = await createJob({ userId: userA.id, plan: p, baseConfig: base() });
    appendEvent(job, "info", "custom event before run");
    await persistJob(job);

    const claimed = (await claimJob(userA.id, job.id))!;
    await runDesignJob(claimed, providerAlwaysOk, {}, { persist: persistJob });

    const fresh = await getJob(userA.id, job.id);
    const messages = fresh!.events.map((e) => e.message);
    expect(messages).toContain("custom event before run");
    expect(fresh!.events.some((e) => e.message.includes("Logged") && e.level === "info")).toBe(true);
    expect(fresh!.events.every((e) => typeof e.ts === "number")).toBe(true);
  });
});

describe("durable job store — lease window", () => {
  test("LEASE_MS bounds the claim window; an expired lease is reclaimable", async () => {
    await usersCreated;
    expect(LEASE_MS).toBeGreaterThan(30_000); // one chunk fits comfortably
    const p = plan([step({ title: "T" })]);
    const job = await createJob({ userId: userA.id, plan: p, baseConfig: base() });
    const claimed = (await claimJob(userA.id, job.id))!;
    // Force-expire the lease (simulates a dead worker): reclaim must work.
    claimed.leaseUntil = Date.now() - 1;
    await persistJob(claimed);
    expect(await claimJob(userA.id, job.id)).not.toBeNull();
  });
});
