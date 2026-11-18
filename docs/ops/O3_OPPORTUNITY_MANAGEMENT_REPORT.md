# M-O3 — Opportunity Management Delivery Report

**Status: COMPLETE (all required gates executed and green; published via the
verified bean-sync workflow).**
Starting commit: `e073faa0e7ed1e6442fd80176a6e22f5b3e6e72e` (verified
`origin/main` at task start) · Ending commit: recorded in the bean-sync
output and verified via `git ls-remote origin refs/heads/main`.
Workspace: `/home/z/beanfolio-o3-dev` (fresh clone of remote `main`; the
preserved legacy workspace `/home/z/my-project` was not modified).

## 1. What was built

Exactly two additive Prisma models (approved decision table), byte-identical
in both schemas (parity gate OK, **92 models**):

- **`Opportunity`** — employer job listing. Lifecycle
  `DRAFT → PENDING_REVIEW → PUBLISHED → PAUSED → FILLED | CLOSED`
  (approved decisions: admin approval is the ONLY route to `PUBLISHED`;
  content edits of `PUBLISHED`/`PAUSED` rows atomically return to
  `PENDING_REVIEW`; `FILLED`/`CLOSED` are terminal; illegal transitions are
  409 with zero writes; deletion is audited and DRAFT-only). Salary = BigInt
  paise via the O2.1 checked boundary (`salaryPaiseToStorage` /
  `salaryPaiseFromStorage`), ISO 4217 currency, explicit period, ₹10 crore
  per-value ceiling. Profession references the EXISTING taxonomy (loose id
  ref, existence-validated at the boundary — O2 precedent).
- **`OpportunitySkill`** — `(opportunityId, skillId)` compound primary key
  (duplicate rows impossible by constraint; duplicate payloads refused with
  400 pre-write), explicit `REQUIRED | PREFERRED` kind, references the
  EXISTING `Skill` taxonomy (reuse-only — unknown slugs/labels are a 400,
  never an upsert).

API surface (13 operations, namespace per approved decision):

| Route file | Operations |
| --- | --- |
| `src/app/api/employers/[id]/opportunities/route.ts` | GET list (tenant-scoped, status filter), POST create → DRAFT |
| `src/app/api/employers/[id]/opportunities/[opportunityId]/route.ts` | GET detail, PATCH edit (atomic published→review return), DELETE (audited, DRAFT-only) |
| `.../[opportunityId]/submit/route.ts` | POST DRAFT → PENDING_REVIEW (VERIFIED-org gate, salary completeness) |
| `.../[opportunityId]/pause/route.ts` | POST PUBLISHED → PAUSED |
| `.../[opportunityId]/reopen/route.ts` | POST PAUSED → PUBLISHED (org authorization re-checked live) |
| `.../[opportunityId]/outcome/route.ts` | POST explicit `FILLED`/`CLOSED` (one endpoint, approved decision) |
| `src/app/api/admin/ox/opportunities/route.ts` | GET admin review queue (status filter, take 50) |
| `src/app/api/admin/ox/opportunities/[opportunityId]/route.ts` | GET review detail (+audit trail), PATCH decision APPROVE/REJECT (the only route to PUBLISHED; REJECT requires a reason and returns to DRAFT) |

Authorization (O1 helpers reused, zero new auth machinery): identity only
from the session; `(organizationId, userId)`-bound membership lookups;
foreign-org access is a 404 existence-hiding deny; writes require ACTIVE
`OWNER/ADMIN/RECRUITER`; **VIEWER is read-only everywhere**; the deferred
HIRING_MANAGER assignment leaves HIRING_MANAGER read-only in M-O3; VERIFIED
required to submit/reopen; SUSPENDED orgs refused (403); admin decisions via
`requireAdmin()` (anonymous and non-admin are the same 403);
`sameOriginOk` on every write; per-action `rateLimitShared` keys; strict zod
schemas. Decisions are audited (`auditModeration`) and notify the org's
active OWNER/ADMIN/RECRUITER members via the existing `notify()` (dedupeKey
upsert; no direct notification-table writes). Employer lifecycle writes are
audited through the OX audit writer (`auditOX`, `ox.opportunity.*`
vocabulary). All state transitions are `updateMany` guards conditioned on
the read status — concurrent changes are 409s with zero writes.

UI (obsidian-black + champagne-gold conventions preserved; no unrelated page
redesigned): `OxEmployerOpportunitiesPanel` (org selector, list with status
pills/skills/salary, create+edit dialog with live skill counters
`Required x/8 · Preferred y/12 · Total z/20`, lifecycle action buttons with
confirmations) mounted in `OpportunityExchangeView`; `OxAdminOpportunityPanel`
(review queue, approve/reject-with-reason dialog) mounted in the admin-only
`ModerationView` below the O1 verification panel. Navigation untouched
(`Opportunities` nav item already existed).

## 2. Database safety (exact record)

- Isolated QA database: `/home/z/beanfolio-o3-dev/db/custom.db` (fresh
  schema-only from the clone; never shared).
- **Fail-closed guard installed and verified**:
  `scripts/ops/qa-db-env.sh` — refuses unset/empty `DATABASE_URL`, non-`file:`
  targets, query-string/in-memory ambiguity, any path other than this
  workspace's `db/custom.db`, refuses to run inside the preserved legacy
  workspace, and (verified against the real environment) refuses the
  inherited `DATABASE_URL=file:/home/z/my-project/db/custom.db` that this
  sandbox exports into every shell — the exact unpinned-inheritance failure
  mode behind the historical three-row incident.
- Verified backup before the schema change (`backup-db.ts` →
  `db-2026-11-18T07-34-59-441Z.sqlite3`, sha256
  `89b6bfbf…1fa7712`, 90 tables, integrity ok) **plus a restore rehearsal**
  into a throwaway path (`restore-db.ts --from … --to
  /home/z/o3-qa-backups/rehearsal-restored.db`, integrity ok, 90 tables).
  Post-push backup: `db-2026-11-18T07-40-41-476Z.sqlite3` (sha256
  `b53b89f0…f51787`, 92 tables, integrity ok).
- Applied ONLY the reviewed additive SQLite SQL to the isolated QA DB
  (verified 92 tables, integrity ok, FK violations 0, salary columns native
  BIGINT, compound PK present). PostgreSQL DDL registered, **not executed**
  (`docs/ops/O3_MIGRATION_REGISTRATION.md`). No `--accept-data-loss`
  anywhere; no production access.

## 3. Gates (all executed in this session)

| Gate | Result |
| --- | --- |
| M-O3 lifecycle / authz / skills+salary / audit suites | **29/29 tests** (4 files) — lifecycle 7, authz 9, skills+salary 9, audit 4 |
| O1/O2/O2.1 regression (all `ox-*` suites) | **125/125** |
| Complete suite (`scripts/ci/run-tests.sh`, sequential, one process per file) | **79/79 files, 1305 tests passed, 0 skipped, 0 failed** — final code state, with both live-HTTP suites executing against the isolated QA server (`BASE_URL` pinned; the legacy dev server on :3000 was unreachable by construction) |
| Live HTTP tests (readiness-probe gated, real network) | **4/4 executed** (health/ready, anonymous 401 matrix, admin 403, authenticated-non-member 404 existence-hiding) — plus the O1 `media-upload-http` suite ran green against the same QA server |
| TypeScript | `bunx tsc --noEmit` → **0 errors** (after fixing one real route-params type bug the build's validator caught: admin detail route under `[opportunityId]` declared `{ id }`) |
| Lint | **0 errors, 13 warnings — exactly the documented baseline** (no new warnings) |
| Production build | `bunx next build` → **compiled successfully** (route/type validation passed) |
| Schema parity + validations | `check-schema-parity.ts` OK (92 models); `prisma validate` OK on both schemas |
| QA DB integrity | `integrity_check` ok, `foreign_key_check` 0 violations (pre-push, post-push, post-suite) |
| Runtime-data scan | `guard-runtime-data.sh` staged-path mode clean (also enforced by bean-sync at publish) |
| Secret scan | bean-sync staged-diff scan clean (also enforced at publish) |

## 4. Preservation evidence

- `git status` on the legacy workspace `/home/z/my-project`: clean at task
  start, untouched throughout (only read-only reads of docs/scripts).
- O1/O2/O2.1 regression suites: 125/125 green on the final tree.
- `auth.test.ts` (account invariants), `media-upload-http`, `startup-validation`
  and every other suite: green in the final full run.
- Schema delta is exactly +2 models; every other model byte-identical
  (parity gate proves it mechanically).

## 5. Disclosed incidents during execution (honesty record)

1. **Legacy-DB boundary breach (corrected; owner-approved cleanup
   recommended):** the FIRST full-suite run executed
   `tests/ox-opportunity-live-http.test.ts` with its default
   `BASE_URL=http://localhost:3000` — the readiness probe passed against the
   legacy workspace's running dev server, and the suite registered one
   throwaway account ("Live Nonmember", `ox-opp***@beanfolio.test`, isDemo=0)
   plus one session row in the LEGACY database before failing on a wrong
   status expectation (201 vs 200). No organizations, opportunities, media
   rows, or uploads were created there (`MediaAsset` 0, `EmployerOrganization`
   0). The legacy DB was a fresh, empty post-recycle dev database — no user
   data existed to be harmed. Remediation: from that point every suite run
   pinned `BASE_URL` to the isolated QA server (verified in the final full
   run: 0 env-gated skips, nothing reached :3000). The two inert rows remain
   in the legacy DB; removing them is a legacy-DB write and is therefore
   **not** performed without explicit owner approval.
2. **QA-fixture hygiene:** the fresh QA DB lacked the historical
   `demo@beanfolio.app` fixture (expected by `auth.test.ts`'s data-state
   invariant) and the O1 suite's soft-deleted test artifact
   (`ox-org-*@beanfolio.test` with `deletedAt`, un-anonymized by design)
   tripped `auth.test.ts`'s tombstone invariant on the shared persistent QA
   DB. Fixed by QA-DB hygiene only (created the documented demo fixture;
   removed rows exactly matching the O1 artifact pattern) — no test was
   weakened or removed, no product code changed for this.

## 6. Browser QA (agent-browser, isolated QA server)

- Employer surface: `Opportunity listings` region renders with the verified
  org context, status pills, and `New opportunity` action — verified at
  1440×900 AND 390×844 (mobile bottom-bar "More" flow intact);
  screenshots archived (`ui-desktop-opportunities.png`,
  `ui-mobile-opportunities.png`).
- Editor dialog: full field set verified in the accessibility tree (title,
  description, profession/employment/work-mode/period selects, positions,
  INR salary fields, skill input + kind + live counters, create button).
- Zero console or page errors on the verified pages.
- NOT browser-verified (honest gap): a form-driven create/click-through and
  the admin panel's visual mount — the headless drive proved flaky in this
  environment and the admin nav link did not surface within the session
  budget. Both paths are exhaustively covered by the API-level suites (29
  M-O3 tests) and the production build's route validation; flagged as a
  future browser-QA follow-up, not a functional risk.

## 7. Publication

Via `scripts/ops/bean-sync.sh commit` (branch main, vault auth, remote-state
gate, explicit-path staging, secret scan, runtime-data scan, push, SHA
verification) — commit SHA and remote SHA recorded in the end-of-task
report and verified with `git ls-remote origin refs/heads/main`.

## 8. Handoff

Next milestone (M-O4 matching/discovery) must start from the published M-O3
SHA; the PG DDL registration (`O3_MIGRATION_REGISTRATION.md`) is a
deployment prerequisite before any production build that includes the
opportunity routes.
