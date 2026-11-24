# BEAN UI — SCREEN INVENTORY (M0, UI/UX track)

**Audit date:** 2026-11-13 · tree `c9fe839`. Every screen in the application with its access path, source of truth, and reachability.

## 1. Rendering model

- **One document**: `src/app/page.tsx` (the only `page.tsx` in `src/app`). All platform navigation is **hash-routed** (`src/lib/hash-router.tsx`), bootstrapped by `SiteShell`.
- **Four public path forms** are rewritten by `src/proxy.ts` onto the SPA document: `/u/<username>`, `/p/<id>`, `/site/<username>(/projects/<id>|/g/<siteId>)`, `/post/<id>` — with `x-bean-boot-route` seeding and edge cache headers.
- **Direct visits to any other path** (e.g. `/explore`) hit the **default Next.js 404** (unstyled) — finding UI-1.

## 2. Hash-route map (from `SiteShell.tsx` Router, lines 520–633)

| Route | View | Auth | Onboarding gate | Status |
|---|---|---|---|---|
| `#/` (empty) | DiscoverView | public | no | ✅ browser-verified |
| `#/explore` | ExploreView | public | no | ✅ browser-verified |
| `#/auth` | AuthView | public | no | ✅ browser-verified (incl. register E2E) |
| `#/onboarding` | OnboardingView | auth | — | ✅ browser-verified E2E |
| `#/folio` | FolioView | auth | yes | ✅ browser-verified |
| `#/studio` | StudioView | auth | yes | ✅ browser-verified |
| `#/studio/new` | ProjectEditorView | auth | yes | ✅ browser-verified |
| `#/studio/<id>/edit` | ProjectEditorView | auth | yes | code-verified |
| `#/p/<id>` | ProjectDetailView | public | no | code-verified (+tests) |
| `#/post/<id>` | PostDetailView | public | no | code-verified (+tests) |
| `#/u/<username>` | PublicProfileView | public | no | ✅ browser-verified |
| `#/site/<username>` | PublishedSiteView | public | no | code-verified (+tests) |
| `#/site/<u>/projects/<id>` | SiteProjectDetailView | public | no | code-verified (+tests) |
| `#/site/<u>/g/<siteId>` | SiteGiftzSiteView | public | no | code-verified |
| `#/intelligence` | IntelligenceView | auth | yes | ✅ browser-verified |
| `#/laxii` | LaxiiView | auth | yes | ✅ browser-verified |
| `#/giftz` | WebsiteBuilderView | auth | yes | ✅ browser-verified (desktop + mobile) |
| `#/connect` | ConnectView | auth | yes | ✅ browser-verified |
| `#/messages` | MessagesView | auth | yes | code-verified |
| `#/search/<q>` | SearchView | public | no | code-verified |
| `#/hashtags/<tag>` | SearchView (HashtagView export) | public | no | code-verified |
| `#/insights` | InsightsView | auth | yes | ✅ browser-verified |
| `#/settings` | SettingsView | auth | yes | ✅ browser-verified |
| `#/collections` | CollectionsView | auth | yes | ✅ browser-verified |
| `#/privacy`, `#/terms` | StaticView | public | no | code-verified |
| `#/moderation` | ModerationView | admin (self-gates) | yes | code-verified |
| *(default)* | NotFound (in-app branded) | — | — | code-verified |

## 3. View inventory (28 files, `src/views/`)

| View | LOC | Purpose | Reachable |
|---|---|---|---|
| DiscoverView | 736 | homepage feed: hero, composer gate, suggested profiles, hashtags, reels, posts | ✅ |
| ExploreView | 275 | published-project search/filter/sort | ✅ |
| StudioView | 870 | project manager (drafts/published/archive, feature, duplicate, bulk assets) | ✅ |
| ProjectEditorView | 1976 | project create/edit, templates, crops, AI improve/suggest | ✅ |
| ProjectDetailView | 805 | public project page | ✅ |
| PostDetailView | 131 | public post deep-link | ✅ |
| PublicProfileView | 759 | profile, stats dialogs, follow/message/inquiry | ✅ |
| PublishedSiteView | 351 | standalone published website | ✅ |
| SiteProjectDetailView | 348 | website-native project detail | ✅ |
| SiteGiftzSiteView | 162 | published GIFTZ-generated site | ✅ |
| WebsiteBuilderView | 2997 | CODE GIFTZ studio (customization + AI chat) | ✅ |
| IntelligenceView | 556 | RIISHE chat + dashboard | ✅ |
| LaxiiView | 12 | wrapper → LaxiiStudio | ✅ |
| ConnectView | 774 | notifications/inquiries/following/blocks | ✅ |
| MessagesView | 396 | 1:1 DMs with requests | ✅ |
| SearchView | 291 | unified search + hashtag view | ✅ |
| InsightsView | 464 | analytics overview | ✅ |
| SettingsView | 749 | trust & settings | ✅ |
| CollectionsView | 644 | saves & collections | ✅ |
| FolioView | 751 | My Folio profile editor | ✅ |
| AuthView | 753 | sign in/register/recovery | ✅ |
| OnboardingView | 438 | 2-step onboarding | ✅ |
| StaticView | 310 | privacy/terms | ✅ |
| ModerationView | 466 | admin report queue | ✅ (admin) |
| GiftzView | 921 | **ORPHAN** — old GIFTZ engineering dashboard | ❌ |
| PortfolioStudioView | 3295 | **ORPHAN** — legacy drag-drop builder | ❌ |
| PortfolioSiteView | 232 | **ORPHAN** — legacy site renderer consumer | ❌ |
| PortfolioCaseStudyView | 340 | **ORPHAN** — legacy case-study page | ❌ |

Orphan total: **4,788 LOC** (+ their private dependency tree `components/bean/portfolio/*`).

## 4. API route inventory (181 files / 250 handlers)

Full method+path listing (extracted and verified during the M0 audit):

**auth (9):** POST login · POST register · POST logout · GET me · GET google · GET google/callback · GET google/status · POST recover/request · POST recover/reset

**ai (15):** POST chat · POST chat-stream · GET conversations · GET conversations/[id] · POST design · GET|POST|DELETE design/chat · POST design/audit · POST design/execute · GET|POST design/job · POST design/plan · POST suggest · POST improve · GET capabilities

**discover (4):** GET / · GET creators · GET posts · GET suggested
**feed (1):** GET /
**giftz (25):** GET|POST creative · GET creative/[id] · POST creative/[id]/approve|reject|integrate · GET|POST repositories · GET|DELETE repositories/[id] · GET|POST tasks · GET tasks/[id] · POST tasks/[id]/approve|reject|retry|revert|cancel · GET|POST sites · GET|PUT|DELETE sites/[id] · POST sites/[id]/publish|unpublish · GET sites/[id]/public

**hashtags (2):** GET trending · GET [tag]
**inquiries (2):** POST / · PATCH [id]
**intelligence (6):** GET|POST handoffs · GET handoffs/[id] · POST approve|reject|cancel
**laxii (30):** brief, capabilities, banner-presets, banner/export, conversations (+[id], messages), generate, images, images/export, jobs (+[id], retry, cancel), library, messages/[id], versions favourite/select, resume (+export, parse)
**media (6):** GET / · GET|DELETE [id] · GET [id]/raw · POST direct/presign · POST direct/complete — **plus the deleted POST /upload (missing at HEAD)**

**me (55):** audit, blocks, collections, deletion, export(+[jobId]), followers, following, inquiries, insights(overview|posts|projects), messages(+[conversationId]), notifications(+read, preferences), onboarding, privacy, profile, recovery-key, requests, saves, search-history, site(+publish, unpublish, revisions, export, materials), site/studio/sessions(+[id], messages), site/studio/turns/[taskId](+retry)

**collections (4):** PATCH|DELETE [id] · POST|DELETE [id]/items
**posts (20):** GET|POST / · GET|POST drafts · GET|PATCH|DELETE [id] · POST|DELETE like|bookmark · POST share|view|hide · GET|POST comments · PATCH|DELETE comments/[commentId] · POST|DELETE comments/[commentId]/like
**profiles (8):** GET [username] · GET|POST|DELETE follow · GET posts|followers|following · PATCH edge
**professions (2):** GET / · GET [slug]
**portfolio (8 — dead subsystem):** GET|PATCH / · POST publish|unpublish · POST import · GET export · GET revisions · POST revisions/[id]/restore
**projects (16):** GET|POST / · GET|PATCH|DELETE [id] · POST publish|unpublish|archive|unarchive|feature|unfeature|duplicate|view · POST|DELETE save · GET related
**reports (1):** POST /
**admin (3):** GET reports · GET|PATCH reports/[id] (requireAdmin)
**riishe (22):** automations(+[id], stop-all), dashboard, shortlist, preferences, enquiries send, notes(+[id]), steps/[id], workflows(+[id])
**search (5):** all · posts · projects · profiles · suggest
**site (1):** GET [slug]
**root (4):** GET / · GET health · GET ready · GET origin-proof (raw)

Non-API: GET robots.txt · GET sitemap.xml (dynamic).

## 5. Screenshots captured (evidence)

Desktop 1440×900: discover, explore, auth, recovery-key, onboarding, folio, studio, studio-new, giftz, intelligence, laxii, connect, insights, settings, collections, public-profile (16 files).
Mobile 390×844: discover, auth, folio, giftz, connect (5 files). Tablet 768×1024: discover (1 file).
All under `docs/audit-screenshots/`.
