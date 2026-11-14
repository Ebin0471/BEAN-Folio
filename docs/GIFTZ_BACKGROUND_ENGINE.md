# GIFTZ Background Engine

Module: the `backgroundEffects` half of `src/lib/giftz/motion-engine.ts` (registry + program + runtime), served by the same deterministic compiler and lifecycle as the GSAP Motion Engine.

## Responsibilities

| Layer | Implementation |
|---|---|
| Registry | `VANTA_EFFECTS` — 13 verified effects, per-effect strict settings schemas derived from the installed package's real defaults |
| Config | `backgroundEffectsSchema` (zod) embedded in the SiteConfig schema; validated in `normalizeConfig` via `validateBackgroundEffects` |
| Program | `compileMotionProgram()` → `program.vanta = { effect, distFile, selector, settings, responsive, respectReducedMotion, fallback, textureUrl }` |
| Assets | `vendorFileSpecs()` emits `assets/vendor/three.min.js` + `assets/vendor/vanta.<effect>.min.js` (+ `assets/vendor/noise.png` for CLOUDS2) |
| Runtime | the fixed interpreter's Vanta section: WebGL detection, hex→int color conversion, `new VANTA[effect]({ el, THREE, texturePath?, ...settings })`, mobile reduction, static fallback, `destroy()` cleanup |
| Validator | `motionBuildChecks` verifies vendor presence + config validity before preview/publish |
| UI | Motion tab "Vanta background" card (effect/target/speed/fallback/reduced-motion editors + live preview) |

## Target resolution

- `page` → `.bs-bg-host` (the page background host)
- `hero` → the first `hero`-type section's `[data-gz-section="<id>"]` anchor (emitted by the compiler only when the motion engine is active)
- `section` → explicit `[data-gz-section="<sectionId>"]`

Vanta's own `prepareEl()` makes the target's children positioned/z-indexed above the canvas, so foreground content stays interactive without extra CSS.

## Failure behavior (graceful degradation, always)

| Condition | Result |
|---|---|
| WebGL unavailable | static fallback color/gradient applied to the target |
| `window.VANTA[effect]` missing (failed script) | console warning + static fallback |
| Effect constructor throws | static fallback (Vanta's internal fallback + ours) |
| Reduced motion (OS / `?motion=static`) | no canvas at all; static fallback |
| Mobile + `responsive.mobile: "reduced"` | `scaleMobile` floor + halved speed |
| Mobile + `"off"` | no initialization |

Text, buttons and navigation are never dependent on the background effect.

## Fallback configuration

`backgroundEffects.fallback` = `{ kind: "color" | "gradient", value }` — applied to the target element whenever the animated background cannot run. Default `#101014`; the value is CSS-injected (string sanitized by the schema).

## Example fixtures

`tests/helpers/giftz-motion-fixtures.ts` ships the five M16 demo sites (FOG luxury agency, NET SaaS, WAVES travel, GLOBE global business, BIRDS creative portfolio) — each normalized, compiled, exported and build-validated by `tests/giftz-motion-engine.test.ts`, each carrying the static fallback.
