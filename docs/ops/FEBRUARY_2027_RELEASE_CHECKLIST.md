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

### Phase 1 — Workspace and source stabilization — **COMPLETE (2026-11-20)** (item 1.7 remains an ONGOING DISCIPLINE: per-task publication + bundle backups continue through Phases 4–5)

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1.1 | Recovery investigation of original M-O7 workspace | DONE (2026-11-20, verdict **C — unrecoverable from this environment**) | All persistent sources checked read-only: live overlay workspace (stale O2-era @ `9947e73f`), PolarFS volume `/tmp/my-project` (O2-era, frozen 2026-11-17), OSS `repo.tar` (O2-era content, uploaded 2026-11-19 16:16 UTC, zero O7 markers), Nov-10 7z archives, dangling commits (Oct 24–Nov 12), Z.ai in-container state. One platform-side location (`/home/z/.zai-reserve`, root-only) uninspectable. Original uncommitted M-O7 implementation (21 paths) exists in no accessible location. |
| 1.2 | Authoritative workspace established from remote `main` | DONE | Fresh clone of `https://github.com/Ebin0471/BEAN-Folio.git` at **`93779fe75dccf6cd76ac113c255c4b1c14fdbf5`** (M-O6 published baseline, parity 96; SHA-256 transcription corrected during the Phase 3 documentation pass — the recorded value had a duplicated `5`) into `/home/z/bean-folio`. Clean tree; credential vault equipped with preserved permissions (700/600); original vault in the stale workspace untouched. |
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

### Phase 3 — Database and infrastructure readiness — **COMPLETE (2026-11-20)**

Registered sequence O2.1 → O3 → O4 → O5 → O6 → O7 validated on disposable copies with
isolated QA, backups, restore drills, additive-migration review and integrity verification.
PostgreSQL DDL remains **REGISTERED ONLY**; production migrations, deployment and any
production database operation remain separately authorized gates.

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 3.1 | Environment verification + workspace re-establishment | DONE | Independent `git ls-remote` == expected `3d86f87d7de0e0bcd2a58900918f0c7e804db0c1`; local HEAD identical (main, clean); `/home/z/my-project` preserved untouched @ `9947e73f`; vault permissions restored to 700/600 in both workspaces; `bun install` 652 pkgs; parity gate `SCHEMA PARITY OK — 100 models`. |
| 3.2 | Migration-chain inventory | DONE | All 6 registrations read (O2.1, O3, O4, O5, O6, O7); all 12 SQL artifacts' SHA-256 match the registered values exactly (sizes match too); all 12 byte-for-byte reproducible from the published lineage schemas (`prisma migrate diff` from each registered baseline commit); destructive screen: zero matches on O3–O7, exactly the 2 registered O2.1 lines (SQLite rebuild `DROP TABLE` + PG widening `ALTER COLUMN`). Baseline chain: `26c18d60 → e073faa0 → 9d5e57f2 → a4d463bd → cba7b57c → 1c0d501b → 3d86f87`. |
| 3.3 | Full chain rehearsal on disposable copy | DONE | Baseline established from the published O2 schema (`26c18d60`, 90 tables) via `prisma db push`; preservation fixtures seeded (4 users, org, membership, 2 candidate profiles incl. salary values, skill); exact registered SQL applied per stage in single transactions with FK enforcement on. After EVERY stage: `PRAGMA integrity_check` ok, `foreign_key_check` 0 rows, intermediate `migrate diff` vs that stage's published target schema EMPTY, fixture row counts + salary values preserved 1:1 (O2.1 rebuild copies all rows verbatim). Table counts 90 → 90 → 92 → 93 → 94 → 96 → 100. Final diff vs approved `prisma/schema.prisma`: **EMPTY (parity 100)**. `bun run db:push` → "The database is already in sync with the Prisma schema." |
| 3.4 | O7 constraint + FK behavior verification | DONE | RD-1: second HiringRoom for the same invitation refused at the database level (`UNIQUE constraint failed: HiringRoom.invitationId`); FK enforcement refuses unknown parents; RD-4: duplicate (roomId,userId) member refused; unassigned (NULL-user) member rows allowed, NULLs distinct; O6 one-ACTIVE-invitation-per-(org, opportunity, candidate) enforced, terminal (NULL-token) rows coexist; humans FK `ON DELETE SET NULL` (member row preserved, userId nulled), owning aggregates CASCADE (room→members/stages/interviews; invitation→room). |
| 3.5 | Double-application refusal | DONE | O3–O7 re-applied to throwaway copies: all refused loudly (`table "X" already exists`), copies unchanged (tablesBefore == tablesAfter). Notable property: the O2.1 SQLite rebuild artifact is replayable-by-construction (the RedefineTables plan re-converges with no error and no data change) — the operational never-double-apply rule is unchanged. |
| 3.6 | QA database (canonical, guard-sanctioned path) | DONE, with recorded limitation | **Limitation:** the Phase 2 QA database file did not survive the 2026-11-20 container recycle (`db/` is gitignored; no copy of the 100-table QA file exists in this container — verified by filesystem survey). It was rebuilt at `db/custom.db` via the same verified chain replay behind `scripts/ops/qa-db-env.sh assert --must-exist`: 100 tables, integrity ok, FK 0, `HiringRoom_invitationId_key` + `HiringRoomMember_roomId_userId_key` unique indexes present, RD-15 `Interview.meetingLink` present, O1–O7 structural invariants all PASS. The prior QA DB's fixture rows (1026 users / 516 invitations, canonical demo accounts) are **not reproducible here**; canonical QA fixture re-bootstrap is a Phase 4 prerequisite. The original file cannot be verified because it is absent — reported, not fabricated. |
| 3.7 | Backup + restore drill | DONE | `scripts/ops/backup-db.ts` → `db-2026-11-20T15-15-27-000Z.sqlite3` (1,622,016 bytes, sha256 `f5e28b0c61d56036f5ab89c2f5f126ff1e55d8390958d07630bcddc240a9cd13`, 100 tables, integrity ok, row parity verified, `beanfolio-backup-manifest/v1` sidecar); `restore-db.ts --from … --to` a separate disposable target (script confirms "Rehearsal only — the live database was NOT touched"); independent verification of the restored copy: identical table set (100/100), identical per-table row counts, integrity ok, FK 0. Original QA database untouched throughout (same bytes/mtime, integrity re-check ok). |
| 3.8 | PostgreSQL boundary (REGISTERED ONLY) | DONE (structural validation only) | All 6 PG artifacts hashed against registered SHA-256 values; structural statement screens: O3–O7 purely additive (O7 = 4 CREATE TABLE + 2 CREATE UNIQUE INDEX + 9 CREATE INDEX + 14 ADD CONSTRAINT FK; human FKs `SET NULL`, owning aggregates `CASCADE`), O2.1 = the single registered widening statement. **No PostgreSQL connection was made, no DDL executed, no deployment performed.** |

**Phase 3 environment incident record:** the sandbox container was recycled again before
Phase 3 execution; `/home/z/bean-folio` and the Phase 2 QA database did not persist while
the remote `main` remained intact at the expected SHA. Recovery per the launch mandate:
fresh clone from the verified remote (no force, no history rewrite), stale workspace still
preserved, QA database rebuilt from the registered chain. Guard fail-closed behavior
re-demonstrated live: refuses a foreign `/tmp` target, the inherited legacy-workspace URL,
an unset URL, and a missing QA file (`--must-exist`) — all exit 1 with refusal reasons.

**Registration prose correction (evidence-supported):** `O7_MIGRATION_REGISTRATION.md` §1
stated "1 unique + 10 secondary indexes" and "4 CREATE TABLE, 10 CREATE INDEX, 1 CREATE
UNIQUE INDEX"; the exact artifact statement count is **2 CREATE UNIQUE INDEX + 9 CREATE
INDEX** (both unique indexes were already correctly named in the same doc; the DDL totals
are unchanged: 11 indexes + 4 tables per dialect). Corrected in this commit.

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
| P3 | Post-launch enhancement | 2 known |

The two P3 entries are the test-infrastructure findings in the known-baseline register
below (queue-timing flake classification + `auth.test` accumulated-DB invariants, both
classified 2026-11-20 during Phase 1); product code is untouched by both. The P0/P1/P2
counts remain 0 known.

Known baseline defects carried from the O6-era audit record (not new findings): none open —
M22 blockers were resolved before O1 (protocol §6 re-baseline: tsc 0, full suite green).

### Phase 5 — Beta and public launch — **NOT STARTED**

Controlled private beta → real user feedback → critical-defect resolution → feature freeze →
public launch in February 2027.

---

## Progress log (newest first)

| Date (UTC) | Entry |
|-----------|-------|
| 2026-11-20 | **Phase 3 (database & infrastructure readiness) complete**: workspace re-cloned from the verified remote main `3d86f87` after another container recycle (stale workspace preserved, no history rewrite); chain inventory 12/12 artifacts SHA-verified and 12/12 byte-for-byte reproducible; full O2.1→O7 rehearsal on a disposable copy (every stage integrity ok, FK 0, empty intermediate diff, fixtures preserved; tables 90→100); RD-1/RD-4/O6 DB-level invariants + FK SET NULL/CASCADE behaviors verified; double-apply refusals demonstrated (O2.1 noted replayable-by-construction); canonical QA DB rebuilt behind the fail-closed guard (100 tables, parity 100, db-push in-sync) — original Phase 2 QA file + fixtures not reproducible after the recycle, recorded as a Phase 4 prerequisite; verified backup (sha256 `f5e28b0c…`) + restore drill to a disposable target (100-table parity, original untouched); PG artifacts structurally screened, never executed. Documentation-only commit: checklist + O7 registration prose counts; zero product code changes. |
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

Phase 4 — the complete launch-readiness audit with the P0–P3 register. Prerequisite noted
from Phase 3: canonical QA fixture re-bootstrap (the rebuilt QA database is at schema
parity 100 with zero fixture rows — Phase 4 journey tests need the canonical demo accounts
restored first). Then Phase 5 — controlled private beta and the February 2027 public
launch. PostgreSQL application, any production database operation and deployment remain
separately authorized gates.
