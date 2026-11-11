# Phase 4 delivery report — CODE GIFTZ Engineering Agent

Phase: controlled engineering agent — repository inspection · structured planning ·
approval-gated execution in isolated workspaces · allowlisted command running ·
reviewable diffs · durable task history.
Companion docs: `06-code-giftz-phase4-audit.md` (pre-code audit), `02-architecture.md` (P1),
`05-laxii-phase3-delivery.md` (P3), worklog Task 34.

## 1. Audit findings (full detail in `06-code-giftz-phase4-audit.md`)

- CODE GIFTZ was a mature **site-config mutation pipeline** (plan → approve → execute → verify
  over validated SiteConfig JSON) with zero code-editing, command-running or durable-job
  capability; its jobs lived in an in-memory `globalThis` Map with a 30-minute TTL.
- **Jobs were stored only in memory** — audit confirmed; server restart lost all state.
- No `child_process` usage existed anywhere in the codebase — the execution layer is
  entirely new, built on the house timeout/confinement idioms.
- `AgentTask` existed with an unused task tree and free-string `agent`/`kind` — the durable
  landing spot; `kind: "ENGINEERING_TASK"` needed no destructive change.
- The website-design pipeline, gateway, storage boundary and 278-test suite had to remain
  untouched and green.

## 2. Architecture changes

- New `src/lib/giftz/` module (10 files): `types.ts` (lifecycle + contracts), `redact.ts`
  (secret redaction + secret/ignored path predicates), `template.ts` (real starter repo —
  a bun/TypeScript "ledger-kit" with a seeded defect so `bun test` FAILS on arrival),
  `workspace.ts` (confinement, git baseline, minimal-env), `inspect.ts` (deterministic
  read-only digest), `commands.ts` (allowlisted runner with kill registry), `diff.ts`
  (git-powered unified diffs + parser), `plan.ts` (zod engineering plan + semantic
  validator + ONE bounded structured repair), `provider.ts` (gateway-backed model calls,
  agent `CODE_GIFTZ`), `jobs.ts` (durable task store on AgentTask).
- Lifecycle: `QUEUED → ANALYZING → PLANNING → AWAITING_APPROVAL → EXECUTING → VALIDATING /
  TESTING → COMPLETED | FAILED | CANCELLED` — persisted at every transition.
- Workflow implemented per spec §2: user request → repository inspection → requirement
  analysis/planning (LLM, schema-validated) → **approval gate** → execution (plan-scoped
  file edits) → code validation & testing (allowlisted commands) → diff review → completion
  report.
- Design-job durability (smallest safe change): terminal design-job states shadow-persist as
  `AgentTask` rows (`kind: SITE_DESIGN_JOB`) — live stepping behavior unchanged.

## 3. Files modified / created

**New** — `src/lib/giftz/` (10 files above); `src/lib/giftz-client.ts` (browser SDK);
`src/app/api/giftz/` (9 route files: repositories GET/POST, repositories/[id] GET/DELETE,
tasks GET/POST, tasks/[id] GET, approve, reject, cancel, retry, revert);
`src/views/GiftzView.tsx` + `src/components/giftz/` (workspace UI);
`src/lib/ai-design/durability.ts`; `tests/giftz-engine.test.ts` (29 tests);
`tests/giftz-api.test.ts` (5 tests); `tests/helpers/giftz-fixtures.ts`;
`docs/ai-transformation/06-code-giftz-phase4-audit.md` + this report.

**Modified (additive)** — `prisma/schema.prisma` + `schema.postgres.prisma`: new
`GiftzRepository` model, `AgentTask.repoId String?`, status-vocabulary comment (both mirrors
in lockstep, `db:push` clean, no data migration); `src/components/bean/SiteShell.tsx`
(imports, `/giftz` route case, nav entries "Code Giftz", title map);
`src/lib/ai-design/execute.ts` (three terminal-return hook lines calling the durability
shadow — behavior otherwise byte-identical); `tsconfig.json` (`"data"` added to `exclude` —
user workspaces must never be typechecked as app code).

## 4. Database changes

- `GiftzRepository { id, ownerId→User cascade, name, status READY|ARCHIVED, sizeBytes,
  fileCount, timestamps }` — the durable workspace registry; the on-disk path is ALWAYS
  derived from the row id (`data/giftz-workspaces/<id>`), never stored from user input.
- `AgentTask.repoId String?` — engineering tasks link to their repository.
- All additive; both SQLite and Postgres mirrors updated; `prisma db push` verified.

## 5. Security boundaries (implemented + verified)

| Boundary | Implementation |
|---|---|
| Path confinement | `constrainWorkspacePath`: resolve + under-root check, `..`/absolute/NUL refusal, symlink-escape walk, secret/ignored predicates (storage.ts `resolveLocalPath` idiom) |
| Secret hygiene | `.env*`, `*.pem`, `*.key`, `id_rsa*`, credentials, `.npmrc`… never read, never written, never even listed in the digest tree; binary files refused for reads |
| Secret redaction | `redactText` applied to ALL captured command output before storage (key=value secrets, bearer/basic, PEM blocks, AWS ids, 40+ hex tokens, URL credentials); idempotent |
| Command allowlist | argv-validated: `bun test [paths]`, `bun run <script from workspace package.json>`, `bunx tsc`, `bunx eslint`, `node --version` — everything else 403; `shell:false`, argv arrays, no interpolation |
| Environment isolation | Every subprocess runs with `{PATH, HOME, LANG, TMPDIR, NODE_ENV}` only — `DATABASE_URL`, session or S3 secrets physically cannot reach a child process (verified by an env-probe test) |
| Timeouts / kill | 120 s hard cap per command with SIGKILL; per-task child registry enables `killTaskChildren` on cancellation |
| Resource caps | 256 KB per-file read/write, 32 MB / 2000-file workspace caps, 64 KB output caps (tail kept + truncation flag), ≤12 argv entries, ≤256 chars/arg |
| Ownership | Every repo/task accessor takes `userId` (`findFirst({id, userId})`, foreign → 404); ≤5 repos/user; task creation rate-limited; `aiGate` consent + burst + daily quota on planning |
| Duplicate prevention | At most ONE active task per repo per user — duplicate creation re-attaches (409 semantics via `duplicate: true`) |
| Approval | Execution only from `AWAITING_APPROVAL` (409 otherwise, server-enforced); reject/cancel/revert server routes; retry bounded (MAX_ATTEMPTS = 3) |
| Restart recovery | Stale ACTIVE tasks (10 min, no live runner) honestly FAILED by the sweep — "interrupted before completion", retryable; in-flight tasks are never swept |
| Plan validation | Strict zod + semantic checks (secret/ignored/unknown paths, file↔step consistency, command linkage, mandatory test command); ONE bounded repair; actionable errors — users never rephrase because of internal schema mismatches |

The BEAN Folio application itself is never a workspace target — the agent can neither read
nor modify production source.

## 6. Implemented capabilities (spec §3–§9 mapping)

- **Repository inspection**: file tree (capped), languages, frameworks, package manager +
  scripts (argv), entry points, route files, test files, schema files, git state, size
  counts, policy-skip counts — metadata only, deterministic, re-runnable.
- **Engineering planner**: full plan schema (objective, problem, root-cause hypothesis,
  files+reasons, ≤10 steps with kinds/risks/dependencies, external dependencies, risks,
  validation strategy + allowlist-shaped commands, expected outcome).
- **Controlled execution**: per-step model edits validated (path equality, change-type
  equality, content cap, secret refusal); applied ONLY to plan-declared paths inside the
  isolated workspace; baseline git commit enables per-file revert.
- **Patches & approval**: real `git diff HEAD` unified diffs parsed per file (+/− counts,
  hunks, truncation flags) shown in a line-level diff viewer; approve/reject before
  anything runs; per-task cancel (hard child kill), bounded retry, per-file revert.
- **Test & validation engine**: command records store argv, exit code, duration, status
  (passed/failed/timeout/killed/error), capped redacted stdout/stderr tails, redaction
  counts; test counts parsed from `bun test` output; status semantics distinguish
  generated / applied / verified / failed / not_performed — a change is COMPLETED only
  when its validation commands pass.
- **Durable jobs**: every transition persisted (state, lifecycle timeline, plan, edits,
  diffs, runs, report, attempts, error); history list; restart sweep; nothing is lost.
- **UI** (`#/giftz`, nav "Code Giftz"): repository explorer + create/delete, inspection
  digest + file tree, task composer, live execution timeline (2 s polling, cancel),
  plan review card with approve/reject, applied-file summary, diff viewer, terminal
  output per run, test summary, completion report with verdict banner, task history —
  obsidian/champagne-gold, consistent with RIISHE/LAXII, no provider branding.

## 7. Tests added (spec §11 A–O) — `bun test`: 325 pass / 0 fail

29 engine tests (`tests/giftz-engine.test.ts`) + 5 route tests (`tests/giftz-api.test.ts`),
all against REAL workspaces (mkdtemp root), REAL git baselines, REAL `bun test` /
`tsc` subprocesses and the REAL database (unique QA users, cascade cleanup); only model
calls are scripted:

A. inspection (inventory + scripts + tests + git; secret files invisible even as paths) ·
B. valid plan parses+validates · C. invalid plans: one bounded repair then actionable
error; repair success labelled; semantic rejections (secret/unknown paths) ·
D. confinement (traversal, absolute, symlink policy, secret read/write refusal, ignored
dirs) · E. real unified diffs + per-file revert preserving unrelated files · F. approval
enforcement (409 before approval, reject blocks, approve-after-reject 409) ·
G. command allowlist (rm/curl/sh/unknown-script/flag injection rejected; allowlisted
shapes accepted) · H. isolated execution (cwd = workspace, env keys PATH/HOME only — no
DATABASE_URL; output redaction with counts) · I. real test execution: seeded bug FAILS
(counts parsed), fix PASSES · J. stale-task recovery + in-flight guard · K. full state
survives clearing every in-process registry (simulated restart) · L. mid-execution
cancellation kills children → CANCELLED · M. duplicate re-attach + retry bounds (409 when
exhausted) · N. cross-user invisibility (repo, detail, approve, revert) · O. redaction
coverage + idempotency.

Route tests additionally cover: 401 anonymous, 400 malformed, workspace create/list/
detail/delete with cross-user 404, duplicate re-attach via HTTP, approve → COMPLETED →
revert through real handlers, reject/cancel paths, history listing.

## 8. Browser verification (agent-browser, real credentials, demo account)

1. `#/giftz` renders (nav entry, repositories, composer, history); mobile 390×844 and
   desktop 1280×800 both clean after fixing two real overflow defects the check caught
   (missing `min-w-0` on flex/grid items); footer flush at page end (gap 0).
2. "New workspace" → real `ledger-kit` repository (8 files, 2.9 KB), live inspection
   digest (TypeScript (3), scripts, tests, "Git: clean baseline commit", policy-skip
   counters) and expandable file tree.
3. Engineering task submitted → live PLANNING state on the timeline → the REAL gateway
   produced a schema-validated plan (objective/problem/root-cause/6 steps with risks and
   `bun test` + `bun run typecheck` validation). One earlier live plan required the
   bounded repair and the UI labelled "validated after one repair" — the repair loop
   demonstrably works in production.
4. Approve → EXECUTING → real model file edits → real `bun test` + `bunx tsc` inside the
   workspace.
5. **Failure path (honest)**: the model's first execution contained a genuine defect
   (syntax error in the generated test file: `amount: }`) — both validation commands
   failed, the task landed FAILED with "NOT verified — validation commands failed", the
   run log showed exit codes and durations, and the diff remained reviewable. Retry
   (attempt 2/3) re-ran execution; the model produced a correct fix + expanded suite →
   **COMPLETED, "Verified — the applicable validation checks passed", 13 tests passed**,
   typecheck passed.
6. Diff viewer showed the exact real change: `−total += Math.abs(entry.amount);` →
   `+total += entry.amount;` (+1/−1) and +60 lines of new tests — vs the baseline commit.
7. **Restart persistence**: dev server force-killed and restarted → task history intact;
   the COMPLETED task reloads with full plan, timeline, diffs, run log and report.
8. Rejection path exercised live (plan rejected → CANCELLED → late approval 409);
   cancellation and attempts-exhaustion covered by automated tests.
9. `dev.log` shows no runtime errors from Phase 4 code; giftz routes serving 200s.

## 9. Cost and latency (documented estimates, not bills)

- Planning: one deep gateway call (observed 12–18 s live; AI_DEEP_TIMEOUT_MS 120 s);
  recorded via `recordAiUsage(userId, "giftz-plan")` in the shared daily ledger.
- Execution: one gateway call per file step (observed seconds each) + subprocess time
  (`bun test` ≈ 60 ms in the workspace; first `bunx tsc` ≈ 1.3 s after dependency fetch);
  recorded as "giftz-execute". Managed-gateway cost estimate $0.0000 (unmetered engine).
- Command cap 120 s each; whole-task wall-clock bounded by plan size (≤10 steps) +
  attempts (≤3).

## 10. Known limitations (honest)

1. Workspaces are created from the built-in starter template — uploading/importing an
   arbitrary existing repository (zip/git URL) is not implemented yet; the registry and
   all engines are already repository-agnostic.
2. `bunx tsc`/`bunx eslint` fetch their toolchain on first use inside a workspace (no
   offline guarantee); a workspace without the needed tooling reports an honest command
   failure rather than a fake pass.
3. Execution is in-process fire-and-forget: a crash mid-step cannot resume — it is
   honestly failed by the sweep and retryable (bounded), never silently "recovered".
4. Cancellation is cooperative between steps plus hard child-kill; a single in-flight
   model call completes before the flag is observed.
5. Design-job shadow persistence stores terminal state only; the website-design panel's
   live UX (in-memory stepping) is intentionally unchanged.
6. Model-generated file edits are whole-file writes validated against plan-declared
   paths — no find/replace surgery, so very large refactors are out of scope by design.
7. Secret redaction is pattern-based; it is a strong guard for captured output, not a
   general-purpose DLP engine.
8. "Run the project's tests through CODE GIFTZ" is satisfied against the authorized
   workspace repository (the only repositories the agent may touch) — pointing the agent
   at the BEAN Folio codebase itself is deliberately impossible.

## 11. Deferred work

- Repository import (zip upload / git clone) and multi-repo tooling.
- Per-step approval UI (currently whole-plan approval, server-enforced).
- Streaming execution timeline (SSE) instead of 2 s polling.
- LAXII-style quality reports for engineering outputs (lint annotations inline in the diff).
- Phase 5 remainder (generic task-list/cancel surfaces across agents), Phase 6, Phase 8.

## 12. Remaining production blockers (honest)

- No production deployment has been performed or verified; "production-ready" is
  explicitly NOT claimed. Phase 4 is feature-complete for its scope on the sandbox
  deployment with real end-to-end evidence.
- Build verification is not possible in this sandbox (dev server only, by platform rule);
  tsc + lint + 325-test suite are the applied static gates.
- Single-instance assumptions (in-memory rate limiters, child registries) persist from
  the existing architecture and are documented in the Phase 0/1 docs.
