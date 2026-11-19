# M-O4 — Talent Matching & Candidate Discovery — Completion Report

**Status: COMPLETE (all required gates executed and green; published through
the verified bean-sync workflow in the owner-directed per-concern lineage).**
Starting commit: `9d5e57f27d8a9a7ce8eb3736153269995c465f6c` (verified
`origin/main` at task start). Workspace: `/home/z/bean-folio-o3` (fresh clone
of remote `main`; the preserved legacy workspace `/home/z/my-project` was not
modified).

## 1. What was built

Exactly one additive Prisma model (approved schema directive §3.1,
byte-identical in both dialects, parity gate **93 models**):

- **`TalentMatch`** — one CURRENT deterministic compatibility record per
  `(opportunityId, candidateUserId)` (compound-unique). Fields: identifiers,
  `matchVersion` (`O4-MATCH-V1`), integer `score` 0–100, `eligible` +
  `ineligibleReason` vocabulary, minimal audience-safe `explanationJson`
  (factor/reason metadata only — NO candidate names, contact data, salary
  values or skill-list snapshots), `generatedAt`/`expiresAt` staleness
  markers. Indexes: `(candidateUserId, matchVersion)`, `(opportunityId,
  score)`. Storage minimality per the owner directive.

Engine + boundary (M-O4 decision set D2–D10, safeguards A/B/C):

- `src/lib/ox/matching.ts` — PURE deterministic scoring, `O4-MATCH-V1`.
  O0 relative weights preserved for applicable factors (required 30 /
  preferred 10 / profession 15 / evidence 15 / work-mode 5 / location 5 /
  availability 5 / compensation 5; active max 90). **Safeguard A:** the
  experience factor has no legitimate input in M-O3's published Opportunity
  model and is permanently excluded (`NOT_EVALUABLE_NO_OPPORTUNITY_INPUT` in
  every explanation) — no experience values invented or derived, no schema
  columns added. Missing factors are EXCLUDED and renormalized
  (`round(earned×100/activeWeightSum)`, Math.round half-up documented) —
  never zero-penalized. Requirements-vs-preferences distinction: skill
  coverage against declared opportunity requirements is evaluable (set
  intersection; empty candidate set = honest 0), undeclared candidate
  PREFERENCES are unknown (excluded). **Safeguard B:** withheld salary never
  enters the score (excluded + renormalized; the pinned invariant proves a
  zero-filled design would have scored LOWER — renormalization protects).
  No LLM, no external AI, no protected attributes, no randomness; clock
  injected.
- `src/lib/ox/discovery.ts` — **the ONE authoritative boundary**
  `assertCandidateDiscoverableToOrg`: account state (deleted/demo), consent
  ledger re-read (current grant + vocabulary-version currency), visibility
  ACTIVE (PAUSED stops display everywhere — D7; INVITE_ONLY behaves as
  HIDDEN in v1 — D8), both-direction Blocks against the org's ACTIVE member
  set (also implements "candidate and employer do not discover
  themselves"), employment-type unknown-passes hard filter, salary
  hard-filter ONLY on disclosed incompatibility (D10). Plus the bounded
  persist-on-read discovery run (D2 — live eligibility is the source of
  truth; upsert-overwrite per D3; deterministic score-desc/candidateUserId-asc
  tie-break; page size 25; scan cap 500 documented).
- dto/audit: employer + candidate match serializers (masked states carry NO
  candidate content and NO explanations); `ox.candidate.viewed` +
  `ox.discovery.searched` vocabulary.
- Queue (safeguard C): `ox.match-expiry-sweep` recurring chain on the
  EXISTING queue infrastructure — removal-only (`deleteMany expiresAt <
  now`); a job never grants access or restores consent; no new scheduler or
  dependency.

APIs (13 handlers, all through existing session auth, tenant-bound
`requireOrgRole` 404-deny, strict zod, same-origin on writes, documented
rate limits, OX audit, error envelopes, `force-dynamic`):

| Route | Operations |
| --- | --- |
| `src/app/api/employers/[id]/opportunities/[opportunityId]/matches/route.ts` | GET match list — LIVE discovery for PUBLISHED (recomputes in-request, upserts current rows, slices pages from the same consented filter), FROZEN for PAUSED, TERMINAL for FILLED/CLOSED (no recomputation, per-row revalidation), 409 for DRAFT/PENDING_REVIEW; POST explicit recompute (PUBLISHED only, audited, same-origin) |
| `.../matches/[candidateUserId]/route.ts` | GET match detail — live recompute (PUBLISHED) with `ox.candidate.viewed` audit (org + recruiter identity, candidate-visible), frozen revalidated detail (PAUSED/terminal), truthful masked states, 404 when no stored row and not discoverable |
| `src/app/api/opportunities/me/matches/route.ts` | GET own matches (D12) — public employer identity (displayName/slug), opportunity title/status, truthful `discoveryState` (ACTIVE/PAUSED/HIDDEN/INVITE_ONLY/REVOKED/EXPIRED/NO_DISCOVERY), own explanation |
| `src/app/api/opportunities/me/discovery-audit/route.ts` | GET own access trail (D12) — who viewed (viewer identity per O0 §6.7), org, opportunity, purpose, timestamp; bound to the candidate's own profile id |

Roles: OWNER/ADMIN/RECRUITER only (D11 — VIEWER and HIRING_MANAGER are
404-deny on discovery); VERIFIED required (`OX_ORG_NOT_VERIFIED` 403);
SUSPENDED refused (403); foreign org/opportunity/candidate = 404
existence-hiding. No bulk export endpoint exists; responses bounded to
25/page. No global talent search (per-opportunity discovery only, D11).

## 2. Approved-decision compliance (D1–D15 + safeguards)

| Decision | Evidence |
| --- | --- |
| D2 persist-on-read | live search recomputes eligibility every request; stored rows serve explanation/transparency only; expiry sweep removes stale rows |
| D3 one current row | compound-unique upsert; idempotency pinned by tests (repeat runs keep exactly one row, stable score) |
| D4 weights + version | `O4-MATCH-V1` stamped; weights table pinned by unit tests |
| D5/D6 | unknown-passes hard filters; PUBLISHED-only discovery; PAUSED freeze; terminal read-only (409 on recompute) |
| D7/D8/D9 | PAUSED masks display everywhere (data preserved); INVITE_ONLY = HIDDEN; revocation masks retained rows immediately (masked cards carry no content) |
| D10 + B | disclosure-gated salary factor with renormalization; hard filter only on disclosed incompatibility; hidden salary never inferable (explanations carry vocabulary reasons only) |
| D11 | per-opportunity matches; role matrix enforced by tests |
| D12 | own matches + employer identity + who-viewed audit trail |
| C | existing queue reused, removal-only sweep |

## 3. Database safety (exact record)

- Isolated QA database: `/home/z/bean-folio-o3/db/custom.db` (fresh
  schema-only from the clone; every DB-touching process pinned
  `DATABASE_URL=file:/home/z/bean-folio-o3/db/custom.db` and validated
  through `scripts/ops/qa-db-env.sh assert` — the guard VERIFIED-REFUSED the
  inherited legacy URL `file:/home/z/my-project/db/custom.db` this session).
- Pre-migration backup: `beanfolio-20261119-112019.db` (VACUUM INTO, sha256
  `b417afc365ad65b8d38d14bac8daa3f646351c212531bd78770ab2f606f91bad`, 92
  tables) + byte-identical restore rehearsal (`restore-db.ts --target
  /tmp/o4-rehearsal.db --force`, integrity ok, 92 tables).
- Applied: the exact registered SQLite DDL
  (`docs/deployment/o4-talent-match-additive-sqlite.sql`, sha256
  `2b04e849…`) — only CREATE TABLE + CREATE INDEX statements. Post-push:
  `prisma migrate diff --from-url` reports an **empty migration**; 93
  tables; `integrity_check` ok; `foreign_key_check` 0 violations; all 3
  named indexes + autoindex present; pre-existing row counts unchanged.
- PostgreSQL DDL registered (`4ead0096…`), **never executed** — deployment
  prerequisite #3 in the registered order (O2.1 → O3 → O4 → O5).
- No `--accept-data-loss` anywhere; no production access; legacy DB and
  workspace untouched; the outstanding Demo Fixture row was NOT touched.

## 4. Gates (all executed in this session)

| Gate | Result |
| --- | --- |
| Baseline (pre-change) full suite | **79/79 files green** (77 in-run + 2 live-HTTP suites green against the isolated QA server on :3100, pinned `BASE_URL`) |
| M-O4 suites | **55 tests / 168 assertions, 0 fail** — determinism 16, consent 11, privacy 14, matches-api 8, transparency 6 |
| Full suite with M-O4 | **84 files: 82 passed, 2 env-gated skips (live-HTTP by design), 0 failed — ALL TEST FILES GREEN**; live-HTTP suites executed green against the isolated QA server (4/4 + 9/9), plus ox-matches-api re-verified over real HTTP (8/8) |
| Privacy attack scenarios | T1–T15 all pinned green (see suite table above); plus opportunity-PAUSED, terminal, idempotency, tie-break, zero-leak-through-list/ordering/cache assertions |
| Fairness invariance | pinned (identical relevant inputs ⇒ identical results; no protected-attribute input channel exists in the engine's type) |
| TypeScript | `bunx tsc --noEmit` → **0 errors** |
| Lint | **0 errors, 13 warnings — exactly the documented baseline** |
| Production build | `bunx next build` → **compiled successfully** (exit 0; 5 pre-existing Turbopack warnings on untouched `process.exit` lines in `src/instrumentation.ts`) |
| Schema parity + validations | `check-schema-parity.ts` OK (93 models); `prisma validate` OK on both dialects |
| QA DB integrity | ok / FK 0 (pre- and post-migration) |
| Secret scan | bean-sync staged-diff scan clean (enforced at every publish) |
| Runtime-data scan | bean-sync staged-path scan clean at every publish |

## 5. Publication record (per-concern lineage, main-only, fast-forward)

| Commit | Content |
| --- | --- |
| `c132071bf8a19a5b2fecf181c86b502e942b5cf8` | schema (both dialects) + registered DDL artifacts + `O4_MIGRATION_REGISTRATION.md` |
| `154f84a0ba6ce966e74be3d56efeb1e7e612ecc3` | matching engine + discovery boundary + serializers/audit + queue sweep + 13 API handlers |
| `93895abd465dbb2272cf7d2f32917a6a9d0839c6` | the five M-O4 test suites |
| this document | M-O4 completion report |

Every push verified: `git ls-remote origin refs/heads/main` equals the local
tip after each step (bean-sync performs and records the verification).
Ending tip before this report: `93895ab…`.

## 6. Disclosed environment events (honesty record)

1. **Workspace recycle before start:** the sandbox was reset between the
   planning and implementation sessions — `/home/z/bean-folio-o3` and
   `/home/z/planning-reports/` were lost, and the legacy vault mode bits had
   regressed to 755 (restored to 700/600; token content untouched and
   verified working). The owner's authorization anticipated this: the
   planning documents were RECONSTRUCTED from the authorization text plus
   authoritative repository docs (no application files changed), recorded in
   the reconstructed headers. The fresh clone was re-verified at
   `9d5e57f2` = remote main.
2. **Vault wiring in the fresh clone:** `bean-sync` resolves the vault
   relative to the repo root; the fresh clone's `.git/bean-auth/` was absent
   (workspace-recycle artifact, anticipated by `docs/GITHUB_AUTHENTICATION_AND_SYNC.md`
   — "will be reused whenever the vault is found empty"). The SAME working
   token from the surviving legacy vault was wired into the clone's vault
   (700/600), verified via `bean-auth.sh status` (masked; account
   `Ebin0471`, API ok). No token was printed; no new OAuth grant was minted.
3. **Test-isolation learnings (fixed in-suite, no product impact):** the QA
   database is shared across the per-file suite, so the discovery scan
   legitimately surfaces candidates created by other suites; per-candidate
   assertions were moved to the detail route + persisted rows (the list page
   is top-25-by-score paginated). Also fixed in-suite: masked cards must not
   carry factor explanations (serializer tightened; T15 now pins it).

## 7. Handoff to M-O5

- Prerequisite state: published tip `93895ab…` (+ this report commit);
  schema at 93 models with `TalentMatch`; the discovery boundary, match
  serializers, audit vocabulary and queue sweep are live.
- M-O5 scope (owner directive): `CandidateShortlist` additive model
  (parity 94), shortlist API with full revalidation on every add/read,
  employer discovery/shortlist UI + candidate transparency UI inside
  `OpportunityExchangeView`, browser acceptance, migration registration,
  publication.
- First action for M-O5: verify remote main equals the M-O4 report tip,
  then follow the owner's §6 (schema → API → UI → tests → gates → publish).
