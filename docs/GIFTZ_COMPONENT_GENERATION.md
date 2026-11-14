# GIFTZ Component Generation (M17 §6)

How a selected component becomes a real, editable file inside the project tree.

## Generation surface

Generated websites are static projects compiled by `buildSiteExport()` (`src/lib/site-export.ts`). Components do not exist as shipped JS classes — they are **compiled compositions**:

1. **Structure** — semantic HTML emitted by the section generators (`<header>`, `<section>`, `<nav>`, `<article>`, `<figure>`, `<details>`, real `<a href>` links, ordered lists for timelines/processes).
2. **Styling** — one shared stylesheet per site (`assets/styles.css`) compiled from the theme tokens (fonts, palette, radius, density, width) + motion CSS. Component instances never duplicate CSS; tokens are computed once.
3. **Behavior** — `assets/site.js` (vanilla IntersectionObserver reveals, parallax, progress) + the optional GSAP/Vanta runtime (`assets/motion.js`) driven by the validated config.
4. **Target anchors** — `data-gz-section="<id>"` attributes on every section (only when the motion engine is active) give animations stable, engine-scoped targets.

## Requirements checklist (M17 §6 — how each is met)

| Requirement | Mechanism |
|---|---|
| TypeScript compatibility (React apps) | the content model + compiled output are framework-neutral; the platform's own renderer is React/TS and consumes the same config |
| Semantic HTML | every section generator uses landmark/structural elements; headings ordered (single h1 per page) |
| Responsive CSS | fluid `clamp()` typography, grid auto-fit layouts, single-column collapse (mirror of the live renderer's rules) |
| Accessible interaction | native elements (`<details>`, buttons, links); sr-only copies for split/typed/rotating text; reduced-motion static fallbacks |
| Valid component props | registry props schemas + site-config zod validation (invalid values cannot normalize) |
| Proper event handling | runtime listeners are pointer-only decorations, keyboard semantics untouched |
| No unnecessary dependencies | dependency list per component in the registry; components map to existing sections/presets first |
| No arbitrary remote scripts | local vendor files only; build check flags remote `<script src>` |
| No unsafe dynamic evaluation | interpreter has no eval; validator rejects eval/new Function in custom scripts |
| No duplicated CSS | tokens compiled once per site |
| No unnecessary global styles | per-site stylesheet scoped under `.bean-site` |
| Proper component cleanup | gsap.context revert, Vanta destroy, interval cleanup (pagehide chain) |

## Provenance & ownership (M17 §11)

- Config-driven components: generated rows (compiler-owned, replaced on save).
- User/AI-authored files: preserved by sync rule S1 (`skippedUserFiles` accounting); version snapshots + restore cover both.
- The visual configuration layer (Motion tab / StudioRail) only writes config data — it can never overwrite user-authored animation code, which lives in separate `user`/`ai` rows.

## Export independence

Exported sites reference only their own files (`./assets/...`) and the Google Fonts stylesheet when the config uses bundled families (system fallback stacks included). Generated components therefore work independently when exported — the manifest's `externalResources` field documents every non-local reference honestly.

## Config-mode and file-mode stay synchronized

- Config mode edits the content model → S1 recompiles files.
- File mode (Code workspace / AI file agent) edits files → S2 syncs `site.config.json` back into the content model.
- Both paths run the same validation and produce the same compiled output.
