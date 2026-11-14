# GIFTZ Vanta.js Integration (M16)

**Status: delivered.** Vanta.js 0.5.24 + three.js r134 are integrated as the GIFTZ Background Engine: AI-generated websites can carry configurable interactive WebGL backgrounds through the existing file-first architecture.

## Repository and license audit (verified from the installed packages)

| Fact | Value |
|---|---|
| vanta version / license | 0.5.24 / MIT (package.json `license` field) |
| three version / license | 0.134.0 / MIT (documented r134-compatible pairing) |
| Effects in dist (verified files) | BIRDS, CELLS, CLOUDS, CLOUDS2, DOTS, FOG, GLOBE, HALO, NET, RINGS, RIPPLE, TOPOLOGY, TRUNK, WAVES |
| Exposed in the registry | 13 effects (all above except **HALO** — the installed dist ships no verifiable `defaultOptions` for it, and the spec forbids inventing unsupported options) |
| Runtime network requirements | none for the exposed effects — verified by scanning the dist files for URL references; CLOUDS2's `texturePath` dependency is satisfied with a compiler-generated local noise PNG (`assets/vendor/noise.png`) |
| Bundle sizes | three.min.js 615,601 B; vanta effects 10,066–28,594 B each |
| Register | `docs/OPEN_SOURCE_REGISTER.md` §4 |

## Effect registry (`VANTA_EFFECTS` in `src/lib/giftz/motion-engine.ts`)

Every exposed effect carries: unique id, display name, description, required engine (three), a **settings allowlist derived from the installed package's real `prototype.defaultOptions`** (extracted per effect, never invented), performance classification, mobile compatibility, recommended use cases, cleanup method (`effect.destroy()`) and — for CLOUDS2 — the local texture requirement.

Notably verified defaults include BIRDS (color1/color2/backgroundColor/colorMode/birdSize/wingSpan/speedLimit/separation/alignment/cohesion/quantity), FOG (highlightColor/midtoneColor/lowlightColor/baseColor/blurFactor/speed/zoom), WAVES (color/shininess/waveHeight/waveSpeed/zoom), NET/GLOBE (points/maxDistance/spacing/showDots...), plus the common controls (`mouseControls`, `touchControls`, `gyroControls`, `minHeight`, `minWidth`, `scale`, `scaleMobile`). Colors accept hex strings; the runtime converts to the numeric form Vanta's shaders use.

## Configuration (site.config.json `backgroundEffects` block)

```jsonc
"backgroundEffects": {
  "enabled": true,
  "engine": "vanta",
  "effect": "FOG",
  "target": { "kind": "hero" },          // page | hero | section (+sectionId)
  "settings": { "speed": 1.2, "highlightColor": "#d4af6a" },
  "responsive": { "mobile": "reduced" }, // full | reduced | off
  "accessibility": { "respectReducedMotion": true },
  "fallback": { "kind": "color", "value": "#101014" }
}
```

Validation: unknown effect → normalized to disabled; unknown/malformed settings keys → rejected (strict schema + hex color grammar); `section` target requires an existing sectionId; the AI patch schema (`designPatchSchema.backgroundEffects`) enforces the same shape.

## AI background generation

Requests like "add animated fog behind the hero" or "remove the animated background" flow through the existing pipeline (classify → plan → validate → build → preview → approval → apply) — see `docs/GIFTZ_ANIMATION_AI_PIPELINE.md`. The AI inspects the content model for the hero/section targets; it cannot overwrite page content or unrelated styles (patch semantics are block-scoped and the build validator checks the result).

## Lifecycle (M16 §7)

The generated runtime initializes the effect only after the target element exists, only on the client, with the real rendering engine passed explicitly (`opts.THREE = window.THREE`). It: destroys cleanly on `pagehide`, avoids duplicate instances (single init per site), resize is handled by Vanta's own `resize` listener + `scaleMobile`, rendering pauses automatically off-screen (VantaBase `isOnScreen` gate), init failures (no THREE, no WebGL, throw) fall back to the static background, and foreground content stays interactive (canvas z-index 0 inside the target). No unapproved remote scripts are ever loaded.

## Performance (M16 §8)

Lazy initialization (runtime only when configured) · device-aware settings (`scaleMobile` + speed halved for `reduced` mobile mode) · reduced-motion static fallback · WebGL capability detection · canvas cleanup via `destroy()` · static disable fallback · performance classifications in the registry (heavy: BIRDS/CLOUDS/CLOUDS2/GLOBE) surfaced in the Motion tab UI and the AI prompts. Websites never depend on a working animation: the fallback background and all content render regardless.

## GSAP coexistence (M16 §9)

Clear responsibility split — GSAP owns element/timeline/scroll animation; Vanta owns the WebGL background. The GSAP runtime never touches Vanta's canvas (its targets are content selectors; Vanta's canvas is engine-internal), and teardown is independent (`ctx.revert()` vs `effect.destroy()`). Sites that don't request background effects bundle no Vanta/three bytes.

## CSP & sandbox (M16 §10)

Nothing changed: self-hosted bundled dependencies only, no new external origins, no unsafe-eval, no sandbox weakening — details in `docs/GIFTZ_MOTION_SECURITY.md` (shared security doc for both engines).

See also: `docs/GIFTZ_BACKGROUND_ENGINE.md`, `docs/GIFTZ_EFFECT_REGISTRY.md`, `docs/GIFTZ_WEBGL_PERFORMANCE.md`, `docs/GIFTZ_BACKGROUND_SECURITY.md`, `docs/GIFTZ_VANTA_TEST_REPORT.md`.
