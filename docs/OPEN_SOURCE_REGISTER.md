# BEAN FOLIO — OPEN SOURCE REGISTER (M0)

**Audit date:** 2026-11-13. License facts fetched live from the GitHub API (`repos/{repo}` + license-file contents). Stars/push dates are point-in-time snapshots.
**Policy:** MIT / Apache-2.0 / BSD preferred after review. GPL/AGPL/BSL/source-available components are flagged and require isolation or written approval before adoption. Every future adopted dependency must be appended here with purpose, version, and review verdict.

## 1. Currently adopted stack (verified in `package.json` / `bun.lock`)

| Dependency | Purpose | License | Verdict |
|---|---|---|---|
| next ^16.1.1, react ^19, react-dom ^19 | framework + renderer | MIT | ✅ keep |
| @prisma/client + prisma ^6.11.1 | ORM (SQLite dev, Postgres prod) | Apache-2.0 | ✅ keep |
| tailwindcss ^4 (+ postcss, tailwind-merge, tailwindcss-animate, tw-animate-css) | styling | MIT | ✅ keep |
| shadcn/ui primitives: @radix-ui/react-* (23 pkgs), class-variance-authority, clsx, lucide-react, sonner, vaul, embla-carousel-react, cmdk, input-otp, react-day-picker | component system | MIT/BSD-family | ✅ keep — 23 Radix-backed primitives currently unused (see cleanup list in UI audit) |
| next-themes ^0.4.6 | theme provider (dark-only today) | MIT | ✅ keep |
| zod ^4 | validation at every API boundary | MIT | ✅ keep |
| zustand ^5 | single store (feed-video coordinator) | MIT | ✅ keep |
| @aws-sdk/client-s3 + s3-request-presigner + @smithy/* | S3-compatible storage driver + presigned PUT | Apache-2.0 | ✅ keep |
| z-ai-web-dev-sdk ^0.0.18 | managed AI gateway transport (text/vision/images) | bundled managed service | ✅ keep (server-side only) |
| recharts ^2.15.4 | Insights charts | MIT | ✅ keep |
| react-markdown ^10.1 | AI/markdown rendering | MIT | ✅ keep |
| react-syntax-highlighter ^15.6 | code display | MIT | ✅ keep |
| framer-motion ^12.23 | studio motion | MIT | ✅ keep |
| sharp ^0.34 | image processing | ISC + libjpeg/png (commercial OK) | ✅ keep |
| docx ^9.15, pdfkit ^0.20, mammoth ^1.13, pdf-parse ^2.4 | resume export/parse pipeline | Apache-2.0/MIT | ✅ keep |
| jszip ^3.10 | site export ZIP | MIT/GPLv3 dual — MIT path used | ✅ keep |
| @dnd-kit/core/sortable/utilities | drag-and-drop (legacy portfolio + future editors) | MIT | ✅ keep |
| date-fns ^4.1, uuid ^11.1 | utilities | MIT | ✅ keep |
| next-auth ^4.24.11 | **UNUSED — zero imports (custom auth)** | MIT | ⚠️ remove candidate |
| @tanstack/react-query ^5.82, @tanstack/react-table ^8.21, react-hook-form ^7.60, @hookform/resolvers ^5.1 | **UNUSED in app code** | MIT | ⚠️ remove-or-adopt decision at M1 (profile editor could adopt RHF) |
| @mdxeditor/editor ^3.39 | **UNUSED** | MIT | ⚠️ remove candidate |
| react-resizable-panels ^3.0.3 | studio panels | MIT | ✅ keep |

## 2. Researched candidates for M1–M14 (live GitHub facts, 2026-11-13)

### M2 — Visual portfolio editor
| Repo | Stars | License | Last push | Verdict |
|---|---|---|---|---|
| puckeditor/puck | 13,699 | **MIT** | 2026-11-13 (active) | ✅ **Recommended M2 foundation** — React visual editor, JSON layout model, custom widget registry matches BEAN widget-library requirements; MIT clean |
| prevwong/craft.js | 8,768 | MIT | **2025-02-14 (≈21 months stale)** | ⚠️ rejected as primary: maintenance stalled; MIT fine but activity risk |

### M4 — Workgraph visualization
| Repo | Stars | License | Last push | Verdict |
|---|---|---|---|---|
| xyflow/xyflow (React Flow) | 39,006 | **MIT** | 2026-11-12 (active) | ✅ **Recommended** visualization layer (graph rendered from authorized DB records only, per M4 rules) |
| cytoscape/cytoscape.js | 11,288 | MIT | 2026-11-10 (active) | alternative — heavier imperative API, weaker React integration |

### M6 — Search engine
| Repo | Stars | License | Last push | Verdict |
|---|---|---|---|---|
| meilisearch/meilisearch | 59,854 | **MIT AND BUSL-1.1** (core MIT; `enterprise/` parts BSL 1.1) | active (Rust binary) | ⚠️ conditional: MIT core usable; must pin core-only images and audit EE modules; operational cost: separate service |
| typesense/typesense | 27,129 | **GPL-3.0** | active | ❌ rejected — GPL server; copyleft risk for a hosted SaaS embedding it as first-party infra |
| opensearch-project/OpenSearch | 14,006 | **Apache-2.0** | active (JVM) | ⚠️ license clean but operationally heavy; overkill at current scale |
| **Interim decision:** first-party SQLite/Prisma search already ships and is permission-aware. Keep it until real scale demands an engine; then adopt Meilisearch **core** (documenting the BSL carve-out) or a managed Meilisearch Cloud plan. |

### M7 — AI observability / routing / RAG
| Repo | Stars | License | Last push | Verdict |
|---|---|---|---|---|
| BerriAI/litellm | 63,216 | MIT core + separate `enterprise/` license | active (Python proxy) | ⚠️ rejected as in-process dependency: architecture mismatch (Next.js/Bun app already has a gateway with breaker/retries); a Python sidecar adds ops surface; enterprise dir not needed |
| comet-ml/opik | 23,392 | **Apache-2.0** | active | ✅ leading candidate for M7 tracing/eval (self-host or cloud) |
| langfuse/langfuse | 37,393 | MIT core + `ee/` dirs proprietary | active | ⚠️ acceptable for core self-host; audit `ee/` boundaries |
| run-llama/llama_index | 52,894 | MIT | active | ⚠️ evaluate only if M7 requires heavy RAG; BEAN's grounded context builder (`src/lib/intelligence/context.ts`) may suffice with in-house retrieval |

### M9 — Analytics
| Repo | Stars | License | Last push | Verdict |
|---|---|---|---|---|
| PostHog/posthog | 40,773 | MIT core + `ee/` proprietary | active | ⚠️ heavy self-host; plausible cloud option |
| umami-software/umami | 40,119 | **MIT** | active | ✅ lightweight self-host alternative if/when BEAN outgrows first-party tracking |
| plausible/analytics | 29,841 | **AGPL-3.0** | active | ❌ rejected — AGPL for a hosted service component |

**Interim decision:** BEAN's first-party analytics (deduped views, impression buckets, documented engagement formula) is genuinely implemented and privacy-clean. Keep it; revisit only for traffic-source/attribution depth (M9), preferring umami (MIT).

### M12 — Billing / subscriptions
| Repo | Stars | License | Last push | Verdict |
|---|---|---|---|---|
| getlago/lago | 10,832 | **AGPL-3.0** | active (Go) | ❌ rejected for embedding — AGPL; would require separate-service isolation and legal review, or Lago's commercial license |
| killbill/killbill | 5,854 | **Apache-2.0** | active (Java) | ✅ clean-license alternative (heavier ops; evaluate vs. a first-party entitlement model + Stripe/Paddle/Razorpay integration at M12) |

### M5 / M8 — Verifiable credentials & portable data (standards, not repos)
| Standard | Status | Verdict |
|---|---|---|
| W3C Verifiable Credentials Data Model 2.0 (w3c/vc-data-model, active) | Recommendation-track | ✅ adopt the **data model + JSON serialization** for evidence/credential records; do **not** invent a custom cryptographic protocol (M5 explicitly forbids it); use existing libs (e.g. `@digitalcredentials/vc` family) when implementing |
| 1EdTech Open Badges 3.0 (1EdTech/openbadges-specification, active) | current spec (published under spec terms) | ✅ align credential issuance payloads with OB 3.0 (it builds on W3C VC) |

## 3. Register governance rules (standing)

1. Any new runtime dependency requires an entry here (name, version, license, purpose, verdict) before merging.
2. GPL/AGPL/BSL/SSPL/source-available components are **rejected by default**; exceptions need written justification + isolation plan (separate service/process boundary).
3. "COPYING a repository" is preferred over "installing a library" only when the library is not maintained as a package; otherwise prefer packages.
4. Rejected alternatives and reasons are recorded in `docs/ARCHITECTURE_DECISIONS.md`.
5. License re-check on every major-version bump (this register is re-verified each milestone audit).
