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
| M35.7 tip (`1146dfe`) | 133 | 130 | **2** | 1959 | both failures classified below; `tests/riishe-m357-safety-hardening.test.ts` 15/15 pass |
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

- `scripts/ops/bean-sync.sh push` (fast-forward only, MAIN-ONLY) after local main is fast-forwarded to the M35.7 tip; SHA verified.
- Review PR opened for the owner from `feat/m35.7-agent-safety-hardening`. The owner merges; nothing is self-merged.
