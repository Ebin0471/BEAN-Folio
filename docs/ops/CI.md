# BEAN FOLIO — CI (GitHub Actions)

> **⚠️ ACTIVATION STATUS (2026-11 publication-readiness audit): NOT YET ACTIVE.**
> The reviewed workflow exists as a TEMPLATE at
> [`docs/templates/github-workflow-ci.yml`](../templates/github-workflow-ci.yml);
> `.github/workflows/ci.yml` is NOT on `main`, and GitHub reports **zero Actions
> runs** for this repository. Every job description below is the DESIGNED contract
> of that template, verified locally (typecheck, lint, parity, per-file tests,
> build, guards all run green in-repo) — it is not GitHub-verified execution until
> the workflow file lands on `main` and the first run appears in the Actions tab.
>
> **Exact permission limitation (verified twice):** the repository credential
> vault token carries scopes `repo, read:org` — no `workflow` scope. GitHub
> refuses OAuth-app pushes that create or update `.github/workflows/` paths
> with this token; the verbatim remote rejection is preserved in commit
> `28af577`'s message ("refusing to allow an OAuth App to create or update
> workflow `.github/workflows/ci.yml` without workflow scope"), and the
> 2026-11 audit re-verified the token scopes via the GitHub API
> (`x-oauth-scopes: read:org, repo`). Activation therefore requires an OWNER
> action: issue a workflow-scoped credential (fine-grained PAT with
> `workflows: read & write`, or GitHub App), then run the one-command
> activation documented in the template header. This cannot be bypassed with
> the current credential and was not.
Designed 2026-11-15 (M0.5). Workflow template:
[`docs/templates/github-workflow-ci.yml`](../templates/github-workflow-ci.yml).
Intended to run on every push to `main` and every pull request. Four independent
jobs (fail-one = CI red; nothing auto-cancels unrelated work except same-ref
supersession via the concurrency group).

## Jobs

| Job | Checks | Notes |
| --- | --- | --- |
| `quality` | `bunx tsc --noEmit`, `bun run lint`, `prisma validate` on BOTH schemas (`schema.prisma` + `schema.postgres.prisma`), `scripts/check-schema-parity.ts`, runtime-data guard (tracked tree) | No DB needed. TypeScript/lint settings are never weakened to pass CI. |
| `tests` | Full suite via `scripts/ci/run-tests.sh` against an ISOLATED disposable sqlite database (`file:…/custom.db`), seeded with the product's own idempotent seeders (taxonomy → demo fixtures → QA accounts) | The isolated DB is created fresh per run by `prisma db push`; the developer's live database is never touched. Seeders run behind `scripts/lib/seed-guard.ts` (refuse production contexts). |
| `build` | `bun run build` (next build, standalone output) | The app's single document is `force-dynamic`, so the build needs no database. |
| `security` | gitleaks secret scan (full history), runtime-data guard `--history 50` | Fails on NEW runtime-data paths; 94 paths of the published history are recorded in `scripts/ci/runtime-data-history-baseline.txt` (documented below). |

## Version pinning & privileges

- Bun version is pinned in [.bun-version](../../.bun-version) (1.3.14 — matches
  the development environment) and read by `oven-sh/setup-bun@v2`.
- Actions are tag-pinned (`actions/checkout@v4`, `oven-sh/setup-bun@v2`,
  `gitleaks/gitleaks-action@v2`). Hardening follow-up: pin by commit SHA.
- Workflow permissions: `contents: read` only. No secrets are exposed to
  pull-request runs (only the built-in `GITHUB_TOKEN`, read-only).
- No workflow artifacts are uploaded at all — databases, media and backups
  can never leak through artifacts.

## Per-file test execution — why

A single-process `bun test` full run fails ~88 tests through cross-file
interference (shared in-process state: rate-limit buckets, in-memory job
stores, module mocks, fixture ordering) — measured at the published M0.5
baseline on BOTH an empty and a populated database, while every file passes
in isolation against the same database. CI therefore runs each file in its
own process (`scripts/ci/run-tests.sh`) and aggregates: any per-file failure
is a real regression. The order-independence gap is a recorded baseline
finding for a future milestone — it is worked around measurably, not hidden.

## Environment-gated suites

`tests/media-upload-http.test.ts` (the live-HTTP 405 boundary) requires a
running server that shares `DATABASE_URL`. Its module-top-level gate creates
the QA fixture user + a real session against the test database and asks the
server to recognize it:

- no server reachable → suite reports SKIPPED (visible, 0 failures)
- server on a DIFFERENT database → SKIPPED — safe-CI: the suite must never
  mutate a live development database it does not own
- server shares the test DB (the local `./ensure-dev.sh` + `.env` case) →
  runs fully, as before

The 405 regression stays pinned in CI by `tests/media-upload-route.test.ts`
(handler contract) and in every dev session by the `ensure-dev.sh` sentinel
(DEVELOPMENT_SAFETY §4).

## Runtime-data guard

`scripts/ci/guard-runtime-data.sh` enforces the DEVELOPMENT_SAFETY §8 intent
("GitHub receives source only") mechanically on three layers: tracked tree,
staged set, and recent history. Patterns: `db/*.db*`, `uploads/`, `backups/`,
`upload/`, `pg-migration/`, `tool-results/`, `data/laxii-tmp/`,
`public/downloads/`, `.env*` (only `.env.example` is allowed).

**History baseline:** the published history contains 85 non-empty blobs under
`tool-results/` + `upload/` (agent session transcripts, screenshots, pasted
assets) committed 2026-11-11 at `e6883a6` and untracked at `845641a`. The
M22 clean-lineage verification checked only five path classes and missed
these. A secret-pattern scan of all 85 blobs found NO credential-format
strings (only prose false-positives), but the blobs remain reachable from
`origin/main`. Removal requires an owner-approved history rewrite (currently
forbidden), so the paths are recorded verbatim in
`scripts/ci/runtime-data-history-baseline.txt` and the history guard fails
only on NEW violations. See the M0.5 final report (finding H-3) for the
owner decision this unlocks.

## Recommended branch protection (owner action — not applied by CI)

Settings → Branches → `main` protection rule:

1. Require a pull request before merging — or, given the single-owner bean-sync
   workflow, at minimum: **Require status checks**: `quality`, `tests`, `build`,
   `security` (the four job names above) before merging.
2. Require branches to be up to date before merging.
3. Do not allow force pushes or deletions (also enforced by bean-sync's
   remote-state gate).
4. Optional hardening: restrict `GITHUB_TOKEN` permissions org-wide
   (read-only default), enable secret-scanning + push-protection on the repo.

CI does not (and cannot) change repository settings; this list is the
owner's checklist.
