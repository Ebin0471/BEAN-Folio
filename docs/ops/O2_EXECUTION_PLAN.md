# O2 — Candidate Opportunity Profiles & Consent — Execution Plan

**Status:** READY FOR IMPLEMENTATION — planning only; no schema, application, database, or production changes are made by this document.
**Base:** O1 published main tip `51be22ad75ed1369305255b7f691580716b25a33`.
**Working branch:** `feat/ox-o2-candidate-profiles-consent`.
**Authority:** O0 Opportunity Exchange audit §2, §3 (M-O2), §6, §9 and §11; O1 handoff §11; repository safety and milestone execution protocols.

## 1. Exact scope

O2 adds only candidate-side opportunity profile data and purpose-scoped visibility consent. It does not implement job/opportunity listings, employer talent discovery, matching, shortlists, invitations, hiring rooms, interviews, candidate reports, billing, or public job URLs.

Required capabilities:

- One candidate opportunity profile per existing `User`; no second identity/account system.
- Candidate-controlled career preferences and availability.
- Candidate-controlled salary disclosure, defaulting to hidden.
- Separate consent records for each processing purpose.
- Explicit opt-in before discoverability; absence of a consent grant means deny.
- Immediate revocation and server-side enforcement on every future discovery read.
- Candidate-facing settings within the existing Opportunity Exchange route and design system.

## 2. Data model — proposed additive-only schema

Implement the O0 M-O2 entities in BOTH `prisma/schema.prisma` and `prisma/schema.postgres.prisma`, preserving model parity.

### CandidateOpportunityProfile

One-to-one with existing `User` (unique `userId`; relation must not duplicate identity fields). Proposed scalar fields, subject to checking current schema conventions and the O0 model diagram before implementation:

- `id`, `userId` (unique FK to User)
- `visibilityStatus`: `HIDDEN | ACTIVE | PAUSED | INVITE_ONLY`, default `HIDDEN`
- `employmentTypes`, `workModes`, `preferredLocations`, `preferredProfessionIds`: serialized string arrays following the repository's existing SQLite-compatible convention
- `experienceMinYears`, `experienceMaxYears` (nullable bounded integers)
- `availableFrom` (nullable DateTime), `noticePeriodDays` (nullable bounded integer)
- `compensationVisibility`: `HIDDEN | VERIFIED_EMPLOYERS | AFTER_INVITE | RANGE_ONLY`, default `HIDDEN`
- `salaryMinPaise`, `salaryMaxPaise` (nullable integer minor units), `salaryCurrency` (ISO 4217 code), `compensationPeriod` (explicit vocabulary such as YEAR/MONTH/HOUR)
- timestamps

Do not store salary in floating-point values. Validate min ≤ max, currency format, period vocabulary, integer bounds, and paired-field consistency. Do not infer or populate preferences from protected characteristics.

### CandidateVisibilityConsent

Purpose-specific consent rows, not one global boolean:

- `id`, `userId`, `scope` (`DISCOVERY | PROFILE_ANALYTICS | AI_PROCESSING`)
- `consentVersion`, `status` (explicit grant/revoke state), `source`
- `grantedAt`, `revokedAt`, `expiresAt`, timestamps
- indexes/uniqueness that support a clear current-consent lookup while preserving auditable consent history

The implementation must preserve history rather than overwrite away prior grants/revocations. Before settling uniqueness or history mechanics, inspect existing schema patterns and the full O0 consent specification; document the chosen invariant in tests.

## 3. Privacy and authorization invariants

1. No consent row or no current valid grant = no consent.
2. Profile visibility defaults to HIDDEN. Creating a profile never makes a candidate discoverable.
3. ACTIVE discoverability requires the explicit DISCOVERY grant and is checked server-side for every read.
4. Revocation is immediate: write the revocation record, set visibility to HIDDEN in the same transaction, emit the OX audit event, and invalidate the `ox.visibility` cache event. Candidate/private data must never be put in shared cache.
5. PROFILE_ANALYTICS and AI_PROCESSING are independent purposes. Granting one never grants another.
6. Salary disclosure defaults to HIDDEN and is evaluated per requesting employer/context. Do not include salary in generic profile DTOs or responses unless the candidate's configured policy permits that exact disclosure context.
7. Email, phone, private project data, private portfolio drafts and other direct contact details never appear in candidate preview/profile DTOs.
8. Reuse existing User/session/auth infrastructure and O1 OX audit writer. Never create a second identity model.
9. All candidate-owned endpoints derive userId from the authenticated session; never trust a client-supplied userId.
10. Every mutation uses the repository's same-origin, rate-limit, validation, error-envelope and audit conventions.
11. No bulk export endpoint. No employer discovery endpoint in O2.
12. No AI processing of private candidate content without the specific AI_PROCESSING consent and existing AI gateway/cap rules.

## 4. API design — candidate self-service only

Use the OX namespace `/api/opportunities/me/*` as selected in the O1/O0 owner decisions. Confirm no collisions against the current tree before adding routes.

Proposed endpoints:

- `GET /api/opportunities/me/profile` — read the authenticated candidate's own profile and privacy-safe settings.
- `PUT /api/opportunities/me/profile` — create/update only the authenticated candidate's own preferences and disclosure settings.
- `GET /api/opportunities/me/consents` — read purpose-specific consent state and history suitable for the candidate.
- `POST /api/opportunities/me/consents` — explicitly grant a supported purpose with current consent version/source.
- `POST /api/opportunities/me/consents/:scope/revoke` — revoke one purpose; DISCOVERY revocation also forces profile visibility to HIDDEN and invalidates visibility cache.
- `POST /api/opportunities/me/visibility` — change visibility state only when the required consent preconditions are satisfied.

Do not expose admin consent mutation routes or employer candidate-search routes in O2. Keep route handlers thin and centralize parsing/authorization/privacy serialization in `src/lib/ox/*`.

## 5. UI

Add a candidate opportunity-profile/privacy view under the existing `/opportunities` route, without replacing or breaking the O1 employer workspace.

Include:
- Career preferences editor (employment type, work mode, locations, profession, experience, availability/notice).
- Salary preference and disclosure editor with a clear HIDDEN default and contextual explanation.
- Separate purpose toggles for DISCOVERY, PROFILE_ANALYTICS and AI_PROCESSING, each showing version/status/timestamps.
- Visibility status and an explicit confirmation before enabling ACTIVE discoverability.
- Clear revoke/pause controls and a truthful confirmation of what becomes hidden.
- Loading, empty, validation, server-error and success states.

Reuse existing BEAN Folio components, design tokens, responsive layout and accessible controls. Preserve the existing Opportunity Exchange navigation and employer flows.

## 6. Required tests

Add isolated-database tests following `scripts/ci/run-tests.sh` conventions. At minimum:

- profile is private by default; one profile per User; cannot read or mutate another user's profile;
- strict validation for all preference vocabularies, bounds, dates, currency, compensation period and salary range;
- no consent / expired consent / revoked consent denies discovery eligibility;
- purpose isolation (DISCOVERY grant does not imply analytics or AI grant);
- visibility ACTIVE is rejected without current DISCOVERY consent;
- revocation atomically hides the profile, preserves consent history, audits and invalidates cache;
- salary default hidden; each disclosure mode serializes only the allowed fields in its permitted context;
- contact fields and private portfolio/project fields never appear in DTOs;
- same-origin, auth, rate-limit and error-envelope behavior;
- O1 employer routes, verification and tenant-isolation suites remain green.

Run the complete test runner, parity, both Prisma validations, TypeScript, lint and production build. Report exact outputs. Never weaken or skip tests to obtain a green result.

## 7. Mandatory execution gates

1. Verify repository instructions and clean working tree; record actual branch, local SHA, remote SHA and O1 baseline. Run `scripts/ops/bean-sync.sh verify` in the real repository workspace.
2. Read current `AGENTS.md`, `DEVELOPMENT_SAFETY.md`, `docs/ops/MILESTONE_EXECUTION_PROTOCOL.md`, `docs/ops/MIGRATIONS.md`, O0 audit and O1 report. Inspect actual User schema, O1 OX helpers, route patterns, cache invalidation and candidate UI patterns.
3. Produce a file-by-file implementation plan and confirm the proposed schema against the complete O0 specification.
4. Add the two models and User backrefs to BOTH schemas. Run schema parity and both Prisma validations. Stop on any error.
5. Take and verify a database backup. Verify the additive change against an isolated copy. Only then, under the owner's existing O2 schema approval, run the approved development DB push without `--accept-data-loss`. Stop if Prisma proposes data loss.
6. Implement shared helpers, routes and UI incrementally.
7. Run focused O2 suites after each logical unit; fix every failure before continuing.
8. Run all regression suites, tsc, lint and the production build. The build must actually execute; a CI plan or TypeScript check is not a substitute.
9. Review the entire diff and status. Run secret and runtime-data scans. Confirm no unrelated edits, deletions, media, databases, backups, credentials or environment files are staged.
10. Publish only through `scripts/ops/bean-sync.sh` on the approved clean `main` path, with no force push or history rewrite. Independently verify `git ls-remote origin main` equals the intended local SHA.
11. Produce the full milestone report: baseline/ending SHAs, complete file inventory, tests and outputs, build output, schema parity, backup evidence, privacy/security checks, preservation evidence, publication SHA and blockers.

## 8. Stop conditions

Stop and report rather than guessing if:
- the verified O1 remote baseline differs from the expected SHA;
- branch/worktree is dirty or the environment auto-checkpoint changes HEAD unexpectedly;
- the complete O0 consent requirements conflict with this plan;
- either Prisma schema cannot validate or parity fails;
- a backup cannot be created and restore-verified;
- DB push proposes data loss;
- any authorization, privacy, consent, test, lint, TypeScript or build check fails;
- the local shell/workspace cannot execute the required gates.

**No false-green reports. No O3 work until O2 is genuinely complete.**
