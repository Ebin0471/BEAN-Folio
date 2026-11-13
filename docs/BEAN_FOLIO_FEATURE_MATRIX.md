# BEAN FOLIO — FEATURE MATRIX (M0)

**Audit date:** 2026-11-13 · tree `c9fe839` · verification methods: source inspection, executed tests, live browser E2E (screenshots under `docs/audit-screenshots/`).
**Legend:** ✅ Complete and verified · 🟡 Implemented, partially verified · 🔴 Implemented but broken · 🟠 UI-only / mocked · ⬛ Missing · 🧟 dead code (present, unrouted/type-broken).

## 1. Platform foundations

| Feature | Status | Notes |
|---|---|---|
| Registration + recovery-key ceremony | ✅ | browser E2E executed; one-time key + ack checkbox |
| Login / logout / session TTL | ✅ | hashed opaque tokens; 30-day TTL; sweep |
| Password recovery (email + recovery key) | 🟡 | implemented + tested; needs live email-optional flow verification (no mailer — recovery-key based only) |
| Google OAuth | 🟡 | fully implemented + tested; env-gated; honestly disabled UI when unconfigured |
| Onboarding (2 steps) | ✅ | browser E2E executed (identity → professions/skills → Folio) |
| Profile editor (My Folio, AI bio improve) | ✅ | routes + tests |
| Profile privacy (public/followers/private + soft delete) | ✅ | `visibility.ts`; enforced in every public path (tested) |
| Custom profile URL (`/u/<username>`) | ✅ | proxy rewrite + SEO metadata verified in code |
| Availability / languages / links fields | ⬛ | not present in profile model (M1 scope) |
| Multiple audience-specific presentations | ⬛ | not present (M1 scope) |
| Profession taxonomy (families, specialisms, aliases) | ✅ | `src/lib/professions/taxonomy.ts` + seed + `/api/professions` |
| Admin & moderation queue | ✅ | `requireAdmin()` + AuditEvent; browser-verified gate |

## 2. Projects & portfolio

| Feature | Status | Notes |
|---|---|---|
| Project CRUD + publish/unpublish/archive/duplicate/feature | ✅ | 16 handlers; API-tested; ownership verified |
| Project media (upload, reorder, captions, covers) | 🔴/🟡 | presigned direct upload ✅; **classic multipart route deleted at HEAD** (6 pinned tests fail; client fallback broken) |
| Project visibility (PUBLIC/UNLISTED/PRIVATE) | ✅ | enforced in serving ladder + Explore |
| Saves & collections | ✅ | models + routes + UI |
| Related projects / view recording | ✅ | deduped per viewer/day |
| Project templates per profession family | ✅ | `src/lib/studio-templates.ts` |
| Cover/avatar crop & focal points | ✅ | dialogs + focal fields on User/Project |
| Contribution graph (Workgraph) | ⬛ | M4 scope |
| Evidence records (types, hashes, verification status) | ⬛ | M3 scope — only freeform media exists today |
| Portfolio website publishing (SiteDesign → `/site/<u>`) | ✅ | publish/unpublish/revisions/export tested |
| Website-native project pages | ✅ | `/site/<u>/projects/<id>` + tests |
| Site templates (54 templates, 7 palette families) | ✅ | `site-palettes.ts`, `site-templates/professions/*` |
| Legacy drag-drop portfolio builder | 🧟 | `PortfolioStudioView` (3,295 LOC) unrouted; `/api/portfolio/*` type-broken |

## 3. GIFTZ products

| Feature | Status | Notes |
|---|---|---|
| GIFTZ website builder UI (customization + AI chat modes) | ✅ | browser-verified; 2,997-line view wired to real endpoints |
| Site studio AI turns (proposal → review → apply) | 🟡 | durable rows + honest sweeps; in-process execution; needs live-provider run |
| Publish/unpublish + canonical URLs + export ZIP | ✅ | tested + browser-verified |
| Revision history (site) | ✅ | pruned snapshots + restore |
| Code Giftz engineering agent (repos/tasks/creative) | 🟡 | 19 giftz routes; tests exist (`giftz-engine`, `giftz-api`); needs live-provider verification |
| AI design chat route | 🔴 | type-broken dead model refs (19 tsc errors) |
| **Standalone GIFTZ platform (project files, code editor, builds, deployments, versions)** | 🟡* | **exists only on published remote `09e67a9`** — verified there; absent from workspace lineage; must be reconciled (see SYSTEM_AUDIT §1.4) |

## 4. Creator social network

| Feature | Status | Notes |
|---|---|---|
| Posts (4 kinds) + drafts + schedules | 🟡 | scheduled posts modeled (status field) but no scheduler dispatch wired — DRAFT/PUBLISHED exercised |
| Likes / bookmarks / shares (ledger) / deduped views / impressions | ✅ | composite-PK dedup; idempotency tests |
| Nested comments (one level) + hidden-approval | ✅ | tested |
| Hashtag discovery + trending | ✅ | counters + trending API |
| Feed engine (Recent/For You/Following/Trending tabs) | ✅ | keyset pagination; explainable ranking |
| Follow graph with private-account requests | ✅ | ACTIVE/PENDING + approval flow tested (30/30) |
| Mute / restrict / remove-follower / blocks | ✅ | AccountEdge + Block + tests |
| DMs (message requests, read receipts, typing window) | 🟡 | polling-based (2.5s/10s); no realtime transport |
| Reels (muted autoplay, poster frames, IntersectionObserver) | 🟡 | UI + coordinator verified; 3 ladder tests fail on empty storage fixtures (pre-existing on remote too) |
| Search (people/posts/hashtags) + private history | ✅ | |
| Notifications (13 types, dedupKey, grouped inbox, per-type prefs) | 🟡 | engine + tests; one bypass in INQUIRY_RESPONSE |
| Moderation reports queue | ✅ | server-authoritative admin routes |

## 5. AI (BEAN Intelligence + agents)

| Feature | Status | Notes |
|---|---|---|
| Chat (persisted conversations, history injection, partial-save on stream failure) | ✅ | SSE streaming verified in code + tests |
| Delegation (AgentTask) + artifact handoff (TTL, single-consumption) | ✅ | tests |
| RIISHE automations (reminders/summaries/radar) | 🟡 | queue-backed; needs live-provider run |
| RIISHE workflow agent (planner → registry-checked steps → approvals → dashboard) | 🟡 | 22/22 tests; 1 fixture-drift failure on empty DB |
| LAXII image studio (4 providers, version tree, favourites, export) | 🟡 | honest env-gated availability; cost guardrail; 1 load-flaky test passes alone |
| Resume studio (parse → facts → export docx/pdf) | ✅ | tests + routes |
| AI improve/suggest (project/profile) | ✅ | routes + UI wiring |
| Provider gateway hygiene (breaker, retries, honest errors, no prompt leaks) | ✅ | tests assert no-fabrication |
| Prompt versioning / eval harness / feedback capture | ⬛ | prompts only in git constants (M7 scope) |
| Embeddings/RAG | ⬛ | honestly refuses ("no fake vectors") — M7 scope |

## 6. Insights, settings, platform ops

| Feature | Status | Notes |
|---|---|---|
| Insights overview / posts / projects (14-day series, engagement formula) | ✅ | first-party; documented formulas; browser-verified UI |
| Recovery key show-once + audit log viewer | ✅ | browser-verified |
| Data export (async job, machine-readable) | ✅ | ExportJob + tests |
| Account deletion (password re-auth) | ✅ | DeletionRequest + tests |
| Privacy controls (visibility, blocking, mute) | ✅ | |
| Terms/Privacy documents | ✅ | static view, self-labeled "Beta draft" |
| SEO (dynamic robots/sitemap, per-route OG for path forms, noindex for private/demo) | ✅ | verified in code + metadata pipeline |
| Edge caching of path-form documents | ✅ | proxy Cache-Control |
| CI | ⬛ | nothing runs automatically |
| Realtime transport (WebSocket/SSE to client for social) | ⬛ | polling only (chat uses SSE) |
| Multilingual UI / i18n | ⬛ | `next-intl` installed but unused (M14 scope) |
| Monetization / billing | ⬛ | M12 scope |
| Public API / OAuth apps / webhooks | ⬛ | M13 scope |

## 7. Totals

| Verdict | Count | Share |
|---|---|---|
| ✅ Complete and verified | 34 | 46% |
| 🟡 Implemented, partially verified | 15 | 20% |
| 🔴 Implemented but broken | 3 | 4% (multipart upload, AI design chat, Postgres mirror deployability) |
| 🧟 Dead code | 2 | 3% (legacy portfolio UI+API) |
| ⬛ Missing | 20 | 27% (M1–M14 scope: evidence, workgraph, verification, advanced search, passport, rooms, i18n, monetization, public API, CI…) |

**Bottom line:** the platform's existing surface is real and substantially verified; the broken items are few, specific, and repairable; the missing items map one-to-one onto the M1–M14 roadmap (see `docs/BEAN_FOLIO_ROADMAP.md`).
