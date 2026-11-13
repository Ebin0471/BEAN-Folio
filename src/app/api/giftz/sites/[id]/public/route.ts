import { NextRequest } from "next/server";

import { handler, ok, ERR } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { normalizeConfig } from "@/lib/site-config";

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
 * portfolio website renders through. A PRIVATE profile therefore keeps its
 * generated sites unreachable to visitors, exactly like the portfolio site.
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
      user: { select: { username: true, name: true, deletedAt: true } },
    },
  });

  if (!site || site.status !== "PUBLISHED" || !site.publishedConfig || site.user.deletedAt) {
    return ERR.notFound();
  }

  const config = normalizeConfig(site.publishedConfig);
  if (!config) return ERR.notFound();

  const liveDeployment = await db.giftzDeployment.findFirst({
    where: { siteId: id, status: "LIVE" },
    orderBy: { createdAt: "desc" },
    select: { id: true, deployedAt: true },
  });

  return ok({
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
});
