# BEAN Folio — Website-Editor / Publishing OSS Evaluation (Legal Reuse Register)

**Task:** owner TXT spec Part B (§3–5). **Evaluated:** 2026-11-24 (UTC), live registry + upstream
verification; full raw evidence in `agent-ctx/oss-research-B1.md` (workspace-only file, not
committed). **Decision authority:** this register implements the spec's recommended choice
(GrapesJS core) and documents the legal provenance of everything actually reused.

**Verification method & limitation (honest):** every license/version was verified live against
`registry.npmjs.org` metadata and upstream LICENSE files via `raw.githubusercontent.com`.
`api.github.com` was hard rate-limited (HTTP 429) from this sandbox for the entire research
window (retried 5× per repo); repository liveness was therefore verified via commit Atom feeds
and archived-banner checks instead of the REST API — both succeeded for every candidate.

---

## 1. Decision summary

| Candidate | Verdict | Role |
| --- | --- | --- |
| **GrapesJS core** (`grapesjs` 0.23.9) | **SELECTED** | GIFTZ visual editor core (BSD-3-Clause; pinned exact version) |
| Puck (`@measured/puck` → `@puckeditor/core`) | Evaluated, NOT adopted | Documented as the React-native alternative for a future SiteDesign structured-editor integration only |
| VvvebJs (`vvvebjs` 2.0.9) | Evaluated, NOT adopted | Vanilla-JS/Bootstrap-5 architecture and bundled-asset audit burden do not fit BEAN's React/Tailwind design system or the GIFTZ generated-file pipeline |
| Craft.js (`@craftjs/core` 0.2.12) | Evaluated, NOT adopted | MIT but dormant (last publish 2025-02-14); would require building the entire editor UX |
| Webstudio | **REJECTED (legal)** | Core AGPL-3.0-or-later + a proprietary-licensed animation package in the same org — spec forbids reuse without explicit owner legal review; kept out of any dependency graph |
| Vercel Platforms | Architectural reference ONLY | **No root LICENSE file exists** (main/LICENSE → HTTP 404; also LICENSE.md/.txt/COPYING); repo `private: true`, no license field. Nothing copied, vendored or forked — ideas only (subdomain→tenant routing shape, local-dev behavior) |

## 2. GrapesJS — exact provenance of what is reused

- **Upstream repository:** https://github.com/GrapesJS/grapesjs
- **Pinned version:** `grapesjs@0.23.9` (npm dist-tag `latest`, published 2026-11-03) — installed
  with an EXACT version pin (no `^` range) so license audits bind to one tree.
- **License:** **BSD-3-Clause** — verified twice: npm metadata (`license: BSD-3-Clause`) and the
  upstream LICENSE file (`Copyright (c) 2017-current, Artur Arseniev` + full 3-clause text),
  re-verified **in-package at the pinned version** (`node_modules/grapesjs/LICENSE`) after install.
- **Package dependency footprint:** 5 runtime dependencies (backbone, codemirror.framework,
  underscore, etc. — all MIT/ISC-class permissive; audited in evidence file). **No paid-service or
  commercial dependency.**
- **Commercial product separation (verified):** `@grapesjs/studio-sdk@1.2.1` ("GrapesJS Studio",
  Grapes Studio Inc. EULA, license keys + watermarks) is a SEPARATE package that **depends on**
  the core — the core does not depend on it. **Not installed, not referenced.** BEAN uses the
  open-source core only, per spec.
- **Third-party GrapesJS plugins:** **none installed.** The upstream plugin ecosystem carries
  independent licenses; the audit rule "plugin licenses are not covered by the core license" is
  satisfied by using zero plugins — BEAN blocks/presets are original code.
- **What is reused:** the library AS AN INSTALLED DEPENDENCY (no vendoring, no fork, no
  `node_modules` modification). BEAN-specific adapters/extensions are original BEAN code:
  - `src/lib/giftz/visual-editor/grapesjs-config.ts` — editor construction config, BEAN styling,
    block presets (hero/about/projects/contact) written for BEAN; **not copied from upstream
    examples or presets** (upstream's `gjs-preset-webpage` is deliberately NOT installed).
  - Import/export adapter (project files → editor → project files) with the round-trip +
    reconciliation contract (see `docs/architecture/multi-tenant-publishing.md` §12).
- **License obligations honored:** BSD-3-Clause requires retaining the copyright + license text
  in redistributions of the library — satisfied because the library ships as an npm dependency
  with its LICENSE file intact (never stripped, never modified); the attribution note below
  records provenance for the product documentation. Upstream trademarks/branding are not used
  as BEAN product branding. No upstream notices altered; BEAN claims no ownership of GrapesJS.
- **Attribution note (product-facing):** "GIFTZ visual editing is powered by the open-source
  GrapesJS library (BSD-3-Clause, © Artur Arseniev / GrapesJS contributors)."

## 3. Candidate evaluations (facts + reasons)

### GrapesJS 0.23.9 — SELECTED
- BSD-3-Clause (permissive), active (0.23.7/0.23.8/0.23.9 on 2026-10-13/10-15/11-03; dev-branch
  commit 2026-11-13), 5 deps, HTML/CSS round-trip serialization designed for exactly the GIFTZ
  use case (real static HTML/CSS/JS project files), layer/style manager, responsive preview
  frames, project JSON — matches spec §14's required capability list out of the box.
- Spec-preferred starting point ("This is the preferred starting point for GIFTZ").

### Puck — NOT adopted (now)
- `@measured/puck@0.20.2` is **deprecated** ("Puck has moved") → successor `@puckeditor/core`
  0.24.2 (MIT, 2026-11-23, React ^18||^19). Extremely active, but it is a **React structured
  component editor**, not an HTML/CSS file editor — adopting it now would bypass GIFTZ's real
  file pipeline (spec explicitly forbids replacing GIFTZ static-file generation). Also carries 37
  top-level deps incl. a `latest`-pinned CLI package (supply-chain churn). **Kept documented as
  the future SiteDesign structured-editor option** (spec Alternative 1 role).

### VvvebJs 2.0.9 — NOT adopted
- Apache-2.0 verified (upstream LICENSE). Vanilla JS + Bootstrap 5 UI; npm dist ships the full
  builder with bundled third-party components/templates whose individual licenses would each
  need auditing (spec §5 audit requirement) for a UI incompatible with BEAN's React design
  system. Quiet maintenance (~5 months since last commit 2026-07-01). Rejected on fit + audit
  burden, not on license.

### Craft.js — NOT adopted
- `@craftjs/core@0.2.12`, MIT, 4 deps. **Dormant: last publish AND last upstream commit
  2025-02-14 (~21 months).** Would require building the whole editor UX from framework parts.
  Rejected: maintenance risk + effort, per spec's warning ("do not select it simply because it
  is open source").

### Webstudio — REJECTED (legal, per spec)
- Core `@webstudio-is/sdk@0.314.0`: **AGPL-3.0-or-later** (license text fetched and verified).
- **Proprietary exception confirmed:** `@webstudio-is/sdk-components-animation@0.314.0` carries
  `LicenseRef-Webstudio,Inc-Proprietary` with a "Webstudio, Inc. EULA" license file — exactly the
  mixed-licensing hazard the spec flags. AGPL implications for a proprietary product + a
  proprietary package in the same org → **not installed, not vendored, not referenced**; any
  future reconsideration requires explicit owner legal review (spec rule).

### Vercel Platforms — reference only (no license)
- No root LICENSE (main/LICENSE, LICENSE.md, LICENSE.txt, COPYING all HTTP 404), `private: true`
  package. **Zero source copied** — the tenant-routing design (`src/lib/tenant-host.ts`,
  `src/proxy.ts` host logic) is original BEAN code; the repo informed only the architectural
  questions (resolve subdomain → tenant context at the edge, keep tenant resolution out of the
  data layer, local-dev wildcard behavior).

## 4. Maintenance rules recorded for THIS register

1. Any version bump of `grapesjs` requires re-verifying the in-package LICENSE at the new pinned
   version and re-running the round-trip test suite before merge.
2. No GrapesJS plugin may be added without its own license audit recorded here.
3. `@grapesjs/studio-sdk` (commercial EULA) must never enter the dependency tree.
4. Webstudio packages must never enter the dependency tree without owner legal approval.
5. BEAN-original adapter code (`grapesjs-config.ts`, import/export adapter) carries BEAN's
   project conventions and is the only place editor behavior is customized — upstream stays
   unmodified (no fork, no patch files as of this milestone).
