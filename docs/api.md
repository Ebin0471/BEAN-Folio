# BEAN Folio — REST API Reference

**Summary:** Complete reference for every endpoint implemented under `/api` in this build
(~50 route files / ~55 operations). Auth is a cookie session (`bean_session`, httpOnly); all
bodies and responses are JSON; errors are always `{ error: string }`. Behavior documented here
matches the implemented route handlers, including deliberate deviations from the original
contract (noted inline).

**Status:** As built in this repository — verified via live API smoke tests (`docs/testing.md`).

---

## 1. Conventions

| Convention | Value |
|---|---|
| Base | same origin, e.g. `/api/...` |
| Auth | `bean_session` cookie (httpOnly, SameSite=Lax, `secure` when `NODE_ENV=production`); 30-day expiry |
| Errors | `{ error: string, code? }` — 400 validation · 401 `Authentication required` · 403 `Not allowed` · 404 `Not found` · 413 `Request body too large` (`payload_too_large`) · 429 `Too many requests. Please slow down.` · 500 `Something went wrong` (never a stack trace) |
| Request ID | every response through `handler()` carries `x-request-id` (client-supplied when well-formed, else generated) — see §18 |
| Validation | zod at the boundary; first issue returned as `Invalid input — <path>: <message>` |
| Content type | JSON bodies (`application/json`); media upload is `multipart/form-data` |

**Rate limits (in-memory by default, per instance — pluggable shared backend, see §18 — `docs/security.md` §8):**

| Bucket | Limit |
|---|---|
| Auth endpoints (register, login, logout, me) | 10/min per IP (shared bucket) |
| Media upload | 30/h per user |
| Project create | 20/h per user |
| Inquiries | 10/h per sender |
| Reports | 10/h per reporter |
| AI features (improve/suggest/chat) | 6/min per user, plus **30/day** per user via `AiUsage` rows |
| Site builder mutations (save, watermark, publish, unpublish) | 20–60/min per user (shared-backend bucket via `rateLimitShared`, see §18) |

**View dedup:** views are recorded at most once per viewer per UTC day per target
(`ProjectView`/`ProfileView` unique keys; viewer = `u:<userId>` or anonymous `a:<cookie>`).
Counts shown anywhere in the product are therefore **estimates** and labelled as such.

**Abbreviated DTOs:**

```ts
PublicMe      = { id, email, name, username, headline, bio, location, avatarUrl, coverUrl,
                  availability, contactEmail, websiteUrl, professions: string[] /*slugs*/,
                  skills: string[] /*slugs*/, aiConsent, onboarded, profileVisibility, isDemo, createdAt }
PublicPerson  = { username, name, headline, avatarUrl, location, availability, professions, skills /*labels*/,
                  stats: { followers, projects } }
ProjectCard   = { id, title, summary, category, coverUrl, visibility, status, publishedAt, updatedAt,
                  owner: { username, name, avatarUrl }, counts: { views, saves }, skills: string[] }
FullProject   = ProjectCard fields + description, brief, process, challenges, outcome, role,
                  externalUrl, repoUrl, tools: string[], media: [{ id, mediaId, url, kind, caption, order }],
                  contributors: [{ id, name, role, contribution }], visibility, status, publishedAt,
                  createdAt, updatedAt, skills: string[], counts
InquiryDTO    = { id, type, subject, message, status, createdAt, project?: { id, title }, counterparty: PublicPerson }
```

`avatarUrl`/`coverUrl`/`coverUrl`/media `url` are always `/api/media/<id>/raw`.

---

## 2. Auth

| Method & path | Auth | Body / notes |
|---|---|---|
| `POST /api/auth/register` | — | `{ email, password (min 8), name }` → `{ user: PublicMe }` + sets cookie. 409 if email taken; 400 weak password |
| `POST /api/auth/login` | — | `{ email, password }` → `{ user: PublicMe }`. 401 invalid credentials |
| `POST /api/auth/logout` | cookie | → `{ ok: true }`; deletes the session row and clears the cookie |
| `GET /api/auth/me` | optional | → `{ user: PublicMe \| null }` (anonymous → `null`). Shares the 10/min auth bucket — the SPA must not hammer it |

Google OAuth is **not** implemented in this build — see `docs/google-auth.md`.

## 3. Onboarding & own profile

| Method & path | Auth | Notes |
|---|---|---|
| `POST /api/me/onboarding` | ✓ | `{ username, displayName, professions: string[], skills?, bio?, location?, headline? }` → `{ user: PublicMe }`. Username `[a-z0-9][a-z0-9-]{2,23}` unique (400/409); unknown profession slug → 400; sets `onboarded=true` |
| `GET /api/me/profile` | ✓ | → `{ user: PublicMe, stats: { projects, published, followers, following, profileViews } }` |
| `PATCH /api/me/profile` | ✓ | Partial: `name, headline, bio, location, availability, contactEmail, websiteUrl, avatarMediaId, coverMediaId, professions, skills, profileVisibility`. Nullable text fields cleared by `""`; URLs validated http(s) ≤ 300; avatar/cover must be owned media (else 400); professions/skills are full-replace inside a transaction |

## 4. Taxonomy

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/professions` | optional | → `{ professions: [{ slug, label, group }] }` — curated list, seed-on-read (idempotent), ordered |
| `GET /api/skills` | optional | → `{ skills: [{ slug, label }] }` — same seeding behavior |

## 5. Public profiles & follow graph

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/profiles/:username` | optional | → `{ profile: { …PublicPerson-ish, bio, websiteUrl, createdAt, stats: { followers, following, projects, profileViews? } }, isFollowing, isSelf, projects: ProjectCard[] (PUBLISHED; +UNLISTED when self), collections: [{ id, name, description, items: ProjectCard[] }] }`. PRIVATE/deleted profile → 404 unless self. Records a deduped ProfileView (never fails the request) |
| `POST /api/profiles/:username/follow` | ✓ | → `{ following: true }`. Self-follow 400; block either direction 403; FOLLOW notification on first follow only. Idempotent |
| `DELETE /api/profiles/:username/follow` | ✓ | → `{ following: false }` |
| `GET /api/me/following` | ✓ | → `{ people: PublicPerson[] }` |
| `GET /api/me/followers` | ✓ | → `{ people: PublicPerson[] }` |

## 6. Media

| Method & path | Auth | Notes |
|---|---|---|
| `POST /api/media/upload` | ✓ | multipart `file` (+ optional `kind`). Magic-byte sniffed — client MIME never trusted. Limits: IMAGE ≤ 8 MB (jpeg/png/webp/gif), VIDEO ≤ 64 MB (mp4/webm/mov), AUDIO ≤ 20 MB (mp3/m4a/wav/ogg), DOCUMENT ≤ 10 MB (pdf). → `{ media: { id, kind, mime, size, url } }`. 400 with safe message on bad type/size |
| `GET /api/media/:id/raw` | optional | Binary stream, Content-Type + `private, max-age=3600`. Authorization ladder: owner → avatar/cover of a live account → attached project PUBLIC/UNLISTED (or project owner) → else 403. Missing blob marks the asset FAILED → 404 |
| `GET /api/media/:id` | ✓ owner | → `{ media }` metadata. Non-owner 404, anon 401 |
| `DELETE /api/media/:id` | ✓ owner | Removes file then row (file deletion idempotent) |

## 7. Projects

| Method & path | Auth | Notes |
|---|---|---|
| `POST /api/projects` | ✓ | Body per `docs/product-spec.md` §3 (`title` required; `media[]`, `contributors[]`, `skills[]`, `tools[]`, `category`, `coverMediaId` (string, or `null` → no cover), …). All media must be owned (else 400). Atomic transaction. Rate 20/h. → `{ project: FullProject }` (status DRAFT) |
| `GET /api/projects` | ✓ | Own projects only, all visibilities. `?status=DRAFT\|PUBLISHED` (invalid → 400). → `{ projects: ProjectCard[] }`, updatedAt desc, take 100 |
| `GET /api/projects/:id` | optional | → `{ project: FullProject, owner: PublicPerson, isOwner, isSaved, canEdit }`. PRIVATE **or DRAFT** → 404 unless owner (draft guard is stricter than the original contract — deliberate). UNLISTED readable by direct link. Records a deduped ProjectView when PUBLISHED and viewer ≠ owner |
| `PATCH /api/projects/:id` | ✓ owner | Same fields as POST, partial. **Omitted key = unchanged; explicit `null` = clear** (nullable text also accepts `""` → clear; `coverMediaId: null` clears the cover). Arrays replace wholesale; `status` NOT patchable. Non-owner → **403** (deviation: contract said owner-only, implemented as explicit 403 since the resource exists) |
| `DELETE /api/projects/:id` | ✓ owner | → `{ ok: true }`. Non-owner → 403 |
| `POST /api/projects/:id/publish` | ✓ owner | Publish gate: trimmed title + (cover OR ≥1 media) else 400 `"Add a cover or at least one media item before publishing"`. Sets PUBLISHED; `publishedAt` only on first publish. Non-owner → 403 |
| `POST /api/projects/:id/unpublish` | ✓ owner | Back to DRAFT (keeps `publishedAt`) |
| `POST /api/projects/:id/view` | optional | Visibility-aware view recording (PRIVATE/DRAFT → 404 for non-owners; owner/drafts never counted). Always → `{ ok: true }` |
| `POST /api/projects/:id/save` | ✓ | PUBLIC/UNLISTED + PUBLISHED + live owner required (else 404); own project → 400. → `{ saved: true }`; owner notification on first save only |
| `DELETE /api/projects/:id/save` | ✓ | → `{ saved: false }` |

## 8. Discover & search

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/discover` | optional | Query: `cursor?`, `limit` (1..24, default 12), `category?`. → `{ items: [{ project: ProjectCard, reason?: string }], nextCursor }`. Ranking per `docs/product-spec.md` §5; block-filtered for signed-in viewers |
| `GET /api/search/projects` | optional | Query: `q` (≤ 80, else 400; case-insensitive contains on title/summary/description), `category?`, `skill?` (slug or label), `sort=recent\|saved`, `cursor?`. → `{ items: ProjectCard[], nextCursor }`. PUBLIC+PUBLISHED only, block-filtered |
| ~~`GET /api/search/profiles`~~ | — | **Removed.** The People discovery experience was removed from Explore (Projects is the only discovery surface); the route was deleted. Person/follow functionality remains via `GET /api/profiles/:username`, `GET /api/me/following`, `GET /api/me/followers`, `GET /api/me/blocks` |

## 9. Saves & collections

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/me/saves` | ✓ | → `{ projects: ProjectCard[] }` (defensively skips PRIVATE/deleted-owner rows) |
| `GET /api/me/collections` | ✓ | → `{ collections: [{ id, name, description, isPublic, items: ProjectCard[] }] }` (items pre-filtered: no PRIVATE, live owners) |
| `POST /api/me/collections` | ✓ | `{ name (1..80), description? (≤300), isPublic? }` → `{ collection }` |
| `PATCH /api/collections/:id` | ✓ owner | Partial update; empty description → null. Foreign/missing → **404** (deliberate: foreign and missing are indistinguishable) |
| `DELETE /api/collections/:id` | ✓ owner | → `{ ok: true }` |
| `POST /api/collections/:id/items` | ✓ owner | `{ projectId }` — target must be PUBLISHED and not PRIVATE (404 missing / 400 otherwise). → `{ ok: true }` |
| `DELETE /api/collections/:id/items` | ✓ owner | `?projectId=` required (missing → 400). → `{ ok: true }` |

## 10. Inquiries & notifications

| Method & path | Auth | Notes |
|---|---|---|
| `POST /api/inquiries` | ✓ | `{ recipientUsername \| projectId, type: INQUIRY\|COLLABORATION\|INVITE, subject, message }` → `{ inquiry }`. Self 400; blocked 403; missing/deleted recipient 404; rate 10/h. Notification to recipient |
| `GET /api/me/inquiries` | ✓ | → `{ incoming: InquiryDTO[], outgoing: InquiryDTO[] }` |
| `PATCH /api/inquiries/:id` | ✓ recipient | `{ status: ACCEPTED\|DECLINED }` → `{ inquiry }`; notification to sender (INQUIRY_RESPONSE) |
| `GET /api/me/notifications` | ✓ | → `{ notifications: [{ id, type, payload: object, readAt, createdAt }], unreadCount }` |
| `POST /api/me/notifications/read` | ✓ | `{ ids?: string[] }` (omit = mark all) → `{ ok: true }` |

## 11. Blocks & reports

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/me/blocks` | ✓ | → `{ blocks: PublicPerson[] }` |
| `POST /api/me/blocks` | ✓ | `{ username }` → idempotent block; severs follows in both directions |
| `DELETE /api/me/blocks` | ✓ | `?username=` → `{ ok: true }` |
| `POST /api/reports` | ✓ | `{ targetType: PROJECT\|PROFILE, targetId, reason, details? }` → `{ ok: true }`. Target must exist (deleted profile → 404). Rate 10/h. Audit `report.create` |

## 12. Privacy, export, deletion, audit

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/me/privacy` | ✓ | → `{ profileVisibility, aiConsent }` |
| `PATCH /api/me/privacy` | ✓ | `{ profileVisibility?, aiConsent? }` → same shape. Audit `privacy.update` with changed-field meta |
| `POST /api/me/export` | ✓ | → `{ job: { id, status } }` — synchronous full JSON export of the user's own data (account minus passwordHash, taxonomy, projects, collections, saves, follows, inquiries, notifications, AI conversations) into `ExportJob` (READY, FAILED fallback). Audit `data.export` |
| `GET /api/me/export/:jobId` | ✓ owner | → `{ job }`; `payload` holds the export JSON when READY. Foreign job → 404 |
| `POST /api/me/deletion` | ✓ | `{ reason? }` → `{ ok: true }`. Creates `DeletionRequest`, immediately soft-deletes (email/name anonymized, username + profile fields nulled, `deletedAt=now`), revokes all sessions, marks the request COMPLETED. Audit `account.deleted` |
| `GET /api/me/audit` | ✓ | → `{ events: [{ action, targetType?, targetId?, createdAt }] }` — meta is never returned |

## 13. Insights (owner-only, labelled "estimated")

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/me/insights/overview` | ✓ | → `{ totals: { profileViews, projectViews, saves, followers }, series14d: [{ day, views }] (zero days included), topProjects: [{ id, title, views, saves }] }` — computed from the dedup tables only |
| `GET /api/me/insights/projects` | ✓ | → `{ projects: [{ id, title, views, saves, views14d }] }` |

## 14. BEAN Intelligence (AI)

All AI endpoints require: session + `aiConsent=true` (else 403 *"AI is not enabled for your
account. Enable it in Settings."*) + rate limits (6/min and 30/day via `AiUsage`).
Provider failures surface as **502** with a safe message (`docs/ai-integration.md`).

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/ai/capabilities` | ✓ | → `{ available, features: [{ id, label, description }], dailyLimit, usedToday, consentRequired }`. Does **not** consume quota |
| `POST /api/ai/improve` | ✓ consent | `{ field: 'description'\|'summary'\|'bio'\|'process'\|'outcome', content, projectContext? }` → `{ text }`. Never auto-saves |
| `POST /api/ai/suggest` | ✓ consent | `{ projectId?, title?, description? }` → `{ summary?, skills?: string[], category?: string }`. JSON-validated; `category` coerced against the 18 profession slugs (unknown → null). Never auto-applies |
| `POST /api/ai/chat` | ✓ consent | `{ conversationId?, message }` → `{ conversationId, reply }`. Grounded ONLY in the user's own profile + latest 10 own projects (any visibility — they own them); keeps last-10 message history; persists conversation/messages |
| `GET /api/ai/conversations` | ✓ consent | → `{ conversations: [{ id, title, updatedAt }] }` — consent-gated but **quota-free** (deliberate) |
| `GET /api/ai/conversations/:id` | ✓ consent owner | → `{ conversation: { id, title, messages: [{ role, content, createdAt }] } }` |

## 15. System

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/health` | — | → `{ ok: true, service: "bean-folio", time }` |
| `GET /api` | — | Same payload (wrapped in the standard `handler()` — carries `x-request-id`) |

---

## 16. Deviations from the original v1 contract (intentional, as implemented)

1. **Draft guard** — `GET /api/projects/:id` (and the view endpoint) 404 non-published projects
   for non-owners even when `visibility=PUBLIC`; the contract only specified visibility checks.
2. **Foreign project mutations → 403** (`PATCH`/`DELETE`/`publish`/`unpublish`); foreign
   collections stay 404 per the original task spec.
3. **`GET /api/auth/me` counts against the 10/min auth bucket** (it shares the auth rate limit).
4. **AI conversation reads are consent-gated but do not consume daily quota.**
5. **Public profile skills are labels** (display strings) while `PublicMe` uses slugs —
   deliberate, documented in `worklog.md` (3-a).
6. **Onboarding/PATCH profile reject unknown profession slugs with 400**; skills are free-form
   (labels or slugs, auto-created).

## 17. Related docs

`docs/product-spec.md` (behavioral spec) · `docs/security.md` (auth, rate limits, visibility
enforcement) · `docs/database.md` (persistence + dedup) · `docs/testing.md` (what was verified)

## 18. Platform standard (scale phase)

Cross-cutting standard introduced by the "Global Scale" upgrade (task 2-a). All routes built on
`handler()` + `src/lib/api-helpers.ts` inherit it; new endpoints MUST follow it.

### Request IDs (`x-request-id`)

- Every response produced through `handler()` carries an `x-request-id` header (success and error
  paths alike).
- The ID is taken from the client's `x-request-id` request header when it is well-formed
  (`/^[A-Za-z0-9_-]{8,64}$/`), otherwise a fresh UUID is generated — malformed client IDs are
  never echoed into logs.
- Server code can read the current ID anywhere below the wrapped handler via
  `getRequestId()` (`src/lib/api-helpers.ts`, AsyncLocalStorage-backed; `null` outside requests)
  for log correlation.

### Error envelope + structured logging

- Error bodies stay `{ error: string, code? }` (see §1) — no stack traces, ever.
- Unhandled exceptions are logged as ONE structured JSON line:
  `{"event":"api.error","requestId","method","path","status","durationMs","error":{name,message}}`.
  A `stack` field is appended **only** when `NODE_ENV !== "production"`.
- `PayloadTooLargeError` (thrown by body parsing) is mapped to a typed
  `413 { error: "Request body too large", code: "payload_too_large" }`.

### Body-size limits

- `parseBodySized(req, schema, maxBytes = 256_000)` reads the raw body, enforces a byte budget
  (`Buffer.byteLength`; `Content-Length` short-circuits before reading) and then JSON+ zod-parses.
  Over-budget → typed 413 (above).
- `parseBody(req, schema)` keeps its old signature and now delegates with a generous 1 MB budget.
  Behavior change: JSON bodies > 1 MB now return 413 instead of being parsed unbounded. Multipart
  media uploads are unaffected (they enforce per-kind size limits in the upload route).

### Rate-limit backends (`src/lib/rate-limit-backend.ts`)

- Interface: `RateLimitBackend.hit(key, limit, windowMs) → { allowed, remaining, resetAt }`
  (fixed window; the request reaching `count === limit` is the last allowed one; blocked requests
  do not consume budget).
- Backends: `memory` (default, per-instance, 5000-key cap with prune) and `postgres` (shared,
  backed by the `RateLimitBucket` table; rows store only SHA-256-hashed keys — never raw
  IPs/emails; SQLite-compatible upsert increments).
- Selection: `RATE_LIMIT_BACKEND` env var — `memory` (default) | `postgres`; memoized at first use.
- Resilience: if the shared backend errors, the call falls back to the in-memory limiter (limits
  stay enforced, per-instance) and logs `{"event":"ratelimit.backend_fallback",...}`. The limiter
  can never 500 a request.
- Helpers: legacy `rateLimit()` stays synchronous/per-instance for existing call sites;
  **abuse-sensitive routes** (auth login/register/recover, media upload, AI POSTs, studio
  messages, `laxii/generate`, and similar) should use
  `await rateLimitShared(key, limit, windowMs)` which returns a ready 429 response (with
  `Retry-After`) or `null` when allowed. Adopted in this cycle by the site-builder mutation
  routes (`PUT`/`PATCH /api/me/site`, `POST /api/me/site/publish`, `POST /api/me/site/unpublish`).

### App-level cache + invalidation events (`src/lib/cache.ts`)

- Helpers: `cacheGet/cacheSet/cacheDelete/cacheInvalidatePrefix/cacheInvalidateEvent`,
  `cacheKey(...parts)` (stable, collision-free serialization), `cacheStats()`
  (size/hits/misses for health). Single-process Map, ≤ 2000 entries, TTL expiry,
  oldest-entry eviction after prune. Cached plain objects come back with a
  `_cachedAt` debug field — never spread a cached object directly into a response.
- Only PUBLIC shapes may be cached; user-specific-private data (drafts, sessions, owner-only
  views) is forbidden. Applied today to `GET /api/profiles/:username` (public base payload,
  60s TTL, key `profile:public:<username>`); `GET /api/professions` uses the same helpers.
- `cacheInvalidateEvent(event)` is the single invalidation entry point: it removes every entry
  (a) tagged with the event at `cacheSet` time **or** (b) stored under one of the event's mapped
  key prefixes (union — over-invalidation is always safe). Unknown events degrade to tag-only.
  `cacheInvalidatePrefix(prefix)` is the low-level primitive the mapping compiles to.
- Invalidations:

| Event | Fired by | Invalidates |
|---|---|---|
| `site.publish` | `POST /api/me/site/publish` | `profile:public:*` (+ the exact username key) |
| `site.unpublish` | `POST /api/me/site/unpublish` | `profile:public:*` (+ the exact username key) |
| `site.save` | `PUT /api/me/site` | reserved `site:draft:*` + the owner's `profile:public:<username>` key (defensive; draft saves cannot change the published snapshot) |
| `profile.update` | `PATCH /api/me/profile` | `profile:public:*` |
| `professions.changed` | taxonomy mutations (`src/lib/professions/service.ts`) | `profile:public:*` + `professions:*` |

- `PATCH /api/me/site` (watermark) deletes the owner's `profile:public:<username>` key directly
  since the watermark is a live setting embedded in the cached payload.
- Known trade-off: public profile payloads may lag up to 60s behind project-level
  publish/unpublish and profile-media changes; site-level events invalidate immediately.
