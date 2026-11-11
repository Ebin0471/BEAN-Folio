# BEAN Folio — Architecture (as built)

**Summary:** BEAN Folio is a single Next.js 16 (App Router) application serving a hash-routed
client-side SPA at `/` plus a REST API under `/api/*`, backed by Prisma + SQLite and local-disk
media storage, with server-side AI through a provider-independent gateway. This document
describes the system exactly as built and verified in this repository, the constraints that
shaped it, and the precise extraction path to the production blueprint (NestJS API, PostgreSQL,
S3, background worker, Expo mobile).

**Status:** As built in this repository — verified (lint + type checks + live API smoke tests; see `docs/testing.md`).

---

## 1. Runtime shape

| Concern | As built |
|---|---|
| Process | One Next.js 16 App Router app, port **3000** (`bun run dev`, logs to `dev.log`) |
| UI | Client-side SPA under the single visible page route `/`; URLs are hash routes (`/#/discover`, `/#/u/:username`, …) |
| API | Route handlers under `src/app/api/**/route.ts` (Next.js allows API routes; only `/` is a user-visible PAGE route) |
| Database | SQLite via Prisma 6 (`DATABASE_URL="file:./db/custom.db"`) |
| Media | Local `uploads/` directory, served through `GET /api/media/:id/raw` |
| AI | `z-ai-web-dev-sdk` (server-side only) behind the `src/lib/ai.ts` gateway |
| Runtime | bun; package scripts in `package.json` (`dev`, `build`, `start`, `lint`, `db:push`, …) |
| Styling/UI | Tailwind CSS 4 + shadcn/ui ("new-york") component set, dark obsidian + gold brand tokens in `src/app/globals.css` |

### Sandbox constraints (why it looks like this)

These constraints were verified at audit time (see `worklog.md`) and are non-negotiable in this
environment:

1. **One app, one port (3000), one visible page route (`/`).** A separate API service, a NestJS
   server, or server-rendered profile pages are not possible here.
2. **SQLite only** — no PostgreSQL instance available.
3. **No external credentials** — no Google OAuth, no Supabase, no S3.
4. **`z-ai-web-dev-sdk` is the only configured AI provider** (server-side).
5. **No test frameworks may be added** — verification = lint + tsc + live API smoke tests.

The architecture decision (documented trade-off in `worklog.md`): implement the *full product*
on the enforced stack with clean integration boundaries, and document the exact upgrade path
rather than stubbing fake integrations. Accordingly, Google OAuth is a documented boundary
(`docs/google-auth.md`), media processing is a documented design (`docs/media-pipeline.md`),
and no fabricated integration states exist in product code.

---

## 2. Layering

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser (SPA under /)                                               │
│                                                                     │
│  src/app/page.tsx        SPA shell: providers, nav, footer,         │
│                          hash router → views, auth/onboarding gates │
│  src/views/*.tsx         15 feature views (see §4 for build state)  │
│  src/components/bean/*   shared atoms: ProjectCard, PersonCard,     │
│                          FollowButton, TagInput, MediaUploadButton… │
│  src/components/ui/*     shadcn/ui primitives                       │
│                                                                     │
│  client libs:                                                       │
│   src/lib/client.ts        api<T>() fetch wrapper (ApiError),       │
│                            uploadFile() XHR with progress           │
│   src/lib/hash-router.ts   navigate() / useHashRoute()              │
│   src/lib/session.tsx      SessionProvider / useSession()           │
│   src/lib/types.ts         shared DTO types                         │
└───────────────┬─────────────────────────────────────────────────────┘
                │  fetch (same-origin, cookie session bean_session)
┌───────────────▼─────────────────────────────────────────────────────┐
│ API route handlers  src/app/api/**/route.ts                         │
│  auth, me/*, profiles, media, projects, discover, search,           │
│  collections, inquiries, notifications, blocks, reports, privacy,   │
│  export/deletion/audit, insights, ai/*, health                      │
│                                                                     │
│  shared server libs:                                                │
│   src/lib/auth.ts         scrypt passwords, hashed session tokens,  │
│                           getSessionUser, cookie set/clear          │
│   src/lib/api-helpers.ts  ok/err/parseBody(zod), rateLimit,         │
│                           resolveViewerKey + utcDay, handler wrapper│
│   src/lib/serialize.ts    toProjectCard / toFullProject /           │
│                           toPublicPerson + Prisma includes          │
│   src/lib/media.ts        magic-byte validation, uploads/ storage,  │
│                           imageDimensions                           │
│   src/lib/ai.ts           aiComplete gateway (60s timeout, safe     │
│                           errors), parseJsonFromText                │
│   src/lib/db.ts           Prisma client (singleton)                 │
└───────────────┬─────────────────────────────────────────────────────┘
                │  Prisma Client
┌───────────────▼─────────────────────────────────────────────────────┐
│ Prisma 6 → SQLite (db/custom.db)          uploads/ (local disk)     │
│ 27 models — see docs/database.md          served via                │
│                                           /api/media/:id/raw        │
└─────────────────────────────────────────────────────────────────────┘
                │  (server-side only)
┌───────────────▼─────────────────────────────────────────────────────┐
│ z-ai-web-dev-sdk (GLM) — reached only through src/lib/ai.ts         │
└─────────────────────────────────────────────────────────────────────┘
```

Key rule: **product code never imports the AI SDK directly** and **never trusts the client for
authorization** — every route resolves `getSessionUser()` and re-checks ownership/visibility
server-side.

---

## 3. Hash-routed SPA under one route

The entire UI lives at `/` (`src/app/page.tsx`) and switches views by `location.hash`
(`src/lib/hash-router.ts`). Current routes (from the shell router):

| Hash route | View | Access |
|---|---|---|
| `#/` | DiscoverView | public |
| `#/explore` | ExploreView | public |
| `#/auth` | AuthView | public |
| `#/onboarding` | OnboardingView | auth |
| `#/folio` | FolioView | auth |
| `#/studio`, `#/studio/new`, `#/studio/:id/edit` | StudioView / ProjectEditorView | auth |
| `#/p/:id` | ProjectDetailView | public (visibility enforced by API) |
| `#/u/:username` | PublicProfileView | public (visibility enforced by API) |
| `#/intelligence` | IntelligenceView | auth |
| `#/connect` | ConnectView | auth |
| `#/insights` | InsightsView | auth |
| `#/settings` | SettingsView | auth |
| `#/collections` | CollectionsView | auth |
| `#/privacy`, `#/terms` | StaticView | public |

**Trade-off (documented honestly):** deep links and back/forward work, but everything renders
from one HTML document. There is **no server-side rendering for profiles or project pages**, so
SEO/social previews for `/#/u/:username` and `/#/p/:id` are effectively absent until the
production route structure exists. UI gating (`RequireAuth`, onboarding redirect) is a UX
convenience only; the server enforces all authorization.

---

## 4. Frontend build state (read before trusting UI claims)

The SPA shell, hash router, session provider, client libs, shared `bean/*` components and the
full design system are implemented (Task 1-2, `worklog.md`), and **all 15 feature views in
`src/views/*.tsx` are fully implemented** (tasks 4-a/4-b/4-c). The complete product was verified
end-to-end in a real browser during the final integration pass: register → onboarding →
create/upload/publish → discover → follow → inquiry → real AI calls → insights → export, plus a
server-side authorization matrix (anonymous 401s, cross-user 403/404) and a zero-console-error
fresh-session check. Evidence list in `worklog.md` (final entry).

---

## 5. Module map (current → production home)

The production blueprint (per the product vision) is a NestJS monorepo + PostgreSQL + Supabase
Auth + S3 media + background worker + Expo mobile. Each current module has a clean extraction
path because boundaries were kept provider-independent:

| Current module (this repo) | Responsibility | Production home |
|---|---|---|
| `src/app/api/**/route.ts` | REST endpoints (see `docs/api.md`) | NestJS controllers/modules (e.g. `apps/api/src/{auth,projects,media,discovery,connect,insights,ai}`) |
| `src/lib/auth.ts` | scrypt hashing, opaque sessions, cookie helpers | Supabase Auth (Google OAuth etc.) + thin session mapping (`docs/google-auth.md` §7) |
| `src/lib/api-helpers.ts` | ok/err, zod parseBody, rate limiter, viewer key | Nest interceptors/filters/guards + Redis-backed rate limiter |
| `src/lib/serialize.ts` | DTO builders + Prisma include shapes | Nest serialization layer |
| `src/lib/media.ts` | magic-byte validation, local storage | S3 signed uploads + worker (`docs/media-pipeline.md`) |
| `src/lib/ai.ts` | provider-independent completion gateway | Same wrapper in the API; provider key/swap via env (`docs/ai-integration.md`) |
| `prisma/schema.prisma` | 27-model domain model | PostgreSQL schema via Prisma migrate (`docs/database.md` §6) |
| `src/views/*` + shell | SPA | Next.js web app (server-rendered profile/project pages) + Expo app reusing the same REST API |
| `scripts/` | demo fixture loader | Seed job (see note in `README.md` — loader not yet present in this pass) |

Nothing in the API design is single-tenant-locked: endpoints are stateless JSON over cookie
sessions, so pointing an Expo app or a Nest gateway at the same contract is a port, not a
rewrite.

---

## 6. Cross-cutting mechanics worth knowing

- **View dedup** — `resolveViewerKey()` (`src/lib/api-helpers.ts`) mints `u:<userId>` for
  signed-in viewers or an anonymous `bean_vk` cookie (`a:<uuid>`); views upsert into
  `ProjectView`/`ProfileView` keyed by `(target, viewerKey, utcDay)`. See `docs/database.md` §4.
- **Rate limiting** — in-memory fixed-window buckets in `src/lib/api-helpers.ts`
  (per-process; see `docs/security.md` §8 for the production gap).
- **Error convention** — `{ error: string }` with 400/401/403/404/429/500; handlers wrapped by
  `handler()` so stack traces never reach clients (`docs/api.md` §1).
- **Visibility model** — PUBLIC/UNLISTED/PRIVATE + draft guard, enforced in every read path and
  in the media authorization ladder (`docs/product-spec.md` §4, `docs/security.md` §4).
- **Next.js 16 specifics** — route params are Promises (`await params`), `cookies()` is async;
  `next.config.ts` sets `output: "standalone"` (used by the production runbook in
  `docs/deployment.md`).

## 7. Related docs

`docs/product-spec.md` · `docs/api.md` · `docs/database.md` · `docs/security.md` ·
`docs/media-pipeline.md` · `docs/ai-integration.md` · `docs/deployment.md` · `docs/testing.md` ·
`docs/known-limitations.md`
