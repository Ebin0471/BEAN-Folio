/**
 * BEAN Folio — standalone queue worker ("drain mode").
 *
 *   bun scripts/queue-drain.ts
 *
 * Runs the SAME worker loop as the in-process Next worker, but as its own
 * process: PORT-independent, no web server, safe to run N copies (claims are
 * atomic via status-guarded updates). Use this to scale job throughput
 * independently of web traffic, or with QUEUE_ENABLED=false on the web tier
 * so a dedicated worker owns the queue.
 *
 * Handlers + recurring sweeps (maintenance.sweep, site.studio-sweep) are the
 * built-ins; per-process knobs: QUEUE_CONCURRENCY, QUEUE_POLL_MS,
 * QUEUE_USER_CONCURRENCY.
 *
 * This script must stay free of Next.js imports — only `@/lib/queue/*` and
 * the Prisma client (bun auto-loads .env for DATABASE_URL).
 */

import {
  MAINTENANCE_SWEEP_KEY,
  SITE_STUDIO_SWEEP_KEY,
  STUDIO_SWEEP_EVERY_MS,
  SWEEP_EVERY_MS,
  ensureRecurring,
  registerBuiltInHandlers,
} from "../src/lib/queue/handlers";
import { requeueDeadJobs } from "../src/lib/queue/index";
import { getWorkerStatus, gracefulShutdown, startWorker } from "../src/lib/queue/worker";

async function main(): Promise<void> {
  // Ops mode: `bun scripts/queue-drain.ts --requeue-dead [jobId]` re-queues
  // dead letters (all, or one specific job) and exits — the deliberate,
  // human-initiated dead-letter recovery path (P4 reliability).
  const argv = process.argv.slice(2);
  if (argv.includes("--requeue-dead")) {
    const jobId = argv[argv.indexOf("--requeue-dead") + 1];
    const count = await requeueDeadJobs({ jobId: jobId && !jobId.startsWith("--") ? jobId : undefined });
    console.log(JSON.stringify({ event: "queue.dead.requeued", count }));
    process.exit(0);
  }

  registerBuiltInHandlers();
  // Boot-time chain recovery: re-enqueue recurring sweeps if a previous
  // process died between completion and successor enqueue (honest gap logs).
  await ensureRecurring(MAINTENANCE_SWEEP_KEY, SWEEP_EVERY_MS);
  await ensureRecurring(SITE_STUDIO_SWEEP_KEY, STUDIO_SWEEP_EVERY_MS);

  startWorker();
  const status = getWorkerStatus();
  console.log(
    JSON.stringify({
      event: "queue.drain.ready",
      workerId: status.workerId,
      concurrency: status.concurrency,
    })
  );

  let shuttingDown = false;
  const graceful = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "queue.shutdown.begin", signal, workerId: status.workerId }));
    const hardExit = setTimeout(() => process.exit(0), 27_000);
    void gracefulShutdown()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(hardExit);
        process.exit(0);
      });
  };
  process.once("SIGTERM", () => graceful("SIGTERM"));
  process.once("SIGINT", () => graceful("SIGINT"));
}

main().catch((e: unknown) => {
  console.error("[queue-drain] fatal:", e);
  process.exit(1);
});
