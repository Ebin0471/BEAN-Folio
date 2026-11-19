/**
 * Next.js instrumentation hook — runs once when the server process boots
 * (dev server and the standalone production server alike).
 *
 * Contract (docs/ai-transformation — startup hardening):
 *  - Validate the environment BEFORE serving any traffic (fail-fast).
 *  - On validation failure print the structured, value-free diagnosis and
 *    exit(1). A half-configured server must never come up green.
 *  - After validation passes, bootstrap the durable background-job worker
 *    (unless QUEUE_ENABLED === "false") and its recurring sweeps, and wire
 *    SIGTERM/SIGINT to a graceful queue shutdown. Worker logic lives in
 *    `@/lib/queue/*`; this file only orchestrates (no cycles).
 *  - Import-safe for `next build`: all heavy modules are dynamically imported
 *    inside register(), and only under the Node.js runtime.
 */
export async function register(): Promise<void> {
  // The hook is compiled for BOTH runtimes; environment validation (and the
  // process.exit policy below) is a Node.js concern — the edge build skips it.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { validateStartupEnvironment, StartupValidationError } = await import(
    "@/lib/startup-validation"
  );

  try {
    validateStartupEnvironment();
  } catch (error) {
    if (error instanceof StartupValidationError) {
      console.error("[startup] environment validation failed — refusing to start");
      console.error(`[startup] ${error.message}`);
    } else {
      console.error("[startup] unexpected error during startup validation:", error);
    }
    // Fail-fast: exit the process so the orchestrator (dev server, docker,
    // start script) surfaces a non-zero exit code instead of a broken app.
    process.exit(1);
  }

  // ---- Durable background-job worker (durable queue infrastructure) ----
  // Disabled explicitly with QUEUE_ENABLED=false (e.g. when a dedicated
  // `bun scripts/queue-drain.ts` worker owns the queue instead).
  if (process.env.QUEUE_ENABLED !== "false") {
    try {
      const handlers = await import("@/lib/queue/handlers");
      const worker = await import("@/lib/queue/worker");

      handlers.registerBuiltInHandlers();
      // Recurring chains: self-perpetuating jobs with honest gap recovery.
      // (ensureRecurring registers the definition AND enqueues the first run
      // if the chain has no active job.)
      await handlers.ensureRecurring(handlers.MAINTENANCE_SWEEP_KEY, handlers.SWEEP_EVERY_MS);
      await handlers.ensureRecurring(handlers.SITE_STUDIO_SWEEP_KEY, handlers.STUDIO_SWEEP_EVERY_MS);
      await handlers.ensureRecurring(handlers.WORKFLOW_SWEEP_KEY, handlers.RIISHE_WORKFLOW_SWEEP_EVERY_MS);
      await handlers.ensureRecurring(handlers.OX_MATCH_EXPIRY_KEY, handlers.OX_MATCH_EXPIRY_EVERY_MS);
      worker.startWorker();

      let shuttingDown = false;
      const graceful = (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(JSON.stringify({ event: "queue.shutdown.begin", signal }));
        // Hard cap beyond the worker's own 25s in-flight grace: never let a
        // hung handler keep the process from exiting after a shutdown signal.
        const hardExit = setTimeout(() => process.exit(0), 27_000);
        void worker
          .gracefulShutdown()
          .catch(() => undefined)
          .finally(() => {
            clearTimeout(hardExit);
            process.exit(0);
          });
      };
      process.once("SIGTERM", () => graceful("SIGTERM"));
      process.once("SIGINT", () => graceful("SIGINT"));
    } catch (error) {
      // Honest but non-fatal: a broken queue bootstrap must not take the web
      // server down. Jobs stay QUEUED and are picked up by the next boot (or
      // a dedicated drain worker).
      console.error(
        JSON.stringify({
          event: "queue.bootstrap.failed",
          message: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
}
