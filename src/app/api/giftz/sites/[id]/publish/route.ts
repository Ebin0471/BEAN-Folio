import { handler, ok, err, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeConfig } from "@/lib/site-config";
import { siteConfigMediaError } from "@/lib/site-media-guard";
import { publicSiteGiftzPath } from "@/lib/site-url";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/giftz/sites/[id]/publish — publish THIS generated site.
 *
 * Publishes the GiftzSite's own artifact at /site/<username>/g/<siteId> —
 * completely independent from the user's portfolio website: publishing (or
 * unpublishing) a GiftzSite never touches SiteDesign, and the portfolio's
 * publish state is irrelevant here. The saved draft is snapshotted into
 * publishedConfig (an immutable visitor-facing copy); the media IDOR guard
 * runs on the snapshot so a published GiftzSite can never expose foreign
 * media through /api/media/<id>/raw.
 */
export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findUnique({ where: { id } });
  if (!site || site.userId !== user.id) return ERR.notFound();

  const config = site.config ? normalizeConfig(site.config) : null;
  if (!config) {
    return err("Generate and save the website first — there is nothing to publish yet.", 400);
  }

  const mediaError = await siteConfigMediaError(config, user.id);
  if (mediaError) return err(mediaError, 400);

  const publishedConfig = JSON.stringify(config);
  const updated = await db.giftzSite.update({
    where: { id: site.id },
    data: {
      status: "PUBLISHED",
      publishedConfig,
      publishedAt: site.publishedAt ?? new Date(),
      updatedAt: new Date(),
    },
  });

  return ok({
    status: updated.status,
    publishedAt: updated.publishedAt?.toISOString() ?? null,
    publicPath: publicSiteGiftzPath(user.username, site.id),
  });
});
