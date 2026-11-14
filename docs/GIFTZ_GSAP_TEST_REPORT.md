# GIFTZ GSAP Test Report (M15 §13)

**Scope:** automated verification of the GSAP Motion Engine. Run with `bun test tests/giftz-motion-engine.test.ts tests/giftz-motion-compiler.test.ts` (plus the full regression suite — results in the delivery report).

## Suites

### `tests/giftz-motion-engine.test.ts` — 65 tests, 1,106 expect() calls — ALL PASSING

| Describe | Tests | Covers (M15 §13 mapping) |
|---|---|---|
| GSAP preset registry integrity | 4 | animation preset schemas; full contract per preset (name/description/targets/plugins/schema/defaults/trigger/responsive/reduced-motion/cleanup); every plugin exists in the installed dist and fits the per-file cap; spec §3 capability list present |
| GSAP animation config validation | 6 | unknown presets rejected; unsafe selectors rejected; unknown section targets rejected; invalid ScrollTrigger positions rejected; duplicate targets flagged; custom-ease naming; AI animation plan validation |
| Vanta effect registry | 5 | plugin registration surface; dist verification; settings allowlists |
| site.config.json blocks | 3 | project file synchronization (schema gate drops invalid entries, keeps valid); backwards compatibility (byte-identical configs without the new blocks) |
| motion program compilation | 4 | non-animated sites → null program (no dependency injected); selector resolution; plugin derivation; generated-runtime safety (no eval/fetch/remote, reduced-motion + cleanup + fallback present) |
| static export emission | 6 | compiler preservation (vendor files, runtime, script tags, data-gz-section anchors only when enabled); three.js via vendor cap; CLOUDS2 noise texture; manifest honesty; MIME mapping |
| build validation — motion checks | 6 | generated code validation (missing vendor/runtime errors; eval/CDN errors; reduced-motion/cleanup warnings; excessive-animation warning; remote script warning) |
| project agent plan protection | 2 | compiler-owned path rejection (assets/vendor/**, assets/motion.js) + bridge protection |
| component intelligence | 9 | registry validation, selection determinism, capability doc |
| design consistency engine | 2 | intensity clamping, luxury-direction warnings |
| demo fixtures | 17 | **all five M15 demo sites + five M16 Vanta sites + six M17 component sites** pass normalize → compile → export → build-checks, with no-JS readability pinned per fixture |

### `tests/giftz-motion-compiler.test.ts` — 3 tests — ALL PASSING

Real `syncGeneratedFiles` (S1) against an in-memory db fake:
1. motion-enabled config emits vendor rows + runtime; user/ai animation files keep provenance (never upserted); version snapshot + activity recorded.
2. three.min.js (616KB) passes the `assets/vendor/` per-file cap allowance and the generated HTML references it.
3. disabling the engine removes stale generated vendor rows while user files survive.

## Reduced-motion handling (M15 §13)

Pinned at three levels: runtime source contains `prefers-reduced-motion` + `?motion=static` override; every preset declares a reduced-motion alternative (registry test); the Motion tab exposes the static preview toggle (UI). OS-level emulation is exercised in the browser verification step of the delivery report.

## Preview CSP (M15 §13)

Preview/public CSP headers are untouched (`connect-src 'none'`, `default-src 'none'`) — covered by the pre-existing `tests/giftz-project-platform.test.ts > preview serving` suite (7 tests) which still passes, plus the new runtime-safety assertions (no fetch, no remote URLs) in this report.

## Published project behavior + version restoration (M15 §13)

Publish runs the same `runProjectBuild` gate (check 8 included) and deploys the validated artifact; version snapshots include the motion files because they are ordinary project rows — restore semantics are covered by the pre-existing platform tests (`unifiedPatch`, version payload, restore) which still pass.

## Baseline discipline

No pre-existing test was modified. The full regression suite result is recorded in the M15-M17 delivery report; known pre-existing failures (documented in the repo baseline) are unchanged.
