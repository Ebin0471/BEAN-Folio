# Phase 4 pre-code audit — CODE GIFTZ Engineering Agent

Audit performed before any Phase 4 code was written. Companion docs:
`01-repository-audit.md` (P0), `02-architecture.md` (P1), `03-laxii-phase3-audit.md` (P3),
`05-laxii-phase3-delivery.md` (P3 delivery), worklog Tasks 32–33.

Method: every file under `src/lib/ai-design/` read in full; all four design API routes read in
full; `CodeGiftzPanel.tsx` and the Code-Giftz parts of `WebsiteBuilderView.tsx` read;
`AgentTask` model + every usage traced; gateway/circuit/registry/storage/media/tempstore read;
auth, api-helpers, test infrastructure and scripts inventoried; filesystem layout and git state
verified live. Line references below were verified against the working tree at audit time.

---

## 1. What CODE GIFTZ already implements

CODE GIFTZ today is a **site-config mutation pipeline** — a mature, well-guarded design agent,
not a code agent. It plans, gets approval, executes and verifies changes to a validated
`SiteConfig` JSON document (`src/lib/site-config.ts:504-553`), rendered by `SiteRenderer`.

### 1.1 Library (`src/lib/ai-design/`, 12 files)

| File | What it provides |
|---|---|
| `jobs.ts` (181 L) | In-memory job store on `globalThis.__beanDesignJobs` (Map). `DesignJob` = id/userId/status (queued·running·completed·failed·cancelled)/plan/baseConfig/working/steps/changes/verification. Finished jobs pruned after 30 min, ≤4 per user, **single-flight per user** (`JobConflictError` → HTTP 409). Cooperative `cancelRequested`; `prepareRetry` resets failed/skipped steps only. Ownership structural: every accessor takes `userId` (`jobs.ts:100-104`). |
| `plan.ts` (484 L) | Strict zod plan schema (`designPlanSchema`: reply/notes/constraints/clarifyingQuestion/steps ≤8; `planStepSchema`: id/title/tool/kind/targets ≤16/instruction ≤4000/patch/dependsOn ≤8 restricted to earlier steps → ordered DAG). `coerceDesignPatch` folds model-style flat keys into canonical groups. `validatePlan` returns `PlanIssue[]` (11 codes) resolving library ids against real PALETTES/presets. Bounded self-repair for constraint-only issues (`dropUngroundedConstraints`, `dropUnresolvableConstraints`). |
| `tools.ts` (174 L) | 15-tool registry, deterministic (token/font/motion/palette/preset/template) + model-scoped (section/page/content/compose). `UNSUPPORTED_CAPABILITIES` honestly declares custom code editing, form builders, image generation, publishing, embeds, custom domains **out of scope today**. |
| `execute.ts` (360 L) | `runDesignJob` — steps in plan order, cancellation at step boundaries, dependents-of-failed skipped, constraint enforcement after every step with byte-identical `restorePreserved` repair. Injected `StepProvider` makes the whole pipeline testable without network. |
| `constraints.ts` (260 L) | Natural-language protected-region targets → canonical kinds → JSON-equality checks + byte-identical restore. |
| `verify.ts` (183 L) | 7 verification checks (schema/fonts/WCAG contrast/motion/structure/preserved-identity/section-id stability); anything un-runnable is honestly `untested`. |
| `digest.ts` (279 L) | Deterministic `SiteDigest` inventory shared by prompts, panel and validators. |
| `diff.ts` (61 L) | `summarizeChanges` — **prose before/after summaries, not patches**; `aggregateStepChanges`. |
| `prompts.ts` (226 L) | Persona + honesty block (Code Giftz vs RIISHE separation), schema doc rendered from real libraries. |
| `context.ts` (41 L) | Owner-scoped portfolio grounding fetch. |
| `ingest.ts` (380 L) | Site materials pipeline (≤12/user, PDF/image extraction, ≤5 images per batched vision call). |
| `browser-checks.ts` (173 L) | Pure evaluators (overflow/assets/runtime/structure/links) fed by real iframe DOM measurements. |

### 1.2 API routes (`src/app/api/ai/design/`)

- `plan/route.ts` (192 L): request 3–1000 chars → session 401 → `aiGate` → server-computed digest (never trusts client digest) → `aiComplete` (deep, 120 s) → `reply | plan | invalid` kinds; two-stage constraint self-repair; nothing persisted, nothing executed.
- `execute/route.ts` (103 L): plan **re-validated against the real current config** (stale/tampered → 422) → `createJob` (409 on conflict) → fire-and-forget `runDesignJob` → `{jobId, status}` 202-style; polling at `/job`.
- `job/route.ts` (97 L): GET latest/by-id (ownership-enforced; config payload only when finished); POST `cancel | retry` (retry re-runs `aiGate` with rollback on block).
- `audit/route.ts` (141 L): read-only review grounded in digest + **real** `browserEvidence` from the live preview iframe; per-item validated findings; never returns config.

### 1.3 UI

`CodeGiftzPanel.tsx` (1401 L): consent gate → plan (fix|create workflows, materials, abortable) → approve (client stale-guard comparing base config, `CodeGiftzPanel.tsx:549-557`) → poll every 1500 ms (404 → "execution record expired"; 5 failures → give up) → review (verification report + browser checks + changes + preview/retry/discard) → audit loop. `WebsiteBuilderView.tsx` mounts it with `forceMount`, applies proposals **only as preview** (never saves/publishes — the user does), stale-proposal guard (`:864-873`), real iframe browser checks (`:1573-1664`), `SiteRevision` snapshots as the recovery net.

## 2. What functionality is incomplete (Phase 4 gap matrix)

| Capability (spec §) | Status | Evidence |
|---|---|---|
| Structured plan schema + validation (§4) | ✅ exists for SITE design; ❌ no ENGINEERING plan schema (files/steps/risks/validation-commands) | `plan.ts` scope |
| Bounded plan repair (§4) | ✅ pattern exists (constraint repair, ≤1 repair in plan route) — reusable idiom | `plan/route.ts:152-176` |
| Repository inspection (§3) | ❌ none — agent sees only SiteConfig JSON + portfolio text; no file tree, no source reading, no repo map | `digest.ts` scope |
| Reading source files (§3, §5) | ❌ no source-file read path anywhere in the pipeline | — |
| Patch/unified-diff generation (§5, §6) | ❌ prose summaries only; no diffs, no line-level UI | `diff.ts:14-60` |
| Approval enforcement (§6) | ✅ whole-plan approval, client stale-guard + server 422 re-validation; ⚠️ no per-step approval, no reject→task record | `execute/route.ts:62-72` |
| File writes (§5) | ❌ none — mutation surface is validated SiteConfig JSON only; explicitly declared unsupported | `tools.ts:167` |
| Command execution (§5) | ❌ **zero process spawning in the entire codebase** (no `child_process`/`spawn`/`exec` in src/, scripts/ or tests/) | audit sweep |
| Isolated execution sandbox (§5) | ❌ no workspace concept; only storage `uploads/` boundary + `data/laxii-tmp` tempstore | `storage.ts:88-95`, `tempstore.ts` |
| Test/lint/tsc execution + records (§7) | ❌ verification is config-level only; "untested" is the honest ceiling | `verify.ts:50-53` |
| Durable jobs (§8) | ❌ **in-memory `globalThis` Map only** — everything (state, logs, changes, verification) lost on restart; no DesignJob Prisma model exists | `jobs.ts:45-49` |
| Restart recovery / stale detection (§8) | ❌ none for design jobs; LAXII has the idiom to copy (`sweepStaleLaxiiJobs`, 30-min stale → FAILED) | `src/lib/laxii/jobs.ts` |
| Cancellation (§8) | ⚠️ cooperative flag only, between steps; running model calls cannot be interrupted (no `AbortSignal` threading, no child-kill) | `jobs.ts:133-142` |
| Retry (§8) | ⚠️ manual retry-from-failure exists; bounded attempts not enforced | `job/route.ts:69-95` |
| Idempotency (§8) | ⚠️ single-flight prevents concurrency but not sequential duplicate runs; no idempotency keys | `jobs.ts:65-97` |
| Task history (§9) | ❌ latest job only; ≤4 finished jobs TTL 30 min; no history list, no persisted run log | `jobs.ts:45-46` |
| Diff viewer / terminal output / test results UI (§9) | ❌ absent | `CodeGiftzPanel.tsx` |
| Secret redaction (§3, §10) | ⚠️ gateway observability never logs prompts/secrets (`observability.ts`), but no output-redaction utility exists (nothing captured output before) | `observability.ts:36-58` |

## 3. Which services can be reused (do not duplicate)

- **`AgentTask` Prisma model** (`schema.prisma:493-513`): durable, user-indexed, status/stepsJson/resultJson, `AWAITING_APPROVAL` in the documented lifecycle, task tree (`parentTaskId`, currently unused). `agent`/`kind` are free strings → additive `CODE_GIFTZ`/`ENGINEERING_TASK` usage **needs no schema change for the core**. RIISHE delegation already persists `kind: "WEBSITE_DESIGN"` tasks; LAXII stamps `RUNNING→COMPLETED/FAILED` — the lifecycle-helper idiom (`delegation.ts:386-515`) is the template.
- **Gateway**: `aiComplete` (`ai.ts:149-177`), `parseJsonFromText` (`ai.ts:238-251`), `aiGate` (consent → 6/min → 30/day shared pool), `recordAiUsage`, circuit breaker + same-capability-only fallback + honest errors. Structured-plan consumers already use exactly this stack.
- **Route idioms**: `handler()` wrapper, `parseBody` zod gate, `rateLimit`, `ERR.*`, `findFirst({ id, userId })` ownership (foreign → 404-indistinguishable).
- **Filesystem confinement idioms**: `storage.ts resolveLocalPath` (resolve + under-root check on every access) and `tempstore.ts` (root-resolved per-job dirs, `startsWith(ROOT + sep)` deletion guard, stale sweep). These two are the security template for workspaces.
- **Timeout idioms**: `Promise.race` deadlines (gateway), `AbortController`+typed timeout (diffusers provider), bounded backoff (circuit.ts).
- **Test idioms**: armed auth mocks (`globalThis.__laxiiP3Auth` pattern), route handlers imported after overrides and called with `NextRequest`, `MEDIA_LOCAL_ROOT` env redirect to `mkdtemp` for FS isolation, unique QA rows against the real dev DB with cascade cleanup.
- **Scripted-provider testing**: `StepProvider` injection proves LLM pipelines can be tested deterministically without credentials.

## 4. Are jobs still stored only in memory?

**Yes.** `src/lib/ai-design/jobs.ts:48-49` — `globalThis.__beanDesignJobs` Map; 30-min TTL; ≤4 finished per user; no Prisma model; no persistence anywhere. A server restart loses all design-job state, and the client's reconnect-on-mount (`CodeGiftzPanel.tsx:333-357`) degrades to "execution record expired". **Durable persistence is required** for the Phase 4 engineering agent (spec §8) and is the smallest safe change for design-job history (shadow-persist terminal states; live stepping unchanged).

## 5. Which database changes are necessary (all additive)

1. **New model `GiftzRepository`** — durable registry of authorized workspace repositories (owner, name, status, timestamps). Path is **derived from the row id** (never stored from user input): `<workspaces-root>/<repoId>`.
2. **`AgentTask.repoId String?`** — optional link from an engineering task to its repository (queryable for sweeps and per-repo single-flight).
3. **`AgentTask` schema comment** — document the additive Phase 4 status vocabulary (`QUEUED·ANALYZING·PLANNING·AWAITING_APPROVAL·EXECUTING·VALIDATING·TESTING·COMPLETED·FAILED·CANCELLED`) for `kind: "ENGINEERING_TASK"`. Status is a plain String column → zero destructive change; existing consumers unaffected (they match their own values).
4. Both `schema.prisma` (SQLite) and `schema.postgres.prisma` (mirror) must be updated in lockstep (project convention), then `bun run db:push`.

No existing column changes, no migrations of production data, no renames.

## 6. Which security boundaries already exist

| Boundary | Where | Reuse in Phase 4 |
|---|---|---|
| Path-traversal guard (resolve + under-root) | `storage.ts:88-95`; `tempstore.ts:16-64` | Every workspace file op + git invocation confined to `<root>/<repoId>` |
| Uploads served inert, magic-byte sniffed | `media.ts:76-207` | Workspaces never write into `uploads/` and never serve executable content to other users |
| Ownership structural (`findFirst({id, userId})`) | `delegation.ts:387`, `laxii/brief/route.ts:84-100` | Every repo/task accessor |
| Consent + rate/quota gates | `ai.ts:96-111` (`aiGate`), `api-helpers.ts:45-75` | Plan/replan LLM calls |
| Secrets out of logs | `observability.ts:36-58` (no prompts/credentials); `.env` untracked, single `DATABASE_URL` line | Output redaction layer must extend this to command output |
| Error hygiene (`handler`, `ERR.*`, no stacks) | `api-helpers.ts:5-20,125-136` | All new routes |
| **Missing today** | no process execution exists → no allowlist/timeout/kill/env-sanitization infrastructure | Phase 4 must build it (`child_process` spawn, `shell:false`, argv arrays, per-command timeout + kill, env allowlist, output caps, workspace-cwd) |

Additional hard rules derived from the spec for this repo's reality:
- The BEAN Folio application itself is the **production server** — CODE GIFTZ must never edit, execute or run commands against it. Workspaces are separate, user-owned directories under a dedicated root (`data/giftz-workspaces/`, env-overridable `CODE_GIFTZ_WORKSPACE_ROOT` for tests).
- Inspection/read paths skip `.env*`, `*secret*`, `*.pem`, `*.key`, `id_rsa*`, `.git/`, `node_modules/`, binary files; command output passes a redaction filter (key=value secrets, PEM blocks, long tokens) before storage.
- Command allowlist (argv[0] ∈ `bun`/`bunx`/`node` + fixed safe subcommands), `shell:false`, workspace cwd, 120 s default timeout, 64 KB output cap, minimal env (PATH/HOME/LANG/TMPDIR only — never `DATABASE_URL`, session or S3 secrets).

## 7. Which existing tests must remain passing

All **278 tests across 18 files** (`bun test`, green as of this audit). Hard requirements:
- `tests/design-agent.test.ts` (766 L) — the website-design pipeline (plan validation, execution, constraint repair, failure/retry, cancellation, cross-user isolation, verification) must pass **unchanged**: Phase 4 is additive to `ai-design/` (shadow persistence must not alter job semantics visible to tests).
- `tests/browser-checks.test.ts`, all LAXII Phase 3 tests (`laxii-banner-phase3`, `laxii-brief-api`), gateway/branding tests, auth/storage/visibility suites.
- Conventions to respect: no global test preload (`bunfig.toml` absent), real dev DB with unique QA rows + cascade cleanup, `mkdtemp` for any filesystem isolation, armed-mock seam for auth, unique XFF keys for rate-limit collision avoidance.

## 8. Phase 4 implementation map (small steps, each verified)

| Step | Deliverable | Verified by |
|---|---|---|
| 1 | Schema: `GiftzRepository` + `AgentTask.repoId` + status-comment (both prisma schemas) → `db:push` | `bun run db:push` + existing suite |
| 2 | `src/lib/giftz/`: `types.ts`, `redact.ts`, `template.ts` (starter repo), `workspace.ts` (confinement, git baseline), `inspect.ts`, `commands.ts` (allowlist runner), `diff.ts` (git diff + parser), `plan.ts` (zod engineering plan + bounded repair), `jobs.ts` (durable AgentTask store: create/approve/execute/cancel/retry/revert/sweep/idempotency) | new unit tests (A–O) |
| 3 | API: `/api/giftz/repositories`, `/api/giftz/repositories/[id]`, `/api/giftz/tasks`, `/api/giftz/tasks/[id]`, `/tasks/[id]/approve|reject|cancel|retry|revert` | route tests (armed auth), lint, tsc |
| 4 | UI: `src/views/GiftzView.tsx` + `src/components/giftz/*` (repo explorer, composer, plan review, execution timeline, diff viewer, terminal output, test results, history), nav entry "Code Giftz", route `#/giftz` | browser E2E |
| 5 | Design-job durability: shadow-persist terminal design-job states as `AgentTask` rows (`kind: SITE_DESIGN_JOB`) — additive, runtime behavior unchanged | design-agent suite unchanged + new persistence test |
| 6 | Verification: full suite, lint, tsc, browser golden path (inspect → plan → approve → execute → tests pass → diff → report), restart persistence, reject/cancel/failure paths | evidence recorded in `07-code-giftz-phase4-delivery.md` |

## 9. Constraints kept from the spec

- Phase 4 only; no LAXII/banner changes (942×190 preset untouched); no RIISHE redesign; no gateway changes beyond additive consumers; no provider branding; no Ollama; no mocks replacing real behavior; no destructive schema changes; build/deploy verification not possible in this sandbox (documented honestly, as in Phase 3).
