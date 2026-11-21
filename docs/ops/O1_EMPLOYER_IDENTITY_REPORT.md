# BEAN FOLIO — O1 — OPPORTUNITY EXCHANGE — EMPLOYER IDENTITY & VERIFICATION

**Milestone:** O1 — Employer identity, memberships/roles, verification, tenant
authorization, employer onboarding UI, dedicated Opportunity Exchange
navigation pillar.
**Status:** COMPLETE — every owner-directed gate executed green; O2 not
started (gated on this report's accuracy).
**Specification source:** `docs/ops/O0_OPPORTUNITY_EXCHANGE_AUDIT.md` §10
(owner-approved 2026-11-16) + the owner's O1 directive (same day), which
extends O0 §10.3 by requiring controlled ownership transfer with
re-authentication (resolving O0 §11 D7 in O1's favor).

---

## 1. Commit SHAs

| Point | SHA |
| --- | --- |
| Baseline (start) | `4f8798c20f7cf65df6dd7d549295d4aca25108cf` (== origin/main at start) |
| Schema commit | `b7fc00b` (cherry-picked; original `4f4a066` made on the feature branch before the environment checkpoint moved HEAD — see §9) |
| Backend commit | `380e9ce` |
| UI commit | `00cefea` |
| Test commit | `f874490` |
| Report commit | this document's own commit (created by bean-sync; a commit cannot contain its own SHA — recorded in §10's addendum) |
| **Published tip** | see §10 (verified against `origin/main` after push) |

Branch note: the owner-approved feature branch
`feat/ox-o1-employer-identity` exists and is **synced to the exact published
lineage** (`update-ref` to the same tip), so the merge path is a verified
fast-forward (identical trees). The environment's auto-checkpoint repeatedly
moved HEAD back to `main` during the milestone (§9); the work therefore
committed on `main` directly, which is also the only branch bean-sync
publishes.

## 2. Complete file inventory

**Modified (6):**
- `prisma/schema.prisma` — 3 new models + 3 `User` back-references (additive)
- `prisma/schema.postgres.prisma` — byte-identical additions (mirror parity)
- `docs/ops/MIGRATIONS.md` — model-count correction 45→88 (O0 §3 stale-doc note)
- `.gitignore` — `/db/backups/` added (runtime-data hygiene)
- `src/components/bean/SiteShell.tsx` — Opportunity Exchange nav pillar (desktop + mobile More sheet), router case, private-route label
- `src/views/ModerationView.tsx` — additive admin verification panel mount (`isAdmin`-gated; reports queue untouched)

**Added (20):**
- `src/lib/ox/authz.ts` — tenant-bound membership/role helpers, 404-deny contract
- `src/lib/ox/audit.ts` — the ONE OX audit writer (action vocabulary constants)
- `src/lib/ox/validation.ts` — shared zod vocabularies + slug rules
- `src/lib/ox/dto.ts` — serializer allowlists (org/member/verification)
- `src/app/api/employers/route.ts` — POST create (org + OWNER membership in ONE transaction)
- `src/app/api/employers/me/route.ts` — GET own memberships
- `src/app/api/employers/[id]/route.ts` — PATCH org profile (OWNER/ADMIN)
- `src/app/api/employers/[id]/members/route.ts` — GET list (OWNER/ADMIN) + POST invite (duplicate-proof, REMOVED-reactivating)
- `src/app/api/employers/[id]/members/[memberId]/route.ts` — PATCH role/status (manager + self-service paths, last-owner invariant)
- `src/app/api/employers/[id]/verification/route.ts` — POST submit (state machine)
- `src/app/api/employers/[id]/transfer-ownership/route.ts` — POST audited transfer with scrypt re-authentication
- `src/app/api/admin/ox/verifications/route.ts` — GET admin queue (list)
- `src/app/api/admin/ox/verifications/[id]/route.ts` — GET detail + PATCH decisions (APPROVE/REJECT/SUSPEND/REINSTATE)
- `src/views/ox/OpportunityExchangeView.tsx` — landing/dashboard (honest O2 preview)
- `src/views/ox/OxEmployerSetupView.tsx` — employer workspace (org CRUD, verification, team, transfer)
- `src/views/ox/OxAdminVerificationPanel.tsx` — manual review panel
- `tests/ox-employer-org.test.ts` (20 tests)
- `tests/ox-verification.test.ts` (8 tests)
- `tests/ox-tenant-isolation.test.ts` (4 tests)
- `tests/ox-navigation.test.ts` (11 tests)

## 3. Employer features implemented (O1 scope, exactly)

1. **Organization creation** — legal/display name, unique slug (client-proposed
   or auto-derived + uniquified; explicit-slug collision = 409), website
   (https-validated), industry, company size, headquarters, description. The
   creator's OWNER membership is created in the SAME `db.$transaction` as the
   organization row.
2. **Membership & roles** — OWNER/ADMIN/RECRUITER/HIRING_MANAGER/VIEWER ×
   ACTIVE/INVITED/SUSPENDED/REMOVED. Duplicate memberships impossible (DB
   unique (org,user) + reactivation of the same row on re-invite). Roles are
   server-enforced; client-supplied roles/statuses are never trusted (strict
   zod vocabularies). Ownership is never granted by invite or PATCH — only by
   the audited transfer flow.
3. **Ownership transfer** — ACTIVE-OWNER-only (404-deny otherwise),
   scrypt/timing-safe password re-authentication on every transfer, target
   must be an ACTIVE non-owner member of the same org, atomic role swap in one
   transaction, `ox.ownership.transferred` audit event. The last ACTIVE OWNER
   cannot be demoted/suspended/removed via PATCH (transaction-checked
   invariant, 409).
4. **Verification (pilot = manual admin review, O0 D5)** — submission moves
   UNVERIFIED/REJECTED→PENDING (row + org updated in one transaction;
   PENDING/VERIFIED = 409; SUSPENDED = 403). Evidence is a SECURE REFERENCE
   ONLY (≤256 chars; no upload path exists — raw documents are structurally
   impossible). Admin decisions: APPROVE (row VERIFIED + org
   VERIFIED/method/verifiedAt), REJECT (reason REQUIRED; org REJECTED;
   resubmission allowed), SUSPEND (org-level moderation), REINSTATE
   (SUSPENDED→UNVERIFIED). Decided rows are terminal (409). Every decision is
   audit-recorded (`auditModeration` + OX actions). Admin UI lives in the
   existing Trust & Safety view.
5. **Authorization** — existing session auth (`getSessionUser`), shared OX
   helpers (`requireOrgRole` with ACTIVE-status requirement, `countActiveOwners`
   in-transaction), tenant binding on every query, uniform 404-deny for
   foreign-org resources, 403 indistinguishable for admin surfaces,
   `sameOriginOk` on every mutation, documented rate-limit keys
   (`ox:org-create`, `ox:org-update`, `ox:member-invite`, `ox:member-update`,
   `ox:verification-submit`, `ox:ownership-transfer`, `ox:verification-review`).

## 4. Navigation changes (owner-directed)

- Desktop `NAV`: `{ href: "/opportunities", label: "Opportunities", icon: Briefcase }`
  inserted after Studio — 8 top-level destinations, all 7 pre-existing
  preserved verbatim.
- Mobile bottom bar: the 7 established one-tap destinations preserved + ONE
  new "More" entry (`grid-cols-8`). The More sheet (accessible bottom Sheet,
  sr-only title, 56px rows) lists: **Opportunity Exchange** (leads, emphasized,
  with description), My Folio, Create Studio, Saves & collections, Insights,
  Trust & settings, and Moderation review (admins only). The More entry
  highlights when the current route lives in the overflow set. No destination
  lost one-tap access; no eight-destination squeeze.
- Router: `case "opportunities"` → `RequireAuth label="Opportunity Exchange"` →
  landing view; `PRIVATE_ROUTE_LABELS.opportunities = "Opportunity Exchange"`
  (noindex). Trust & settings unchanged in the UserMenu.

## 5. Database / schema results

- Additive-only: 3 tables + 3 User relation arrays in BOTH schemas; parity
  gate `bun scripts/check-schema-parity.ts` → **"SCHEMA PARITY OK — 88 models
  identical"**; `prisma validate` → valid on BOTH schemas (postgres validated
  with a postgres-format DATABASE_URL).
- Backup before push: `scripts/backup-db.ts` →
  `db/backups/beanfolio-20261116-013311.db` (VACUUM INTO, sha256
  `06b1863…`, 85 tables).
- Isolated push verification: copy → `prisma db push` on `/tmp/o1-verify.db` →
  "in sync", no data-loss proposal; live push identical (no
  `--accept-data-loss` anywhere; the dev DB held zero user rows at the time —
  post-recycle thin state documented in Protocol §6).
- No migrations history introduced; no destructive statement of any kind.

## 6. Tests executed (actual outputs)

- **New OX suites (this session, isolated `file:/tmp/ci-db/custom.db`):**
  - `ox-employer-org.test.ts` — **20 pass, 0 fail** (79 expect calls)
  - `ox-verification.test.ts` — **8 pass, 0 fail** (46 expect calls)
  - `ox-tenant-isolation.test.ts` — **4 pass, 0 fail** (21 expect calls)
  - `ox-navigation.test.ts` — **11 pass, 0 fail** (145 expect calls)
- **Full regression suite** (`bash scripts/ci/run-tests.sh`, per-file
  isolation): **70 files total, 69 passed, 1 env-gated skip, 0 failed —
  "ALL TEST FILES GREEN"**. The skip is `tests/media-upload-http.test.ts`
  (self-skips without a live server BY DESIGN; it fails only when a dev
  server on the production DB is reachable during the isolated-DB run — the
  documented baseline procedure runs it serverless).
- Fixture note: the isolated test DB was seeded (`scripts/seed.ts`, guarded)
  and the ten legacy QA/E2E fixture accounts were restored additively to
  satisfy `auth.test.ts`'s environmental invariants (fixtures only; no test
  weakened).
- During-suite fixes (root-caused, re-run green): admin detail 500 (missing
  serializer fields in `ORG_SELECT`), test-helper typing (split
  org/memberParams), run-unique slug fixtures (isolated DB persists across
  local runs).

## 7. TypeScript & lint

- `bunx tsc --noEmit` → **0 errors** (baseline: 0).
- `bun run lint` → **0 errors, 13 warnings** — byte-for-byte the known
  baseline (unused eslint-disable directives + k6 default exports; §6 of the
  protocol). Zero new errors, zero new warnings.

## 8. Build, security, and preservation

- **Production build: NOT executed in this environment** (the sandbox
  forbids `bun run build` — it competes with the mandatory dev server).
  Compile-level confidence is `tsc` (0 errors) + the CI `build` job defined in
  the withheld workflow, which runs on the owner-authorized CI activation
  (M0.6 §12 / D9). Reported honestly as environment-restricted, not passing.
- Secret scan: regex sweep over the full diff + all new files → **0 hits**.
- Runtime-data scan: staged paths contain **no db/media/backup/env/vault**
  paths (bean-sync re-verifies mechanically at publish).
- Preservation evidence: full suite green (all pre-existing behavior intact);
  diff contains no deletions of existing files; the only edits to existing
  files are additive (nav entry, More sheet, admin panel mount, schema
  additions, gitignore line, doc correction). Live E2E on the running app:
  signed in, created org "Champagne Studios" (`/champagne-studios`),
  submitted verification, admin-independent states verified in-browser
  (desktop + 390px mobile, More sheet, zero console errors).

## 9. Environment incidents during O1 (disclosed, none affecting shipped code)

1. **Branch flips (auto-checkpoint):** the environment moved HEAD from
   `feat/ox-o1-employer-identity` back to `main` at least twice (reflog
   `checkout: moving from feat/… to main`). Consequence: commits 380e9ce +
   landed on `main`; the schema commit was cherry-picked onto `main` (`b7fc00b`)
   and the feature branch was synced to the final tip via `update-ref`. No
   history rewrite, no force, nothing deleted.
2. **`[m` transport mangling (false-correlation alarm):** shell/pipe outputs
   containing the two-byte sequence `[m` (e.g. `[memberId]`, `[moreOpen`)
   display as mangled (`emberId]`, `oreOpen`). Hash-level proof that NO file,
   index, or tree was ever corrupted: `mktree` from stdin with the correct
   `[memberId]` name reproduces the committed members tree sha `ea556f80`
   exactly; commit `383f5ec` (built as a "fix") turned out **tree-identical**
   to `380e9ce` (`24b71a34…` both) and was left unreferenced. The D8
   recommendation (post-session integrity check) stands, now extended: treat
   any `[m`-looking corruption in tool OUTPUT as suspect until hash-verified.
3. **Background suite process loss:** a nohup'd suite run died with its log
   vanished between polls; re-run in foreground produced the recorded results.

## 10. Publication record

- Published via `scripts/ops/bean-sync.sh` (MAIN-ONLY, plain fast-forward,
  secret + runtime-data scans enforced, remote-SHA verification built in).
- Push executed: `4f8798c..db5e385  main -> main` — plain push, no force,
  no history rewrite.
- **Published tip: `db5e3856e75bac5276084c35878c9a771e1c0672`**
- bean-sync verification: "remote SHA verified: db5e3856e75bac5276084c35878c9a771e1c0672 (branch main)".
- Independent verification: `git ls-remote origin main` →
  `db5e3856e75bac5276084c35878c9a771e1c0672  refs/heads/main` — **matches
  local main exactly**.
- Published lineage (oldest→newest): `b7fc00b` (schema) → `380e9ce` (backend)
  → `00cefea` (UI) → `f874490` (tests) → `db5e385` (this report). The
  owner-approved feature branch `feat/ox-o1-employer-identity` points at the
  same verified tip (merge path = identity fast-forward).

## 11. Handoff to O2

- Prerequisite state: O1 published tip (§10 addendum); schema contains the
  three employer-identity tables; `src/lib/ox/*` + authz/audit/validation
  ready for reuse; OX audit action vocabulary established.
- O2 scope (owner directive): candidate opportunity profiles, career
  preferences, salary privacy (Int-paise money representation, O0 D4) and
  purpose-scoped candidate visibility consent (`CandidateOpportunityProfile`,
  `CandidateVisibilityConsent` per O0 §3 phase M-O2).
- First action for the next agent: re-run `scripts/ops/bean-sync.sh verify`,
  confirm the O2 baseline equals the published O1 tip, then follow O0 §3
  phase M-O2 + §6 consent flow. Approval gates (Protocol §3.1) apply to the
  new schema push.
