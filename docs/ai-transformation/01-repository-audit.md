# BEAN Folio — Phase 0 Repository Audit (AI Intelligence Transformation)

Date: performed at the start of the AI Intelligence Transformation program.
Scope: full repository inspection with three parallel audit tracks (docs/worklogs, AI systems, schema/auth/media/branding), plus a live toolchain baseline.
Method: read-only. No code was changed during the audit. Every claim below was verified against source with exact file paths.

---

## 1. Toolchain baseline (actually executed during this audit)

| Check | Result |
|---|---|
| `bun run lint` (eslint .) | **clean, exit 0** |
| `bunx tsc --noEmit` | **clean, exit 0** |
| `bunx prisma validate` (schema.prisma) | **valid** |
| `bunx prisma validate` (schema.postgres.prisma) | **valid** |
| Dev server (`bun run dev`, port 3000) | running; recent log shows only 2xx API responses |
| Bun | 1.3.14 |
| Git working tree | clean at audit start |

Historical worklog claims (204 tests pass / 2 pre-existing fails, 32/32 API journeys) were **not** re-run as part of the audit itself; the transformation program re-runs the full suite in its verification phase (see the testing report when written).

---

## 2. Product inventory

BEAN Folio is a Next.js 16 (App Router) portfolio platform. The UI is a hash-routed SPA mounted at `/` (`src/app/page.tsx` → `SiteShell.tsx`), with ~55 REST route files under `src/app/api/**`. Data: Prisma 6 + SQLite locally, PostgreSQL mirror schema prepared for production. Auth: custom scrypt + opaque cookie sessions (no next-auth). Storage: local `uploads/` driver + S3 driver (`src/lib/storage.ts`).

Three AI surfaces exist today:

| Surface | Location | State |
|---|---|---|
| **LAXII** — conversational AI image studio (banner 942×190, avatar, resume) | `src/lib/laxii/**`, `src/app/api/laxii/**`, `src/components/laxii/**` | Live, substantial, honest-failure architecture |
| **RIISHE** — general assistant (BEAN Intelligence) | `src/app/api/ai/chat`, `/api/ai/chat-stream`, `/api/ai/improve`, `/api/ai/suggest`, `src/views/IntelligenceView.tsx` | Live, but **two divergent implementations** (§5.1) |
| **Code Giftz** — website-design agent (Website Studio) | `src/lib/ai-design/**`, `src/app/api/ai/design/**`, `src/components/bean/site/CodeGiftzPanel.tsx` | Live, real agentic pipeline (plan→approve→execute→verify→preview) |

---

## 3. Prisma schema (36 models, verified)

Both `prisma/schema.prisma` (SQLite) and `prisma/schema.postgres.prisma` (PostgreSQL mirror) hold exactly 36 models and were validated. Model groups:

- **Identity/auth**: `User` (role USER|ADMIN, `aiConsent`, `profileVisibility`), `Session` (SHA-256 token), `PasswordResetToken`.
- **Taxonomy**: `Profession`, `ProfileProfession`, `ProfileSkill`, `Skill`.
- **Media**: `MediaAsset` (kind/mime/dims/status, owner-scoped storage keys).
- **Portfolio**: `Project` (DRAFT/PUBLISHED × PUBLIC/UNLISTED/PRIVATE), `ProjectSkill`, `ProjectMedia`, `Contributor`, `SavedProject`, `Collection`, `CollectionItem`, `Follow`, `ProjectView`, `ProfileView`.
- **Communication**: `Inquiry`, `Notification`, `Block`, `Report`.
- **AI**: `AiConversation`, `AiMessage`, `AiUsage` (30/day shared pool), `LaxiiConversation` (kind IMAGE|BANNER|AVATAR|RESUME + banner canvas geometry), `LaxiiMessage` (operation/provider/model/status/meta), `LaxiiImageVersion` (parent-linked tree, isSelected/isFavourite), `LaxiiUsage` (80/day images), `LaxiiResume`.
- **Website builder**: `SiteDesign` (draft/published config, watermark), `SiteMaterial` (Code Giftz inputs), `SiteRevision` (auto-snapshots, pruned to 10).
- **Governance**: `AuditEvent` (append-only), `ExportJob`, `DeletionRequest`.

**Missing for the transformation (gap analysis):**
- No `AgentTask` / cross-agent orchestration model — Code Giftz jobs are **in-memory only** (`src/lib/ai-design/jobs.ts:2`), so they do not survive restarts (Phase 5 requires durable task state).
- No provider-registry persistence, usage-cost ledger, or gateway health record. The provider registry is code constants in `src/lib/laxii/router.ts:35-50` and the single-provider text gateway `src/lib/ai.ts`.

---

## 4. Auth, permissions, privacy (verified sound)

- Opaque 256-bit session tokens, stored as SHA-256; httpOnly cookie `bean_session`; scrypt password hashing; recovery-key + email double-factor reset that revokes all sessions.
- `requireAdmin()` with deliberately indistinguishable 403s; append-only `AuditEvent` trail with a user-facing `/api/me/audit` view.
- Visibility ladder enforced **server-side everywhere** (`src/lib/visibility.ts`): profile PUBLIC/PRIVATE × project DRAFT/PUBLISHED × PUBLIC/UNLISTED/PRIVATE; public filters require non-demo, non-deleted, public-profile owners.
- Media serving ladder (`src/app/api/media/[id]/raw/route.ts`): owner → avatar/cover of live account → project covers → project gallery (PUBLIC/UNLISTED) → published SiteDesign logo/cover (ownership-checked) → 403. Magic-byte upload validation, full-buffer re-verify, path-traversal guard.
- **AI privacy today**: both RIISHE chat routes inject the user's own profile + latest 10 own projects (including PRIVATE/DRAFT) into the system prompt, gated behind `User.aiConsent` (403 without consent) + 6/min burst + 30/day quota. Grounding is own-data-only; no cross-user leakage path found.

---

## 5. AI systems audit

### 5.1 RIISHE — two divergent chat implementations (defect)

| | `POST /api/ai/chat` | `POST /api/ai/chat-stream` (SSE) |
|---|---|---|
| Used by | IntelligenceView (BEAN Intelligence page) | floating `RiisheAssistant.tsx` — **which is dead code, mounted nowhere** |
| Persona | "RIISHE, the general assistant inside BEAN Folio (BEAN Intelligence)… distinct agent from Code Giftz… advisory-only" + routing guard to Code Giftz | Older persona: "RIISHE, the portfolio assistant… **(you were built by the Code Giftz team)**… help configure code widgets" |
| Context assembly | own profile + 10 projects | identical, copy-pasted |

Problems: persona drift, a false provenance claim ("built by the Code Giftz team" — Code Giftz is a sibling agent, not RIISHE's creator), and ~70 lines of duplicated context-building code. The streaming route is only consumed by a dead component.

### 5.2 Code Giftz — real but bounded, and its job store is not durable

Real pipeline: `POST /api/ai/design/plan` (deep-reasoning plan bound to a validated tool registry) → user approval → `/api/ai/design/execute` (in-memory job, per-step provider calls, mechanical constraint enforcement, byte-identical "repaired" restore) → job poll (1.5s) → verification report (7 server checks + honest `untested` list) → real browser preview checks → proposal applied only via the manual draft flow. Audit mode is read-only.

Bounds (honest, documented in `src/lib/ai-design/tools.ts`): the only mutation surface is the zod-validated `SiteConfig` JSON. **No** terminal, repo indexing, multi-file codegen, or test execution exists. `UNSUPPORTED_CAPABILITIES` says so explicitly. The in-memory job store is lost on restart — Phase 5 requires durable cross-agent tasks.

### 5.3 LAXII — strongest surface; already matches much of Phase 3

- Provider registry (code-level) of 4 real providers: `managed` (z-ai SDK images API), `gemini` (Interactions API, `gemini-nano-banana-2.1` default), `openai` (`gpt-image-2.5-sunburst` default, images/generations + images/edits with `input_fidelity=high`), `diffusers` (HTTP to `LAXII_DIFFUSERS_URL`). Pinned-but-unconfigured providers are **refused, never silently substituted** (`router.ts:68-85`). Capability table per operation; `requireCapability` before dispatch; output validation + deterministic post-processing.
- Banner pipeline: single fixed preset **942×190** (`banner-presets.ts`), safe area ≈810×171, engine renders nearest aspect (21:9 → 2016×864), job worker composites onto the exact canvas via sharp (cover-fit, never stretched), export route re-encodes, re-probes decoded pixels and verifies exactly 942×190 before storing.
- Avatar pipeline: 10 no-prompt style presets, identity-preservation warnings, background removal via generative isolation + alpha extraction with an 8–95% subject-coverage sanity gate that fails honestly.
- Jobs: 202 + poll pattern, one RUNNING job per conversation, stale sweep after 30 min, per-output isolation, idempotent duplicate-media guard. Usage: `LaxiiUsage` ledger, 80 images/day + 6/min.
- Resume Studio: document-only (never images), zod-validated JSON-Resume schema, invented-entity cross-check against user facts (1 corrective retry, then honest 502), aiTouched provenance.
- **Gaps vs Phase 3**: no quality-evaluation pipeline beyond deterministic validation; banner "intelligence" (portfolio-aware brief via Riishe) absent; editing preservation directives exist per intent kind but no version-lineage-aware "transform only the requested thing" guarantee beyond prompts.

### 5.4 Shared text gateway (`src/lib/ai.ts`)

Single server-side integration over `z-ai-web-dev-sdk`: `aiComplete` (60s timeout, thinking toggle, safe `AiProviderError`), `aiStream` (SSE for chat), `aiVision` (≤5 images), `parseJsonFromText`. `aiGate` = consent → 6/min → 30/day via `AiUsage`. **No circuit breaker, no retry policy, no health checks, no fallback chain, no structured logging, no cost tracking** — all Phase 1 requirements that must be added.

### 5.5 Duplication / dead code (proven unreachable)

| Item | Evidence | Action in this program |
|---|---|---|
| `src/components/bean/RiisheAssistant.tsx` (391 lines) | imported nowhere (grep-verified) | remove in Phase 2 (proven unreachable) |
| `src/components/bean/site/RiisheDesignPanel.tsx` (365 lines) | imported nowhere; `WebsiteBuilderView` imports `CodeGiftzPanel` only | remove (proven unreachable) |
| Legacy `POST /api/ai/design` one-shot route | still mounted; served only the dead panel; duplicates `summarizeChanges` (drifted copy vs `ai-design/diff.ts`) | remove route + dedupe helper (proven unreachable; regression test updated) |
| `scripts/laxii/diffusers_worker.py` | orphaned: TS provider speaks REST (`LAXII_DIFFUSERS_URL`); nothing invokes the CLI worker | keep (documented local path), mark as auxiliary in docs |
| Two ZAI singletons (`__beanZai`, `__laxiiZai`) | `ai.ts:25` vs `managed.ts:33` | converge under the gateway in Phase 1 (behavior-preserving) |
| Two usage ledgers (`AiUsage` 30/day, `LaxiiUsage` 80/day); resume counts in both | `ai.ts:100-106`, `generate/route.ts:88-91` | keep separate quotas (different cost classes) but document the boundary |

---

## 6. Model identifiers found (exact strings, single source list)

| Identifier | Where | Status |
|---|---|---|
| `managed-image-1` | `src/lib/laxii/providers/managed.ts:75` | internal label for the managed gateway (no public model id exists for it — recorded as-is) |
| `gemini-nano-banana-2.1` | `providers/gemini.ts:39` (env `LAXII_GEMINI_IMAGE_MODEL`) | documented provider model (repo's own verified registry) |
| `gemini-3.1-flash-image`, `gemini-3-pro-image` | `gemini.ts:22-23` (alternates), `router.ts:103-104` (cost tiers) | documented alternates |
| `gpt-image-2.5-sunburst` | `providers/openai.ts:39` (env `LAXII_OPENAI_IMAGE_MODEL`) | documented provider model |
| `gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2.5-flare` | `openai.ts:18-19` | documented alternates |
| `local-diffusers` | `providers/diffusers.ts:39` | local deployment id |
| `runwayml/stable-diffusion-v1-5` | `scripts/laxii/diffusers_worker.py:113` | local worker default |
| text chat model | **never named anywhere in src/** — deliberately resolved by the gateway | preserved (no fabricated ids) |

No `cogview-*`, `glm-4*`, Claude, Llama, Mistral, DeepSeek, Qwen, Flux, Ollama strings exist in `src/`. **No fabricated model identifiers were found.**

---

## 7. User-facing external-AI branding (violations of the non-negotiable rule)

| # | Location | What renders | Classification |
|---|---|---|---|
| 1 | `src/views/IntelligenceView.tsx` (capabilities row) ← `src/lib/ai.ts:60` | "Provider: **z-ai-glm (server-side)**" | user-facing → must fix |
| 2 | `src/components/bean/site/CodeGiftzPanel.tsx` (footer) | "Runs on the shared server-side AI provider **(GLM)**" | user-facing → must fix |
| 3 | `src/components/bean/site/RiisheDesignPanel.tsx` (footer) | same "(GLM)" copy | dead file → removed |
| 4 | `src/components/laxii/LaxiiStudio.tsx` (engine dropdown) | provider labels: "**OpenAI GPT Image**", "**Google Nano Banana**", "**Local Diffusers**", "BEAN managed engine" | user-facing → rebrand under LAXII identities (§7.1) |
| 5 | `src/lib/laxii/providers/openai.ts`, `gemini.ts`, `diffusers.ts` | provider error strings name OpenAI/Google/Diffusers; surfaced in toasts/cards | user-facing → neutralize |
| 6 | `src/lib/laxii/resume-service.ts:32-33` | labels `"bean-ai"` / `"glm (server-side gateway)"` stored on messages | UI shows neutral "LAXII engine" chip → align labels |
| 7 | `src/app/api/ai/chat-stream/route.ts` | persona claims RIISHE "was built by the Code Giftz team" | false provenance → removed in persona unification |

**Legal/disclosure surfaces that must be preserved** (verified present, provider-anonymous): `src/views/StaticView.tsx` ("BEAN Intelligence calls a server-side AI provider… consent… revocable"), `IntelligenceView.tsx` consent copy, consent gates in both agents. These stay.

**7.1 Display-name policy adopted** (complies with "no external brand names in user-facing product interfaces" + "no false ownership claims"): LAXII engines get LAXII-family display names; the provider backing each engine remains server-side and is disclosed generically in the existing legal copy ("a server-side AI provider"). Engine ids stay `managed|gemini|openai|diffusers` so routing, tests and stored data are untouched:

| Engine id | Old label | New user-facing label |
|---|---|---|
| `managed` | BEAN managed engine | **LAXII Core** — managed engine |
| `gemini` | Google Nano Banana | **LAXII Prisma** — advanced image engine |
| `openai` | OpenAI GPT Image | **LAXII Studio** — professional image engine |
| `diffusers` | Local Diffusers | **LAXII Local** — self-hosted engine |

RIISHE and Code Giftz copy never names a provider; they say "BEAN Intelligence gateway (server-side)".

---

## 8. Documentation drift found (to fix during the program)

1. `docs/laxii/README.md` describes `engine.ts`, `pipeline/compose.ts|quality.ts`, `ProfileStudio.tsx`, `LAXII_PROVIDER`/`LAXII_MODEL_*` envs that no longer exist; documents 13 banner presets while code has the single 942×190 preset. → rewrite in Phase 3.
2. README/docs claim 27 models ("now 36"), "no automated test suite" (bun test suites exist), "no E2E" (browser E2E ran per worklog). → corrected in the final report.
3. `worklog.md` ends mid-Task-31; avatar pipeline, 942×190 banner change, resume feature are undocumented there. → appended at program end.
4. `.env.example` documents `AI_PROVIDER_API_KEY` which no code reads. → gateway documents its actual env contract.

---

## 9. Security review snapshot (input for the security report)

Known-and-accepted (documented): in-memory rate limiter (per-instance), no CSRF tokens (cookie SameSite=Lax + same-site SPA), no 2FA, cookie `secure` tied to NODE_ENV, AI prompt-injection surface mitigated by advisory-only agents + validated tool registries.

Added by this program: gateway credentials remain server-side only (registry reads env at call time, never serializes keys); provider/model metadata surfaced to clients contains ids/labels/availability only; circuit-breaker state is per-instance memory (no cross-user leakage); all gateway events log structured JSON without prompt contents or credentials.
