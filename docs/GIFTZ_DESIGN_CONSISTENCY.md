# GIFTZ Design Consistency Engine (M17 §8)

Module: `applyDesignConsistency` / `enforceDesignConsistency` in `src/lib/giftz/component-intelligence.ts`.

## What it understands

The engine reads the site's existing design language from the theme + brief:

- brand palette (background/foreground/accent tokens),
- typography (typeScale, fonts, weights),
- spacing/density (compact/regular/relaxed),
- border radius, content width, layout columns,
- theme (template genre, e.g. dark-luxury vs minimal-index),
- animation intensity (motion.intensity + GSAP animation set).

## What it enforces

1. **Component-direction compatibility** — a luxury/editorial/portfolio direction flags loud components (heavy WebGL backgrounds, scramble-text) with concrete replacement suggestions ("prefer blur/gradient/line-mask reveals"). A compact+intimate layout is warned away from WebGL backgrounds.
2. **Motion intensity budget** — luxury directions clamp to ≤55, loud/experimental directions may use up to 80, the default budget is 70. `enforceDesignConsistency` applies the clamp to the actual config (never silently — it returns the warning strings that surface in proposals/reports).
3. **WebGL gate** — `webglAllowed=false` for luxury directions unless the brief explicitly asks for immersive/interactive.
4. **Token inheritance (by construction)** — every component renders through the theme-token stylesheet; there is no path for a generated component to introduce a foreign palette, font or radius. A "luxury portfolio with neon buttons" cannot be expressed by the generator without the user explicitly changing the tokens themselves.

## Where it runs

- **AI planning** — prompts carry restraint rules ("a luxury portfolio gets no neon/toy interactions; a minimal SaaS page gets no heavy 3D") plus the capability doc; the deterministic `selectComponents` already filters by direction keywords.
- **Post-plan gate** — `enforceDesignConsistency(config, brief)` runs on built configs in the pipeline helpers (exported for the turn pipeline + tests), returning the normalized config + warnings.
- **Build validation** — the >12-animation warning and the motion sanity checks (existing verify.ts + new motionBuildChecks) back the engine up at build time.

## Examples (tested)

- Luxury portfolio brief + `vanta-webgl-background` + `scramble-text` requested → two warnings, intensity budget 55, webglAllowed false.
- Same brief with `motion.intensity = 95` → config clamped to ≤55 with an explicit "intensity clamped" warning.
- Minimal developer brief → CSS-only selection, no heavy components.
- SaaS brief → counters + tabs + CSS background selected; heavy components absent.
