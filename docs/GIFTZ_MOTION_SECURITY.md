# GIFTZ Motion Security (M15 §10 + M16 §10)

## Threat model

AI-generated (and user-written) animation code ships to visitor browsers inside preview iframes and published sites. The existing isolation contract must hold: no sandbox escape, no CSP weakening, no network access, no arbitrary script execution.

## What did NOT change

- **CSP unchanged**: preview + published serving still send `default-src 'none'; img-src * data: blob:; style-src * data: 'unsafe-inline'; font-src * data:; script-src * data: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors *` (quote from `lib/giftz/preview-serve.ts`). No new origins, no `unsafe-eval`, no sandbox attribute changes (`allow-scripts` preview, `allow-scripts allow-popups allow-forms` public).
- **connect-src 'none' holds**: the motion runtime performs ZERO fetches; all libraries are local files (`assets/vendor/*`). CDN tags are flagged by the build validator.
- **No eval**: the interpreter contains no eval/Function constructor; config reaches it as JSON (JSON.stringify with `<` escaped). The build validator rejects eval/new Function in user/AI animation scripts.
- **No unsafe callbacks through the visual config**: Vanta settings are a strict per-effect allowlist of primitives (numbers, hex strings, booleans) — functions, `onInit`, `mouseControls` handlers etc. cannot be expressed, let alone executed. GSAP options are likewise primitive-validated per preset.

## Delivery trust chain

1. Config → `normalizeConfig` (schema + registry validation; unknown → dropped/disabled).
2. Program → `compileMotionProgram` (selector allowlist, plugin catalog, trigger grammar).
3. Runtime → fixed interpreter string (auditable, constant code; only the JSON payload varies per site).
4. Vendor files → read from the pinned npm package inside the repo (`node_modules/gsap/dist/...`), never from the network.
5. Build → `motionBuildChecks` before every publish (errors block publishing; the pre-publish build gate is the existing one).

## Build validation checks (static analysis — honest limits)

Errors (block publish):
1. Missing motion vendor files or missing `assets/motion.js` referenced by the generated HTML.
2. Unknown preset/effect ids or settings in `site.config.json` (via `compileMotionProgram` issues).
3. `eval` / `new Function` in user/AI animation scripts.
4. CDN references in animation scripts (self-containment + CSP honesty).
5. GSAP/Vanta usage in a script with no corresponding vendor file in the tree.

Warnings (reported, not blocking):
6. `prefers-reduced-motion` guard missing in an animation script.
7. Cleanup pattern (context/revert/kill) missing in an animation script.
8. >12 active GSAP animations (scroll-performance guard).
9. External `<script src>` tags in generated HTML.
10. GSAP enabled in config but no page references the vendor scripts (stale tree).

**Limitation (stated, per M15 §9):** static scanning cannot prove runtime behavior — timing, visual correctness, scroll feel and cross-browser behavior require the real preview and published URL. The Motion tab embeds the actual file-based preview (owner-only route, sandboxed iframe) for exactly this purpose; automated browser verification is documented in the test reports.

## Fallback hierarchy (content-first, M15 §10)

1. JavaScript disabled → HTML content fully visible (noscript CSS + JS-applied initial states only).
2. GSAP fails to load → console warning, content visible, Vanta static fallback.
3. Plugin missing → that animation's handler no-ops (content visible).
4. WebGL unavailable / Vanta init throws → static fallback color/gradient, content untouched.
5. Reduced motion (OS or `?motion=static`) → no GSAP program, no Vanta canvas; fallback background only.
6. Vanta canvas never overlays content (`z-index` 0 inside the target; foreground content stays interactive).

## Bundle & performance impact (measured)

- gsap.min.js 73,357 B; ScrollTrigger 44,683 B; SplitText 7,955 B; ScrambleTextPlugin 11,687 B; MotionPathPlugin 22,002 B; MorphSVGPlugin 21,195 B; Flip 25,596 B; Observer 10,055 B; CustomEase 7,143 B; Draggable 35,762 B; DrawSVGPlugin ~15 KB. Only plugins referenced by the site's animations are emitted.
- three.min.js (r134) 615,601 B + vanta effect 10-29 KB each — emitted only for background-effect sites.
- Sites without `motion.gsap`/`backgroundEffects` emit **zero** motion bytes (test-pinned).

## Registry metadata security facts

- gsap license = GreenSock standard "no charge" license — see `docs/OPEN_SOURCE_REGISTER.md` §4 for the redistribution boundary.
- vanta 0.5.24 = MIT; CLOUDS2's remote texture dependency is satisfied locally (compiler-generated PNG) — the effect performs no runtime fetches; verified by scanning the dist files (no `http(s)://` runtime references in the exposed effects).
