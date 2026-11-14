# GIFTZ GSAP Integration (M15)

**Status: delivered.** GSAP 3.15.1 is integrated into GIFTZ as a production animation engine for AI-generated websites — generated through the existing project-file architecture, validated by the existing build system, previewed through the existing isolated preview and published through the existing deployment lifecycle.

## What was integrated

| Concern | Implementation |
|---|---|
| Dependency | `gsap@3.15.1` (exact pin) — core + ScrollTrigger, SplitText, ScrambleTextPlugin, MotionPathPlugin, MorphSVGPlugin, Flip, Observer, CustomEase, Draggable, DrawSVGPlugin (all free in the npm dist since 3.13). `@gsap/react` evaluated and intentionally **not** installed (see `docs/OPEN_SOURCE_REGISTER.md` §4). |
| Engine module | `src/lib/giftz/motion-engine.ts` — 39-preset structured registry, plugin catalog, easing registry, selector allowlist, program compiler, runtime generator. |
| Config schema | `motion.gsap` block inside `site.config.json` (the SiteConfig bridge): `{ enabled, respectReducedMotion, animations: [...] }`. Additive + backward compatible. |
| Deterministic compiler | `buildSiteExport()` emits `assets/vendor/*.js` (read from the pinned npm package), `assets/motion.js` (audited interpreter + sanitized program) and deferred `<script>` tags — only when the config opts in. |
| Provenance | Vendor files + runtime are `generated` rows (compiler-owned); user/AI animation files keep their `user`/`ai` provenance and are never overwritten by sync rule S1. |
| Build validation | `runProjectBuild` check 8 (`motionBuildChecks`) — see `docs/GIFTZ_MOTION_SECURITY.md`. |
| AI pipeline | Config-mode (`motion.configure` patch carries `gsap`), file-mode (`PLAN_RULES` motion block + compiler-owned path protection). Both flow through the existing proposal → approval → apply contract. |
| UI | Motion canvas tab (`src/components/bean/site/giftz/MotionWorkspace.tsx`) — preset/target/trigger/duration/delay/stagger/easing/ScrollTrigger start-end/mobile editors, enable-disable, reduced-motion preview, live file-based preview. |
| Cap registry | `motionCapabilityDoc()` + `componentCapabilityDoc()` give the AI planner the exact available vocabulary. |

## Delivery method (how GSAP reaches a generated website)

1. The site config (via visual editor, Motion tab, chat agent or hand-edited `site.config.json`) carries validated `motion.gsap` data.
2. Every config save runs the deterministic compiler (sync rule S1), which:
   - compiles the animation list into a **program** (resolved selectors, triggers, sanitized options);
   - copies the **exact pinned dist files** from `node_modules` into `assets/vendor/`;
   - generates `assets/motion.js` = fixed interpreter + program JSON;
   - injects `<script src="./assets/vendor/... " defer>` tags into every generated page.
3. Preview (`/api/giftz/sites/[id]/preview/**`) and published serving (`/site/<u>/g/<id>`) serve those rows unchanged — the animation behaves identically in both.

## Design rules enforced everywhere

- Import only what is needed: plugin files are selected per animation set (`pluginsForAnimations`).
- No CDN, no network: `connect-src 'none'` CSP holds; all assets are local.
- Transform/opacity-first: presets animate transform/opacity/filter only.
- Scoped selections: targets are `[data-gz-section="<id>"]`-anchored or allowlist-validated selectors.
- Single initialization: per-element duplicate-init guards inside the runtime.
- Cleanup: `gsap.context()` + `pagehide` revert; Vanta `destroy()`; typewriter interval cleanup.
- Reduced motion: OS preference **and** `?motion=static` preview override; static fallback otherwise.
- Animation is optional: sites without the block bundle **zero** animation bytes (test-pinned).

See: `docs/GIFTZ_MOTION_ENGINE.md` (architecture), `docs/GIFTZ_ANIMATION_PRESETS.md` (registry),
`docs/GIFTZ_ANIMATION_AI_PIPELINE.md` (AI flow), `docs/GIFTZ_MOTION_SECURITY.md` (validation + CSP),
`docs/GIFTZ_GSAP_TEST_REPORT.md` (results).
