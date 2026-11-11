# Phase 3 delivery report — LAXII Creative Intelligence

Phase: RIISHE→LAXII structured brief ingestion · professional banner production ·
quality evaluation · bounded refinement · approval-gated export.
Companion docs: `01-repository-audit.md` (P0), `02-architecture.md` (P1),
`03-laxii-phase3-audit.md` (P3 audit), `04-laxii-realism-capabilities.md` (P3 §6).

## 1. Files inspected (audit before code)

Read end-to-end: `src/lib/laxii/{types,router,service,jobs,image-ops,validate,banner-presets,styles,intent,avatar-presets,tempstore}.ts`,
`src/lib/laxii/providers/{managed,gemini,openai,diffusers}.ts`,
`src/lib/intelligence/{gateway,registry,circuit,context,personas,delegation,observability}.ts`,
`src/app/api/laxii/{generate,banner/export,images,versions/*,conversations/*,resume/*}/route.ts`,
`src/app/api/laxii/capabilities/route.ts`, `src/app/api/ai/chat*/route.ts`,
`src/components/laxii/{LaxiiStudio,LaxiiBannerPanel,LaxiiSidebar,LaxiiResume*}.tsx`,
`src/views/{LaxiiView,IntelligenceView}.tsx`, `src/lib/{laxii-client,media,client,ai,api-helpers,site-config,site-palettes}.ts`,
`prisma/schema.prisma`, `docs/laxii/README.md` (historical), `worklog.md`, all 16 test files.
Findings recorded in `03-laxii-phase3-audit.md` (what works / 8 gaps / constraints to keep).

## 2. Files modified / created

**New modules**
- `src/lib/laxii/design-brief.ts` — versioned zod schema for the structured brief (request, profession/audience, authorized portfolio `permission:"self"`, visual identity, direction, subject/focal point, background, composition+hierarchy, palette, exact typography items, canvas, safe area, reference ids, preserve, avoid, export, bounded revisions, provenance) + deterministic prompt compiler + scoped revision addenda.
- `src/lib/laxii/typography.ts` — deterministic typography engine: real-font SVG rendering (DejaVu family), trim-based ink measurement of the rendered pixels, WCAG contrast against the sampled background, palette-color selection, conditional scrim, safe-area/focal-overlap checks, and `verifyInkApplied()` (pixel-diff proof the text survived compositing onto the FINAL image).
- `src/lib/laxii/quality.ts` — four evaluators: **technical** (decode, exact physical dimensions, mime, real-transparency detection via alpha-plane sampling, full raw read-back), **visual** (Laplacian-variance sharpness, luminance stddev contrast, Hasler–Süsstrunk colorfulness, paired-bar letterbox detection, border/interior coherence — thresholds calibrated on real LAXII outputs), **typography** (exact-text ink presence, safe-area fit, measured contrast, focal overlap, final-pixel ink verification), **compliance** (satisfied / guidance-only / unsupported / needs-approval — no invented scores).
- `src/lib/laxii/banner-pipeline.ts` — the 11-step production pipeline: brief+canvas validation (refuses mismatched dimensions), deterministic composition plan (subject placement opposite the text side), real provider generation, scene fit to the exact canvas FIRST, deterministic typography composite in final-canvas space with forced opacity, measured evaluation (optional advisory AI review via the gateway vision path, `LAXII_AI_VISUAL_REVIEW`), bounded refinement (env `LAXII_BANNER_MAX_ATTEMPTS`, default 2, max 3) with defect-scoped directives and best-of selection, budget check before every engine call, private temp artifacts + metrics-only manifest.
- `src/lib/laxii/cost.ts` — daily-estimate helpers extracted from the route so the pipeline honors the same ledger.
- `src/app/api/laxii/brief/route.ts` — GET (ownership-checked structured brief + stale-RUNNING sweep) and POST lifecycle actions (`revise` bounded 3, `cancel`, `approve-result`/`reject-result`).
- `src/components/laxii/LaxiiBriefReview.tsx` — BriefReviewCard (every structured field + approve&generate / targeted revision / dismiss), QualityFindingsPanel (measured findings, refinement trail, approve/reject), BriefPipelineProgress (live stage lines).
- `docs/ai-transformation/03-laxii-phase3-audit.md`, `04-laxii-realism-capabilities.md`, this report.

**Modified**
- `src/lib/intelligence/delegation.ts` — BANNER delegations now build the schema-validated structured brief from authorized own data (profile, professions, site palette/typography via SiteDesign), exact text ONLY from the user's quoted strings, persist it in AgentTask.resultJson (human paragraph derived FROM the structure), plus task lifecycle helpers (load/revise/decide/record/status).
- `src/lib/intelligence/context.ts` — additive `professions` field.
- `src/app/api/laxii/generate/route.ts` — `briefTaskId` path: ownership + canvas-truth checks, brief-supplied prompt/canvas/typography, duplicate re-attach per brief, AgentTask RUNNING stamp; free-form paths untouched.
- `src/lib/laxii/jobs.ts` — pipeline branch keyed on `briefTaskId` with stage progress written into the job message meta; brief lineage + quality report recorded; failure marks the AgentTask FAILED.
- `src/app/api/laxii/banner/export/route.ts` — approval gate: brief-produced banners export only after an explicit user approval (403 with guidance otherwise).
- `src/lib/laxii/providers/managed.ts` — SDK-internal crashes now surface as honest `provider` failures (found via E2E transient gateway error).
- `src/lib/laxii-client.ts`, `src/components/laxii/LaxiiStudio.tsx`, `LaxiiBannerPanel.tsx`, `src/views/IntelligenceView.tsx` — client types/APIs, sessionStorage handoff transport (`bean:laxii-pending-brief`), brief card + findings + decisions rendering, approval-aware export button.
- `tests/laxii-banner-phase3.test.ts` (27 tests), `tests/laxii-brief-api.test.ts` (11 tests).

## 3. Existing features preserved

- The working free-form 942×190 banner path is byte-identical in behavior (same preset, same prompt assembly, same `fitToCanvas` compositing, same export verification) — the brief path is strictly additive.
- All engine operations (AUTO/GENERATE/EDIT/VARIATIONS/UPSCALE/REMOVE_BACKGROUND/EXPAND), avatar + resume studios, style registry, version tree/undo/redo/compare, gallery, usage + cost ledger, rate limits, branding rules — untouched; full pre-existing suite (240 tests) still passes.

## 4. Brief ingestion implementation (spec §2)

RIISHE chat → `detectDelegationIntent` → `buildStructuredBannerBrief` (own data only:
name/headline/professions/projects + the user's own SiteDesign accent colors & heading font)
→ AgentTask (AWAITING_APPROVAL, structured brief in resultJson) → chat card → handoff
button stores the taskId in sessionStorage → LAXII studio fetches `/api/laxii/brief`
(ownership-enforced) → BriefReviewCard shows the ACTUAL structured fields (request verbatim,
audience, portfolio summary, identity, direction, subject/focal, background, composition,
palette chips, EXACT text items, canvas 942×190 + safe zone, avoid list, revisions) →
"Approve brief & generate". The provider prompt is compiled deterministically from the
structure (`compileBriefPrompt`) with the exact user request first and inferred portfolio
context explicitly labelled guidance-only. When the brief carries typography, the prompt
forbids the model from painting any lettering — text is rendered by the engine.

## 5. Real generation evidence (browser E2E, real credentials)

Signed in as the demo account; RIISHE chat message: *'Create a professional banner for my
portfolio with "MAYA STUDIO" as the headline'*:
1. Delegation card appeared; handoff opened LAXII with the structured brief (screenshot `/tmp/p3-brief-card.png`).
2. "Approve brief & generate" → 202 → live pipeline stages rendered in the thread
   ("Generating the banner scene… Attempt 1 of 2" → "Evaluating the composition…").
3. Managed engine rendered a real cinematic scene (film reel — grounded in the film-editor
   profile) at 2016×864, cover-cropped to exactly 942×190, "MAYA STUDIO" rendered
   deterministically in the user's own site accent (#ff8e5e), placed in the left calm zone
   (final image: `/tmp/banner-final.png`).
4. Quality report stored on the message: overall `warn`, 18 measured checks including
   `typ.ink-final` PASS ("MAYA STUDIO", mean pixel change 51.4), exact-dimension PASS,
   palette/subject marked guidance-only honestly, advisory AI review labelled non-deterministic.
5. Export refused (403) before approval; "Approve result" unlocked it; export verified
   **942×190 image/png** in the UI and by decode on the server.
6. AgentTask transitions verified in DB: AWAITING_APPROVAL → RUNNING → COMPLETED with
   generation linkage (conversationId, messageId, mediaId).
7. Mobile 390×844: no horizontal overflow, approved state + export reachable, footer pinned.

**Before/after (honest)**: the first E2E run exposed a real defect — the typography layer was
composited in the wide provider render's coordinate space and the center-crop removed it, and
the composite carried stray alpha. Fixed by fitting the scene to the exact canvas BEFORE
compositing text and forcing opacity; added `verifyInkApplied` as a permanent regression check
(unit test reproduces the bug and proves detection). Both before/after images are preserved at
`/tmp/banner-check.png` (before: no text) and `/tmp/banner-final.png` (after).

## 6. Test results

- `bun test`: **278 pass / 0 fail** (240 pre-existing + 38 new) across 18 files.
- `bunx tsc --noEmit`: clean. `bun run lint`: clean.
- New coverage maps to spec §9: brief reaching LAXII (API), permission enforcement
  (cross-user 404 / anonymous 401), exact 942×190 (unit + API + export), crop/subject
  positioning (plan math + rendered ink), text spelling/clipping (real ink measurement +
  shrink-to-fit + final-pixel verification), safe-area compliance, invalid image rejection,
  quality-evaluation failures (near-empty, letterbox, transparency, mismatched dimensions),
  bounded refinement (directive scoping, ≤max attempts, budget stop, best-of), retry/idempotency
  (duplicate re-attach), version lineage + selection, user approval before export, cost
  guardrails (ledger sum → 429; refinement budget stop), provider failure (honest FAILED turn +
  FAILED AgentTask). Real provider credentials are NOT required for any automated test — the
  engine is scripted with real sharp-rendered pixels; credential-dependent behavior is covered
  by the browser E2E above (real managed generation, AI review call logged `success`).
- Browser: golden path verified desktop 1280×800 + mobile 390×844; no console errors from
  Phase 3 code (one pre-existing app-wide hydration warning on the public home page, unrelated).

## 7. Cost and latency measurements (documented estimates, not bills)

- First E2E run (05:02): 1 attempt, engine call inside the ~78 s wall-clock window between
  202 and DONE; pipeline total ≈ 78 s including evaluation + advisory AI vision review (1.6 s).
- Second successful run (05:27): same shape, ≈ 90 s end-to-end; managed-engine cost estimate
  $0.0000 (unmetered engine), recorded to `LaxiiUsage` as before.
- Refinement attempt (when triggered) adds one engine call (~100 s observed earlier) and is
  gated by the daily estimate budget before it runs.

## 8. Known limitations

1. Subject placement, palette adherence and background coherence remain MODEL guidance — the
   evaluators measure what they can (sharpness/contrast/letterbox/borders/ink) and explicitly
   mark the rest "guidance; not verifiable deterministically".
2. The advisory AI visual review is non-deterministic and may be wrong; it is labelled as such
   and can never override deterministic findings (one E2E run showed its "unusable response"
   honest-degradation path; a later run succeeded).
3. `typography.ts` uses three locally-available font grades (DejaVu sans/serif/mono) — no
   brand-font pipeline yet; long text auto-shrinks to fit the safe area.
4. Facial identity preservation / mask-inpainting / native 4K remain provider-dependent as
   documented in `04-laxii-realism-capabilities.md`; nothing is faked when unavailable.
5. The managed gateway intermittently returns malformed bodies (two `.map` SDK crashes
   observed in one session); they now surface as honest retryable failures, but the gateway
   itself is outside this repo's control.
6. The evaluation thresholds (sharpness/contrast) are calibrated on real outputs from ONE
   engine family (managed); other engines may need recalibration once configured.

## 9. Remaining production blockers (honest)

- No production deployment has been performed or verified in this phase; the verdict
  "production-ready" is explicitly NOT claimed. LAXII is feature-complete for the Phase 3
  scope on the sandbox deployment.
- Gemini/OpenAI/local-diffusers paths remain implemented-but-inactive (no credentials here);
  their brief-pipeline behavior is covered by the provider-agnostic contract + scripted tests,
  not by live calls.
- Phase 4 (Code Giftz expansion), Phase 5 remainder (task-list UI/cancel surfaces),
  Phase 6 (dependency write-up) and Phase 8 (production-readiness verdict) are still open.
