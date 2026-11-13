# BEAN FOLIO — ROADMAP M1 → M14 (M0 output)

**Audit date:** 2026-11-13 · baseline tree `c9fe839` (+ published remote `09e67a9` carrying the GIFTZ platform).
**Basis:** every milestone is mapped to the components, models, and routes that actually exist today (verified in `docs/BEAN_FOLIO_SYSTEM_AUDIT.md` and `docs/BEAN_FOLIO_FEATURE_MATRIX.md`).

## 0. Gate tasks (before M1 — "M0.5", ~2–4 days)

These are not features; they are prerequisites uncovered by this audit. Skipping them makes every later milestone riskier.

| # | Task | Rationale (evidence) | Size |
|---|---|---|---|
| G1 | **Restore `POST /api/media/upload/route.ts`** (verbatim from history) or remove the client fallback + pin tests | uploads broken on local-disk deployments; 6 pinned tests fail; `ensure-dev.sh` sentinel FATALs; 5th recurrence | S |
| G2 | **Add CI** (GitHub Actions): lint + `bunx tsc --noEmit` + `bun test` (3 shards) + `publish-github-clean.sh` leak audit + upload-route sentinel | no `.github/` exists; this is how G1 shipped 5 times | S |
| G3 | **Reconcile workspace lineage with published remote** (fast-forward 3-way tree merge on tree-base `1b9c65f`) so the GIFTZ platform (remote `09e67a9`) returns to the workspace | GIFTZ platform exists only on the remote; pushing the workspace as-is would destroy it on GitHub; any further local work risks a 3-way divergence | M |
| G4 | Re-sync `prisma/schema.postgres.prisma` (+ fix `scripts/check-schema-parity.ts:19`) | Vercel deploy generates a client missing 25 models | M |
| G5 | Delete/quarantine the dead portfolio subsystem (`/api/portfolio/*`, `portfolio-server.ts`, `ai/design/chat`, orphaned views) + remove unused deps (`next-auth`, `@mdxeditor`, unused @tanstack if not adopted) | 36 of 118 tsc errors; 4,788 LOC dead UI | M |
| G6 | Seed discipline: run `seed.ts` + `restore-qa-fixtures.ts` in dev bootstrap; document in `ensure-dev.sh` | 7 of 14 baseline test failures are empty-DB drift | S |

**Recommended order: G2 → G1 → G3 → G4 → G5 → G6** (CI first so the fix stays fixed; then lineage reconciliation before any feature forks the tree again).

## 1. Milestone dependency graph

```
M1 Universal Identity ──► M2 Create Studio 2.0 ──► M7 Intelligence (portfolio features)
        │                        │
        │                        ▼
        │                 M3 Proof of Work ──► M4 Workgraph ──► M5 Trust & Verification
        │                        │                                     │
        ▼                        ▼                                     ▼
   M6 Discover & Search ◄── (skills/evidence/professions feed ranking)  M8 Folio Passport
                                       │
        M9 Insights ──► M10 Rooms ──► M11 Accessibility/Security/Perf (cross-cutting, runs after M2/M3)
                                                       │
                                        M12 Monetization ──► M13 Ecosystem & API ──► M14 Growth
```
Sequencing logic: identity data model feeds everything; studio consumes identity; evidence consumes projects; workgraph consumes evidence; verification consumes workgraph; search indexes all of it; passport exports verified records; monetization gates advanced editor/analytics; API exposes verified data only.

## 2. Milestone plan (repository-specific)

### M1 — Universal Professional Identity
- **Existing surfaces reused:** `User`, `ProfileProfession`, `ProfileSkill`, `Profession/Family/Specialism`, `FolioView.tsx`, `/api/me/profile`, `OnboardingView`, profession taxonomy seed.
- **Add:** profile metadata JSON (zod per-family), availability/languages/links/education-career fields, section-visibility controls, custom `slug` (already have username — add vanity alias table), presentation variants (`ProfilePresentation` rows referencing shared data).
- **UI:** rebuild `FolioView` editor with live preview + completeness indicator + reordering (reuses `@dnd-kit`).
- **Deps:** none new (adopt-or-remove react-hook-form decision).
- **Risks:** public-API leakage of private fields (mitigate: response-shaping tests like existing privacy tests); migration compatibility for existing users (additive columns only).
- **Estimate:** M (1–2 wks).

### M2 — BEAN Create Studio 2.0
- **Existing:** `SiteDesign`, `SiteRevision`, `SiteRenderer`, template/palette systems, `publish/unpublish/export` routes, `SiteStudioSession` AI turns, edge-cached `/site/*`.
- **Add:** adopt **Puck** (MIT) as editor core; widget registry (18 widgets from spec) compiled to the existing `SiteRenderer` config JSON; versioned layout model with zod; undo/redo (Puck-native); autosave conflict handling (revision tokens); sandboxed custom-HTML widget.
- **Risks:** SiteRenderer compatibility with Puck's data model (adapter layer); keeping published sites serving while editor changes (config versioning + forward-compatible reader); XSS via custom HTML (sandbox iframe, no same-origin).
- **Estimate:** L (3–4 wks).

### M3 — BEAN Proof of Work
- **Existing:** `Project`, `ProjectMedia`, `Contributor`, upload pipeline (presigned direct), `AuditEvent`, privacy machinery.
- **Add:** `Evidence` model (type/source/hash/verification-status/privacy/retention), evidence workspace UI inside `ProjectDetailView`, sharing grants (viewer tokens), redaction support.
- **Risks:** private evidence leaking through public ladders (extend the media ladder tests); hash computation on large files (hash at upload time in the direct-complete path).
- **Estimate:** L (2–3 wks).

### M4 — BEAN Workgraph
- **Existing:** `Contributor`, projects/skills joins, evidence (M3), visibility rules.
- **Add:** relational graph tables (Contribution, EvidenceSupports, CollaboratorConfirmation, Outcome, Credential), graph API (permission-filtered), React Flow visualization (MIT), dispute flow, export.
- **Rules encoded:** no activity-count percentages; no auto-ownership; private collaborators hidden; visualization generated only from authorized records.
- **Risks:** N+1 queries on graph assembly (batched includes); attribution disputes touching verified records (audit everything).
- **Estimate:** M–L (2–3 wks).

### M5 — BEAN Trust & Verification
- **Existing:** `AuditEvent`, notification engine, `Follow` approval pattern (PENDING/ACTIVE), rate limits.
- **Add:** verification levels (self/evidence/collaborator/source/independent), `VerificationRequest` + `Credential` models (W3C VC 2.0 data model, Open Badges 3.0 payload compatibility), issuer registry, revocation lists, disputes/appeals, signed records via existing libs (no custom crypto).
- **Risks:** "source verified" claims (never claim institutional verification without the issuer actually validating); key management (server-held signing keys, rotated; never client-side).
- **Estimate:** L (3 wks).

### M6 — BEAN Discover & Search
- **Existing:** `/api/discover/*`, `/api/search/*` (permission-aware), feed ranking, `SearchQuery` history.
- **Add:** multi-entity indexing (people/projects/skills/professions/organizations/collections), faceted filters, explainable ranking (already a stated codebase value — formalize factors into a testable scorer), new-member fairness boost, labeled paid placement hooks (no opaque score).
- **Decision:** stay first-party until scale; Meilisearch core (MIT; BSL carve-out documented) as the upgrade path — see ARCHITECTURE_DECISIONS RD-M6.
- **Risks:** index staleness vs. privacy changes (reindex on visibility transitions); private-profile leakage (permission-aware query layer is already tested — reuse).
- **Estimate:** M (2 wks).

### M7 — BEAN Intelligence (portfolio assistant)
- **Existing:** gateway (registry/breaker/SSE), `AiUsage` quotas, conversation persistence, `context.ts` grounded builder, delegation.
- **Add:** the 10 portfolio capabilities (draft generation, description improvement, evidence-gap suggestions, completeness analysis, audience presentations), prompt-version columns + versioned prompt registry, Opik (Apache-2.0) tracing/eval harness, user-feedback capture, fabrication test suite (known records vs. fabricated-claim cases), structured-output validation.
- **Truth rules encoded:** never invent outcomes/clients/degrees; gaps surfaced as questions; nothing auto-publishes; private content gated by explicit permission.
- **Risks:** provider cost drift (daily caps already exist — extend per-feature budgets); eval flakiness (pin eval sets).
- **Estimate:** L (3–4 wks).

### M8 — Folio Passport
- **Existing:** `/api/me/export` (ExportJob async, machine-readable), `download` route, export rate limits, deletion workflows.
- **Add:** profile/projects/evidence/credentials/history export bundles, PDF portfolio generator (pdfkit already present), original-file retrieval links (expiring, signed), selective sharing + revocation, export audit trail, import (portfolio JSON; VC/OB credential import).
- **Risks:** exports containing third-party private info (filter collaborators' private fields); expiring links (reuse presign TTL pattern).
- **Estimate:** M (1.5–2 wks).

### M9 — BEAN Insights
- **Existing:** first-party deduped analytics, engagement formula, Insights UI with recharts.
- **Add:** traffic sources/referrers, device categories, geography at coarse aggregation, version-performance comparison, consent-aware opt-out, aggregate-small-audience guards, API protection (rate limits exist).
- **Decision:** first-party stays; Umami (MIT) optional for attribution depth.
- **Risks:** privacy creep (document counting methods; aggregate < k viewers).
- **Estimate:** M (1.5 wks).

### M10 — BEAN Rooms
- **Existing:** `Conversation`/`Message` (requests, read receipts), `MediaAsset` sharing ladder, notification engine, inquiry flow (approval state machine precedent), expiring-token precedent (presign, OAuthFlow).
- **Add:** client invitations (expiring, revocable guest tokens), private rooms with milestone/checklist state, threaded feedback + approval history, scoped file grants, activity timeline.
- **Risks:** cross-room access (owner-scoped queries everywhere — follow the existing `findFirst({id, userId})` discipline); guest access revocation must invalidate tokens immediately.
- **Estimate:** M–L (2–3 wks).

### M11 — Accessibility, Security & Performance (cross-cutting)
- **Existing:** strong aria coverage, reduced-motion support, security headers, rate limits, upload validation, audit logging.
- **Add (from audit findings):** skip-to-content link, route-change focus management, keyboard parity for editor canvases, nonce-based CSP (with preview-surface exemptions), CSRF origin checks as defense-in-depth, dependency scanning (`bun audit` + Dependabot), malware-scan hook where feasible, signed file access, pagination/caching audits, DB index review, background-processing migration of in-process agent jobs to the durable queue.
- **Risks:** CSP breaking embeds (staged rollout with report-only mode); perf work regressing the honest-analytics dedup (test-locked).
- **Estimate:** M (2 wks, spread after M2/M3 land).

### M12 — BEAN Monetization
- **Existing:** rate limits + `AiUsage`/`LaxiiUsage` meters (usage metering primitives), honest-cost culture.
- **Add:** `Subscription`/`Entitlement` state machine, billing provider adapter (Stripe/Razorpay; no existing integration), webhook idempotency (dedupeKey pattern), invoice history, grace periods, entitlement enforcement server-side (editor limits, custom domains, AI credits), labeled-promotion only.
- **Hard rules:** never charge for truthful verification; never sell ranking; sandbox-first, explicit approval before live payments.
- **Risks:** entitlement bypass through client-side gating (server enforcement tests); webhook replay (idempotency keys).
- **Estimate:** L (3 wks).

### M13 — BEAN Ecosystem & API
- **Existing:** `handler()` standardization, request IDs, rate limits, OAuth-flow machinery (PKCE precedent), audit events.
- **Add:** public portfolio API (read-only, privacy-respecting), authorized private API via OAuth2 (authorization-code + PKCE, reusing OAuthFlow), scoped API keys (hashed, like session tokens), webhook delivery with HMAC signatures + retry via the durable queue, GitHub/GitLab/Behance-style import adapters, versioned API surface (`/v1`), developer docs.
- **Risks:** scope creep of tokens (least-privilege scopes; rotation; revocation lists); abuse (per-key rate limits already have the hashed-bucket backend).
- **Estimate:** L (3 wks).

### M14 — Growth & Global Expansion
- **Existing:** taxonomy tables, `next-intl` (unused — adopt), timezone primitives in date-fns, profession families covering the three launch communities.
- **Add:** multilingual profiles (locale rows), localized templates, regional privacy controls, international custom domains, founding-professional programme (labeled), organization onboarding.
- **Sequencing:** creators/media → developers → independent services (per spec).
- **Risks:** translation drift in taxonomy (source-of-truth JSON with CI validation); custom-domain abuse (verification like existing DNS-verify pattern in GIFTZ domains).
- **Estimate:** M (2 wks).

## 3. Cross-milestone risk register (top 10)

1. Lineage divergence between workspace and GitHub (mitigate: G3 reconciliation + CI + never force-push).
2. Upload route deletion recurrence (G1 + CI sentinel).
3. Postgres mirror drift breaking deploys (G4 + parity gate in CI).
4. Privacy regressions as public surfaces grow (permission-aware tests per milestone — the codebase already does this; keep the discipline).
5. Puck↔SiteRenderer data-model mismatch (adapter + forward-compatible reader + published-site snapshot immutability).
6. Evidence privacy leaks via media ladder (extend ladder tests with evidence branches).
7. AI fabrication (fabrication test suite is an M7 gate — milestone blocked until it passes).
8. Billing webhook replay/idempotency bugs (dedupeKey pattern + sandbox gate).
9. API abuse (per-key limits + audit + anomaly alerts).
10. i18n taxonomy drift (CI-validated translation completeness).

## 4. Recommended execution order (with rationale)

**G2 → G1 → G3 → G4 → G5 → G6 → M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8 → M9 → M10 → M11 → M12 → M13 → M14**

Rationale: the gate tasks de-risk everything; M1 unblocks M2/M6; M2 produces the surface M7 assists; M3 evidence feeds M4 workgraph feeds M5 verification; M6 search can land any time after M3 but benefits from richer data; M7/M8/M9 are largely independent and can parallelize with M10 under separate workstreams once M5 stabilizes credential semantics; M11 runs after the two biggest UI milestones; M12/M13 monetize and expose the now-stable platform; M14 scales it.

Sequenced strictly and executed at the current velocity, the plan is roughly **6–9 months** of single-engineer-equivalent work, with M1–M5 being the proof-of-work core that differentiates the product.
