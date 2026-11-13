import { NextRequest, NextResponse } from "next/server";

import { handler, ok, err, ERR, rateLimitShared } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeConfig } from "@/lib/site-config";
import { siteConfigMediaError } from "@/lib/site-media-guard";
import { publicSiteGiftzPath } from "@/lib/site-url";
import { parseBuildDiagnostics, serializeBuild } from "@/lib/giftz/project-build";
import {
  deploymentAdapterStatus,
  publishGiftzSiteProject,
} from "@/lib/giftz/project-deploy";

export const dynamic = "force-dynamic";
// Publishing runs the build + deployment + version snapshot synchronously.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/giftz/sites/[id]/publish — publish THIS generated site.
 *
 * Publishes the GiftzSite's own artifact at /site/<username>/g/<siteId> —
 * completely independent from the user's portfolio website: publishing (or
 * unpublishing) a GiftzSite never touches SiteDesign, and the portfolio's
 * publish state is irrelevant here.
 *
 * Two paths (contract §7.2), keyed on whether the site owns a real project
 * file tree:
 *  - NO project files (legacy JSON-only site): the original behavior,
 *    unchanged — the saved draft is snapshotted into publishedConfig (an
 *    immutable visitor-facing copy); the media IDOR guard runs on the
 *    snapshot so a published GiftzSite can never expose foreign media
 *    through /api/media/<id>/raw.
 *  - WITH project files: the standalone-platform pipeline — build gate
 *    (trigger "publish") → GiftzDeployment DEPLOYING→LIVE carrying the
 *    build's artifact → site PUBLISHED. deployStatus transitions are
 *    persisted per stage (DEPLOYING at start, PUBLISHED/FAILED at end) so
 *    the UI always sees the honest state. The legacy fields of the response
 *    (status / publishedAt / publicPath) are preserved; the new fields name
 *    the deployment, the build and the (honestly unconfigured) adapter.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findUnique({ where: { id } });
  if (!site || site.userId !== user.id) return ERR.notFound();

  const hasProjectFiles = (await db.giftzProjectFile.count({ where: { siteId: site.id } })) > 0;
  if (!hasProjectFiles) {
    // ---- legacy JSON-only publish: existing behavior, unchanged ----
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
  }

  // ---- file-based pipeline (contract §7) ----
  const limited = await rateLimitShared(`giftz-publish:${user.id}`, 10, 60_000);
  if (limited) return limited;

  const result = await publishGiftzSiteProject(user, site, req.headers);
  if (!result.ok) {
    if (result.stage === "build" && result.build) {
      // The build gate failed — surface the real diagnostics; nothing was deployed.
      return NextResponse.json(
        {
          error: result.message,
          stage: result.stage,
          buildId: result.buildId ?? null,
          build: serializeBuild(result.build),
          diagnostics: result.diagnostics ?? [],
        },
        { status: 422 }
      );
    }
    return err(result.message, result.status);
  }

  const buildSummary = parseBuildDiagnostics(result.build)?.summary ?? null;
  return ok({
    // legacy response fields — unchanged shapes
    status: "PUBLISHED",
    publishedAt: result.publishedAt,
    publicPath: result.publicPath,
    // standalone-platform additions (contract §7.2)
    deployment: {
      id: result.deployment.id,
      status: result.deployment.status,
      url: result.deployment.url,
      provider: result.deployment.provider,
    },
    canonicalUrl: result.canonicalUrl,
    canonicalKind: result.canonicalKind,
    canonicalUrlUnavailable: result.canonicalUrlUnavailable,
    build: {
      id: result.build.id,
      status: result.build.status,
      summary: buildSummary,
    },
    adapter: deploymentAdapterStatus(),
  });
});
