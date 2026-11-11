# LAXII realism capabilities — investigated and wired (Phase 3, spec §6)

Scope: photorealistic banners and portraits through the EXISTING BEAN
Intelligence gateway + LAXII provider registry. Rule honored throughout:
**only documented, already-registered model capabilities; no invented model
ids; no Ollama; unconfigured providers stay disabled; image generation is
never silently substituted by text generation (or vice versa).**

## 1. What the registered engines actually provide (verified against the provider implementations)

| Capability | Managed (`managed.ts`, always configured) | Gemini (`gemini.ts`, needs key) | OpenAI (`openai.ts`, needs key) | Local diffusers (`diffusers.ts`, needs GPU) |
|---|---|---|---|---|
| Photorealistic text-to-image | ✅ `images.generations.create`, 8 fixed sizes incl. **2016×864 (21:9)** — the pipeline's banner render size | ✅ 1K/2K/4K, native aspect control, SynthID provenance watermark | ✅ 1024/1536 sizes | ✅ SDXL/SD1.5 via the local worker |
| Reference-guided generation | ✅ `images.generations.edit` with ONE reference (multi-ref → real `composeReferenceSheet` contact sheet, `router.ts`) | ✅ up to **10 reference images** per call (object + character refs) | ✅ edit endpoint, up to **16 references** | ⚠️ IP-Adapter path documented, GPU only |
| Conversational editing (background consistency across turns) | ❌ stateless (compact context brief appended) | ✅ NATIVE multi-turn via `previous_interaction_id` (`jobs.ts` records `interactionIds`) | ❌ stateless | ❌ stateless |
| Facial identity preservation | ⚠️ best-effort likeness from a reference photo — the avatar flow already labels it honestly ("approximate, not guaranteed", `generate/route.ts`) | ⚠️ character-reference conditioning (better, still best-effort) | ⚠️ reference-weighted edit | ⚠️ IP-Adapter / PuLID documented as the production upgrade (`docs/laxii/README.md`) |
| Inpainting / masked editing | ❌ not offered natively — the engine achieves localized changes deterministically (mask compositing is legacy; today: reference-guided edit + deterministic overlay) | ⚠️ conversational region edits (no explicit mask API used) | ⚠️ images.edit supports optional mask field (not wired — capability marked honestly in the table) | ⚠️ BrushNet recommended in docs, not wired |
| High-resolution export | Deterministic Lanczos via `fitToCanvas`/export route, exact-size verified by decode | ✅ native up to 4K (`quality` tier) | ✅ quality tiers | GPU-dependent |
| Transparency | ✅ engine-level alpha extraction (`extractTransparency`) after provider isolation; banner pipeline asserts **fully opaque** output | ✅ native transparent option | ✅ native | ❌ honest unsupported |

Legacy note: the MODNet alpha-matting compositing pipeline described in
`docs/laxii/README.md` was removed during the engine refactor (only ONNX
weights remain under `data/laxii-models/`); `docs/laxii/README.md` is a
historical document for that architecture, not the current one.

## 2. What Phase 3 wired into the banner pipeline

1. **Reference-guided banners**: brief `referenceMediaIds` (ownership-checked
   MediaAssets) are loaded and passed to the engine — managed renders them via
   a real contact sheet; Gemini/OpenAI accept them natively when configured.
2. **Subject placement + scale as a deterministic plan** (`planComposition`)
   expressed in the prompt, with the honest caveat that placement guidance is
   not a guarantee — the evaluator measures what actually happened.
3. **Deterministic typography** — exact strings rendered with real fonts
   (`typography.ts`), measured from rendered pixels; the model is explicitly
   told to paint NO lettering. This removes the largest realism/quality
   failure mode (garbled text) entirely for brief banners.
4. **Contrast-aware text rendering**: text color chosen by measured WCAG
   contrast against the actual background under the text; a soft scrim is
   composited only when measurement demands it, and the decision is recorded
   for user approval (`cmp.approval.*` finding).
5. **Lighting/shadow/texture/geometry realism**: checked by the measured
   evaluators (sharpness, contrast, letterbox, border coherence) plus the
   OPTIONAL advisory AI visual review (`LAXII_AI_VISUAL_REVIEW`, default on,
   degrades honestly when unavailable). The AI review is labelled
   non-deterministic and can never overwrite deterministic findings.
6. **High-resolution export**: the banner pipeline exports exactly 942×190
   (decode-verified). Gemini users may render 2K/4K source scenes through the
   existing `quality` option before the deterministic crop.

## 3. Honest gaps (not faked, candidates for later phases)

- Facial identity preservation remains best-effort on every configured
  engine; no PuLID/IP-Adapter wiring exists in the active path.
- No explicit mask-based inpainting is wired through the gateway; localized
  edits run as reference-guided re-renders.
- The advisory AI review consumes the shared vision path without its own cost
  line (it is unmetered at 0 estimate); if it is ever metered, the ledger
  entry belongs in the same route that records the generation.
- Sub-pixel kerning/letter-spacing control in `typography.ts` is intentionally
  minimal (DejaVu family, three grades) — a curated brand-font pipeline is a
  product decision, not a capability gap.
