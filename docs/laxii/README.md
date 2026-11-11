# LAXII — Open-Source AI Image Engine

LAXII is a modular, provider-agnostic image generation & editing engine. It
powers professional avatar and banner creation inside BEAN Folio (Profile
Studio) while remaining **independently reusable** by any other BEAN product.

```
src/lib/laxii/                 ← the ENGINE (zero BEAN Folio imports)
├── types.ts                   ← core contracts (kinds, request/result, ImageProvider)
├── styles.ts                  ← 6 avatar + 7 banner presets, deterministic grades,
│                                generation-size handling (32-multiple rule)
├── engine.ts                  ← orchestrator: avatar / banner / background /
│                                upscale / edit pipelines + provider resolution
├── tempstore.ts               ← private temp workspace (data/laxii-tmp), TTL sweep
├── providers/
│   ├── managed.ts             ← REAL inference via the platform's managed
│   │                            generation service (works everywhere, no GPU)
│   └── diffusers.ts           ← REAL local stack: Hugging Face Diffusers on a
│                                CUDA GPU (availability-probed, honest failure)
└── pipeline/
    ├── compose.ts             ← sharp compositing: feathered alpha masks, subject
    │                            preservation, keep-regions, grading, vignettes
    └── quality.ts             ← Laplacian-variance sharpness, blockiness,
                                dimension-verified export (PNG/JPEG/WebP)

scripts/laxii/diffusers_worker.py  ← the genuine local-GPU diffusion worker
src/app/api/laxii/…            ← thin BEAN Folio API layer (auth, ownership, jobs)
src/components/bean/ProfileStudio.tsx  ← Profile Studio UI (optional feature)
prisma: LaxiiJob               ← job records (no image bytes; results are MediaAssets)
```

**Independence contract:** everything under `src/lib/laxii/` imports only its
own files, `sharp` and `z-ai-web-dev-sdk` (inside the managed provider). No
`@/lib/db`, no auth, no BEAN types. The source image is injected as a `read()`
closure and results come back as raw buffers — a future BEAN product (or a
standalone mini-service) can host the engine with its own persistence in
minutes.

---

## 1. Component selection — what we inspected and why

| Component | License | Status (checked via GitHub at build time) | Decision |
|---|---|---|---|
| **Diffusers** (huggingface/diffusers) | Apache-2.0 | Actively maintained, the reference library | ✅ **Selected** — the local-GPU provider is built on it. Pipeline-level control, `enable_model_cpu_offload()` for 16 GB cards, SDXL & SD1.5 support. |
| **IP-Adapter** (tencent-ailab/IP-Adapter) | Apache-2.0 | Stable (last push 2024-06); weights on HF (`h94/IP-Adapter`) | ✅ **Selected** for the local provider's identity-guidance path (`--identity-image`) — conditioning without fine-tuning the base model. |
| **PuLID** (ToTheBeginning/PuLID) + PuLID_ComfyUI (cubiq) | Apache-2.0 (both) | Maintained | ✅ **Recommended production upgrade** for stronger zero-shot identity on the GPU path (documented, wired as the natural next step of `diffusers_worker.py`). |
| **BrushNet** (TencentARC/BrushNet) | Apache-2.0 (with listed third-party exceptions) | Maintained | ✅ **Recommended** for localized inpainting in production. The current engine achieves the same *outcome* (preserve content, replace surroundings) deterministically via masked compositing — see §3. |
| **ComfyUI** (Comfy-Org/ComfyUI) | **GPL-3.0** | Very active | ⚠️ **Not linked.** ComfyUI's copyleft license would force LAXII itself to become GPL if we imported its code. It can still be *run as an unmodified separate application* beside LAXII. |

**Weight licenses (no unlicensed weights):** SD1.5 — CreativeML Open RAIL-M;
SDXL — StabilityAI CreativeML Open RAIL++-M; IP-Adapter weights — Apache-2.0.
All inference providers used by LAXII are open-source-licensed or the
platform's own managed service. No paid APIs, no paid cloud generation.

## 2. Honest capability matrix (what runs where)

| Capability | This sandbox (no GPU) | GPU machine w/ diffusers enabled |
|---|---|---|
| Avatar generation — preserved-pixel (identity = original pixels) | ✅ real (managed inference + sharp compositing) | ✅ real (local SDXL/SD1.5 + sharp) |
| Avatar generation — AI-guided (identity not guaranteed) | ✅ real img2img inference | ✅ real (+ IP-Adapter/PuLID conditioning) |
| Banner generation (+ keep-region content preservation) | ✅ real | ✅ real |
| Background replacement | ✅ real | ✅ real |
| Outpainting (banner re-frame) | ✅ real (generate wider canvas, composite original) | ✅ real |
| Masking / inpainting | ✅ real (feathered alpha masks; content inside masks is *never* sent to any model) | ✅ + BrushNet option |
| Upscaling | ✅ real (sharp Lanczos3 + unsharp; exact dimensions verified) | same |
| Export PNG/JPEG/WebP, quality knob | ✅ real | same |
| Sharpness / artifact metrics | ✅ real (Laplacian variance, 8×8 blockiness) | same |

**The engine never fabricates results.** If a requested provider is
unavailable (`LAXII_PROVIDER=diffusers` on a machine without CUDA), the job
FAILS with the concrete reason — it never returns a placeholder image.

## 3. Identity preservation — honest statement

* **Preserved-pixel mode (default, "Recommended" in the UI):** the subject is
  segmented by a local, license-verified alpha-matting model — **MODNet**
  (upstream ZHKKKe/MODNet, Apache-2.0; ONNX port Xenova/modnet, apache-2.0;
  runtime @huggingface/transformers + onnxruntime-node, CPU, no paid API).
  Weights are prefetched into `data/laxii-models/` with
  `bun ./scripts/laxii/prefetch-models.ts`; jobs never download at generation
  time. The composite implements the exact equation
  `output = original_subject × alpha + generated_background × (1 − alpha)`
  where alpha is the hair-level matte (feathered only at the subject
  boundary) — original background, plants, walls never leak into the result.
  The frame mapping is a single uniform scale + translation centered on the
  subject, so proportions and positioning are preserved exactly.
  **Every composite is numerically validated before export**
  (`pipeline/validate.ts`): outside the mask the pixels must equal the
  generated plate, inside the mask core they must equal the mapped original,
  and the output must be fully opaque. Violations FAIL the job — a defective
  composite is never exported. Generated backdrops are also scanned by the
  same matting model: a "empty scene" plate that contains a person is
  rejected and regenerated (3 attempts, then an honest failure).
  *Fallback:* when the segmentation weights are absent
  (`LAXII_DISABLE_SEGMENTATION=1` or missing cache), the user's manually
  marked subject window becomes the mask (documented downgrade — the
  boundary is the marked rectangle, not hair-level; a near-full-frame window
  is refused). With no mask available at all the job fails with a useful
  error instead of exporting a defective image.
  *Diagnostics:* every run writes its stages to the private temp workspace
  `data/laxii-tmp/<run-id>/` — original, binary subject mask, feathered
  alpha, generated background, final composite, and a `manifest.json` with
  mapping, coverage and validation measurements (age-swept, never public).
* **AI-guided mode (explicit "Experimental", warning shown):** real img2img
  inference conditioned on the reference. Likeness is usually close but is
  NOT guaranteed — the UI says so before generating, and every result is
  reviewed by the user before anything is applied.

Regression suite: `bun ./scripts/laxii/verify-composite.ts` (37 numeric
checks — equation exactness, ghosting rejection, transparency, feather
confinement, export formats, confidence gates, real-model checks).
Reproduction tool: `bun ./scripts/laxii/reproduce-avatar.ts` (runs a PRESERVE
avatar job through the real engine with a local file).

## 4. Security & privacy

* Every LAXII endpoint requires an authenticated session; jobs and results
  are strictly owner-scoped (`userId` on every row/accessor; cross-user ids
  are indistinguishable from nonexistent — verified by tests).
* Source assets are read **through the storage boundary** only after an
  ownership check on the `MediaAsset` row.
* Reference bytes travel in-memory to the provider; they are never logged,
  never written into `paramsJson`, and **never used for training** (the
  engine has no training path at all).
* Results are unattached `MediaAsset`s → served **owner-only** by
  `/api/media/:id/raw` until the user explicitly applies one as avatar/cover
  (which is exactly when it becomes part of the public profile face).
* Intermediate frames live in `data/laxii-tmp/<job>/` — outside the media
  root, unservable — and are deleted when the job finishes plus swept by a
  2-hour age guard (crash-safe).
* Rate limits: 12 jobs/hour/account, max 2 RUNNING per user.

## 5. Hardware & storage requirements (honest)

**This sandbox (what the MVP was verified on):** no GPU, 2 vCPU, ~4 GB RAM,
~7 GB free disk. Consequently the *local diffusion* provider cannot run here —
the managed provider performs the real inference, sharp performs all
compositing/quality work locally.

**Local GPU deployment (the §8 target):**
* GPU: NVIDIA 16 GB VRAM class (RTX 4060 Ti 16G / 4070 Ti / 3090 / A4000…).
  SD1.5 fits comfortably; SDXL runs fp16 with `enable_model_cpu_offload()`
  (verified approach in diffusers; peak VRAM ≈ 9–11 GB at 1024²).
* Disk: SD1.5 ≈ 4 GB, SDXL ≈ 7 GB (fp16 safetensors) + IP-Adapter ≈ 0.1–1 GB,
  per model, in `HF_HOME`.
* Python: torch (CUDA build), diffusers, transformers, accelerate, safetensors.
* RAM: ≥ 32 GB recommended for SDXL with CPU offload.
* Activation: `LAXII_PROVIDER=diffusers` (or `auto` — prefers the GPU stack
  when `torch.cuda.is_available()`), plus `LAXII_MODEL_T2I` /
  `LAXII_MODEL_I2I` / `LAXII_MODEL_DEFAULT=sd15|sdxl`. The worker is
  `scripts/laxii/diffusers_worker.py`; the Node bridge availability-probes
  CUDA before every selection and reports honest unavailability otherwise.

## 6. Production deployment path

1. **Split the engine out** — `src/lib/laxii/` has no BEAN imports; lift it
   into `mini-services/laxii/` (Bun) or a worker container behind the gateway
   (`XTransformPort`). The API layer's job lifecycle (Prisma `LaxiiJob`)
   stays; the engine call becomes an HTTP call.
2. **Queue discipline** — move execution from the in-process fire-and-forget
   runner to a real worker (BullMQ/Redis or a DB-leased loop like
   `ai-design`'s `leaseUntil`/`heartbeatAt` pattern, which LaxiiJob's
   `attempt`/`nextAttemptAt` already mirror).
3. **GPU autoscaling** — one worker per 16 GB GPU; the diffusers worker is
   stateless (stdin → stdout contract), so containers scale horizontally.
4. **Stronger identity** — add PuLID (zero-shot identity) and BrushNet
   (true inpainting) to the worker; keep the managed provider as fallback.
5. **Segmentation matting** — replace the elliptical preserve-mask with a
   matting model for hair-level edges.
6. **Object storage** — results already persist through the BEAN storage
   boundary (local disk or S3-compatible), so S3-mode deployments need no
   engine changes.
7. **CDN / caching** — `/api/media/:id/raw` already sets
   `Cache-Control: private, max-age=3600` with auth-aware streaming.

## 7. Test evidence (executed during this build)

1. Real avatar generation (preserved-pixel, 2×1024², managed provider) ✅
2. Real banner generation (champagne-gold, 1440×720, keep-region) ✅
3. Identity preservation (inside-mask pixels near-identical; outside
   clearly replaced — measured numerically) ✅
4. Original-image preservation (upload byte-identical after all jobs —
   SHA-256 verified) ✅
5. Background replacement (dark-luxury, WebP export) ✅
6. Resize/upscale (2× = 1728×2304 exact; custom export dims verified by
   sharp metadata re-read) ✅
7. Multiple requests (7+ jobs; per-user RUNNING cap enforced with a clear
   message) ✅
8. Failed jobs & retries (real failure modes hit: invalid size rule, sharp
   gamma range; retry with backoff succeeded; budget enforced) ✅
9. Unauthorized access (401 anonymous; cross-user read/cancel/retry →
   404/403; cross-user source asset → 400) ✅
10. Avatar application persistence (`PATCH /api/me/profile` → avatarUrl
    updated; original upload untouched; unapplied results owner-only) ✅

UI E2E: Profile Studio opened from My Folio → reference upload →
preserved-pixel mode → corporate-headshot style → live progress ("Generating
scene 2/2 — 30%") → result grid with before/after slider → Apply → confirm
dialog → avatar replaced, toast shown. Banner tab mirrors the same flow.

---

## 8. Conversational creative studio (ChatGPT-Images-style multi-turn engine)

LAXII now powers a full conversational image studio (`/#/laxii`) alongside the
Profile Studio — one engine, two front doors.

### Providers (independent, capability-registered)

| Provider | id | Runs where | Cost model | Reference images |
|---|---|---|---|---|
| Managed inference (z-ai SDK) | `managed` | platform GPU fleet | platform quota | 1 |
| Local Diffusers (SD1.5/SDXL, Apache-2.0) | `diffusers` | this machine's CUDA GPU | local (free) | 1 |
| **Nano Banana** (Google Gemini API) | `gemini` | Google cloud | **paid per image** (estimates in registry) | up to 14 |
| **GPT Image** (OpenAI API) | `openai` | OpenAI cloud | **paid per image** (estimates in registry) | up to 16 |

* Nano Banana models (official registry, verified against
  ai.google.dev/gemini-api/docs/image-generation): `gemini-nano-banana-2.1`
  (Nano Banana 2.1), `gemini-3.1-flash-image` (Nano Banana 2),
  `gemini-3.1-flash-lite-image` (Nano Banana 2 Lite — 1K only),
  `gemini-3-pro-image` (Nano Banana Pro), `gemini-2.5-flash-image` (v1).
  Official Interactions API: `POST /v1beta/interactions` with
  `x-goog-api-key`, `input[]` text/image parts and
  `response_format{aspect_ratio,image_size}`. Native multi-turn exists via
  `previous_interaction_id`; LAXII currently drives multi-turn statelessly by
  resending the previous image (declared "synthetic" in the registry).
* OpenAI: `gpt-image-1` / `gpt-image-1-mini` via `/v1/images/generations`
  and `/v1/images/edits` (multipart, up to 16 images, `input_fidelity=high`).
* Keys are env-only: `GEMINI_API_KEY`, `OPENAI_API_KEY`,
  `LAXII_GEMINI_IMAGE_MODEL`, `LAXII_OPENAI_IMAGE_MODEL`,
  `LAXII_DEFAULT_PROVIDER`. A missing key = provider reports unavailable —
  never an error mid-job and never a silent fallback to a fake image.
* Size contract (verified live): t2i accepts 512–2880 per side, 16-multiples,
  ≤ 2^22 px total; the **edit endpoint is stricter — ≤ 2^21 px total**
  (error 1214). `isValidGenerationSize(width, height, mode)` encodes this and
  invalid requests fall back to the nearest trained generation size.

### Common provider-independent interface

`src/lib/laxii/creative.ts` — `laxii.generateImage() / editImage() /
generateVariations() / continueEditing() / upscaleImage() / removeBackground() /
expandCanvas() / getCapabilities()`. All route through the same engine
pipelines; the frontend never talks to providers directly.

### Conversation model (Phase 3)

* `LaxiiConversation` → `LaxiiMessage[]`; every ASSISTANT message owns exactly
  one `LaxiiJob` (the hardened pipeline: validation, ownership, rate limits,
  retries, stale-job reaper — unchanged) and mirrors its live stage/progress.
* Versioning is structural: `parentAssetId` (the image a turn edits) +
  `outputsJson` (produced assets) + `selectedAssetId` (the continuation
  anchor). "Undo / continue from here" = send the next turn with an earlier
  message's output as `parentAssetId` — no separate version table needed.
* Operation planning is deterministic (`planTurn`): AUTO infers
  GENERATE (no image) vs EDIT (image present); the fallback image is scoped to
  the CURRENT conversation. Promptless operations (VARIATIONS, REMOVE_BG,
  UPSCALE) act purely on the selected image. The previous image ALWAYS
  accompanies the instruction — never the latest text alone.
* Engine kinds added: `GENERATE` (t2i, reference-conditioned when refs are
  attached), `VARIATIONS` (N genuine i2i variations), `REMOVE_BG` (local
  MODNet hair-level matte → transparent PNG — the same segmentation stack as
  PRESERVE avatars), `OUTPAINT` (blurred self-prior canvas + real generative
  completion). BANNER now accepts a bare natural-language brief (style
  preset optional; grading applied only when a preset is chosen).
* Managed provider accepts EXACT sizes that are valid runtime sizes
  (Banner Studio's true 2560×1440) instead of always snapping to the preset
  aspect list.

### Banner Studio (Phase 5)

13 platform presets with official dimensions and text-safe areas
(`src/lib/laxii/banner-presets.ts`): YouTube channel banner 2560×1440 with the
1546×423 central safe area, YouTube thumbnail 1280×720 (<2 MB), LinkedIn cover
1584×396, Facebook cover 851×315, X header 1500×500, website hero/promo,
ecommerce, product ad (1080×1080), business campaign, event, portfolio cover,
and fully custom (16–4096). Safe areas drive the canvas-preview guides AND a
prompt hint; the export pipeline verifies exact dimensions and platform file
size caps. The UI canvas preview draws the dashed safe area.

### Library & UI (Phase 6)

Results are stored with `origin="LAXII"` + `laxiiKind` on MediaAsset, powering
My images / My banners / Favourites (`favourite` flag) and History. The studio
UI (`src/components/laxii/`) is a premium dark, champagne-gold layout: left
sidebar (new creation, recent conversations, library, history, Profile Studio
entry, live provider status), centre thread (variation cards, selection rings,
live progress, honest failures with retry, before/after compare), bottom
composer (prompt, uploads/references, 8 operation modes, provider + model +
aspect + variations in collapsible options, Banner panel with safe-area
canvas). Capability-driven: the UI only offers what the selected provider
genuinely supports, and shows per-image cost estimates for paid APIs.

### Cost discipline (Phase 8)

External providers are treated as PAID inference: per-image USD estimates live
in the capability registry, are surfaced in the composer (model picker) and
stored on each finished message (`meta.estimatedCostUSD`, explicitly labelled
an estimate). Local paths (managed quota, diffusers GPU, MODNet) estimate to
zero. Rate limits: 20 conversational turns/hour/account on top of the
existing 12 jobs/hour and max-2-RUNNING caps.

### E2E evidence (executed against the real managed provider)

text-to-image (4-up zen garden) ✅ · AUTO-inferred multi-turn edit (brighter
flame) ✅ · variations (cooler blue candlelight) ✅ · continue-from-earlier-
version ✅ · REMOVE_BG real MODNet cutout (75.1% transparent, hair-level) ✅ ·
OUTPAINT 1024²→1448² ✅ · UPSCALE exact 2× (2048²) ✅ · YouTube banner exactly
2560×1440 PNG 2.1 MB ✅ · provider-failure honesty (gemini without key →
honest FAILED, no fake image) ✅ · retry budget enforcement ✅ · 401/404
ownership isolation ✅ · library/favourites ✅ · UI E2E desktop + 375 px
mobile (drawer, composer, banner panel, Profile Studio entry) ✅ · 20/20
backdrop regression tests ✅ · 37/37 composite checks ✅
