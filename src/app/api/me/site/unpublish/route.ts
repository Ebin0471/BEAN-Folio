import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared } from "@/lib/api-helpers";
import { publicSitePath, publicSiteAbsoluteUrl } from "@/lib/site-url";
import { resolveShareOriginForRequest } from "@/lib/workspace-origin";
import { cacheDeleteShared, cacheInvalidateEventShared, profilePublicCacheKey } from "@/lib/cache";

export const dynamic = "force-dynamic";

/**
 * POST /api/me/site/unpublish — take the custom website offline.
 * The draft is preserved, so the owner can republish later. The website is
 * immediately removed from public access; the BEAN Folio public profile
 * (/u/<username>), which is an independent page, is unaffected. The response
 * still reports the address the website will return to on the next publish:
 * publicUrl (route form /site/<username>) always, canonicalUrl only when a
 * verified public origin exists (deployment configuration or the
 * origin-proof-verified environment host — see lib/site-url +
 * lib/workspace-origin; never an unverified request host). Until the next
 * publish the website is not served to anyone.
 */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  // Abuse-sensitive mutation (scale phase, 2-a): shared-backend limiter so the
  // bound holds across instances when RATE_LIMIT_BACKEND=postgres.
  const limited = await rateLimitShared("site-unpublish:" + user.id, 20, 60_000);
  if (limited) return limited;

  const share = await resolveShareOriginForRequest(req.headers);
  const canonical = share.ok ? publicSiteAbsoluteUrl(user.username, share.origin) : null;
  const kind = share.ok ? share.kind : null;
  const unavailable = share.ok ? null : { reason: share.reason, message: share.message };

  const design = await db.siteDesign.findUnique({ where: { userId: user.id } });
  if (!design || design.status !== "PUBLISHED") {
    return ok({
      status: "DRAFT",
      publishedAt: null,
      publicUrl: publicSitePath(user.username),
      canonicalUrl: canonical,
      canonicalKind: kind,
      canonicalUrlUnavailable: unavailable,
    });
  }

  const updated = await db.siteDesign.update({
    where: { userId: user.id },
    // Clear publishedAt too, so GET /api/me/site (which reports the stored
    // column) and this response agree: after unpublish there is no live
    // publication, hence no publication timestamp.
    data: { status: "DRAFT", publishedAt: null },
  });

  // Cache invalidation (scale phase, 2-a): visitors must stop seeing the
  // website immediately, not up to one cache TTL later. The public profile
  // payload embeds the site block, so drop it too.
  await cacheInvalidateEventShared("site.unpublish");
  if (user.username) await cacheDeleteShared(profilePublicCacheKey(user.username));

  return ok({
    status: updated.status,
    publishedAt: null,
    publicUrl: publicSitePath(user.username),
    canonicalUrl: canonical,
    canonicalKind: kind,
    canonicalUrlUnavailable: unavailable,
  });
});
