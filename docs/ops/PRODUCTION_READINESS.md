# BEAN Folio — Post-Transformation Production Readiness Report

**Date:** 2026-11-07 · **Scope:** P0 delivery verification → P1 shared infra → P2 media → P3 public portfolio → P4 reliability → P5 load · **Constraint honored:** no UI redesign, no destructive changes, no pushes to `main`, no paid services, no production migrations, no DNS changes, no user data touched.

**Verdict: production-hardening infrastructure is implemented and verified to the extent this environment allows. The maximum MEASURED capacity is 100 concurrent virtual users (~165 req/s browse, 2 vCPU sandbox). Levels above that were NOT tested and are NOT claimed — see §5.**

---

## 0. Delivery verification (audit before building)

The repository was inspected against the prior delivery claims before any new work.

| Claim | Verified against source | Result |
|---|---|---|
| Durable queue (`BackgroundJob`, claims, heartbeats, dead-letter) | `src/lib/queue/{index,worker,handlers,stats}.ts` | ✅ real |
| App cache + event invalidation | `src/lib/cache.ts` | ✅ real — but **per-instance only** (drove P1) |
| Shared rate-limit backend | `src/lib/rate-limit-backend.ts` (memory \| postgres) | ✅ real |
| Storage abstraction (local \| S3) | `src/lib/storage.ts` | ✅ real |
| `/u/<username>` path serving | `src/proxy.ts` + `page.tsx` boot route | ✅ real (SPA shell, client-fetched data — drove P3) |
| Ops docs, env reference, load-test infra | `docs/ops/*`, `.env.example`, `scripts/loadtest/*` | ✅ real; load results honestly marked "local only, ≤100 VU" |
| **Media upload endpoint** | — | ❌ **BROKEN: `src/app/api/media/upload/route.ts` was missing from the tree** (client, tests and docs all referenced it; it had been accidentally deleted by an automated snapshot commit on 2026-11-03). **Restored from git history** (`5896edd^`); `tests/media-upload-route.test.ts` passes again. |

**Environment drift fixed during verification:** the `demo@beanfolio.app` seed account was missing from the dev database (tests/auth.test.ts invariant failed); recreated from `scripts/seed.ts`'s own definition. QA fixtures restored via `scripts/restore-qa-fixtures.ts`.

---

## 1. Priority 1 — Shared production infrastructure ✅ implemented + verified

**Code:** `src/lib/cache/` (index = API + memory backend; shared = shared-store backend), `CacheEntry` + `CacheGeneration` tables (SQLite + Postgres schemas), `CACHE_BACKEND=memory|postgres`.

- **Shared cache backend** — with `CACHE_BACKEND=postgres`, viewer-independent PUBLIC payloads (published profile payloads, profession taxonomy) are stored in the database and read by every instance through a short-TTL local buffer (L1 ≤ 2s). Works on the SQLite dev DB and managed Postgres with **no additional infrastructure** (no Redis required, vendor-neutral).
- **Cross-instance invalidation** — publish/unpublish/save/profile-update/professions-changed delete the shared rows AND bump the namespace's generation counter; every process re-reads the (tiny) generation table at most once per second and drops its local buffer for any namespace whose generation advanced. **Convergence: ≤ ~1s across instances, without a message broker.**
- **Atomicity / concurrency** — generation bumps are atomic upsert-increments; rate-limit buckets are atomic upsert-increments (row-lock serialized, each caller reads its own post-increment count).
- **Private data can never leak through shared caching** — the shared store accepts ONLY whitelisted public key namespaces (`profile:public:*`, `professions:*`). Anything else is refused at the write boundary (structured log) and served per-instance memory-only. Reads of private keys are refused even if a row exists. The viewer-dependent `/api/profiles/:username` response is additionally `Cache-Control: private, no-store`.
- **Failure posture** — any shared-store error flips the process to memory-only for 30s (one structured log line); the cache can never take a request down.
- **Shared rate limiting** — pre-existing postgres backend retained and now verified (see below). Memory fallback per call on backend failure, limits stay enforced.

**Verification evidence:**

- `bun scripts/verify-shared-cache.ts` — **9/9 PASS across REAL separate OS processes** (the production topology, exercised on the dev DB): cross-instance write/read, cross-instance invalidation, generation-poll L1 drop, private-key refusal, and shared rate-limit atomicity (2 processes × 12 hits, limit 15 → exactly 15 allowed, bucket count converged to 24/24 attempts).
- `tests/shared-cache.test.ts` — 12/12 (whitelist, round-trip, invalidation, L1 generation drop, memory path unchanged).

**Production env (documented in `.env.example` + `docs/ops/RUNBOOK.md` §3.1/§3.3):** `CACHE_BACKEND=postgres`, `RATE_LIMIT_BACKEND=postgres` (>1 instance), same `DATABASE_URL`; Postgres connection budget documented in `prisma/schema.postgres.prisma` (`connection_limit=10`, `pool_timeout=10`, total-budget rule of thumb).

---

## 2. Priority 2 — Production media infrastructure ✅ implemented + verified

**Code:** `POST /api/media/direct/presign` + `POST /api/media/direct/complete`, `src/lib/media.ts` (`validateDirectUploadRequest`, `completeDirectUpload`), `src/lib/storage.ts` (`presignedPutUrl`, `objectMetadata` via `@aws-sdk/s3-request-presigner`), client transport swap in `src/lib/client.ts` (transparent fallback), PENDING-cleanup in the daily maintenance sweep.

- **Presigned direct-to-object-storage uploads** — the browser PUTs bytes straight to the bucket; file contents never pass through a Next.js API handler, so the ~4.5 MB function-body cap (Vercel) no longer bounds upload size (the 64 MB video cap is now the product rule, enforced at presign AND complete).
- **Secure authorization** — both routes require a session; presign validates declared kind/size/filename against the same allowlist as the classic path (30/h quota shared); complete re-verifies ownership before touching anything.
- **File validation** — the declared mime only pre-selects the key extension; the REAL content is sniffed from the stored bytes on complete (magic bytes via ranged GET), the sniffed kind must match the declared kind, text documents get the whole-file NUL-byte/UTF-8 scan, images get intrinsic dimensions, sizes come from HeadObject (never trusted from the client).
- **Object ownership** — keys are owner-scoped and unguessable (`uploads/<ownerId>/…`); the presigned PUT grants write access to exactly ONE key for 10 minutes and can never read/list/overwrite another object; the bucket stays PRIVATE — delivery remains behind the `/api/media/:id/raw` authorization ladder.
- **Cleanup** — a failed completion deletes the object AND the row (nothing left behind); complete without an object is an honest 400; PENDING rows older than 24h are purged (object included) by the daily sweep (`maintenance.sweep` count: `mediaUploadsPending`).
- **Private/public separation** — unchanged and re-verified (§3 cache classes).
- **Preserved behavior** — existing media URLs (`/api/media/:id/raw`) and `MediaAsset` records are untouched; the classic multipart route remains (and is the transparent fallback on local-disk deployments, which answer 501 honestly); the client's `uploadFile()` signature and DTO shape are unchanged, so every upload surface works without modification.

**Verification evidence:** `tests/media-direct.test.ts` — **11/11 end-to-end against a local S3-compatible fake** (presign auth/validation/501 → direct PUT → complete content verification → byte-identical serving → mismatch/missing-object/foreign-owner failures leave nothing → PENDING sweep cleanup → private/public ladder). No real bucket exists in the sandbox (no paid services); signature generation is the AWS SDK's own — the fake verifies the APPLICATION contract.

---

## 3. Priority 3 — Public portfolio performance ✅ implemented + verified

**Code:** `generateMetadata` in `src/app/page.tsx`, `src/lib/public-profile.ts` (cached public payload → metadata), proxy edge-cache headers (`src/proxy.ts`), media cache classes (`/api/media/[id]/raw`), explicit `no-store` on the viewer-dependent profile API.

- **Server-rendered SEO/social metadata** — the document served AT `/u/<username>` now carries the creator's real `<title>`, description, canonical, OpenGraph and Twitter tags in the INITIAL HTML (source: the shared public cache, lean fallback query — never a second full fan-out). Crawlers that never execute JavaScript no longer fall back to generic app metadata. Client-side SEO (lib/seo) still owns the live head after hydration; both paths compose.
- **Draft safety** — demo fixtures and PRIVATE profiles resolve to null → generic metadata + `robots: noindex, nofollow`; a draft can never leak its name/bio/imagery through metadata, and the document HTML itself never contains draft content.
- **CDN caching** — the public-shell document carries `Cache-Control: public, max-age=0, s-maxage=30, stale-while-revalidate=120` + an `X-Bean-Edge-Cache` marker (set in the proxy — the only layer applied after the dynamic document's own `no-store`). **Honest limitation:** Next.js protects `Cache-Control` on dynamic documents, so in this dev environment the response still shows the runtime's `no-store`; in production a CDN route rule (documented in RUNBOOK §3.3) enforces the 30s edge TTL. The metadata staleness window after unpublish is ≤ 30s + SWR.
- **Image/metadata optimization** — viewer-independent public media (avatar/cover refs, PUBLIC/UNLISTED project media, published-site branding) now serves `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` (asset bytes are immutable); owner-only media keeps `private`. This makes the heavy bytes CDN/browser-cacheable for the first time.
- **Rendering strategy decision** — hybrid kept deliberately: dynamic document (force-dynamic + headers-driven boot route) + SSR metadata + edge-cacheable shell + immutable static chunks + app-level shared payload cache. Full ISR/SSG of `/u/[slug]` was evaluated and rejected for this pass: it requires a second document route through the hash-router boot contract (regression risk to core navigation, against the "preserve existing functionality" constraint) for a shell that is already cheap.

**Verification evidence:** live curl — `/u/ebin` → `<title>Ebin — Editor</title>` + `og:title` from the public payload, `X-Bean-Edge-Cache: public-profile-shell`; `/u/demo-ada` → generic title + `robots noindex, nofollow`; `/api/profiles/ebin` → `private, no-store`; `tests/p3-public-meta.test.ts` 5/5 (visibility ladder + cache classes).

---

## 4. Priority 4 — Reliability ✅ implemented + verified

**Code:** `requeueDeadJobs()` in `src/lib/queue/index.ts` + `bun scripts/queue-drain.ts --requeue-dead [jobId]` (the missing dead-letter recovery path), connection-budget documentation in the Postgres schema.

**Verification evidence (`tests/queue-reliability.test.ts`, 9/9 against the real DB):**

- **Multi-worker claims** — two concurrent claimers over 12 jobs: no double claim, every job claimed exactly once (status-guarded update = the lock), attempts == 1.
- **Duplicate jobs** — 3 concurrent enqueues with one dedupeKey → exactly ONE active row.
- **Worker crash/restart** — claimed job with stale heartbeat → `recoverStuck()` requeues (attempt honestly burned, attempts == 2) → second worker completes. At max attempts → DEAD with `lastError: "worker lost…"`.
- **Dead-letter recovery** — exhausted retries → DEAD; operator requeue (new) → QUEUED with a fresh attempt budget → SUCCEEDED.
- **Graceful shutdown** — in-flight jobs are never marked SUCCEEDED by shutdown; the stale-claim recovery path requeues them (heartbeat-liveness contract verified).
- **No-handler jobs** dead-letter honestly instead of looping.
- **DB failure posture** — a simulated DB outage on the claim path propagates as an error (the worker's tick catches, logs one structured event, continues next poll); nothing is marked SUCCEEDED; the queue works again after recovery. Rate limiter verified to fall back to memory per call.
- **Backup restoration against an isolated database** — `scripts/backup-db.ts` (VACUUM INTO, sha256 manifest) → `scripts/restore-db.ts --target /tmp/p4-restore-drill.db` (integrity_check ok, manifest verified) → row counts compared live vs restored with an isolated Prisma client: **users/projects/jobs/media all match**. The live DB was never touched.
- **Graceful application shutdown** — SIGTERM/SIGINT → stop polling → wait ≤25s for in-flight → 27s hard exit (wired in `instrumentation.ts`; the shutdown semantics are covered by the test above).
- **DB connection exhaustion** — posture documented (`connection_limit`/`pool_timeout` + total-budget rule in `prisma/schema.postgres.prisma`; RUNBOOK §3.2). SQLite (this environment) cannot exhibit pool exhaustion; on Postgres the pooler guidance is the control. Honest scope: exhaustion under real Postgres load was NOT reproduced here.

---

## 5. Priority 5 — Load tests (honest scope)

**Environment:** 2 vCPU / 3.9 GiB sandbox, dev server, SQLite, load generator on the SAME machine (it competes with the app for CPU — measured numbers are a LOWER bound on provisioned hardware, and the generator saturates first at high VU).

**Measured (dependency-free runner, read-only mix; results in `scripts/loadtest/results/2026-11-07-*.md|json`):**

| Workload | Levels run | Max measured | RPS @ max | p50 | p95 | p99 | Errors | Verdict |
|---|---|---|---|---|---|---|---|---|
| browse (public reads) | 5 / 10 / 50 / **100 VU** | **100 VU** | 165 | 354ms | 776ms | 940ms | 0 hard, 0 429 | p95 target (500ms) **breached at 100 VU** — PASS ≤ 50 VU (159 RPS, p95 403ms) |
| search | 2 / 3 / 13 / 25 / **50 VU** | **50 VU** | 138.9 | 79ms | 381ms | 487ms | 0 | PASS at all measured levels |
| authenticated reads | 1 / 5 / 10 / (20 n/a) | **10 VU** | 12.3 | 9ms | 94ms | 229ms | 0 hard; 4xx = pre-existing runner session behavior (identical in the 2026-11-05 baseline) | PASS at measured levels |
| publish/unpublish (writes) | 1 VU × 16 reqs | **1 VU** | — | 16ms / 13ms | 106ms | — | 0 | PASS (single fixture account; write throughput intentionally not scaled) |
| uploads | — | — | — | — | — | — | — | functionally verified (11 E2E tests); **NOT load-tested** (no S3 endpoint in sandbox) |
| queued generation | — | — | — | — | — | — | — | **NOT tested** (AI quota + k6-only scenario; requires staging infra per runner design) |

**Not tested and NOT claimed: 1,000 / 5,000 / 10,000 / 25,000 / 50,000 / 100,000 concurrent users.** The instruction requires dedicated load generators and isolated staging infrastructure for these levels; this sandbox has neither (2 vCPU, generator and server share the box, no CDN/Postgres/Redis). The 1k–100k plan (k6 scenarios, tier math, thresholds) exists in `scripts/loadtest/k6/`, `scripts/loadtest/workloads.md`, and `docs/ops/LOAD_TESTING.md` for the staging run.

**Maximum measured capacity: 100 concurrent users / ~165 req/s on 2 vCPU, with p95 latency breach at that level; the p95-clean ceiling on this hardware is ~50 VU (~140–160 req/s).** Nothing above that is claimed. Cost per workload: not measurable (no metered infrastructure) — recorded as N/A rather than estimated.

**Observability used during runs** (all real, from `GET /api/health`): queue depth/ages/tick, cache backend + hit/miss (4,606 hits / 7 misses at the post-run snapshot). DB connections (SQLite: single file) and CDN hit rate: not applicable in this environment — documented as unmeasured.

---

## 6. Deployment safeguards — status

- **No pushes to `main`** — nothing was pushed anywhere; all work is local commits/working tree.
- **Stale deployment branch reconciled** — `deploy` (orphan snapshot `1ee036f`, ~92k lines behind `main`, its only unique files being dead code: the superseded `api/ai/design` route and the removed Giftz panel component) was re-pointed to `main`'s tip (`git branch -f deploy main`). Old tip recorded here for provenance.
- **No paid services provisioned; no production migrations; no DNS changes.** Schema changes are additive and applied to the local dev DB only (`bun run db:push`); the Postgres parity schema was updated in lockstep (`prisma/schema.postgres.prisma`, additive tables only).
- **User data preserved** — no destructive operation ran against the DB; the only writes were QA fixture/demo-account restoration (existing scripts) and the restored upload route.

---

## 7. Remaining risks (honest)

1. **Unproven capacity above 100 VU** — the architecture targets (stateless app, shared cache/rate-limit, pooled Postgres, dedicated workers, CDN) are the right shape for 100k, but **the number is unproven until the staging k6 run executes**. The staging plan is ready; the infrastructure is not available here.
2. **CDN enforcement of the public-shell policy** is a deployment-side rule (RUNBOOK §3.3) — origin headers alone cannot override Next's dynamic-document `no-store`. Without that rule, HTML is uncached at the edge (metadata SSR still works; public media still caches).
3. **Presigned flow verified against a local S3-compatible fake** — signature correctness is AWS SDK territory; a production smoke test against the real bucket (R2/S3) is the remaining step.
4. **AI/queued-generation load** untested (needs provider quota + staging).
5. **Connection-exhaustion behavior under real Postgres** was documented, not reproduced.
6. **`/p/<id>` deep links** keep generic metadata (payload is viewer-dependent); project-level SEO tags remain client-side.

---

## 8. Evidence index

| Area | Evidence |
|---|---|
| P1 shared cache + rate limit | `scripts/verify-shared-cache.ts` 9/9 cross-process · `tests/shared-cache.test.ts` 12/12 |
| P2 presigned uploads | `tests/media-direct.test.ts` 11/11 (local S3 fake, E2E) |
| P3 public portfolio | live curl transcripts (§3) · `tests/p3-public-meta.test.ts` 5/5 |
| P4 reliability | `tests/queue-reliability.test.ts` 9/9 · backup→isolated-restore drill (sha256 + integrity + row parity) |
| P5 load | `scripts/loadtest/results/2026-11-07T03-08*.md` (browse) · `…03-11*.md` (search+reads) · `…03-20*.md` (publish) |
| Regression safety | full suite re-run in chunks: **509 tests, 0 failures** (36 files; incl. 3 new suites) · `tsc --noEmit` clean · `eslint` 0 errors (5 pre-existing k6 warnings) |
| Schema | `prisma/schema.prisma` + `prisma/schema.postgres.prisma` — additive: `CacheEntry`, `CacheGeneration` (47 tables) |
| Env docs | `.env.example` (CACHE_BACKEND, presigned-upload note) · `docs/ops/RUNBOOK.md` §3.1/§3.3/§3.4 · `docs/media-pipeline.md` §5 (status: IMPLEMENTED) |
