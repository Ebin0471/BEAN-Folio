import { NextRequest } from "next/server";

import { handler, ok, ERR } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { normalizeConfig } from "@/lib/site-config";
import { getSessionUser } from "@/lib/auth";
import { isProfilePubliclyVisible } from "@/lib/visibility";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/giftz/sites/[id]/public — PUBLIC render data for a PUBLISHED
 * GIFTZ generated site: the immutable publishedConfig snapshot + the
 * creator's public identity (username/name only). Drafts and unpublished
 * sites are 404 for everyone except the owner (who uses the owner GET).
 *
 * Profile/projects/collections data comes from the standard public profile
 * endpoint (/api/profiles/:username) — the exact same public filters the
 * portfolio website renders through.
 *
 * M2 SECURITY FIX (multi-tenant publishing prerequisite — spec Part F): the
 * privacy ladder is now ENFORCED SERVER-SIDE on THIS endpoint. Previously it
 * only checked site status + owner deletion and relied on the client to
 * fetch /api/profiles/:username afterwards — a direct API caller could read
 * a PRIVATE profile's published GIFTZ configuration. Now:
 * - the owner is active (deleted accounts never serve),
 * - the site is genuinely PUBLISHED with a snapshot,
 * - the owner's profile passes `isProfilePubliclyVisible` — with the
 *   session-authenticated owner exempt (an owner can always read their own
 *   published data), so demo fixtures and PRIVATE profiles 404 to everyone
 *   else (non-revealing, same shape as any other miss).
 *
 * `deployment` (contract §5.2/§5.3, additive): when the site has a LIVE
 * file-based deployment, the response names it so the public view renders the
 * real built artifact from /api/giftz/sites/:id/public/index.html instead of
 * the legacy SiteRenderer fallback (which stays the behavior when this field
 * is null — legacy JSON-only published sites).
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const site = await db.giftzSite.findUnique({
    where: { id },
    select: {
      status: true,
      publishedConfig: true,
      publishedAt: true,
      title: true,
      userId: true,
      user: {
        select: { username: true, name: true, deletedAt: true, profileVisibility: true, isDemo: true },
      },
    },
  });

  if (!site || site.status !== "PUBLISHED" || !site.publishedConfig || site.user.deletedAt) {
    return ERR.notFound();
  }

  // M2: server-side privacy ladder (defense that used to live only in the
  // client's follow-up profile fetch). Self is resolved from the session so
  // the owner keeps seeing their own site; every other viewer gets the same
  // 404 a private profile's /api/profiles/:username already returns.
  const viewer = await getSessionUser();
  const isSelf = viewer?.id === site.userId;
  if (!isProfilePubliclyVisible(site.user, isSelf)) {
    return ERR.notFound();
  }

  const config = normalizeConfig(site.publishedConfig);
  if (!config) return ERR.notFound();

  const liveDeployment = await db.giftzDeployment.findFirst({
    where: { siteId: id, status: "LIVE" },
    orderBy: { createdAt: "desc" },
    select: { id: true, deployedAt: true },
  });

  const res = ok({
    site: {
      id,
      title: site.title,
      config,
      publishedAt: site.publishedAt?.toISOString() ?? null,
    },
    owner: {
      username: site.user.username,
      name: site.user.name,
    },
    deployment: liveDeployment
      ? { id: liveDeployment.id, deployedAt: liveDeployment.deployedAt?.toISOString() ?? null }
      : null,
  });
  // M2: viewer-dependent response (self vs public) — never cached shared.
  res.headers.set("Cache-Control", "private, no-store");
  return res;
});
