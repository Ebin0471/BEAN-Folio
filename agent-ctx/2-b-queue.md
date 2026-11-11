# Task 2-b — Durable background-job infrastructure (queue)

## Status: DONE (verified live in dev.log + /api/health)

## Files (all within my ownership)
- `src/lib/queue/index.ts` — queue core: `enqueue` (idempotent on dedupeKey, P2002-safe),
  `claimBatch` (status-guarded `updateMany` atomic claim, per-user concurrency guard,
  attempts increment on claim), `complete` / `fail` (backoff `min(2^a*30s, 10min)`, else DEAD)
  / `heartbeat` / `cancelQueued` (ownership-checked) / `recoverStuck` (5 min heartbeat /
  15 min claim cutoff, "worker lost"), handler registry (`registerHandler`/`getHandler`),
  recurring-chain machinery (`registerRecurring`, `reenqueueRecurringSuccessor`,
  `ensureRecurringChain(s)`), tunables (`envInt`, `globalConcurrency`, `userConcurrency`,
  `nextBackoffMs`).
- `src/lib/queue/worker.ts` — `startWorker` (poll `QUEUE_POLL_MS`=2000, claim up to
  `QUEUE_CONCURRENCY`=4, 15s heartbeats), `gracefulShutdown` (stop polling, 25s in-flight
  grace, never marks abandoned work as success), `getWorkerStatus`. Structured logs
  `job.start` / `job.done` / `job.fail` (+ `job.abandoned`, `queue.recover.stuck`,
  `queue.claim.error`, `queue.recurring.gap`).
- `src/lib/queue/handlers.ts` — `registerBuiltInHandlers`; `MAINTENANCE_SWEEP_KEY`
  (`maintenance.sweep`, 10 min) purge: Session expired >7d, PasswordResetToken
  expired/consumed >7d, RateLimitBucket expiresAt<now, ExportJob READY >24h (payload incl.),
  AuditEvent >90d, SiteRevision beyond newest 10/user (bounded 50 users/sweep),
  BackgroundJob SUCCEEDED >7d + DEAD >30d; per-table counts logged.
  `SITE_STUDIO_SWEEP_KEY` (`site.studio-sweep`, `STUDIO_SWEEP_EVERY_MS` = **5 min**) delegates
  to kind-aware `sweepStaleGiftzTasks()`. `ensureRecurring(key, everyMs, kind?, payload?)`
  boot-time chain healing.
- `src/lib/queue/stats.ts` — `queueStats()` → `{ byStatus (zero-filled 6 statuses),
  oldestQueuedAgeMs, runningCount, lastTickAgoMs|null }`; never throws (DB down → nulls).
- `src/instrumentation.ts` — after `validateStartupEnvironment` (untouched): if
  `QUEUE_ENABLED !== "false"` → register handlers, `ensureRecurring` both sweeps,
  `startWorker()`, SIGTERM/SIGINT → `gracefulShutdown()` → `process.exit(0)` with 27s hard
  cap. Dynamic imports only (build-safe, no top-level await). Edge runtime skips all of it.
- `src/lib/giftz/jobs.ts` — `sweepStaleGiftzTasks(kinds = ["ENGINEERING_TASK","SITE_STUDIO_TURN"])`
  kind-aware (B-3): engineering 60 min unchanged verbatim; studio 30 min → task FAILED
  + linked SiteStudioMessage PENDING/RUNNING → FAILED ("Generation interrupted — please retry").
- `src/lib/site-studio/turn.ts` — doc comment (line ~37) now matches reality;
  `enqueueStudioTurnSweep()` fire-and-forget trigger (30s throttle per process).
- `src/app/api/me/site/studio/sessions/route.ts` + `turns/[taskId]/route.ts` — GET calls
  `enqueueStudioTurnSweep()` (minimal diff, best-effort).
- `src/app/api/health/route.ts` — `queue: queueStats()` snapshot (value-free, DB-down safe).
- `scripts/queue-drain.ts` — standalone drain worker (`bun scripts/queue-drain.ts`), same
  worker loop + recurring chains, own SIGTERM/SIGINT handling.
- `docs/ops/RUNBOOK-QUEUE.md` — lifecycle, kinds table, env vars, worker scaling, DLQ SQL,
  recovery semantics, failure drills.

## Key decisions
- Claim atomicity = status-guarded `UPDATE … WHERE id=? AND status='QUEUED'` (portable;
  no `SKIP LOCKED` since SQLite has no row locks). Overfetch (limit*5+10, cap 100) absorbs
  lost races / per-user skips. attempts++ happens inside the claim update.
- Per-user concurrency best-effort at claim time (COUNT RUNNING per owner, optimistic
  reservation) — documented overshoot bound = number of racing claimers.
- Recurring jobs self-perpetuate via `__recurring` payload stamp (key+everyMs) so ANY
  worker can enqueue the successor; boot/30s repair pass heals broken chains with honest
  `queue.recurring.gap { overdueMs }` logs.
- Worker holds `complete()` behind a re-check that the row is still RUNNING → a job
  recovered elsewhere can never be double-marked SUCCEEDED (`job.abandoned`).
- Renamed to match spec exactly: `gracefulShutdown()` (was shutdownWorker),
  `queueStats()` with `byStatus`/`lastTickAgoMs` (was getQueueStats/counts/lastWorkerTickAgoMs).
  Studio sweep cadence 5 min (maintenance stays 10 min) — `STUDIO_SWEEP_EVERY_MS`.

## Verification (live)
- dev.log: `queue.recover.stuck {requeued:1}` after a restart; `job.start/done` for both
  sweep kinds; successor rows QUEUED with runAt = completion +10 min (maintenance) and
  +5 min (studio) — chains self-perpetuating, dedupeKey released on success (null).
- `GET /api/health` returns live queue counters (`lastTickAgoMs` ~600ms → in-process
  worker polling).
- Pre-existing B-3 false comment in turn.ts fixed; sweep reachable from sessions/turns GET
  and the recurring job.

## Notes for next agents
- Do NOT create Prisma models named like jobs for one-off async work — use
  `enqueue({ kind, payload, userId?, dedupeKey? })` + `registerHandler`.
- The only `bunx tsc --noEmit` errors are 2 pre-existing TS2451 in
  `scripts/tmp/verify-taxonomy-2c.ts` (task 2-c scratch file, not mine) — my files are clean.
- `QUEUE_ENABLED=false` on web tiers + `bun scripts/queue-drain.ts` for scale-out.
