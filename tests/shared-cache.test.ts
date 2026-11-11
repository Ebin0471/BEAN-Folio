import { afterAll, describe, expect, test } from "bun:test";

/**
 * P1 — shared cache backend unit tests.
 *
 * The MULTI-INSTANCE behavior (two real processes sharing one store, cross-
 * process invalidation, atomic shared rate limiting) is verified by
 * `bun scripts/verify-shared-cache.ts` (its report feeds the production-
 * readiness doc). This file pins the in-process contracts:
 *   - memory path: with CACHE_BACKEND=memory (the default) the *Shared API
 *     delegates to the per-instance Map and never touches shared tables;
 *   - shared tier: the shared.ts functions round-trip through the CacheEntry
 *     table, refuse private keys (leak guard), invalidate by event/prefix,
 *     and drop the local L1 buffer when a namespace generation advances.
 */

import {
  cacheDeleteShared,
  cacheGetShared,
  cacheInvalidateEventShared,
  cacheSetShared,
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheKey,
  getCacheBackend,
  isSharedCacheKeyAllowed,
} from "@/lib/cache";
import {
  sharedSet,
  sharedGet,
  sharedDelete,
  sharedInvalidateEvent,
  sharedInvalidatePrefix,
} from "@/lib/cache/shared";
import { db } from "@/lib/db";

const K = (s: string) => cacheKey("profile", "public", `test-p1-${s}`);

afterAll(async () => {
  await db.cacheEntry.deleteMany({ where: { key: { startsWith: "profile:public:test-p1-" } } });
  await db.cacheEntry.deleteMany({ where: { key: { startsWith: "professions:test-p1-" } } });
  await db.cacheGeneration.deleteMany({ where: { namespace: { in: ["profile", "professions"] } } });
});

describe("P1 shared cache — backend selection", () => {
  test("default backend is memory (single-instance behavior preserved)", () => {
    expect(getCacheBackend()).toBe("memory");
  });
});

describe("P1 shared cache — private-data whitelist", () => {
  test("public namespaces are allowed", () => {
    expect(isSharedCacheKeyAllowed("profile:public:ada")).toBe(true);
    expect(isSharedCacheKeyAllowed("professions:flat")).toBe(true);
  });

  test("private namespaces are refused", () => {
    expect(isSharedCacheKeyAllowed("site:draft:u1")).toBe(false);
    expect(isSharedCacheKeyAllowed("me:draft:x")).toBe(false);
    expect(isSharedCacheKeyAllowed("session:abc")).toBe(false);
    expect(isSharedCacheKeyAllowed("insights:u1")).toBe(false);
  });

  test("sharedSet refuses a private key — no CacheEntry row, sharedGet returns null", async () => {
    const key = "me:draft:never-shared";
    const stored = await sharedSet(key, { secret: true }, 60_000, []);
    expect(stored).toBe(false);
    const row = await db.cacheEntry.findUnique({ where: { key } });
    expect(row).toBeNull();
    expect(await sharedGet(key)).toBeNull();
  });

  test("sharedGet refuses private keys even if a row existed", async () => {
    // Plant a row directly (simulating a tampered/legacy row) — reads are
    // still gated by the whitelist.
    await db.cacheEntry.create({
      data: {
        key: "me:draft:planted",
        value: JSON.stringify({ secret: "nope" }),
        namespace: "me",
        tags: "[]",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(await sharedGet("me:draft:planted")).toBeNull();
    await db.cacheEntry.deleteMany({ where: { key: "me:draft:planted" } });
  });
});

describe("P1 shared cache — memory path unchanged (CACHE_BACKEND=memory)", () => {
  test("cacheSetShared/cacheGetShared delegate to the Map; CacheEntry untouched", async () => {
    const key = K("memmode");
    await cacheSetShared(key, { hello: "memory" }, 60_000);
    expect(cacheGet<{ hello: string }>(key)?.hello).toBe("memory");
    const row = await db.cacheEntry.findUnique({ where: { key } });
    expect(row).toBeNull(); // memory backend never writes the shared table
    await cacheDeleteShared(key);
    expect(cacheGet(key)).toBeNull();
  });

  test("cacheInvalidateEventShared invalidates the Map by tag and prefix", async () => {
    const tagged = K("mem-tagged");
    const untagged = K("mem-untagged");
    cacheSet(tagged, { t: 1 }, 60_000, ["site.publish"]);
    cacheSet(untagged, { u: 1 }, 60_000);
    const removed = await cacheInvalidateEventShared("site.publish");
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(cacheGet(tagged)).toBeNull();
    expect(cacheGet(untagged)).toBeNull();
  });
});

describe("P1 shared cache — shared tier round-trip", () => {
  test("sharedSet/sharedGet round-trip through the CacheEntry table", async () => {
    const key = K("roundtrip");
    const stored = await sharedSet(key, { hello: "shared" }, 60_000, []);
    expect(stored).toBe(true);
    const row = await db.cacheEntry.findUnique({ where: { key } });
    expect(row).not.toBeNull();
    expect(row?.namespace).toBe("profile");
    const value = await sharedGet<{ hello: string }>(key);
    expect(value?.hello).toBe("shared");
    await sharedDelete(key);
    expect(await db.cacheEntry.findUnique({ where: { key } })).toBeNull();
    expect(await sharedGet(key)).toBeNull();
  });

  test("sharedGet stamps object values with _cachedAt; arrays untouched", async () => {
    const objKey = K("stamp-obj");
    const arrKey = K("stamp-arr");
    await sharedSet(objKey, { a: 1 }, 60_000, []);
    await sharedSet(arrKey, [{ slug: "x" }], 60_000, []);
    const obj = await sharedGet<{ a: number; _cachedAt?: number }>(objKey);
    const arr = await sharedGet<Array<{ slug: string; _cachedAt?: number }>>(arrKey);
    expect(typeof obj?._cachedAt).toBe("number");
    expect(arr?.[0]?.slug).toBe("x");
    expect(arr?.[0]?._cachedAt).toBeUndefined();
    await sharedDelete(objKey);
    await sharedDelete(arrKey);
  });

  test("sharedInvalidateEvent removes tagged AND prefix-matched entries", async () => {
    const tagged = K("ev-tagged");
    const untagged = K("ev-untagged");
    await sharedSet(tagged, { t: 1 }, 60_000, ["site.publish"]);
    await sharedSet(untagged, { u: 1 }, 60_000, []);
    expect(await sharedGet(untagged)).not.toBeNull();
    const removed = await sharedInvalidateEvent("site.publish", ["profile:public:"]);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await sharedGet(tagged)).toBeNull();
    expect(await sharedGet(untagged)).toBeNull();
  });

  test("sharedInvalidatePrefix removes by prefix and bumps the namespace generation", async () => {
    const a = K("px-a");
    const b = K("px-b");
    await sharedSet(a, { v: 1 }, 60_000, []);
    await sharedSet(b, { v: 2 }, 60_000, []);
    const genBefore = await db.cacheGeneration.findUnique({ where: { namespace: "profile" } });
    const removed = await sharedInvalidatePrefix("profile:public:test-p1-px-");
    expect(removed).toBe(2);
    expect(await sharedGet(a)).toBeNull();
    expect(await sharedGet(b)).toBeNull();
    const genAfter = await db.cacheGeneration.findUnique({ where: { namespace: "profile" } });
    expect((genAfter?.generation ?? 0)).toBeGreaterThan(genBefore?.generation ?? 0);
  });

  test("generation bump after invalidation drops the local L1 buffer", async () => {
    const key = K("gen");
    await sharedSet(key, { v: 1 }, 60_000, []);
    expect(await sharedGet(key)).not.toBeNull(); // now in L1
    // Another instance invalidates behind our back (direct shared-table ops —
    // exactly what a remote cacheInvalidateEventShared produces).
    await db.cacheEntry.deleteMany({ where: { key } });
    await db.cacheGeneration.upsert({
      where: { namespace: "profile" },
      create: { namespace: "profile", generation: 1 },
      update: { generation: { increment: 1 } },
    });
    // The local L1 entry carries a stale generation → dropped on next read.
    // (genCache refreshes at most once per second; wait past that bound.)
    await new Promise((r) => setTimeout(r, 1_200));
    expect(await sharedGet(key)).toBeNull();
  });
});
