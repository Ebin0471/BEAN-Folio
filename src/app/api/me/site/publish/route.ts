import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared } from "@/lib/api-helpers";
import { normalizeConfig } from "@/lib/site-config";
import { publicSitePath, publicSiteAbsoluteUrl } from "@/lib/site-url";
import { resolveShareOriginForRequest } from "@/lib/workspace-origin";
import { cacheDeleteShared, cacheInvalidateEventShared, profilePublicCacheKey } from "@/lib/cache";

export const dynamic = "force-dynamic";

/**
 * POST /api/me/site/publish — snapshot the current draft into the published slot.
 *
 * Publish requires a saved, schema-valid draft. The snapshot (not a live
 * reference) is stored, so later draft edits stay private until republished.
 * The website publishes to its OWN public route — /site/<username> — which is
 * fully independent of the BEAN Folio public profile (/u/<username>);
 * publishing never changes the profile page or project visibility.
 *
 * The response carries the canonical public address of the website:
 *  - publicUrl     — the route form "/site/<username>" (see lib/site-url);
 *  - canonicalUrl  — the fully-qualified shareable URL from a VERIFIED
 *                    source only: deployment configuration
 *                    (NEXT_PUBLIC_APP_URL / VERCEL_URL, kind
 *                    "production") or — for the current environment — the
 *                    edge host AFTER it passed the active origin-proof round
 *                    trip (kind "workspace", lib/workspace-origin). An
 *                    unverified request host is NEVER used: no proof, no
 *                    share URL. When nothing verifies, canonicalUrl is null
 *                    and canonicalUrlUnavailable explains exactly why. The
 *                    address is stable: republishing keeps it, only
 *                    unpublishing removes public access.
 */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  // Abuse-sensitive mutation (scale phase, 2-a): shared-backend limiter so the
  // bound holds across instances when RATE_LIMIT_BACKEND=postgres.
  const limited = await rateLimitShared("site-publish:" + user.id, 20, 60_000);
  if (limited) return limited;

  if (!user.username) {
    return err("Finish onboarding to claim your public URL before publishing.", 400);
  }

  const design = await db.siteDesign.findUnique({ where: { userId: user.id } });
  if (!design?.draftConfig) {
    return err("Save your website draft before publishing.", 400);
  }

  const config = normalizeConfig(design.draftConfig);
  if (!config) {
    // Corrupt/legacy draft — refuse rather than publish something invalid.
    return err("The saved draft is not a valid website configuration. Re-save it from the editor.", 400);
  }

  const published = await db.siteDesign.upsert({
    where: { userId: user.id },
    update: {
      publishedConfig: design.draftConfig,
      status: "PUBLISHED",
      publishedAt: new Date(),
    },
    create: {
      userId: user.id,
      draftConfig: design.draftConfig,
      publishedConfig: design.draftConfig,
      status: "PUBLISHED",
      publishedAt: new Date(),
    },
  });

  // Cache invalidation (scale phase, 2-a): the public profile payload embeds
  // the PUBLISHED site config, so drop it the moment the snapshot changes.
  await cacheInvalidateEventShared("site.publish");
  await cacheDeleteShared(profilePublicCacheKey(user.username));

  const share = await resolveShareOriginForRequest(req.headers);
  return ok({
    status: published.status,
    publishedAt: published.publishedAt?.toISOString() ?? null,
    publicUrl: publicSitePath(user.username),
    canonicalUrl: share.ok ? publicSiteAbsoluteUrl(user.username, share.origin) : null,
    canonicalKind: share.ok ? share.kind : null,
    canonicalUrlUnavailable: share.ok ? null : { reason: share.reason, message: share.message },
  });
});
