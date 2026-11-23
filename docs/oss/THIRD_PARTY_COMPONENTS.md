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

---

## Register maintenance

Every future third-party addition MUST append an entry here BEFORE the
dependency is used in product code, with the pinned version/commit, the
in-package license verification, the exact files/packages reused and every
BEAN modification.
