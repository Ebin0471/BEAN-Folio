/**
 * Code Giftz — execution job store (server-only, DURABLE).
 *
 * MI-1 (multi-instance readiness): the store is the `DesignJob` TABLE, not a
 * process-local Map. Every application instance reads the same rows, so a
 * poll, cancel or retry landing on ANY instance sees the true job state, and
 * a restarted process resumes from the persisted step state (completed steps
 * are never re-run).
 *
 * Ownership is structural: every accessor takes the userId and refuses
 * cross-user access.
 *
 * One active job per user (single-flight) — the provider quota and the editor
 * canvas both assume a single authoritative pipeline per session. A stale
 * active job (dead worker: heartbeat cold AND lease expired) is recovered as
 * honestly failed on the next create, so single-flight can never dead-lock an
 * account.
 *
 * Execution exclusion is a durable CLAIM LEASE (`leaseUntil`) written with a
 * status-guarded update: exactly one executor drives a chunk at a time;
 * concurrent claimers see exactly one winner. An expired lease is reclaimable
 * (the previous driver died).
 *
 * Cancellation is durable (`cancelRequested`/`cancelRequestedAt`): stamped
 * with a status-guarded update by ANY instance; the driver re-reads the flag
 * fresh at every step boundary. Terminal jobs can never be cancelled again.
 *
 * Retry is budgeted (MAX_RETRIES) with an exponential backoff gate
 * (`nextAttemptAt`) so a failing job cannot hammer the provider.
 *
 * The durable `BackgroundJob` queue (kind `ai.design-job`) is the execution
 * backbone: whoever claims the queue row drives the job under the same lease.
 * The queue is optional at the margins — polls can still drive chunks — but
 * with a worker running, jobs complete without any poll.
 */
import type { DesignPlan, PlanStep } from "@/lib/ai-design/plan";
import type { SiteConfig } from "@/lib/site-config";
import type { VerificationReport } from "@/lib/ai-design/verify";
import type { StepContext } from "@/lib/ai-design/execute";
import { db } from "@/lib/db";
import type { DesignJob as DesignJobRow } from "@prisma/client";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "done" | "repaired" | "failed" | "skipped";

export interface JobStep extends PlanStep {
  status: StepStatus;
  changes: string[];
  error?: string;
}

export interface DesignJob {
  id: string;
  userId: string;
  status: JobStatus;
  plan: DesignPlan;
  baseConfig: SiteConfig;
  working: SiteConfig;
  steps: JobStep[];
  changes: string[];
  verification: VerificationReport | null;
  error: string | null;
  cancelRequested: boolean;
  /** Source-material media ids for site.compose steps (owner-scoped reload). */
  materialIds: string[];
  createdAt: number;
  updatedAt: number;
  /** Retry bookkeeping (durable): attempts consumed + backoff gate. */
  attempt?: number;
  nextAttemptAt?: number | null;
  /** Persisted execution grounding (driver re-validates material ownership before reuse). */
  context?: StepContext;
  /** Bounded driver diagnostics (warn/error notes), capped to keep snapshots small. */
  events?: JobEvent[];
  /** Durable claim lease (ms epoch) — set by claimJob, cleared by releaseLease. */
  leaseUntil?: number | null;
}

export interface JobEvent {
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
}

export const TTL_MS = 30 * 60 * 1000; // finished jobs are forgettable after 30 minutes
export const MAX_JOBS_PER_USER = 4;
/** Retry budget per job (attempts consumed by prepareRetry). */
export const MAX_RETRIES = 3;
/** How long a claim keeps other executors out; expired leases allow reclaim. */
export const LEASE_MS = 90_000;
/** Diagnostic events are capped so persisted jobs and snapshots stay small. */
export const MAX_EVENTS = 50;
/** An active job with a colder heartbeat than this is considered abandoned. */
export const STALE_JOB_MS = 5 * 60_000;
/** Exponential backoff floor/ceiling for the retry gate (matches the queue). */
export const RETRY_BACKOFF_BASE_MS = 30_000;
export const RETRY_BACKOFF_CAP_MS = 600_000;

const ACTIVE: readonly JobStatus[] = ["queued", "running"];
const TERMINAL: readonly JobStatus[] = ["completed", "failed", "cancelled"];

/** Retry backoff for attempt N: min(2^N * 30s, 10min) — same shape as the queue. */
export function nextRetryBackoffMs(attempt: number): number {
  return Math.min(2 ** Math.max(attempt, 1) * RETRY_BACKOFF_BASE_MS, RETRY_BACKOFF_CAP_MS);
}

// ---------------------------------------------------------------------------
// (De)serialization — the durable row is the truth; DesignJob is the live shape
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function hydrate(row: DesignJobRow): DesignJob {
  const job: DesignJob = {
    id: row.id,
    userId: row.userId,
    status: (TERMINAL.concat(ACTIVE).includes(row.status as JobStatus) ? row.status : "failed") as JobStatus,
    plan: parseJson<DesignPlan>(row.planJson, { reply: "Unavailable plan.", constraints: [], steps: [] }),
    baseConfig: parseJson<SiteConfig>(row.baseConfigJson, {} as SiteConfig),
    working: parseJson<SiteConfig>(row.workingJson, {} as SiteConfig),
    steps: parseJson<JobStep[]>(row.stepsJson, []),
    changes: parseJson<string[]>(row.changesJson, []),
    verification: row.verificationJson ? parseJson<VerificationReport>(row.verificationJson, null as unknown as VerificationReport) : null,
    error: row.error,
    cancelRequested: row.cancelRequested,
    materialIds: parseJson<string[]>(row.materialIdsJson, []),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    attempt: row.attempt,
    nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.getTime() : null,
    events: parseJson<JobEvent[]>(row.eventsJson, []),
    leaseUntil: row.leaseUntil ? row.leaseUntil.getTime() : null,
  };
  if (row.contextJson) {
    const ctx = parseJson<StepContext | null>(row.contextJson, null);
    if (ctx) job.context = ctx;
  }
  return job;
}

function serializeState(job: DesignJob) {
  return {
    status: job.status,
    workingJson: JSON.stringify(job.working),
    stepsJson: JSON.stringify(job.steps),
    changesJson: JSON.stringify(job.changes),
    eventsJson: JSON.stringify((job.events ?? []).slice(-MAX_EVENTS)),
    verificationJson: job.verification ? JSON.stringify(job.verification) : null,
    error: job.error,
    attempt: job.attempt ?? 0,
    nextAttemptAt: job.nextAttemptAt ? new Date(job.nextAttemptAt) : null,
    // Execution grounding is driver-owned (resolveStepContext may rebuild it
    // after a material deletion); persisted so retries stay consistent.
    contextJson: job.context ? JSON.stringify(job.context) : null,
    // The claim lease is executor-owned and persisted: a dead worker's lease
    // expires on the row (claimable again), and a simulated/observed expiry
    // through persistJob behaves exactly like a real crash.
    leaseUntil: job.leaseUntil === null || job.leaseUntil === undefined ? null : new Date(job.leaseUntil),
  };
}

// ---------------------------------------------------------------------------
// Single-flight bookkeeping (create-time recovery + prune)
// ---------------------------------------------------------------------------

const STALE_UNBLOCK_ERROR = "Execution interrupted — the runner stopped before completion. You can retry it.";

function staleActiveWhere(scope: { userId?: string; id?: string }) {
  const staleBefore = new Date(Date.now() - STALE_JOB_MS);
  return {
    ...(scope.userId ? { userId: scope.userId } : {}),
    ...(scope.id ? { id: scope.id } : {}),
    status: { in: [...ACTIVE] },
    // Honest recovery: active + lease expired + heartbeat cold = the executor
    // died (process crash/restart). A freshly claimed job (warm lease or
    // heartbeat) is NEVER touched.
    OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
    heartbeatAt: { lt: staleBefore },
  };
}

async function recoverStaleActiveJobs(userId: string): Promise<number> {
  const stale = await db.designJob
    .updateMany({ where: staleActiveWhere({ userId }), data: { status: "failed", error: STALE_UNBLOCK_ERROR } })
    .catch(() => ({ count: 0 }));
  return stale.count;
}

/**
 * Recover one stale active job (studio sweep). Guarded: only truly abandoned
 * rows (lease expired + heartbeat cold) are failed.
 */
async function recoverOneStaleJob(jobId: string): Promise<boolean> {
  const res = await db.designJob.updateMany({
    where: staleActiveWhere({ id: jobId }),
    data: { status: "failed", error: STALE_UNBLOCK_ERROR },
  });
  return res.count === 1;
}

/** Keep at most MAX_JOBS_PER_USER finished jobs per user (oldest beyond cap deleted). */
async function pruneFinished(userId: string): Promise<void> {
  const finished = await db.designJob.findMany({
    where: { userId, status: { in: [...TERMINAL] } },
    orderBy: { createdAt: "desc" },
    skip: MAX_JOBS_PER_USER - 1,
    select: { id: true },
  });
  if (finished.length > 0) {
    await db.designJob.deleteMany({ where: { id: { in: finished.map((r) => r.id) } } }).catch(() => undefined);
  }
  // TTL hygiene: finished jobs older than TTL are forgettable (the AgentTask
  // shadow keeps the terminal history).
  await db.designJob
    .deleteMany({ where: { userId, status: { in: [...TERMINAL] }, updatedAt: { lt: new Date(Date.now() - TTL_MS) } } })
    .catch(() => undefined);
}

export class JobConflictError extends Error {
  constructor(public jobId: string) {
    super("Another GIFTZ execution is already running for this account.");
  }
}

export function newJobId(): string {
  return `dgj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface CreateJobParams {
  userId: string;
  plan: DesignPlan;
  baseConfig: SiteConfig;
  materialIds?: string[];
  context?: StepContext;
  /** Optional idempotency: duplicate submissions with the same per-user key return the SAME job. */
  idempotencyKey?: string;
}

export async function createJob(params: CreateJobParams): Promise<DesignJob> {
  // Idempotency first: the same per-user key always resolves to the same job.
  if (params.idempotencyKey) {
    const existing = await db.designJob.findUnique({
      where: { userId_idempotencyKey: { userId: params.userId, idempotencyKey: params.idempotencyKey } },
    });
    if (existing) return hydrate(existing);
  }

  // Unblock single-flight: recover abandoned active jobs (dead executor).
  await recoverStaleActiveJobs(params.userId).catch(() => 0);

  const active = await db.designJob.findFirst({
    where: { userId: params.userId, status: { in: [...ACTIVE] } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (active) throw new JobConflictError(active.id);

  await pruneFinished(params.userId).catch(() => undefined);

  const now = new Date();
  const row = await db.designJob.create({
    data: {
      id: newJobId(),
      userId: params.userId,
      status: "queued",
      planJson: JSON.stringify(params.plan),
      baseConfigJson: JSON.stringify(params.baseConfig),
      workingJson: JSON.stringify(params.baseConfig),
      stepsJson: JSON.stringify(params.plan.steps.map((s: PlanStep) => ({ ...s, status: "pending", changes: [] }))),
      changesJson: "[]",
      eventsJson: "[]",
      verificationJson: null,
      error: null,
      cancelRequested: false,
      materialIdsJson: JSON.stringify(params.materialIds ?? []),
      ...(params.context ? { contextJson: JSON.stringify(params.context) } : {}),
      attempt: 0,
      nextAttemptAt: null,
      leaseUntil: null,
      heartbeatAt: now,
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      createdAt: now,
    },
  });
  return hydrate(row);
}

/** Ownership-enforced accessor — a job is visible ONLY to its creator. */
export async function getJob(userId: string, jobId: string): Promise<DesignJob | null> {
  const row = await db.designJob.findUnique({ where: { id: jobId } });
  if (!row || row.userId !== userId) return null;
  return hydrate(row);
}

/** The user's most recent job (client reconnect after a page refresh). */
export async function latestJob(userId: string): Promise<DesignJob | null> {
  const row = await db.designJob.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
  return row ? hydrate(row) : null;
}

/**
 * The user's most recent FAILED job — the retry-the-failed-step path for
 * turns persisted before per-message job linkage existed (their metaJson
 * carries no jobId). Ownership is structural (userId-scoped), and the caller
 * still checks job.status === "failed" before offering a retry.
 */
export async function latestFailedJob(userId: string): Promise<DesignJob | null> {
  const row = await db.designJob.findFirst({
    where: { userId, status: "failed" },
    orderBy: { createdAt: "desc" },
  });
  return row ? hydrate(row) : null;
}

export interface RetryDecision {
  ok: boolean;
  /** HTTP-ish code for the refusal (429 = budget/backoff gate). */
  code?: number;
  reason?: string;
  retryAfterSeconds?: number;
}

/**
 * Reset failed/skipped steps so the pipeline can continue from the failure.
 * Enforces the retry budget and the exponential backoff gate. On success the
 * reset is PERSISTED (queued again, cancel flag cleared) and the passed job
 * object is updated in place — callers keep reading it for the retry run.
 */
export async function prepareRetry(job: DesignJob): Promise<RetryDecision> {
  if (job.status === "running" || job.status === "queued") {
    return { ok: false, reason: "That execution is already running — wait for it to finish." };
  }
  if (job.status === "completed") {
    return { ok: false, reason: "That execution finished successfully — there is nothing to retry." };
  }
  const attempt = job.attempt ?? 0;
  if (attempt >= MAX_RETRIES) {
    return {
      ok: false,
      code: 429,
      reason: `That execution has already been retried ${MAX_RETRIES} times — start a fresh request instead.`,
    };
  }
  if (job.nextAttemptAt && job.nextAttemptAt > Date.now()) {
    return {
      ok: false,
      code: 429,
      retryAfterSeconds: Math.max(1, Math.ceil((job.nextAttemptAt - Date.now()) / 1000)),
      reason: "That execution failed repeatedly — retry is gated by a short backoff.",
    };
  }

  job.cancelRequested = false;
  job.error = null;
  job.status = "queued";
  job.attempt = attempt + 1;
  job.nextAttemptAt = null;
  for (const step of job.steps) {
    if (step.status === "failed" || step.status === "skipped") {
      step.status = "pending";
      step.error = undefined;
    }
  }
  job.updatedAt = Date.now();
  await persistJob(job);
  return { ok: true };
}

/**
 * Durable cancellation: stamped with a status-guarded update so it is visible
 * to the executor on ANY instance. Idempotent for an already-requested active
 * job; refused for terminal jobs (their results belong to the user).
 */
export async function requestCancel(userId: string, jobId: string): Promise<boolean> {
  const now = new Date();
  const res = await db.designJob.updateMany({
    where: { id: jobId, userId, status: { in: [...ACTIVE] }, cancelRequested: false },
    data: { cancelRequested: true, cancelRequestedAt: now },
  });
  if (res.count === 1) return true;
  // Idempotent duplicate cancel on an active job stays a success.
  const row = await db.designJob.findUnique({ where: { id: jobId }, select: { userId: true, status: true, cancelRequested: true } });
  return Boolean(row && row.userId === userId && row.cancelRequested && (ACTIVE as readonly string[]).includes(row.status));
}

/** In-memory timestamp bump (the durable write happens in persistJob). */
export function touch(job: DesignJob) {
  job.updatedAt = Date.now();
}

/** Client-safe projection of a job (config only included when finished). */
export function jobSnapshot(job: DesignJob, includeConfig: boolean) {
  return {
    id: job.id,
    status: job.status,
    reply: job.plan.reply,
    notes: job.plan.notes ?? null,
    constraints: job.plan.constraints,
    // Included with the config (finished jobs only): the exact draft the plan
    // was approved against, so a reconnecting client can feed the builder's
    // stale-proposal guard instead of assuming the live draft.
    ...(includeConfig ? { baseConfig: job.baseConfig } : {}),
    steps: job.steps.map((s) => ({
      id: s.id,
      title: s.title,
      tool: s.tool,
      kind: s.kind,
      targets: s.targets,
      summary: s.summary,
      risk: s.risk,
      status: s.status,
      changes: s.changes,
      error: s.error ?? null,
    })),
    changes: job.changes,
    verification: job.verification,
    error: job.error,
    cancelRequested: job.cancelRequested,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(includeConfig ? { config: job.working } : {}),
  };
}

// ------------------------------------------------------- driver primitives

/** Append a bounded diagnostic event to a job (persisted by the next persistJob). */
export function appendEvent(job: DesignJob, level: JobEvent["level"], message: string): void {
  if (!job.events) job.events = [];
  job.events.push({ ts: Date.now(), level, message });
  if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
  job.updatedAt = Date.now();
}

/**
 * Atomically claim a job for one bounded execution chunk. Returns the job
 * only when it is known, owned, NOT finished, and NOT actively leased —
 * otherwise null ("unclaimable"). Concurrent callers: exactly one wins.
 * The claim is a durable status-guarded update (two guarded paths: queued →
 * running, or running lease refresh), so the winner is unique across
 * instances, not just across async tasks in one process.
 */
export async function claimJob(userId: string, jobId: string): Promise<DesignJob | null> {
  const row = await db.designJob.findUnique({ where: { id: jobId } });
  if (!row || row.userId !== userId) return null;
  if ((TERMINAL as readonly string[]).includes(row.status)) return null;

  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const expiredLease = { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] };

  // Path A: a queued job starts running under the lease.
  const started = await db.designJob.updateMany({
    where: { id: jobId, userId, status: "queued", ...expiredLease },
    data: { status: "running", leaseUntil, heartbeatAt: now },
  });
  // Path B: a running job re-claims its next chunk (lease refresh).
  const refreshed =
    started.count === 1
      ? { count: 1 }
      : await db.designJob.updateMany({
          where: { id: jobId, userId, status: "running", ...expiredLease },
          data: { leaseUntil, heartbeatAt: now },
        });
  if (started.count !== 1 && refreshed.count !== 1) return null; // leased elsewhere / raced away

  const claimed = await db.designJob.findUnique({ where: { id: jobId } });
  if (!claimed) return null;
  return hydrate(claimed);
}

/**
 * Persist the current job state durably. Guarded: only ACTIVE rows can be
 * written (a terminal row is final — a stale executor can never resurrect a
 * cancelled/completed/failed job), and the write refreshes the heartbeat so
 * stale recovery keeps distinguishing "alive" from "abandoned".
 */
export async function persistJob(job: DesignJob): Promise<boolean> {
  const res = await db.designJob.updateMany({
    where: { id: job.id, userId: job.userId, status: { in: [...ACTIVE] } },
    data: { ...serializeState(job), heartbeatAt: new Date() },
  });
  return res.count === 1;
}

/** Release the claim lease so the next poll/kick/worker can drive the next chunk. */
export async function releaseLease(job: DesignJob): Promise<void> {
  if (job.leaseUntil === null || job.leaseUntil === undefined) return;
  await db.designJob
    .updateMany({
      where: { id: job.id, userId: job.userId, leaseUntil: new Date(job.leaseUntil) },
      data: { leaseUntil: null },
    })
    .catch(() => undefined);
  job.leaseUntil = null;
  job.updatedAt = Date.now();
}

/**
 * Mark a job failed with a user-safe message while keeping every completed
 * step (retry remains possible via prepareRetry). `backoff: true` stamps the
 * exponential retry gate (`nextAttemptAt`) that prepareRetry enforces.
 */
export async function applyFailure(job: DesignJob, message: string, opts: { backoff?: boolean } = {}): Promise<void> {
  job.status = "failed";
  job.error = message;
  job.nextAttemptAt = opts.backoff ? Date.now() + nextRetryBackoffMs(job.attempt ?? 0) : null;
  job.updatedAt = Date.now();
  await persistJob(job).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Durable queue bridge + fleet-wide sweep
// ---------------------------------------------------------------------------

/** The BackgroundJob kind that drives design jobs (registered in queue/handlers). */
export const AI_DESIGN_JOB_KIND = "ai.design-job";
export function designJobDedupeKey(jobId: string): string {
  return `design-job:${jobId}`;
}

/**
 * Enqueue the durable drive job for a design job (best-effort — polls still
 * drive chunks when no worker is available). Idempotent via the dedupeKey.
 */
export async function enqueueDesignJobDrive(jobId: string, userId: string): Promise<void> {
  try {
    const { enqueue } = await import("@/lib/queue/index");
    await enqueue({
      kind: AI_DESIGN_JOB_KIND,
      userId,
      payload: { jobId },
      dedupeKey: designJobDedupeKey(jobId),
    });
  } catch {
    // Queue unavailable: the poll/kick path still drives the job honestly.
  }
}

/**
 * Fleet-wide stale recovery for design jobs — an active job whose executor
 * died (lease expired + heartbeat cold) is failed honestly with completed
 * steps kept and the job remaining retryable. Called by the studio sweep
 * (every 5 min) so a crashed worker never leaves an account dead-locked.
 */
export async function sweepStaleDesignJobs(limit = 50): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_JOB_MS);
  const rows = await db.designJob.findMany({
    where: {
      status: { in: [...ACTIVE] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
      heartbeatAt: { lt: staleBefore },
    },
    select: { id: true },
    take: limit,
    orderBy: { updatedAt: "asc" },
  });
  let recovered = 0;
  for (const row of rows) {
    if (await recoverOneStaleJob(row.id)) recovered += 1;
  }
  return recovered;
}
