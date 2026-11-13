# BEAN FOLIO — SYSTEM AUDIT (M0)

**Audit date:** 2026-11-13
**Audited tree:** local `main` @ `c9fe839` ("test(riishe): typed tool invocation in agent tests (registry erasure boundary)"), working tree clean at audit start.
**Method:** read-only source inspection (three parallel deep audits: backend, frontend, data/AI), live database queries (read-only), executed baseline tests, and browser verification of 15 routes with 20 screenshots. Every "verified" claim in this document corresponds to an executed check; anything not executed is labeled as such.
**No production code, data, routes, or integrations were modified during this audit.** The only files created are the audit documents in `docs/` and screenshots in `docs/audit-screenshots/`.

---

## 1. Executive summary

BEAN Folio is a **genuinely engineered platform**, not a facade. Authentication, authorization, rate limiting, a durable background-job queue, a provider-gateway AI layer, a storage abstraction with private/public serving ladders, first-party analytics, and a notification engine are all really implemented and tested. No fabricated responses, hidden mock layers, or placeholder-data arrays were found anywhere in the shipped frontend or API surface.

The platform is a **hash-router SPA on one Next.js document** (`src/app/page.tsx`) with ~181 API route files (250 handlers), **76 Prisma models** (all present in the live SQLite DB), **28 view files (~20.8k LOC)**, 48 shadcn primitives, 52 custom BEAN components, and 54 test files (835 tests).

Five defects dominate the risk profile, in order:

1. **`POST /api/media/upload` is missing at HEAD** — deleted by commit `c9fe839`; the client (`src/lib/client.ts:139`) still falls back to it; 6 live-HTTP tests pin the breakage; `scripts/ops/ensure-dev.sh` sentinel FATALs. This is the 5th documented recurrence of this deletion (worklog.md:462/795/977/1004/1310).
2. **The production Postgres schema mirror has drifted** — `prisma/schema.postgres.prisma` (used by `vercel-build`) is missing 25 models (the entire social-feed and RIISHE layers). A Vercel deploy would generate a client without them and break at build/runtime. The parity-check script that should catch this is itself syntax-broken (`scripts/check-schema-parity.ts:19`).
3. **No CI exists** — there is no `.github/` directory; nothing runs lint/tests/typecheck automatically. This is precisely how defect #1 shipped.
4. **Repository lineage divergence (workspace vs. published remote):** the standalone GIFTZ website-creation platform (project files, code editor, builds, deployments, versions — published to GitHub as `09e67a9` on 2026-11-13) is **absent from the local workspace lineage**. The workspace was rebuilt after a sandbox recycle and later commits (recomposed social/RIISHE history + `4c06429`, `c9fe839`) do not include it. The GIFTZ platform exists **only on the published remote** and must be reconciled back at the next publish (fast-forward 3-way tree merge — do not force-push, do not re-push the workspace tree as-is or the published platform is destroyed on GitHub).
5. **Dead portfolio subsystem** — `src/app/api/portfolio/*` (6 routes), `src/lib/portfolio-server.ts`, `src/app/api/ai/design/chat/route.ts` reference Prisma models (`portfolio`, `portfolioRevision`, `designChatMessage`) that exist in **neither schema nor the generated client** — type-broken dead code behind a UI that is no longer routed.

---

## 2. Architecture diagram

```
                        Browser (SPA document, hash-router)
                                      │
                    ┌─────────────────┴───────────────────┐
                    │  SiteShell (src/components/bean)     │
                    │  Header / MobileNav / Router / Footer│
                    │  28 views · SessionContext · sonner  │
                    └─────────────────┬───────────────────┘
                                      │ fetch (same-origin, credentials include)
┌─────────────────────────────────────┴────────────────────────────────────────┐
│ Next.js 16 (App Router, single page.tsx + route handlers)                    │
│  src/proxy.ts — rewrites /u/* /p/* /site/* /post/* → SPA doc (boot-route hdr)│
│                                                                              │
│  API layer: 181 route files / 250 handlers, 249 wrapped in handler():        │
│   zod parseBody (1MB budget) → auth (getSessionUser) → ownership checks      │
│   → rate limits (~70 enforcement points) → business logic → ok()/ERR        │
│                                                                              │
│  Services:                                                                   │
│   auth.ts (scrypt, hashed session tokens)  ai.ts → intelligence gateway      │
│   notify.ts (dedupKey engine)              registry/circuit/observability    │
│   media.ts (magic bytes, caps)             queue/ (BackgroundJob = queue)    │
│   storage.ts (local | S3, Range)           visibility.ts (demo/private)      │
│   feed.ts / social.ts / search libs        riishe/* (planner, tools, engine) │
│   ai-design/* (Code Giftz pipeline)        site-studio/turn.ts               │
│   giftz/* (creative/tasks/repositories)    laxii/* (4 image providers)       │
│   rate-limit-backend.ts (memory|postgres)  admin.ts (requireAdmin + audit)   │
│   startup-validation.ts (fail-fast)        insights endpoints (first-party)  │
└──────────────┬──────────────────────────────┬───────────────┬───────────────┘
               │ Prisma                       │               │
     ┌─────────┴─────────┐        ┌───────────┴──────┐  ┌─────┴───────────┐
     │ SQLite db/custom.db│        │ uploads/ (local) │  │ z-ai-web-dev-sdk│
     │ 76 models (db push)│        │ or S3 (presign)  │  │ + Gemini/OpenAI │
     └───────────────────┘        └──────────────────┘  │ + diffusers opt │
                                                        └─────────────────┘
  Ops (manual): scripts/ops/{publish-github-clean.sh, gh-*.sh, backup-db.ts,
  restore-db.ts, backup-media.ts, ensure-dev.sh, smoke-social.sh, queue-drain.ts}
  CI: none. Deploy: package.json vercel-build → Vercel (schema.postgres).
```

---

## 3. Stack and structure

| Layer | Technology | Notes |
|---|---|---|
| Framework | Next.js 16, React 19, App Router | single page + route handlers; `force-dynamic` document |
| Runtime / pkg | Bun | `bun test`, `bun run dev`, `vercel-build` script |
| Styling | Tailwind CSS 4 (CSS-first tokens in `globals.css`) | `tailwind.config.ts` is vestigial — Tailwind 4 never loads it |
| UI kit | shadcn/ui new-york (48 primitives) + Radix | 23 ui primitives currently unused |
| Data | Prisma 6.11 + SQLite (`db/custom.db`, `db push`, no migrations dir) | Postgres mirror `prisma/schema.postgres.prisma` for prod (drifted) |
| Auth | custom (scrypt + hashed opaque session tokens; Google OIDC PKCE) | `next-auth` declared but **zero imports** |
| AI | `z-ai-web-dev-sdk` managed gateway + direct Gemini/OpenAI/diffusers for LAXII | capability registry, circuit breaker, SSE streaming |
| State | plain hooks + `SessionContext`; Zustand used in exactly 1 file (feed-video coordinator) | `@tanstack/react-query`, `react-hook-form` declared but unused |
| Testing | `bun test`, 54 files / 835 tests | no CI enforcement |
| Deploy | Vercel (`vercel-build`) — no Dockerfile, no workflows | publish to GitHub via audited snapshot script |

---

## 4. API inventory (summary)

**181 route files under `src/app/api/**`, 250 exported handlers.** 249 use the `handler()` wrapper (request IDs via `AsyncLocalStorage`, zod body parsing with byte budgets, 413/500 mapping, `Retry-After` on 429); 1 raw export (`GET /api/origin-proof`).

| Domain | Files | Handlers | Domain | Files | Handlers |
|---|---|---|---|---|---|
| auth | 9 | 9 | media | 5 | 6 |
| ai | 13 | 15 | me (self-scoped) | 35 | 55 |
| discover | 4 | 4 | collections | 2 | 4 |
| feed | 1 | 1 | posts | 11 | 20 |
| giftz | 19 | 25 | profiles | 6 | 8 |
| hashtags | 2 | 2 | professions | 2 | 2 |
| inquiries | 2 | 2 | portfolio (dead) | 7 | 8 |
| intelligence | 5 | 6 | projects | 12 | 16 |
| laxii | 21 | 30 | reports | 1 | 1 |
| admin | 2 | 3 | riishe | 12 | 22 |
| search | 5 | 5 | site | 1 | 1 |
| root/ops (health, ready, origin-proof) | 4 | 4 | | | |

Non-API document routes: `robots.txt` and `sitemap.xml` (dynamic, generated from public non-demo content). The full route-by-route listing is recorded in `docs/BEAN_UI_SCREEN_INVENTORY.md` (API side) and was extracted verbatim during this audit.

---

## 5. Data model inventory

**76 models** in `prisma/schema.prisma` (SQLite, no enums — statuses are validated strings; JSON-string columns; composite-PK dedup on all join tables). Domain groups:

- **Identity & auth (10):** User, Session, PasswordResetToken, OAuthFlow, GoogleLink, Profession, ProfessionFamily, Specialism, ProfileProfession, Skill + ProfileSkill
- **Media & projects (8):** MediaAsset, Project, ProjectSkill, ProjectMedia, Contributor, SavedProject, Collection, CollectionItem
- **Social & moderation (9):** Follow (ACTIVE/PENDING), Block, AccountEdge, Report, Inquiry, Notification (dedupKey unique), NotificationSetting, SearchQuery, AuditEvent
- **Feed / Discover (16):** Post, PostMedia, PostLike, PostBookmark, PostCommentLike, PostComment, PostHidden, PostShareEvent, PostImpressionDay, Hashtag, PostHashtag, PostView, Conversation, ConversationParticipant, Message
- **Analytics (2):** ProjectView, ProfileView (per-viewerKey-per-day dedup)
- **AI / agents (12):** AiConversation, AiMessage, AiUsage, LaxiiConversation, LaxiiMessage, LaxiiImageVersion, LaxiiUsage, LaxiiResume, AgentTask, AgentArtifact, GiftzRepository (+ shared)
- **Website builders (7):** SiteDesign, SiteMaterial, SiteRevision, SiteStudioSession, SiteStudioMessage, GiftzSite, GiftzSiteRevision
- **Ops (7):** ExportJob, DeletionRequest, BackgroundJob (the durable queue), RateLimitBucket, CacheEntry, CacheGeneration
- **RIISHE (6):** RiisheAutomation, RiisheAutomationRun, RiisheContactNote, RiisheWorkflow, RiisheWorkflowStep, RiisheCreatorShortlist, RiisheUserPreference

**Usage cross-check:** every one of the 76 models has ≥1 code reference. The reverse direction is broken: code references 3 models that do not exist (`portfolio`, `portfolioRevision`, `designChatMessage`) — see §1 defect 5.

**Live DB reality (read-only queries):** at audit start every table had **0 rows** except `BackgroundJob` (11 rows: 3 recurring system sweeps — `maintenance.sweep`, `site.studio-sweep`, `riishe.workflow.sweep` — proving the queue worker runs). Running the baseline test suite created transient fixtures (test accounts/posts), including residue such as a test hashtag. There is **no persistent user data in this sandbox**.

---

## 6. Subsystem classification (the honest verdicts)

Legend: **CV** = complete and verified (executed evidence); **PV** = implemented but partially verified; **B** = implemented but broken; **UI** = UI-only/mocked; **M** = missing.

| Subsystem | Verdict | Evidence |
|---|---|---|
| Password auth (scrypt, timing-safe) | **CV** | `src/lib/auth.ts`; verified by register + login E2E in browser during this audit |
| Sessions (hashed tokens, TTL, revocation) | **CV** | `src/lib/auth.ts:48-122`; sweep prunes expired rows |
| Google OIDC (PKCE, JWKS, link grants) | **PV** | fully implemented + tested (`tests/google-oauth.test.ts`); **disabled in this environment** (no env keys) — UI honestly disables the button (browser-verified) |
| Recovery flow (email+recovery key, single-use tokens) | **CV** | browser-verified recovery-key ack modal; `tests/security-hardening.test.ts` |
| Registration → onboarding E2E | **CV** | executed in browser during this audit (account + 2-step onboarding + Folio landing) |
| Rate limiting (~70 points, memory/postgres backends, hashed keys, Retry-After) | **CV** | `src/lib/rate-limit-backend.ts`, `src/lib/api-helpers.ts:112-154` |
| Durable queue (claim/heartbeat/backoff/dead-letter/recurring) | **CV** | worker observed running live in dev.log; `tests/queue-reliability.test.ts` |
| LAXII + studio-turn execution | **PV** | durable rows + honest failure sweeps, but executed **in-process** (`void` async), not queue-executed; crash mid-run is repaired-to-FAILED, not resumed |
| Notifications engine + grouped inbox | **PV** | `src/lib/notify.ts` engine with dedupKey/mutes/preferences; one bypass found (`PATCH /api/inquiries/[id]:67` writes raw `db.notification.create`) |
| Upload pipeline (presigned direct: PENDING→READY, magic bytes, cleanup) | **CV** | `src/lib/media.ts:338` + `tests/media-direct.test.ts` |
| Classic multipart upload route | **B (critical)** | `src/app/api/media/upload/route.ts` deleted at HEAD `c9fe839`; client fallback still targets it; 6 tests fail; `ensure-dev.sh` sentinel FATALs |
| Media serving ladder (6-branch authz, Range, cache classes) | **PV** | code-inspected + 3 failing ladder tests caused by empty-storage fixtures (fail identically on the published remote tree — environmental, not code) |
| Media processing (thumbnails/transcoding/posters) | **M** | no thumbnail/transcode handler exists; `media.thumbnails` referenced in a schema comment but never registered |
| Storage abstraction (local | S3, presigned PUT, traversal guard) | **CV** | `src/lib/storage.ts`; `tests/storage.test.ts` |
| AI gateway (text/vision/code: registry, breaker, retries, SSE, observability) | **CV** | `src/lib/intelligence/*` (1,953 LOC); `tests/intelligence-gateway.test.ts`; zero mocks found (anti-fabrication assertions in tests) |
| AI image (LAXII: managed/gemini/openai/diffusers, cost guardrail) | **PV** | 4 providers with honest env-gated availability; daily cost cap `INTELLIGENCE_DAILY_COST_LIMIT_USD`; needs live-provider verification |
| RIISHE automation agent (planner, tool registry, workflow engine, approvals, dashboard) | **PV** | `src/lib/riishe/*`; `tests/riishe-agent.test.ts` 22/22; 1 test fails on empty-DB fixtures; execution is queue-backed |
| Code Giftz design pipeline (`/api/ai/design/*`) | **B (type-level)** | 19 tsc errors; references dead `designChatMessage` model; superseded by SiteStudio |
| Portfolio editor (Studio/ProjectEditor/Folio) | **CV** | full CRUD exercised via API tests + browser (project creation flow, templates, AI improve) |
| Legacy portfolio builder (`PortfolioStudioView` + `/api/portfolio/*`) | **UI/dead** | unrouted views + type-broken routes (dead `portfolio` model refs) |
| GIFTZ website builder (`/giftz`, SiteStudio sessions/turns, publish, revisions, export) | **PV** | browser-verified UI fully wired; publish/export tested (`tests/site-export.test.ts`, `tests/standalone-site.test.ts`) |
| **Standalone GIFTZ platform (per-project files, code editor, builds, deployments, versions)** | **present only on published remote** | commit `09e67a9` on GitHub main; **absent from workspace lineage** — see §1 defect 4; do not classify as active until reconciled |
| Creator social feed (posts, reels, deduped views/impressions) | **CV** | `tests/discover-social.test.ts`, `tests/feed-video-autoplay.test.ts` (15/18 — 3 storage-fixture failures pre-existing on published remote too) |
| Social network (follow graph with PENDING requests, mute/restrict, DMs w/ requests + typing, moderation reports) | **CV** | `tests/social-network.test.ts` 30/30 |
| Search (unified all/posts/projects/profiles/suggest + private history) | **CV** | `tests/*` cover endpoints; browser-verified UI |
| Analytics (first-party deduped views, impressions buckets, engagement formula) | **CV** | `src/app/api/me/insights/*`; documented formulas; zero external SDKs |
| Data export / deletion workflows | **CV** | `ExportJob` + `DeletionRequest` models + routes; password re-auth enforced on deletion |
| Admin & moderation | **CV** | `requireAdmin()`, 403-indistinguishable, `AuditEvent` trail |
| CI | **M** | no `.github/` directory at all |
| Deploy pipeline | **PV (manual)** | `vercel-build` script + audited `publish-github-clean.sh`; no automated CD |
| Observability (structured JSON logs, request IDs, error webhook) | **CV** | `src/lib/monitoring.ts` (optional webhook), `api-helpers` logging |

---

## 7. Security findings

**Genuine strengths (verified):**
- scrypt password hashing with per-user salts and timing-safe compare; session tokens stored **hashed** (SHA-256); recovery reset revokes all sessions atomically.
- Google OAuth: server-side PKCE + single-use `state`/`nonce` hashes in DB; RS256 ID-token verification against Google JWKS; no silent account takeover (single-use link grant consumed at next password login).
- Rate limiting with hashed keys, rightmost-XFF IP extraction, poisoned-resistant recovery limiter, `Retry-After` semantics.
- Upload validation: client MIME never trusted — magic-byte sniffing + size caps per kind (IMAGE 8MB / VIDEO 64MB / AUDIO 20MB / AUDIO 20MB / DOCUMENT 10MB); PENDING→READY re-validation with fail-cleanup.
- Media serving: explicit multi-branch authorization ladder; private/demo/soft-deleted content excluded; documents served `attachment`; IDOR guard on published-config media refs (owner equality checked server-side).
- Input validation via zod everywhere with byte budgets (413 on overflow); Prisma parameterized exclusively (no injection surface); path-traversal guard on local storage resolution; fail-fast startup env validation that never logs secret values.
- Response hygiene: generic 500 without internals; 404-vs-403 indistinguishability in several routes; `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP headers; HSTS prod-only; audit trail on auth/deletion/moderation.

**Gaps and risks (documented, prioritized):**
1. **No CSP / X-Frame-Options** — deliberate trade-off (same-origin studio preview iframes; `docs/SECURITY_NOTES.md §2`). Risk accepted but should be revisited with nonce-based CSP for the SPA document.
2. **No CSRF tokens** — posture relies on SameSite=Lax + JSON-only bodies + same-origin fetch. Documented; acceptable for now, but add origin checking on state-changing handlers as defense-in-depth.
3. **Rate-limit backend defaults to per-instance memory** — a multi-instance deployment loses shared limits unless `RATE_LIMIT_BACKEND=postgres` is set (shared implementation exists and is tested).
4. **5 env vars referenced in code are undocumented** in `.env.example` (`ERROR_WEBHOOK_URL`, `CODE_GIFTZ_WORKSPACE_ROOT`, `LAXII_BANNER_MAX_ATTEMPTS`, `LAXII_AI_VISUAL_REVIEW`, `LOG_LEVEL`).
5. **No dependency scanning / malware scanning** (M11 scope).
6. **`aiConsent` user field is vestigial** — the consent toggle was removed from the product but the column gates nothing now.
7. **In-process agent execution** (LAXII jobs, studio turns) loses in-flight work on restart (repaired to FAILED by sweeps — honest, but not durable execution).

---

## 8. Baseline test results (exact, executed 2026-11-13 on tree `c9fe839`)

**Lint** (`bun run lint`): **0 errors, 13 warnings** (all pre-existing: unused eslint-disable directives in `PostMediaView.tsx`, `VideoCard.tsx`, `PostDetailView.tsx`).

**TypeScript** (`bunx tsc --noEmit`): **118 errors**, none in views/components; breakdown:
| File | Errors |
|---|---|
| tests/design-jobs-durable.test.ts | 42 |
| tests/riishe-automation.test.ts | 13 |
| src/app/api/ai/design/chat/route.ts | 11 |
| src/lib/ai-design/driver.ts | 8 |
| src/app/api/portfolio/publish/route.ts | 5 |
| scripts/migrate-cover-focal.ts | 5 |
| tests/social-network.test.ts | 3 (extra-arg calls to 1-param handlers; harmless at runtime, pre-existing) |
| src/lib/portfolio-server.ts | 3 |
| scripts/tmp/* (6 scripts) | 12 |
| src/app/api/portfolio/* (4 routes) | 6 |
| 4 misc (site/[slug], turns retry, 2 test files) | 4 |
The `src/` errors (36 total) are all in the dead portfolio/design-chat subsystem (defect 5) or 1-off route typing; the test errors are fixture/typing drift in known files.

**Tests** (`bun test`, 54 files, run in 3 sequential chunks — parallel runs OOM in this sandbox):
- Chunk 1 (18 files): 308 tests — **302 pass / 6 fail**
  - `auth.test.ts` ×2: demo/QA fixture accounts absent (DB reset — no seed data in sandbox)
  - `feed-video-autoplay.test.ts` ×3: media delivery ladder 404s (storage fixtures; identical failures on the published remote tree — environmental)
  - 1 failure not reproducible when files run in isolation (cross-file interference; flaky)
- Chunk 2 (12 files): 149 tests — **142 pass / 7 fail**
  - `media-upload-http.test.ts` ×6: **the upload-route 405 pin — real production defect** (route deleted at HEAD)
  - `laxii-banner-phase3.test.ts` ×1: 5s timeout under chunk load; **passes alone**
- Chunk 3 (24 files): 378 tests — **377 pass / 1 fail**
  - `riishe-automation.test.ts` ×1: "creator discovery" needs seeded users (empty DB)

**Total: 835 tests, 821 pass, 14 fail (98.3%).** Of the 14: **6 are a genuine production defect** (upload route), **7 are empty-DB fixture drift** (fix: run `bun scripts/seed.ts` + `restore-qa-fixtures.ts`), **2 are load flakes that pass in isolation** (laxii-banner; combined-run interference).

---

## 9. Regression risks (ranked)

1. **Upload route deletion is a recurring accident** (5th occurrence). The repo has a documented sentinel (`ensure-dev.sh`), a pinned test (`media-upload-http`), and prior restoration commits — yet `c9fe839` deleted it again. Root cause: snapshot-amendment/sync operations that rewrite history. Until CI runs the pinned tests, this will recur.
2. **Postgres mirror drift** — prod deploy builds against a schema missing 25 models; the parity gate script has a syntax error. Deploying the current workspace to Vercel would fail.
3. **History recomposition churn** — the workspace has been rebuilt multiple times after sandbox recycles; published work was lost locally twice (GIFTZ platform now remote-only). Mitigation: treat the remote as source of truth and always reconcile via tree-merge fast-forward; never push a rebuilt lineage over the published one.
4. **Dead code with live imports** — the portfolio subsystem is type-broken but still compiled by Next; any rename of shared libs can break the build through these files.
5. **Client fallback to the missing upload route** — every non-S3 deployment (including this sandbox) has broken uploads until the route is restored or the fallback removed.
6. **Empty-DB fixture drift** — `auth.test` and `riishe-automation` failures will confuse contributors on any fresh sandbox; a documented seed step (or CI seeding) removes the noise.

---

## 10. Existing data and integrations identified

- **Data:** sandbox DB is effectively empty (0 user rows; 11 system job rows); demo/QA fixtures exist as seed scripts (`scripts/seed.ts` — 8 demo accounts `isDemo=true`; `scripts/restore-qa-fixtures.ts` — 10 QA accounts; `seed-social-e2e.ts` — 3 real social accounts). Demo content is excluded from public surfaces via `isDemo` + `visibility.ts`.
- **Integrations:** Google OAuth (env-gated, disabled here); AI via managed `z-ai-web-dev-sdk` gateway (available, honest at-failure) + optional Gemini/OpenAI/diffusers (not configured); optional S3-compatible storage (not configured here — local driver); optional error webhook; Caddyfile local proxy; Vercel deploy path. Supabase vars reserved but unused. `next-auth`, `@tanstack/react-query`, `react-hook-form`, `@mdxeditor/editor` are unused dependencies.

---

## 11. What was executed during this audit (verification trail)

1. `git status`/`log`/`ls-remote` (repository state + divergence detection; remote fetched and verified).
2. Three parallel deep source audits (backend/frontend/data-AI) with file-level evidence.
3. `bun run lint` → 0E/13W. `bunx tsc --noEmit` → 118 errors (breakdown recorded).
4. `bun test` in 3 chunks → 835 tests, exact pass/fail recorded; failures attributed to files and re-run in isolation to classify root cause.
5. Read-only SQLite queries (table count, row counts, `_prisma_migrations` absence).
6. Live browser verification (Chrome via automation): 15 routes at 1440×900 and 390×844 (+768×1024 spot check), 20 screenshots saved under `docs/audit-screenshots/`, full register→recovery-key→onboarding→Folio E2E executed, zero page errors observed, no horizontal overflow at 390px, hash-route 404 behavior documented, Google OAuth disabled state verified.
7. GitHub API facts fetched live for all 18 researched repositories (stars, license text, last push, archived flag).

---

## 12. Recommended immediate actions (post-audit, in order)

1. Restore `src/app/api/media/upload/route.ts` (verbatim from history) or remove the client fallback + delete the pin tests — one line of client code vs. one route file; the route restore is the correct fix given 3 doc references + sentinel + tests.
2. Reconcile the workspace lineage with the published remote (fast-forward tree merge) so the GIFTZ platform returns to the working tree — before any further feature work that could fork the histories again.
3. Add a minimal CI workflow (lint + typecheck + `bun test` + upload-route sentinel).
4. Re-sync `prisma/schema.postgres.prisma` (+ fix `scripts/check-schema-parity.ts`) before the next Vercel deploy.
5. Delete or quarantine the dead portfolio subsystem.
6. Seed on fresh sandboxes (`seed.ts` + `restore-qa-fixtures.ts`) to silence fixture-drift failures.
