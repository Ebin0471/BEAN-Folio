# BEAN Folio — Third-Party Components (Open-Source Provenance Register)

**Purpose (owner directive §7):** record upstream URL, version/commit, license,
files/packages reused and all BEAN modifications for every third-party
component adopted into the repository. No logos, trademarks, commercial
hosted services or proprietary enterprise features are copied. Components
whose commercial redistribution rights are unclear are not used.

**Rule of record:** required copyright + license notices are preserved in the
pinned package (`LICENSE` inside `node_modules/@langchain/langgraph/`, carried
by the lockfile). BEAN Folio itself deliberately has **no root LICENSE file**
(owner decision pending — public visibility does NOT grant third-party rights
to reuse BEAN's source).

---

## Adopted (dependency in use)

### grapesjs 0.23.9 — BSD-3-Clause — GIFTZ visual editor core (production dependency, client-side only)

| Field | Value |
| --- | --- |
| Upstream | https://github.com/GrapesJS/grapesjs |
| Pinned version | `0.23.9` EXACT pin (published 2026-11-03; no `^` range so license audits bind to one tree) |
| License (verified in-package at pinned version) | BSD-3-Clause — `node_modules/grapesjs/LICENSE` (`Copyright (c) 2017-current, Artur Arseniev`); npm metadata matches |
| Packages/files reused | The published npm package only. No upstream source vendored into `src/`; no fork; no patch; `node_modules` never modified. |
| Where used | GIFTZ visual editor (`src/lib/giftz/visual-editor/*`, mounted client-side in a `WebsiteBuilderView` canvas tab via dynamic import). NOT server-side; not executed for anonymous visitors. |
| BEAN modifications | None to the upstream package. All customization is original BEAN adapter code (`grapesjs-config.ts`, import/export adapter, BEAN blocks/presets); upstream's own presets (`gjs-preset-webpage`) and plugins are NOT installed (zero plugins → no unaudited third-party plugin licenses). |
| Commercial separation | `@grapesjs/studio-sdk` (Grapes Studio Inc. EULA — license keys/watermarks) is a SEPARATE commercial package that depends on the core; it is NOT installed and must never enter the dependency tree (see `docs/oss/website-editor-evaluation.md` §4 rules). |
| License obligations | BSD-3-Clause notices preserved in the pinned package's LICENSE (carried by the lockfile); product-facing attribution recorded in `docs/oss/website-editor-evaluation.md` §2. No upstream trademarks used as BEAN branding. |
| Full evaluation | `docs/oss/website-editor-evaluation.md` (candidates, licenses, rejection reasons, maintenance rules) |

### @langchain/langgraph 0.4.10 — MIT — PoC ONLY (devDependency)

| Field | Value |
| --- | --- |
| Upstream | https://github.com/langchain-ai/langgraphjs |
| Pinned version | `0.4.10` (package.json devDependencies: `"^0.4"`, lockfile-pinned to 0.4.10) |
| License (verified in-package at pinned commit) | MIT — `node_modules/@langchain/langgraph/LICENSE` |
| Packages/files reused | The published npm package only (`dist/`, shipped `LICENSE`/README). No upstream source files copied into `src/`. |
| Where used | `scripts/poc/langgraph/poc.ts` (proof of concept around the real discover→draft workflow, running the REAL registered RIISHE tools against the isolated QA database) |
| BEAN modifications | None to the upstream package. BEAN's PoC file (`scripts/poc/langgraph/poc.ts`) is original code that imports the library. |
| Production impact | NONE — devDependency; not imported by `src/`; not part of the build artifact; the production workflow engine remains `src/lib/riishe/workflow-engine.ts` (adoption decision: `docs/oss/LANGGRAPH_POC_DECISION.md`) |
| Transitive deps | `@langchain/core` and supporting packages pulled by the lockfile — all MIT per their package manifests at the pinned resolution. |
| Enterprise-notice check | No `ee/` folder, no enterprise-only carve-outs in the published package manifest. |

---

## Evaluated — NOT adopted (no dependency added)

### Browser Use — https://github.com/browser-use/browser-use — MIT — DEFERRED

- Verified upstream license declaration: MIT (Python project).
- **Why evaluated:** candidate for isolated browser execution (owner directive §7).
- **Why not adopted in this milestone:** it is a Python runtime — integrating it
  would add a second language runtime to a single-service TypeScript
  deployment (the same second-runtime cost the RIISHE blueprint §15.4
  explicitly rejects for Agno/PydanticAI). Any adoption must be an OPTIONAL,
  self-hosted worker with: per-user + per-task browser-session isolation, no
  shared cookies/credentials between sessions, no mandatory paid cloud, and
  scoped permissions granted only through explicit authorized integrations.
- **Unlock conditions (owner decision):** a real product need for external-site
  automation that cannot be met by authorized integrations, PLUS an owner
  decision to run an isolated Python worker service.
- Assessment detail: `docs/oss/AGENT_FRAMEWORK_ASSESSMENTS.md`.

### OpenHands Software Agent SDK — https://github.com/OpenHands/software-agent-sdk — MIT — DEFERRED

- Verified upstream license declaration: MIT.
- **Why evaluated:** engineering-work agent candidate for CODE GIFTZ's
  existing sandbox (owner directive §7).
- **Why not adopted in this milestone:** CODE GIFTZ already has a working,
  tested sandbox + approval pipeline (filegen budget, nav checks, shape
  healing, deterministic build verification — GZ-1..GZ-4 evidence in-repo).
  Swapping the execution substrate would disrupt a verified pipeline for no
  measured benefit in this milestone. Evaluation-only, zero product imports.
- **Unlock conditions (owner decision):** a measured gap in the existing GIFTZ
  sandbox (e.g. a capability the pipeline cannot express) demonstrated with a
  benchmark before any adoption.
- Assessment detail: `docs/oss/AGENT_FRAMEWORK_ASSESSMENTS.md`.

### onnxruntime-node 1.31.1 — https://github.com/microsoft/onnxruntime — MIT — ADOPTED (M33.4-C, LAXII identity pipeline)

- Verified: in-package LICENSE file (MIT) at the pinned version; runtime is
  Microsoft's official ONNX Runtime Node binding (npm `onnxruntime-node`).
- **Used by:** `src/lib/laxii/segmentation.ts` — local CPU execution of the
  pinned MODNet ONNX portrait-matting model (identity-lock avatar pipeline).
  No model downloads at generation time; weights are tracked in-repo and
  sha256-pinned (see next entry).
- Scope: server-side inference only. No telemetry, no network calls from the
  runtime during inference.

### MODNet portrait-matting weights (`Xenova/modnet`, ONNX port) — Apache-2.0 — ADOPTED (M33.4-C)

- Provenance verified 2026-11-25:
  - HF model card `https://huggingface.co/Xenova/modnet` declares
    `license: apache-2.0`; repo commit
    `fa2fa546052fba4c08921230a26cc69a333fca12` (lastModified 2025-10-26).
  - Local tracked file `data/laxii-models/Xenova/modnet/onnx/model.onnx`
    sha256 `07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9`
    equals the Hub LFS oid for `onnx/model.onnx` at that commit.
  - Upstream model: `https://github.com/ZHKKKe/MODNet` (LICENSE: Apache-2.0,
    including the released pretrained weights) — a commercial-use-permitted
    checkpoint, UNLIKE the research-only InsightFace/InstantID families the
    guide prohibits.
- **Used by:** `src/lib/laxii/segmentation.ts` (portrait matting for the
  identity-lock pipeline: subject mask, plate person-gate). CPU inference
  only. NO ComfyUI/GPL code is involved anywhere in this path.
- Runtime dependency: onnxruntime-node (entry above, MIT).

---

## Register maintenance

Every future third-party addition MUST append an entry here BEFORE the
dependency is used in product code, with the pinned version/commit, the
in-package license verification, the exact files/packages reused and every
BEAN modification.
