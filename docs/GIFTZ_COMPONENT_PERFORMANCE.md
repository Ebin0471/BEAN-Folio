# GIFTZ Component Performance (M17 §10)

## Implemented mechanisms

| Mechanism | Implementation |
|---|---|
| Lazy loading | motion/vendor scripts are deferred and loaded only when the config enables them; zero animation bytes on static sites (test-pinned) |
| Code splitting (equivalent) | per-plugin vendor files — a site using only `fade-up` bundles `gsap.min.js` alone; SplitText/ScrollTrigger/etc. load only when referenced presets require them |
| Dynamic imports where appropriate | the platform's React renderer keeps heavy widgets (charts, syntax highlighting) in lazily loaded chunks (pre-existing); generated sites carry no framework runtime at all |
| Image optimization | existing media pipeline (sharp processing, size caps, aspect-ratio-safe markup, lazy `loading` attributes in generated markup) |
| Avoidance of unnecessary WebGL | registry performance classes + design-consistency WebGL gate + AI prompts ("prefer CSS backgrounds when Vanta is unnecessary") |
| Animation cleanup | gsap.context revert + Vanta destroy + interval cleanup on pagehide; no leak across reloads (SPA navigation N/A in static sites) |
| Component-level budgets | per-component performance field; >12 active animations → build warning; intensity clamps by direction |
| Bundle-size reporting | the export manifest inventories every file with byte counts + roles (motion files listed explicitly); the delivery report records measured totals |

## Warning when a website contains excessive effects

- Build check: `motionBuildChecks` warns above 12 active GSAP animations ("hurts scroll performance on low-power devices").
- Registry: heavy effects (BIRDS/CLOUDS/CLOUDS2/GLOBE) are labeled in the Motion tab picker and prompts.
- Design-consistency engine: clamps intensity and warns on layout/effect contradictions.

## Prefer-lighter defaults (M17 §10)

- CSS transitions win when GSAP is unnecessary: the 107-preset CSS motion system remains the default layer; GSAP presets are additive and opt-in.
- Static/CSS backgrounds win when Vanta is unnecessary: `backgroundEffects` is opt-in, disabled-by-default, and the consistency engine pushes CSS backgrounds for compact layouts.

## Measured numbers (deterministic exports)

- Non-animated site: 0 B motion overhead.
- 5-animation GSAP site: ~156 KB total (core 73 KB + SplitText 8 KB + ScrollTrigger 45 KB + runtime 30 KB).
- Vanta site: ~640 KB (three 616 KB + effect 12-29 KB) — the dominant cost, paid only by background-effect sites.
- Full-suite timings and per-fixture numbers: `docs/GIFTZ_COMPONENT_TEST_REPORT.md` + delivery report.

## Runtime performance guidance encoded in the platform

- Transform/opacity/filter/clip-path only (no layout properties animated).
- ScrollTrigger `limitCallbacks` + `ignoreMobileResize`.
- Interactive presets are pointer-only and mobile-`off` by default.
- Vanta renders are skipped off-screen by the engine; mobile `reduced` halves speed.
- Reduced-motion visitors get a zero-animation page (content identical).
