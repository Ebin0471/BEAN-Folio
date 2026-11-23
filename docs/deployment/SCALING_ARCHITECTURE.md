# BEAN Folio — Scaling Architecture (measured → 100k)

Status: **architecture defined, Tier A/B proven locally, Tier C (100k) NOT
measured — requires the topology in §6.** This document separates what is
MEASURED (with evidence) from what is DESIGNED (with exact activation steps).

## 1. What is already multi-instance-safe (measured / code-verified)

| Concern | Mechanism | Evidence |
|---|---|---|
| Sessions | Opaque 32-byte token, SHA-256 at rest in the `Session` table; per-request DB lookup | `src/lib/auth.ts:34-122` |
| Rate limiting | `RATE_LIMIT_BACKEND=postgres` — SHA-256-hashed keys in `RateLimitBucket`, fleet-shared | `src/lib/rate-limit-backend.ts` |
| Cache invalidation | `CACHE_BACKEND=postgres` shared tier, generation counter, whitelist (`profile:public:*`, `professions:*`) | `src/lib/cache/shared.ts` |
| Background jobs | Durable `BackgroundJob` table queue: atomic claims, heartbeats, stuck recovery, DLQ + replay, recurring chains | `src/lib/queue/index.ts` |
| Media | S3 driver + presigned direct PUT (10-min single-key), private buckets, Range serving | `src/lib/storage.ts` |
| Published GIFTZ sites | DB JSON artifacts (not instance-local files) | `public/[...path]/route.ts` |
| Realtime | SSE (stateless HTTP) — LB-friendly; no sticky sessions needed | `api/ai/chat-stream/route.ts` |
| Graceful shutdown | SIGTERM → queue drain, 27 s hard cap | `src/instrumentation.ts` |

## 2. Known instance-local state (the load-bearing gaps for >1 replica)

| Gap | Location | Effect at N>1 | Remediation plan |
|---|---|---|---|
| AI design jobs in-memory Map | `src/lib/ai-design/jobs.ts:61-62` | Poll lands on another instance → job not found | Move execution onto the durable `BackgroundJob` queue (handler + idempotency by `AgentTask.id`); terminal-state shadow already persists |
| GIFTZ task cancel/in-flight sets | `src/lib/giftz/jobs.ts:60-71` | Cancel hits instance B; task runs to completion on A | Persist `cancelRequestedAt` on the task row; workers poll the flag instead of a local Set |
| LAXII in-flight set | `src/lib/laxii/jobs.ts:79` | Duplicate execution risk on retry storms | Claim the message row (status-guarded update) like the queue does |
| Circuit breakers per-instance | `src/lib/intelligence/circuit.ts:34-43` | N× provider burst before each instance trips | Acceptable first (per-user quotas bound spend); optional shared breaker in Postgres later |
| Editing workspaces on local disk | `src/lib/giftz/workspace.ts:27` | Workspace only exists on the instance that created it | Single-writer tier: sticky route via LB, or move workspaces to S3 driver (same `storage.ts` seam) |

**Until these land, run exactly ONE app replica** (the shipped compose does)
and scale vertically. Nothing above is hypothetical: each row names its file.

## 3. Measured envelope (2026-11-23 campaign — 2 vCPU / 3.9 GiB sandbox, SQLite)

- Zero 5xx across ~107 k requests incl. **1,000 simultaneous connections**
  (closed-model) and an 800-VU connection spike; RSS stayed < 1 GB.
- Safe interactive envelope on THAT box: **~100–200 concurrent users**
  (closed-model p95 ≤ 400 ms); open-model admitted 30–80 effective RPS under
  production rate limits.
- Saturation curve (p50 56 ms → 419 ms → 756 ms at 100/500/1000 VU) is
  connection queueing + SQLite single-writer — NOT a leak or crash mode.
- Full tables: `docs/ops/LOAD_TESTING.md` §6.4; raw JSON in
  `scripts/loadtest/results/gz-scale-*.json`.

## 4. Tier ladder (targets, not claims)

| Tier | Concurrent users | Topology | Swap points (all exist) |
|---|---|---|---|
| A | ~100–500 | 1 app + Postgres + Caddy (shipped compose) | `DATABASE_URL` → postgres; backends → `postgres` |
| B | 5k–20k | N app replicas + Postgres + PgBouncer + S3 + CDN | §2 gaps closed first; `deploy.resources.replicas` / LB |
| C | 100k | Tier B + CDN (≈70 % offload) + read replicas + Redis | `DEPLOYMENT_TIERS.md` §env-lever table |

## 5. Tier C activation checklist (each item independently verifiable)

1. **Database**: PostgreSQL 16 primary (schemas already at 100/100 parity —
   `scripts/check-schema-parity.ts` in CI). PgBouncer in front; Prisma
   `?connection_limit=10&pool_timeout=10` behind it (compose already does).
   Read replica for public profile/feed reads once measured read share > 70 %.
2. **Cache/rate-limit backends**: `postgres` first; Redis adapter is a named
   swap point (`rate-limit-backend.ts:271`, `cache/index.ts:222`) — implement
   only when Postgres polling shows measurable contention (avoid adding a
   dependency before evidence demands it).
3. **Object storage**: S3 driver (`MEDIA_STORAGE_DRIVER=s3`, all four vars) +
   presigned uploads (already shipped); CDN in front of `/api/media/*/raw`
   with signed URLs.
4. **Queues**: move §2 job stores onto the durable queue; scale
   `scripts/queue-drain.ts` workers independently from web replicas.
5. **AI isolation**: per-user quotas exist (`AI_DAILY_LIMIT`,
   `INTELLIGENCE_DAILY_COST_LIMIT_USD`); add a fleet-wide concurrency
   semaphore (p-limit style) in `src/lib/intelligence/gateway.ts` before Tier C.
6. **Observability**: Prometheus scrape of `/api/metrics` (`METRICS_TOKEN`);
   alert on `bean_queue_jobs{state="QUEUED"}` age, `bean_ai_circuit_status`,
   RSS, 5xx rate.
7. **Load proof**: §6 distributed generator plan at T2 → T5 with per-source
   IPs; SLOs in `docs/ops/LOAD_TESTING.md` §2 must hold at each tier before
   the tier is claimed.

## 6. Distributed load-generator plan (100k connections cannot be generated here)

- 1 sandbox ≈ 550 req/s generated (measured ceiling). For 10–30k edge RPS:
  ≥ 20 generator boxes (or k6 cloud) running `scripts/loadtest/k6/*.js` with
  distributed execution (k6 `--distribution` / operator-managed fleet),
  distinct source IPs so rate limiting behaves like production.
- Staged: T1 1k → T2 10k → T3 25k → T4 50k → T5 100k; ramp, sustained, spike
  and soak profiles are declared in `scripts/loadtest/workloads.md` §3.
- Failure drills per tier: stop the DB, saturate AI providers (circuit must
  open and recover — regression-pinned in
  `tests/intelligence-circuit-probe.test.ts`), kill a worker mid-job
  (heartbeat recovery), 4× traffic spike.
