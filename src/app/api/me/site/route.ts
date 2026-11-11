import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, parseBody, handler, rateLimitShared } from "@/lib/api-helpers";
import { normalizeConfig, siteConfigSchema } from "@/lib/site-config";
import { publicSitePath, publicSiteAbsoluteUrl } from "@/lib/site-url";
import { resolveShareOriginForRequest } from "@/lib/workspace-origin";
import { cacheDeleteShared, cacheInvalidateEventShared, profilePublicCacheKey } from "@/lib/cache";

export const dynamic = "force-dynamic";

/**
 * GET /api/me/site — the owner's current draft + published snapshot + public URL.
 * Drafts are private: this endpoint is owner-scoped by definition. publicUrl is
 * the canonical ROUTE form (no leading "#"). canonicalUrl is the fully-qualified
 * shareable address built ONLY from a verified source — deployment
 * configuration (NEXT_PUBLIC_APP_URL / VERCEL_URL) or the current
 * environment's edge host after the active origin-proof round trip (see
 * lib/site-url + lib/workspace-origin); when nothing verifies it is null and
 * canonicalUrlUnavailable carries the actionable reason — an unverified
 * host is never presented as the share URL.
 */
export const GET = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!user.username) {
    return ok({ design: null, needsUsername: true });
  }

  const design = await db.siteDesign.findUnique({ where: { userId: user.id } });
  // Both slots are normalized so every consumer (builder restore, compare-with-live,
  // publish-state diffing) receives schema-valid configs — legacy v1 stored JSON
  // (no pages/motion) is migrated here exactly as the public profile route does.
  const share = await resolveShareOriginForRequest(req.headers);
  return ok({
    needsUsername: false,
    design: {
      status: design?.status ?? "DRAFT",
      draft: design?.draftConfig ? normalizeConfig(design.draftConfig) : null,
      published: design?.publishedConfig ? normalizeConfig(design.publishedConfig) : null,
      publishedAt: design?.publishedAt?.toISOString() ?? null,
      watermark: design?.watermark ?? true,
      publicUrl: publicSitePath(user.username),
      canonicalUrl: share.ok ? publicSiteAbsoluteUrl(user.username, share.origin) : null,
      canonicalKind: share.ok ? share.kind : null,
      canonicalUrlUnavailable: share.ok ? null : { reason: share.reason, message: share.message },
    },
  });
});

/** PUT /api/me/site — persist the draft (zod-validated against the site schema). */
const putSchema = z.object({
  config: siteConfigSchema,
});

export const PUT = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  // Abuse-sensitive mutation (scale phase, 2-a): shared-backend limiter so the
  // bound holds across instances when RATE_LIMIT_BACKEND=postgres. Generous
  // enough for human editing + autosave, tight enough to bound runaway loops.
  const limited = await rateLimitShared("site-save:" + user.id, 60, 60_000);
  if (limited) return limited;

  const r = await parseBody(req, putSchema);
  if (r.response !== undefined) return r.response;

  // Ownership enforcement for referenced branding/cover media: a config may
  // only point at media the session user owns. Without this, a crafted config
  // could reference another user's PRIVATE media id and (once published) make
  // it publicly fetchable through /api/media/<id>/raw. Cover images set via
  // the profile PATCH route are validated the same way.
  const mediaIds = [r.data.config.logoMediaId, r.data.config.coverMediaId].filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  if (mediaIds.length > 0) {
    const owned = await db.mediaAsset.findMany({
      where: { id: { in: mediaIds }, ownerId: user.id },
      select: { id: true },
    });
    if (owned.length !== new Set(mediaIds).size) {
      return err("Website media not found — upload the logo or cover image to your own account first.", 400);
    }
  }

  const configJson = JSON.stringify(r.data.config);

  // Revision snapshot — when a save CHANGES an existing draft, the previous
  // version is kept so the user's original remains recoverable even after a
  // Code Giftz proposal is accepted, saved and the session ends. Bounded
  // (newest 10 kept); identical saves never pile up snapshots.
  const existing = await db.siteDesign.findUnique({ where: { userId: user.id }, select: { draftConfig: true } });
  if (existing?.draftConfig && existing.draftConfig !== configJson) {
    await db.siteRevision.create({
      data: { userId: user.id, label: "Before save", config: existing.draftConfig },
    });
    const stale = await db.siteRevision.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      skip: 10,
      select: { id: true },
    });
    if (stale.length > 0) {
      await db.siteRevision.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
  }

  await db.siteDesign.upsert({
    where: { userId: user.id },
    update: { draftConfig: configJson, updatedAt: new Date() },
    create: { userId: user.id, draftConfig: configJson },
  });

  // Cache invalidation (scale phase, 2-a): the logical event clears any
  // draft-derived caches (site:draft:*). The owner's public profile key is
  // dropped as well — a draft save cannot change the PUBLISHED snapshot the
  // payload embeds, but dropping one key is free insurance against future
  // public shapes derived from the draft (over-invalidation is always safe).
  await cacheInvalidateEventShared("site.save");
  if (user.username) await cacheDeleteShared(profilePublicCacheKey(user.username));

  return ok({ saved: true, savedAt: new Date().toISOString() });
});

/**
 * PATCH /api/me/site — platform-level website settings (owner-scoped).
 * Currently: the footer attribution watermark. This is deliberately NOT part
 * of the site snapshot: it is a setting, so it applies to the live website
 * immediately without republishing, and the renderer applies it at view time
 * — it can never be duplicated by a republish or corrupted by content edits.
 */
const patchSchema = z.object({
  watermark: z.boolean(),
});

export const PATCH = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  // Shared-backend limiter (scale phase, 2-a) — see PUT above.
  const limited = await rateLimitShared("site-watermark:" + user.id, 30, 60_000);
  if (limited) return limited;

  const r = await parseBody(req, patchSchema);
  if (r.response !== undefined) return r.response;

  const design = await db.siteDesign.upsert({
    where: { userId: user.id },
    update: { watermark: r.data.watermark, updatedAt: new Date() },
    create: { userId: user.id, watermark: r.data.watermark },
  });

  // The watermark is a live setting: the cached public profile payload embeds
  // it (site.watermark), so drop that user's key — otherwise the toggle would
  // take up to one TTL to reach visitors.
  if (user.username) await cacheDeleteShared(profilePublicCacheKey(user.username));

  return ok({ watermark: design.watermark });
});
