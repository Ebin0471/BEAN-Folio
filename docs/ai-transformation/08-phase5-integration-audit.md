# Phase 5 audit — CODE GIFTZ × LAXII workflow integration

Audit-first record (no Phase 5 code was written before this document). Sources read:
`05-laxii-phase3-delivery.md`, `07-code-giftz-phase4-delivery.md`,
`07a-code-giftz-planner-fix-delivery.md`, `02-architecture.md`, worklog Tasks 33–35,
`prisma/schema.prisma`, `src/lib/giftz/*`, `src/lib/laxii/*` (service, jobs, router,
design-brief, banner-pipeline, quality, banner-presets, intent), `src/lib/intelligence/
delegation.ts`, `src/lib/ai.ts` (gateway), `src/lib/storage.ts`, media routes, giftz task
routes, both agent UIs.

## 1. What already exists (reused, NOT reimplemented)

**CODE GIFTZ engineering pipeline (Phase 4 + planner fix):**
- Durable `ENGINEERING_TASK` lifecycle on `AgentTask`
  (QUEUED→ANALYZING→PLANNING→AWAITING_APPROVAL→EXECUTING→VALIDATING/TESTING→
  COMPLETED/FAILED/CANCELLED), persisted at every transition; restart sweep honestly fails
  interrupted runs; bounded retry (3); per-file revert; duplicate prevention (one active
  task per repo per user).
- Read-only repository inspection digest, zod plan schema + semantic validator + ONE bounded
  structured repair + vocabulary canonicalization (Task 35), allowlisted command runner,
  git-powered diffs, approval/reject/cancel/retry/revert routes — all ownership-gated and
  404-indistinguishable across users.

**LAXII creative pipeline (Phases 2–3):**
- Async generation jobs (`startGenerationJob`): USER+RUNNING messages → DONE/FAILED, stale
  sweep, idempotent version persistence, safe errors; REAL managed-provider rendering with
  the banner pipeline (structured brief → generate → deterministic typography → measured
  quality evaluation → bounded refinement → exact-canvas export).
- Zod-validated versioned `DesignBrief` (canvas authority 942×190 preserved),
  `buildStructuredBannerBrief` + `compileBriefPrompt`, `runBannerPipeline`,
  `parseDesignBrief` — the proven creative path from the RIISHE delegation.
- `storeGeneratedMedia` → `MediaAsset` (owner, kind, mime, size, **width/height**, READY
  status, private storagePath) and `loadOwnedMediaAsReferences` (ownership-verified loading
  that throws when any id is missing/not owned).

**Shared BEAN Intelligence infrastructure:**
- `AgentTask` **already has** `parentTaskId`/`childTasks` (agentTaskTree) — task
  relationships persist today; handoffs can link immediately. `repoId` links to
  `GiftzRepository`.
- The RIISHE→LAXII delegation (`src/lib/intelligence/delegation.ts`) is the established
  handoff pattern: AgentTask (`kind BANNER_DESIGN`) + structured brief in resultJson +
  approval gates + decision/generation records.
- Provider-agnostic gateway (`aiComplete`) with agent/feature tags, usage + cost-estimate
  records, redaction discipline; `recordAiUsage` quota accounting.
- `MediaAsset` served ONLY via `/api/media/[id]/raw` (ownership/visibility enforced;
  private storage paths and credentials never leave the server).
- Both UIs (`GiftzView` #/giftz, `LaxiiView` studio) already render live task state,
  approval cards, diffs, quality reports in the obsidian-black + champagne-gold system.

## 2. Exact missing functionality (to build in Phase 5)

1. **Shared artifact-reference mechanism** — nothing links a generated asset to a task
   pair today. `LaxiiImageVersion` links media to a conversation message only; there is no
   cross-capability artifact record, no TTL/expiry, no consumption state, no
   source/destination task tracking. → new additive `AgentArtifact` model + `artifacts.ts`
   (ownership + mime allowlist + size + dimensions verified at registration; status
   ACTIVE→CONSUMED/EXPIRED/MISSING resolved honestly; mediaId references only — storage
   paths never cross a boundary).
2. **Orchestration layer for authorized handoffs** — the four directions need a controlled
   creator with: source task id, destination capability, ownership, structured description,
   authorized context only, artifact refs, required approvals, execution status, completion
   result; duplicate prevention per source; retry/cancel. → `src/lib/intelligence/handoff.ts`
   building linked `AgentTask` rows (parentTaskId) with approval gates.
3. **Workflow 1 (CODE GIFTZ → LAXII)** — creative-asset request from an engineering
   context: inspect repo → propose structured brief → approval → REAL LAXII banner pipeline
   (quality evaluation retained by LAXII) → validated asset (dims 942×190, mime, ownership)
   → registered artifact → **separate** integration approval → asset bytes + code applied in
   the isolated workspace (deterministic asset-file write; model edits only code) → tests →
   diff → report.
4. **Workflow 2 (LAXII → CODE GIFTZ)** — "integrate into website" follow-up: structured
   engineering handoff with the asset reference + integration requirements → user approval →
   real giftz planning/plan-approval/execution on the authorized repo (artifact bytes
   substituted deterministically for the asset file step) → validation → report.
5. **UI** — cross-capability handoff cards (source/destination identification, asset
   preview via `/api/media/[id]/raw`, brief review, approve/reject/cancel), task
   relationship history (parent chain), final integration report; LaxiiView entry point for
   Workflow 2. No redesign of unrelated interfaces.
6. **Dedup/idempotency across handoffs** — one active handoff per source task; artifact
   consumption is single-shot (prevents duplicate generation and duplicate repository
   modifications on retry); plan-level duplicate prevention reused for the engineering leg.

## 3. Security boundaries carried into Phase 5 (unchanged)

- No repository modification without the CODE GIFTZ approval gate; LAXII generation NEVER
  triggers repository modifications (Workflow 1 integration is a separate, second gate).
- Cross-user protection: every handoff/artifact read is userId-scoped, 404-indistinguishable.
- Isolated workspace execution, allowlisted commands, redaction, timeouts, kill registry —
  untouched. No validator is weakened; plan schema strictness preserved (asset files are
  declared in the manifest; their BYTES come from the approved artifact, never from the
  model — content substitution is deterministic and recorded in the edit record).
- No Ollama, no external model branding, no invented identifiers; gateway calls stay tagged.
- No storage credentials or private URLs in any payload, log or UI state (mediaId + `/api/
  media/[id]/raw` only).
- Schema changes are strictly additive (new table + documented kind vocabulary); no
  destructive migration, no production data moves.

## 4. Test strategy (aligned with existing suites)

Unit/integration tests (deterministic, no live provider — house pattern from
`laxii-banner-phase3.test.ts`): artifact ownership/missing/expired/mime/size; handoff
authorization, approval, rejection, cancellation, duplicate prevention, retry idempotency,
cross-user access, restart persistence (real DB rows, real workspaces, scripted model
calls). REAL asset generation and REAL engineering execution are verified by browser E2E
with the configured managed gateway + real `bun test` subprocesses (the Phase 3/4 pattern).

## 5. Explicit non-goals (scope discipline)

No Phase 3/4 reimplementation; the 942×190 banner preset and quality evaluation are
preserved as-is; RIISHE untouched; no website builder; no zip/git workspace import (Phase 4
deferral stands); no production migration or readiness claim.
