# Phase 4 follow-up delivery report — CODE GIFTZ planner consistency fix

Fixes the real production failure: `undeclared-file [propose-fix]: step "propose-fix" targets
"PROPOSED_FIX.md" which is not declared in files` — a valid engineering request (the exact
ledger-kit inspection request) failed because the planner's steps and its file manifest
diverged. Companion docs: `07-code-giftz-phase4-delivery.md` (P4), worklog Task 35.

## 1. Audit findings (evidence, not guesswork)

The failed production task (`cmw0dqqyq0005r8kel8txsikv`, ledger-kit starter) was recovered
from its persisted `resultJson`:

- `planIssues` showed **4 findings**: steps `propose-fix` → `PROPOSED_FIX.md` and
  `propose-additional-tests` → `PROPOSED_TESTS.md` were not declared in `files`, while
  `src/lib/ledger.ts` + `tests/ledger.test.ts` were declared but never applied by any step.
- The ONE bounded repair **did run** (timeline note `plan failed validation` is written only
  on the bounded path) and its output still failed validation.
- The user-visible error was the raw first validator string: no existence/intent context,
  no repair telemetry.

**Where PROPOSED_FIX.md was introduced:** the model interpreted "propose a minimal fix" as
*write a proposal document* and structured the work as documentation deliverables, while
declaring the real source/test files in the manifest it never wired steps to. The original
prompt had no rule against invented documentation files and no explicit manifest↔steps
consistency rule.

**Two additional real failure modes discovered and fixed during verification** (same root
class — model/vocabulary brittleness behind a strict validator):

1. **Step-id format nits**: a plan died on `steps.2.id: lowercase alphanum and dashes`
   *after* a successful semantic repair — pure label formatting.
2. **Conflated vocabularies** (captured via the new received-value telemetry): steps used
   `kind: "modify"` (the change vocabulary) and the manifest listed read-only targets as
   `change: "inspect"`; a later run omitted the modify steps entirely because the request
   said "Do not modify any files until I approve" — the model removed the work from the plan
   instead of relying on the approval gate.

## 2. Changes (planner + validation integration only)

- `src/lib/giftz/plan.ts`
  - `PlanIssue` gains `hint` — actionable, redaction-safe remediation text.
  - `undeclared-file` now reports **whether the target exists in the repository** and the
    **planner's intent** (create/modify/delete) plus remediation.
  - `unknown-file` suggests up to 3 closest repository files (bounded, from the digest).
  - New checks: `duplicate-file` (manifest declared twice), `invalid-step-path`
    (traversal/absolute/backslash step targets), secret-path checks now also apply to bare
    step targets (defense in depth; execution-time checks unchanged).
  - `parsePlanWithRepair` returns `firstIssues` — what the validator rejected first.
  - **Deterministic vocabulary canonicalization before validation** (`canonicalizePlanVocabulary`):
    step ids ("Fix_Ledger" → `fix-ledger`, `dependsOn` remapped), change verbs
    (update/fix/patch → `modify`, add/write → `create`, remove → `delete`), step kinds
    (modify/edit → `modify_file`, run/execute → `run_command`, …), and read-only manifest
    entries (`change: "inspect"/"read"/"view"` = a wish to LOOK at a file) are **dropped —
    never turned into writes, never invented**. Unknown values are left untouched and fail
    validation honestly. File paths are NEVER canonicalized (security-relevant).
  - **Received-value feedback**: zod v4 discards the rejected input on enum failures, so
    off-enum `files[].change` / `steps[].kind` values are captured before validation and
    embedded in the issue text — `(received: "inspect")` — so the repair model and the user
    see exactly which word to fix.
- `src/lib/giftz/provider.ts`
  - Planner prompt: explicit manifest↔steps consistency rule, no-invented-documentation
    rule, prefer-existing-source/test-files rule, and the crucial clarification that the
    plan is a PROPOSAL — modify steps belong IN the plan; "do not modify until approved" is
    satisfied by the approval gate, not by omitting the work.
  - Repair prompt: per-issue-class guidance (`repairGuidance`) derived from issue codes +
    schema-error line with the exact allowed values; preserves the user objective.
- `src/lib/giftz/types.ts` + `src/lib/giftz-client.ts`: `TaskResult(DTO)` gains
  `planRepaired?: boolean` and `planRepairIssues?: string[]`.
- `src/lib/giftz/jobs.ts`: failure path persists `planIssues` (final), `planRepaired`,
  `planRepairIssues` (first attempt); success path persists the same telemetry with empty
  issues — the old `"plan repaired once…"` marker string is gone.
- `src/views/GiftzView.tsx`: plan review shows the repair note (with the first-attempt
  findings) keyed on `planRepaired`; FAILED tasks render a "Plan validation findings" panel
  (issues + "automatic repair was attempted once and the plan still failed validation").
- `bunfig.toml` (new): `[test] root = "tests"` — application-suite discovery no longer
  collects `data/giftz-workspaces/*/tests/*.test.ts` (user workspaces ship their own suites
  and run them inside isolation with the workspace as cwd; explicit `bun test` inside a
  workspace still works — verified). Without this, any real user workspace silently
  contaminated the app suite (observed: leftover E2E workspace made `bun test` at root fail
  the template's seeded-bug test).

## 3. Regression coverage — `tests/giftz-plan-consistency.test.ts` (16 tests)

Spec §5 A–J plus the exact production regression and live-discovered failure modes:

- A declared-existing-file plan validates cleanly; B declared-new-file (create) validates
  cleanly; C undeclared EXISTING file → existence + intent + remediation in message/hint;
  D undeclared NEW file → absence + create guidance + no-invented-docs warning; E traversal
  and absolute step paths refused (`invalid-step-path`) and manifest traversal still
  schema-rejected; F secret targeting refused for declared files AND bare steps; G duplicate
  declarations flagged exactly once without masking other findings; H undeclared-file error
  repaired — precise issues reach the repair callback, `repaired: true`, `firstIssues` kept;
  I repair failure after the ONE bounded attempt → actionable error, repair called exactly
  once; J valid plans produce no issues and are not mutated.
- **Regression**: the exact PROPOSED_FIX.md plan shape (schema-valid, semantically broken)
  yields precisely the four production findings (`undeclared-file [propose-fix]`,
  `undeclared-file [propose-additional-tests]`, 2× `uncovered-file`).
- Task-level: repair rescues the failing plan → `AWAITING_APPROVAL`, `planRepaired: true`,
  every repaired-plan step targets a declared file, workspace git-clean; repair exhausted →
  honest `FAILED` with `planIssues[0]` naming `PROPOSED_FIX.md`, zero workspace changes,
  exactly one repair call.
- Canonicalization: id format nits repaired deterministically with `dependsOn` remapping
  (no repair call); change/kind synonym conflation normalized; read-only manifest entries
  dropped; unknown vocabulary still fails honestly (never invented).

Suite: **327 pass / 0 fail** (312 pre-existing across the same 20 files, unchanged + 16 new
in this file − 1 counted overlap in per-file tallies; per-file counts reconciled) — see §4.

## 4. Verification actually executed

1. Full suite: `bun test` → **327 pass / 0 fail** (21 files). Pre-existing coverage
   confirmed intact by per-file counts (312 across the 20 prior files; nothing removed).
2. `bunfig` behavior: app-suite root run discovers only `tests/` (workspaces excluded);
   `bun test` **inside** `data/giftz-workspaces/<id>` still runs the workspace's own 13
   tests (0 fail on the fixed workspace); explicit file targeting works.
3. `bun run lint` → 0 problems. `bunx tsc --noEmit` → clean.
4. **Real gateway, scripted verification** (`scripts/p4-fix-verify.ts`, since removed):
   the exact original request through `createGatewayGiftzProvider` on the ledger-kit
   starter → one plan call (12.1 s), no repair needed, `AWAITING_APPROVAL`,
   `CHECK every-step-target-declared: PASS`, `CHECK no-modification-before-approval: PASS`
   (clean baseline before/after), plan files = `src/lib/ledger.ts(modify)`,
   `tests/ledger.test.ts(modify)` — no invented documents.
5. **Browser E2E as demo@beanfolio.app** (`#/giftz`): the exact original request typed into
   the composer → live PLANNING → **AWAITING_APPROVAL**; plan review card renders objective,
   files (2× modify), steps (3 inspect + 2 modify_file + run tests + typecheck),
   "schema-validated"; screenshots `/tmp/p5a-plan-approved.png`,
   `/tmp/p5a-after-restart-plan.png`. Honest intermediate runs: two earlier UI attempts
   FAILED while the new failure modes were being diagnosed — their persisted findings panels
   (error + `PLAN VALIDATION FINDINGS` + repair-attempted note) are themselves verified UI
   behavior (`/tmp/p5-plan-ui.txt`).
6. Invariants: `CHECK every-step-target-declared: PASS` (server-side, both tasks). No-files-
   modified-before-approval: PASS on the clean-baseline repo; on demo's repo the working
   tree carries the earlier COMPLETED task's applied fix (file mtimes 07:15, task created
   09:58 — untouched by this task; structurally no execution phase ran without approval).
7. **Restart persistence**: dev server killed and restarted; `#/giftz` task history intact —
   1× AWAITING_APPROVAL, 1× COMPLETED, 3× FAILED — and the persisted plan re-opens with the
   full approval card.

## 5. Known limitations

- One bounded repair remains one bounded repair: a model that fails twice still fails
  honestly (by design). Canonicalization removes the formatting classes; genuinely wrong
  content still requires a retry or a rephrase — now with actionable findings displayed.
- Canonicalization maps unambiguous synonyms only; exotic vocabulary surfaces as
  `Invalid option … (received: "…")` and is fed to the repair pass verbatim.
- Read-only manifest entries are dropped silently (the model's read intent is preserved by
  its inspect steps); this normalization is documented here rather than surfaced in the UI.
- Plans with zero file changes remain structurally impossible by Phase 4 design (files ≥ 1
  + a test command required) — correct for an engineering agent; pure-analysis requests are
  not its contract.
- Workspaces still come from the built-in starter template; no zip/git import (deferred
  from Phase 4, unchanged).

## 6. Strict-scope conformance

Planner + validation integration only; isolated execution, approval gates, allowlists,
redaction and security validators untouched (secret-path checks only gained a step-level
check — strictly additive). Phase 3 (LAXII), RIISHE, the gateway, the 942×190 banner preset
and the design pipeline are untouched. No Ollama, no external branding, no mock replacing
real execution, no production migrations, no production-readiness claim.
