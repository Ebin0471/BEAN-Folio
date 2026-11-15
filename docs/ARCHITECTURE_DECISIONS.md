# BEAN FOLIO — ARCHITECTURE DECISIONS (M0)

**Audit date:** 2026-11-13. This file records (a) decisions already embodied in the codebase, (b) alternatives evaluated, and (c) recommended decisions for M1–M14, including rejected options and reasons.

## A. Decisions found in the existing codebase (documented, preserved)

### AD-1 — Hash-router SPA on a single Next.js document
- **What:** the app renders one `page.tsx` (`force-dynamic`); navigation happens via `src/lib/hash-router.tsx`; `src/proxy.ts` rewrites the four public path forms (`/u/*`, `/p/*`, `/site/*`, `/post/*`) onto the SPA document with a boot-route header.
- **Why (in-code rationale):** full SPA state continuity for the studio surfaces; SEO still achieved for public path forms via server-generated per-route OG metadata + sitemap + edge cache.
- **Alternatives:** file-based Next routes per screen; App Router nested layouts.
- **Assessment:** keep. It is load-bearing everywhere; a rewrite is forbidden by the preservation rules. Known cost: non-matched direct paths show the default Next 404 (documented defect UI-1).

### AD-2 — Custom authentication instead of NextAuth
- **What:** scrypt passwords, SHA-256-hashed opaque session tokens in a `Session` table, custom Google OIDC (PKCE + JWKS), recovery-key flow.
- **Alternatives:** NextAuth v4 (declared in package.json, zero imports), Auth.js v5, Clerk.
- **Assessment:** keep the custom implementation (it is tested and more auditable); **remove the unused `next-auth` dependency** to stop confusion. If a future milestone needs OAuth app federation (M13), evaluate `arctic`-style libraries rather than adopting NextAuth wholesale.

### AD-3 — SQLite `db push` in development, Postgres mirror for production
- **What:** no migrations directory; `prisma db push` workflow; `prisma/schema.postgres.prisma` drives `vercel-build`.
- **Assessment:** the dual-schema model is the current weakest operational point (drift: 25 missing models). Recommendation: introduce `prisma migrate` with a single source schema + provider mapping, or at minimum fix the parity gate and CI-enforce it.

### AD-4 — First-party analytics, no third-party trackers
- **What:** deduped `ProjectView`/`ProfileView`/`PostView` per viewerKey/day, `PostImpressionDay` buckets, documented engagement formula, no external SDKs.
- **Alternatives evaluated (M0 research):** PostHog (MIT core + `ee/` proprietary; heavy self-host), Umami (MIT, lightweight), Plausible (AGPL — rejected).
- **Assessment:** keep first-party for M9 basics; adopt Umami only if traffic-source attribution depth is needed. Privacy posture is a differentiator worth keeping.

### AD-5 — Durable queue anchored in the database (`BackgroundJob`)
- **What:** guarded atomic claims, heartbeats, exponential backoff, dead-letter requeue, recurring sweeps; worker boots from `instrumentation.ts`.
- **Alternatives:** Redis/BullMQ (extra infra), Vercel Cron (limited), pg-boss (Postgres-only).
- **Assessment:** keep — it matches the zero-extra-infra constraint and is genuinely tested. Known gap: LAXII jobs and site-studio turns execute in-process (durable state, not durable execution) — route them through the queue when reliability matters (M11).

### AD-6 — No CSP/X-Frame-Options; CHIPS-partitioned cookies for embeds
- **What:** security headers set in `next.config.ts` deliberately omit CSP/XFO (studio preview iframes need same-origin framing); `bean_session` supports `SameSite=None; Secure; Partitioned` via `X-Bean-Embed`.
- **Alternatives:** strict CSP with nonce'd scripts + frame-ancestors allowlist.
- **Assessment:** revisit at M11 — a nonce-based CSP can be introduced for the SPA document while exempting the preview surfaces via explicit directives.

### AD-7 — Dark-only theme
- **What:** layout forces `.dark`, inline boot script strips persisted light prefs; a full `.light` token block exists in `globals.css` but is unreachable.
- **Assessment:** keep dark-only for the platform chrome (brand); **delete or formally gate the dead light tokens** to avoid false theming affordances.

### AD-8 — Polling for messaging; SSE for AI chat streaming
- **What:** DMs poll at 2.5s (10s idle); AI chat uses real SSE (`/api/ai/chat-stream`); no WebSocket anywhere (examples/ scaffolding untouched).
- **Alternatives:** socket.io mini-service (sandbox supports it), long-poll.
- **Assessment:** acceptable now; M10 (Rooms) should pick one realtime transport and reuse it for presence — SSE-first is the lower-risk path on serverless.

### AD-9 — `isDemo` fixture quarantine
- **What:** seed accounts are flagged `isDemo=true`; `visibility.ts` excludes them from every public surface; sitemap/metadata respect it.
- **Assessment:** solid pattern; keep and document in the seed scripts.

### AD-10 — GitHub publication via audited single-branch snapshot (`publish-github-clean.sh`)
- **What:** `github-clean` lineage holds source-only snapshots; hard leak audit (db/.env/uploads/backups/vault); push is manual and fast-forward; **never force-push**.
- **Assessment:** keep. Add a CI step that runs the same leak audit on every push (the audit found the sentinel + tests can be deleted silently — CI closes that hole).

## B. Recommended decisions for M1–M14 (with rejected alternatives)

### RD-M1 — Single profile model + profession-aware metadata JSON (not per-profession tables)
- Rejected: per-profession tables (schema explosion, migration cost), rigid all-fields form (explicitly forbidden by M1).
- Adoption: `User.profileMeta` JSON (zod-validated per profession family) + taxonomy already present (`Profession`/`ProfessionFamily`/`Specialism`).
- Dependency verdicts: no new libraries required; react-hook-form (already declared, unused) is the candidate for the rebuilt editor — adopt or remove at M1.

### RD-M2 — Adopt **Puck** (MIT) as the visual editor foundation; do not adopt Craft.js
- Rejected Craft.js: MIT but ≈21 months without a push (maintenance risk).
- Rejected: building from scratch on @dnd-kit (already used) — slower, loses the JSON schema/tooling Puck provides.
- Rules: layout configs stored as **versioned, zod-validated JSON** (new `FolioLayout` model), widget whitelist, no arbitrary user JS in app origin, custom HTML only through a sanitized sandbox (iframe sandbox token pattern already proven by GIFTZ previews).

### RD-M3 — Evidence records as a first-class model (`Evidence` table + content hash + verification status)
- Rejected: stuffing evidence into `MediaAsset.customFields`; stringly-typed JSON blobs.
- Content hashing: `node:crypto` (no new dependency); storage refs reuse `buildStorageKey` (server-generated, owner-scoped).

### RD-M4 — Graph stored relationally, rendered with **React Flow (MIT)**
- Rejected: a graph database (neo4j etc.) — operations cost + SQLite/Postgres continuity; relational tables (`Contribution`, `EvidenceSupports`, `CollaboratorConfirmation`) are sufficient at this scale.
- Rejected: D3-from-scratch — xyflow gives interactive pan/zoom/minimap with MIT license.

### RD-M5 — W3C VC 2.0 data model + Open Badges 3.0 payloads; **no custom cryptography**
- Rejected: inventing a bespoke verification protocol (explicitly forbidden by the milestone).
- Library candidates (to evaluate at M5, license-gated): `@digitalcredentials/vc` (MIT), `@sdg/...` none — record final picks in OPEN_SOURCE_REGISTER.

### RD-M6 — Keep first-party search until scale forces an engine; then **Meilisearch core** (MIT, with documented BSL carve-out audit) or managed Meili
- Rejected: Typesense (GPL-3.0), OpenSearch (Apache but operationally disproportionate), Algolia (proprietary SaaS).
- Explainable ranking stays first-party (testable per the milestone's acceptance criteria).

### RD-M7 — Keep the in-house gateway; add **Opik (Apache-2.0)** for tracing/evals; add prompt-version columns
- Rejected: LiteLLM (Python sidecar mismatch; enterprise-licensed dir), Langfuse (acceptable but `ee/` boundaries need audit; Opik is license-cleaner).
- Rejected: llama_index as a default dependency — adopt only if heavy RAG becomes real; the existing grounded-context builder + honest-refusal posture is a better fit.

### RD-M8 — Passport export via first-party JSON/PDF (already has ExportJob + pdfkit/docx)
- Standards: W3C VC for credential payloads; no proprietary format invention.
- Rejected: new SaaS export vendors.

### RD-M9 — First-party analytics retained; Umami (MIT) only if attribution depth is required
- Rejected: Plausible (AGPL), PostHog self-host at current scale.

### RD-M10 — Rooms built on existing `Conversation`/`Message` + `AgentArtifact`-style scoped file grants + expiring invitation tokens
- Rejected: adopting a full collaboration suite (e.g. Liveblocks — proprietary); the messaging infrastructure is already permission-aware and tested.

### RD-M11 — Add CI first (GitHub Actions: lint + tsc + bun test + leak audit + upload-route sentinel), then security hardening passes
- Dependency scanning: `bun audit`/ Dependabot config (native, no license cost).

### RD-M12 — Entitlement model first-party + hosted billing provider; **Lago rejected (AGPL)**; Kill Bill (Apache-2.0) only if self-hosted billing is mandated
- The spec allows "use the existing payment integration if one already works" — none exists; recommend Stripe (or Razorpay for India) behind a provider adapter, with idempotent webhooks.

### RD-M13 — Public API + scoped API keys + webhook signatures built on the existing `handler()` + rate-limit infrastructure
- OAuth: authorization-code with PKCE reusing the OAuthFlow pattern; reject custom token formats (use JWTs sparingly, short-lived, revocable via key table).

### RD-M14 — i18n via `next-intl` (already declared, unused) + taxonomy translation tables
- Rejected: rebuilding a custom i18n layer.

## C. Rejected-technologies quick register (with reasons)

| Technology | Reason |
|---|---|
| NextAuth v4 | unused; custom auth is complete and tested; remove dependency |
| Typesense | GPL-3.0 — copyleft risk |
| Plausible self-host | AGPL-3.0 |
| Lago | AGPL-3.0 |
| Craft.js as M2 primary | maintenance stalled (last push 2025-02) |
| LiteLLM in-process | architecture mismatch (Python sidecar); enterprise-licensed directory |
| Neo4j / dedicated graph DB | operational cost not justified at current scale |
| OpenSearch | operationally disproportionate for current scale |
| Liveblocks / proprietary collab SaaS | vendor lock-in; existing messaging infra sufficient |
| Custom credential cryptography | explicitly forbidden by M5; use W3C VC + existing libs |
