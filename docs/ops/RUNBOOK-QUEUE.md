# Ops Runbook — Durable Background Jobs (BEAN Folio)

Durable, DB-backed background jobs on the `BackgroundJob` table (Prisma + SQLite, PostgreSQL-compatible). Workers are interchangeable: the Next server runs one in-process worker by default, and any number of dedicated `bun scripts/queue-drain.ts` processes can share the same queue. A restart never silently loses a job — worst case, it runs again.

---

## 1. Lifecycle & guarantees

```
QUEUED ──claim (status-guarded update)──▶ RUNNING ──handler resolved──▶ SUCCEEDED
   ▲                                        │
   │◀── fail (attempts < maxAttempts):      ├──handler threw──▶ FAILED → re-QUEUED with backoff
   │    re-QUEUED, runAt = now + backoff    └──attempts ≥ maxAttempts──▶ DEAD (dead-letter)
   │
   └── CANCELLED (explicit user/ops action on a QUEUED row only)
```

- A job is marked **SUCCEEDED only when its handler resolved without error**. The worker re-verifies the row is still `RUNNING` before completing — a row that was recovered elsewhere is **not** marked success (`job.abandoned` log event).
- **Retries:** exponential backoff `min(2^attempts × 30s, 10min)`, `maxAttempts` default 3 (`attempts` is incremented at claim time). Exhausted attempts → `DEAD` with the last error stored in `lastError`.
- **Claim atomicity:** each claim is `UPDATE BackgroundJob SET status='RUNNING', claimedBy=… WHERE id=? AND status='QUEUED'`. Exactly one concurrent worker wins; losers match 0 rows. On SQLite the engine's coarse write lock makes this effectively atomic; on PostgreSQL row-level MVCC gives the same per-row guarantee (`FOR UPDATE SKIP LOCKED` is deliberately avoided — SQLite has no row locks).
- **Per-user concurrency:** at claim time a candidate is skipped while its owner has ≥ `QUEUE_USER_CONCURRENCY` (default 2) `RUNNING` jobs. Best-effort under racing workers (may briefly overshoot by the number of concurrent claimers; self-corrects). System jobs (`userId = null`) are exempt.
- **Heartbeats:** a `RUNNING` job is heartbeated every 15s. `recoverStuck()` (every 30s per worker) requeues `RUNNING` rows whose `heartbeatAt` is older than **5 min** (or `claimedAt` older than **15 min** if no heartbeat yet). Attempts are **kept**; rows already at `maxAttempts` go to `DEAD` with `lastError = "worker lost — process restarted or crashed before completion"`. That is the entire restart story — no startup probe marks anything success.

## 2. Job kinds (built-in handlers)

| Kind | dedupeKey | Schedule | What it does |
|---|---|---|---|
| `maintenance.sweep` | `maintenance.sweep` | every 10 min (self-perpetuating chain) | Retention purge, per-table counts logged (`event: "maintenance.sweep"`): `Session` expired >7d · `PasswordResetToken` expired/consumed >7d · `RateLimitBucket` `expiresAt < now` · `ExportJob` `READY` older than 24h **including payload** · `AuditEvent` older than 90d · `SiteRevision` beyond the newest 10 per user (bounded: max 50 users/sweep) · `BackgroundJob` `SUCCEEDED` >7d and `DEAD` >30d. |
| `site.studio-sweep` | `site.studio-sweep` | every 5 min + on studio reads | Kind-aware stale-task sweep (see §5): honestly fails `ENGINEERING_TASK` (60 min staleness) and `SITE_STUDIO_TURN` (30 min staleness) rows whose runner died; flips linked `SiteStudioMessage` PENDING/RUNNING → FAILED with a user-safe retryable error. |

Custom kinds: `registerHandler(kind, fn)` in a bootstrap path, then `enqueue({ kind, payload, userId? })`. A job whose kind has **no handler** fails honestly each attempt (`error: no handler registered for kind "…"` in the log) until it dead-letters.

## 3. Environment variables

| Var | Default | Meaning |
|---|---|---|
| `QUEUE_ENABLED` | `true` | `false` disables the in-process worker (use when a dedicated drain worker owns the queue). Bootstrap failure is logged (`queue.bootstrap.failed`) but never takes the web tier down. |
| `QUEUE_CONCURRENCY` | `4` | Max jobs one worker runs simultaneously. |
| `QUEUE_USER_CONCURRENCY` | `2` | Max concurrent `RUNNING` jobs per owning user. |
| `QUEUE_POLL_MS` | `2000` | Poll interval. |

## 4. Where workers run

- **In-process (default):** `src/instrumentation.ts` starts the worker after startup validation passes, registers the recurring sweeps via `ensureRecurring(...)`, and wires SIGTERM/SIGINT to a graceful shutdown (stop polling → wait for in-flight jobs, 25s cap → exit). A job that cannot finish within the grace window is *not* marked success; it loses its heartbeat and the next boot requeues it.
- **Dedicated (scale-out):** `bun scripts/queue-drain.ts` — one self-contained worker process per instance; run N copies (claims are atomic). No web server, no port. Recommended production split: `QUEUE_ENABLED=false` on web tiers + one or more drain workers.
- Both modes log the same single-line JSON events: `job.start` / `job.done` / `job.fail` (fields: `kind`, `jobId`, `userId`, `durationMs`, `attempt`, plus `outcome`/`error` on fail), and `queue.recurring.gap` when a recurring chain was found broken (how overdue it is is logged honestly, never papered over).

**Recurring chains:** `ensureRecurring(key, everyMs, handlerKind, payload)` registers the chain and enqueues if inactive. Each successful run re-enqueues its successor (`runAt = completion + everyMs`) using a `__recurring` payload stamp, so ANY worker can continue the chain. If the process dies between completion and successor enqueue (or a run dead-letters), the next boot / 30s recovery pass detects the missing active job, logs `queue.recurring.gap { overdueMs }`, and re-enqueues.

## 5. Studio turn sweep (SITE_STUDIO_TURN) — behavior

- **Trigger paths:** (a) recurring `site.studio-sweep` job every 5 min; (b) fire-and-forget `enqueueStudioTurnSweep()` on `GET /api/me/site/studio/sessions` and `GET /api/me/site/studio/turns/[taskId]` (throttled to one attempt per 30s per process).
- **What happens:** `AgentTask` rows with `kind = "SITE_STUDIO_TURN"` (agent `CODE_GIFTZ`) in `RUNNING`/`PENDING` whose `updatedAt` is older than **30 min** → `status = FAILED`, `error = "Generation interrupted — please retry"`; linked `SiteStudioMessage` rows in `PENDING`/`RUNNING` → `FAILED` with the same user-safe error. Live turns keep `updatedAt` fresh at every stage transition, so only genuinely dead turns cross the threshold. Engineering tasks keep their existing sweep behavior verbatim (60 min staleness, step-bookkeeping failure note, in-process in-flight guard).

## 6. Health & monitoring

`GET /api/health` returns value-free counters (no error text, no user data):

```json
{
  "ok": true,
  "service": "bean-folio",
  "time": "2025-11-05T16:40:12.345Z",
  "queue": {
    "byStatus": { "QUEUED": 0, "RUNNING": 1, "SUCCEEDED": 42, "FAILED": 0, "DEAD": 0, "CANCELLED": 0 },
    "oldestQueuedAgeMs": 812,
    "runningCount": 1,
    "lastTickAgoMs": 340
  }
}
```

- `oldestQueuedAgeMs` high → workers stalled or per-user guard saturated.
- `lastTickAgoMs` `null` → no in-process worker (expected with `QUEUE_ENABLED=false`; check a drain worker is running).
- `byStatus.DEAD` growing → inspect the DLQ (§7).

## 7. DLQ inspection & replay (SQLite)

```sql
-- Inspect dead letters
SELECT id, kind, attempts, maxAttempts, lastError, createdAt, updatedAt
FROM BackgroundJob
WHERE status = 'DEAD'
ORDER BY updatedAt DESC
LIMIT 50;

-- Replay a dead-lettered job (resets to QUEUED, keeps attempts — raise
-- maxAttempts if it should get fresh retries)
UPDATE BackgroundJob
SET status = 'QUEUED', runAt = CURRENT_TIMESTAMP, claimedBy = NULL,
    claimedAt = NULL, heartbeatAt = NULL, finishedAt = NULL
WHERE id = '<jobId>' AND status = 'DEAD';

-- Replay everything of one kind (e.g. after a fix shipped)
UPDATE BackgroundJob
SET status = 'QUEUED', runAt = CURRENT_TIMESTAMP, claimedBy = NULL,
    claimedAt = NULL, heartbeatAt = NULL, finishedAt = NULL
WHERE status = 'DEAD' AND kind = '<kind>';

-- Stuck-RUNNING audit (what recoverStuck() will pick up within 30s)
SELECT id, kind, claimedBy, claimedAt, heartbeatAt
FROM BackgroundJob
WHERE status = 'RUNNING'
  AND (heartbeatAt < datetime('now', '-5 minutes')
       OR (heartbeatAt IS NULL AND claimedAt < datetime('now', '-15 minutes')));

-- Recurring chain check (should always return one active row per key)
SELECT dedupeKey, status, runAt, attempts FROM BackgroundJob
WHERE dedupeKey IN ('maintenance.sweep', 'site.studio-sweep') ORDER BY createdAt DESC;
```

Prisma equivalents: `db.backgroundJob.findMany({ where: { status: "DEAD" } })`, `cancelQueued(id, userId?)` for QUEUED rows. DEAD rows are purged by the maintenance sweep after 30 days.

## 8. Failure drills

- **Kill -9 the server mid-job:** the job stays RUNNING until the next boot's recovery (heartbeat >5 min) → requeued, attempt kept. If attempts are exhausted → DEAD "worker lost". The studio sweep independently repairs user-visible turn state within 5 min (or on the next studio read).
- **Chain break (recurring):** boot logs `queue.recurring.gap` with `overdueMs` and re-enqueues. No silent schedule drift.
- **DB down:** `/api/health` queue counters degrade to nulls (liveness stays green); the worker logs `queue.claim.error`/`queue.recover.error` each tick and keeps retrying.
