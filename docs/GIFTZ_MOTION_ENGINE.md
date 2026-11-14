# GIFTZ Motion Engine — Architecture

Module: `src/lib/giftz/motion-engine.ts` (pure — no fs/db, client-safe). Consumers: `lib/site-config.ts` (schema), `lib/site-export.ts` (compiler), `lib/giftz/project-build.ts` (validator), `lib/giftz/project-agent.ts` + `lib/ai-design/prompts.ts` (AI vocabulary), Motion tab UI.

## Layers

```
site.config.json (motion.gsap + backgroundEffects)          ← validated data, never code
        │  normalizeConfig → validateGsapMotionBlock / validateBackgroundEffects
        ▼
compileMotionProgram(config) → MotionProgram | null          ← selectors resolved, plugins derived
        │
        ├─ buildMotionRuntime(program) → assets/motion.js    ← FIXED interpreter + program JSON
        ├─ vendorFileSpecs(program)    → assets/vendor/*.js  ← pinned npm dist files
        └─ motionScriptTags(program)   → <script> tags       ← deferred, local, ordered
```

## The runtime interpreter

`assets/motion.js` is a single fixed, audited IIFE (~30KB). It is generated per site but the CODE is constant — only the embedded JSON program differs. This is the core safety decision: **presets are structured data; the AI never emits executable animation logic** (custom JS has its own guarded path — see the security doc).

Runtime responsibilities:
1. Reduced-motion gate: `matchMedia('(prefers-reduced-motion: reduce)')` + `?motion=static` (preview) + `?motion=on` (testing override); static fallback otherwise.
2. Vendor presence check: if `window.gsap` is missing (load failure), content stays fully visible and a console warning is logged — animation failure never hides content.
3. Plugin registration: only the globals actually present are registered.
4. Program execution: one handler per preset id (39 handlers); targets via validated selectors; per-element duplicate-init guards; ScrollTrigger with `limitCallbacks` + `ignoreMobileResize`.
5. Vanta init: WebGL capability detection → `new VANTA[effect]({ el, THREE, ...settings })` (hex strings → ints; CLOUDS2 gets the local `texturePath`); any failure → static fallback background.
6. Lifecycle: `gsap.context()` revert + Vanta destroy + interval cleanup on `pagehide`; mobile "off/reduced" per-animation responsiveness.

## Configuration schema (site.config.json)

```jsonc
{
  "motion": {
    // ...existing CSS motion tokens (unchanged)...
    "gsap": {
      "enabled": true,
      "respectReducedMotion": true,
      "animations": [
        {
          "id": "hero-title",                  // kebab-case, unique
          "preset": "word-reveal",             // registry id — unknown ids are rejected
          "target": { "kind": "section", "sectionId": "hero-1", "element": "heading" },
          "trigger": { "type": "scroll", "start": "top 85%", "end": "+=100%", "once": true },
          "options": { "duration": 900, "stagger": 80, "easing": "power3.out" },
          "responsive": { "mobile": "full" },  // full | reduced | off
          "reducedMotion": "static",
          "enabled": true
        }
      ]
    }
  },
  "backgroundEffects": {
    "enabled": true, "engine": "vanta", "effect": "FOG",
    "target": { "kind": "hero" },              // page | hero | section (+sectionId)
    "settings": { "speed": 1.2, "highlightColor": "#d4af6a" },
    "responsive": { "mobile": "reduced" },
    "accessibility": { "respectReducedMotion": true },
    "fallback": { "kind": "color", "value": "#101014" }
  }
}
```

Validation contract (all enforced, tested):
- unknown preset/effect ids → rejected (config mode) or dropped (normalize);
- unknown settings keys → rejected (per-effect strict allowlists derived from the installed package's real defaults);
- invalid selectors → rejected (conservative allowlist regex — classes/ids/tags/combinators; no quotes, braces, `javascript:`);
- invalid ScrollTrigger positions → rejected (`top 85%`, `bottom top`, `+=120%` grammar);
- invalid durations/delays/staggers → rejected by zod ranges;
- unknown easing names → rejected (GSAP easing ids + `gz-*` CustomEase registrations only);
- duplicate animation ids → rejected; duplicate target+selector → flagged.

## Two-way synchronization

- **S1 (content → files):** every config save re-compiles the tree; vendor/runtime rows are replaced, stale generated rows deleted, `user`/`ai` rows skipped and counted (`skippedUserFiles`).
- **S2 (files → content):** editing `site.config.json` in the Code workspace validates through the same schema gate before `GiftzSite.config` updates.
- The Motion tab saves through `PUT /api/giftz/sites/[id]` — the same contract, so every path produces identical output.

## Versioning

`assets/motion.js`, `assets/vendor/*` and `site.config.json` are part of version snapshots; restore semantics are unchanged (full file-tree snapshots, source-preserving restore).
