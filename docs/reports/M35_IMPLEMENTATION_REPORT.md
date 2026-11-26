# M35 — Implementation Report: RIISHE Unified Creative Agent

Spec of record: `docs/M35_RIISHE_UNIFIED_CREATIVE_AGENT.md` · Baseline: `73cf553` (M33.5, PR #11) · Published head: see bean-sync verification below. Review PR opened for the owner — never self-merged.

## 1. What shipped

**12 registered creative tools** (`src/lib/riishe/creative-tools.ts`, merged into the ONE `RIISHE_TOOLS` registry) wrapping the REAL services:

| Tool | Real service wrapped | Risk/level | Verify hook |
| --- | --- | --- | --- |
| `giftz.site.plan` | `planWebsiteArchitecture` (M33.2 deterministic planner) | LOW/1 | read-only |
| `giftz.site.create` | owned `GiftzSite` draft (route-equivalent fields) | LOW/1 | re-read row |
| `giftz.task.create` | `createEngineeringTask` (AWAITING_APPROVAL flow + dedupe) | LOW/1 | re-read `AgentTask` |
| `giftz.task.status` | `loadTaskDetail` | LOW/1 | read-only |
| `giftz.task.approve` | `approveAndExecuteTask` (durable runner on the owner's workspace) | **HIGH/2** | re-read: left AWAITING_APPROVAL |
| `laxii.banner.brief` | `buildStructuredBannerBrief` + shared `persistStructuredBriefTask` | LOW/1 | re-read brief task |
| `laxii.banner.produce` | `startBriefDrivenBanner` (shared with the studio route) | MEDIUM/1 | re-read `LaxiiMessage` |
| `laxii.job.status` | owned message + version read | LOW/1 | read-only |
| `career.resume.analyze` | `analyzeReadability` + `parseJobDescription` + `mapJobRequirements` (M33.5-B) | LOW/1 | read-only |
| `career.resume.importProposal` | `buildImportProposal` (nothing persisted) | LOW/1 | read-only |
| `career.resume.tailoredCopy` | `createTailoredCopy` (master untouched) | MEDIUM/1 | re-read variant row |
| `career.coverLetter.draft` | `generateCoverLetter` (anti-fabrication guard) | MEDIUM/1 | re-read letter row |

**Supporting changes**
- Typed artefact references: `REF_FIELDS`/`REF_RESULT_KEYS` in `tools.ts`; generic ref resolution in `workflow-engine.ts` (`briefTaskRef→briefTaskId`, `giftzTaskRef→taskId`, `siteRef→siteId`, `resumeRef→conversationId`, `letterRef→letterId`, `jobRef→messageId`; legacy `draftRef`/`postRef` unchanged). A ref to a step that produced nothing FAILS the step (`dependency-missing`) — never fabricated.
- `src/lib/laxii/banner-handoff.ts`: ONE shared brief-driven banner entry (`startBriefDrivenBanner`) for BOTH the generate route and `laxii.banner.produce`; route behavior preserved (canvas truth, per-conversation + per-brief dedupe, `setBriefTaskStatus`, `startGenerationJob`).
- `src/lib/intelligence/delegation.ts`: `persistStructuredBriefTask` extracted — one persistence path for delegation and the tool.
- Planner: system prompt documents all ref keys; deterministic clauses for site-plan / banner-brief / resume-analyze; planner-friendliness via honest defaults (newest READY repository, newest master resume) with explicit failures when nothing exists.
- Specialist **`creative-producer`** (10th) with registry-checked availability; `career-guide` gains the four career-document tools.
- Streaming gap §3.3-3 closed via the retire branch: orphaned `RiisheAssistant` deleted; the tested stream route remains; the live surface keeps the action path (governance cards) — recorded honestly in the matrix.
- Capability matrix §3.1/§3.2/§3.3 refreshed (35 tools, 12 creative, 10 specialists) — the count-pinning tests verify docs against live imports.

## 2. QA evidence (M35.6)

Environment: isolated QA worktrees `/home/z/bean-qa-m35` (M35 tip) and `/home/z/bean-qa-m35-base` (untouched baseline `73cf553`), identical seeding order (`db:push → seed.ts → restore-qa-fixtures.ts → seed-professions.ts`), pinned `DATABASE_URL=file:<worktree>/db/custom.db` validated by `scripts/ops/qa-db-env.sh`.

### 2.1 Per-file QA + baseline comparison

Full per-file run (one bun process per suite, 240s per-suite timeout, both tips, same environment):

| Run | Files | Pass | Fail | Notes |
| --- | --- | --- | --- | --- |
| M35 tip (final, incl. two catalog-pin fixes) | 132 | 1944+ pass | **1** | the single failure is the pre-existing flake below |
| Untouched baseline `73cf553` | 130 | 1914 pass | **1** | identical failure |
| Skip-only (both tips) | 2 | — | — | `media-upload-http` (9 skip), `ox-opportunity-live-http` (4 skip) — live-server suites, self-skipping |

Failure classification:
- `riishe-specialists.test.ts > org-scoped tools run only with ACTIVE authorized membership re-verified server-side` — **5s per-test timeout, reproduced identically at the untouched baseline in this environment** (the sandbox gateway is reachable, so the org-checklist test's real AI call exceeds the 5s cap; it returns `llmError` instantly when no gateway is configured). Pre-existing, timing/environment-dependent — NOT an M35 regression.
- Two M35-caused catalog pins were fixed honestly during QA: the B2 "no placeholder tools" exact-registry pin and the specialist-manifest pin now include the 12 real M35 tools / the 10th specialist (both suites now fully green: 26/26 and 18 pass + the pre-existing flake).

### 2.2 Typecheck / lint / production build
- `bunx tsc --noEmit` — **0 errors** (repo-wide, QA worktree).
- `bun run lint` — **0 errors**, 14 warnings (all pre-existing: k6 anonymous default exports + unused eslint-disable directives).
- `bun run build` (production, QA worktree) — **exit 0**, full route table generated.

### 2.3 Live browser + API evidence (production build served via `next start`, QA DB, seeded fixtures)

| Evidence | What it shows |
| --- | --- |
| `agent-ctx/shots/m35-dashboard-live.json` | `GET /api/riishe/dashboard` from the running production build: catalog size **35**, all 5 `giftz.*`, 3 `laxii.*`, 4 career-document tools present |
| `shots/m35/01-logged-in-landing.png` | authenticated session on the production build |
| `shots/m35/02-riishe-landing-1440.png` | RIISHE landing with **"Creative Producer"** in the specialists strip |
| `shots/m35/03-creative-goal-sent.png` | banner/website delegation card (existing one-hop flow, unchanged) |
| `shots/m35/04-workflow-card.png` | workflow card in the live chat: **"Creative Producer: giftz site plan for a food photographer portfolio"**, steps list `1. Plan the website architecture [LOW, Ready]` with Pause/Cancel controls |
| `shots/m35/05-automation-dashboard-workflows.png` | Automations dashboard surfacing the `giftz.*` tools + "High-risk steps wait here until you approve them explicitly." |
| `shots/m35/06-workflow-history-completed.png` | dashboard history panel (reads legacy automation runs — pre-existing surface, unchanged by M35) |
| `shots/m35/07-riishe-mobile-390.png` | 390px responsive RIISHE view |

**End-to-end golden path (verified against the production build + durable queue worker):**
chat goal "giftz site plan for a documentary portfolio" → deterministic planner (`planner: deterministic`, `specialistId: creative-producer`) → `RiisheWorkflow` ACTIVE → in-process worker executed `giftz.site.plan` through the registry → step **SUCCEEDED** with the real deterministic plan (family `personal-portfolio`, 5 sitemap pages) → workflow **COMPLETED** (derived from real step outcomes). A ref-to-non-producing-step workflow FAILS honestly (`dependency-missing`) in the engine suite.

## 3. Honest limitations

- `giftz.task.approve` completes when execution is CLAIMED (EXECUTING); final file artifacts surface in the GIFTZ workspace + `giftz.task.status` — the workflow never claims results it has not re-read.
- `laxii.banner.produce` completes when the pipeline job is durably RUNNING; `laxii.job.status` reports the true DONE/FAILED outcome. In this QA environment the managed image engine returned 429 (rate limit) — the pipeline failed honestly and no fabricated success was recorded (asserted in tests).
- Cards are response-time only in chat (pre-existing); the durable state lives in the workflows API + Automations dashboard. Completed workflows do not appear in the dashboard's "Recent execution history" panel (that panel reads legacy automation runs — pre-existing surface behavior, unchanged).
- The streaming surface keeps the non-streaming action path for governance cards (matrix §3.2 records the deferral honestly).
- Avatar identity-lock stays an interactive studio flow (deferred, recorded in the spec).

## 4. Publication

- `scripts/ops/bean-sync.sh push` (fast-forward only, MAIN-ONLY, secret/runtime-data scans) — verification recorded in the publish log.
- Review PR opened for the owner from `feat/m35-riishe-unified-creative-agent` (identical content, like the M33.5 precedent). The owner merges; nothing is self-merged.

---

# M35.7 — Agent Safety & Reliability Hardening (review findings)

Spec amendment: `docs/M35_RIISHE_UNIFIED_CREATIVE_AGENT.md` §7 (M35.7 phase) · Baseline: `b8b0d9b` (M35 merge, PR #12, verified via `git fetch` + fast-forward before any work).

## 5. What changed (three review findings, no new capability surface)

**Finding 1 — approval policy for provider/AI generation.** `laxii.banner.produce` (LAXII provider generation), `career.resume.tailoredCopy` and `career.coverLetter.draft` (AI gateway generation) move from MEDIUM/level-1 to **MEDIUM/level-2** (`src/lib/riishe/creative-tools.ts`): every execution consumes the owner's provisioned budget (LAXII daily image/cost guards, shared AI budget), so it now requires the explicit owner go-ahead — the `post.schedule` MEDIUM/2 precedent. Consequences enforced everywhere without code changes to the gates: plan-time status (`initialStatusForStep`), the queue's execution gate (`mayExecuteStep`), approval-time execution, and retry re-entry. Registry and automation-policy tests updated (`tests/riishe-creative-tools.test.ts` approval-ladder pin now expects exactly four approval-class creative tools; `tests/riishe-automation-policy.test.ts` pins the three new level-2 tools against the generic risk map).

**Finding 2 — durable step-level idempotency.** `giftz.site.create` and `laxii.banner.brief` stamp their artifact with the creating workflow step: `createdViaStepId` (nullable, **unique**) on `GiftzSite` and `AgentTask` (`prisma/schema.prisma`), written in the SAME insert as the artifact (no crash window), with a P2002 fallback that re-reads the winning attempt's row under concurrent redelivery. A retry after a partially successful write (artifact committed, step result lost to a worker crash) re-attaches to the stamped artifact instead of duplicating it. Studio-created rows (null stamp) are unaffected; both tools now declare `idempotent: true`. The shared `persistStructuredBriefTask` gained an optional stamp parameter (delegation flow unchanged, still null).

**Finding 3 — typed artefact references validate against the explicit dependency graph.**
- Plan time (`createWorkflowFromPlan`): a ref param may only name an earlier step declared in that step's `dependsOn`. Forward references, self references, unknown ids and undeclared refs are rejected before anything is persisted (the dangling-ref plans the old suite relied on are now honest plan-time rejections).
- Resolution time (`resolveStepParams`, now exported for the safety suite): the referenced step must be an explicit declared dependency AND `SUCCEEDED` before its artefact resolves — honest `WorkflowError` classes `dependency-undeclared`, `dependency-failed`, `dependency-missing`; dependents of failed producers SKIP with the reason recorded.
- Engine hardening in the same class: jobs redelivered while a step is RUNNING are a quiet no-op (never concurrent double-execution; the sweep recovers stale rows); executing a SUCCEEDED step reports `already`; a REPLAYED approval on a terminal step is refused (`approveStep` terminal guard).

## 6. Tests

New suite `tests/riishe-m357-safety-hardening.test.ts` (15 tests, REAL engine + registry + database, no handler mocks) pins every requested scenario: approval bypass (queue + approval-time paths produce zero artifacts for unapproved level-2 steps), duplicate queue delivery (no double tool execution, SUCCEEDED and RUNNING states), retry-after-write (real sweep recovery → stamped-artifact re-attach for BOTH tools; the step↔artifact unique stamp proven airtight at the index level), missing dependencies, forward references, failed dependencies (engine SKIP + resolution-level refusal), and replayed approvals (execute twice → `already`, approval replay → refused, attempts/artifact/audit trail unchanged). Updated suites: `tests/riishe-creative-tools.test.ts` (approval ladder + brief→produce chain now approves the level-2 produce step through the production approval-time path), `tests/riishe-automation-policy.test.ts` (level-2 pins + plan-time dangling-ref rejections), `tests/riishe-agent.test.ts` (plan-time rejection + rewritten failure-chain scenario).

## 7. QA evidence (M35.7)

Environment: isolated clones `/home/z/bean-qa-m357` (tip `1146dfe`) and `/home/z/bean-qa-m357-base` (untouched baseline `b8b0d9b`), identical seeding order (`db:push → seed.ts → restore-qa-fixtures.ts → seed-professions.ts`), pinned `DATABASE_URL` validated by `scripts/ops/qa-db-env.sh`, per-clone `MEDIA_LOCAL_ROOT`. Evidence: `agent-ctx/shots/m357/qa-evidence-summary.json`.

### 7.1 Per-file QA + baseline comparison (one bun process per suite, 240s per-suite timeout)

| Run | Files | Pass | Fail | Individual test passes | Notes |
| --- | --- | --- | --- | --- | --- |
| M35.7 tip (`1146dfe`) | 133 | 129 | **2** | 1959 | both failures classified below; `tests/riishe-m357-safety-hardening.test.ts` 15/15 pass |
| Untouched baseline (`b8b0d9b`) | 132 | 129 | **1** | 1926 | identical known flake |
| Skip-only (both) | 2 | — | — | — | `media-upload-http` (9 skip), `ox-opportunity-live-http` (4 skip) — live-server suites, self-skipping |

Failure classification (zero M35.7 regressions):
- `tests/riishe-specialists.test.ts` — **pre-existing baseline flake** (5s per-test timeout on the org-checklist test's real AI gateway call), reproduced identically at the untouched baseline in this environment; recorded in the M35.6 baseline taxonomy.
- `tests/ox-salary-boundary.test.ts` — **transient SQLITE_BUSY (database is locked)** under 2-shard parallel execution; passes 2/2 in isolated per-file runs (the protocol's intended mode). Not an M35.7 regression.

### 7.2 Typecheck / lint / production build

- `bunx tsc --noEmit` — **0 errors** (tip clone).
- `bun run lint` — **0 errors**, 14 warnings (all pre-existing: k6 anonymous default exports + unused eslint-disable directives).
- `bun run build` (production) — **exit 0**; the 11 Edge-Runtime `process.exit` warnings in `src/instrumentation.ts` traces are **pre-existing** (verified by building the baseline clone: identical exit 0 with the identical 11 warnings).

### 7.3 Live workflow + browser evidence (production build via `next start` standalone, QA DB)

| Evidence | What it shows |
| --- | --- |
| `agent-ctx/shots/m357/01-dashboard-catalog.json` | live catalog: 35 tools; `laxii.banner.produce` MEDIUM/**level-2**, `career.resume.tailoredCopy` MEDIUM/**level-2**, `career.coverLetter.draft` MEDIUM/**level-2**, `giftz.task.approve` HIGH/level-2 |
| `04/05-workflow-awaiting-approval.json` + `05-workflow-before-approval.json` | engine-seeded brief→produce chain: brief SUCCEEDED (level 1), produce **AWAITING_APPROVAL** (level 2) — the queue never ran it |
| `06-approval-response.json` | `PATCH /api/riishe/steps/{id} {"action":"approve"}` → `executed:true`; the REAL pipeline started (real `conversationId`/`messageId`, status RUNNING; the brief's `briefTaskId` flowed through the typed `briefTaskRef` — Finding 3 resolution live) |
| `08-workflow-final.json` | both steps SUCCEEDED with verification evidence re-read from the backend |
| `09-replayed-approval-refused.json` | replayed approve on the SUCCEEDED step → **HTTP 409** (terminal) |
| `10-chat-deterministic-workflow.json` | live chat goal → deterministic planner → creative-producer workflow card (the M35 path is preserved unchanged) |
| `01/02/03/04-*.png` | authenticated landing; RIISHE surface with the specialists strip (incl. Creative Producer); Automation dashboard with the level-policy banner (L1 auto · L2 confirm · L3 typed confirm); 390px responsive |

## 8. Honest limitations (M35.7 additions)

- Step-level idempotency stamps cover the two artifact-creating tools named by the review (`giftz.site.create`, `laxii.banner.brief`). Other persistent tools keep their existing guarantees (`giftz.task.create` dedupes inside the service, `laxii.banner.produce` dedupes per conversation+brief, the AI career-document generators run at maxAttempts 1 under level-2 approval).
- The `createdViaStepId` columns are additive/nullable (no production DDL was run; dev/QA SQLite only). The unique index is what makes the step↔artifact pairing airtight; the handler's pre-check + P2002 fallback is defense in depth.
- Plan-time ref validation intentionally rejects plans the old engine tolerated (dangling `postRef`/`draftRef` values); the affected tests were rewritten to the honest shapes and the LLM planner prompt already declared the contract ("reference params take the PLANNER ID of the earlier step").

## 9. Publication (M35.7)

- `scripts/ops/bean-sync.sh push` (fast-forward only, MAIN-ONLY) after local main is fast-forwarded to the M35.7 tip; remote SHA verified: **origin/main `760be22`** (= this tip; branch gate, secret scan and runtime-data scan all passed).
- Review PR opened for the owner from `feat/m35.7-agent-safety-hardening` (M35 precedent, PR #12). The owner merges; nothing is self-merged. This final publication-verification commit rides the review branch so the PR carries a reviewable diff — the M35.7 implementation commits are already fast-forward-published on main, exactly like the M35 series before the owner merged PR #12.

---

# M35.8 — Atomic Execution & Concurrency Control (review finding)

Spec amendment: `docs/M35_RIISHE_UNIFIED_CREATIVE_AGENT.md` §7 (M35.8 phase) · Baseline: `26437bb` (origin/main, PR #13 merge; verified via `git fetch` + fast-forward before any work).

**Correction to §7.1 (M35.7 pass-count discrepancy):** the M35.7 tip row previously read "130 pass" but the machine-readable evidence (`agent-ctx/shots/m357/qa-evidence-summary.json`, corroborated by the raw per-file run log: 129 PASS + 2 FAIL + 2 SKIP-ONLY = 133 classified files, 1959 individual passes) records **129 pass** — corrected above. The underlying evidence files were always self-consistent (129 + 2 + 2 = 133).

## 10. What changed (one review finding, no new capability surface)

The durable workflow engine still claimed executions with a check-then-update pair: read the step's status, run the policy gates, then unconditionally `update` the row to RUNNING. Two workers (or two simultaneous approval requests) that both read an eligible row could both reach the unconditional write and execute the tool twice. M35.8 replaces **every** execution claim with one atomic conditional database transition and guards every terminal write on ownership. Nothing else changes: no new tools, no new capability surface, no policy edits, GIFTZ/LAXII/career-document behavior untouched, M35.7 idempotency stamps and typed-reference validation untouched.

**`src/lib/riishe/workflow-engine.ts` (one file):**
- **`claimStepExecution`** — the atomic claim: a single `updateMany` whose WHERE guard carries the expected pre-status (`READY` for queue deliveries; the existing accepted set `PENDING/AWAITING_APPROVAL/READY/FAILED` for approval-time execution, preserving approve-after-failure). Only the writer whose UPDATE matches the guard wins — exactly the status-guard pattern the durable queue core uses (documented as the portable equivalent of `SELECT … FOR UPDATE SKIP LOCKED`); no in-memory mutex, safe across processes. The loser never executes the tool.
- **Ownership token** — the post-claim `attempts` value is returned with the fresh row; **`finishClaimedStep`** guards every terminal write on `status = "RUNNING" AND attempts = token`. A stale worker whose RUNNING row was recovered by the sweep and re-claimed cannot record a second outcome: at most one SUCCEEDED/FAILED transition per execution, one audit pair, one dependent unlock cascade. The queue path's retry (`READY`) and terminal (`FAILED`) writes and the approval path's `FAILED` write are all ownership-guarded.
- **`releaseClaimIfWorkflowInactive`** — the post-claim control re-verification both entrypoints run before executing the tool: if the workflow got paused/cancelled between the pre-claim read and the claim, the claim is released honestly (PENDING under PAUSED — resume re-arms it; CANCELLED with the owner-cancellation reason under CANCELLED) and nothing executes.
- **Control transitions guarded both ways:** pause flips only still-READY steps to PENDING (a claimed RUNNING step keeps its claim — its own re-verification releases it); cancel flips only PENDING/READY/AWAITING_APPROVAL to CANCELLED and cancels the queued job only when the transition landed; resume/unlock/retry/decline/approve and the skip cascade are conditional on the expected pre-status (never resurrect a concurrently skipped/cancelled row, never clobber a live claim); the sweep's stale-RUNNING recovery re-checks the staleness predicate in its WHERE guard (a step that completed between the read and the write is never flipped back to READY — previously possible, and it would resurrect a finished execution); the sweep's due-step scheduling is conditional on PENDING; derived workflow completion is guarded on the observed workflow status; `approveStep`'s approval transition is atomic (a replayed approval that RACES a concurrent terminal transition is refused with the same error contract).
- Execution semantics preserved exactly: ownership/registry-derived risk/Level-2-3 approval requirements and the daily action cap are checked pre-claim as before; retry/backoff and durable-queue behavior are unchanged (the claim increments `attempts` once per actual attempt, exactly like the pre-M35.8 write); stale-running recovery is unchanged in strength (still recovers RUNNING rows past the staleness boundary, now without the resurrection race).

## 11. Tests (real database, controlled concurrency barriers — never hand-set RUNNING states)

New suite `tests/riishe-m358-concurrency.test.ts` — **12 tests, 97 assertions, REAL engine + registry + database** (no handler mocks; every claim/recovery/outcome goes through real engine code; races are driven by controlled barriers that release two real call paths into the same event-loop tick, plus engine-level `Promise.all` races):
1. two workers claim the same READY step simultaneously → exactly one atomic claim wins; a wrong ownership token is refused while the owner's token lands;
2. two workers execute the same READY step through the REAL queue entrypoint → one attempt, one artifact (unstamped `post.draft` would duplicate on any leak), one `step_succeeded` audit + one tool audit;
3. duplicate delivery while another attempt is RUNNING (real claim held mid-flight, real sweep recovery) → quiet no-op, then honest recovery to SUCCEEDED;
4. two simultaneous approval requests for one level-2 step (`approveStep` → `executeApprovedStep`, the route's exact sequence) → exactly one claim/execution, the loser 409 conflict (or honest `already`), one artifact, one execution audit;
5. two simultaneous approvals of a level-2 provider generation step (`laxii.banner.produce`) → the LAXII pipeline starts exactly once (1 conversation, 1 ASSISTANT generation message);
6. cancel never clobbers a live claim (claimed step stays RUNNING through the cancel pass); a stale worker cannot bypass cancellation (recovered READY step is never scheduled on a CANCELLED workflow; stale deliveries and outcome writes are refused);
7. pause never clobbers a live claim; the post-claim re-verification (`releaseClaimIfWorkflowInactive`) releases to PENDING without executing;
8. engine-level races: delivery vs cancel and delivery vs pause launched together → single-execution invariants hold under any interleaving;
9. stale-worker recovery: the recovered attempt's stale outcome write is refused by the ownership token; the live attempt's result stands (one stamped artifact, one audit);
10. duplicate simultaneous deliveries of a stamped artifact tool → exactly one artifact (budget consumed once);
11. claim-status surfaces pinned (`READY`-only queue claims; `PENDING` scheduled steps can never be queue-claimed).

Existing M35.7 safety-hardening suite re-run on the changed engine: **15/15 pass**. Focused RIISHE suites re-run per-file: riishe-agent 22/22, riishe-automation-policy 26/26, riishe-automation 28/28, riishe-creative-tools 27/27, riishe-chat-reliability 20/20, riishe-direct-access 19/19, riishe-persona-contract 13/13, universal-studio-capability-matrix 19/19.

## 12. QA evidence (M35.8)

Environment: isolated worktrees `/home/z/bean-qa-m358` (tip `48d130d`) and `/home/z/bean-qa-m358-base` (untouched baseline `26437bb`), identical seeding order (`db:push → seed.ts → restore-qa-fixtures.ts → seed-professions.ts`), pinned `DATABASE_URL` validated by `scripts/ops/qa-db-env.sh`, per-worktree `MEDIA_LOCAL_ROOT`, one bun process per suite. Evidence: `agent-ctx/shots/m358/qa-evidence-summary.json`.

### 12.1 Per-file QA + baseline comparison

| Run | Files | Pass | Fail | Individual test passes | Notes |
| --- | --- | --- | --- | --- | --- |
| M35.8 tip (`48d130d`) | 134 | 131 | **1** | 1971 | the only failure is the pre-existing flake below; `tests/riishe-m358-concurrency.test.ts` 12/12 pass |
| Untouched baseline (`26437bb`) | 133 | 130 | **1** | 1959 | identical known flake |
| Skip-only (both) | 2 | — | — | — | `media-upload-http` (9 skip), `ox-opportunity-live-http` (4 skip) — live-server suites, self-skipping |

Zero M35.8 regressions: **+1 file (the new concurrency suite) and exactly +12 individual passes; the identical single failure on both tips** is `tests/riishe-specialists.test.ts` (18 pass / 1 fail on both) — the documented pre-existing 5s-timeout flake on the org-checklist test's real AI gateway call, reproduced identically at the untouched baseline. Environment honesty note: an earlier QA attempt showed `tests/queue-reliability.test.ts` failures because interrupted background runs had left stale QUEUED jobs in the shared QA database; the databases were reseeded with the full protocol order and the entire battery re-run cleanly — the numbers above are from the clean runs and queue-reliability passes 9/9 on both tips.

### 12.2 Typecheck / lint / production build
- `bunx tsc --noEmit` — **0 errors** (tip).
- `bun run lint` — **0 errors**, 14 warnings (all pre-existing: k6 anonymous default exports + unused eslint-disable directives).
- `bun run build` (production) — **exit 0 on BOTH tips** with the identical 5 Edge-Runtime `process.exit` warnings in `src/instrumentation.ts` traces (verified by building the baseline clone: identical exit 0, identical warnings).

### 12.3 Live workflow + browser evidence (production build via `next start` standalone, QA DB, in-process durable worker)

| Evidence | What it shows |
| --- | --- |
| `agent-ctx/shots/m358/01-dashboard-catalog.json` | live catalog: 35 tools; `laxii.banner.produce` MEDIUM/**level-2**, `career.resume.tailoredCopy` MEDIUM/**level-2**, `career.coverLetter.draft` MEDIUM/**level-2**, `giftz.task.approve` HIGH/level-2 — M35.7 approval policy preserved |
| `04-workflow-awaiting-approval.json` | engine-seeded brief→produce chain drained by the production worker: brief SUCCEEDED (level 1), produce **AWAITING_APPROVAL** (level 2) — the queue never ran it |
| `06-approval-response-A.json` + `06-status-A.txt` | **the M35.8 live race**: two SIMULTANEOUS approval PATCH requests on the SAME level-2 step fired against the running production build — request A → **HTTP 200 `{"executed":true,…}`** (real pipeline start) |
| `06-approval-response-B.json` + `06-status-B.txt` | request B (simultaneous) → **HTTP 409 `{"error":"This step is already running"}`** — the loser never executed the tool |
| `07-db-probe.json` | post-race database verdict **`EXACTLY-ONE-EXECUTION`**: produce attempts=1, 1 BANNER conversation, 1 ASSISTANT generation message, 1 `step_succeeded` audit, 1 tool audit — no duplicate provider generation, no duplicate budget consumption |
| `08-workflow-final.json` | both steps SUCCEEDED, produce attempts=1 with verification evidence |
| `09-replayed-approval-refused.json` + `09-replay-status.txt` | replayed approve on the SUCCEEDED step → **HTTP 409** (terminal — M35.7 replay protection preserved) |
| `10-chat-deterministic-workflow.json` | live chat goal → deterministic planner → creative-producer workflow (the M35 path preserved unchanged) |
| `01/02/03/04-*.png` | authenticated landing; RIISHE surface with the specialists strip (incl. Creative Producer); Automation dashboard with the level-policy banner (L1 auto · L2 confirm · L3 typed confirm) and live KPIs; 390px responsive |

## 13. Honest limitations (M35.8 additions)

- The atomic claims make step execution exactly-once at the CLAIM level (one attempt, one outcome write, one audit per execution). Recovery remains at-least-once by design: a worker that dies mid-tool is recovered by the sweep and the step legitimately runs again on the next claim — the stamped artifact tools re-attach (never a duplicate artifact) and the ownership token guarantees only ONE recorded outcome, but the external effect of a single un-stamped tool can still occur twice across such a crash-recovery cycle. Honest durable-queue trade-off, unchanged by M35.8.
- The deterministic race tests hold a claim via the exported atomic claim primitive (`claimStepExecution`) and release it via the engine's own recovery paths — no status is ever hand-set; the true-simultaneity proofs are the barrier tests and the engine-level `Promise.all` races.
- Pre-existing quirk observed while testing (unchanged, recorded): `resume` re-arms only PENDING steps with declared, satisfied dependencies (`deps.length > 0`), so a dependency-free step paused from READY stays PENDING until an explicit retry.

## 14. Publication (M35.8)

- `scripts/ops/bean-sync.sh push` (fast-forward only, MAIN-ONLY) after local main is fast-forwarded to the M35.8 tip; remote SHA verified after push (branch gate, secret scan and runtime-data scan all passed).
- Review PR opened for the owner from `feat/m35.8-atomic-concurrency`. The owner merges; nothing is self-merged. No production DDL, deployment, DNS change or paid provisioning.

Publication verification (M35.8): `scripts/ops/bean-sync.sh push` fast-forwarded origin/main from `26437bb` to the M35.8 tip **`f259aee`** (branch gate: on main, MAIN-ONLY publishing; secret scan + runtime-data scan passed; remote SHA verified after push). Review PR opened for the owner from `feat/m35.8-atomic-concurrency` — the owner merges; nothing is self-merged. This publication-verification commit rides the review branch so the PR carries a reviewable diff; the M35.8 implementation commits are already fast-forward-published on main, exactly like the M35 series before the owner merged PR #12/#13.
