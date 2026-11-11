/**
 * BEAN Folio — durable background-job queue core.
 *
 * Persistence: the `BackgroundJob` table (prisma/schema.prisma) IS the queue.
 * Lifecycle: QUEUED → RUNNING → SUCCEEDED | FAILED (retry with exponential
 * backoff) → DEAD (max attempts exceeded); CANCELLED is an explicit user/ops
 * action. A job is only ever marked SUCCEEDED after its handler resolved —
 * never speculatively.
 *
 * Claim semantics (SQLite + PostgreSQL):
 *  - A candidate is claimed with a status-guarded `updateMany`
 *    (`WHERE id = ? AND status = 'QUEUED'`). Only the writer whose UPDATE
 *    matches the guard wins; a racing worker matches 0 rows and moves on.
 *    On SQLite the engine serializes writers with a coarse lock, so the
 *    guard is effectively atomic; on PostgreSQL row-level MVCC gives the
 *    same per-row guarantee. We deliberately do NOT use
 *    `SELECT … FOR UPDATE SKIP LOCKED` (SQLite has no row locks): the
 *    guarded-update pattern is the portable, honest equivalent. Worst case,
 *    two workers evaluate the same candidate list and exactly one claim per
 *    row succeeds.
 *  - Per-user concurrency is enforced best-effort at claim time (COUNT of
 *    RUNNING rows per owner). With several workers racing, a user's RUNNING
 *    count can momentarily overshoot by the number of concurrent claimers; it
 *    self-corrects on the next claim. Documented, not hidden.
 *
 * Restart story: RUNNING rows lose liveness when their heartbeat goes stale
 * (or their claim, before the first heartbeat). `recoverStuck()` requeues
 * them (attempts kept) or dead-letters them when attempts are exhausted.
 * A restart never silently loses a job — the worst case is that it runs again.
 *
 * This module must stay free of Next.js-specific imports so it can run inside
 * the Next server process AND standalone (`scripts/queue-drain.ts`).
 */

import { Prisma } from "@prisma/client";
import type { BackgroundJob } from "@prisma/client";

import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types + tunables
// ---------------------------------------------------------------------------

export type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD" | "CANCELLED";

/** A job handler receives the claimed row. Throwing = failure (retry/backoff). */
export type JobHandler = (job: BackgroundJob) => Promise<unknown>;

/** Statuses that occupy the dedupeKey slot. */
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["QUEUED", "RUNNING"];

/** Backoff bounds used by `fail()` — min(2^attempts * 30s, 10min). */
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 600_000;

/** Read a positive-int env knob with a fallback (re-read per call: ops can tune per process). */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Global worker concurrency (jobs one worker runs simultaneously). */
export function globalConcurrency(): number {
  return envInt("QUEUE_CONCURRENCY", 4);
}

/** Max concurrent RUNNING jobs per owning user (system jobs with no owner are exempt). */
export function userConcurrency(): number {
  return envInt("QUEUE_USER_CONCURRENCY", 2);
}

/** Exponential backoff for attempt N: min(2^attempts * 30s, 10min). */
export function nextBackoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(attempts, 1) * BACKOFF_BASE_MS, BACKOFF_CAP_MS);
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export function errorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e ?? "unknown error");
  return message.length <= 500 ? message : message.slice(0, 500);
}

function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

// ---------------------------------------------------------------------------
// Handler registry (globalThis-held so dev hot-reload cannot orphan it)
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __beanQueueHandlers?: Map<string, JobHandler> };
g.__beanQueueHandlers ??= new Map<string, JobHandler>();

export function registerHandler(kind: string, fn: JobHandler): void {
  g.__beanQueueHandlers!.set(kind, fn);
}

export function getHandler(kind: string): JobHandler | undefined {
  return g.__beanQueueHandlers!.get(kind);
}

// ---------------------------------------------------------------------------
// Enqueue (idempotent on dedupeKey)
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  kind: string;
  payload?: unknown;
  userId?: string | null;
  /** Earliest execution time. Defaults to now. */
  runAt?: Date;
  /** Default 3. */
  maxAttempts?: number;
  /** Optional idempotency: at most one ACTIVE job per key (null keys never conflict). */
  dedupeKey?: string | null;
}

/**
 * Insert a QUEUED job. If a job with the same dedupeKey is already active
 * (QUEUED/RUNNING) it is returned unchanged — enqueue is idempotent. If a
 * TERMINAL row still holds the key (DEAD/CANCELLED/SUCCEEDED leftovers), the
 * key is released lazily and the insert retried once.
 */
export async function enqueue(input: EnqueueInput): Promise<BackgroundJob> {
  const data = {
    kind: input.kind,
    payload: JSON.stringify(input.payload ?? {}),
    userId: input.userId ?? null,
    runAt: input.runAt ?? new Date(),
    maxAttempts: input.maxAttempts ?? 3,
  };

  if (input.dedupeKey) {
    // Fast path: an active job with this key wins WITHOUT a throwing insert
    // (Prisma's client logs every P2002 even when caught — keep the common
    // idempotent path quiet). The insert below still guards with P2002 for
    // the race between this check and the create.
    const existing = await db.backgroundJob.findUnique({ where: { dedupeKey: input.dedupeKey } }).catch(() => null);
    if (existing && (ACTIVE_JOB_STATUSES as readonly string[]).includes(existing.status)) {
      return existing;
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await db.backgroundJob.create({
        data: input.dedupeKey ? { ...data, dedupeKey: input.dedupeKey } : data,
      });
    } catch (e) {
      if (attempt === 0 && input.dedupeKey && isUniqueViolation(e)) {
        const existing = await db.backgroundJob.findUnique({ where: { dedupeKey: input.dedupeKey } }).catch(() => null);
        if (existing && (ACTIVE_JOB_STATUSES as readonly string[]).includes(existing.status)) {
          return existing; // idempotent: the active job wins
        }
        if (existing) {
          // Terminal row still holds the key — release it and retry once.
          await db.backgroundJob.update({ where: { id: existing.id }, data: { dedupeKey: null } }).catch(() => undefined);
          continue;
        }
      }
      throw e;
    }
  }
  throw new Error(`enqueue: could not insert job kind=${input.kind} (dedupeKey contention)`);
}

// ---------------------------------------------------------------------------
// Claim (optimistic, status-guarded)
// ---------------------------------------------------------------------------

/**
 * Atomically claim up to `limit` QUEUED jobs whose runAt has passed, oldest
 * first. Per-user concurrency: a candidate is skipped while its owner already
 * has >= QUEUE_USER_CONCURRENCY RUNNING jobs (best-effort under concurrent
 * workers — see module docstring). System jobs (userId null) are exempt.
 */
export async function claimBatch(limit: number, workerId: string): Promise<BackgroundJob[]> {
  if (limit <= 0) return [];
  const now = new Date();

  // Overfetch: some candidates may be skipped (per-user guard) or lost to a
  // racing worker (status guard).
  const candidates = await db.backgroundJob.findMany({
    where: { status: "QUEUED", runAt: { lte: now } },
    orderBy: { runAt: "asc" },
    take: Math.min(limit * 5 + 10, 100),
    select: { id: true, userId: true },
  });

  const claimed: BackgroundJob[] = [];
  const runningByUser = new Map<string, number>();
  const perUser = userConcurrency();

  for (const candidate of candidates) {
    if (claimed.length >= limit) break;

    if (candidate.userId) {
      let running = runningByUser.get(candidate.userId);
      if (running === undefined) {
        running = await db.backgroundJob.count({ where: { userId: candidate.userId, status: "RUNNING" } });
      }
      if (running >= perUser) {
        runningByUser.set(candidate.userId, running);
        continue; // user at capacity — try the next candidate
      }
      // Optimistic reservation; a lost claim race only makes the next skip
      // decision slightly conservative.
      runningByUser.set(candidate.userId, running + 1);
    }

    // The status guard IS the lock: exactly one concurrent claimer flips a
    // QUEUED row to RUNNING; every other claimer matches 0 rows.
    const won = await db.backgroundJob.updateMany({
      where: { id: candidate.id, status: "QUEUED" },
      data: {
        status: "RUNNING",
        claimedBy: workerId,
        claimedAt: now,
        heartbeatAt: now,
        attempts: { increment: 1 },
      },
    });
    if (won.count !== 1) continue;

    const job = await db.backgroundJob.findUnique({ where: { id: candidate.id } });
    if (job) claimed.push(job);
  }

  return claimed;
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

/** Mark a RUNNING job SUCCEEDED. Releases the dedupeKey (one ACTIVE job per key). */
export async function complete(id: string): Promise<boolean> {
  const res = await db.backgroundJob.updateMany({
    where: { id, status: "RUNNING" },
    data: {
      status: "SUCCEEDED",
      finishedAt: new Date(),
      lastError: null,
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
      dedupeKey: null,
    },
  });
  return res.count === 1;
}

export type FailOutcome = "REQUEUED" | "DEAD" | "IGNORED";

/**
 * Fail a RUNNING job honestly. attempts < maxAttempts → re-queue with
 * exponential backoff (same row, dedupeKey held while it waits); otherwise →
 * DEAD (dead-letter). An error is never swallowed into a success.
 */
export async function fail(id: string, error: unknown): Promise<FailOutcome> {
  const job = await db.backgroundJob.findUnique({
    where: { id },
    select: { status: true, attempts: true, maxAttempts: true, kind: true },
  });
  if (!job || job.status !== "RUNNING") return "IGNORED";

  const message = errorMessage(error);
  const cleared = { claimedBy: null, claimedAt: null, heartbeatAt: null };

  if (job.attempts >= job.maxAttempts) {
    await db.backgroundJob.updateMany({
      where: { id, status: "RUNNING" },
      data: { status: "DEAD", lastError: message, finishedAt: new Date(), ...cleared },
    });
    logEvent("queue.job.dead", { kind: job.kind, jobId: id, attempts: job.attempts });
    return "DEAD";
  }

  await db.backgroundJob.updateMany({
    where: { id, status: "RUNNING" },
    data: {
      status: "QUEUED",
      runAt: new Date(Date.now() + nextBackoffMs(job.attempts)),
      lastError: message,
      ...cleared,
    },
  });
  return "REQUEUED";
}

/** Refresh liveness for a RUNNING job. */
export async function heartbeat(id: string): Promise<boolean> {
  const res = await db.backgroundJob.updateMany({
    where: { id, status: "RUNNING" },
    data: { heartbeatAt: new Date() },
  });
  return res.count === 1;
}

/**
 * Cancel a QUEUED job. When `userId` is given the job must belong to that
 * user (ownership check). RUNNING jobs are NOT cancellable here — handlers
 * own cooperative cancellation. Releases the dedupeKey.
 */
export async function cancelQueued(id: string, userId?: string | null): Promise<boolean> {
  const job = await db.backgroundJob.findUnique({ where: { id }, select: { userId: true, status: true } });
  if (!job || job.status !== "QUEUED") return false;
  if (userId && job.userId !== userId) return false;
  const res = await db.backgroundJob.updateMany({
    where: { id, status: "QUEUED" },
    data: {
      status: "CANCELLED",
      finishedAt: new Date(),
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
      dedupeKey: null,
    },
  });
  return res.count === 1;
}

// ---------------------------------------------------------------------------
// Stuck-RUNNING recovery (the honest restart story)
// ---------------------------------------------------------------------------

export interface RecoverResult {
  requeued: number;
  dead: number;
}

/**
 * Requeue RUNNING rows whose worker died: heartbeat older than 5 min, or —
 * before the first heartbeat — claimedAt older than 15 min. Attempts are
 * KEPT (a recovered job has already burned its attempt); rows at/over
 * maxAttempts go straight to DEAD with lastError "worker lost".
 */
export async function recoverStuck(): Promise<RecoverResult> {
  const heartbeatCutoff = new Date(Date.now() - 5 * 60_000);
  const claimCutoff = new Date(Date.now() - 15 * 60_000);

  const stuck = await db.backgroundJob.findMany({
    where: {
      status: "RUNNING",
      OR: [{ heartbeatAt: { lt: heartbeatCutoff } }, { heartbeatAt: null, claimedAt: { lt: claimCutoff } }],
    },
    select: { id: true, attempts: true, maxAttempts: true, kind: true },
    take: 100,
    orderBy: { updatedAt: "asc" },
  });

  let requeued = 0;
  let dead = 0;
  const cleared = { claimedBy: null, claimedAt: null, heartbeatAt: null };

  for (const row of stuck) {
    if (row.attempts >= row.maxAttempts) {
      const res = await db.backgroundJob.updateMany({
        where: { id: row.id, status: "RUNNING" },
        data: {
          status: "DEAD",
          lastError: "worker lost — process restarted or crashed before completion",
          finishedAt: new Date(),
          ...cleared,
        },
      });
      dead += res.count;
    } else {
      const res = await db.backgroundJob.updateMany({
        where: { id: row.id, status: "RUNNING" },
        data: { status: "QUEUED", ...cleared },
      });
      requeued += res.count;
    }
  }

  if (requeued + dead > 0) {
    logEvent("queue.recover.stuck", { requeued, dead, examined: stuck.length });
  }
  return { requeued, dead };
}

// ---------------------------------------------------------------------------
// Dead-letter recovery (ops action)
// ---------------------------------------------------------------------------

/**
 * Re-queue DEAD (dead-lettered) jobs for another attempt. This is the
 * deliberate, human-initiated counterpart of `fail()`: after an operator has
 * fixed the underlying cause (a provider outage, a bug, a bad payload), the
 * dead letters go back into the queue instead of being lost.
 *
 * - `jobId` re-queues one specific dead letter (must be DEAD);
 * - without `jobId`, ALL dead letters older than `olderThanMs` (default: 5
 *   minutes — avoids racing an operator action with an in-flight retry
 *   decision) are re-queued, up to `limit` (default 500 per run; the sweep
 *   cadence converges on larger backlogs).
 *
 * attempts RESET to 0 (the job gets a full fresh retry budget — the operator
 * explicitly asked for another run) and lastError is kept for the audit
 * trail. Returns the number of rows re-queued.
 */
export async function requeueDeadJobs(opts: { jobId?: string; olderThanMs?: number; limit?: number } = {}): Promise<number> {
  const olderThanMs = opts.olderThanMs ?? 5 * 60_000;
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5_000));
  const cutoff = new Date(Date.now() - olderThanMs);

  const candidates = await db.backgroundJob.findMany({
    where: {
      status: "DEAD",
      ...(opts.jobId ? { id: opts.jobId } : {}),
      OR: [{ finishedAt: { lt: cutoff } }, { finishedAt: null, createdAt: { lt: cutoff } }],
    },
    select: { id: true },
    take: limit,
    orderBy: [{ finishedAt: "asc" }, { createdAt: "asc" }],
  });

  let requeued = 0;
  for (const row of candidates) {
    const res = await db.backgroundJob.updateMany({
      where: { id: row.id, status: "DEAD" },
      data: {
        status: "QUEUED",
        attempts: 0,
        runAt: new Date(),
        finishedAt: null,
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
      },
    });
    requeued += res.count;
  }
  if (requeued > 0) logEvent("queue.dead.requeued", { count: requeued, jobId: opts.jobId ?? null });
  return requeued;
}

// ---------------------------------------------------------------------------
// Recurring jobs (self-perpetuating chains)
// ---------------------------------------------------------------------------

export interface RecurringDef {
  /** dedupeKey of the chain — at most one active job per key at any time. */
  key: string;
  /** BackgroundJob.kind the handler registry knows. */
  kind: string;
  everyMs: number;
  payload?: unknown;
}

const gg = globalThis as unknown as { __beanQueueRecurring?: Map<string, RecurringDef> };
gg.__beanQueueRecurring ??= new Map<string, RecurringDef>();

/** Register (or update) a recurring definition in this process. */
export function registerRecurring(def: RecurringDef): void {
  gg.__beanQueueRecurring!.set(def.key, def);
}

/** The payload stamp that lets ANY worker re-enqueue the successor after a run. */
function stampRecurring(payload: unknown, key: string, everyMs: number): Record<string, unknown> {
  const base =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { data: payload ?? null };
  return { ...base, __recurring: { key, everyMs } };
}

type RecurringStamp = { __recurring?: { key?: unknown; everyMs?: unknown } };

function readRecurringStamp(job: BackgroundJob): { key: string; everyMs: number } | null {
  let parsed: RecurringStamp | null = null;
  try {
    parsed = JSON.parse(job.payload ?? "{}") as RecurringStamp;
  } catch {
    return null;
  }
  const rec = parsed?.__recurring;
  if (!rec || typeof rec.key !== "string" || typeof rec.everyMs !== "number" || !Number.isFinite(rec.everyMs)) {
    return null;
  }
  return { key: rec.key, everyMs: rec.everyMs };
}

/**
 * After a recurring job SUCCEEDS, enqueue its successor (same kind/payload,
 * same dedupeKey, runAt = completion + everyMs). `complete()` released the
 * old key, so the insert is clean; a racing worker loses the P2002 race and
 * gets the active successor back (idempotent enqueue). If THIS step crashes
 * the chain breaks — `ensureRecurringChains()` repairs it on the next
 * recovery pass / boot, with honest gap logging.
 */
export async function reenqueueRecurringSuccessor(job: BackgroundJob): Promise<BackgroundJob | null> {
  const stamp = readRecurringStamp(job);
  if (!stamp) return null;
  try {
    return await enqueue({
      kind: job.kind,
      payload: job.payload ? JSON.parse(job.payload) : {},
      dedupeKey: stamp.key,
      runAt: new Date(Date.now() + stamp.everyMs),
    });
  } catch (e) {
    logEvent("queue.recurring.successor_failed", { key: stamp.key, kind: job.kind, message: errorMessage(e) });
    return null;
  }
}

async function repairRecurringChain(def: RecurringDef): Promise<BackgroundJob | null> {
  const active = await db.backgroundJob.findFirst({
    where: { dedupeKey: def.key, status: { in: [...ACTIVE_JOB_STATUSES] } },
    select: { id: true },
  });
  if (active) return null; // chain alive — nothing to do

  const last = await db.backgroundJob.findFirst({
    where: { dedupeKey: def.key, status: { in: ["SUCCEEDED", "DEAD"] } },
    orderBy: [{ finishedAt: "desc" }, { createdAt: "desc" }],
    select: { status: true, finishedAt: true, createdAt: true },
  });

  if (last) {
    const lastFinishedMs = (last.finishedAt ?? last.createdAt).getTime();
    const overdueMs = Math.max(0, Date.now() - lastFinishedMs - def.everyMs);
    logEvent("queue.recurring.gap", {
      key: def.key,
      kind: def.kind,
      lastStatus: last.status,
      overdueMs,
      everyMs: def.everyMs,
    });
  } else {
    logEvent("queue.recurring.start", { key: def.key, kind: def.kind, everyMs: def.everyMs });
  }

  try {
    return await enqueue({
      kind: def.kind,
      payload: stampRecurring(def.payload, def.key, def.everyMs),
      dedupeKey: def.key,
      runAt: new Date(),
    });
  } catch (e) {
    logEvent("queue.recurring.repair_failed", { key: def.key, kind: def.kind, message: errorMessage(e) });
    return null;
  }
}

/**
 * Repair a single registered chain: if no active job carries its dedupeKey,
 * enqueue one (with honest gap logging). Used by `ensureRecurring` at boot.
 */
export async function ensureRecurringChain(key: string): Promise<BackgroundJob | null> {
  const def = gg.__beanQueueRecurring!.get(key);
  if (!def) return null;
  return repairRecurringChain(def);
}

/** Repair pass over ALL registered chains (worker recovery cadence). */
export async function ensureRecurringChains(): Promise<number> {
  let repaired = 0;
  for (const def of gg.__beanQueueRecurring!.values()) {
    const job = await repairRecurringChain(def);
    if (job) repaired += 1;
  }
  return repaired;
}
