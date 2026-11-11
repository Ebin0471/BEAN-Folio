# BEAN Folio — Root-Cause Bottleneck Report

Each item: symptom → root cause → blast radius → fix (mapped to IMPLEMENTATION_PLAN.md IDs).

## P0 — Blocking production correctness

| # | Finding | Root cause | Blast radius | Fix |
|---|---|---|---|---|
| B-1 | **Every media upload 405s on main.** Client POSTs `/api/media/upload` (`src/lib/client.ts:86`, 5 call sites) but the route exists only on the stale `deploy` branch | Route historically deleted while client + docs + `saveUpload()` (`lib/media.ts:133`) remained | All uploads: avatars, covers, project media, LAXII references | Restore route (auth → rate 30/h → `saveUpload` → UploadError 400); re-enable `tests/media-upload-route.test.ts` |
| B-2 | **PG mirror missing 3 models** (`AgentArtifact`, `SiteStudioSession`, `SiteStudioMessage`) | Mirror drifted while features landed on SQLite schema only | `vercel-build` (client generated from mirror) → type-check failure / runtime 500 in studio + artifacts | Re-sync mirror; add CI parity gate |
| B-3 | **Crashed studio turns strand forever** — `sweepStaleGiftzTasks` filters `kind:"ENGINEERING_TASK"` only (`giftz/jobs.ts:643-644`), but `turn.ts:37` claims SITE_STUDIO_TURN is swept | Sweep scope never extended when studio turns adopted AgentTask | Users see eternal "pending" turns after any restart/crash | Kind-aware sweep on session/turn reads (B-8 queue adds claim/recovery) |
| B-4 | **No backups, no migration history** — live DB gitignored, `pg-migration/` 808-row backup deleted, no `prisma/migrations/` | Ops never operationalized | Unrecoverable data loss on any incident | Backup script + schedule, additive-migration policy, documented restore drill (docs/ops) |

## P1 — Horizontal-scale blockers (why 1 instance ≠ N instances)

| # | Finding | Root cause | Blast radius | Fix |
|---|---|---|---|---|
| B-5 | **Rate limiting silently disables at >1 replica** — fixed-window buckets in per-process `Map` (`api-helpers.ts:47-79`, cap 5000) | No shared backend | Login/AI/upload quotas unenforceable; abuse protection void | Limiter interface + shared backend (DB upsert opt-in; Redis-compatible adapter documented) |
| B-6 | **Design-job store is process-local** (`globalThis` Map, `ai-design/jobs.ts:48-49`) | Jobs created before queue existed | Restart during `ai/design/execute` loses job while client polls | Durable `BackgroundJob` queue (B-8) + honest "job lost → retry" path |
| B-7 | **All generation work dies with the process** — `void executeTurn(...)` in-process | No worker separation | Deploy/restart kills in-flight AI work; one heavy user shares the event loop with everyone | Durable queue + worker loop with claim/retry/backoff/DLQ + per-user concurrency caps |
| B-8 | **No request correlation** — `console.error("[api]", e)` only | Observability never added | Incidents undebuggable at scale; no per-request tracing | Request-ID in `handler()`, structured log lines, `x-request-id` response header |
| B-9 | **Zero caching on hot public reads** — profile/discover recompute 5-6 queries + a write per hit | Caching layer never built | DB CPU scales linearly with reads; public portfolio is the 100k-user hot path | App-level TTL cache + publish/unpublish invalidation + cache headers on immutable public data |

## P2 — Efficiency & correctness debt

| # | Finding | Root cause | Fix |
|---|---|---|---|
| B-10 | `Block` OR-scan on every authenticated public request (6 routes) + 11 other missing FK indexes | Indexes added reactively | Additive index migration |
| B-11 | Unbounded-growth tables: `Session` (expired never purged), `ExportJob.payload` (giant JSON rows), `AuditEvent`, `PasswordResetToken` | No retention jobs | Maintenance sweep in queue worker |
| B-12 | Offset pagination masquerading as "cursor" (search/discover/admin) | `cursor` param parsed into `skip` | Keyset pagination on large collections (bounded pools mask it today) |
| B-13 | Media raw route buffers whole objects (≤64 MB video) + JSON-LIKE substring scans for published-site refs | Serving path predates streaming; refs stored as JSON strings | Stream body passthrough; promote site media refs to indexed columns (later) |
| B-14 | Public profile route hydrates full User row incl. `passwordHash`/`recoveryKeyHash` | `include` instead of `select` | `select`-narrow the query |
| B-15 | Public portfolio is CSR-only: crawlers get skeletons; 6+ queries per hit with no cache | SPA single-document design (deliberate) | Keep SPA; add app-level cache now; document SSR/ISR path as Tier C evolution (no UI redesign) |
| B-16 | Synchronous 60–120 s AI routes (`ai/chat`, `ai/design/plan`, `ai/design/audit`, `laxii/resume`, materials vision call) | Predate 202+poll convention | Migrate to queue-backed jobs progressively; per-user concurrency caps |
| B-17 | Single 2,023-line template registry file; 4 registries must move in lockstep; all template ids inlined into every plan prompt | Organic growth | Split into per-collection modules; cap prompt embedding |
| B-18 | 18-slug profession taxonomy hardcoded in route seed + static fallback (drift-prone stringly-typed slugs in 3 places) | Taxonomy never designed | DB-driven hierarchical taxonomy, single source module, backward-compatible API |

## Deliberate non-issues (audited, OK)

- No IDOR found anywhere (double-checked studio/laxii/giftz/media paths).
- No client-supplied userId/role anywhere (grep-verified 0 matches).
- Prisma client is a proper singleton with dev hot-reload guard.
- `/api/ready` is a real readiness probe (2 s-capped `SELECT 1`).
- Site publish/unpublish is atomic at the row level and isolated from drafts.
- XFF handled correctly behind Caddy (rightmost = remote_host).
