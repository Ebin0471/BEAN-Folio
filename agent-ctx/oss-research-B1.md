# OSS Visual-Editor Research & Verification — Task B-1

**Research date (UTC):** 2026-11-24T03:43Z
**Method:** All data below was pulled live from `registry.npmjs.org` (via `npm view` and `curl` + python parsing), `raw.githubusercontent.com`, `github.com` commit Atom feeds, and GitHub repo HTML pages. **No data was taken from memory.**

**Network limitation (explicit):** `api.github.com` returned HTTP 429 "API rate limit exceeded" for every request from this sandbox (shared egress IPs 47.57.x.x / 8.212.x.x, unauthenticated quota exhausted; retried 5× per repo across several minutes — all failed). Therefore GitHub `pushed_at`/`archived`/`license` API fields could **not** be fetched via the REST API. Workarounds used (all successful):
- License text & copyright lines: `raw.githubusercontent.com` (CDN, not rate-limited)
- Last-commit dates: `https://github.com/<org>/<repo>/commits/<branch>.atom` (Atom feed `<updated>` timestamps)
- Archived status: fetched `https://github.com/<org>/<repo>` HTML pages (HTTP 200) and grepped for the "This repository has been archived" banner — none found for any repo.
- Repo liveness/stars via REST API: unavailable (rate-limited). Where it matters, npm publish dates + Atom commit dates are used as the maintenance signal.

---

## 1. GrapesJS (npm: `grapesjs`)

**Version:** `0.23.9` (dist-tag `latest`), published **2026-11-03T09:14:16.981Z**
**Repository:** `git+https://github.com/GrapesJS/grapesjs.git` → https://github.com/GrapesJS/grapesjs
**License:** **BSD-3-Clause** — verified both in npm metadata and in the repo LICENSE file (master branch):
> `Copyright (c) 2017-current, Artur Arseniev` — followed by BSD "Redistribution and use in source and binary forms..." 3-clause text.

**Deprecation:** none (`npm view grapesjs deprecated` → empty; registry `deprecated: None`).
**Maintenance status:** ACTIVE. Last 3 releases:
| Version | Published |
|---|---|
| 0.23.7 | 2026-10-13T14:30:34.520Z |
| 0.23.8 | 2026-10-15T09:06:11.975Z |
| 0.23.9 | 2026-11-03T09:14:16.981Z |

Repo is actively developed on the **`dev`** branch (last commit 2026-11-13T10:01:59Z per Atom feed); `master` branch last touched 2024-07-02 (release-merge lag, not abandonment). No archived banner on github.com/GrapesJS/grapesjs.

**Dependency footprint:** **5 top-level deps**, all open source, none paid-service:
`backbone 1.4.1`, `codemirror 5.63.0`, `underscore 1.13.8`, `@types/backbone 1.4.15`, `codemirror-formatting 1.0.0` (plus 9 devDeps).

**GrapesJS Studio SDK separation — CONFIRMED:**
- `@grapesjs/studio-sdk` (latest `1.2.1`, published 2026-08-27) is a **separate package** with license field `SEE LICENSE IN LICENSE.md` (not an OSS SPDX id).
- Its tarball `package/LICENSE.md` reads: "This code is licensed under the **Grapes Studio SDK license** (github.com/GrapesJS/studio/blob/main/LICENSE.md)". That license file (fetched from GrapesJS/studio repo, HTTP 200) is a **proprietary/commercial EULA** from "Grapes Studio Inc., a Delaware corporation" with **license-key requirements, watermark protection, and prohibited uses** — i.e., commercial product.
- Dependency direction: `@grapesjs/studio-sdk` **depends on** `grapesjs ^0.23.6` and `@grapesjs/react ^2.0.0` — the Studio SDK *wraps* the OSS core. **The OSS core's dependency list contains NO `@grapesjs/studio-sdk` and no paid-service dependency** — confirmed from registry metadata above.
- Note: `@grapesjs/studio-sdk` has `repository: null` on npm (no public source repo mapping).

**Assessment:** GrapesJS core = genuinely open-source (BSD-3-Clause), lightweight deps (Backbone-era but pinned), very actively published. Studio SDK is a commercial layer on top — irrelevant unless explicitly opted into; importing `grapesjs` alone does not pull any commercial package.

**Evidence commands & key output:**
```
$ npm view grapesjs version license repository.url
version = '0.23.9'
license = 'BSD-3-Clause'
repository.url = 'git+https://github.com/GrapesJS/grapesjs.git'
$ npm view grapesjs deprecated        # (empty)
$ npm view grapesjs dist-tags --json  → { "latest": "0.23.9", ... }
$ curl -s https://registry.npmjs.org/grapesjs/latest | python3 -c ...
  dep_count: 5 ; deps: backbone/codemirror/underscore/@types/backbone/codemirror-formatting ; deprecated: None
$ curl -s https://registry.npmjs.org/grapesjs | python3 (time) → 0.23.9 2026-11-03T09:14:16.981Z ; modified 2026-11-03
$ curl -s https://raw.githubusercontent.com/GrapesJS/grapesjs/master/LICENSE
  Copyright (c) 2017-current, Artur Arseniev / Redistribution and use in source and binary forms ...
$ npm view @grapesjs/studio-sdk version license dependencies
version = '1.2.1'  license = 'SEE LICENSE IN LICENSE.md'
dependencies = { grapesjs: '^0.23.6', '@grapesjs/react': '^2.0.0' }
$ curl -s "https://github.com/GrapesJS/grapesjs/commits/dev.atom" → <updated>2026-11-13T10:01:59Z</updated>
$ curl -sL https://raw.githubusercontent.com/GrapesJS/studio/main/LICENSE.md (HTTP 200)
  "# GRAPES STUDIO SDK LICENSE ... Grapes Studio Inc., a Delaware corporation ... license key ... Watermark"
```

---

## 2. Puck (npm: `@measured/puck` → moved to `@puckeditor/core`)

**Important finding:** `@measured/puck` is now **DEPRECATED**.
- `@measured/puck` latest `0.20.2`, published **2025-09-05T09:18:00.857Z**, MIT, repo `git+https://github.com/measuredco/puck.git`.
- Deprecation message (registry metadata): *"Puck has moved. Please use @puckeditor/core instead: https://www.npmjs.com/package/@puckeditor/core"*

**Successor package `@puckeditor/core`:**
- Version `0.24.2` (dist-tag latest), published **2026-11-23T14:03:44.894Z** (day before research date — very active; canary releases continuous).
- License **MIT**; repository `puckeditor/puck` → https://github.com/puckeditor/puck (GitHub redirect from `measuredco/puck` still serves files: raw README HTTP 200).
- License file (main branch): `MIT License / Copyright (c) The Puck Contributors.`
- Peer dependencies: **`react: '^18.0.0 || ^19.0.0'`** (same on both `@measured/puck` 0.20.2 and `@puckeditor/core` 0.24.2).
- **Dependency footprint:** `@puckeditor/core` has **37 top-level deps** (heavy: TipTap editor family ×18, dnd-kit family ×6, zustand, @tanstack/react-virtual, radix popover, happy-dom, `@puckeditor/cli` pinned to `latest` (!), `@vercel/detect-agent`, etc.). The legacy `@measured/puck` 0.20.2 had 10 deps.
- Maintenance: ACTIVE — `puckeditor/puck` main last commit 2026-11-23T13:43:15Z (Atom); no archived banner.

**Assessment:** Puck is healthy but the package name/registry location changed in late 2025/early 2026 — any `@measured/puck` pin is dead weight; use `@puckeditor/core`. Note the `@puckeditor/cli: "latest"` dependency pin (non-reproducible installs) and large dep surface. MIT licensed, React 18/19 supported.

**Evidence commands & key output:**
```
$ npm view @measured/puck version license repository.url peerDependencies
version = '0.20.2'  license = 'MIT'  repository.url = 'git+https://github.com/measuredco/puck.git'
peerDependencies = { react: '^18.0.0 || ^19.0.0' }
$ npm view @measured/puck deprecated
Puck has moved. Please use @puckeditor/core instead: https://www.npmjs.com/package/@puckeditor/core
$ curl -s https://registry.npmjs.org/@measured%2fpuck | python3 → published 2025-09-05T09:18:00.857Z ; deprecated: (message above)
$ npm view @puckeditor/core version license repository.url peerDependencies deprecated
version = '0.24.2'  license = 'MIT'  repository.url = 'puckeditor/puck'
peerDependencies = { react: '^18.0.0 || ^19.0.0' }   # deprecated: (empty)
$ curl -s https://registry.npmjs.org/@puckeditor%2fcore | python3 → dep_count: 37 ; 0.24.2 published 2026-11-23T14:03:44.894Z
$ curl -s https://raw.githubusercontent.com/puckeditor/puck/main/LICENSE
  MIT License / Copyright (c) The Puck Contributors.
$ curl -s "https://github.com/puckeditor/puck/commits/main.atom" → <updated>2026-11-23T13:43:15Z</updated>
$ curl -s "https://github.com/measuredco/puck/commits/main.atom" → NO FEED (old org dead; raw files still 200 via redirect)
```

---

## 3. VvvebJs (npm: `vvvebjs` — package EXISTS)

**Version:** `2.0.9`, published **2026-06-30T13:21:20.645Z**
**Repository:** `git+https://github.com/givanz/VvvebJs.git` → https://github.com/givanz/VvvebJs
**License:** **Apache-2.0** — verified in npm metadata AND the repo LICENSE file (master branch): full **Apache License Version 2.0** text.
**Deprecation:** none. **Maintenance:** repo master last commit **2026-07-01T16:32:11Z** (Atom) → quiet ~5 months as of research date; npm modified 2026-06-30. No archived banner.
**Publish history note:** npm shows `0.0.1` (2018-01-27) then a jump straight to `2.0.7` (2026-06-28), `2.0.8` (2026-06-28), `2.0.9` (2026-06-30) — npm publishing started fresh in 2026 even though the project is older.

**Architecture (from README, fetched from master):**
> "Built with **Vanilla Js with no dependencies or build tools and Bootstrap 5**"

- Vanilla JS + Bootstrap 5 components/blocks; drag & drop page builder; iframe-based canvas (`editor.html` opened through a webserver due to iframe security); git clone requires `--recurse-submodules`.
- npm `dependencies`: just **`express ^4.19.2`** (1 dep — save-backend example server). devDeps: 6.
- Features: file manager, code editor (CodeMirror), image upload via example PHP script, Bootstrap 5 blocks, zip download plugin, etc. Full-featured CMS integration is the separate Vvveb CMS project.

**Assessment:** Truly dependency-free vanilla JS (permissive Apache-2.0), but integration model (PHP save scripts, iframe canvas, submodules, no npm-SDK ergonomics, activity paused mid-2026) makes it better as a reference/inspiration than as a React/Next.js embedded editor.

**Evidence commands & key output:**
```
$ npm view vvvebjs version → 2.0.9
$ npm search vvveb --json → [{"name":"vvvebjs", ... "license":"Apache-2.0", "date":"2026-06-30T13:21:20.645Z",
  "repository":"git+https://github.com/givanz/VvvebJs.git", "publisher":"givanz"}]
$ curl -s https://registry.npmjs.org/vvvebjs | python3 → latest 2.0.9 ; license Apache-2.0 ;
  deps {"express":"^4.19.2"} ; published 2026-06-30T13:21:20.645Z
$ curl -s https://raw.githubusercontent.com/givanz/VvvebJs/master/LICENSE → "Apache License / Version 2.0, January 2004"
$ curl -s https://raw.githubusercontent.com/givanz/VvvebJs/master/README.md →
  "Built with Vanilla Js with no dependencies or build tools and Bootstrap 5"
$ curl -s "https://github.com/givanz/VvvebJs/commits/master.atom" → <updated>2026-07-01T16:32:11Z</updated>
```

---

## 4. Craft.js (npm: `@craftjs/core`)

**Version:** `0.2.12`, published **2025-02-14T09:25:26.719Z**
**Repository:** `git+https://github.com/prevwong/craft.js.git` → https://github.com/prevwong/craft.js
**License:** **MIT** — npm metadata + LICENSE (main branch): `MIT License / Copyright (c) 2020 Previnash Wong Sze Chuan`
**Deprecation:** none.
**Maintenance status: STALE.** Last npm publish 2025-02-14 (~21 months before research date). Repo default branch `main` last commit **2025-02-14T09:22:26Z** (Atom) — matches the last release almost exactly; `master` branch dead since 2021-11-15. No archived banner, but effectively dormant.
**Dependency footprint:** **4 top-level deps** — `lodash ^4.17.21`, `debounce ^1.2.0`, `@craftjs/utils ^0.2.5`, `tiny-invariant ^1.0.6`. Peer: `react: '^16.8.0 || ^17 || ^18 || ^19'` (broadest React support of the candidates).

**Assessment:** Lean, permissive, widest React range — but ~21 months without a release or commit. Usable (MIT, small surface), yet plan for forking/patching; do not expect upstream fixes. (GitHub REST API `pushed_at` unavailable due to rate limit; Atom feed used instead.)

**Evidence commands & key output:**
```
$ npm view @craftjs/core version license repository.url
version = '0.2.12'  license = 'MIT'  repository.url = 'git+https://github.com/prevwong/craft.js.git'
$ npm view @craftjs/core deprecated   # (empty)
$ npm view @craftjs/core time --json → "0.2.12": "2025-02-14T09:25:26.719Z" (last entry)
$ curl -s https://registry.npmjs.org/@craftjs%2fcore/latest | python3 → dep_count: 4 ; peerDeps react ^16.8||^17||^18||^19
$ curl -s https://raw.githubusercontent.com/prevwong/craft.js/main/LICENSE
  MIT License / Copyright (c) 2020 Previnash Wong Sze Chuan
$ curl -s "https://github.com/prevwong/craft.js/commits/main.atom" → <updated>2025-02-14T09:22:26Z</updated>
$ curl -s "https://github.com/prevwong/craft.js/commits/master.atom" → <updated>2021-11-15T11:08:51Z</updated>
```

---

## 5. Webstudio (npm: `@webstudio-is/sdk` + `webstudio` CLI)

**Core license — CONFIRMED AGPL-3.0-or-later:**
- `@webstudio-is/sdk` latest `0.314.0`, published **2026-11-17T23:51:36.020Z**, license **`AGPL-3.0-or-later`** (registry metadata). npm `repository` field is null on this sub-package; homepage `https://webstudio.is`; monorepo = https://github.com/webstudio-is/webstudio.
- Repo LICENSE (main branch, HTTP 200): full **GNU AFFERO GENERAL PUBLIC LICENSE Version 3, 19 November 2007** text.
- The `webstudio` CLI package is also `0.314.0`, `AGPL-3.0-or-later`.

**Proprietary/commercial exception — CONFIRMED:** `@webstudio-is/sdk-components-animation` `0.314.0` (published 2026-11-17) carries license **`LicenseRef-Webstudio,Inc-Proprietary`** (registry metadata). Its LICENSE file in the monorepo (`packages/sdk-components-animation/LICENSE`, HTTP 200) reads:
> "**Webstudio, Inc. End User License Agreement (EULA)** — Last updated: August 3, 2025"

So: **the animation SDK package is proprietary/commercial, NOT AGPL.** It depends on AGPL packages (`@webstudio-is/sdk 0.314.0`, `@webstudio-is/react-sdk 0.314.0`, `@webstudio-is/sdk-components-react 0.314.0`, etc.).
All other `@webstudio-is/*` packages checked via registry search are `AGPL-3.0-or-later` (protocol, wsauth, http-client, css-engine, react-sdk, sdk-components-react, sdk-components-react-radix, sdk-components-react-remix, sdk-components-registry, sdk-components-react-router, postgrest, expression, fonts, icons, image, plans, content-engine, query-builder, css-data, asset-uploader, project-migrations, trpc-interface, authorization-token, multiplayer-protocol, domain, error-utils, css-vars, project, project-build, prisma-client, dashboard, cli, form-handlers, sync-client). One legacy exception: `@webstudio-is/design-tokens 0.22.0` is MIT (old package).

**Dependency footprint (`@webstudio-is/sdk`):** **19 top-level deps** (zod, tldts, nanoid, undici, ipaddr.js, type-fest, warn-once, change-case, @emotion/hash, email-addresses, json-schema-typed, reserved-identifiers + 6 in-house `@webstudio-is/*` packages). No React peer dep on the SDK itself (framework-agnostic core; rendering packages are separate).

**Maintenance:** ACTIVE — `webstudio-is/webstudio` main last commit **2026-11-21T17:44:40Z** (Atom); npm publish cadence same week. Not deprecated, no archived banner.

**Assessment:** Actively developed and full-featured, but **AGPL-3.0-or-later is copyleft** — embedding/linking it in BeanFolio's multi-tenant service has strong viral implications, and the animation components are outright proprietary EULA. Treated as a reference/screenshot-benchmark, not a vendored dependency, unless legal accepts AGPL.

**Evidence commands & key output:**
```
$ npm view @webstudio-is/sdk version license
version = '0.314.0'  license = 'AGPL-3.0-or-later'
$ npm view @webstudio-is/sdk deprecated   # (empty)
$ curl -s https://registry.npmjs.org/@webstudio-is%2fsdk | python3 → latest 0.314.0 ;
  published 2026-11-17T23:51:36.020Z ; deps 19 ; repository: null ; homepage https://webstudio.is
$ curl -s https://raw.githubusercontent.com/webstudio-is/webstudio/main/LICENSE
  "GNU AFFERO GENERAL PUBLIC LICENSE / Version 3, 19 November 2007"
$ curl -s "https://registry.npmjs.org/-/v1/search?text=@webstudio-is&size=40" →
  @webstudio-is/sdk-components-animation 0.314.0 LicenseRef-Webstudio,Inc-Proprietary
  (all other @webstudio-is/* → AGPL-3.0-or-later; @webstudio-is/design-tokens 0.22.0 MIT)
$ curl -s https://registry.npmjs.org/@webstudio-is%2fsdk-components-animation | python3 →
  license LicenseRef-Webstudio,Inc-Proprietary ; published 2026-11-17T23:52:48.371Z
$ curl -s https://raw.githubusercontent.com/webstudio-is/webstudio/main/packages/sdk-components-animation/LICENSE (HTTP 200)
  "Webstudio, Inc. End User License Agreement (EULA) / Last updated: August 3, 2025"
$ curl -s "https://github.com/webstudio-is/webstudio/commits/main.atom" → <updated>2026-11-21T17:44:40Z</updated>
```

---

## 6. Vercel Platforms (github.com/vercel/platforms)

**LICENSE — CONFIRMED ABSENT:** `https://raw.githubusercontent.com/vercel/platforms/main/LICENSE` → **HTTP 404** (fetched, body "404: Not Found"). Also 404: `LICENSE.md`, `LICENSE.txt`, `COPYING`, `LICENSE-MIT.txt`. Repo `package.json` has **no `license` field** and declares `"private": true`.
**README terms:** The README (fetched from main) describes it purely as *"Next.js Multi-Tenant Example — A production-ready example of a multi-tenant application built with Next.js 16"* with deploy-to-Vercel instructions; **grep found no license/grant/forking terms anywhere in the README** — no stated usage terms at all.
**Implication:** no open-source license = default "all rights reserved" under copyright law. Reading the code for ideas is what it's clearly meant for (public example), but copying code wholesale into BeanFolio is legally unprotected. Treat as inspiration/reference only.
**Maintenance:** main branch last commit 2026-07-08T20:18:49Z (Atom); not archived (no archived banner; page HTTP 200).

**Evidence commands & key output:**
```
$ curl -s -o /dev/null -w "%{http_code}" https://raw.githubusercontent.com/vercel/platforms/main/LICENSE → 404
$ curl -s https://raw.githubusercontent.com/vercel/platforms/main/README.md | head -60
  "# Next.js Multi-Tenant Example ... A production-ready example of a multi-tenant application built with Next.js 16"
$ curl -s https://raw.githubusercontent.com/vercel/platforms/main/package.json | python3
  name: None ; license field: None ; private: True
$ curl -s "https://github.com/vercel/platforms/commits/main.atom" → <updated>2026-07-08T20:18:49Z</updated>
```

---

## Comparison Table (all values verified live 2026-11-24 UTC)

| Project | npm package | Latest ver | Publish date | License (SPDX, verified) | Repo | Deps (top-level) | React peer | Maintenance (last commit / last publish) | Key risk |
|---|---|---|---|---|---|---|---|---|---|
| **GrapesJS** | `grapesjs` | 0.23.9 | 2026-11-03 | **BSD-3-Clause** (LICENSE: Artur Arseniev) | GrapesJS/grapesjs | 5 (backbone, codemirror, underscore…) | n/a (vanilla JS) | 2026-11-13 (dev) / 2026-11-03 — ACTIVE | None for core; Studio SDK (@grapesjs/studio-sdk 1.2.1) is a **separate commercial EULA** product that *depends on* core (never reverse) |
| **Puck** | `@puckeditor/core` (was `@measured/puck`) | 0.24.2 | 2026-11-23 | **MIT** (Puck Contributors) | puckeditor/puck | **37** (tiptap ×18, dnd-kit ×6…) | ^18 \|\| ^19 | 2026-11-23 / 2026-11-23 — VERY ACTIVE | Old package **deprecated**; `@puckeditor/cli: latest` pin; large dep surface |
| **VvvebJs** | `vvvebjs` | 2.0.9 | 2026-06-30 | **Apache-2.0** | givanz/VvvebJs | 1 (express) | n/a (vanilla JS + Bootstrap 5) | 2026-07-01 / 2026-06-30 — quiet ~5 mo | PHP-era integration, iframe canvas, submodules; npm history restarted 2026 |
| **Craft.js** | `@craftjs/core` | 0.2.12 | 2025-02-14 | **MIT** (Previnash Wong) | prevwong/craft.js | 4 (lodash, debounce…) | ^16.8 \|\| ^17 \|\| ^18 \|\| ^19 | **2025-02-14 / 2025-02-14 — STALE ~21 mo** | Dormant upstream; plan to fork/patch |
| **Webstudio** | `@webstudio-is/sdk` | 0.314.0 | 2026-11-17 | **AGPL-3.0-or-later** core; **`LicenseRef-Webstudio,Inc-Proprietary`** for `@webstudio-is/sdk-components-animation` (EULA) | webstudio-is/webstudio | 19 | n/a (framework-agnostic core) | 2026-11-21 / 2026-11-17 — ACTIVE | Copyleft (AGPL) + one proprietary animation package |
| **Vercel Platforms** | (no npm pkg) | n/a | n/a | **NONE** — no LICENSE file (404), no license field, `private: true` | vercel/platforms | n/a | n/a | 2026-07-08 last commit | All-rights-reserved example; inspiration only |

## Bottom-line assessment for BeanFolio's website visual editor evaluation

1. **GrapesJS** is the safest OSS foundation: permissive BSD-3-Clause, tiny dep footprint, very active releases (3 in the last 6 weeks), and zero commercial code in the core dependency tree. The "Studio SDK" branding on grapesjs.com is a separate commercial product (`@grapesjs/studio-sdk`, Grapes Studio Inc. EULA with license keys/watermarks) — it consumes the core, not vice versa.
2. **Puck** is the most actively developed React-native option but has moved registries (`@measured/puck` deprecated → `@puckeditor/core`) and carries a heavy dependency tree plus a `latest`-pinned CLI dep.
3. **Craft.js** is permissive and lean but effectively unmaintained (~21 months).
4. **VvvebJs** is permissive (Apache-2.0) and dependency-light but architecturally foreign to a React/Next.js stack (vanilla JS iframe + PHP save scripts) and has been quiet since 2026-06-30.
5. **Webstudio** must stay out of the dependency graph: AGPL core + one proprietary-EULA animation package (`@webstudio-is/sdk-components-animation`).
6. **Vercel Platforms** has no license at all — benchmark/inspiration only, no code copying.
