# BEAN Folio — Universal Creative Studio Capability Matrix (GIFTZ · LAXII · RIISHE)

**Status label legend** (used for every row):

| Label | Meaning |
| --- | --- |
| **Existing** | Implemented and verified in source on this baseline; evidence path cited. |
| **Partial** | Implemented with documented limits that a reader must not mistake for full capability. |
| **Removed** | Existed historically; no longer in the code. UI/docs that still mention it are stale. |
| **Owner-setup-required** | Code path exists, but live use needs an outside resource (DNS/TLS, credentials, provider account, owner decision). |
| **Backend-required** | The requested experience needs a server capability that does not exist for generated sites; must be planned, never faked. |
| **Unsupported** | Not implemented; the product says so plainly (see `UNSUPPORTED_CAPABILITIES` and route honesty guards). |

**Method.** Every count below was derived by importing the live registry on the
baseline tree and counting entries programmatically (pinned by
`tests/universal-studio-capability-matrix.test.ts`, which fails if the doc and
the registries drift apart). Route counts are derived by counting `route.ts`
files under each API namespace. Qualitative claims cite the governing file.
Baseline: `main` at `74123a5` (PR #7 merge, 2026-11-24). North star:
`docs/GIFTZ_UNIVERSAL_CREATIVE_STUDIO_GUIDE.md`.

> This document is the source-backed capability and gap report for M33. It is
> deliberately honest: nothing here may be read as claiming a capability that
> the cited source does not implement.

---

## 1. GIFTZ — website engineering studio

### 1.1 Verified registry sizes (live imports, baseline `74123a5`)

| Registry | Count | Source of truth |
| --- | --- | --- |
| Site font families (`SITE_FONTS`) | 129 | `src/lib/site-fonts.ts` |
| Section types (`SECTION_TYPES`) | 17 | `src/lib/site-config.ts` |
| Curated color palettes (`PALETTES`) | 38 | `src/lib/site-palettes.ts` |
| CSS motion preset ids (`MOTION_PRESET_IDS`, incl. `bg-none`) | 108 | `src/lib/site-motion.ts` |
| Design languages (`DESIGN_LANGUAGES`) | 8 | `src/lib/ai-design/design-languages.ts` |
| Profession playbooks (family-resolved) | 13 | `src/lib/professions/playbooks.ts` |
| Component registry entries (`COMPONENT_REGISTRY`) | 37 | `src/lib/giftz/component-intelligence.ts` |
| GSAP motion presets (`GSAP_MOTION_PRESETS`) | 39 | `src/lib/giftz/motion-engine.ts` |
| Vanta background effects (`VANTA_EFFECTS`) | 13 | `src/lib/giftz/motion-engine.ts` |
| Config-mode step tools (`STEP_TOOLS`) | 15 | `src/lib/ai-design/tools.ts` |
| GIFTZ API route files under `src/app/api/giftz/` | 42 | route-tree count (39 at baseline `74123a5` + 3 added in M33: `src/app/api/giftz/brand-kit/route.ts`, `src/app/api/giftz/planner/route.ts`, `src/app/api/giftz/quality-gate/route.ts`) |

### 1.2 Capability table

| Capability | Status | Evidence | Notes |
| --- | --- | --- | --- |
| AI design/config generation (plan → validate → execute → verify) | Existing | `src/lib/ai-design/plan-core.ts` | Bounded self-repair (`PLAN_MAX_ATTEMPTS=2`), digest grounding, durable jobs. |
| Deterministic design-language registry with module-scope validation | Existing | `src/lib/ai-design/design-languages.ts` | 8 languages validated against font/palette/motion libraries at import. |
| Profession-aware generation + anti-fabrication guidance | Existing | `src/lib/professions/playbooks.ts`, `docs/PROFESSION_AWARE_GENERATION.md` | 13 family playbooks; templateIds resolved at call time. |
| Structured `SiteConfig` schema (17 section types, 38 palettes, motion presets) | Existing | `src/lib/site-config.ts` | `normalizeConfig()` heals shapes then strict-parses; unknown presets dropped, never executed. |
| Deterministic static exporter (multi-page ZIP, relative assets) | Existing | `src/lib/site-export.ts` | Manifest honestly declares non-reproducible features (inquiries→mailto, RIISHE, live data). |
| Project-file mode (plan → sandboxed files → build → proposal → approval) | Existing | `src/lib/giftz/project-agent.ts`, `src/lib/giftz/plan.ts` | Plans 1–12 files, workspace-relative paths, bounded repair; approval gate before writes. |
| File-store limits (DB project files) | Existing | `src/lib/giftz/project-files.ts` | max 300 files / 30 MB total / 256 KB text / 4 MB binary. |
| Git-backed workspaces + safe command execution | Existing | `src/lib/giftz/workspace.ts`, `src/lib/giftz/commands.ts` | 2000 files / 32 MB; command allowlist `{bun, bunx, node}`; 120 s timeout; output cap 64 KB. |
| Real build diagnostics + artifact builds | Existing | `src/lib/giftz/project-build.ts` | Entry check, local link/asset resolution, multi-page nav diagnostics, JSON balance heuristic — a lint-grade check, **not** a JS/TS compiler. |
| Sandboxed preview with restrictive CSP | Existing | `src/lib/giftz/preview-serve.ts` | `PREVIEW_CSP` includes `connect-src 'none'`; applied to owner preview and public serving. |
| Publish / unpublish / rollback with exactly-one-LIVE deployments | Existing | `src/lib/giftz/project-deploy.ts` | External deployment adapters honestly `not-configured` (`deploymentAdapterStatus`). |
| Version snapshots (20 kept) + diff/restore | Existing | `src/lib/giftz/project-versions.ts` | Sources `ai|user|publish|restore|auto`. |
| Custom domains: registry + real DNS verification | Partial | `src/lib/giftz/project-domains.ts` | Serving is **not** implemented (`DOMAIN_ROUTING_NOTE`); verification ≠ traffic routing. |
| Visual editor (GrapesJS) with eligibility + reconciliation-guarded saves | Existing | `src/lib/giftz/visual-editor/round-trip.ts`, `src/lib/giftz/visual-editor/grapesjs-config.ts` | Exact pin `grapesjs@0.23.9` (BSD-3-Clause, `docs/oss/THIRD_PARTY_COMPONENTS.md`); pages with external/multiple stylesheets refuse editing. |
| Tenant host routing (`username.beanfolio.app`) | Existing (local/serving path) | `src/proxy.ts`, `src/lib/tenant-host.ts` | Public use of `*.beanfolio.app` additionally requires owner DNS/wildcard TLS/ingress — Owner-setup-required beyond the code. |
| Public site serving with privacy ladder | Existing | `src/app/api/giftz/sites/[id]/public/[...path]/route.ts` | Owner ACTIVE + `PUBLISHED` + profile visibility ladder + LIVE deployment required. |
| Server backend for generated sites (auth, DB, payments, inventory) | Unsupported | `src/lib/ai-design/tools.ts` (`UNSUPPORTED_CAPABILITIES`) | Static-site agent stays static; never loosen CSP to fake it. |
| Full-stack application runtime (M34) | Unsupported | Guide §5 | Separate isolated runtime must be designed and reviewed first. |

### 1.3 GIFTZ gaps (priority register)

| Gap | Priority | Notes |
| --- | --- | --- |
| Brand attributes → validated font pairings + shared brand kit | M33.1 | Implemented in this milestone (`src/lib/brand-kit.ts`); see §4 tests. |
| Universal website-family planner + capability router (no dead buttons) | M33.2 | Implemented in this milestone (`src/lib/giftz/site-taxonomy.ts`, `src/lib/giftz/site-planner.ts`). |
| Consolidated quality gate (a11y/SEO/links/responsive/perf report) | Existing | `src/lib/giftz/quality-gate.ts`, `src/app/api/giftz/quality-gate/route.ts` | M33.3: deterministic STATIC report (15 checks) over a site's compiled project file tree with page-attributed evidence; every report ships an explicit `untested` list — static analysis never claims runtime proof; live-render complement remains `src/lib/ai-design/browser-checks.ts`. |
| Versioned banner/canvas presets beyond the canonical one (LAXII side) | M33.4 | See §2. |
| Custom-domain serving (after DNS/TLS/ingress) | Owner gate | Registry + DNS verify only. |

---

## 2. LAXII — visual and professional-document production engine

### 2.1 Verified registry sizes (live imports, baseline `74123a5`)

| Registry | Count | Source of truth |
| --- | --- | --- |
| Banner canvas presets (`BANNER_PRESETS`) | 1 (canonical 2048×687) | `src/lib/laxii/banner-presets.ts` |
| Avatar style presets (`AVATAR_PRESETS`) | 10 | `src/lib/laxii/avatar-presets.ts` |
| Style-registry presets (`STYLE_PRESETS`) | 15 | `src/lib/laxii/styles.ts` |
| Resume formats (`RESUME_TYPES`) | 17 | `src/lib/laxii/resume-schema.ts` |
| Resume profession families (`RESUME_PROFESSION_FAMILIES`) | 26 | `src/lib/laxii/resume-professions.ts` |
| LAXII API route files under `src/app/api/laxii/` | 21 | route-tree count |

### 2.2 Capability table

| Capability | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Image generation via managed gateway (the only user-selectable provider) | Existing | `src/app/api/laxii/generate/route.ts` (schema pins `provider: z.literal("managed")`), `src/lib/laxii/router.ts` | `resolveProvider()` refuses any non-managed pin and never silently reroutes; Gemini/OpenAI/Diffusers adapters exist as internal plumbing, not user options. |
| Banner pipeline with deterministic typography | Existing | `src/lib/laxii/banner-pipeline.ts`, `src/lib/laxii/typography.ts` | Exact-canvas output, measured ink (`verifyInkApplied`), WCAG text color choice, bounded refinement (≤3), quality eval. |
| Exact-canvas banner export (PNG/JPEG/WebP) | Existing | `src/app/api/laxii/banner/export/route.ts` | Decode-verified dimensions. |
| Preserve-pixel / identity-locked avatar compositing | **Removed** | `tests/laxii-backdrop.test.ts.disabled` records the removed engine; no segmentation/compositing code exists under `src/` | The MODNet weights on disk are referenced by **zero** code. Any UI/doc claiming "Preserved-pixel portrait" is stale. Identity note is honest: `AVATAR_IDENTITY_NOTE` in `src/lib/laxii/avatar-presets.ts`. |
| AI-styled portrait presets (likeness best-effort, clearly labelled) | Existing | `src/lib/laxii/avatar-presets.ts` | Prompt-level styling only; review-before-use warning shipped. |
| Subject isolation → transparent cutout | Partial | `src/lib/laxii/image-ops.ts` (`extractTransparency`) | Generative isolation prompt + border flood-fill alpha extraction with 8–95% subject-coverage sanity — **not** segmentation. |
| Resume generation with anti-fabrication guard | Existing | `src/lib/laxii/resume-service.ts` (`findInventedEntities`, `filterInventedSkills`) | One corrective retry, then honest failure; custom sections merged verbatim from user facts; `aiTouched` provenance. |
| Resume PDF export (selectable text) | Existing | `src/lib/laxii/resume-export.ts` (`renderResumePdf`) | pdfkit, standard-14 fonts, 4 themes. |
| Resume DOCX export | Existing | `src/lib/laxii/resume-export.ts` (`renderResumeDocx`) | docx library. |
| Resume upload parsing (PDF/DOCX/TXT → facts) | Existing | `src/app/api/laxii/resume/parse/route.ts` | pdf-parse / mammoth; text stored nowhere as claims. |
| ATS scoring / ATS-pass guarantees | Unsupported | `src/app/api/laxii/resume/export/route.ts` ("No ATS pass is ever guaranteed or claimed") | Only an ATS-safe single-column format exists. |
| Cover letters | Unsupported | repo-wide search: zero matches | New capability; must be built and tested before any UI claims it. |
| EXIF/metadata stripping on uploads/outputs | Unsupported | `docs/known-limitations.md` | Documented limitation. |
| Worker queue with lease/heartbeat for generation | Partial | `src/lib/laxii/jobs.ts` | Durable DB claim + status-guarded terminal writes + 30-min stale sweep, in-process; no cross-replica lease machinery. |
| Diffusers self-hosted worker | Owner-setup-required | `src/lib/laxii/providers/diffusers.ts` | Requires `LAXII_DIFFUSERS_URL`; never user-selectable in V1. |

### 2.3 LAXII gaps (priority register)

| Gap | Priority | Notes |
| --- | --- | --- |
| Versioned banner canvas preset registry (hero/campaign/square/story + bounds) preserving canonical 2048×687 | M33.4 | Registry currently 1 preset. |
| Numeric regression tests proving protected-region pixels unchanged (future preserve-pixel path) | M33.4 | Blocked: no preserve-pixel engine exists; rebuild requires design + owner approval. |
| Deterministic typography with user-selected approved font families + glyph coverage checks | M33.4 | `src/lib/laxii/typography.ts` currently uses built-in fonts; SITE_FONTS integration pending. |
| Cover-letter drafting grounded in the same facts (only after tests) | M33.5 | Zero code today. |
| ATS-oriented parsing checks + job-keyword gap reporting | M33.5 | Honest gap reporting only; never an ATS score. |
| Resume renderer + anti-fabrication unit tests | M33.5 | Currently no test imports `renderResumePdf`/`renderResumeDocx` or the guard functions. |

---

## 3. RIISHE — conversational agent and governed orchestration

### 3.1 Verified registry sizes (live imports, baseline `74123a5`)

| Registry | Count | Source of truth |
| --- | --- | --- |
| Registered tools (`RIISHE_TOOLS`, incl. 9 specialist tools) | 23 | `src/lib/riishe/tools.ts`, `src/lib/riishe/specialist-tools.ts` |
| Specialists (`SPECIALISTS`) | 9 | `src/lib/riishe/specialists.ts` |
| Response modes (`RIISHE_MODES`) | 8 | `src/lib/riishe/modes.ts` |
| Automation intent kinds (`RiisheIntentKind`) | 11 | `src/lib/riishe/intents.ts` |
| RIISHE API route files under `src/app/api/riishe/` | 13 | route-tree count |

### 3.2 Capability table

| Capability | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Typed tool registry with strict zod input schemas | Existing | `src/lib/riishe/tool-contracts.ts`, `src/lib/riishe/tools.ts` | Risk (`LOW|MEDIUM|HIGH|DESTRUCTIVE`), automation level, approval rule `toolApprovalRequired()`. |
| Execution-time ownership/workspace re-verification | Existing | `src/lib/riishe/specialist-tools.ts` (`authorizeOrgContext`, per-candidate consent re-read) | Org membership/role re-checked server-side; consent ledger authoritative. |
| Durable workflow engine (steps, retries, pause/resume/cancel, recovery sweep) | Existing | `src/lib/riishe/workflow-engine.ts` | `RiisheWorkflow`/`RiisheWorkflowStep` + `BackgroundJob` queue; verify phase re-reads outputs before success. |
| Approval ladder (publish/send gated; DESTRUCTIVE requires typed confirm → HTTP 428) | Existing | `src/app/api/riishe/steps/[id]/route.ts`, `src/lib/riishe/tool-contracts.ts` | HIGH tools execute in-session after approval, never via queue. |
| Automation policy (daily cap, level-2 pre-auth preferences, safe degradation) | Existing | `src/lib/riishe/automation-policy.ts` | Corrupted preferences degrade to safe defaults. |
| Append-only audit events | Existing | `src/lib/riishe/audit.ts` | Never throws; every tool declares `auditAction`. |
| Specialist routing (deterministic keyword classifier + LLM planner attribution) | Existing | `src/lib/riishe/specialists.ts`, `src/app/api/ai/chat/route.ts` | Conservative: ambiguous goals fall through to advisory chat. |
| GIFTZ/LAXII delegation via durable briefs | Existing (brief handoff, **not** tool execution) | `src/lib/intelligence/delegation.ts`, `src/app/api/laxii/brief/route.ts` | One hop: `AgentTask` AWAITING_APPROVAL; user executes follow-through. |
| Registered `giftz.*` tools in `RIISHE_TOOLS` | Unsupported (today) | live registry: zero keys starting `giftz.` | Planned as M35 via the existing registry — not permission to fake. |
| Registered `laxii.*` tools in `RIISHE_TOOLS` | Unsupported (today) | live registry: zero keys starting `laxii.` | Same as above. |
| Payment / spend tools | Unsupported by design | `src/lib/riishe/tool-contracts.ts` header | "RIISHE has NO tools for spending money" — permanent. |
| Streaming chat (SSE) | Partial | `src/app/api/ai/chat-stream/route.ts` | Route exists and is tested; the live surface (`IntelligenceView`) uses the non-streaming `/api/ai/chat`; the streaming UI component is currently orphaned. |

### 3.3 RIISHE gaps (priority register)

| Gap | Priority | Notes |
| --- | --- | --- |
| `giftz.brief.create` / `giftz.site.plan` / `giftz.project.build` style registered tools | M35 | Must reuse `defineTool` + registry contracts; approval gates re-checked at execution. |
| `laxii.banner.produce` / `laxii.resume.*` style registered tools | M35 | Same. |
| Wire streaming UI to the live surface (or retire the orphaned component) | M35+ | Honesty: route tested, UI orphaned. |

---

## 4. Universal website-family coverage (Guide §3 mapped to real tiers)

Deterministic classification + per-feature capability routing for these
families is implemented in this milestone: `src/lib/giftz/site-taxonomy.ts`
(registry) and `src/lib/giftz/site-planner.ts` (classifier/planner/router),
exposed read-only via `src/app/api/giftz/planner/route.ts`. The registry
encodes, per family, the honest tier of every dynamic capability (Guide §3).
Summary of the tier logic:

| Tier | Meaning in BEAN today |
| --- | --- |
| Static-ready | Buildable and publishable through config mode or the file agent (17 section types / 39 GSAP presets / 12-file plans). |
| Backend-required | Needs the M34+ isolated application runtime; the planner returns an architecture request, never a fake form. |
| Owner-setup-required | Needs owner resources (domain/DNS/TLS, provider credentials, payment account). |
| Unsupported | Explicitly refused with the honest reason (e.g. patient/clinical data flows). |

Every generated or planned feature that is not static-ready is labelled in the
plan output — no dead buttons, no silent "connected" claims.

---

## 5. Licence / model / font provenance decision register

Rule of record: `docs/oss/THIRD_PARTY_COMPONENTS.md` — every third-party
addition is registered there **before** product use. Dependency licences for
shipped libraries: `docs/OPEN_SOURCE_REGISTER.md`; GIFTZ upstream review:
`docs/product/GIFTZ_OPEN_SOURCE_REGISTER.md`. Code licence ≠ weight/font
licence: each artefact class is audited separately.

| Project / artefact | Licence signal | BEAN decision (Guide §8, verified against current use) |
| --- | --- | --- |
| GrapesJS `0.23.9` | BSD-3-Clause (verified in-package) | **Keep.** Registered with exact pin + obligations. |
| `@langchain/langgraph` `0.4.10` | MIT (verified in-package) | devDependency PoC only; zero production imports. |
| Puck | MIT core | **Evaluate later** for a React app editor; never a replacement for the GrapesJS static pipeline without a measured case. |
| Reactive Resume | MIT | **Reference only** for resume UX; do not duplicate the LAXII resume service. |
| Fontsource tooling | MIT repo — **each font family carries its own terms** | Optional tooling; per-family OFL/Apache/UFL audit required before any self-hosting. |
| Medusa | MIT open-core; enterprise materials separate | **Evaluate only** for a real commerce module inside the M34 runtime boundary. |
| Motion (motiondivision) | MIT | **Do not add now**; GSAP + CSS + Framer Motion cover current needs. |
| Diffusers | Apache-2.0 | Optional isolated worker; each model card/weight licence audited individually. |
| IP-Adapter | Apache-2.0 code; weights/base-model terms separate | Candidate only after pinned weights + commercial-rights audit. |
| PuLID | Apache-2.0 code; checkpoints need separate audit | Candidate, not production-approved. |
| PhotoMaker | Apache-2.0 except listed third-party components | Candidate only; full checkpoint/dependency audit required. |
| InstantID | Apache-2.0 code; **InsightFace models/checkpoints research-only** | **Do not use in commercial production** without written licences. |
| InsightFace | MIT code; pretrained models non-commercial | Same prohibition. |
| ComfyUI | GPL-3.0 | **Do not vendor/link into BEAN**; independent sidecar needs separate review. |
| React Bits | MIT + Commons Clause (BEAN review) | **Reference-only**; never copy/bundle. |
| Google Fonts (129-family library) | Families are individually OFL/UFL/Apache — **not uniform** | Current loading = on-demand Google Fonts CDN; per-family licence audit is a hard prerequisite for any self-hosting move. |
| Removed MODNet weights on disk | Apache-2.0 (historic) | Unused by code; retained only as inert files pending owner cleanup decision — no capability claim. |

---

## 6. Documentation truth fixes applied in this milestone

1. `src/lib/ai-design/tools.ts` — the model-facing `section.add` description
   claimed "the 15 section types" while the schema has 17 (`featured`, `reel`
   were omitted). Now generated from `SECTION_TYPES` itself, so it can never
   drift again.
2. `src/lib/professions/playbooks.ts` — stale "11 valid SiteSectionTypes"
   comment corrected to reference `SECTION_TYPES`.
3. `src/lib/site-export.ts` — stale "all 11 section types" header corrected.
4. `docs/laxii/README.md` — now carries a HISTORICAL banner: it describes the
   removed preserve-pixel engine, the removed `LaxiiJob` model and a 13-preset
   banner registry that no longer exist. Current LAXII truth lives in this
   matrix + `docs/ai-transformation/04-laxii-realism-capabilities.md`.

## 7. Machine-checked honesty (this milestone's test)

`tests/universal-studio-capability-matrix.test.ts` pins this document to the
live code: every registry count in §1.1/§2.1/§3.1 must equal the imported
registry length; every `src/`/`docs/` evidence path cited above must exist;
the "Unsupported (today)" RIISHE tool-family claims are verified against the
live `RIISHE_TOOLS` keys; the GIFTZ model-facing section-type list is verified
to contain `featured` and `reel`. If the code and this document drift, the
test fails — the document may never claim a capability the registries do not
have.
