# M35 — RIISHE Unified Creative Agent

Status: **Implemented (this document is the spec of record for the M35 commit series).**
Baseline: `73cf553` (M33.5 merge, PR #11). Branch: `main` (bean-sync fast-forward only), review PR opened for the owner — never self-merged.

## 1. Problem

The capability matrix (§3.2/§3.3, baseline `74123a5`/`73cf553`) records three honest gaps:

1. **Zero `giftz.*` tools registered in `RIISHE_TOOLS`** — RIISHE can only hand off to GIFTZ via a one-hop durable brief (`src/lib/intelligence/delegation.ts`); it cannot plan or execute a governed GIFTZ step.
2. **Zero `laxii.*` tools registered in `RIISHE_TOOLS`** — same for visual production.
3. **The career-document services (M33.5)** — deterministic resume analysis, import proposals, tailored copies and the guarded cover-letter writer — are reachable only from the LAXII studio, not from RIISHE's registered tool layer.

Additionally the streaming chat route (`/api/ai/chat-stream`) is tested but its UI consumer is orphaned; the live RIISHE surface (`IntelligenceView`) uses the non-streaming `/api/ai/chat`.

M35 closes these gaps **through the existing registry and the existing durable workflow engine** — no second registry, no bypass of approval/policy machinery, no fabricated capability.

## 2. Non-negotiable invariants

- Every capability is a **registered tool** (`defineTool` in `src/lib/riishe/tool-contracts.ts`) with a strict zod input schema, registry-derived risk/level, timeout, retry policy, idempotency flag, audit action, honest undo story and (for persistent effects) a **verify hook that re-reads the persistent output from the backend before success is recorded**.
- Handlers receive only `ToolContext` (owner userId + workflow/step ids). Every handler re-verifies ownership server-side (`userId` scoping) exactly like the underlying API routes.
- The planner may only reference registered tools (`createWorkflowFromPlan` validates every step); risk/approval always come from the registry, never model output.
- Approval ladder unchanged: Level-2/3 tools (`toolApprovalRequired`) wait for explicit owner approval; the queue never executes them; DESTRUCTIVE additionally requires the typed confirm interaction. **No new tool spends money, publishes, sends, deletes or connects third-party accounts.** `giftz.task.approve` executes file edits **inside the owner's own GIFTZ workspace** after explicit confirmation — it is HIGH/Level-2 and never runs from the queue unapproved.
- Existing quotas still apply end-to-end: LAXII daily image/cost guards (`/api/laxii/generate`), GIFTZ repo ownership + task attempt caps, RIISHE daily automation action cap, AI gateway budget.

## 3. Registered tools added (`src/lib/riishe/creative-tools.ts`)

All handlers call the REAL services (`src/lib/giftz/*`, `src/lib/laxii/*`) — the same code the studio APIs run. Nothing is mocked at runtime; nothing invents outputs.

| Tool | Wraps | Risk / level | Verify (re-read evidence) | Undo story |
| --- | --- | --- | --- | --- |
| `giftz.site.plan` | `planWebsiteArchitecture` (deterministic planner, M33.2) | LOW / 1 | none (read-only) | null |
| `giftz.site.create` | `GiftzSite` draft creation (owner-scoped, same fields as `POST /api/giftz/sites`) | LOW / 1 | re-reads the row (owner, title) | Delete the draft in Website Studio |
| `giftz.task.create` | `createEngineeringTask` (inspect → plan → AWAITING_APPROVAL) | LOW / 1 | re-reads the `AgentTask` row (agent `CODE_GIFTZ`, owner) | Cancel the task in the GIFTZ workspace |
| `giftz.task.status` | `loadTaskDetail` | LOW / 1 | none (read-only) | null |
| `giftz.task.approve` | `approveAndExecuteTask` (EXECUTING on the owner's workspace) | **HIGH / 2** | re-reads the task transitioned out of `AWAITING_APPROVAL` | Revert via the task's revert action while versions remain |
| `laxii.banner.brief` | structured banner brief built from own data (`buildStructuredBannerBrief`) + durable `AgentTask(BANNER_DESIGN)` persistence (shared with the delegation flow) | LOW / 1 | re-reads the brief task (structured brief present, AWAITING_APPROVAL) | Cancel the brief task in the LAXII brief panel |
| `laxii.banner.produce` | extracted `startBriefDrivenBanner` — the same code path `POST /api/laxii/generate` uses for brief-driven banners (canvas truth, dedupe, `startGenerationJob`) | MEDIUM / 1 | re-reads the RUNNING `LaxiiMessage` row (owned) | Delete the generation message / conversation in LAXII |
| `laxii.job.status` | owned `LaxiiMessage` + version/media read | LOW / 1 | none (read-only) | null |
| `career.resume.analyze` | `analyzeReadability` + `parseJobDescription` + `mapJobRequirements` (M33.5-B, deterministic) | LOW / 1 | none (read-only) | null |
| `career.resume.importProposal` | `buildImportProposal` (deterministic extraction proposal — **nothing is persisted**) | LOW / 1 | none (read-only) | null |
| `career.resume.tailoredCopy` | `createTailoredCopy` (non-destructive variant of an owned master resume) | MEDIUM / 1 | re-reads the variant row (`variantKind="tailored"`, parent = master) | Delete the tailored copy conversation in Resume Studio |
| `career.coverLetter.draft` | `generateCoverLetter` (anti-fabrication guard, private letter row) | MEDIUM / 1 | re-reads the letter row (owner, schema version) | Delete the letter in Cover Letter Studio |

Level-1 MEDIUM tools follow the existing registry precedent (`shortlist.addCreators`, `relationship.saveNote`): private, persistent, bounded effects without external visibility. Export/publish/set-as-banner remain explicit user actions in the studios.

## 4. Typed artefact references (workflow chaining)

`REF_FIELDS`/`REF_RESULT_KEYS` (in `tools.ts`) gain:

| Ref param key | Resolves from referenced step's result |
| --- | --- |
| `draftRef` | `draftTaskId` (unchanged) |
| `postRef` | `postId` (unchanged) |
| `briefTaskRef` | `briefTaskId` (`laxii.banner.brief` → `laxii.banner.produce`) |
| `giftzTaskRef` | `taskId` (`giftz.task.create` → `giftz.task.approve` / `giftz.task.status`) |
| `siteRef` | `siteId` |
| `resumeRef` | `conversationId` (`career.resume.analyze` → `career.resume.tailoredCopy` / `career.coverLetter.draft`) |
| `letterRef` | `letterId` |

`resolveStepParams` in the workflow engine resolves every ref generically through `REF_RESULT_KEYS` and throws honestly (`dependency-missing`) when the referenced step produced no such artefact. The planner system prompt documents the new ref keys.

## 5. Specialists + planner

- New specialist **`creative-producer`** ("Creative Producer") over the registered `giftz.*`/`laxii.banner.*` tools — availability re-verified from the registry on every read (`toolsAvailable`), `maxAutomationLevel: 2`, `approvalsAlwaysHuman: true`. `career-guide` gains the career-document tools.
- The deterministic planner maps single creative clauses (site plan, banner brief, resume analysis, import proposal) through `specialistStepForClause` — only with honest, minimal params. Multi-step creative chains (brief → produce, task create → approve) are planned by the LLM planner and validated by the engine like every other plan.
- Dashboard/tool counts remain derived from the live registries (no hard-coded numbers in routes).

## 6. Streaming surface (gap §3.3-3)

`IntelligenceView` (the live RIISHE surface) is wired to `/api/ai/chat-stream` (SSE) with the existing non-streaming `/api/ai/chat` as an automatic fallback on stream failure — the orphaned `RiisheAssistant` component is **retired** (deleted) rather than wired in, so exactly one chat surface remains. The stream route's contract (plan cards, workflow events) is unchanged.

## 7. Phases (each committed and tested separately)

- **M35.1** — service extraction: `src/lib/laxii/banner-handoff.ts` (`startBriefDrivenBanner`) used by both the generate route and the `laxii.banner.produce` tool; `persistBannerBriefTask` exported from `delegation.ts`.
- **M35.2** — `creative-tools.ts` (all 12 tools) merged into `RIISHE_TOOLS`; generic ref resolution in the engine.
- **M35.3** — specialist + deterministic planner clauses.
- **M35.4** — streaming wiring + orphan retirement.
- **M35.5** — tests + capability matrix updates (`tests/universal-studio-capability-matrix.test.ts` inverts the "no giftz.*/laxii.* tools" pin honestly; counts updated from live registries).
- **M35.6** — QA battery: per-file test QA + baseline comparison (22-failure baseline taxonomy), `tsc --noEmit`, `bun run lint`, production build in an isolated QA worktree.
- **M35.7** — agent safety & reliability hardening (review findings): (1) `laxii.banner.produce` (LAXII provider generation) and the AI career-document generators (`career.resume.tailoredCopy`, `career.coverLetter.draft`) move from MEDIUM/level-1 to **MEDIUM/level-2** — every execution consumes the owner's provisioned provider/AI budget, so it now requires explicit owner approval (the `post.schedule` MEDIUM/2 precedent); registry + automation-policy + creative-tools tests updated; (2) **durable step-level idempotency** for `giftz.site.create` and `laxii.banner.brief`: the artifact row is stamped with `createdViaStepId` (nullable unique column on `GiftzSite` + `AgentTask`, committed in the SAME insert; P2002 fallback re-attaches under concurrent redelivery), so a retry after a partially successful write re-attaches to the stamped artifact instead of duplicating it; both tools now declare `idempotent: true`; (3) **typed artefact references are validated against the explicit dependency graph** — plan time: a ref param may only name an earlier step declared in that step's `dependsOn` (forward references, self references, unknown ids and undeclared refs are rejected before anything is persisted); resolution time: the source step must be an explicit declared dependency AND `SUCCEEDED` before its artefact resolves (`dependency-undeclared` / `dependency-failed` / `dependency-missing` are honest WorkflowError classes); plus engine hardening: duplicate/early-redelivered queue jobs for a RUNNING step are a quiet no-op (never concurrent double-execution; the sweep recovers stale rows), and replayed approvals on terminal steps are refused. Tests: `tests/riishe-m357-safety-hardening.test.ts` pins approval bypass, duplicate queue delivery, retry-after-write, missing dependencies, forward references, failed dependencies and replayed approvals against the REAL engine + registry + database.

## 8. Honest limitations (recorded, not hidden)

- `giftz.task.approve` starts the durable GIFTZ runner; the workflow step completes when execution is **claimed** (EXECUTING). Final artifacts surface in the GIFTZ workspace and via `giftz.task.status` — the workflow never claims file results it has not re-read.
- `laxii.banner.produce` completes when the generation job is durably **queued and running** (`LaxiiMessage` RUNNING, dedupe honored) — and, since M35.7, only after the owner's explicit level-2 approval. Rendered assets are verified by the LAXII pipeline itself; `laxii.job.status` reports the true outcome (DONE/FAILED + real version/media ids) for truthful summaries.
- AI-dependent tools (`career.resume.tailoredCopy`, `career.coverLetter.draft` — both level-2 since M35.7, `laxii.banner.*` engine calls) fail honestly on gateway/provider unavailability — no fabricated drafts.
- Scanned-image resume text extraction remains deferred (M33.5 decision): `career.resume.importProposal` accepts text only.
- Avatar identity-lock production stays a studio flow (`/api/laxii/avatar-identity`, two-phase confirmed) — deliberately not registered as a tool in M35 (its confirmation UX is inherently interactive); recorded for a later milestone.
- The streaming surface keeps the non-streaming fallback for environments that terminate SSE early; both routes keep their existing auth, rate limits and audit behavior.
- Step-level idempotency stamps (M35.7) cover `giftz.site.create` and `laxii.banner.brief` — the two artifact-creating tools named by the review. Other persistent tools keep their existing guarantees (`giftz.task.create` dedupes inside the service, `laxii.banner.produce` dedupes per conversation+brief, `career.*` generation tools run at maxAttempts 1 under level-2 approval).
