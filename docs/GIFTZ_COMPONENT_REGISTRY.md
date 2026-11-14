# GIFTZ Component Registry

Source: `COMPONENT_REGISTRY` in `src/lib/giftz/component-intelligence.ts`. Validation test: `tests/giftz-motion-engine.test.ts > component intelligence registry`.

## Schema (M17 §5 fields — every entry carries all of them)

| Field | Meaning |
|---|---|
| id / name / category / description | identity + classification (categories: typography, interactive, galleries, backgrounds, layout, micro-interactions) |
| framework | `static-html` (deterministic exporter) or `react-rendered` (live platform renderer, e.g. video reel) |
| styling | `theme-tokens` — every component inherits the site's palette/type/spacing/radius tokens; never hard-coded styles |
| requiredDependencies | exact npm libs the generated site needs (kept minimal; `[]` for pure CSS components) |
| animationEngine | none / css / gsap / vanta |
| implementation | the concrete platform capability it maps to (gsap preset ids, section layouts, motion tokens) |
| propsSchema | zod schema for configuration |
| responsive | always `true` (and the generated markup must hold 360-1920px — see the test report) |
| accessibility | concrete a11y contract (sr-only copies, native semantics, reduced-motion behavior) |
| performance | light / moderate / heavy |
| origin / license / version / compatible | provenance: **all current entries are `original` / "GIFTZ original (no third-party source)"** |

## Registry classification rules

- **Original GIFTZ components** — installable, all 34 entries today.
- **Approved third-party components** — would require an OPEN_SOURCE_REGISTER entry + license review; none exist.
- **Reference-only examples** — React Bits patterns; explicitly never installable; no registry entry references its source.
- **Unsupported components** — anything outside the registry is named "unsupported" by the honesty rules in the AI prompts.

## The 34 components (summary)

**Typography:** split-word-reveal, character-reveal, line-mask-reveal, typewriter, rotating-headline, scramble-text, gradient-headline, blur-reveal.
**Interactive:** hover-lift-card, magnetic-button, card-tilt, animated-tabs, nav-hover-motion, accordion-motion, modal-transition, animated-counter.
**Galleries & media:** masonry-gallery, strip-gallery, editorial-rows, gallery-flip, parallax-media, video-reel.
**Backgrounds:** css-animated-background, vanta-webgl-background, gsap-scene-background.
**Layout:** hero-classic, bento-grid, stats-band, pricing-table, testimonials-wall, timeline-section, process-steps, contact-band.
**Micro-interactions:** css-micro-hover, scroll-progress-bar, page-transition, stagger-entrance-grid.

## Programmatic API

```ts
getComponent(id)                       // entry or null (honest unknown)
componentsByCategory(category)         // filtered list
selectComponents(brief)                // deterministic selection + reasons
applyDesignConsistency(brief, theme, ids)  // warnings + intensity budget + webglAllowed
enforceDesignConsistency(config, brief)    // clamped config + warning strings
componentCapabilityDoc()               // planner vocabulary block
componentSelectionRules()              // file-agent selection rules block
```

`selectComponents` rules: direction keyword matching (cinematic/luxury/playful/minimal/tech/immersive), section-driven mapping (stats→counters, gallery→masonry...), constraint filtering (`no-heavy-webgl`, `offline`), baseline micro-interactions for every site. Deterministic and unit-tested.
