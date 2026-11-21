# BEAN Folio — Phase 5 Operational Readiness Audit

**Date:** 2026-11-21 · **Scope:** inspect and document the operational capabilities that
matter for running a controlled beta and the February 2027 launch, using existing
architecture and zero-cost/already-available tooling only. No new infrastructure was
added and none is recommended before the beta evidence demands it.

**Method:** every capability below was verified against the shipped code/docs in this
workspace (`e52786e`) and, where noted, exercised live against the authoritative QA
deployment on 2026-11-21. Gaps are stated honestly — nothing is aspirational.

---

## 1. Application health checks — PRESENT, VERIFIED LIVE

- `GET /api/health` — service liveness + operational counters. Live capture
  (2026-11-21): `{"ok":true,"service":"bean-folio",…,"queue":{"byStatus":{"QUEUED":5,
  "RUNNING":0,"SUCCEEDED":13,"FAILED":0,"DEAD":0,…},"oldestQueuedAgeMs":0,…},
  "cache":{"backend":"memory","size":3,"hits":10,"misses":3}}`.
- `GET /api/ready` — readiness with startup validation and DB reachability. Live
  capture: `{"ok":true,"ready":true,…,"startup":{"ok":true,"pending":true},
  "database":"reachable"}`.
- `./ensure-dev.sh` — idempotent single-instance guard including the historically
  fragile upload-route sentinel (`POST /api/media/upload` → 401 = healthy, 405 = the
  known recycle artifact with a one-line fix). Verified live this phase.
- **Gap (honest):** both endpoints are unauthenticated by design (operator-friendly)
  and expose only aggregate counters — no secrets, verified by inspection. There is
  **no external uptime monitor configured** (no paid service is approved); during beta
  the owner must poll `/api/health` externally (free tier of any uptime checker, or a
  scheduled curl from any always-on machine the owner controls).

## 2. Error and exception visibility — PRESENT (structured logs + optional webhook)

- Every unhandled API failure flows through `reportError()`
  (`src/lib/monitoring.ts`): structured JSON log event always, plus fire-and-forget
  POST of the same redacted payload to `ERROR_WEBHOOK_URL` when configured (3 s
  timeout; monitoring can never take the request path down). Verified callers:
  `api-helpers` (`api.error` with requestId, route, status), queue dead-letter
  (`queue.job.dead`), GIFTZ deploys (`giftz.deploy.failed`).
- User-facing error surfaces exist: `src/app/error.tsx`, `global-error.tsx`,
  `not-found.tsx` (verified present this phase — the old HP-2 gap is closed).
- Payload discipline: metadata only (route/status/message, redacted) — never request
  bodies, prompts, tokens.
- **Gaps (honest, pre-existing and documented):** (a) no metrics/APM aggregation —
  error visibility = logs + webhook sink, not dashboards; (b) the M-2 note stands:
  ~25 `console.error` sites and a couple of user-text logs exist outside the JSON log
  policy (Tier-C cleanup, not beta-blocking).

## 3. Database monitoring — PARTIAL

- What exists: `/api/ready` reports DB reachability; `/api/health` exposes queue
  depth/age (the primary DB-pressure signal — the queue lives in the same DB);
  startup validations verify schema expectations at boot; Prisma connection-budget
  guidance is documented for PostgreSQL (`prisma/schema.postgres.prisma` header,
  RUNBOOK §3.2).
- **Gaps:** no query-latency metrics, no slow-query log, no DB connection-usage
  export. For a single-instance SQLite beta this is acceptable (the file IS the
  database); for PostgreSQL production the provider dashboard + `connection_limit`
  budget is the documented control.

## 4. Backup and restore procedures — PRESENT, TESTED, DRILLED

- Tooling (all committed, all under test): `scripts/ops/backup-db.ts` (SQLite
  `VACUUM INTO` snapshot + `PRAGMA integrity_check` on the snapshot + row-count
  parity + sha256 manifest sidecar), `backup-media.ts` (tar.gz + per-file checksum
  ledger + full round-trip extraction proof), `backup-all.ts` (coordinated manifest;
  `status: complete` only when every check passes), `restore-from-backup.ts`
  (refuses anything not `status: complete`).
- PostgreSQL path: `pg_dump --format=custom` + `pg_restore --list` verification —
  honest failure when client tooling is missing, never fake success.
- Evidence: `tests/backup-*.test.ts` suites green in this phase's full run; Phase 3
  executed a real backup (`f5e28b0c…`) + restore drill to a disposable target with
  100-table parity and the live DB untouched.
- Retention + policy: guarded retention in the orchestrator; runtime data never
  leaves the machine (bean-sync runtime-data scan refuses db/media/backup paths).
- **Beta duty:** one `backup-all.ts` run before inviting each cohort; one restore
  drill onto a disposable copy before the first cohort goes live. (Both are owner
  actions; commands documented in `BACKUP_AND_RECOVERY.md`.)

## 5. Session and authentication behavior — PRESENT, VERIFIED

- Cookie policy (`src/lib/auth.ts`): `httpOnly: true`; `SameSite=lax` by default
  (cross-site gateway mode uses `SameSite=none; Secure`); `secure` via
  `SESSION_SECURE_COOKIES` or automatic HTTPS detection.
- Password hashing: scrypt with per-user salt; recovery-key flow at signup; logout
  clears session rows. Phase 4 verified live: cookie flags observed, anonymous
  upload 401, deleted account cannot log in, sessions revoked on deletion (J10).
- Rate-limited auth endpoints (register 10/min observed firing in Phase 4 and again
  during this phase's journey runs — the limiter is real and observable).
- **Gaps (honest):** scrypt N=16384 below OWASP-2024 guidance (documented M-7,
  Tier-C); logout lacks an origin check (same item); per-process memory rate-limit
  backend is correct only at one instance (HP-3 — fine for beta Tier A, documented
  swap to `postgres` backend for >1 instance).

## 6. Queue processing and notification delivery — PRESENT, TESTED

- Durable `BackgroundJob` queue with atomic claims, heartbeats, stale-claim recovery
  (`recoverStuck()`), attempts budget → DEAD, and operator requeue
  (`bun scripts/queue-drain.ts --requeue-dead`). Verified by `tests/queue-reliability.test.ts`
  (no double-claim, dedupe, crash/restart, dead-letter recovery, graceful shutdown)
  — green in this phase's run.
- Notifications: six OX notification types with dedupe keys and exactly-one closure
  notification (RD-18), delivered through the real notification system; in-app
  delivery verified by J8/J9 journey checks (16 + 11 checks green this phase).
- **Honest boundary:** there is no external email/push channel — notifications are
  in-product. Beta participants must be told to check the in-app notification panel;
  the hiring-room flow shows the bell badge. This is a product reality, not a defect.
- Queue topology switch exists (`QUEUE_ENABLED=false` on web + dedicated
  `queue-drain.ts` worker) — documented in `.env.example`, RUNBOOK-QUEUE, GO_LIVE
  checklist §1.

## 7. Upload reliability and storage constraints — PRESENT, TESTED

- Two transports: classic multipart `POST /api/media/upload` (the load-bearing
  route with its 405 sentinel) and presigned direct-to-bucket for S3-class storage
  (bypasses serverless body caps; content re-verified from stored bytes on
  complete — magic-byte sniffing, declared-kind match, NUL/UTF-8 scan for text,
  intrinsic image dimensions, size from HeadObject, never from the client).
- Authorization: session-required on both paths; owner-scoped unguessable keys
  (`uploads/<ownerId>/…`); private bucket; delivery only through the
  `/api/media/:id/raw` authorization ladder. Evidence: `tests/media-direct.test.ts`
  11/11, `media-upload-route` 4/4, `media-upload-http` 9/9, Phase 4 probes
  (anonymous 401, foreign object 403, owner 200).
- Constraints (documented): 64 MB video cap product-wide; local-disk driver keeps
  everything under the workspace (media backup covers it); 30/h upload quota per
  session; PENDING direct-upload rows purged by the daily sweep.
- **Gap:** no real S3 bucket exists in this environment — the presigned path is
  verified against a local S3-compatible fake (signature generation is AWS SDK's
  own); a production-bucket smoke test remains a deploy-time item (GO_LIVE §5).

## 8. Rate-limiting behavior — PRESENT, OBSERVED FIRING

- In-process memory backend by default; shared PostgreSQL backend available
  (`RATE_LIMIT_BACKEND=postgres`, atomic upsert-increments, verified cross-process
  by `verify-shared-cache.ts` 9/9 in the P1 delivery). Falls back to memory per
  call on backend failure — limits stay enforced.
- Observed live in this phase: register limiter (≈10/min) fired repeatedly during
  journey-audit registration bursts, returning 409/429 with Retry-After — this is
  the same behavior beta users would hit when a class of users signs up from one
  network. Documented consequence for beta: stagger cohort signups or expect 429s
  with honest messaging.
- **Gap:** per-process memory default is single-instance-only (HP-3, Tier-C — the
  documented beta topology is one instance, so this is correct as configured).

## 9. Rollback and recovery procedures — PRESENT, DOCUMENTED

- App-level: additive-only schema policy means the previous build keeps working
  against the newer schema; rollback = redeploy the previous immutable artifact
  (GO_LIVE §4). Publish lineage is clean (`main` history carries no runtime data —
  verified 2026-11-14 and enforced mechanically per publish).
- DB-level: restore ONLY from the verified Step-0 backup; never "undo" a migration
  by dropping (`MIGRATIONS.md` §3/§4); restore path refuses unverified artifacts.
- Degradation levers (all env-flips, no code): `CACHE_BACKEND`/`RATE_LIMIT_BACKEND`
  → memory; `QUEUE_ENABLED=false` stops new work; stuck jobs self-recover via
  heartbeat on next boot.
- Workspace-level: per-task bundles to the persistent backup location
  (`/home/sync/bean-folio-backups/`, four phase bundles present); workspace recycle
  recovery is now a documented, twice-proven procedure (Phase 1/3 checklists).

## 10. Administrative access controls — PRESENT, MINIMAL BY DESIGN

- Admin role on the User row, promoted by the committed CLI
  (`bun scripts/set-admin.ts <email>` — deliberately no admin API; Phase 4 probed
  the admin surface as anonymous → 403). Admin review actions (organization
  verification) run through the real `OxAdminVerificationPanel` with audit events.
- Ops credentials: GitHub token in the mode-700/600 vault inside `.git/bean-auth/`
  (never printed, never published; host-scoped credential helper); `.env` never
  tracked; secret scan + runtime-data scan gate every publish.
- **Gap:** admin actions are not individually rate-limited/2FA'd — acceptable for a
  single-owner beta; the honest statement is that admin security rests on the owner's
  own account hygiene.

---

## 11. Missing production capabilities (honest register)

| # | Capability | Status | Beta impact | When needed |
|---|---|---|---|---|
| G-1 | External uptime monitoring | MISSING (no paid service approved) | Owner polls `/api/health` manually/scheduled | Before first cohort |
| G-2 | Metrics/APM dashboards | MISSING (logs + webhook only) | Low — manual triage works at 14 users | Public launch scale-up |
| G-3 | CSP (M-1) | Deferred (documented Tier-C) | Low | Owner decision, post-beta |
| G-4 | Shared rate-limit backend in use (HP-3) | Configured single-instance memory | None at 1 instance | >1 instance only |
| G-5 | Out-of-app notifications (email/push) | ABSENT (in-product only) | Participants must check in-app | Owner decision |
| G-6 | Real-bucket presign smoke test | PENDING deploy-time item | None in sandbox | At deployment |
| G-7 | Load beyond 100 VU | NOT MEASURED (staging k6 plan ready) | None at beta scale | Public launch |
| G-8 | Log aggregation | MISSING (structured JSON lines exist) | Owner reads process logs | Public launch |

None of the above is beta-blocking. Items G-1 and the backup duties in §4 are the only
**operator actions required before the first cohort**; everything else is recorded as
launch-time work with an owner decision attached.

## 12. Verification index

| Claim | Evidence |
|---|---|
| Health/ready live behavior | curl captures 2026-11-21 (§1) |
| ensure-dev sentinel | live run this phase (401 guarded) |
| reportError wiring | `src/lib/monitoring.ts`, callers in api-helpers/queue/giftz |
| Error boundaries | files present this workspace (§2) |
| Backup/restore verification | `tests/backup-*.test.ts` green (90-file run) + Phase 3 drill record |
| Session cookie flags | `src/lib/auth.ts` lines 76–90 |
| Queue reliability | `tests/queue-reliability.test.ts` green this phase |
| Rate limiter firing | register 429/409 observed during journey runs (this phase) |
| Upload authz ladder | `tests/media-direct.test.ts` 11/11 + Phase 4 probes |
| Admin 403 | Phase 4 probe record (§4.4 of the release checklist) |
