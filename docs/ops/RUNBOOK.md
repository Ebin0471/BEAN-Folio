# BEAN Folio — Operations Runbook

**Summary:** Day-2 operations for the BEAN Folio standalone server: deploy, environment
reference, scaling, incident recovery, monitoring/alerts, backups, and secret handling. The app
is a **stateless Next.js 16 standalone server** (`bun .next/standalone/server.js`, port 3000)
over Prisma (SQLite in dev/sandbox, PostgreSQL in production), with a durable `BackgroundJob`
queue, S3-compatible or local-disk media, and a provider-independent AI gateway.

**Companion docs (referenced, not duplicated):** `docs/ops/RUNBOOK-QUEUE.md` (queue lifecycle,
DLQ replay SQL, failure drills) · `docs/ops/MIGRATIONS.md` (schema-change policy, backup/restore
drill) · `docs/ops/DEPLOYMENT_TIERS.md` (tier configs + cost estimates) ·
`docs/deployment.md` (first deployment, Vercel cutover, P1000 troubleshooting).

**Status:** Deploy commands match the committed `package.json` scripts; probe behaviors are
verified against the live routes (`/api/health`, `/api/ready`).

---

## 1. Deploy (build → standalone → health checks → worker)

### 1.1 Build

```bash
bun install
bunx prisma generate                       # SQLite client (sandbox). Production/Vercel:
                                           # vercel-build generates from prisma/schema.postgres.prisma
bun run build                              # next build + copies static/public into .next/standalone/
```

- `output: "standalone"` is set in `next.config.ts`; the build is self-contained
  (`.next/standalone/` + copied static/public assets).
- Keep the previous build artifact per release (`builds/<git-sha>/`); a rollback is a
  symlink/pointer flip + restart — no rebuild (`docs/deployment.md` §3.8).
- Known scaffold caveat: `ignoreBuildErrors: true` — gate releases on `bunx tsc --noEmit` too
  (`docs/deployment.md` §1, `docs/testing.md`).

### 1.2 Run

```bash
NODE_ENV=production bun .next/standalone/server.js     # or: bun run start
```

- Boot order (`src/instrumentation.ts`): startup env validation runs **before** traffic
  (fail-fast `process.exit(1)` on misconfiguration — a half-configured server never comes up
  green), then the durable queue worker + recurring sweeps bootstrap (unless
  `QUEUE_ENABLED=false`), then SIGTERM/SIGINT are wired to a graceful drain (stop polling →
  wait in-flight jobs ≤25s → exit; hard cap 27s).
- Startup validation snapshot is exposed by `/api/ready` (see §1.3).

### 1.3 Health checks (in order — each proves more than the last)

| Probe | Proves | Expected |
|---|---|---|
| `GET /api/health` | process alive (liveness). Does **not** touch the DB. Carries value-free queue counters (`byStatus`, `oldestQueuedAgeMs`, `runningCount`, `lastTickAgoMs`) that degrade to nulls during a DB outage | `200 {"ok":true,"service":"bean-folio",…}` |
| `GET /api/ready` | readiness: startup validation passed **and** a real DB round-trip (`SELECT 1`, capped at 2s) answers | `200` ready · `503 {"error":"Not ready — database is unreachable"}` when the DB is down |
| `GET /api/professions` | end-to-end DB smoke (connection, credentials, schema) | `200` JSON array |
| Register a throwaway account + one upload | auth ladder + media driver | works; media blobs survive restart when S3 env is set |

Release gate: all four green on the new instance **before** shifting traffic (LB weight, DNS,
or deploy slot).

### 1.4 Queue worker on/off

| Mode | Config | When |
|---|---|---|
| In-process (default) | nothing to set (`QUEUE_ENABLED` ≠ `false`) | Tier A / single instance |
| Web tier without worker | `QUEUE_ENABLED=false` on every web instance | Tier B/C — dedicated workers own the queue |
| Dedicated worker(s) | `bun scripts/queue-drain.ts` — N copies per machine; claims are atomic, workers are interchangeable; knobs `QUEUE_CONCURRENCY` / `QUEUE_POLL_MS` / `QUEUE_USER_CONCURRENCY` | any scale-out; also the drain tool during backlogs (§4.2) |

A restart never silently loses a job — worst case it runs again (claim/heartbeat/recovery
semantics in `docs/ops/RUNBOOK-QUEUE.md` §1). Worker process count is visible indirectly:
`/api/health` → `queue.lastTickAgoMs` stays fresh while any worker polls.

## 2. Environment variable reference (grouped)

Copy values into the host's env settings — never commit real secrets. The authoritative
commented list lives in `.env.example`; queue and rate-limit vars are documented here and in
`docs/ops/RUNBOOK-QUEUE.md` §3 (they are **not yet in `.env.example`** — a known docs gap).

### Database

| Var | Values / default | Notes |
|---|---|---|
| `DATABASE_URL` | `file:./db/custom.db` (dev) · `postgresql://…` (prod) | The ONLY db config. Copy from the provider dashboard, never hand-type (P1000 runbook: `docs/deployment.md` §0.4). No `DIRECT_URL` anywhere in this repo. |

### App URL & session

| Var | Values / default | Notes |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | e.g. `https://beanfolio.example` | Exact HTTPS origin, no trailing slash. **Inlined at BUILD time** — set before deploying or redeploy after changing. Only source of permanent public share URLs (`src/lib/site-url.ts`; never from request headers) |
| `NODE_ENV` | `production` | Drives the `secure` cookie flag and HSTS header |
| `SESSION_SECURE_COOKIES` | `true`/`false` | Optional explicit override of the NODE_ENV-derived secure flag (`src/lib/auth.ts`) |

### Media / S3 (`src/lib/storage.ts`)

| Var | Values / default | Notes |
|---|---|---|
| `MEDIA_STORAGE_DRIVER` | unset (auto: S3 when configured, else local) · `local` forces local disk | Multi-instance deploys MUST use S3 — local disk is per-instance and ephemeral |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | All four required together; any S3-compatible store (AWS S3, R2, Supabase, MinIO). Bucket stays private — media streams through `GET /api/media/:id/raw` behind the authz ladder |
| `S3_REGION` | default `auto` | Optional |
| `S3_FORCE_PATH_STYLE` | default `true` (correct for R2/Supabase/MinIO) | AWS uses virtual-hosted |
| `MEDIA_LOCAL_ROOT` | default `<cwd>` | Local-driver root (testing/self-host) |
| *(serverless caveat)* | — | Vercel function bodies ≲4.5 MB; larger uploads need presigned direct uploads (designed, not implemented — `docs/media-pipeline.md` §5) or a self-hosted server |

### AI gateway

| Var | Values / default | Notes |
|---|---|---|
| `AI_PROVIDER_API_KEY` | — | Swap the text provider off the sandbox gateway (`docs/ai-integration.md` §9). Server-only |
| `BEAN_TEXT_PROVIDER_PRIMARY` | provider id | Optional pin; default `bean-managed` |
| `INTELLIGENCE_DAILY_COST_LIMIT_USD` | default `5` | Per-user daily budget of DOCUMENTED cost estimates for metered image engines — a guardrail, not a bill |
| `LAXII_DEFAULT_PROVIDER` | `managed` \| `gemini` \| `openai` \| `diffusers` | Image studio provider |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` | — | Leave unset to keep a provider disabled. Server-only |
| `LAXII_DIFFUSERS_URL` (+ `_MODEL`/`_TOKEN`/`_NEGATIVE`) | — | Local Diffusers inference server (privacy engine) |

### Queue

| Var | Values / default | Notes |
|---|---|---|
| `QUEUE_ENABLED` | `true` (default) · `false` | `false` disables the in-process worker (dedicated drain workers own the queue). Bootstrap failure is logged, never takes the web tier down |
| `QUEUE_CONCURRENCY` | default `4` | Max simultaneous jobs per worker process |
| `QUEUE_USER_CONCURRENCY` | default `2` | Max concurrent RUNNING jobs per owning user |
| `QUEUE_POLL_MS` | default `2000` | Poll interval |

### Rate limiting

| Var | Values / default | Notes |
|---|---|---|
| `RATE_LIMIT_BACKEND` | `memory` (default) · `postgres` | `memory` = per-instance fixed-window Map (cap 5000 keys). `postgres` = shared buckets in `RateLimitBucket` rows, keys SHA-256-hashed before storage (`src/lib/rate-limit-backend.ts`). Required for >1 instance. Falls back to memory per-call if the backend throws — limits stay enforced, just per-instance (one structured log line) |
| *(no Redis backend yet)* | — | Redis-compatible adapter is the documented swap point in `src/lib/rate-limit-backend.ts` (Tier B/C) |

## 3. Scaling procedures

### 3.1 Horizontal app instances (stateless — the easy part)

The Next server holds no state: sessions are DB rows, media is S3, queue is DB rows. Scale = run
N instances behind a load balancer. Before N > 1:

1. **`RATE_LIMIT_BACKEND=postgres` (mandatory).** In-memory buckets are per-instance: with N
   replicas every quota (login, uploads 30/h, AI minute-buckets, follow, recovery attempts)
   effectively multiplies by N, resets on each deploy/restart, and abuse protection is void.
   With the postgres backend every instance shares the same buckets. NOTE: the shared minute
   buckets for AI remain per-process in memory on the legacy path — verify the AI quota routes
   use the shared backend when scaling (audit item 5.1 in `docs/known-limitations.md`).
2. **`CACHE_BACKEND=postgres` (mandatory at N > 1).** The shared cache backend (P1,
   `src/lib/cache/`) stores viewer-independent PUBLIC payloads (published profiles, profession
   taxonomy) in CacheEntry rows and invalidates through CacheGeneration counters — a publish on
   instance A invalidates instance B's local buffer within ~1s, verified cross-process
   (`bun scripts/verify-shared-cache.ts`). A per-key PUBLIC whitelist refuses private data at
   the write boundary; on any shared-store error a process falls back to memory for 30s (one
   structured log line, limits stay enforced).
3. **Database connections multiply.** Each instance opens its own Prisma pool — put a pooled
   endpoint (pgBouncer / Neon pooler / RDS Proxy) behind `DATABASE_URL` before ~3+ instances.
4. **Stop the in-process workers, run dedicated ones.** `QUEUE_ENABLED=false` on web instances;
   run `bun scripts/queue-drain.ts` as separate processes (start 1, add copies while
   `oldestQueuedAgeMs` stays high). In-process workers on every web instance still work (claims
   are atomic) but AI generation then shares the request-serving event loop.
5. Media: S3 driver only (§2). Local disk breaks silently — rows point at blobs another
   instance cannot see.

### 3.2 What breaks without the above (honest list)

- Missing `RATE_LIMIT_BACKEND=postgres` → quotas ×N, per-instance resets, distributed brute
  force unbounded per-IP (each replica has its own IP bucket).
- In-process worker on every web replica → noisy-neighbor: one heavy generation slows all
  requests on that instance; deploys kill in-flight jobs mid-heartbeat (they recover, but
  user-visible turns fail and must be retried).
- Local media driver at N>1 → 404s on media served by instances without the blob.
- Un-pooled Postgres at many replicas → connection exhaustion (each Prisma pool defaults to
  ~num_cpus×2+1).

### 3.3 Caching & CDN (P3)

Three cache layers and their invalidation story:

| Layer | What | TTL / policy | Invalidation |
|---|---|---|---|
| App (shared) | public profile payloads, profession taxonomy (`CacheEntry`) | 60s / 5min | publish/unpublish/save/profile.update/professions.changed delete shared rows + bump the namespace generation (all instances converge ≤ ~1s) |
| Edge/CDN — public media | `/api/media/:id/raw` for viewer-INDEPENDENT classes (avatar/cover refs, PUBLIC+UNLISTED project media, published-site branding) | `public, max-age=3600, stale-while-revalidate=86400` | bytes are immutable per asset id; deleting an asset removes future cacheability — a stale public copy can persist ≤1h after deletion (acceptable: it was public) |
| Edge/CDN — owner-only media | everything else on `/api/media/:id/raw` | `private, max-age=3600` | never stored by a shared cache |
| SPA document | `/u/<username>` served AT the path | origin emits `no-store` (dynamic doc); proxy sets the intended CDN policy `public, max-age=0, s-maxage=30, stale-while-revalidate=120` + `X-Bean-Edge-Cache` marker | deploy a CDN route rule (e.g. Cloudflare Cache Rule / Fastly edge dictionary) to cache `/u/*` for 30s ignoring origin `Cache-Control`, or rely on the proxy header with a CDN that honors it. The shell contains platform chrome + metadata derived ONLY from the public payload; the DATA endpoint is `private, no-store`, so no per-viewer state can enter the edge cache |

SEO/social metadata is now SERVER-GENERATED for `/u/<username>` (src/app/page.tsx
generateMetadata via lib/public-profile): crawlers without JS see the creator's real
title/description/canonical/og tags from the cached public payload. PRIVATE/demo profiles get
generic metadata + `noindex, nofollow` — a draft can never leak through metadata.

### 3.4 Dead-letter recovery (P4)

Dead letters (`BackgroundJob.status='DEAD'`) are NEVER auto-retried. Operator path:

1. Inspect: `dead` count via `GET /api/health` (queue.byStatus) and the rows themselves
   (`lastError` holds the final error message).
2. After fixing the cause, requeue ALL dead letters older than 5 min:
   `bun scripts/queue-drain.ts --requeue-dead`
   — or exactly one: `bun scripts/queue-drain.ts --requeue-dead <jobId>`.
   Attempts reset to 0 (fresh budget); `lastError` is kept for the audit trail.
3. Watch `queue.dead.requeued` in the logs, then the job's own `job.start`/`job.done`.

## 4. Incident recovery

### 4.1 Database down / unreachable

- **Behavior:** `/api/health` stays **200** with `queue` counters `null` (liveness by design —
  it never touches the DB); `/api/ready` returns **503** `not_ready`; DB-backed routes 500;
  the worker logs `queue.claim.error` / `queue.recover.error` each tick and keeps retrying
  (`docs/ops/RUNBOOK-QUEUE.md` §8).
- **Playbook:** check provider status → verify `DATABASE_URL` was not rotated (P1000/P1001
  diagnostics in `docs/deployment.md` §0.4 — copy the current string from the dashboard, never
  hand-type) → when the DB answers again, `/api/ready` flips to 200 **without an app restart**
  (the probe re-checks every request). Jobs queued during the outage drain automatically;
  heartbeats older than 5 min self-requeue.

### 4.2 Queue backlog (oldestQueuedAgeMs high / DEAD growing)

1. Read `/api/health` → `queue.byStatus.QUEUED`, `oldestQueuedAgeMs`; `lastTickAgoMs: null`
   means no in-process worker is polling (expected with `QUEUE_ENABLED=false` — confirm a drain
   worker is actually running).
2. Add drain capacity: `bun scripts/queue-drain.ts` (one or more processes). Claims are atomic;
   extra workers are safe anytime.
3. Per-user saturation: `QUEUE_USER_CONCURRENCY` (default 2) can hold the queue with one heavy
   user — raise it deliberately or let it self-drain.
4. Dead letters: inspect + replay with the SQL in `docs/ops/RUNBOOK-QUEUE.md` §7
   (`UPDATE BackgroundJob SET status='QUEUED' … WHERE status='DEAD' AND kind=…` after shipping
   the fix). DEAD rows purge after 30 days via `maintenance.sweep`.
5. If a job kind fails with `no handler registered` → a deploy shipped a kind whose handler
   registration was lost; fix the bootstrap and replay.

### 4.3 Stuck studio turns ("pending forever")

- Covered by the **`site.studio-sweep`** recurring job (every 5 min) + a fire-and-forget sweep
  enqueue on studio session/turn reads (throttled 30s/process): `AgentTask` rows of kind
  `SITE_STUDIO_TURN` in RUNNING/PENDING with `updatedAt` older than **30 min** → FAILED with a
  user-safe retryable error; linked `SiteStudioMessage` PENDING/RUNNING → FAILED the same way.
- User action after a sweep: hit **Retry** in the studio chat. If a turn is stuck <30 min,
  it may still be live — do not force-fail it manually before the threshold.
- Root cause of stuck turns is usually a restart during a 60–120s generation — the queue's
  heartbeat recovery requeues the job; the sweep repairs user-visible state. Both fire on next
  boot; no manual SQL needed (manual repair SQL for other kinds: RUNBOOK-QUEUE §7).

## 5. Monitoring & alert list

**Observable today** (no external tooling): structured single-line JSON logs
(`job.start/done/fail`, `queue.recurring.gap`, `queue.claim.error`, `[api]` error choke point,
`[ai]` gateway lines, `maintenance.sweep` counts), `/api/health` queue snapshot, `/api/ready`,
`/api/professions` as DB smoke. At Tier B/C these become scraped metrics/log pipelines — each
row names the minimum external tool.

| Alert | Why | Observable today | Needs at Tier B/C |
|---|---|---|---|
| p95 latency per route | user-facing degradation | nothing built-in | reverse-proxy/CDN metrics + APM (OTel/Sentry perf) |
| 5xx error rate | incidents | `handler()` logs `[api] …` per error | log aggregation + alert on rate (Sentry/Datadog/CloudWatch) |
| DB connection errors / saturation | outages, pool exhaustion | `/api/ready` 503; `[api]` Prisma errors | provider metrics (connections, CPU, replication lag) + alerting |
| Queue depth & oldest job age | backlog/user-visible stalls | `/api/health` → `queue.byStatus`, `oldestQueuedAgeMs` | exporter scraping `/api/health` → metric + alert (e.g. QUEUED > 500 for 10m, oldest > 15m) |
| Worker failures / no worker | jobs never start | `lastTickAgoMs: null` (no poller); `job.fail`, `queue.bootstrap.failed`, `queue.claim.error` logs | process manager/restarts + log alert; DEAD-count alert |
| DEAD (DLQ) growth | permanently failed jobs | `/api/health` → `byStatus.DEAD`; sweep purge logs | alert on any DEAD increase; DLQ review cadence |
| Storage errors (S3) | uploads/media serving broken | `[api]` errors on media routes; serving route degrades to FAILED/404 | bucket metrics (4xx/5xx on S3 API) + disk-usage alert if local driver persists |
| Auth failures (login/recovery) | brute force, outage of scrypt path | security logs via `[api]`/route errors; recovery limiter is failure-count based | log-based anomaly alert (spikes of 401/403 per IP/account) |
| Generation failures (AI) | provider outage/cost blowout | `job.fail` with kind, `[ai]` provider errors | alert on `AiProviderError` bursts + daily cost estimate vs `INTELLIGENCE_DAILY_COST_LIMIT_USD` |
| Publish failures | core user flow broken | `[api]` errors on `/api/me/site/publish` (atomic single-row snapshot) | route-level 5xx alert |
| Rate-limit events (429s) | abuse or misconfigured limits | in-memory backend has no event log — 429 responses only; postgres backend records bucket rows (`RateLimitBucket`) | 429-rate alert; at scale, move to Redis/DB backend metrics |
| Uptime | outages | — | external uptime probe on `/api/health` (1 min) + `/api/ready` (5 min) from outside the network |

## 6. Backups & restore cadence

M21 adds the coordinated, fully verified tooling behind this table —
`scripts/ops/backup-all.ts` (orchestrator: DB + media in one run, one
connecting manifest, every checksum re-verified, fail-closed) and
`scripts/ops/restore-from-backup.ts` (manifest+checksum validation, fresh
pre-restore backup, isolated staging drill by default, live restore only
behind `--confirm-live --yes`). Full reference:
**`docs/ops/BACKUP_AND_RECOVERY.md`**.

| Store | Method | Schedule | Restore test |
|---|---|---|---|
| SQLite (`db/custom.db`) | `bun scripts/backup-db.ts` (VACUUM INTO, manifest sha256, keeps 14) | hourly cron + **before every schema change**; ship off-host (object storage w/ encryption) | drill per `docs/ops/MIGRATIONS.md` §5 — quarterly + after every schema change; restore into a throwaway `--target`, never over the live file |
| PostgreSQL | managed PITR + `pg_dump --format=custom` (exact command printed by `backup-db.ts`) | provider PITR continuous; pg_dump daily | `pg_restore` into scratch DB quarterly; PITR-to-timestamp exercised once before relying on it |
| Media (S3/local) | S3 bucket versioning or cross-region replication; local driver → file-level backup of `uploads/` | continuous (versioning) / daily (local) | quarterly: restore one media object and serve it via `/api/media/:id/raw` |

Measure and record RTO/RPO on every drill (`docs/deployment.md` §3.7). A backup that has never
been restored is not a backup.

## 7. Secret management rules

- Never commit secrets: `.env` is gitignored and excluded from the deploy branch; `.env.example`
  carries placeholders only. `db/custom.db` (password hashes) and user media are likewise
  excluded from deploy branches — verify with `git ls-tree` before pushing (`docs/deployment.md` §0.2 Step A).
- Credentials are **copied from the provider dashboard**, never hand-typed or reconstructed
  (trailing spaces / percent-encoding mistakes are the top P1000 cause — `docs/deployment.md` §0.4).
  Verify with the read-only probe `bun scripts/check-postgres-connection.ts` before redeploying.
- Server-only keys (`S3_SECRET_ACCESS_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `AI_PROVIDER_API_KEY`,
  `GEMINI_API_KEY`, `OPENAI_API_KEY`, `LAXII_DIFFUSERS_TOKEN`) must never reach the client bundle
  or API responses — provider identity is server-side by design.
- Rotating a secret = update the env setting → **redeploy** (env changes apply only to new
  deployments; `NEXT_PUBLIC_*` additionally re-inlines at build time). Rotating a DB password
  invalidates every previously copied connection string.
- Derived-value hygiene is built in: session tokens stored SHA-256-hashed; postgres rate-limit
  bucket keys SHA-256-hashed before storage (`src/lib/rate-limit-backend.ts`); recovery-limiter
  buckets keyed on the hashed email.
- Store host-level secrets in the platform's secret manager (Vercel env scopes / systemd
  EnvironmentFile with 600 perms / Docker secrets) — not in dotfiles on shared hosts.

## 8. Related docs

`docs/ops/RUNBOOK-QUEUE.md` · `docs/ops/MIGRATIONS.md` · `docs/ops/DEPLOYMENT_TIERS.md` ·
`docs/deployment.md` (§0.2 first deploy, §0.4 P1000, §3 production runbook, §4 checklist) ·
`docs/SECURITY_NOTES.md` (hardening record) · `docs/media-pipeline.md` (S3 + presigned path)
