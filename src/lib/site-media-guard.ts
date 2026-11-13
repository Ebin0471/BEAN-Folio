import { db } from "@/lib/db";

/**
 * Structural subset of a website config the media guard inspects — accepts
 * both the zod-parsed save payload (pages optional) and the normalized
 * SiteConfig, so the SAME guard runs on every save path.
 */
export interface SiteConfigLike {
  logoMediaId?: string | null;
  coverMediaId?: string | null;
  pages?: { sections: { type: string; videos?: { mediaId: string }[] }[] }[];
}

/**
 * Shared media-reference guard for website config saves — the IDOR boundary
 * for EVERY surface that persists a SiteConfig (the portfolio site PUT
 * /api/me/site and GIFTZ's GiftzSite saves).
 *
 * Rule: a saved config may only reference media the session user OWNS, and
 * reel-section media must be real VIDEO assets. Without this, a crafted
 * config could reference another user's PRIVATE media id and (once
 * published) make it publicly fetchable through /api/media/<id>/raw.
 *
 * Returns a user-safe error message, or null when every reference is valid.
 */
export async function siteConfigMediaError(config: SiteConfigLike, userId: string): Promise<string | null> {
  const mediaIds = [config.logoMediaId, config.coverMediaId].filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  const reelIds = new Set<string>();
  for (const page of config.pages ?? []) {
    for (const section of page.sections) {
      if (section.type === "reel") {
        for (const v of section.videos ?? []) {
          mediaIds.push(v.mediaId);
          reelIds.add(v.mediaId);
        }
      }
    }
  }
  if (mediaIds.length === 0) return null;

  const uniqueIds = [...new Set(mediaIds)];
  const owned = await db.mediaAsset.findMany({
    where: { id: { in: uniqueIds }, ownerId: userId },
    select: { id: true, kind: true },
  });
  if (owned.length !== uniqueIds.length) {
    return "Website media not found — upload the logo, cover or reel videos to your own account first.";
  }
  const badKind = owned.some((m) => reelIds.has(m.id) && m.kind !== "VIDEO");
  if (badKind) {
    return "Reel videos must be video files — pick videos from your own library.";
  }
  return null;
}
