import { afterAll, describe, expect, test } from "bun:test";

/**
 * Shared-cache FAILURE & FALLBACK regression — the failure posture of
 * src/lib/cache/shared.ts: "the cache must never take a request down".
 *
 *   - any shared-store error NEVER propagates: sharedSet → false,
 *     sharedGet → null (one structured fallback log line)
 *   - the process flips onto the memory path (30s cooldown) instead of
 *     failing the request
 *   - the per-instance memory tier keeps serving during the outage
 *
 * zz- prefix: this file runs LAST in the suite. Triggering the documented
 * outage path arms a 30-second in-memory cooldown inside shared.ts module
 * state that cannot be reset from outside, so the test is deliberately
 * isolated at the end of the run.
 *
 * Failure injection: the CacheEntry delegate's methods are temporarily
 * replaced with throwing stubs (originals restored in a finally block), so
 * the real PrismaClient singleton and the module registry stay untouched.
 */

import { db } from "@/lib/db";
import { cacheDelete, cacheGet, cacheGetShared, cacheSet } from "@/lib/cache";
import { sharedGet, sharedSet, sharedStats } from "@/lib/cache/shared";

const ALLOWED_KEY = "profile:public:qa-outage-probe";

type Delegate = Record<string, (...args: unknown[]) => unknown>;
const delegate = db.cacheEntry as unknown as Delegate;

/** Replace delegate methods with throwing stubs; returns a disposer. */
function armOutage(methods: string[]): () => void {
  const originals = new Map<string, ((...args: unknown[]) => unknown) | undefined>();
  const throwing = async () => {
    throw new Error("simulated shared-store outage");
  };
  for (const m of methods) {
    originals.set(m, delegate[m]);
    delegate[m] = throwing;
  }
  return () => {
    for (const [m, orig] of originals) {
      if (orig === undefined) delete delegate[m];
      else delegate[m] = orig;
    }
  };
}

afterAll(() => {
  cacheDelete(ALLOWED_KEY);
});

describe("shared cache failure → memory fallback (never throws)", () => {
  test("sharedSet failure → false, cooldown armed, no exception", async () => {
    const restore = armOutage(["upsert"]);
    try {
      const stored = await sharedSet(ALLOWED_KEY, { v: 1 }, 60_000, []);
      expect(stored).toBe(false); // fallback, not failure
      expect(sharedStats().cooldown).toBe(true);
    } finally {
      restore();
    }
  });

  test("sharedGet failure/cooldown → null (miss is authoritative), no exception", async () => {
    const restore = armOutage(["findUnique"]);
    try {
      const value = await sharedGet<{ v: number }>(ALLOWED_KEY);
      expect(value).toBeNull();
      expect(sharedStats().cooldown).toBe(true);
    } finally {
      restore();
    }
  });

  test("memory tier keeps serving while the shared store is in cooldown", () => {
    cacheSet(ALLOWED_KEY, { v: "memory" }, 60_000);
    expect(cacheGet<{ v: string }>(ALLOWED_KEY)?.v).toBe("memory");
  });

  test("memory-mode cacheGetShared unaffected by the shared outage", async () => {
    const value = await cacheGetShared<{ v: string }>(ALLOWED_KEY);
    expect(value?.v).toBe("memory");
    cacheDelete(ALLOWED_KEY);
  });
});
