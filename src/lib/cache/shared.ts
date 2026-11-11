/**
 * Shared cache backend — "Post-Transformation Production Readiness" (P1).
 *
 * A second storage tier for the app cache that lives in the DATABASE
 * (`CacheEntry` table — works on the SQLite dev database AND on managed
 * PostgreSQL in production, no extra infrastructure). Enabled with
 * CACHE_BACKEND=postgres so horizontally scaled instances read one shared
 * store and see each other's invalidation.
 *
 * ── Private-data safety (the hard rule) ─────────────────────────────────
 * The shared store accepts ONLY whitelisted PUBLIC key namespaces
 * (`SHARED_CACHE_ALLOWED_PREFIXES` — "profile:public:*", "professions:*").
 * Any other key is REFUSED here (one structured log line) and falls back to
 * the per-instance memory cache, which is never shared. A future caller that
 * tries to cache a draft, a session, or any per-viewer payload under a new
 * key cannot leak it through the shared tier — the write boundary is the
 * whitelist, not caller discipline.
 *
 * ── Cross-instance invalidation (generation counters) ───────────────────
 * No message broker is required: every entry belongs to a namespace (the
 * first key segment). Invalidation bumps the namespace's generation in the
 * `CacheGeneration` table (atomic upsert-increment) and deletes the shared
 * rows. Every process re-reads the (tiny) generation table at most once per
 * GEN_POLL_MS and drops its local L1 buffer for any namespace whose
 * generation advanced. Result: a publish/unpublish on instance A invalidates
 * instance B's memory buffer within the poll interval, and B's next read
 * goes back to the shared store (or the database) — never to stale memory.
 *
 * ── Failure posture ─────────────────────────────────────────────────────
 * The cache must never take a request down. Any shared-store error flips
 * this process onto the memory-only path for SHARED_ERROR_COOLDOWN_MS (one
 * structured log line per outage) — limits stay per-instance, correctness
 * is preserved, and recovery is automatic when the store returns.
 */

import { db } from "@/lib/db";

/** Public key namespaces allowed into the shared store. EVERYTHING else is refused. */
export const SHARED_CACHE_ALLOWED_PREFIXES = ["profile:public:", "professions:"] as const;

/** Local L1 buffer TTL — bounds staleness even without a generation bump. */
export const L1_TTL_MS = 2_000;
/** Generation poll cadence — bounds cross-instance invalidation propagation. */
export const GEN_POLL_MS = 1_000;
/** Hard entry cap for the shared store (prune sampled on write). */
export const MAX_SHARED_ENTRIES = 5_000;
/** How long this process stays on the memory path after a shared-store error. */
export const SHARED_ERROR_COOLDOWN_MS = 30_000;

interface L1Entry {
  value: unknown;
  expiresAt: number; // min(shared expiry, now + L1_TTL_MS)
  gen: number;
  tags: string[];
}

const l1 = new Map<string, L1Entry>();
const L1_MAX = 4_000;

const genCache = new Map<string, { gen: number; fetchedAt: number }>();
let sharedDisabledUntil = 0;
let lastFallbackLogAt = 0;

export function namespaceOf(key: string): string {
  return key.split(":")[0] || key;
}

function logFallback(error: unknown, op: string): void {
  if (Date.now() - lastFallbackLogAt < 5_000) return; // ≤1 line / 5s per outage
  lastFallbackLogAt = Date.now();
  console.error(
    JSON.stringify({
      event: "cache.shared_fallback",
      op,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    })
  );
}

function sharedAvailable(): boolean {
  return Date.now() >= sharedDisabledUntil;
}

function disableSharedForCooldown(): void {
  sharedDisabledUntil = Date.now() + SHARED_ERROR_COOLDOWN_MS;
}

// ---------------------------------------------------------------- generations

async function currentGeneration(namespace: string): Promise<number> {
  const cached = genCache.get(namespace);
  if (cached && Date.now() - cached.fetchedAt < GEN_POLL_MS) return cached.gen;
  try {
    // One tiny SELECT refreshes the whole map (namespaces ≤ whitelist size).
    const rows = await db.cacheGeneration.findMany();
    genCache.clear();
    for (const row of rows) genCache.set(row.namespace, { gen: row.generation, fetchedAt: Date.now() });
    return genCache.get(namespace)?.gen ?? 0;
  } catch (e) {
    disableSharedForCooldown();
    logFallback(e, "generation_poll");
    return cached?.gen ?? 0;
  }
}

async function bumpGeneration(namespace: string): Promise<void> {
  // Atomic upsert-increment: two instances invalidating concurrently both
  // land a monotonic bump (row lock serializes; each read-back is fresh).
  await db.cacheGeneration.upsert({
    where: { namespace },
    create: { namespace, generation: 1 },
    update: { generation: { increment: 1 } },
  });
  const row = await db.cacheGeneration.findUnique({ where: { namespace }, select: { generation: true } });
  genCache.set(namespace, { gen: row?.generation ?? 0, fetchedAt: Date.now() });
}

// ---------------------------------------------------------------------- L1

function l1Get(key: string, gen: number): unknown | undefined {
  const entry = l1.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now() || entry.gen !== gen) {
    l1.delete(key);
    return undefined;
  }
  return entry.value;
}

function l1Set(key: string, value: unknown, expiresAt: number, gen: number, tags: string[]): void {
  if (l1.size >= L1_MAX) {
    const oldest = l1.keys().next().value;
    if (oldest !== undefined) l1.delete(oldest);
  }
  l1.set(key, { value, expiresAt: Math.min(expiresAt, Date.now() + L1_TTL_MS), gen, tags });
}

function l1InvalidatePrefix(prefix: string): void {
  for (const key of l1.keys()) if (key.startsWith(prefix)) l1.delete(key);
}

function l1InvalidateTag(tag: string): void {
  for (const [key, entry] of l1) if (entry.tags.includes(tag)) l1.delete(key);
}

// ----------------------------------------------------------------- shared ops

/** Stamp object values with `_cachedAt` (same debug contract as the memory cache). */
function stamp(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    (value as { _cachedAt?: number })._cachedAt = Date.now();
  }
  return value;
}

/** True when this key is allowed into the SHARED store (public data only). */
export function isSharedCacheKeyAllowed(key: string): boolean {
  return (SHARED_CACHE_ALLOWED_PREFIXES as readonly string[]).some((p) => key.startsWith(p));
}

export async function sharedGet<T>(key: string): Promise<T | null> {
  if (!isSharedCacheKeyAllowed(key)) return null; // never even read private keys from the shared tier
  if (!sharedAvailable()) return null;

  try {
    const gen = await currentGeneration(namespaceOf(key));
    const local = l1Get(key, gen);
    if (local !== undefined) return stamp(local) as T;

    const row = await db.cacheEntry.findUnique({ where: { key } });
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      if (row) await db.cacheEntry.delete({ where: { key } }).catch(() => undefined);
      l1.delete(key);
      return null;
    }
    const value = JSON.parse(row.value) as T;
    l1Set(key, value, row.expiresAt.getTime(), gen, safeTags(row.tags));
    return stamp(value) as T;
  } catch (e) {
    disableSharedForCooldown();
    logFallback(e, "get");
    return null;
  }
}

function safeTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export async function sharedSet(key: string, value: unknown, ttlMs: number, tags: string[]): Promise<boolean> {
  // WRITE BOUNDARY: private data can never enter the shared tier.
  if (!isSharedCacheKeyAllowed(key)) {
    console.warn(JSON.stringify({ event: "cache.shared_refused", key, reason: "key not in public whitelist" }));
    return false;
  }
  if (!sharedAvailable()) return false;

  try {
    const namespace = namespaceOf(key);
    const gen = await currentGeneration(namespace);
    const expiresAt = new Date(Date.now() + ttlMs);
    const payload = JSON.stringify(value ?? null);
    await db.cacheEntry.upsert({
      where: { key },
      create: { key, value: payload, namespace, tags: JSON.stringify(tags), expiresAt },
      update: { value: payload, namespace, tags: JSON.stringify(tags), expiresAt },
    });
    l1Set(key, value, expiresAt.getTime(), gen, tags);
    void pruneSharedSampled();
    return true;
  } catch (e) {
    disableSharedForCooldown();
    logFallback(e, "set");
    return false;
  }
}

export async function sharedDelete(key: string): Promise<void> {
  if (!isSharedCacheKeyAllowed(key)) return;
  if (!sharedAvailable()) return;
  try {
    await db.cacheEntry.deleteMany({ where: { key } });
    l1.delete(key);
  } catch (e) {
    disableSharedForCooldown();
    logFallback(e, "delete");
  }
}

export async function sharedInvalidatePrefix(prefix: string): Promise<number> {
  if (!sharedAvailable()) return 0;
  try {
    const res = await db.cacheEntry.deleteMany({ where: { key: { startsWith: prefix } } });
    l1InvalidatePrefix(prefix);
    await bumpGeneration(namespaceOf(prefix)).catch(() => undefined);
    return res.count;
  } catch (e) {
    disableSharedForCooldown();
    logFallback(e, "invalidatePrefix");
    return 0;
  }
}

export async function sharedInvalidateEvent(event: string, prefixes: string[]): Promise<number> {
  if (!sharedAvailable()) return 0;
  try {
    const where = {
      OR: [...prefixes.map((p) => ({ key: { startsWith: p } })), { tags: { contains: `"${event}"` } }],
    };
    // Collect affected namespaces first (bounded table) so their generations bump.
    const affected = new Set<string>(prefixes.map(namespaceOf));
    const rows = await db.cacheEntry.findMany({ where, select: { namespace: true }, take: 1_000 });
    for (const row of rows) affected.add(row.namespace);

    const res = await db.cacheEntry.deleteMany({ where });
    l1InvalidateTag(event);
    for (const prefix of prefixes) l1InvalidatePrefix(prefix);
    for (const ns of affected) await bumpGeneration(ns).catch(() => undefined);
    return res.count;
  } catch (e) {
    disableSharedForCooldown();
    logFallback(e, "invalidateEvent");
    return 0;
  }
}

/** Sampled hygiene (1% of writes): expire old rows; evict oldest when over cap. */
async function pruneSharedSampled(): Promise<void> {
  if (Math.random() >= 0.01) return;
  try {
    await db.cacheEntry.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const size = await db.cacheEntry.count();
    if (size > MAX_SHARED_ENTRIES) {
      const doomed = await db.cacheEntry.findMany({
        orderBy: { updatedAt: "asc" },
        take: Math.min(1_000, size - MAX_SHARED_ENTRIES),
        select: { key: true },
      });
      await db.cacheEntry.deleteMany({ where: { key: { in: doomed.map((d) => d.key) } } });
    }
  } catch {
    // hygiene is best-effort — never surface
  }
}

/** Shared-store snapshot for /api/health. */
export function sharedStats(): { backend: "postgres"; l1: number; cooldown: boolean } {
  return { backend: "postgres", l1: l1.size, cooldown: !sharedAvailable() };
}
