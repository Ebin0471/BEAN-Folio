# GIFTZ Vanta Test Report (M16 §14)

**Scope:** automated verification of the Vanta Background Engine + browser verification recorded in the delivery report.

## Automated results (all passing)

### `tests/giftz-motion-engine.test.ts`

| Test | Verifies (M16 §14 mapping) |
|---|---|
| Vanta effect registry > every exposed effect exists in the installed package dist | effect registry — 13 effects × dist file existence + engine + cleanup contract |
| Vanta effect registry > three.js is installed at the pinned r134 release | dependency integrity (0.134.0 + build file present) |
| Vanta effect registry > spec-listed effects exposed; HALO not | registry scope per spec §3 |
| Vanta effect registry > settings allowlists reject unknown keys and malformed colors | configuration validation |
| Vanta effect registry > backgroundEffects validation rejects unknown effects and bad targets | config validation |
| site.config.json blocks > invalid background effects normalize to disabled | generated-file handling / schema gate |
| motion program compilation > vanta target resolves to the hero section with texture for CLOUDS2 | target resolution + local texture wiring |
| generated runtime safety | cleanup + fallback + no network |
| static export emission > Vanta sites bundle three.js through the vendor cap allowance | compiler preservation + preview/published asset serving path |
| static export emission > CLOUDS2 ships the generated local noise texture | local texture (valid PNG header/dimensions asserted) |
| build validation > missing vendor files reported as errors | build validation |
| demo fixtures > all five Vanta fixtures bundle three.js + effect locally | M16 §12 fixture pipeline |

### `tests/giftz-motion-compiler.test.ts`

Real S1 sync: Vanta-enabled config emits three.js + fog + runtime rows; HTML references them; user files untouched.

## Webll fallback + reduced motion (M16 §14)

- Reduced motion: the runtime skips canvas init entirely and applies `backgroundEffects.fallback` (source-asserted: `applyStaticFallback` + `prefers-reduced-motion` + `?motion=static` present in every generated runtime).
- WebGL failure: capability probe (`canvas.getContext('webgl')`) gates init; failure → static fallback (source-asserted).
- Cleanup: `pagehide` → `effect.destroy()` (source-asserted; dist source verifies destroy removes listeners/rAF/scene).
- Resize: handled by VantaBase's native resize listener (`scaleMobile` on mobile) — engine-internal, verified in dist.

## Preview rendering / CSP compatibility (M16 §14)

- Serving headers unchanged (`connect-src 'none'`) — pinned by the pre-existing preview-serving tests, which pass unchanged.
- Runtime source asserts zero `fetch` calls and zero remote URLs.
- Browser-level rendering (actual canvas frames, pointer response, mobile viewport, reload, published URL) is covered in the M15-M17 delivery report's Agent Browser verification section — the automated suite cannot produce pixels, and this report does not claim it did.

## Mobile + desktop viewports

Automated: `responsive.mobile` modes are compiled into the program and honored by the runtime (`reduced` → scaleMobile floor + halved speed; `off` → no init) — source-asserted. Browser viewport matrix results are in the delivery report.

## Baseline discipline

No pre-existing test was modified and no unrelated baseline failure was touched (full-suite results in the delivery report).
