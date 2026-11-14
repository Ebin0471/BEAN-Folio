# GIFTZ WebGL Performance (M16 §8 + M15 §11)

## What a background costs

| Asset | Size | When loaded |
|---|---|---|
| three.min.js (r134) | 615,601 B | only when `backgroundEffects.enabled` |
| vanta.<effect>.min.js | 10,066–28,594 B | only when `backgroundEffects.enabled` |
| gsap.min.js + plugins | 7.9–73.4 KB each | only when `motion.gsap.enabled` |
| nothing | 0 B | sites without motion/background blocks (test-pinned) |

Scripts are deferred and local; there is no CDN round-trip. Preview and published serving send `Cache-Control` per the existing routes (preview no-store, published public 60s).

## Runtime optimizations implemented

1. **Lazy initialization** — the background initializes only after DOM ready, only when the config enables it, only on a client with WebGL.
2. **Device-aware configuration** — `responsive.mobile: "reduced"` sets a `scaleMobile` floor and halves `speed` below 768px; Vanta's own UA detection applies `scaleMobile` natively.
3. **Reduced motion** — no canvas at all; static fallback color (zero GPU work).
4. **Off-screen pause** — VantaBase skips rendering when the target is out of the viewport (verified in the dist source: `isOnScreen()` gates the render loop) unless `forceAnimate` is set (GIFTZ never sets it).
5. **Canvas cleanup** — `destroy()` on `pagehide` removes listeners, cancels rAF and disposes geometries/materials (verified in the dist source).
6. **GSAP side** — `ScrollTrigger.config({ limitCallbacks: true, ignoreMobileResize: true })`; per-element init guards; mobile `off/reduced` per animation; >12 active animations triggers a build warning.

## Measured builds (fixture sites, deterministic export)

| Fixture | Extra motion bytes | Animation files |
|---|---|---|
| non-animated seed | 0 B | none |
| premium-agency (5 GSAP animations) | ~126 KB (gsap + SplitText + ScrollTrigger) + 30 KB runtime | 4 files |
| luxury-agency-fog (Vanta FOG) | ~640 KB (three + fog) + runtime | 4 files |
| GSAP + Vanta combined | ~766 KB | 7 files |

Three.js is the dominant cost and is only ever paid by sites that explicitly request a background effect. For comparison, the same sites' images are capped at 30MB per project by the existing file limits.

## Guidance encoded in the platform

- Registry performance classes (`light/moderate/heavy`) are shown in the Motion tab effect picker and embedded in the AI prompts ("Heavy effects (BIRDS, CLOUDS, CLOUDS2, GLOBE) degrade on mobile — prefer reduced there").
- The design-consistency engine warns when a WebGL background fights a compact/intimate layout and clamps motion intensity by visual direction (luxury ≤ 55%).
- AI plans are instructed to prefer 3-8 animations; the build warns above 12.
- Avoid-list honored by design: no scroll hijacking (ScrollTrigger is used without `scrub`-on-body anywhere except the opt-in progress bar), no constantly-moving decorative content beyond the opted-in background, no layout-property animation (transform/opacity/filter/clip-path only).

## Low-power / slow-network behavior

- JS disabled → content fully readable (noscript CSS + JS-only initial states).
- Slow network → deferred scripts; content renders first, animation attaches after.
- WebGL failure → static fallback, zero retries, no polling.
