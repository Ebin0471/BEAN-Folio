import { db } from "@/lib/db";
import { cacheGetShared, profilePublicCacheKey } from "@/lib/cache";
import { isProfilePubliclyVisible } from "@/lib/visibility";

/**
 * Server-side public-profile metadata source (P3 — public portfolio
 * performance).
 *
 * The SPA document is one shared `/` file; when it is served AT a public path
 * (`/u/<username>`, seeded by src/proxy.ts) the document's generateMetadata
 * uses THIS module to emit real, per-creator SEO/social tags in the initial
 * HTML — so crawlers that never execute JavaScript (social cards, search
 * bots) still see the creator's name, headline and image.
 *
 * Data discipline:
 *  - The CACHED public payload (same shared key the API route fills) is the
 *    preferred source — metadata adds no extra query on cache hits.
 *  - On a cache miss a LEAN query fetches only the metadata fields (never the
 *    4-query fan-out) and writes nothing to the cache — the API route owns
 *    cache population.
 *  - The visibility ladder runs on FRESH columns every call: demo fixtures
 *    and PRIVATE profiles return null → the document emits generic, noindex
 *    metadata. A draft or private profile can never surface its name, bio or
 *    imagery through this path.
 */

export interface PublicProfileMeta {
  name: string;
  username: string;
  headline: string | null;
  bio: string | null;
  avatarMediaId: string | null;
  siteName: string | null;
  siteTagline: string | null;
}

/** Shape of the cached public payload's site block (subset we read). */
interface CachedSiteBlock {
  status?: "PUBLISHED" | "NONE";
  config?: { name?: string; tagline?: string } | null;
}

/** Shape of the cached public payload (subset we read). */
interface CachedProfileBlock {
  profile?: {
    name?: string;
    username?: string;
    headline?: string | null;
    bio?: string | null;
    avatarUrl?: string | null;
  };
  site?: CachedSiteBlock | null;
}

/** Minimal columns needed to decide visibility + compose metadata. */
const metaSelect = {
  id: true,
  username: true,
  name: true,
  headline: true,
  bio: true,
  avatarMediaId: true,
  isDemo: true,
  deletedAt: true,
  profileVisibility: true,
} as const;

export async function getPublicProfileMeta(username: string): Promise<PublicProfileMeta | null> {
  const uname = username.trim().toLowerCase();
  if (!uname) return null;

  // 1) Cached public payload (identical key + shape the API route publishes).
  const cached = await cacheGetShared<CachedProfileBlock>(profilePublicCacheKey(uname));
  if (cached?.profile?.name) {
    return {
      name: cached.profile.name,
      username: cached.profile.username ?? uname,
      headline: cached.profile.headline ?? null,
      bio: cached.profile.bio ?? null,
      avatarMediaId: extractAvatarId(cached.profile.avatarUrl),
      siteName: cached.site?.config?.name ?? null,
      siteTagline: cached.site?.config?.tagline ?? null,
    };
  }

  // 2) Lean fallback query — metadata fields only, no cache write.
  const row = await db.user.findUnique({
    where: { username: uname },
    select: metaSelect,
  });
  if (!row) return null;
  if (!isProfilePubliclyVisible(row, false)) return null;

  // The published website snapshot (only status=PUBLISHED) may carry the
  // creator's own site name/tagline — used for the title exactly like the
  // client SEO path. Draft configs are never read here.
  let siteName: string | null = null;
  let siteTagline: string | null = null;
  const site = await db.siteDesign.findFirst({
    where: { userId: row.id, status: "PUBLISHED" },
    select: { publishedConfig: true },
  });
  if (site?.publishedConfig) {
    try {
      const cfg = JSON.parse(site.publishedConfig) as { name?: unknown; tagline?: unknown };
      if (typeof cfg.name === "string" && cfg.name.trim()) siteName = cfg.name.slice(0, 120);
      if (typeof cfg.tagline === "string" && cfg.tagline.trim()) siteTagline = cfg.tagline.slice(0, 200);
    } catch {
      // unreadable snapshot → site fields stay null (never fabricated)
    }
  }

  return {
    name: row.name,
    username: row.username ?? uname,
    headline: row.headline,
    bio: row.bio,
    avatarMediaId: row.avatarMediaId,
    siteName,
    siteTagline,
  };
}

/**
 * The cached profile block carries avatarUrl ("/api/media/<id>/raw") — derive
 * the media id for the og:image absolute URL. Root-relative avatarUrl would
 * need the configured origin anyway; keeping the ID lets generateMetadata
 * decide (absolute when an origin exists, omitted otherwise).
 */
function extractAvatarId(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null;
  const match = /^\/api\/media\/([^/]+)\/raw$/.exec(avatarUrl);
  return match ? match[1] : null;
}
