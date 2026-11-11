/**
 * App-level TTL cache with invalidation events — "Global Scale" phase (2-a).
 *
 * Single-process Map with TTL expiry, a hard entry cap (prune, then
 * oldest-first eviction) and TWO invalidation mechanisms that compose:
 *
 *  1. TAGS — `cacheSet(key, value, ttlMs, tags)` may attach logical event tags;
 *     `cacheInvalidateEvent(event)` removes every entry tagged with it.
 *  2. PREFIX MAP — known platform events are also mapped to key prefixes
 *     (below), so entries are invalidated even when their producer forgot (or
 *     had no reason) to tag them. Tag + prefix invalidation are UNIONED —
 *     over-invalidation is always safe, under-invalidation is not.
 *
 * Event → prefix map (docs/api.md §18):
 *   "site.publish"       → profile:public:*
 *   "site.unpublish"     → profile:public:*
 *   "site.save"          → site:draft:*          (reserved; drafts are private)
 *   "profile.update"     → profile:public:*
 *   "professions.changed"→ profile:public:* + professions:*
 *
 * ⚠️ PRIVATE DATA NEVER ENTERS THIS CACHE — only viewer-independent PUBLIC
 * shapes (published site config, public projects/collections, public profile
 * fields). Per-viewer data (drafts, isSelf extras, session state) is applied
 * AFTER cache retrieval by the consumers.
 *
 * Call-site contract (existing consumers depend on it):
 *   cacheKey(...parts)                  → collision-free, stable key string
 *   profilePublicCacheKey(username)     → "profile:public:<username>"
 *   cacheGet<T>(key)                    → T | null  (SYNC)
 *   cacheSet(key, value, ttlMs?, tags?) → void      (SYNC)
 *   cacheDelete(key)                    → void      (SYNC)
 *   cacheInvalidatePrefix(prefix)       → number removed (SYNC)
 *   cacheInvalidateEvent(event)         → number removed (SYNC)
 *   cacheStats()                        → { size, hits, misses }
 *
 * `cacheGet` stamps returned OBJECT values (never arrays/primitives) with a
 * `_cachedAt` debug timestamp — consumers must build explicit response shapes
 * so that field never leaks into API responses.
 */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  tags: string[];
}

const store = new Map<string, CacheEntry>();

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 2_000;

// Hit/miss counters (monotonic for the process lifetime) — surfaced via
// cacheStats() for the health/observability story.
let hits = 0;
let misses = 0;

// ---------- Keys ----------

/**
 * Build a namespaced cache key. Prefix convention: "<domain>:<view>[:<id>]".
 *
 * JSON-stable: every part is serialized unambiguously so two different part
 * tuples can never produce the same key (`cacheKey("a:b", "c")` ≠
 * `cacheKey("a", "b:c")` — the first colon-bearing part is JSON-encoded).
 * Plain string/number/boolean parts without reserved characters render
 * unchanged, so existing keys ("professions:flat", "profile:public:<username>")
 * keep their exact literal form.
 */
export function cacheKey(...parts: (string | number | boolean)[]): string {
  return parts
    .map((p) => {
      if (typeof p === "string" && !p.includes(":") && !p.includes('"')) return p;
      const json = JSON.stringify(p);
      return json === undefined ? String(p) : json;
    })
    .join(":");
}

/** Cache key for the public profile payload of a username. */
export function profilePublicCacheKey(username: string): string {
  return cacheKey("profile", "public", username);
}

// ---------- Core operations ----------

export function cacheGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) {
    misses += 1;
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    misses += 1;
    return null;
  }
  hits += 1;
  // Debug affordance (documented contract): stamp object values with the time
  // they were served from cache. Arrays/primitives are left untouched.
  if (entry.value !== null && typeof entry.value === "object" && !Array.isArray(entry.value)) {
    (entry.value as { _cachedAt?: number })._cachedAt = Date.now();
  }
  return entry.value as T;
}

export function cacheSet(key: string, value: unknown, ttlMs: number = DEFAULT_TTL_MS, tags: string[] = []): void {
  if (store.size >= MAX_ENTRIES) pruneExpired();
  if (store.size >= MAX_ENTRIES) {
    // Last-resort eviction: drop the oldest entry (Map preserves insertion order).
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs, tags });
}

export function cacheDelete(key: string): void {
  store.delete(key);
}

// ---------- Invalidation ----------

/**
 * Invalidate every entry whose key starts with `prefix`. Returns the number of
 * keys removed. Prefer `cacheInvalidateEvent` for the platform events below —
 * this is the low-level primitive (and what event mapping compiles to).
 */
export function cacheInvalidatePrefix(prefix: string): number {
  let removed = 0;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * The known platform events, mapped to the key prefixes a change of that kind
 * must invalidate. Union with tag-based matching in cacheInvalidateEvent.
 */
const EVENT_PREFIXES: Record<string, string[]> = {
  "site.publish": ["profile:public:"],
  "site.unpublish": ["profile:public:"],
  "site.save": ["site:draft:"],
  "profile.update": ["profile:public:"],
  "professions.changed": ["profile:public:", "professions:"],
};

/**
 * Invalidate every entry (a) tagged with `event` OR (b) living under one of
 * the event's mapped key prefixes. Returns the number of keys removed.
 * Unknown events fall back to tag-only matching (producers may extend the
 * vocabulary by tagging entries with new event strings).
 */
export function cacheInvalidateEvent(event: string): number {
  const prefixes = EVENT_PREFIXES[event] ?? [];
  let removed = 0;
  for (const [key, entry] of store) {
    if (entry.tags.includes(event) || prefixes.some((p) => key.startsWith(p))) {
      store.delete(key);
      removed += 1;
    }
  }
  return removed;
}

// ---------- Observability ----------

/** Cache health snapshot for /api/health-style introspection. */
export function cacheStats(): { size: number; hits: number; misses: number } {
  return { size: store.size, hits, misses };
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

// ===========================================================================
// SHARED BACKEND — "Post-Transformation Production Readiness" (P1)
// ===========================================================================
//
// The Map above is per-instance. Horizontally scaled deployments need the
// cache shared AND invalidated across instances. The async API below selects:
//   CACHE_BACKEND=memory  (default) → the Map above, exactly as before
//   CACHE_BACKEND=postgres          → shared `CacheEntry`/`CacheGeneration`
//                                     tables (src/lib/cache/shared.ts) with a
//                                     short-TTL local L1 buffer and generation-
//                                     based cross-instance invalidation.
//
// Safety contract carried by the shared path (enforced in shared.ts):
//   1. WHITELIST — only viewer-independent PUBLIC key namespaces
//      ("profile:public:*", "professions:*") may enter the shared store;
//      anything else is refused and served memory-only. Private user data
//      cannot leak through shared caching even if a future caller misuses
//      the API.
//   2. INVALIDATION — cacheInvalidateEventShared/cacheInvalidatePrefixShared
//      delete shared rows AND bump a namespace generation that every process
//      polls (≤1s), so every instance drops its local buffer.
//   3. FALLBACK — any shared-store failure flips the process to the memory
//      path for 30s (one structured log); the cache never takes a request
//      down.
//
// Consumers: use the *Shared variants below (await them). The sync Map API
// above remains for legacy/local-only helpers (e.g. lib/workspace-origin's
// private origin cache) and as the automatic fallback store.
// ===========================================================================

import {
  isSharedCacheKeyAllowed,
  sharedDelete,
  sharedGet,
  sharedInvalidateEvent as sharedInvalidateEventBackend,
  sharedInvalidatePrefix,
  sharedSet,
  sharedStats as sharedBackendStats,
} from "./shared";

export type CacheBackend = "memory" | "postgres";

let selectedCacheBackend: CacheBackend | null = null;

/** Resolve CACHE_BACKEND ("memory" default, "postgres" = shared store). Memoized. */
export function getCacheBackend(): CacheBackend {
  if (!selectedCacheBackend) {
    const choice = (process.env.CACHE_BACKEND ?? "memory").trim().toLowerCase();
    selectedCacheBackend = choice === "postgres" ? "postgres" : "memory";
  }
  return selectedCacheBackend;
}

export function sharedCacheEnabled(): boolean {
  return getCacheBackend() === "postgres";
}

/** Extended cache snapshot for /api/health. */
export function cacheHealthSnapshot(): {
  backend: CacheBackend;
  size: number;
  hits: number;
  misses: number;
  shared?: { l1: number; cooldown: boolean };
} {
  const base = { backend: getCacheBackend(), ...cacheStats() };
  if (base.backend !== "postgres") return base;
  return { ...base, shared: sharedBackendStats() };
}

/** Read-through: shared store when enabled (with local L1), else the Map. */
export async function cacheGetShared<T>(key: string): Promise<T | null> {
  if (!sharedCacheEnabled()) return cacheGet<T>(key);
  const shared = await sharedGet<T>(key);
  if (shared !== null) return shared;
  // On shared miss (or during an error cooldown) do NOT consult this
  // instance's Map: another instance may have invalidated newer state than
  // what our process last wrote. Miss = authoritative.
  return null;
}

/** Write-through: shared store when enabled (public keys only), always mirrored to the Map. */
export async function cacheSetShared(
  key: string,
  value: unknown,
  ttlMs: number = DEFAULT_TTL_MS,
  tags: string[] = []
): Promise<void> {
  cacheSet(key, value, ttlMs, tags); // per-instance mirror (fallback + local reads)
  if (!sharedCacheEnabled()) return;
  await sharedSet(key, value, ttlMs, tags);
}

export async function cacheDeleteShared(key: string): Promise<void> {
  cacheDelete(key);
  if (!sharedCacheEnabled()) return;
  await sharedDelete(key);
}

export async function cacheInvalidatePrefixShared(prefix: string): Promise<number> {
  const local = cacheInvalidatePrefix(prefix);
  if (!sharedCacheEnabled()) return local;
  return sharedInvalidatePrefix(prefix);
}

export async function cacheInvalidateEventShared(event: string): Promise<number> {
  const local = cacheInvalidateEvent(event);
  if (!sharedCacheEnabled()) return local;
  const prefixes = EVENT_PREFIXES[event] ?? [];
  return sharedInvalidateEventBackend(event, prefixes);
}

/**
 * Public-key whitelist re-exported for tests/ops. The shared store refuses
 * any key outside these namespaces — the enforcement point for "private user
 * data never leaks through shared caching".
 */
export { SHARED_CACHE_ALLOWED_PREFIXES, isSharedCacheKeyAllowed } from "./shared";
