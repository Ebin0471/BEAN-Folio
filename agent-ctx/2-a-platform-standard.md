# Task 2-a — Platform standard: request IDs, structured logging, rate-limit backends, app cache

Agent: 2-a (platform core / "Global Scale"). Date: 2026-11-05.
Status: **Complete.** `bunx tsc --noEmit` → 0 errors · `bun run lint` → clean ·
`bun test tests/auth-routes.test.ts tests/media-upload-route.test.ts tests/security-hardening.test.ts` → **23 pass / 0 fail**
(also re-ran `tests/profession-taxonomy.test.ts` → 14 pass, since it consumes `@/lib/cache`).

Note for other agents: parts of this surface had already been materialized by a prior pass
(cache.ts header comment references task 2-c); this pass reconciled the implementation with the
2-a spec and closed every gap. Call-site contracts are UNCHANGED for existing consumers.

## File-by-file changes

### 1. `src/lib/api-helpers.ts` (complete — verified against spec)
- Request IDs: `REQUEST_ID_RE` (L31) validates incoming `x-request-id`
  (`/^[A-Za-z0-9_-]{8,64}$/`, else fresh UUID); AsyncLocalStorage `requestStorage` (L39);
  `getRequestId()` (L46-48, `null` outside requests).
- `handler()` (L211-260): sets `x-request-id` on EVERY response (success L231 + error L255);
  on uncaught error emits ONE structured JSON line
  `{"event":"api.error","requestId","method","path","status","durationMs","error":{name,message}}`
  with `stack` only when `NODE_ENV !== "production"` (L249-253); maps `PayloadTooLargeError` → 413.
- `parseBodySized(req, schema, maxBytes = 256_000)` (L65-96): Content-Length short-circuit,
  `Buffer.byteLength` check → typed 413 `payload_too_large`, then zod parse.
  `parseBody` (L103-108) delegates with 1 MB budget — signature/compat preserved.
- `rateLimit()` stays SYNC (L136-138, delegates to `memoryBackend.hitSync`).
- NEW `rateLimitShared(key, limit, windowMs)` (L148-154): async, consults the configured
  backend, returns ready 429 + `Retry-After` or `null`. Abuse-sensitive routes should adopt it.
- Also (pre-existing, untouched): `getClientKey` (rightmost XFF), `ERR.*`, `IS_POSTGRES`,
  `containsCI`, `resolveViewerKey`, `utcDay`, `USERNAME_RE`.

### 2. `src/lib/rate-limit-backend.ts` (complete — verified)
- `RateLimitResult { allowed, remaining, resetAt }` (L28-33); `RateLimitBackend` interface (L35-39).
- `MemoryRateLimitBackend` (L45-78): fixed window, 5000-key cap + prune, `hitSync` core shared
  with the legacy sync helper; blocked requests never consume budget.
- `PrismaRateLimitBackend` (L84-116): upsert into `RateLimitBucket`
  (`windowStart = floor(now/windowMs)*windowMs`, create count 1 / update increment 1), keys
  SHA-256-hashed (PII hygiene), 1%-sampled fire-and-forget expiry sweep.
- `getRateLimitBackend()` (L128-134): `RATE_LIMIT_BACKEND` env ("memory" default | "postgres"),
  memoized.
- `hitRateLimit()` (L141-154): on any backend error → memory fallback for that call + one
  `{"event":"ratelimit.backend_fallback",...}` log. Limiter can never 500 a request.

### 3. `src/lib/cache.ts` (UPGRADED this pass — full 2-a surface)
Exported API surface (backward compatible; `tags` param and `_cachedAt` stamping kept):
- `cacheKey(...parts: (string|number|boolean)[]): string` — now collision-free/JSON-stable
  (parts containing `:` or `"` are JSON-encoded); existing keys (`professions:*`,
  `profile:public:<username>`) render byte-identical. (L41-56)
- `profilePublicCacheKey(username)` → `profile:public:<username>`. (L59-61)
- `cacheGet<T>(key): T | null` — TTL-checked, counts hits/misses, stamps `_cachedAt` on object
  values (documented contract — never spread a cached object into a response). (L68-87)
- `cacheSet(key, value, ttlMs? = 5min, tags? = [])` — cap now **2000** entries, prune-then-evict
  oldest. (L89-98)
- `cacheDelete(key)`. (L100-102)
- **NEW** `cacheInvalidatePrefix(prefix): number` — deletes keys starting with prefix. (L109-117)
- `cacheInvalidateEvent(event): number` — now the UNION of (a) tag match and (b) built-in
  event→prefix map: `site.publish`/`site.unpublish`/`profile.update` → `profile:public:`,
  `site.save` → `site:draft:`, `professions.changed` → `profile:public:` + `professions:`.
  Unknown events degrade to tag-only. (L120-147)
- **NEW** `cacheStats(): { size, hits, misses }`. (L152-154)

### 4. Cache consumer routes (owned touchpoints)
- `src/app/api/profiles/[username]/route.ts` — already had explicit `profileSelect` narrowing
  (no `passwordHash`/`recoveryKeyHash`/email/role; ladder inputs `isDemo`/`deletedAt`/
  `profileVisibility` selected fresh, never cached) + 60s cache of the viewer-independent base
  under `profile:public:<username>`; per-viewer extras applied after retrieval. Verified the
  select covers every field the builder/ladder reads. No changes needed this pass.
- `src/app/api/me/site/route.ts` — **PUT** now also drops the owner's
  `profilePublicCacheKey` after `cacheInvalidateEvent("site.save")` (L116-122, spec deliverable
  3b; over-invalidation is deliberate insurance). GET untouched.
- `src/app/api/me/site/publish/route.ts` / `unpublish/route.ts` — invalidation touchpoints were
  already present (`site.publish`/`site.unpublish` + exact key delete); untouched.

### 5. `rateLimitShared` adoption (routes I own)
- `me/site/route.ts` — PUT `site-save:<userId>` 60/min (L64-65); PATCH watermark
  `site-watermark:<userId>` 30/min (L143-144).
- `me/site/publish/route.ts` — `site-publish:<userId>` 20/min (L38-41).
- `me/site/unpublish/route.ts` — `site-unpublish:<userId>` 20/min (L26-29).
All checked AFTER auth (keyed per user). No test hits these routes; limits are far above
human/autosave usage.

### 6. `src/app/api/route.ts`
Already wrapped in `handler()`; body `{ ok: true, service: "bean-folio", time }` unchanged
(no test asserts this body — verified). Carries `x-request-id` now.

### 7. `docs/api.md` (§1 + §18 updates)
- §1 rate-limit table: new row — site builder mutations 20–60/min per user via
  `rateLimitShared`.
- §18 "Platform standard (scale phase)": helpers line corrected (collision-free `cacheKey`,
  oldest-entry eviction, ≤2000 entries); documented the event→prefix union mechanism and
  `cacheInvalidatePrefix`; event table updated (site.save now includes the defensive owner-key
  delete; profile.update / professions.changed marked as WIRED, not "to be wired");
  rate-limit section notes the site-builder routes adopted `rateLimitShared`.

## For downstream agents
- Import surface you may rely on: `cacheGet, cacheSet, cacheDelete, cacheInvalidatePrefix,
  cacheInvalidateEvent, cacheKey, profilePublicCacheKey, cacheStats` from `@/lib/cache`;
  `rateLimitShared` from `@/lib/api-helpers`; `getRateLimitBackend / hitRateLimit /
  MemoryRateLimitBackend / memoryBackend / postgresBackend / RateLimitBackend /
  RateLimitResult` from `@/lib/rate-limit-backend`.
- If you cache anything, key it under a prefix mapped by an event above (or tag it with the
  event string) so invalidation stays automatic. NEVER cache private/per-viewer data.
- The professions service's tag-based usage (`cacheSet(..., [PROFESSIONS_CHANGED_EVENT])`)
  keeps working — tags and prefix mapping are unioned.
