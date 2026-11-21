# Delivery 20 — CODE GIFTZ Autonomous Website Engineering Expansion (GZ-1..GZ-4)

**Status:** implemented and verified in this session. **Not deployed.**
**Scope:** the four authorized sub-batches (GZ-1 agent quality, GZ-2 professional
editing, GZ-3 3D & animation studio, GZ-4 lifecycle completion) as targeted,
additive extensions of the existing GIFTZ experience — no UI redesign, no new
queues/platforms/AI providers, no schema migration, no RIISHE/LAXII changes.

---

## 0. Repository audit — baseline capability matrix (recorded before any change)

Starting point: `origin/main` = `d3898085ea87d07d55d0677c8b241bc0c1555399`
(local main == remote, clean tree; `/home/z/bean-folio` did not exist — the
authoritative workspace is `/home/z/my-project`, verified via `git ls-remote`).

| Capability | State at baseline | GZ disposition |
| --- | --- | --- |
| Chat pipelines (config + file-level) | working: router → plan (zod + tree validation + 1 repair) → ≤4-file overlay batches with 3-tier recovery → build (+2 repair rounds) → proposal → apply-on-save | GZ-1 improved, not replaced |
| Real project file store | DB rows, path confinement, per-file/per-project caps, provenance (generated/user/ai) | preserved, untouched |
| Builds | 8 deterministic checks + artifact; honest FAILED | GZ-1 adds check 9 (static markup sanity) + GZ-3 scene3d checks |
| Publishing | honest state machine (file gate → DEPLOYING → build gate → LIVE), immutable artifact, rollback/unpublish, domains, adapter honesty | GZ-4 verified end-to-end, additive traceability (build id on deployment rows) |
| Preview | owner-only, CSP-isolated, proposal overlay | preserved |
| Motion | GSAP preset registry + Vanta effects + deterministic compiler → `assets/motion.js` + local vendor files | GZ-3 extends with the structured 3D scene engine (same architecture) |
| Code workspace | file tree + plain textarea editor | GZ-2 upgraded to CodeMirror 6 (same layout, same tree, same save contract) |
| Visual editing | element-click selection existed ONLY in Customization (no inspector in CODE GIFTZ) | GZ-2 adds the content-model inspector to CODE GIFTZ mode |
| Versions / diff / restore | server routes + `GiftzVersionDialog` | preserved |
| ZIP export | `downloadSiteCode` | preserved |

What was explicitly NOT duplicated: no second editor/preview/publish system,
no second queue, no new AI provider, no React Three Fiber runtime in the
static pipeline (pattern study only), no GLB/GLTF import (deferred, honestly
documented — see §6 limitations).

## 1. GZ-1 — Agent quality (`src/lib/giftz/project-agent.ts`, `project-build.ts`)

1. **Design-direction discipline** — the file-pipeline plan prompt now requires
   ONE deliberate visual direction (editorial-luxury, minimal-typographic,
   modern-saas, brutalist-experimental, cinematic-product, portfolio-gallery,
   ecommerce-merchandised, immersive-interactive) grounded in the request's
   audience/purpose, committed across pages (restrained palette, real type
   pairing, alternating compositions) and explicitly forbids the default
   "repeated centered gradient heroes with three equal cards".
2. **Multi-page coherence** — plan rules for shared masthead nav with working
   relative links (`./about.html`), per-page `<title>` + meta description,
   index.html entry, mobile collapse at 390px. The plan budget grew 12 → 16
   files (bounded; batching stays ≤4 files per AI call, per-file caps
   unchanged).
3. **Continuity context** — every file-turn planning prompt now carries the
   last 5 `GiftzActivity` entries (bounded, detail-capped) so follow-up turns
   build on what previous turns actually did (resumability).
4. **Honest content + one clarification** — "NEVER invent facts (no fake
   clients/testimonials/metrics/prices)"; at most ONE essential clarifying
   question appended to the plan summary as `QUESTION: …`, execution proceeds
   on sensible defaults (never blocks).
5. **Compiler-owned runtime protection** — `assets/scene3d.js` joined
   `assets/motion.js` + `assets/vendor/*` as unplannable.
6. **Build check 9 — static markup sanity** (honest, static, NOT a browser
   claim): duplicate element ids = error; missing viewport meta / `lang`
   attribute / img alt text = warnings; inline scripts touching
   gsap/THREE/VANTA globals BEFORE the local vendor tags = error.

## 2. GZ-2 — Professional editing

1. **CodeMirror 6 editor** (`giftz/GiftzCodeEditor.tsx`, MIT — versions
   verified in the register): syntax highlighting (html/css/js/json),
   line numbers, active line, bracket matching, history (undo/redo via the
   standard keymap AND toolbar buttons), find & replace (`Ctrl/Cmd+F`, the
   search panel), indent-with-spaces, multiple selections, an obsidian/
   champagne theme matching the workspace, `Cmd/Ctrl+S` → the existing save
   contract, and `jumpTo` line requests for diagnostics navigation.
2. **Code workspace rewrite** (`giftz/CodeWorkspace.tsx`): the tree and all
   operations are unchanged; the editing surface is now professional —
   open-file TABS with per-tab dirty dots and dirty-close confirmation,
   per-path draft state (switching tabs never discards unsaved work),
   Edit/Diff/Preview toggles (the Diff view is a bounded LCS line-diff of
   draft vs saved — `lib/giftz/editor-utils.ts`), an in-file build-diagnostics
   strip for the open file (click → jump to `line N` when the message carries
   one), and **Find in project** through a NEW bounded owner-scoped route
   `GET /api/giftz/sites/:id/files/search?q=` (≤40 results, ≤300 files
   scanned, text rows only, path + 1-based line + excerpt; a match opens the
   file and jumps to the line).
3. **Visual element editing** (`giftz/InspectorPanel.tsx` + builder wiring):
   element-click selection is enabled in CODE GIFTZ mode (it already existed
   only in Customization), and the inspector edits the AUTHORITATIVE
   structured configuration — the SiteConfig section — through the SAME
   `updateSection` mutations the rail uses: heading text, hero subtitle,
   CTA label, about/contact body (only fields the section type actually
   has), heading color, the section background band
   (inherit/none/surface/accent wash/custom hex), content width, spacing and
   heading alignment. Persistence is real: Save → `PUT /api/giftz/sites/:id`
   → sync rule S1 regenerates the project files — the same files the Code
   workspace and the agent edit. Elements outside the content model are
   honestly out of scope (the panel states they belong in the Code
   workspace); no DOM-mutation fakery.

## 3. GZ-3 — Structured 3D scene engine

New pure module `src/lib/giftz/scene3d.ts`, mirroring the GSAP/Vanta
architecture exactly (structured data + one audited runtime, no new
dependency — the pinned local three.js r134 the Vanta engine already carries):

- **Schema/registry**: `scene3d` block on site.config.json (≤3 scenes; per
  scene: target page/hero/section, camera fov/position/lookAt, 1–24 objects
  of 10 geometry kinds with position/rotation(degrees)/scale/material
  (basic|standard, hex color, metalness/roughness/opacity/wireframe)/
  animation (none|rotate|float|pulse|orbit + speed/radius/axis), ≤4 lights,
  pointer interactions (parallax|rotate), hover feedback (scale|spin),
  scroll camera (cameraDolly|cameraOrbit + strength), mobile quality
  (full|reduced|off + pixelRatio cap), optional no-WebGL fallback paint).
  Fail-closed zod validation + registry checks (duplicate ids, unknown
  section targets) in `validateScene3dBlock` and `normalizeConfig` (same
  drop-to-disabled semantics as the gsap block).
- **Compiler**: `compileMotionProgram` now compiles the block into
  `MotionProgram.scene3d`; `vendorFileSpecs` adds the local three.min.js;
  `motionScriptTags` emits `assets/vendor/three.min.js` +
  `assets/scene3d.js` (and NO motion runtime when GSAP/Vanta are absent);
  the exporter emits the runtime file.
- **Runtime** (`assets/scene3d.js`, generated): fixed interpreter — WebGL
  probe, reduced-motion guard (`prefers-reduced-motion` + `?motion=static` /
  `?motion=on`), decorative canvas (pointer-events: none, never blocks
  clicks), window-level pointer listeners, raycast hover, scroll-linked
  camera, IntersectionObserver pause when off-screen, resize handling,
  mobile pixel-ratio reduction, and full disposal on pagehide (rAF cancel,
  listener removal, geometry/material/renderer disposal, canvas removal).
  No eval, no fetch, no CDN; the JSON embed is `<`-escaped (defense in
  depth — the schema cannot produce `<`).
- **Editor**: the Motion workspace gained a "3D scenes" section (enable +
  reduced-motion + per-scene accordion editors for target/camera/objects/
  interactions/scroll/quality/fallback) saving through the existing
  `PUT /api/giftz/sites/:id` contract → compiler regenerates vendor + runtime.
- **AI access, both pipelines**: the file pipeline's motion rules embed
  `scene3dCapabilityDoc()` (never hand-write three imports, never CDNs, the
  runtime is compiler-owned); the site-studio config pipeline gained
  `scene3d` on the design patch schema (strict block-schema passthrough in
  the sanitizer — invalid blocks are dropped, `null` keeps the documented
  disable semantics), executor application (full-block replace, null =
  disable), the planner prompt contract, and the `motion.configure` tool
  description.
- **Build checks**: missing `assets/scene3d.js` = error; pages not
  referencing the three vendor script = warning; >36 total objects = honest
  perf warning.
- **GLB/GLTF import: deferred.** Loading third-party models would require a
  threat-model review of the serving CSP (glTF textures resolve via
  `<img>`, which `img-src *` would allow to reach remote hosts) and a
  vendored loader — documented as a limitation, NOT silently attempted.

## 4. GZ-4 — Project lifecycle completion

Audited end-to-end and verified rather than rebuilt: build-before-publish
gate, immutable verified artifact (pre-deploy parse), honest DEPLOYING→LIVE /
FAILED states, single-LIVE-row invariant, rollback + unpublish, custom
domains with real DNS verification and the honest routing note, versions
with diff/restore, ZIP export, per-project activity audit. Additions:
the new static markup checks feed failed-build diagnostics, and deployment
rows now surface their originating build id (traceability).

## 5. Verification (real exit codes, this session)

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` | **exit 0** (clean) |
| `bun run lint` | **exit 0 — 0 errors, 13 warnings** (identical to the pre-change baseline: all 13 pre-existing) |
| `scripts/ci/run-tests.sh` (canonical per-file runner, isolated QA DB pinned) | **93/94 files pass; 1 pre-existing failure**: `tests/laxii-banner-phase3.test.ts` "long text shrinks to fit the safe area" hits the 5s timeout — verified IDENTICAL on the stashed baseline (unrelated LAXII module, environment flake) |
| New suites | `tests/giftz-scene3d.test.ts` 28 pass · `tests/giftz-agent-quality.test.ts` 22 pass (schema fail-closed, validation, compilation, runtime contract incl. the rAF-cleanup bug the test caught, normalizeConfig round-trip, build diagnostics, markup checks, plan boundaries, prompt contracts, lineDiff, editor language map, workspace contracts) |
| Production build (`rsync → /tmp/bean-build → bun run build`) | **exit 0** |
| `./ensure-dev.sh` | dev server healthy; upload sentinel OK (401) |

**Baseline comparison:** fixed — the healthy-tree build fixture now carries
`lang` + viewport meta (it was asserting "healthy" against the new checks;
the FIXTURE was strengthened, the checks were not weakened). No pre-existing
failures changed status except the documented LAXII flake. New regressions: none.

## 6. Known limitations (honest)

- GLB/GLTF model import is not implemented (CSP threat-model review
  required first — see §3).
- Visual element editing maps to the content model (SiteConfig sections);
  elements of custom user/AI HTML files are not DOM-mapped and the inspector
  says so (Code workspace is the path for those).
- Build check 9 is a static HTML-shape lint — runtime/visual behavior is
  verified by the real preview and the published URL, never claimed by the
  build.
- The `laxii-banner-phase3` 5s-timeout flake is pre-existing (baseline
  verified) and unrelated to GIFTZ.
- External hosting adapters remain honestly "not configured" (per contract).

## 7. Scope discipline

BEAN Folio branding/obsidian-champagne theme untouched; the GIFTZ
conversation experience, canvas and workspace layout preserved; no schema
migration (the 3D block lives inside the existing `GiftzSite.config` JSON);
no RIISHE/LAXII changes; no new AI providers, queues, runtimes or payment
systems; **not deployed**.

---

## 8. Publication-session amendment (2026-11-21, later session)

The implementation above was committed locally in the implementation session
but **not published**. A follow-up session audited the commit, re-verified
everything independently, fixed one real defect found by live-browser
verification, completed the remaining license action item, and published the
work through the verified bean-sync workflow.

### 8.1 Independent re-verification (executed in the publication session)

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` | **exit 0** |
| `bun run lint` | **0 errors / 13 warnings** — identical to the protocol §6 baseline |
| `scripts/ci/run-tests.sh` (isolated QA DB: `prisma db push` + `scripts/seed.ts` + `scripts/restore-qa-fixtures.ts`) | **94 files: 0 failures** (92 pass + 2 env-gated live-HTTP suites that then pass against the healthy dev server: `media-upload-http` 9/9, `ox-opportunity-live-http` 4/4). Setup note: the canonical seeding chain includes `restore-qa-fixtures.ts` — running only `seed.ts` makes `tests/auth.test.ts`'s isDemo invariant fail on the fresh DB (documented seed gap, not a code failure). The doc-20 original run's `laxii-banner-phase3` 5s-timeout flake did not reproduce. |
| Dev server | `./ensure-dev.sh` healthy; upload sentinel 401 (not 405) |
| Production build | verified exit 0 in the implementation session (doc §5); source unchanged by the publication-session fix except the one file in §8.2, re-type-checked clean |

### 8.2 Real defect found and fixed by browser verification — GZ-2 inspector gate

Live browser verification (register a real account → generate a site through
the GIFTZ chat → open the workspaces) exposed that **the GZ-2 visual element
inspector could never mount in CODE GIFTZ mode**: clicking a generated-site
section correctly selected it (the renderer set the id, e.g.
`hero-mwqijfaa-1`), but the inspector's gate resolved `selectedSection` from
the PORTFOLIO draft config (`activePage` ← `config`), in which generated-site
section ids never exist — the lookup always missed.

Fix (one mode-aware resolution in `src/views/WebsiteBuilderView.tsx`):
`selectedSection` now looks up the selected id in the generated website's
config (`giftzSite.config`, or the active config proposal — matching the
inspector panel's own resolution) when `mode === "giftz"`; the Customization
path is byte-identical to before (page-scoped lookup on the portfolio draft).

Post-fix browser verification of the full chain: element click → inspector
mounts ("hero · hero-mwqijfaa-1 — edits persist to the website source on
save") → heading text edit → honest isolated proposal preview
("Visual edit — the hero section was changed in the inspector") → Save Draft
→ config persisted (`heroTitle` updated) → sync rule S1 regenerated
`index.html` containing the new title.

### 8.3 License register action item completed

`GIFTZ_OPEN_SOURCE_REGISTER.md` §6.3: all 9 `@codemirror/*` packages were
install-time re-verified (`LICENSE` files read, exact pins recorded) and the
§2.2 rows flipped to "vendored+verified". The GSAP canonical-text fetch
attempted again this session — still behind the bot-verification
interstitial, honestly left UNVERIFIED in the register.

### 8.4 Live browser verification evidence (QA project `cmwqilapf009rndww2uox604u`)

Golden path executed in the real app (QA account `gz-browser-qa`): chat turn
→ AI proposal → Save Draft (site + project files created, sync rule S1) →
Code workspace (CodeMirror 6 editor: syntax highlighting, line numbers, tabs
with dirty dots, Edit/Diff/Preview toggles, bounded LCS diff "2 added /
1 removed", Ctrl+S save → "File saved" → byte-verified persistence via the
files API) → Find in project (path:line:excerpt results → click jumps to the
line, active line verified) → Motion workspace (3D scenes editor: enable,
scene accordion with target/camera/objects/interactions/scroll/quality/
fallback → Save motion → `scene3d` block persisted; compiler emitted
`assets/scene3d.js` (14,450 B, **no eval, no fetch, no CDN**, reduced-motion
guard + pagehide disposal) + local `assets/vendor/three.min.js`; index.html
references both, zero CDN scripts) → Build workspace (Run build → all checks
passed) → Publish → LIVE with the honest routing note → public URL renders
the generated site **with the live 3D scene** (golden torus + icosahedron)
inside the CSP-sandboxed iframe → deployment row LIVE with its originating
build id (traceability) → visual inspector chain (§8.2).

Evidence screenshots: `agent-ctx/shots/gz-verify-code-editor.png`,
`gz-verify-find.png`, `gz-verify-diff.png`, `gz-verify-motion.png`,
`gz-verify-build.png`, `gz-verify-published.png`.

### 8.5 Honest residue

- The QA project, its published URL and the QA account remain in the live
  sandbox database as verification artifacts (owner may delete them).
- One test-artifact user row
  (`ox-opp-live-e374e722…@beanfolio.test`, "Live Nonmember", zero content
  rows) was left in the live DB untouched: a live-HTTP suite registers
  throwaway accounts through the real flow and does not clean them up (suite
  design gap, disclosed — not silently deleted per DEVELOPMENT_SAFETY §2).
- `styles.css` of the QA project carries a `/* gz-browser-verify edit
  marker */` comment from the save-contract test (QA artifact).
