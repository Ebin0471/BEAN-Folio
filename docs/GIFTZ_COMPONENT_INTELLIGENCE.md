# GIFTZ Component Intelligence (M17)

**Status: delivered.** GIFTZ can now intelligently select and generate sophisticated, original, responsive components through natural-language instructions — while generated websites remain editable, portable, real-file projects with deterministic builds, isolated previews, version history and reliable deployment.

## Position on React Bits (read this first)

React Bits (github.com/DavidHDev/react-bits) was used **strictly as a design and technical reference** for interaction patterns (animated typography, galleries, micro-interactions). Its license is MIT + Commons Clause — **not** plain MIT — so nothing was copied, bundled, redistributed or exposed. Every component GIFTZ generates is an **original GIFTZ implementation** rendered from the content model through the deterministic exporter. Full analysis: `docs/GIFTZ_REACT_BITS_LICENSE_REVIEW.md`.

## The three engines

| Engine | Module | Role |
|---|---|---|
| Capability registry | `src/lib/giftz/component-intelligence.ts` — `COMPONENT_REGISTRY` (34 entries across categories A-F) | the single vocabulary of what GIFTZ can generate |
| AI selection | `selectComponents(brief)` deterministic mapper + `componentCapabilityDoc()` in the planner prompts + `componentSelectionRules()` in the file-agent prompts | picks a FOCUSED set that serves the design; reuse-before-add |
| Design consistency | `applyDesignConsistency()` / `enforceDesignConsistency()` | inherits the site's design tokens; clamps intensity; flags incompatible choices |

## Categories (M17 §3 mapping)

- **Typography (8):** split-word-reveal, character-reveal, line-mask-reveal, typewriter, rotating-headline, scramble-text, gradient-headline, blur-reveal.
- **Interactive (8):** hover-lift-card, magnetic-button, card-tilt, animated-tabs, nav-hover-motion, accordion-motion, modal-transition, animated-counter.
- **Galleries & media (6):** masonry-gallery, strip-gallery, editorial-rows, gallery-flip, parallax-media, video-reel.
- **Backgrounds (3):** css-animated-background, vanta-webgl-background, gsap-scene-background.
- **Layout (8):** hero (4 variants), bento-grid, stats-band, pricing-table, testimonials-wall, timeline-section, process-steps, contact-band.
- **Micro-interactions (4):** css-micro-hover, scroll-progress-bar, page-transition, stagger-entrance-grid.

Every entry declares: id, category, description, framework, styling approach (`theme-tokens` — always the site's own token system), required dependencies, animation engine, the concrete platform implementation it maps to (preset ids / section layouts / motion tokens), a props schema (zod), responsive support, accessibility notes, performance class, origin (`original`), license, version and compatibility status. The registry distinguishes original GIFTZ components (all entries today) from approved third-party (none) and reference-only material (React Bits — never installable).

## How a request becomes components (M17 §4 / §11)

```
Natural-language request
→ existing AI router (site category + visual direction understood from the brief)
→ project context (existing sections/components reused where they exist)
→ component selection (prompt vocabulary + deterministic selection + consistency gate)
→ validated AI plan (config patches / file plan)
→ actual project files (deterministic compiler emits HTML/CSS/JS — never runtime-dependent code)
→ build validation (real build + motion checks)
→ AI repair (up to 2 rounds, fed by real diagnostics)
→ proposal preview → user approval → atomic apply → final build → existing publishing pipeline
```

Example: "Build a premium photography portfolio with beautiful animations" → cinematic/luxury markers select split-word-reveal + parallax-media + gallery components + CSS atmosphere; heavy WebGL is flagged incompatible by the consistency engine; the plan lands as `motion.gsap` presets + section layouts — not every effect at once.

## Guarantees

- Generated components live inside the real project file tree (portable, exportable).
- No component depends on the GIFTZ application runtime.
- No arbitrary remote scripts, no unsafe dynamic evaluation, no duplicated CSS (theme tokens are compiled once).
- GSAP/Vanta integrations reuse the M15/M16 engines — no overlapping animation systems, no unused dependencies.

See: `docs/GIFTZ_COMPONENT_REGISTRY.md`, `docs/GIFTZ_COMPONENT_GENERATION.md`, `docs/GIFTZ_DESIGN_CONSISTENCY.md`, `docs/GIFTZ_COMPONENT_PERFORMANCE.md`, `docs/GIFTZ_COMPONENT_TEST_REPORT.md`.
