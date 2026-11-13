import { NextRequest, NextResponse } from "next/server";

import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeConfig } from "@/lib/site-config";
import { saveGiftzSiteConfig, putSchema } from "../route";
import { projectTreeSummary } from "@/lib/giftz/project-files";
import { syncGeneratedFiles } from "@/lib/giftz/project-compiler";
import { parseBuildDiagnostics } from "@/lib/giftz/project-build";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/giftz/sites/[id] — the owner's generated site (config included).
 * Strictly owner-scoped: another user's site id is a 404.
 *
 * Standalone-platform additions (contract §4): the response also carries the
 * publish-pipeline state (deployStatus, framework, description), a summary
 * of the project file tree, the newest build and the newest LIVE deployment.
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findUnique({ where: { id } });
  if (!site || site.userId !== user.id) return ERR.notFound();

  const [fileSummaryRow, lastBuild, liveDeployment] = await Promise.all([
    projectTreeSummary(site.id),
    db.giftzBuild.findFirst({ where: { siteId: site.id }, orderBy: { createdAt: "desc" } }),
    db.giftzDeployment.findFirst({
      where: { siteId: site.id, status: "LIVE" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return ok({
    site: {
      id: site.id,
      title: site.title,
      status: site.status,
      sourcePrompt: site.sourcePrompt,
      config: site.config ? normalizeConfig(site.config) : null,
      publishedConfig: site.publishedConfig ? normalizeConfig(site.publishedConfig) : null,
      publishedAt: site.publishedAt?.toISOString() ?? null,
      createdAt: site.createdAt.toISOString(),
      updatedAt: site.updatedAt.toISOString(),
      deployStatus: site.deployStatus,
      framework: site.framework,
      description: site.description,
      fileSummary: fileSummaryRow.fileCount > 0 ? fileSummaryRow : null,
      lastBuild: lastBuild
        ? {
            id: lastBuild.id,
            status: lastBuild.status,
            createdAt: lastBuild.createdAt.toISOString(),
            summary: parseBuildDiagnostics(lastBuild)?.summary ?? null,
          }
        : null,
      liveDeployment: liveDeployment
        ? {
            id: liveDeployment.id,
            deployedAt: liveDeployment.deployedAt?.toISOString() ?? null,
            status: liveDeployment.status,
          }
        : null,
    },
  });
});

/**
 * PUT /api/giftz/sites/[id] — save the generated site's working draft
 * (config and/or title/description). Owner-scoped; runs the same media IDOR
 * guard as the portfolio saves; snapshots "Before save" revisions (newest 10
 * kept).
 *
 * Sync rule S1: after a config save the server recompiles the generated
 * project files inline (awaited) and reports the result as `fileSync` —
 * only "generated" rows are replaced; "user"/"ai" rows are skipped and
 * reported. A compile failure keeps the previous tree and surfaces honestly
 * as fileSync.ok = false while the config save itself still succeeds.
 */
export const PUT = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const r = await parseBody(req, putSchema);
  if (r.response) return r.response;

  const result = await saveGiftzSiteConfig(user.id, id, {
    title: r.data.title,
    config: r.data.config,
    description: r.data.description,
  });
  if (!result.ok) return err(result.message, result.status);

  // S1 — regenerate the project tree from the saved content model. Only runs
  // when the config itself changed (title/description-only saves keep the tree).
  const fileSync =
    r.data.config !== undefined
      ? await syncGeneratedFiles(user.id, id)
      : { ok: true, generated: 0, skippedUserFiles: 0, removed: 0 };

  return ok({
    saved: true,
    savedAt: new Date().toISOString(),
    config: result.config,
    fileSync: {
      ok: fileSync.ok,
      ...(fileSync.error ? { error: fileSync.error } : {}),
      generated: fileSync.generated,
      skippedUserFiles: fileSync.skippedUserFiles,
      removed: fileSync.removed,
    },
  });
});

/**
 * DELETE /api/giftz/sites/[id] — the OWNER's own explicit deletion of one
 * generated site (cascades to its revisions). Owner-scoped; never called by
 * any automated flow.
 */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findUnique({ where: { id }, select: { id: true, userId: true } });
  if (!site || site.userId !== user.id) return ERR.notFound();

  await db.giftzSite.delete({ where: { id: site.id } });
  return NextResponse.json({ deleted: true }, { status: 200 });
});
