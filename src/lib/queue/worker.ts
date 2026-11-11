/**
 * BEAN Folio — durable background-job worker loop.
 *
 * One worker per process (globalThis-held so Next dev hot-reload cannot start
 * two). The loop:
 *   - polls the queue every QUEUE_POLL_MS (default 2s);
 *   - runs recoverStuck() + recurring-chain repair every 30s;
 *   - claims up to its concurrency budget and runs handlers;
 *   - heartbeats every RUNNING job every 15s (liveness for recoverStuck);
 *   - logs structured single-line events: job.start / job.done / job.fail.
 *
 * Graceful shutdown: stop polling, wait for in-flight jobs (25s cap). A job
 * that cannot finish within the cap is NOT marked success — it simply loses
 * its heartbeat and the next boot's recoverStuck() requeues it honestly
 * (attempts kept). Nothing is ever silently lost.
 *
 * This module must stay free of Next.js-specific imports so it can run inside
 * the Next server process AND standalone (`scripts/queue-drain.ts`).
 */

import type { BackgroundJob } from "@prisma/client";

import {
  claimBatch,
  complete,
  envInt,
  ensureRecurringChains,
  fail,
  errorMessage,
  getHandler,
  globalConcurrency,
  heartbeat,
  recoverStuck,
  reenqueueRecurringSuccessor,
} from "./index";

export interface WorkerOptions {
  /** Overrides QUEUE_CONCURRENCY for this worker. */
  concurrency?: number;
  /** Overrides QUEUE_POLL_MS for this worker. */
  pollMs?: number;
  /** Overrides the default worker id (pid + random). */
  workerId?: string;
}

export interface WorkerStatus {
  started: boolean;
  workerId: string | null;
  concurrency: number;
  inFlight: number;
  lastTickAt: string | null;
  lastRecoveryAt: string | null;
}

const RECOVERY_INTERVAL_MS = 30_000;
const JOB_HEARTBEAT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 25_000;

interface InFlightEntry {
  startedAt: number;
  promise: Promise<void> | null;
}

const g = globalThis as unknown as { __beanQueueWorker?: WorkerRuntime };

class WorkerRuntime {
  readonly workerId: string;
  readonly concurrency: number;
  readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = true;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private lastTickAt: Date | null = null;
  private lastRecoveryAt: Date | null = null;

  constructor(opts: WorkerOptions = {}) {
    this.workerId = opts.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.concurrency = opts.concurrency ?? globalConcurrency();
    this.pollMs = Math.max(250, opts.pollMs ?? envInt("QUEUE_POLL_MS", 2000));
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    // Boot with pending work immediately — a fresh deploy should not wait a
    // full poll interval to pick up what the previous instance left behind.
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      this.lastTickAt = new Date();
      const now = Date.now();

      if (this.lastRecoveryAt === null || now - this.lastRecoveryAt.getTime() >= RECOVERY_INTERVAL_MS) {
        this.lastRecoveryAt = new Date(now);
        await recoverStuck().catch((e: unknown) =>
          console.error(JSON.stringify({ event: "queue.recover.error", message: errorMessage(e) }))
        );
        await ensureRecurringChains().catch((e: unknown) =>
          console.error(JSON.stringify({ event: "queue.recurring.error", message: errorMessage(e) }))
        );
      }
      if (this.stopped) return;

      const free = this.concurrency - this.inFlight.size;
      if (free > 0) {
        const jobs = await claimBatch(free, this.workerId).catch((e: unknown) => {
          console.error(JSON.stringify({ event: "queue.claim.error", message: errorMessage(e) }));
          return [] as BackgroundJob[];
        });
        for (const job of jobs) this.run(job);
      }
    } finally {
      this.ticking = false;
    }
  }

  private run(job: BackgroundJob): void {
    const startedAt = Date.now();
    const entry: InFlightEntry = { startedAt, promise: null };
    this.inFlight.set(job.id, entry);

    const fields = (): Record<string, unknown> => ({
      kind: job.kind,
      jobId: job.id,
      userId: job.userId ?? null,
      attempt: job.attempts,
    });
    console.log(JSON.stringify({ event: "job.start", durationMs: 0, ...fields() }));

    // Liveness while the handler runs — recoverStuck() judges by this.
    const heartbeatTimer = setInterval(() => {
      void heartbeat(job.id).catch(() => undefined);
    }, JOB_HEARTBEAT_MS);

    entry.promise = (async () => {
      const handler = getHandler(job.kind);
      if (!handler) {
        const outcome = await fail(job.id, `No handler registered for job kind "${job.kind}"`);
        console.log(
          JSON.stringify({
            event: "job.fail",
            durationMs: Date.now() - startedAt,
            outcome,
            error: `no handler registered for kind "${job.kind}"`,
            ...fields(),
          })
        );
        return;
      }

      await handler(job);

      // Guarded completion: if the row is no longer RUNNING (e.g. it was
      // requeued by recoverStuck elsewhere) we must NOT mark it succeeded.
      const done = await complete(job.id);
      if (!done) {
        console.log(JSON.stringify({ event: "job.abandoned", durationMs: Date.now() - startedAt, ...fields() }));
        return;
      }
      console.log(JSON.stringify({ event: "job.done", durationMs: Date.now() - startedAt, ...fields() }));
      await reenqueueRecurringSuccessor(job);
    })()
      .catch(async (e: unknown) => {
        const message = errorMessage(e);
        const outcome = await fail(job.id, message).catch(() => "IGNORED" as const);
        console.log(
          JSON.stringify({
            event: "job.fail",
            durationMs: Date.now() - startedAt,
            outcome,
            error: message.slice(0, 300),
            ...fields(),
          })
        );
      })
      .finally(() => {
        clearInterval(heartbeatTimer);
        this.inFlight.delete(job.id);
      });
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight.size === 0) {
      console.log(JSON.stringify({ event: "queue.shutdown.done", workerId: this.workerId, abandoned: 0 }));
      return;
    }
    console.log(JSON.stringify({ event: "queue.shutdown.waiting", workerId: this.workerId, inFlight: this.inFlight.size }));
    const watched = [...this.inFlight.values()].map((e) => e.promise ?? Promise.resolve());
    await Promise.race([
      Promise.allSettled(watched),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
    ]);
    // Anything still in flight is abandoned WITHOUT being marked success — it
    // loses its heartbeat and the next boot's recoverStuck() requeues or
    // dead-letters it. Honest, never silently "done".
    const abandoned = this.inFlight.size;
    this.inFlight.clear();
    console.log(JSON.stringify({ event: "queue.shutdown.done", workerId: this.workerId, abandoned }));
  }

  status(): WorkerStatus {
    return {
      started: !this.stopped && this.timer !== null,
      workerId: this.workerId,
      concurrency: this.concurrency,
      inFlight: this.inFlight.size,
      lastTickAt: this.lastTickAt ? this.lastTickAt.toISOString() : null,
      lastRecoveryAt: this.lastRecoveryAt ? this.lastRecoveryAt.toISOString() : null,
    };
  }
}

/**
 * Start the per-process worker (idempotent: a second call reuses the running
 * worker). Returns the live status.
 */
export function startWorker(opts: WorkerOptions = {}): WorkerStatus {
  if (!g.__beanQueueWorker) {
    g.__beanQueueWorker = new WorkerRuntime(opts);
  }
  g.__beanQueueWorker.start();
  console.log(
    JSON.stringify({
      event: "queue.worker.started",
      workerId: g.__beanQueueWorker.workerId,
      concurrency: g.__beanQueueWorker.concurrency,
      pollMs: g.__beanQueueWorker.pollMs,
    })
  );
  return g.__beanQueueWorker.status();
}

/**
 * Graceful shutdown: stop polling and wait for in-flight jobs (25s cap).
 * Safe if never started. SIGTERM/SIGINT handlers call this, then exit.
 */
export async function gracefulShutdown(): Promise<void> {
  const worker = g.__beanQueueWorker;
  if (!worker) return;
  await worker.shutdown();
}

/** Snapshot for /api/health (lastWorkerTickAgoMs) — never throws. */
export function getWorkerStatus(): WorkerStatus {
  const worker = g.__beanQueueWorker;
  if (!worker) {
    return {
      started: false,
      workerId: null,
      concurrency: 0,
      inFlight: 0,
      lastTickAt: null,
      lastRecoveryAt: null,
    };
  }
  return worker.status();
}
