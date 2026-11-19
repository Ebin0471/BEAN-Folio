/**
 * Pluggable rate-limit backends — "Global Scale" phase (2-a).
 *
 * The legacy `rateLimit()` helper in api-helpers is per-instance memory only.
 * This module adds a backend interface so limits can be shared across
 * instances (RATE_LIMIT_BACKEND=postgres) while keeping identical fixed-window
 * semantics:
 *
 *   hit(key, limit, windowMs) → { allowed, remaining, resetAt }
 *     - windowStart = floor(now / windowMs) * windowMs
 *     - the request that reaches count === limit is the last allowed one
 *       (i.e. allowed while count-after-increment <= limit)
 *     - blocked requests do NOT consume budget
 *     - `resetAt` is the epoch ms when the current window ends
 *
 * PII hygiene: Postgres bucket rows must never store raw keys (they contain
 * IPs/emails), so the full key is SHA-256 hashed before it touches the DB.
 * The memory backend never persists anything and keeps raw keys.
 *
 * Reliability: the limiter must never take a request down. If the shared
 * backend throws, `hitRateLimit` falls back to the in-memory backend for that
 * call (limits stay enforced, just per-instance) and logs one structured line.
 */

import { createHash } from "node:crypto";
import { db } from "@/lib/db";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Epoch ms when the current window ends (Retry-After can be derived from it). */
  resetAt: number;
}

export interface RateLimitBackend {
  /** Stable backend identifier (used in logs). */
  readonly name: string;
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

// ---------- Memory backend (default; per-instance) ----------

const MAX_BUCKETS = 5000;

export class MemoryRateLimitBackend implements RateLimitBackend {
  readonly name = "memory";
  private buckets = new Map<string, { count: number; resetAt: number }>();

  /**
   * Synchronous core with the exact semantics of the original api-helpers
   * `rateLimit()` (fixed window, 5000-key cap with prune). Kept on the
   * backend so the legacy sync helper and the async shared path share ONE
   * implementation.
   */
  hitSync(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      const resetAt = now + windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      if (this.buckets.size > MAX_BUCKETS) this.prune(now);
      return { allowed: true, remaining: Math.max(0, limit - 1), resetAt };
    }
    if (bucket.count >= limit) {
      return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
    }
    bucket.count += 1;
    return { allowed: true, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt };
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    return this.hitSync(key, limit, windowMs);
  }

  private prune(now: number) {
    for (const [k, v] of this.buckets) if (v.resetAt < now) this.buckets.delete(k);
  }

  /**
   * Test-support only: clears all in-memory buckets. Exists so the per-file
   * test runner can isolate quota-heavy suites from the burst buckets —
   * no production caller exists, and the shared (postgres) backend is
   * unaffected. This does NOT weaken any limit: production traffic never
   * invokes it.
   */
  resetForTests(): void {
    this.buckets.clear();
  }
}

export const memoryBackend = new MemoryRateLimitBackend();

// ---------- Postgres/SQLite shared backend (RateLimitBucket table) ----------

class PrismaRateLimitBackend implements RateLimitBackend {
  readonly name = "postgres";

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
    const expiresAt = new Date(windowStart.getTime() + windowMs);
    // PII hygiene: bucket rows are opaque — never store raw IPs/emails.
    const bucketKey = createHash("sha256").update(key).digest("hex");

    const row = await db.rateLimitBucket.upsert({
      where: { key_windowStart: { key: bucketKey, windowStart } },
      create: { key: bucketKey, windowStart, expiresAt, count: 1 },
      update: { count: { increment: 1 } },
    });

    // Opportunistic hygiene: rows are normally pruned by maintenance jobs,
    // but a cheap 1%-sampled sweep keeps the table bounded in single-node
    // deployments without one. Fire-and-forget — never blocks the caller.
    if (Math.random() < 0.01) {
      db.rateLimitBucket
        .deleteMany({ where: { expiresAt: { lt: new Date() } } })
        .catch(() => undefined);
    }

    const resetAt = expiresAt.getTime();
    return {
      allowed: row.count <= limit,
      remaining: Math.max(0, limit - row.count),
      resetAt,
    };
  }
}

export const postgresBackend = new PrismaRateLimitBackend();

// ---------- Selection (memoized) + resilient entry point ----------

let selectedBackend: RateLimitBackend | null = null;

/**
 * Resolve the configured backend from RATE_LIMIT_BACKEND ("memory" default,
 * "postgres" = shared RateLimitBucket table). Memoized after first call.
 */
export function getRateLimitBackend(): RateLimitBackend {
  if (!selectedBackend) {
    const choice = (process.env.RATE_LIMIT_BACKEND ?? "memory").trim().toLowerCase();
    selectedBackend = choice === "postgres" ? postgresBackend : memoryBackend;
  }
  return selectedBackend;
}

/**
 * Hit the selected backend; on any backend failure fall back to the in-memory
 * limiter for this call (limits stay enforced — per-instance — and the request
 * never fails because the limiter is down). One structured log line on fallback.
 */
export async function hitRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const backend = getRateLimitBackend();
  if (backend === memoryBackend) return memoryBackend.hitSync(key, limit, windowMs);
  try {
    return await backend.hit(key, limit, windowMs);
  } catch (e) {
    const error =
      e instanceof Error
        ? { name: e.name, message: e.message }
        : { name: "Error", message: String(e) };
    console.error(JSON.stringify({ event: "ratelimit.backend_fallback", backend, error }));
    return memoryBackend.hitSync(key, limit, windowMs);
  }
}
