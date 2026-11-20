# BEAN FOLIO — February 2027 Public Launch Checklist

**Mandate:** owner launch-acceleration directive (2026-11-20, IM trace `1a1f8637ef461ecd`).
**Objective:** a complete, reliable, trustworthy public BEAN Folio by February 2027.
**Optimization target:** product readiness, user experience, security, launch reliability —
not milestone count.

This file is the **single central release checklist**. Every progress report updates it.
Every report must state: actual completed functionality, exact changed files, tests
actually executed and results, known defects and remaining blockers, commit SHA and
publication status, database and deployment status, and the next concrete deliverable.

---

## Programme phases

### Phase 1 — Workspace and source stabilization — **IN PROGRESS**

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1.1 | Recovery investigation of original M-O7 workspace | DONE (2026-11-20, verdict **C — unrecoverable from this environment**) | All persistent sources checked read-only: live overlay workspace (stale O2-era @ `9947e73f`), PolarFS volume `/tmp/my-project` (O2-era, frozen 2026-11-17), OSS `repo.tar` (O2-era content, uploaded 2026-11-19 16:16 UTC, zero O7 markers), Nov-10 7z archives, dangling commits (Oct 24–Nov 12), Z.ai in-container state. One platform-side location (`/home/z/.zai-reserve`, root-only) uninspectable. Original uncommitted M-O7 implementation (21 paths) exists in no accessible location. |
| 1.2 | Authoritative workspace established from remote `main` | DONE | Fresh clone of `https://github.com/Ebin0471/BEAN-Folio.git` at **`93779fe75dccf6cd76ac113c2555c4b1c14fdbf5`** (M-O6 published baseline, parity 96) into `/home/z/bean-folio`. Clean tree; credential vault equipped with preserved permissions (700/600); original vault in the stale workspace untouched. |
| 1.3 | Stale workspace preserved for investigation | DONE | `/home/z/my-project` untouched: `main` @ `9947e73f9dc246b570fa4c06f8fcd72264d2e84d`, clean tree, 3 local-only commits (`8f4a9389`-chain) preserved, `.git/bean-auth/` intact. Never reset/clean. Its PolarFS twin (`/tmp/my-project`) equally untouched. |
| 1.4 | Policy documents read (authoritative versions) | DONE | `AGENTS.md`, `DEVELOPMENT_SAFETY.md`, `docs/ops/MILESTONE_EXECUTION_PROTOCOL.md`, `docs/ops/MIGRATIONS.md`, `scripts/ops/qa-db-env.sh`, `scripts/ops/bean-sync.sh` — all read from the authoritative baseline. |
| 1.5 | Reproducible dev environment | DONE | `bun install` (652 pkgs) → both Prisma clients generated → fail-closed QA guard validated → fresh isolated QA SQLite bootstrapped (`db/custom.db` in-workspace, 96 tables, integrity ok, FK 0) → parity 96/96 → dev server on :3000 serves the authoritative app (verified via O6-era route auth response) → `./ensure-dev.sh` green (upload sentinel 401-guarded). |
| 1.6 | Baseline verification at `93779fe7` | DONE | `bunx tsc --noEmit` → **0 errors**. `bun run lint` → **0 errors / 13 warnings** (matches known-baseline register). Full suite (88 files / 1326 tests, batched sequential execution): **1323 pass, 4 investigated and resolved/classified** — (a) `queue-reliability` double-claim test: transient enqueue/claim clock-boundary flake, zero double-claims observed (atomicity held), 3/3 focused re-runs green; (b)+(c) two `auth.test` DB-accumulation invariants: fresh-workspace artifacts — resolved by canonical QA bootstrap (10 historical fixture accounts recreated `isDemo=true`; one canonical tombstone produced through the REAL `/api/me/deletion` flow; suite-created non-anonymized fixture tombstones removed from the QA DB only). `auth.test` final: 9/9. Browser acceptance: `/` renders fully (nav, welcome, feeds), **zero console/page errors**. |
| 1.7 | Prevent loss of uncommitted work | ONGOING DISCIPLINE | (a) verified work is committed per task and published via `bean-sync.sh` (repo binding policy, endorsed by the launch mandate); (b) after every verified commit a git bundle is written to the persistent OSS sync area `/home/sync/bean-folio-backups/` (OSS proven to survive container recycling: Nov-10 uploads still mounted 2026-11-20). |
| 1.8 | Central release checklist (this file) committed + published | DONE (this commit) | This file + restored M-O7 decision register committed on local `main` and published via `scripts/ops/bean-sync.sh` with remote-SHA verification. |

**Environment incident record (Phase 1, resolved):** the sandbox shell injects a legacy
`DATABASE_URL=file:/home/z/my-project/db/custom.db` into every fresh shell. The first dev-server
launch inherited it and briefly served the authoritative app against the LEGACY database; live-HTTP
test suites then registered fixture rows through that server (1 fixture user + 1 session and a few
runtime rows landed in the legacy DB). Contained the same hour: server relaunched with the QA URL
hard-pinned (`file:/home/z/bean-folio/db/custom.db`), legacy DB verified integrity-ok with the
pre-existing user row untouched, fixture rows deliberately LEFT in place (preservation policy —
never modify the legacy DB). Standing rule recorded: **every DB-touching command must pin
`DATABASE_URL` inline and validate via `scripts/ops/qa-db-env.sh assert`.** The detached launcher
(`/home/z/bean-folio-dev-launch.sh`, outside the repo) and the batched test runner are sandbox
plumbing — never committed to the product repo. |

### Phase 2 — M-O7 completion — **COMPLETE (2026-11-20)**

Reimplementation from the approved owner decision register (RD-1…RD-22 + acceptance
clarifications A–D), restored at `docs/ops/O7_OWNER_DECISION_REGISTER.md`. Exactly 4 new
models (`HiringRoom`, `HiringRoomMember`, `Interview`, `HiringStageEvent`), parity 96→100,
routes, UI panels, activity timeline, 6 notification types, migration registration
(SQLite + PostgreSQL DDL, never executed against production), regression coverage.
All M-O1–M-O6 functionality preserved.

| # | Item | Status |
|---|------|--------|
| 2.1 | Restored decision register committed | DONE (`1c0d501b`) |
| 2.2 | Schema: 4 models in both dialects + parity gate | DONE — parity 100/100; `Interview.meetingLink` (RD-15) included |
| 2.3 | Lib layer: room authz, serializers (VIEWER allowlist), activity timeline, notifications, reason vocabulary | DONE — `src/lib/ox/room.ts` + `room-shared.ts` + `room-dto.ts`; +15 audit actions; +6 notification types; clarification-A verification recorded |
| 2.4 | API routes (rooms / members / stages / interviews / withdraw / close / cancel) | DONE — 17 routes, party-aware 404-deny, strict zod, rate limits |
| 2.5 | UI: employer + candidate hiring-room panels | DONE — 2 new panels + 2 additive view insertions; browser-verified |
| 2.6 | Migration registration (O7 SQLite + PG DDL, registration doc) — NOT executed | DONE (registered) — artifacts + `docs/ops/O7_MIGRATION_REGISTRATION.md`; PG DDL NOT executed (deployment prerequisite) |
| 2.7 | Regression coverage + security matrix per RD | DONE — 58 new tests (engine 31 + routes 27), full suite 1384/1384, 28-step live-HTTP journey 28/28 |
| 2.8 | M-O7 completion report + browser acceptance | DONE — `docs/ops/O7_COMPLETION_REPORT.md`; browser evidence incl. one found-and-fixed detail-shape crash |

### Phase 3 — Database and infrastructure readiness — **NOT STARTED**

Registered sequence O2.1 → O3 → O4 → O5 → O6 → O7 validated with isolated QA, backups,
restore drills, additive-migration review, integrity verification. Production migrations
only after explicit owner authorization. (`scripts/ops/qa-db-env.sh` present at baseline —
fail-closed guard confirmed working in this workspace.)

### Phase 4 — Complete launch-readiness audit — **NOT STARTED**

End-to-end journeys to audit: candidate registration & portfolio; privacy/publication
controls; employer onboarding & verification; discovery & consent; opportunity creation &
applications; matching, shortlisting & invitations; compensation negotiation; hiring rooms,
interview scheduling & outcomes; messaging & notifications; account deletion & privacy;
responsive desktop & mobile. Plus performance, accessibility, security, privacy, operational
recovery, error handling.

| Severity | Meaning | Count |
|----------|---------|-------|
| P0 | Critical security / data-loss / launch-blocking | 0 known |
| P1 | Core user journey broken or materially unreliable | 0 known |
| P2 | Important, safely includable pre-launch | 0 known |
| P3 | Post-launch enhancement | 0 known |

Known baseline defects carried from the O6-era audit record (not new findings): none open —
M22 blockers were resolved before O1 (protocol §6 re-baseline: tsc 0, full suite green).

### Phase 5 — Beta and public launch — **NOT STARTED**

Controlled private beta → real user feedback → critical-defect resolution → feature freeze →
public launch in February 2027.

---

## Progress log (newest first)

| Date (UTC) | Entry |
|-----------|-------|
| 2026-11-20 | **Phase 2 (M-O7) complete**: schema parity 100, engine+routes+UI+tests implemented, 58 new tests, full suite 1384/1384, 28-step live-HTTP journey 28/28, browser acceptance (1 crash found→fixed→re-verified), migration artifacts registered (PG not executed), completion report filed. Published via bean-sync with SHA verification. |
| 2026-11-20 | Phase 1 executed: recovery verdict C; authoritative workspace cloned at `93779fe7`; stale workspace preserved; QA DB bootstrapped (96 tables, integrity ok); dev server serving authoritative app on :3000; tsc 0 / lint 0e-13w; full suite 1326 tests → 1323 pass, 4 investigated (1 timing flake classified, 2 accumulation invariants resolved via QA bootstrap, auth 9/9); browser acceptance zero errors; legacy-DB leak incident contained; checklist + restored O7 register committed and published. |

**Known-baseline register additions (fresh-workspace findings, classified):**
- P3 (test stability): `queue-reliability` "K concurrent claimers never double-claim" is
timing-sensitive in one-process full-suite runs (enqueue/claim overlap); batched execution
and 3/3 focused re-runs are green; claim atomicity itself held in every observation.
- P3 (test environment): two `auth.test` invariants encode accumulated-DB state
(historical fixture accounts + tombstone ordering); canonical QA bootstrap documented
above restores them on a fresh workspace. Product code untouched.

## Next concrete deliverable

Phase 3 — database & infrastructure readiness: validate the registered migration sequence
O2.1 → O3 → O4 → O5 → O6 → O7 with isolated-QA backups + restore drills and integrity
verification (PG application and any production operation remain separately authorized
gates). Then Phase 4 — the full launch-readiness audit with the P0–P3 register.
