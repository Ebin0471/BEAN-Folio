# M-O5 — Candidate Shortlists — Completion Report

**Status: COMPLETE (all required gates executed and green; published through
the verified bean-sync workflow in the owner-directed per-concern lineage).**
Starting commit: `a4d463bd5c43fa74fbfad4bc6eab51fd6bf6d7d9` (the verified
published M-O4 tip, = `origin/main` at M-O5 start). Workspace:
`/home/z/bean-folio-o3`.

## 1. What was built

Exactly one additive Prisma model (byte-identical in both dialects, parity
gate **94 models**):

- **`CandidateShortlist`** — tenant-bound, opportunity-specific working
  record; unique per `(organizationId, opportunityId, candidateUserId)`;
  the opportunity-belongs-to-organization rule is validated on every write.
  Fields: identifiers, employer-private `note` (≤500 chars zod),
  `scoreAtAdd` + `matchVersionAtAdd` (explainability provenance),
  `addedByUserId` (SetNull provenance), `status ACTIVE|ARCHIVED`. **No
  copied candidate name/email/phone/salary/resume/skills and no frozen
  candidate card** (D14). Indexes: `(organizationId, status)`,
  `(candidateUserId)` + the unique triple.

API (7 handlers over 2 route files, every one through the established
conventions):

| Route | Operations |
| --- | --- |
| `.../[opportunityId]/shortlist/route.ts` | GET list — per-entry live revalidation through `assertCandidateDiscoverableToOrg` in the SAME request (LISTED renders the live card through the discovery serializer; MASKED_CONSENT / MASKED_VISIBILITY / MASKED_BLOCKED / MASKED_UNAVAILABLE render truthful, content-free states); returns the opportunity's real status + editability. POST add — PUBLISHED-only (D6), candidate must pass the CURRENT eligibility boundary via recompute-in-request (D14 — eligibility is never assumed from the past), duplicate triple = 409, not-eligible = generic 409 (never reveals why — no consent/salary inference), stores minimal metadata only. Audited. |
| `.../shortlist/[entryId]/route.ts` | GET inspect (same revalidation), PATCH note/archive/unarchive (PUBLISHED+PAUSED editable; FILLED/CLOSED = 409 `OX_OPPORTUNITY_TERMINAL_READ_ONLY`), DELETE remove (same lifecycle rule). Tenant-bound lookups `(organizationId, opportunityId, id)` — foreign org/opportunity/entry = 404 existence-hiding. Audited. |

Roles: OWNER/ADMIN/RECRUITER only (D13; VIEWER and HIRING_MANAGER 404-deny);
VERIFIED org required (403 `OX_ORG_NOT_VERIFIED`); SUSPENDED refused (403);
same-origin writes; rate limits `ox:shortlist-write`/`ox:shortlist-read`;
strict zod; error envelopes. **No candidate notification exists anywhere**
(D13 — pinned by a dedicated test comparing Notification counts).
Supporting changes: shared `maskedStateFor` in dto.ts (one truthful-state
source for matches + shortlist); audit vocabulary gains
`ox.shortlist.added/updated/removed`.

UI (inside the existing `OpportunityExchangeView`; obsidian/champagne
system; no unrelated redesign):

- `OxEmployerDiscoveryPanel` — per-opportunity discovery console
  (D11): org + opportunity selectors (VERIFIED orgs only), deterministic
  `O4-MATCH-V1` match cards with score rings, audience-safe factor
  explanations (including the safeguard-A line "Experience not compared —
  no opportunity input exists" and the safeguard-B line "Compensation not
  compared — candidate keeps it private"), LIVE/FROZEN/TERMINAL state
  banners mirroring the server, add-to-shortlist with note dialog, note
  editing, removal, masked-state badges, honest empty/loading states.
- `OxCandidateTransparencyPanel` — "How employers see your profile"
  (D12): truthful discovery-state banner re-read from the server
  (ACTIVE/PAUSED/HIDDEN/INVITE_ONLY/REVOKED/EXPIRED/NO_DISCOVERY), own
  matches with public employer identity + explanations, who-viewed
  discovery-activity audit list, consent-first badges. Mounted below the
  existing candidate profile workspace; consent/visibility controls remain
  in the O2 view (not duplicated).

## 2. Database safety (exact record)

- Pre-migration backup: `beanfolio-20261119-115311.db` (VACUUM INTO, sha256
  `b39d4c72fce2d0f01ade6b54fd43706bc504d97b465fb5e1dd2a39d7e2dc4756`, 93
  tables) + verified restore rehearsal into a throwaway path (integrity ok,
  93 tables).
- Applied: the exact registered SQLite DDL
  (`docs/deployment/o5-candidate-shortlist-additive-sqlite.sql`, sha256
  `99a0132c…`) — CREATE TABLE + CREATE INDEX only. Post-push:
  `prisma migrate diff --from-url` reports an **empty migration**; 94
  tables; `integrity_check` ok; `foreign_key_check` 0; users 955→955 and
  TalentMatch 2834→2834 (pre-existing rows untouched).
- PostgreSQL DDL registered (`acf603e7…`), **never executed** — final step
  of the registered deployment order (O2.1 → O3 → O4 → O5).
- Every DB-touching process pinned the isolated QA URL and passed
  `scripts/ops/qa-db-env.sh assert`. No `--accept-data-loss`; no production
  access; legacy workspace untouched; the outstanding Demo Fixture row was
  NOT touched (browser QA used fresh non-demo accounts after confirming the
  demo account is — correctly — excluded from discovery by `isDemo`).

## 3. Gates (all executed in this session)

| Gate | Result |
| --- | --- |
| Full suite with M-O5 | **85 files: 83 passed, 2 env-gated skips (live-HTTP by design), 0 failed — ALL TEST FILES GREEN** |
| M-O5 suite | **13 tests / 63 assertions, 0 fail** (`tests/ox-shortlist.test.ts`): add/duplicate/mismatch/authz/cross-tenant/role denials/revocation-PAUSED-INVITE_ONLY masking/hidden-salary invariance/PAUSED-editable+no-new-adds/terminal-read-only/no-notification/audit/persistence |
| Live-HTTP suites (pinned QA server :3100) | 4/4 + 9/9 green |
| TypeScript | `bunx tsc --noEmit` → **0 errors** |
| Lint | **0 errors, 13 warnings — exactly the documented baseline** |
| Production build | `bunx next build` → **compiled successfully** (exit 0) |
| Schema parity + validations | 94 models identical; both dialects validate |
| QA DB integrity | ok / FK 0 / 94 tables |
| Secret + runtime-data scans | bean-sync staged-diff scans clean at every publish |

## 4. Browser acceptance (agent-browser, isolated QA server on :3100)

Setup: fresh non-demo candidate + fresh verified-org owner with known
passwords; published opportunity "Senior Video Editor (Documentary)"; live
discovery run (143 eligible candidates on the shared QA DB); shortlist add
via the API (scoreAtAdd 40, O4-MATCH-V1).

- **Candidate (desktop 1440×900):** signed in, completed onboarding, opened
  `#/opportunities` → transparency panel renders the truthful ACTIVE banner
  ("Discovery is ACTIVE — verified employers can find you…"), "Your matches"
  with Browser QA Studios / Senior Video Editor (Documentary) · PUBLISHED +
  score ring, "Discovery activity — who viewed your profile" listing the
  recorded preview. Screenshot archived
  (`/home/z/beanfolio-browser-qa/o5-candidate-transparency-desktop.png`).
- **Employer (desktop 1440×900):** signed in, opened the Discover-talent
  console, selected org + opportunity → "143 eligible matches — recomputed
  live on every view", match cards with score rings and "Why this score"
  factor rows (safeguard-A/B lines verified verbatim), shortlist section
  showing "score at add: 40 · O4-MATCH-V1" with the note. Screenshot
  archived (`o5-employer-discovery-desktop.png`).
- **Mobile (390×844):** both surfaces render with the responsive layout;
  screenshot archived (`o5-employer-discovery-mobile.png`).
- **Zero console errors / zero page errors** across all verified views.
- Honest note: the employer match LIST page shows the top-25 by score on the
  shared QA database (143 eligible candidates from all suites); per-candidate
  correctness was verified through the detail route and the shortlist flow —
  pagination is bounded and documented, not a defect.

## 5. Publication record (main-only, fast-forward, verified)

| Commit | Content |
| --- | --- |
| `509b265d865e78fc87b721148eb1c730be0ce9f0` | schema (both dialects) + registered DDL + `O5_MIGRATION_REGISTRATION.md` |
| `a9a15ba5489774f9e3445514e42e13787e810d43` | shortlist API + shared masking/audit extensions |
| `fd7f10e734d087d627e147142e89ec2c21201b1c` | discovery + transparency UI panels + view mounts |
| `6783e91e0bb0ec38371beb3920c9af31c8243f81` | shortlist test suite |
| this document | M-O5 completion report |

Each push independently verified via `git ls-remote origin refs/heads/main`
(bean-sync performs and records the verification; ending tip = remote tip).

## 6. M-O4 + M-O5 program summary

- Schema: +2 additive models (`TalentMatch`, `CandidateShortlist`), parity
  92 → 94, zero edits to existing models, no destructive statements.
- Registered PostgreSQL deployment prerequisites (never executed):
  1. O2.1 salary BigInt widening → 2. O3 opportunity models →
  3. O4 TalentMatch (`4ead0096…`) → 4. O5 CandidateShortlist (`acf603e7…`).
- Privacy attack scenarios T1–T15 pinned green across the two milestones;
  all 15 approved decisions (D1–D15) and the three safeguards (A/B/C)
  implemented and evidenced in the two milestone reports.
- Full regression lineage green end-to-end: baseline 79/79 → M-O4 84 files →
  M-O5 85 files (per-file isolation), plus pinned live-HTTP suites.

## 7. Handoff

- Next milestone: M-O6 (OpportunityInvitation + InvitationNegotiation per
  O0 §3) — NOT started, per the owner's explicit exclusion.
- Deployment prerequisites before any production build including the
  OX routes: apply the four registered PostgreSQL DDLs in the documented
  order, then the O2.1-style information_schema verification gates.
- Outstanding (unchanged, awaiting owner action): the legacy-DB demo fixture
  row cleanup previously disclosed (requires owner approval; untouched).
