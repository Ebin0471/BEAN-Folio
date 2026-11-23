# 21 — LAXII Prompt Composer & Generation Flow Fix + Professional Image Quality Upgrade

**Date:** 2026-11-22 · **Baseline:** `a4056e9` · **Status:** COMPLETE (both tasks)
**Owner directives:** LAXII composer/flow fix (16k prompt budget, submission flow, composer
preservation, reliability) and professional image-quality upgrade (art direction, deterministic
typography for all banners, honest quality control, benchmark evidence).

---

## Part A — Prompt composer & generation flow

### Root causes found (audited, not assumed)

| # | Finding | Evidence |
| --- | --- | --- |
| A1 | The prompt budget was capped at 4,000 chars in the service (`cleanPrompt`) and the generate-route schema; the legacy conversational route capped at 2,000 | `src/lib/laxii/service.ts:19`, `generate/route.ts` schema, `conversations.ts planTurn` |
| A2 | The live studio auto-cleared the composer the moment a generation completed (`setPrompt("")` in the poll loop's DONE branch) — violating preservation and able to wipe a mid-run draft edit | `src/components/laxii/LaxiiStudio.tsx` pollGenerationJob |
| A3 | No client-side budget guard, no character counter, no over-limit validation message | composer textarea had no `maxLength`/counter |
| A4 | The submission flow itself was already correct server-side: `startGenerationJob` persists the exact prompt as a USER message, creates the ASSISTANT RUNNING job, runs the real engine async, and the studio polls honest states — including server-side duplicate reattachment (202 `duplicate:true`) | `src/lib/laxii/jobs.ts`, `generate/route.ts` |
| A5 | A second, unmounted legacy studio (`Studio.tsx`+`Composer.tsx` → `/api/laxii/conversations/:id/messages`) exists; it is dead code (no importers) but its route still enforces a 2,000-char limit | route-level grep + import graph |

### Changes (Task A)

1. **16,000-character budget everywhere it exists**: `MAX_PROMPT_LENGTH` in
   `src/lib/laxii/service.ts`, the `prompt` schema in `src/app/api/laxii/generate/route.ts`, the
   legacy `text` schema in `src/app/api/laxii/conversations/[id]/messages/route.ts` and
   `planTurn` in `src/lib/laxii/conversations.ts`. Client mirror constant `LAXII_PROMPT_MAX`
   exported from `src/lib/laxii-client.ts`.
2. **Composer (live studio, `LaxiiStudio.tsx`)**: `maxLength` on the textarea; a subtle
   `text-[10px]` counter (`N / 16,000`) that turns amber inside the last 1,000 characters and
   destructive at the limit; a client guard with a clear message when an over-limit prompt is
   submitted. The counter is `aria-live="polite"` and `data-testid="laxii-prompt-counter"`.
3. **Composer preservation**: the DONE branch no longer clears the prompt. The submitted prompt
   stays visible during generation, after success and after failure; only reference chips are
   cleared on success. A mid-run edit can therefore never be overwritten.
4. **Duplicate protection** (verified, pre-existing + confirmed live): client `busy` gate disables
   the Generate button while a job runs; rapid double-clicks create no extra jobs; the server
   returns `202 duplicate:true` and the studio reattaches with an explanatory toast.
5. **Retry** (verified live): the FAILED thread card's "Try again" re-runs the turn from the
   recorded USER text; the server-side `POST /api/laxii/jobs/:id/retry` path exists unchanged.

### Honest engine-boundary discovery (verified by probing)

The managed image gateway REJECTS long prompts in-band: **2,399 chars OK, 2,601 rejected**
(HTTP 200 with an error payload the SDK crashes on; 429 shape also observed). Longer prompts can
therefore not be handed to the engine verbatim. Product behaviour (implemented in
`fitEnginePrompt`, `src/lib/laxii/providers/managed.ts`):

- the **full** prompt is stored verbatim in the conversation (no truncation in any validation,
  schema or persistence layer — the 16k budget is real for storage, threading and retry);
- only the **compiled engine prompt** is fitted to the 2,400-char ceiling, cut at a sentence
  boundary, with an honest warning recorded on the job and shown in the thread:
  "The engine received the first 2,286 of 8,115 compiled prompt characters … the full prompt is
  preserved verbatim in the conversation."

### Verification (Task A, executed in this session)

- Unit/route tests (`tests/laxii-prompt-limits.test.ts`, 4 tests): client/server constant equals
  16,000; `cleanPrompt` keeps exactly 16,000 and truncates 16,001; the REAL generate route
  accepts 16,000 (202) and rejects 16,001 (400); the exact prompt persists verbatim as the USER
  message; the legacy messages route enforces the same budget.
- Browser E2E (desktop 1440×900 + mobile 390×844, QA account `journey@beanfolio.test`):
  - counter reads `5,337 / 16,000` for a prompt exceeding the old 4k limit; submission returns
    202 and the exact 5,337 chars appear as the USER message;
  - prompt stays in the composer during generation (verified mid-run) and after the terminal
    state; a mid-run edit ("— EDITED MID-RUN") survived the terminal state untouched;
  - rapid duplicate clicks during a RUNNING job created no extra jobs (button disabled);
  - failed generation showed its honest error card; "Try again" re-ran the turn and produced a
    real 2048×687 banner with the engine-fit warning visible in the thread;
  - no horizontal overflow at 390px; counter, textarea and controls reachable.

## Part B — Professional image-quality upgrade

### Root causes found

| # | Finding |
| --- | --- |
| B1 | Plain banner requests bypassed the professional pipeline entirely: the user's prompt went to the engine verbatim + a canvas hint, then a cover-fit crop. Deterministic typography, composition planning, quality evaluation and bounded refinement existed ONLY for Riishe brief handoffs (`usePipeline` required `briefTaskId`). |
| B2 | The engine model renders text unreliably: benchmark prompt `titled "NIGHT FREIGHT"` produced **"NIGHT FREQUENCY"** — exact wording is not preservable by the model. |
| B3 | No art-direction interpretation: fresh generations received the prompt verbatim, so vague requests drifted into the generic AI look (dark gradients, glowing lines, floating flat-lay objects — visible in the before-banner). |
| B4 | No quality evaluation on the plain path (decode check only); no honest reporting of soft/empty/letterboxed outputs. |
| B5 | Reference-guided generations gave the model no instruction on HOW to read the reference. |

### Changes (Task B) — all reuse existing systems, no new provider, no new paid service

1. **`src/lib/laxii/art-direction.ts` (new)** — deterministic (keyword-scored) classification
   into seven professional directions (photorealistic photography, cinematic, commercial
   advertising, luxury editorial, graphic design, 3D render, illustration/concept art) plus a
   universal professional default; `compileArtDirection()` appends the matching directive block
   (lighting physics, materials, camera, composition, anti-"AI look" rules) and the honest text
   rule (exact-quotation guidance vs explicit no-text rule). The user's words stay verbatim and
   first. Wired ONLY for fresh GENERATE creations — never edits, avatar presets, style presets
   or banner-pipeline prompts.
2. **`src/lib/laxii/banner-request.ts` (new)** — compiles a plain composer banner request into
   the SAME structured `DesignBrief` the Riishe handoff uses (`source: "USER"`): exact quoted
   wording becomes deterministic typography items (max 4 × 120 chars, double-quoted strings,
   straight or typographic), the remainder becomes the scene description, the preset's safe
   area and canvas are authoritative. `canvasMatchesPreset()` keeps legacy canvas
   conversations on the old direct path instead of failing the pipeline's preset check.
3. **Pipeline wiring**: `src/app/api/laxii/generate/route.ts` builds the synthetic brief for
   plain banners; `src/lib/laxii/jobs.ts` runs the professional pipeline for ANY brief-backed
   banner (Riishe handoff or composer) while brief-linkage bookkeeping stays bound to real
   `briefTaskId`s.
4. **`src/lib/laxii/design-brief.ts`** — `source` widened to `"RIISHE" | "USER"` (provenance
   stays honest) and `request` max raised to 16,000 (consistent with the composer budget).
5. **`src/lib/laxii/quality.ts`** — new `evaluatePlainOutput()`: decode/integrity + measured
   visual metrics (Laplacian sharpness, contrast, colorfulness, letterbox, border coherence)
   for the non-pipeline path. Fail-level findings surface as visible warnings; the full report
   is stored on the message meta (`plainQualityReports`). Nothing claims AI verification that
   did not run.
6. **`src/lib/laxii/router.ts`** — reference-guided generations now receive explicit reference
   reading guidance (composition, subject placement, lighting, palette; preserve intent without
   copying artwork verbatim).

### Benchmark evidence (real renders, same prompts, before/after)

Harness: `scripts/laxii/quality-benchmark.ts` (8 repeatable tasks; full-size originals in
`/home/z/beanfolio-backups/laxii-benchmark/{before,after}/` + `metrics.json`; compressed
evidence in `agent-ctx/shots/laxii-quality/`). Highlights (all inspected visually):

| Task | Before (verbatim prompt) | After (upgraded pipeline) |
| --- | --- | --- |
| 03 movie-poster banner | Model painted **"NIGHT FREQUENCY"** — exact wording lost, text over subject | **"NIGHT FREIGHT"** rendered deterministically, scene text-free, subject placed per plan |
| 01 portfolio banner | Generic dark+gold flat-lay cliché, model-painted text (correct by luck) | Exact "ARJUN MEHTA / Product Designer — Systems & Interfaces" typography, quality loop ran (2 attempts, honest `warn` on letterbox/guidance findings) |
| 02 product ad | Competent but generic warm-gold AI grade | Controlled neutral product-photography grade, slate/material texture, directional light |
| 06 portrait | Waxy plastic skin despite explicit texture request | Visible pores/forehead texture, honest neutral grade (model-limited, improved) |

The attached-example caveat: no image file was actually attached to the task message in this
session; the failed-quality baseline was established from fresh before-benchmark renders of the
same prompts instead (honest substitute, documented).

### Remaining model limitations (stated honestly)

- The managed engine is a prompt+size image model: no native negative-prompt parameter, no
  native typography guarantee, no native upscale. Directions/directives are guidance, not
  guarantees.
- The gateway prompt ceiling (~2,400 chars) bounds how much compiled guidance reaches the
  engine; user prompts are preserved in full in the conversation.
- Photorealism ceiling is the engine's own; the art-direction block improves consistency but
  cannot make the model exceed its training quality (see 06 portrait).
- Busy scenes under the text zone can still reduce readability; the quality loop flags and
  refines this (measured `typ.contrast` finding + refinement directive), bounded by
  `LAXII_BANNER_MAX_ATTEMPTS` (default 2).

## Environment repairs performed during verification (documented, repo-sanctioned)

- Restored the 10 canonical QA fixture accounts + the `demo@beanfolio.app` fixture via the
  repo's own conventions (`scripts/restore-qa-fixtures.ts`, documented credentials) — they were
  missing from this sandbox DB (pre-existing `auth.test.ts` failures).
- Removed test-run leakage created by this session's own verification runs (485 `@beanfolio.test`
  QA rows leaked by the ox-privacy test batches + 1 probe row + 74 `ox-priv-*` rows). No real
  user data touched (owner account and fixtures preserved; `auth.test.ts` now passes 9/9).

## Test results (executed)

- `bun test` full suite (batched to fit tool limits): ~1,490 tests across 96 files — **0
  failures** after environment repair; only visible skips are the env-gated live-HTTP suites
  (they pass with the dev server up: 9/9).
- `tests/laxii-*` (66 tests): all pass, including the new budget + art-direction suites.
- `bun run lint`: 0 errors / 13 pre-existing warnings (unchanged from baseline register).
- `bunx tsc --noEmit`: 0 errors.
- Dev server healthy; `POST /api/media/upload` sentinel 401 (guarded).

## Files changed

- Modified: `src/app/api/laxii/generate/route.ts`, `src/app/api/laxii/conversations/[id]/messages/route.ts`,
  `src/components/laxii/LaxiiStudio.tsx`, `src/lib/laxii-client.ts`, `src/lib/laxii/service.ts`,
  `src/lib/laxii/conversations.ts`, `src/lib/laxii/design-brief.ts`, `src/lib/laxii/jobs.ts`,
  `src/lib/laxii/quality.ts`, `src/lib/laxii/router.ts`, `src/lib/laxii/providers/managed.ts`
- Added: `src/lib/laxii/art-direction.ts`, `src/lib/laxii/banner-request.ts`,
  `scripts/laxii/quality-benchmark.ts`, `scripts/tmp/probe-prompt-limit.ts`,
  `scripts/tmp/probe-messages.ts` (both relocated 2026-11 to `scripts/diagnostics/` when
  `scripts/tmp/` was retired), `tests/laxii-prompt-limits.test.ts`,
  `tests/laxii-art-direction.test.ts`, `agent-ctx/shots/laxii-quality/*` (evidence), this document.
- Untouched on purpose: quota/cooldown logic, provider selection (LAXII V1 = managed gateway
  only), banner/avatar/resume flows, all UI outside the named composer deltas, the dead legacy
  studio components.
