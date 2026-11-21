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

### Phase 4 — Complete launch-readiness audit — **COMPLETE (2026-11-20)**

Canonical QA fixture re-bootstrap, a 97-check live-HTTP journey audit across ten
journeys, a browser audit (desktop + mobile), a security/operational probe pass,
and one P1 fix (found → fixed → re-verified live). PostgreSQL DDL remains
**REGISTERED ONLY**; production migrations, deployment and any production
database operation remain separately authorized gates.

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 4.1 | Preflight + environment | DONE | `git ls-remote` == local HEAD == `a6db165aa857dbd13eb8de2e4158287b35677f8d` (clean main); `/home/z/my-project` preserved untouched @ `9947e73f`; fail-closed guard re-validated live (correct OK + refusal behaviors); a stale auto-started dev server serving the LEGACY workspace on :3000 was found and replaced with the authoritative workspace server (pinned `DATABASE_URL`, upload sentinel 401, ensure-dev green). |
| 4.2 | Canonical QA fixture re-bootstrap | DONE | Pre-change backups verified (`ec275bed…` empty-schema, `5bffac42…` pre-reset); documented seeders run in order (professions 221, seed.ts 8 demo users/14 projects, 10 canonical QA accounts, social E2E, admin promotion); NEW committed bootstrap `scripts/seed-ox-journeys.ts` drives the real HTTP APIs end-to-end (register → org → verification → admin review → opportunity → shortlist → invitations); clean deterministic dataset verified (5 OX profiles, 4 orgs, 3 opportunities, 2 SENT invitations, integrity ok, FK 0); manifest documented in `docs/ops/PHASE4_FIXTURE_MANIFEST.md`. The lost 1,026-user historical dataset was NOT recreated (per owner directive). |
| 4.3 | Eleven journey audits | DONE | J1–J10 via live HTTP + DB verification (`scripts/qa-journeys.ts`): **97/97 checks green in a single pass** (J1 11, J2 7, J3 10, J4 9, J5 11, J6 6, J7 7, J8 16, J9 11, J10 9), repeatable (self-provisioning journeys). J11 responsive browser audit: desktop 1440×900 + mobile 390×844 (home, onboarding, OX candidate + employer surfaces, profile, empty states, score-transparency expander, bottom nav), zero console/page errors, keyboard focus visible, sticky footer verified. |
| 4.4 | Security & operational audit | DONE | Regression suites: security-hardening 8/8, auth+auth-routes 20/20, media-upload(+http 9/9 when server up)+route 4/4, ox authz/room routes 45/45, social-network 30/30. Live probes: session cookie HttpOnly+SameSite=lax; anonymous upload 401; text-pose-as-png honestly classified (content sniffing); admin surface 403; media raw object-authz (anon 403 / owner 200); generic error bodies; rate limits observed firing (register 10/min); timings: APIs 11–76 ms, home DCL 677 ms. Known pre-existing deferrals stand (CSP Tier-C M-1, per-process rate-limit backend HP-3). No security certification or external penetration test claimed. |
| 4.5 | Findings register | DONE | **P1-1 (FIXED):** `POST /api/me/messages/[id]` did not enforce the documented message-request consent gate (unlimited sends to a PENDING recipient; sends into a DECLINED thread). Minimal fix (19 lines, route-only): opening message = the request; further sends refused 409 `DM_REQUEST_PENDING` until approval; DECLINED threads closed. Verified live via J9 and pinned contract preserved (social-network 30/30). **P3 (recorded, post-launch):** pseudonymous match-card labels show truncated ids (privacy-correct); focus outline visible but subtle; known-baseline test-infra items unchanged. **P0/P2: none found.** |
| 4.6 | Verification gates | DONE | `bunx tsc --noEmit` → **0 errors**; `bun run lint` → **0 errors / 13 warnings** (baseline); full regression suite (90 files, batched sequential) → **0 failures** (queue-reliability timing flake did not recur; 2 live-HTTP suites 13/13 with server up); `bunx next build` → **exit 0** (pre-existing instrumentation warnings only); `check-schema-parity.ts` → **parity 100/100**; QA DB `integrity_check` ok, `foreign_key_check` 0; secret scan clean (documented fixture passwords only); runtime-data scan clean (db/uploads/.env git-ignored). |

**Phase 4 environment incident record:** the sandbox dev server was OOM-killed twice
by concurrent heavy test batches (3 GB sandbox RAM); recovered each time via the
pinned-URL launcher, and the full suite was executed file-batched sequentially. The
stale-workspace auto-start server incident (4.1) was contained with zero writes to
the legacy workspace.

| Severity | Meaning | Count |
|----------|---------|-------|
| P0 | Critical security / data-loss / launch-blocking | 0 known |
| P1 | Core user journey broken or materially unreliable | 0 open (P1-1 fixed and re-verified this phase) |
| P2 | Important, safely includable pre-launch | 0 known |
| P3 | Post-launch enhancement | 4 known |

The four P3 entries: (1) match-card pseudonym label polish (truncated ids, privacy-correct);
(2) keyboard focus outline visible but could be higher-contrast; (3)+(4) the two known-baseline
test-infrastructure classifications from Phase 1 (queue-timing flake + auth.test accumulated-DB
invariants). The M22-era CSP (M-1) and rate-limit backend (HP-3) deferrals remain documented
Tier-C follow-ups in the protocol register.

### Phase 5 — Controlled beta preparation — **COMPLETE (2026-11-21)**

Beta preparation only: release candidate established and re-verified in a fresh
workspace; the private-beta plan, operational-readiness audit, additional launch
assurance, prepare-only PostgreSQL/deployment prerequisites and the release-candidate
checklist were produced and published. **No beta invitations, no external
communications, no PostgreSQL migration, no deployment.** Gates A (PostgreSQL),
B (deployment) and C (public launch) remain separately owner-authorized.

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 5.1 | Workspace + release candidate established | DONE | Workspace had been recycled; fresh clone of authoritative remote `main` verified `git ls-remote` == local HEAD == **`e52786e44e7d6993ed02403f5f4edcd4e70cf43e`** (clean main); `/home/z/my-project` preserved untouched; QA DB rebuilt via guard-sanctioned path (100 tables, integrity ok, FK 0); fixture manifest seeders re-run in order, post-bootstrap counts == Phase 4 manifest §4 exactly. |
| 5.2 | Phase 4 evidence + P0/P1 verification | DONE | Phase 4 completion evidence read from this checklist; the single P1 (P1-1 messaging consent gate) is in the published fix commit `e52786e`; **97/97 journey checks re-run green in a single pass** in this workspace (J1 11, J2 7, J3 10, J4 9, J5 11, J6 6, J7 7, J8 16, J9 11, J10 9); remaining P2/P3 recorded (4 P3 + M-1/HP-3/M-7 deferrals → `PHASE5_LAUNCH_ASSURANCE.md` §8 register). |
| 5.3 | Core functionality real, not placeholder | DONE | The 97-check live-HTTP auditor (`scripts/qa-journeys.ts`) drives real APIs and verifies real DB state; browser spot checks this phase (desktop 1440×900 + mobile 390×844: home, auth, onboarding end-to-end, OX employer+candidate panels with live consent data) — zero console/page errors; design system preserved. |
| 5.4 | Private beta plan | DONE | `docs/ops/PHASE5_BETA_PLAN.md` — manual white-glove onboarding (candidates + employers incl. verification), owner-side invitation/access management, cohort recommendation **10 candidates + 4 employers (2 verified orgs)** with funnel-density rationale, feedback collection, bug triage + support SLO, incident escalation ladder, deletion/privacy handling, success metrics, expansion criteria; explicit non-goals (no room chat/document-sharing/M-O8, no invitations without owner approval). |
| 5.5 | Operational readiness audit | DONE | `docs/ops/PHASE5_OPERATIONAL_READINESS.md` — health/ready verified live (queue counters, DB reachable), error visibility (reportError → structured logs + optional webhook; error boundaries present), backup/restore tooling + drills, session cookie flags, durable queue + notification delivery, upload transports + authz ladder, rate limiter observed FIRING, rollback levers, admin controls; honest gap register G-1…G-8 (G-1/G-2/G-8 = operator actions; zero-cost tooling only). |
| 5.6 | Additional launch assurance | DONE | `docs/ops/PHASE5_LAUNCH_ASSURANCE.md` — a11y (semantic landmarks, keyboard flows, real a11y tree checks; no AT session claimed), cross-tenant suites green, session/account security (rate limiter firing live), upload/download ladder, privacy/data-exposure, production build exit 0, mobile 390×844 checks; consolidated unresolved-risk register R-1…R-11 (P0 none, P1 none open, P2 none on product surfaces, P3 eleven recorded) + explicit non-claims (no pentest, no certification). |
| 5.7 | PostgreSQL/deployment prerequisites (prepare only) | DONE | `docs/ops/PHASE5_POSTGRES_DEPLOYMENT_PREREQUISITES.md` — Gate A (O2.1→O7 execution order with all 12 registered artifact SHA-256s, O2.1 destructive-adjacent §4 approval checklist, backup/restore evidence requirements, production verification commands), Gate B (deployment + rollback procedure, pre/post checks), Gate C (launch), boundary statement: nothing executed, nothing authorized. |
| 5.8 | Release-candidate checklist | DONE | `docs/ops/PHASE5_RELEASE_CANDIDATE_CHECKLIST.md` — functional/UX/security/data/performance/monitoring/support/limitations verified item-by-item; beta entry criteria (operator actions pending: deployment approval, backup drill, uptime poll, cohort list), beta exit criteria, February-2027 go/no-go criteria; feature freeze rule stated. |
| 5.9 | Verification gates (this phase) | DONE | `bunx tsc --noEmit` → **0 errors**; `bun run lint` → **0 errors / 13 warnings** (baseline); full regression suite (90 files, sequential, pinned QA URL) → **1371 tests, 0 failures** (timing flake did not recur); `bunx next build` → **exit 0**; parity 100/100; QA DB integrity ok / FK 0; secret + runtime-data scans run at publish (bean-sync built-in). |

**Phase 5 environment incident record (contained, resolved):** the first full-suite
execution in the fresh workspace was launched WITHOUT an inline-pinned `DATABASE_URL`;
the inherited legacy URL (`file:/home/z/my-project/db/custom.db`) was picked up by
direct-DB test suites, which created fixture rows in the LEGACY workspace database.
Containment the same hour: read-only inspection proved the legacy DB was already
**data-empty in this container instance** (oldest of its 354 user rows was created
during the incident run itself — the historical content did not survive the container
recycle, consistent with the Phase 3 finding), `PRAGMA integrity_check` = ok,
**zero pre-existing rows modified (none existed)**; fixture rows deliberately LEFT in
place per the never-modify-legacy policy; no write reached any other protected target
(all live-HTTP suites wrote through the pinned QA server). The full suite was
re-executed with the pinned URL: 90 files, 0 failures. Standing rule re-affirmed with
renewed force: **every command that can touch a database — including `bun test` —
must pin `DATABASE_URL` inline.**

---

## Progress log (newest first)

| Date (UTC) | Entry |
|-----------|-------|
| 2026-11-22 | **Deployment provider assessment complete (recommendation only)**: source-verified DigitalOcean compatibility at `1c5f785` — App Platform BLR: Available, Managed PostgreSQL BLR1: Available (incl. PG 16 Standard), Spaces Standard Storage BLR1: Available (official availability matrix + product pages, fetched 2026-11-22); verdict COMPATIBLE with the documented single-instance topology, zero product changes required (Dockerfile/standalone/prisma-postgres mirror/presigned S3 driver/startup validation already committed and reviewed); new doc `docs/ops/PHASE5_PROVIDER_SELECTION.md` (evidence matrix C1–C20, app-spec deltas, exact env names incl. `S3_REGION=us-east-1` per DO SDK reference, Spaces bucket CORS step required for browser direct PUTs, health checks /api/ready + /api/health, rollback = 10 most recent deployments, PITR 7 days, costs: beta ≈ $70/mo CONFIRMED list prices; launch HA ≈ $167–172 (grandfathered Standard) or ≈ $367–371 (Advanced) — **material plan-change finding: new Standard PG clusters lose standby/read-only nodes from 30 Nov 2026 (15 Oct for never-created accounts), so the HA path is a time-sensitive owner decision**; U-1…U-7 deploy-time verification list + R-P1…R-P8 risk register; D-1…D-11 owner decisions). **No DigitalOcean resource created, no billing started, no domain touched, no secrets requested, no DB connection, no DDL, no migration, no deployment, no DNS change.** Gates A/B/C untouched. Documentation-only commit; zero product code changes. |
| 2026-11-21 | **Phase 5 (controlled beta preparation) complete**: workspace recycled again → fresh clone verified at `e52786e` (remote == local, stale workspace preserved); QA DB rebuilt guard-sanctioned (100 tables, integrity ok, FK 0), manifest seeders re-run (post-bootstrap counts == Phase 4 manifest exactly); Phase 4 evidence re-verified live — **97/97 journey checks green in a single pass**, gates green (tsc 0, lint 0e/13w, full suite 90 files/1371 tests/0 failures with pinned URL, build exit 0, parity 100/100); browser spot checks desktop+mobile zero errors; P0/P1: none open (P1-1 fix re-verified in J9); five Phase 5 docs produced (beta plan with 10-candidate + 4-employer cohort recommendation, operational readiness G-1…G-8, launch assurance R-1…R-11, prepare-only PostgreSQL/deployment gates A/B/C, RC checklist entry/exit/go-no-go). Incident contained: one un-pinned suite run created fixture rows in the legacy DB — proven read-only to be already data-empty pre-incident, integrity ok, zero pre-existing rows modified, rows left in place; pin-everywhere rule re-affirmed. No invitations, no PostgreSQL, no deployment. Documentation-only commit; zero product code changes. |
| 2026-11-20 | **Phase 4 (launch-readiness audit) complete**: canonical QA fixture re-bootstrap through real APIs (manifest committed); 97/97 live-HTTP journey checks green (J1–J10, repeatable) + J11 browser audit desktop/mobile with zero console errors; security/ops probe pass clean; one P1 found & fixed (message-request consent gate unenforced server-side → opening-message-only pre-approval, 409 `DM_REQUEST_PENDING`; verified live + 30/30 pinned suite); P3 register: 4 known, no P0/P2; gates: tsc 0, lint 0e/13w baseline, full suite 0 failures, production build exit 0, parity 100/100, integrity ok FK 0, scans clean. Fixture infra committed (`seed-ox-journeys.ts`, `qa-journeys.ts`, manifest doc). |
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

Phase 5 preparation is COMPLETE and the deployment provider assessment is published
(`PHASE5_PROVIDER_SELECTION.md`: DigitalOcean BLR/BLR1 recommended, compatibility
verified source- and provider-doc-level, no resource provisioned). The next deliverables
are **owner-decision gates**, not agent work: (1) approve the beta plan + cohort-1 list,
(2) make the provider decisions D-1…D-5 of `PHASE5_PROVIDER_SELECTION.md` (plan, PG HA
path — time-sensitive per the 30 Nov 2026 Standard-Edition restriction — origin/URL),
(3) authorize Gate B deployment environment (then the operator backup drill + uptime
poll per the RC entry criteria), (4) optionally schedule Gate A (PostgreSQL O2.1→O7)
before or after beta per `PHASE5_POSTGRES_DEPLOYMENT_PREREQUISITES.md`. Beta execution
(inviting participants) starts ONLY on a separate explicit owner instruction — no
invitations, no external communications and no launch announcements are authorized by
this phase.
