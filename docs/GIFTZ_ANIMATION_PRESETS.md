# GIFTZ Animation Presets (M15 §5)

Source of truth: `GSAP_MOTION_PRESETS` in `src/lib/giftz/motion-engine.ts` (39 presets, registry-tested). The CSS preset system (107 presets, `lib/site-motion.ts`) remains fully available and unchanged.

Every preset defines: name, description, compatible target elements, required plugins, a validated options schema, default duration/delay/easing/stagger, trigger, responsive behavior, a reduced-motion alternative and a cleanup contract. All of it is structured data.

## Entrance (9)

| id | Motion | Plugins | Defaults | Reduced motion |
|---|---|---|---|---|
| fade-in | opacity only | core | 700ms power1.out | fully visible, static |
| fade-up | rise + fade | core | 800ms power2.out, distance 28 | visible, static |
| fade-down | drop + fade | core | 800ms power2.out | visible, static |
| slide-left | enters from right | core | 800ms power2.out | visible, static |
| slide-right | enters from left | core | 800ms power2.out | visible, static |
| scale-in | 94%→100% + fade | core | 800ms power2.out | visible, static |
| blur-reveal | blur→sharp + slight scale | core | 900ms power2.out, blur 10 | fully sharp |
| clip-reveal | clip-path window opens | core | 800ms power2.out | clip removed |
| stagger-entrance | children cascade | core | 700ms + stagger 80 | children visible |

Options (entrance family): `distance` (8-200px), `blur` (0-24), plus shared `duration/delay/easing/stagger`.

## Text (8)

| id | Motion | Plugins | Notes |
|---|---|---|---|
| word-reveal | words reveal in order | SplitText | `aria: "auto"` keeps an SR copy |
| char-reveal | per-character cascade | SplitText | for short headings; mobile "reduced" |
| line-reveal | line-by-line entrance | SplitText | |
| split-clip | units slide up inside masks | SplitText | editorial headline style |
| scramble-text | decode scramble | ScrambleTextPlugin | `chars` allowlisted |
| gradient-text | background-clip gradient sweep | core | text stays selectable |
| rotating-headline | cycles 2-8 words | core | words array validated; SR concatenation |
| typewriter | progressive typing | core | sr-only full text; interval cleanup |

## Scroll (8)

| id | Motion | Plugins | Notes |
|---|---|---|---|
| scroll-reveal | generic scroll entrance | ScrollTrigger | start/end validated |
| stagger-cards | grid children cascade | ScrollTrigger | works with `.bs-stagger` carriers |
| parallax-image | scrubbed vertical drift | ScrollTrigger | restrained ±80px; mobile "off" |
| pinned-section | pin + progress | ScrollTrigger | `end: "+=N%"` grammar; mobile "off" |
| horizontal-story | pin + horizontal panels | ScrollTrigger | auto distance; invalidateOnRefresh |
| scroll-progress | scaleX by page progress | ScrollTrigger | works with `.bs-progress` |
| svg-draw | draws inline SVG strokes | ScrollTrigger + DrawSVGPlugin | |
| number-counter | counts stat values | ScrollTrigger | final number always in markup |

## Interactive (8)

hover-lift, magnetic-button, card-tilt, tab-transition (FLIP panels), nav-transition (underline/fade/slide), gallery-flip (FLIP expand), accordion-motion (native `<details>`), modal-transition (fade/scale/flip panel).

All are pointer-device decorations: mobile "off" by default, keyboard focus untouched, instant state under reduced motion.

## Advanced (6)

| id | Motion | Plugins | Guardrails |
|---|---|---|---|
| motion-path | element follows a path | MotionPathPlugin | points: 2-24 validated {x,y}; or inline SVG path selector |
| svg-morph | path A → path B | MorphSVGPlugin | from/to selectors validated |
| flip-transition | FLIP layout toggle | Flip | trigger/target selectors |
| timeline-sequence | chained entrance steps | core | 2-8 steps, fixed entrance vocabulary, offsets ≤ 8s |
| custom-ease | registers a CustomEase | CustomEase | SVG path grammar regex; `gz-*` naming |
| layered-hero | cinematic hero cascade | core + ScrollTrigger | optional cover parallax |

## Shared option fields

`duration` (100-6000ms) · `delay` (0-8000ms) · `easing` (13 GSAP ids or a registered `gz-*` ease) · `stagger` (0-900ms). Every animation also carries `responsive.mobile` (`full`/`reduced`/`off`) and `reducedMotion` (`static`/`simplified`).

## Selection guidance (enforced by prompts)

3-8 well-chosen animations for a typical site; >12 active animations triggers a build performance warning. Entrances sequence the reading order, hovers confirm interactivity, backgrounds set atmosphere — never all three loudly.
