import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * Public-profile cache regression tests (hotfix follow-up).
 *
 * Pins the caching contract of src/lib/public-profile.ts against the ONE
 * cache module (src/lib/cache/index.ts + shared.ts — there is no
 * src/lib/cache.ts file):
 *   - cache miss  → lean DB fallback; metadata never writes the cache
 *   - cache hit   → the cached PUBLIC payload is served (values the DB row
 *     cannot produce prove the cache-first path)
 *   - cache expiry → fresh DB columns re-decide visibility: a profile that
 *     became PRIVATE while its payload was cached must never leak through
 *     stale cache
 *   - "profile.update" event invalidation drops the cached payload
 *   - the profile:public namespace sits inside the shared-tier whitelist,
 *     and the *Shared API round-trips in memory mode
 *
 * Follows the qa-fixture discipline of p3-public-meta.test.ts: real dev-DB
 * rows created in beforeAll, deleted in afterAll, qa-only usernames.
 */

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import {
  cacheDeleteShared,
  cacheGetShared,
  cacheInvalidateEventShared,
  cacheInvalidatePrefix,
  cacheSetShared,
  isSharedCacheKeyAllowed,
  profilePublicCacheKey,
} from "@/lib/cache";
import { getPublicProfileMeta } from "@/lib/public-profile";

const USERNAME = "qa-pubcache";
const EMAIL = "qa-pubcache@beanfolio.test";

let userId = "";

/** Cached payload whose values the DB row can never produce. */
const CACHED_PAYLOAD = {
  profile: {
    name: "Cached Display Name",
    username: USERNAME,
    headline: "FROM-CACHE-HEADLINE",
    bio: "cached-bio",
    avatarUrl: null as string | null,
  },
  site: null,
};

async function seedCache(ttlMs = 60_000): Promise<void> {
  await cacheSetShared(profilePublicCacheKey(USERNAME), CACHED_PAYLOAD, ttlMs);
}

beforeAll(async () => {
  userId = (
    await db.user.create({
      data: {
        email: EMAIL,
        name: "Pubcache Real Name",
        username: USERNAME,
        passwordHash: await hashPassword("qa-only-password-123"),
        bio: "Real DB bio",
        headline: "Real DB headline",
        profileVisibility: "PUBLIC",
      },
    })
  ).id;
  await cacheDeleteShared(profilePublicCacheKey(USERNAME));
});

afterAll(async () => {
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await cacheInvalidatePrefix(profilePublicCacheKey(USERNAME));
  await cacheDeleteShared(profilePublicCacheKey(USERNAME));
});

describe("public profile cache — miss / hit / expiry", () => {
  test("cache MISS → lean DB fallback returns real metadata", async () => {
    await cacheDeleteShared(profilePublicCacheKey(USERNAME));
    const meta = await getPublicProfileMeta(USERNAME);
    expect(meta).not.toBeNull();
    expect(meta?.name).toBe("Pubcache Real Name");
    expect(meta?.headline).toBe("Real DB headline");
    expect(meta?.bio).toBe("Real DB bio");
    expect(meta?.username).toBe(USERNAME);
  });

  test("cache HIT → cached payload is served, not the DB row", async () => {
    await seedCache();
    const meta = await getPublicProfileMeta(USERNAME);
    expect(meta?.name).toBe("Cached Display Name");
    expect(meta?.headline).toBe("FROM-CACHE-HEADLINE");
    expect(meta?.bio).toBe("cached-bio");
  });

  test("cache EXPIRATION → fresh columns re-decide visibility (no stale leak)", async () => {
    await seedCache(40); // 40 ms TTL
    await db.user.update({ where: { id: userId }, data: { profileVisibility: "PRIVATE" } });
    await new Promise((r) => setTimeout(r, 150)); // past expiry
    const meta = await getPublicProfileMeta(USERNAME);
    expect(meta).toBeNull(); // private again → generic noindex metadata
    await db.user.update({ where: { id: userId }, data: { profileVisibility: "PUBLIC" } });
  });

  test("profile.update invalidation drops a fresh cached payload (private never leaks)", async () => {
    await seedCache();
    await db.user.update({ where: { id: userId }, data: { profileVisibility: "PRIVATE" } });
    const removed = await cacheInvalidateEventShared("profile.update");
    expect(removed).toBeGreaterThanOrEqual(1);
    const meta = await getPublicProfileMeta(USERNAME);
    expect(meta).toBeNull();
    await db.user.update({ where: { id: userId }, data: { profileVisibility: "PUBLIC" } });
  });

  test("public again → fresh DB metadata (ladder recovered after invalidation)", async () => {
    await cacheDeleteShared(profilePublicCacheKey(USERNAME));
    const meta = await getPublicProfileMeta(USERNAME);
    expect(meta?.name).toBe("Pubcache Real Name");
    expect(meta?.headline).toBe("Real DB headline");
  });
});

describe("public profile cache — shared-tier boundary", () => {
  test("profilePublicCacheKey output is inside the shared whitelist", () => {
    expect(profilePublicCacheKey(USERNAME)).toBe(`profile:public:${USERNAME}`);
    expect(isSharedCacheKeyAllowed(profilePublicCacheKey(USERNAME))).toBe(true);
  });

  test("memory-mode cacheGetShared serves the profile payload (Shared API preserved)", async () => {
    await seedCache();
    const block = await cacheGetShared<{ profile?: { name?: string } }>(
      profilePublicCacheKey(USERNAME)
    );
    expect(block?.profile?.name).toBe("Cached Display Name");
    await cacheDeleteShared(profilePublicCacheKey(USERNAME));
  });
});
