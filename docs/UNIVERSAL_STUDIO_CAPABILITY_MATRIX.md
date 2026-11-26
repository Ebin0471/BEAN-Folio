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
| Banner canvas presets (`BANNER_PRESETS`) | 11 (canonical 2048×687 first + 10 versioned site/platform/campaign canvases) | `src/lib/laxii/banner-presets.ts` |
| Avatar style presets (`AVATAR_PRESETS`) | 10 | `src/lib/laxii/avatar-presets.ts` |
| Style-registry presets (`STYLE_PRESETS`) | 15 | `src/lib/laxii/styles.ts` |
| Resume formats (`RESUME_TYPES`) | 17 | `src/lib/laxii/resume-schema.ts` |
| Resume profession families (`RESUME_PROFESSION_FAMILIES`) | 26 | `src/lib/laxii/resume-professions.ts` |
| LAXII API route files under `src/app/api/laxii/` | 28 | route-tree count (22 after M33.4 + 6 added in M33.5: resume/import, resume/analyze, resume/export/verify, resume/revisions, cover-letter, cover-letter/export) |

### 2.2 Capability table

| Capability | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Image generation via managed gateway (the only user-selectable provider) | Existing | `src/app/api/laxii/generate/route.ts` (schema pins `provider: z.literal("managed")`), `src/lib/laxii/router.ts` | `resolveProvider()` refuses any non-managed pin and never silently reroutes; Gemini/OpenAI/Diffusers adapters exist as internal plumbing, not user options. |
| Banner pipeline with deterministic typography | Existing | `src/lib/laxii/banner-pipeline.ts`, `src/lib/laxii/typography.ts`, `src/lib/laxii/font-assets.ts` | Exact-canvas output, measured ink (`verifyInkApplied`), WCAG text color choice, bounded refinement (≤3), quality eval. M33.4-B: user-selectable SITE_FONTS families via a licence-audited 9-family provisioned set (OFL files pinned by sha256 in `data/laxii-fonts/`), real weights (measured on pixels), measured glyph coverage, last-resort measured wrapping — unprovisioned families fall back with explicit warnings, never silently. |
| Exact-canvas banner export (PNG/JPEG/WebP) | Existing | `src/app/api/laxii/banner/export/route.ts` | Decode-verified dimensions. |
| Preserve-pixel / identity-locked avatar compositing | Existing (M33.4-C — NEW implementation) | `src/lib/laxii/avatar-identity.ts`, `src/lib/laxii/segmentation.ts`, `src/app/api/laxii/avatar-identity/route.ts` | The historic engine is gone; this is a NEW pipeline: local MODNet ONNX matting (Apache-2.0 weights pinned+sha256-verified, onnxruntime-node MIT, CPU), `output = original_subject × alpha + plate × (1 − alpha)` on the source's own frame (1:1, no resampling), strict mask sanity bounds (uncertain = fail-closed), plate person-gate (ported from the documented production incident), per-pixel numerical verification with SEPARATE feather-band counters before anything is exported. Results are private MediaAssets + LaxiiImageVersion rows; the profile is touched only by the user's explicit PATCH /api/me/profile. |
| AI-styled portrait presets (likeness best-effort, clearly labelled) | Existing | `src/lib/laxii/avatar-presets.ts` | Prompt-level styling only; review-before-use warning shipped. |
| Subject isolation → transparent cutout | Partial | `src/lib/laxii/image-ops.ts` (`extractTransparency`) | Generative isolation prompt + border flood-fill alpha extraction with 8–95% subject-coverage sanity — **not** segmentation. |
| Resume generation with anti-fabrication guard | Existing | `src/lib/laxii/resume-service.ts` (`findInventedEntities`, `filterInventedSkills`) | One corrective retry, then honest failure; custom sections merged verbatim from user facts; `aiTouched` provenance. |
| Resume PDF export (selectable text) | Existing | `src/lib/laxii/resume-export.ts` (`renderResumePdf`) | pdfkit, standard-14 fonts, 4 themes. |
| Resume DOCX export | Existing | `src/lib/laxii/resume-export.ts` (`renderResumeDocx`) | docx library. |
| Resume upload parsing (PDF/DOCX/TXT → facts) | Existing | `src/app/api/laxii/resume/parse/route.ts` | pdf-parse / mammoth; text stored nowhere as claims. M33.5-A: byte-signature validation (renamed/corrupt uploads rejected precisely). |
| Structured import proposal with user review gate | Existing (M33.5-A) | `src/lib/laxii/resume-import.ts`, `src/app/api/laxii/resume/import/route.ts`, `src/components/laxii/LaxiiResumeImportReview.tsx` | Deterministic extraction (no AI): schema-versioned proposal, confidence buckets with deterministic bases, bounded private snippets, explicit warnings (duplicate skills, undated/overlapping roles, column artifacts, prompt-injection-stays-content). Nothing is stored or used until the user confirms fields; undetectable structure is reported, never guessed. OCR explicitly deferred (gap report §4). |
| Deterministic Document Readability Report | Existing (M33.5-B) | `src/lib/laxii/resume-analysis.ts` (`analyzeReadability`), `src/app/api/laxii/resume/analyze/route.ts` | Versioned report (v1, evaluator `m33.5-readability-1`): stable check ids, severity, measured evidence, remediation, explicit `untested[]` list — vendor ATS behaviour is never emulated or predicted. |
| Job Requirement Evidence Map | Existing (M33.5-B) | `src/lib/laxii/resume-analysis.ts` (`mapJobRequirements`) | Deterministic JD parse (bounded source phrases) → supported/partial/missing/not_assessable verdicts, each citing resume facts; controlled alias table with word-boundary matching (Java ≠ JavaScript); negation/proficiency context ("basic exposure" = partial); transparent years-of-experience arithmetic (overlaps merged, no gap bridging); published descriptive coverage formula with no probability interpretation. |
| Export text round-trip verification | Existing (M33.5-B) | `verifyExportBytes` + `X-Bean-Export-Verification` header on `src/app/api/laxii/resume/export/route.ts`, `POST /api/laxii/resume/export/verify` | The exact produced bytes are decoded and key facts + reading order are checked before/with the download; failures are reported, never claimed as success. |
| Tailored resume copies (master preserved) | Existing (M33.5-C) | `createTailoredCopy` in `src/lib/laxii/resume-service.ts`, `POST /api/laxii/resume` action `tailor_copy` | New variant row linked to the master (master NEVER mutated); facts snapshot copied verbatim; JD stored as sha256 (full text only with explicit opt-in); same anti-fabrication guards; before/after diff (removed/reworded/reordered — never invented). |
| Bounded resume revision history | Existing (M33.5-C) | `LaxiiResumeRevision` model, `/api/laxii/resume/revisions`, `src/components/laxii/LaxiiResumeVersions.tsx` | Transactional snapshots BEFORE every mutation; restore snapshots the current state first (restore-forward always possible); max 30 per resume with pinned-safe pruning; compare shows a structural diff. |
| Cover letters (first-class private documents) | Existing (M33.5-D) | `src/lib/laxii/cover-letter-schema.ts`, `cover-letter-service.ts`, `cover-letter-export.ts`, `/api/laxii/cover-letter*`, `src/components/laxii/LaxiiCoverLetterPanel.tsx` | Generation from linked resume's confirmed facts + JD via aiGate; entity+metric guards (invented names/numbers rejected, NOTHING saved); rephrase touches exactly one paragraph; user edits lose the AI badge; neutral placeholder greeting labelled; PDF/DOCX export decoded+re-read with honest verification header; private LaxiiCoverLetter rows, no public URLs. |
| ATS scoring / ATS-pass guarantees | Unsupported | `src/app/api/laxii/resume/analyze/route.ts` + `resume-analysis.ts` (`untested[]`) | M33.5 ships measurable readability checks + an evidence map, explicitly NOT an ATS score; vendor parsing/ranking behaviour is never emulated or predicted. |
| Cover letters | Existing (M33.5-D) | see the capability table row above | Built and tested in M33.5-D. |
| EXIF/metadata stripping on uploads/outputs | Unsupported | `docs/known-limitations.md` | Documented limitation. |
| Worker queue with lease/heartbeat for generation | Partial | `src/lib/laxii/jobs.ts` | Durable DB claim + status-guarded terminal writes + 30-min stale sweep, in-process; no cross-replica lease machinery. |
| Diffusers self-hosted worker | Owner-setup-required | `src/lib/laxii/providers/diffusers.ts` | Requires `LAXII_DIFFUSERS_URL`; never user-selectable in V1. |

### 2.3 LAXII gaps (priority register)

| Gap | Priority | Notes |
| --- | --- | --- |
| Versioned banner canvas registry (hero/platform covers/campaign formats + strict custom bounds) preserving canonical 2048×687 | Existing (M33.4) | `src/lib/laxii/banner-presets.ts` — 11 presets; platform entries carry `official`/`checkedAt`/`sourceUrl` verified 2026-11-25 against each platform's own docs; custom canvases via `resolveCustomBannerCanvas` (64–4096 per side, ≤2^22 px area, never silently clamped); export enforces registry dims + documented platform byte caps. X/Twitter header deliberately absent (official page unverifiable at check time). |
| Numeric regression tests proving protected-region pixels unchanged (future preserve-pixel path) | Existing (M33.4-C) | `tests/laxii-identity-lock.test.ts` — 13 cases: bit-identical core (max delta 0), exact feather equation ±1/255 with SEPARATE band counters, 1:1 no-clip mapping, dimension/corrupt/uncertain-mask fail-closed, source sha256 immutability, plate person-gate (3 attempts), real-model segmentation integration. |
| Deterministic typography with user-selected approved font families + glyph coverage checks | Existing (M33.4-B) | `src/lib/laxii/font-assets.ts` — 9-family provisioned subset of SITE_FONTS (Fraunces, Inter, Anton, Oswald, Lato, Merriweather, Caveat, Pacifico, Kalam), each family's own OFL.txt tracked beside its sha256-pinned file; measured charset coverage (`checkGlyphCoverage`); kind fallbacks are system DejaVu with explicit warnings. |
| Cover-letter drafting grounded in the same facts (only after tests) | Existing (M33.5-D) | `src/lib/laxii/cover-letter-service.ts` — 17 tests across `tests/cover-letter.test.ts` + `tests/cover-letter-route.test.ts`. |
| ATS-oriented parsing checks + job-keyword gap reporting | Existing (M33.5-B) | Honest deterministic checks + evidence map only; never an ATS score (`tests/resume-analysis.test.ts`, 23 tests). |
| Resume renderer + anti-fabrication unit tests | Existing (M33.5-B/C) | `tests/resume-analysis.test.ts` renders real pdfkit/docx bytes and round-trip-verifies them; guard functions covered by `tests/resume-variants.test.ts` + `tests/resume-import.test.ts`. |
| OCR for scanned/image-only resumes | Deferred (M33.5 decision) | `docs/reports/M33.5_CAPABILITY_GAP_REPORT.md` §4 | Safe rasterization + licence-pinned traineddata could not be delivered within this milestone's audit/benchmark budget; the honest "scanned resumes can't be read as text" path remains. |

---

## 3. RIISHE — conversational agent and governed orchestration

### 3.1 Verified registry sizes (live imports, baseline `73cf553` + M35)

| Registry | Count | Source of truth |
| --- | --- | --- |
| Registered tools (`RIISHE_TOOLS`, incl. 9 specialist tools + 12 M35 creative tools + 2 M36.1 portfolio tools) | 37 | `src/lib/riishe/tools.ts`, `src/lib/riishe/specialist-tools.ts`, `src/lib/riishe/creative-tools.ts`, `src/lib/riishe/portfolio-tools.ts` |
| Registered M35 creative tools (`giftz.*`/`laxii.*`/career-document) | 12 | `src/lib/riishe/creative-tools.ts` |
| Registered M36.1 portfolio tools (`portfolio.*`, read-only evidence) | 2 | `src/lib/riishe/portfolio-tools.ts` |
| Specialists (`SPECIALISTS`, incl. `creative-producer` + M36.1 `people-finder`, `portfolio-intelligence`) | 12 | `src/lib/riishe/specialists.ts` |
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
| Registered `giftz.*` tools in `RIISHE_TOOLS` | Existing (M35) | `src/lib/riishe/creative-tools.ts` (`giftz.site.plan/create`, `giftz.task.create/status/approve`), tests `tests/riishe-creative-tools.test.ts` | Real services wrapped via `defineTool`; `giftz.task.approve` is HIGH/level-2 (explicit confirmation, never queue-run); every persistent effect has a verify hook that re-reads the backend. |
| People Finder specialist (personal people discovery) | Existing (M36.1) | `src/lib/riishe/specialists.ts` (`people-finder`), tests `tests/riishe-portfolio-evidence.test.ts` | PERSONAL-scope registration over the EXISTING `discovery.searchCreators`, `shortlist.addCreators`, `enquiry.draft` + the shared `portfolio.publicEvidence` tool — no second discovery/shortlist/enquiry service; organization candidate discovery stays with Talent Scout (workspace-aware `classifySpecialist`). |
| Portfolio Intelligence Analyst (self evidence report) | Existing (M36.1) | `src/lib/riishe/portfolio-tools.ts` (`portfolio.evidenceReport`), tests `tests/riishe-portfolio-evidence.test.ts` | Deterministic, read-only owner-scoped report with the binding evidence ladder (DECLARED/DEMONSTRATED/VERIFIED/UNKNOWN): verification ONLY from real `TrustVerification` rows (status VERIFIED), never per-skill/per-project; no scores; private/draft/archived work never labelled publicly discoverable. Candidate/org scope deliberately NOT implemented in M36.1. |
| Consent-aware public work evidence (`portfolio.publicEvidence`) | Existing (M36.1) | `src/lib/riishe/portfolio-tools.ts` (`portfolio.publicEvidence`), tests `tests/riishe-portfolio-evidence.test.ts` | Fresh per-execution public ladder (target PUBLIC via `isProfilePubliclyVisible`, not demo, not deleted, no block either direction, PUBLISHED + PUBLIC + `archivedAt: null` projects only) with a strict output allowlist (no contact data, no private fields, no third-party verification evidence). AI-derived analysis is gated by the subject's FRESH `AI_PROCESSING` consent (`getCurrentConsent` + current `OX_CONSENT_VERSION`); without it the tool returns declared + link-level output and NEVER calls the gateway; AI-derived results are never persisted or cached. |
| Registered `laxii.*` tools in `RIISHE_TOOLS` | Existing (M35) | `src/lib/riishe/creative-tools.ts` (`laxii.banner.brief/produce`, `laxii.job.status`), `tests/riishe-m357-safety-hardening.test.ts` | `laxii.banner.produce` runs the shared `startBriefDrivenBanner` entry (same code the studio route calls); since M35.7 it is **MEDIUM/level-2** — provider generation consumes the owner's daily image/cost guards and waits for explicit approval; daily guards apply end-to-end. |
| Registered career-document tools in `RIISHE_TOOLS` | Existing (M35) | `src/lib/riishe/creative-tools.ts` (`career.resume.analyze/importProposal/tailoredCopy`, `career.coverLetter.draft`), `tests/riishe-m357-safety-hardening.test.ts` | M33.5 deterministic analysis, import proposal (nothing persisted), tailored copies (master untouched) and the guarded cover-letter writer. Since M35.7 the two AI generation tools (`career.resume.tailoredCopy`, `career.coverLetter.draft`) are **MEDIUM/level-2** — the gateway call consumes the shared AI budget and waits for explicit approval. |
| Payment / spend tools | Unsupported by design | `src/lib/riishe/tool-contracts.ts` header | "RIISHE has NO tools for spending money" — permanent. |
| Durable step-level idempotency for artifact-creating tools | Existing (M35.7) | `prisma/schema.prisma` (`createdViaStepId` on `GiftzSite` + `AgentTask`), `src/lib/riishe/creative-tools.ts`, `tests/riishe-m357-safety-hardening.test.ts` | `giftz.site.create` + `laxii.banner.brief` stamp the artifact with the creating workflow step in the SAME insert (nullable unique index); a retry after a partially successful write re-attaches to the stamped artifact — never a duplicate; concurrent redelivery loses the P2002 race and re-reads. |
| Typed artefact references resolve only from explicit, successful dependencies | Existing (M35.7) | `src/lib/riishe/workflow-engine.ts` (`createWorkflowFromPlan` + `resolveStepParams`), `tests/riishe-m357-safety-hardening.test.ts` | Plan time: refs must name an earlier step declared in `dependsOn` (forward refs / self refs / unknown ids / undeclared refs rejected). Resolution time: source step must be a declared dependency AND `SUCCEEDED` (`dependency-undeclared` / `dependency-failed` / `dependency-missing`), dependents of failed producers SKIP. |
| Duplicate-delivery + replayed-approval hardening | Existing (M35.7) | `src/lib/riishe/workflow-engine.ts` (`runWorkflowStepJob` RUNNING guard, `approveStep` terminal guard), `tests/riishe-m357-safety-hardening.test.ts` | Jobs redelivered while a step is RUNNING never execute the tool twice (the sweep recovers stale rows); executing a SUCCEEDED step reports `already`; approving a terminal step is refused. |
| Atomic execution claims + concurrency control | Existing (M35.8) | `src/lib/riishe/workflow-engine.ts` (`claimStepExecution`, `finishClaimedStep`, `releaseClaimIfWorkflowInactive`), `tests/riishe-m358-concurrency.test.ts` | Every execution claim is ONE atomic conditional database transition (no check-then-update pair, no in-memory mutex — multi-process safe): only one worker claims an eligible READY step, only one simultaneous approval request claims an approval-class step, and the loser never executes the tool. Terminal writes are ownership-guarded on the post-claim `attempts` token (a stale worker recovered by the sweep cannot overwrite the live attempt); the claim re-verifies workflow status so pause/cancel cannot be bypassed; pause/cancel/resume/decline/retry/sweep transitions are conditionally guarded both ways; `approveStep` refuses replayed approvals atomically. Verified by real-database barrier/Promise.all race tests (simultaneous claims, simultaneous level-2 approvals, duplicate delivery, cancel/pause races, stale-worker recovery, exactly-one attempt/artifact/audit). |
| Streaming chat (SSE) | Partial (route tested; live surface uses the action path) | `src/app/api/ai/chat-stream/route.ts`, `src/views/IntelligenceView.tsx` | M35 retired the orphaned floating assistant (`RiisheAssistant` deleted); the live surface deliberately stays on `/api/ai/chat` because the action path carries the governance cards (delegation/workflow/automation). Wiring streaming INTO the governance surface requires sharing the execution pipeline with the stream route — future work, not faked. |

### 3.3 RIISHE gaps (priority register)

| Gap | Priority | Notes |
| --- | --- | --- |
| `giftz.brief.create` / `giftz.site.plan` / `giftz.project.build` style registered tools | **Resolved (M35)** | `src/lib/riishe/creative-tools.ts` — 5 `giftz.*` tools reuse `defineTool` + registry contracts; the approval gate is re-checked at execution (`mayExecuteStep`). |
| `laxii.banner.produce` / `laxii.resume.*` style registered tools | **Resolved (M35)** | Same file — 3 `laxii.*` tools + 4 career-document tools over the real M33.5/M33.4 services. |
| Wire streaming UI to the live surface (or retire the orphaned component) | **Resolved (M35, retire branch)** | The orphaned `RiisheAssistant` component is deleted; the tested stream route remains. Streaming into the governance surface stays future work (needs the execution pipeline shared with the stream route) — recorded honestly in §3.2. |

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
| LAXII provisioned banner fonts (9 families, M33.4-B) | Each family's own OFL-1.1 text tracked at `data/laxii-fonts/<id>/OFL.txt`; binaries sha256-pinned by `scripts/laxii/prefetch-banner-fonts.ts` | **Keep (server-side rendering only).** OFL permits embedding/server use with attribution; per-family licence text ships beside the file. Provisioned subset only — other SITE_FONTS families still resolve via CDN for websites and never claim server-side rendering. |
| MODNet weights on disk (`data/laxii-models/`) | Apache-2.0 (verified 2026-11-25) | **Now USED again (M33.4-C)**: `Xenova/modnet@fa2fa54` ONNX weights (sha256 `07c308cf…` verified equal to the Hub LFS oid; model card Apache-2.0; upstream ZHKKKe/MODNet Apache-2.0 including released weights) executed locally by `src/lib/laxii/segmentation.ts` via onnxruntime-node `1.31.1` (MIT). Registered in `docs/oss/THIRD_PARTY_COMPONENTS.md`. |

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
   M33.4-C rebuilt the identity-lock capability as a NEW pipeline
   (`src/lib/laxii/avatar-identity.ts` + `src/lib/laxii/segmentation.ts`);
   the removed-engine provenance stays documented in
   `tests/laxii-backdrop.test.ts.disabled`, whose captured fixtures
   (`tests/fixtures/laxii/`) now feed the NEW pipeline's person-gate and
   segmentation regression tests.

## 7. Machine-checked honesty (this milestone's test)

`tests/universal-studio-capability-matrix.test.ts` pins this document to the
live code: every registry count in §1.1/§2.1/§3.1 must equal the imported
registry length; every `src/`/`docs/` evidence path cited above must exist;
the "Unsupported (today)" RIISHE tool-family claims are verified against the
live `RIISHE_TOOLS` keys; the GIFTZ model-facing section-type list is verified
to contain `featured` and `reel`. If the code and this document drift, the
test fails — the document may never claim a capability the registries do not
have.
