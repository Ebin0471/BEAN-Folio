/**
 * GIFTZ publishing / deployment pipeline (contract §7.1).
 *
 * The publish flow is HONEST end to end: a deployment only becomes LIVE after
 * a SUCCEEDED build's artifact has been stored on the deployment row, and the
 * public file route serves exactly that artifact — never the working tree.
 * Every failure surfaces as a real status + message (no fabricated success).
 *
 * State machines:
 *   site.deployStatus: … PREVIEW | READY_TO_PUBLISH → DEPLOYING → PUBLISHED | FAILED
 *   deployment.status: DEPLOYING → LIVE, or DEPLOYING → FAILED on a crash.
 *   Superseded LIVE rows become ROLLED_BACK with an honest `error` note
 *   ("superseded by <id>", "unpublished") so the serving rule — newest LIVE
 *   row wins — always has exactly one candidate.
 */

import { db } from "@/lib/db";
import type { GiftzBuild, GiftzDeployment, GiftzSite } from "@prisma/client";
import { normalizeConfig } from "@/lib/site-config";
import { publicSiteGiftzPath } from "@/lib/site-url";
import { resolveShareOriginForRequest } from "@/lib/workspace-origin";
import { log } from "@/lib/logger";
import { reportError } from "@/lib/monitoring";
import { parseBuildDiagnostics, runProjectBuild, type BuildDiagnostic } from "./project-build";
import { snapshotProjectVersion } from "./project-versions";
import { recordGiftzActivity } from "./project-activity";
import { syncGeneratedFiles } from "./project-compiler";

/** The only hosting provider this environment actually operates. */
export const DEPLOYMENT_PROVIDER = "bean-folio-hosting";

/** Deployment rows created by this module, newest-LIVE-wins serving rule. */
export interface SerializedDeployment {
  id: string;
  buildId: string | null;
  status: string;
  provider: string;
  url: string | null;
  error: string | null;
  deployedAt: string | null;
  createdAt: string;
}

export function serializeDeployment(row: GiftzDeployment): SerializedDeployment {
  return {
    id: row.id,
    buildId: row.buildId,
    status: row.status,
    provider: row.provider,
    url: row.url,
    error: row.error,
    deployedAt: row.deployedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Honest adapter status (contract §7.1): this environment serves deployments
 * itself through /api/giftz/sites/:id/public/*; no external hosting adapters
 * (Netlify, Vercel, S3, …) are configured, and nothing pretends otherwise.
 */
export function deploymentAdapterStatus() {
  return {
    configured: false,
    provider: DEPLOYMENT_PROVIDER,
    externalProviders: [] as string[],
    note: "External hosting adapters are not configured in this environment",
  };
}

/** Session-user shape the pipeline needs (getSessionUser rows satisfy it). */
export interface DeployUser {
  id: string;
  username: string | null;
}

// ------------------------------------------------------------------ publish

export type PublishResult =
  | {
      ok: true;
      deployment: GiftzDeployment;
      build: GiftzBuild;
      /** Public PATH of this deployment (/site/<username>/g/<siteId>) — null without a claimed username. */
      publicPath: string | null;
      publishedAt: string | null;
      /** Fully-qualified URL from a VERIFIED origin only (config or origin-proof) — response-only. */
      canonicalUrl: string | null;
      canonicalKind: string | null;
      canonicalUrlUnavailable: { reason: string; message: string } | null;
    }
  | {
      ok: false;
      stage: "files" | "build" | "deploy";
      status: number;
      message: string;
      buildId?: string;
      build?: GiftzBuild;
      diagnostics?: BuildDiagnostic[];
    };

/**
 * Publish a GiftzSite that owns a real project file tree:
 *   1. File gate — sync the compiled tree if empty, honest 400 when still empty.
 *   2. deployStatus DEPLOYING (persisted so the UI sees the honest intermediate state).
 *   3. Build gate — runProjectBuild(site, "publish"); FAILED → deployStatus
 *      FAILED + 422 with real diagnostics, NO deployment.
 *   4. GiftzDeployment DEPLOYING (artifact copied from the build) → LIVE
 *      (deployedAt, url = the public PATH form), older LIVE rows →
 *      ROLLED_BACK "superseded by <id>".
 *   5. Site: deployStatus PUBLISHED, status PUBLISHED, publishedConfig kept in
 *      its legacy JSON-snapshot semantics (SiteRenderer fallback), publishedAt
 *      keeps its first value.
 *   6. Version snapshot (source "publish", never pruned) + deploy/publish activity.
 */
export async function publishGiftzSiteProject(
  user: DeployUser,
  site: GiftzSite,
  headers: Headers
): Promise<PublishResult> {
  // --- 1. file gate
  let fileCount = await db.giftzProjectFile.count({ where: { siteId: site.id } });
  if (fileCount === 0 && site.config) {
    const sync = await syncGeneratedFiles(user.id, site.id);
    if (!sync.ok) {
      return {
        ok: false,
        stage: "files",
        status: 422,
        message: `The project files could not be generated from the saved configuration: ${sync.error ?? "compile failed"}`,
      };
    }
    fileCount = await db.giftzProjectFile.count({ where: { siteId: site.id } });
  }
  if (fileCount === 0) {
    return {
      ok: false,
      stage: "files",
      status: 400,
      message: "This site has no project files to publish yet — generate or save the website first.",
    };
  }

  // --- 2. honest intermediate state, persisted per stage
  await db.giftzSite.update({
    where: { id: site.id },
    data: { deployStatus: "DEPLOYING", updatedAt: new Date() },
  });

  // --- 3. build gate (trigger "publish" — build leaves deployStatus alone)
  const build = await runProjectBuild(site, "publish");
  if (build.status !== "SUCCEEDED") {
    await db.giftzSite.update({
      where: { id: site.id },
      data: { deployStatus: "FAILED", updatedAt: new Date() },
    });
    const diagnostics = parseBuildDiagnostics(build);
    await recordGiftzActivity(site.id, site.userId, "publish", {
      ok: false,
      stage: "build",
      buildId: build.id,
      summary: diagnostics?.summary ?? null,
    });
    return {
      ok: false,
      stage: "build",
      status: 422,
      message: "The pre-publish build failed — no deployment was created.",
      buildId: build.id,
      build,
      diagnostics: diagnostics?.checks ?? [],
    };
  }

  // The artifact is the deployment's served copy — it must really exist.
  const artifact = parseBuildArtifact(build.artifactJson);
  if (!artifact) {
    await db.giftzSite.update({
      where: { id: site.id },
      data: { deployStatus: "FAILED", updatedAt: new Date() },
    });
    log.error("giftz.deploy.artifact_missing", { siteId: site.id, buildId: build.id });
    return {
      ok: false,
      stage: "deploy",
      status: 500,
      message: "The build succeeded but its artifact is missing or empty — no deployment was created.",
      buildId: build.id,
      build,
    };
  }

  // --- 4..6. deployment + site state (guarded: failures mark FAILED honestly)
  let deploymentId: string | null = null;
  try {
    const deployment = await db.giftzDeployment.create({
      data: {
        siteId: site.id,
        buildId: build.id,
        status: "DEPLOYING",
        provider: DEPLOYMENT_PROVIDER,
        filesJson: build.artifactJson,
      },
    });
    deploymentId = deployment.id;

    // Older LIVE rows are implicitly inactive for serving; retire them with an
    // honest note so exactly one LIVE row exists at any moment.
    await db.giftzDeployment.updateMany({
      where: { siteId: site.id, status: "LIVE", id: { not: deployment.id } },
      data: { status: "ROLLED_BACK", error: `superseded by ${deployment.id}` },
    });

    // url stores the PATH form (contract §7.1); the absolute URL is
    // response-only and comes from a VERIFIED origin or is honestly absent.
    const publicPath = publicSiteGiftzPath(user.username, site.id);
    const deployedAt = new Date();
    const live = await db.giftzDeployment.update({
      where: { id: deployment.id },
      data: { status: "LIVE", deployedAt, url: publicPath, error: null },
    });

    // --- 5. site state (legacy publishedConfig semantics kept)
    const normalized = site.config ? normalizeConfig(site.config) : null;
    await db.giftzSite.update({
      where: { id: site.id },
      data: {
        deployStatus: "PUBLISHED",
        status: "PUBLISHED",
        ...(normalized ? { publishedConfig: JSON.stringify(normalized) } : {}),
        publishedAt: site.publishedAt ?? deployedAt,
        updatedAt: new Date(),
      },
    });

    // --- 6. version (source "publish" — never pruned) + activity
    await snapshotProjectVersion(site.id, user.id, `Publish ${deployedAt.toISOString()}`, "publish");
    await recordGiftzActivity(site.id, site.userId, "deploy", {
      deploymentId: live.id,
      buildId: build.id,
      status: "LIVE",
      provider: DEPLOYMENT_PROVIDER,
      url: live.url,
    });
    await recordGiftzActivity(site.id, site.userId, "publish", {
      ok: true,
      deploymentId: live.id,
      buildId: build.id,
      url: live.url,
      files: artifact.length,
    });

    // Absolute URL — same VERIFIED-origin policy as /api/me/site/publish.
    const share = await resolveShareOriginForRequest(headers);
    const canonicalUrl = share.ok && live.url ? `${share.origin}${live.url}` : null;

    return {
      ok: true,
      deployment: live,
      build,
      publicPath: live.url,
      publishedAt: (site.publishedAt ?? deployedAt).toISOString(),
      canonicalUrl,
      canonicalKind: share.ok ? share.kind : null,
      canonicalUrlUnavailable: share.ok ? null : { reason: share.reason, message: share.message },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportError("giftz.deploy.failed", { siteId: site.id, buildId: build.id, error: message });
    if (deploymentId) {
      // Never leave a DEPLOYING row dangling — the honest terminal state is FAILED.
      await db.giftzDeployment
        .update({ where: { id: deploymentId }, data: { status: "FAILED", error: message } })
        .catch(() => undefined);
    }
    await db.giftzSite
      .update({ where: { id: site.id }, data: { deployStatus: "FAILED", updatedAt: new Date() } })
      .catch(() => undefined);
    await recordGiftzActivity(site.id, site.userId, "deploy", {
      ok: false,
      buildId: build.id,
      deploymentId,
      error: message,
    });
    return {
      ok: false,
      stage: "deploy",
      status: 500,
      message: `The deployment failed: ${message}`,
      buildId: build.id,
      build,
    };
  }
}

/** Parse + validate a build artifact JSON ({ files: [{ path, mime, encoding, content }] }). */
function parseBuildArtifact(artifactJson: string | null): { path: string }[] | null {
  if (!artifactJson) return null;
  try {
    const parsed = JSON.parse(artifactJson) as { files?: unknown };
    if (!Array.isArray(parsed.files) || parsed.files.length === 0) return null;
    const files: { path: string }[] = [];
    for (const f of parsed.files) {
      if (f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string") {
        files.push({ path: (f as { path: string }).path });
      }
    }
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ rollback

export type RollbackResult =
  | { ok: true; deployment: GiftzDeployment }
  | { ok: false; status: number; message: string };

/**
 * Roll the site back to a previous deployment: copy that deployment's stored
 * artifact into a NEW deployment (noted "rollback of <id>") and make it the
 * single LIVE row; the current newest LIVE row becomes ROLLED_BACK. The
 * working tree is untouched — only what the public route serves changes.
 */
export async function rollbackDeployment(
  user: DeployUser,
  site: GiftzSite,
  deploymentId: string
): Promise<RollbackResult> {
  const target = await db.giftzDeployment.findFirst({
    where: { id: deploymentId, siteId: site.id },
  });
  if (!target) {
    return { ok: false, status: 404, message: "Deployment not found for this site." };
  }
  if (target.status !== "LIVE" && target.status !== "ROLLED_BACK") {
    return {
      ok: false,
      status: 400,
      message: `Only LIVE or previously-live (ROLLED_BACK) deployments can be restored — this one is ${target.status}.`,
    };
  }
  if (!target.filesJson) {
    return { ok: false, status: 400, message: "This deployment has no stored artifact to restore." };
  }

  let createdDeploymentId: string | null = null;
  try {
    const deployment = await db.giftzDeployment.create({
      data: {
        siteId: site.id,
        buildId: target.buildId,
        status: "DEPLOYING",
        provider: DEPLOYMENT_PROVIDER,
        filesJson: target.filesJson,
        error: `rollback of ${target.id}`,
      },
    });
    createdDeploymentId = deployment.id;

    await db.giftzDeployment.updateMany({
      where: { siteId: site.id, status: "LIVE", id: { not: deployment.id } },
      data: { status: "ROLLED_BACK", error: `superseded by ${deployment.id}` },
    });

    const url = target.url ?? publicSiteGiftzPath(user.username, site.id);
    const live = await db.giftzDeployment.update({
      where: { id: deployment.id },
      data: { status: "LIVE", deployedAt: new Date(), url },
    });

    // deployStatus stays PUBLISHED (contract); the corrections below only
    // fire when the site was left in a non-published state (e.g. a FAILED
    // publish) — a deployment just went LIVE, so PUBLISHED is the honest value.
    const deployedAt = new Date();
    const artifactConfig = extractArtifactConfig(target.filesJson);
    await db.giftzSite.update({
      where: { id: site.id },
      data: {
        deployStatus: "PUBLISHED",
        ...(site.status !== "PUBLISHED" ? { status: "PUBLISHED" } : {}),
        ...(site.publishedAt ? {} : { publishedAt: deployedAt }),
        // Restore the legacy viewer snapshot when it is missing: the
        // deployed artifact's own site.config.json is the honest source.
        ...(!site.publishedConfig && artifactConfig ? { publishedConfig: artifactConfig } : {}),
        updatedAt: new Date(),
      },
    });

    await snapshotProjectVersion(
      site.id,
      user.id,
      `Rollback to ${target.deployedAt?.toISOString() ?? target.createdAt.toISOString()}`,
      "publish"
    );
    await recordGiftzActivity(site.id, site.userId, "deploy", {
      deploymentId: live.id,
      rollbackOf: target.id,
      status: "LIVE",
      provider: DEPLOYMENT_PROVIDER,
      url: live.url,
    });

    return { ok: true, deployment: live };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("giftz.deploy.rollback_failed", { siteId: site.id, rollbackOf: deploymentId, error: message });
    if (createdDeploymentId) {
      // Never leave a DEPLOYING row dangling — the honest terminal state is FAILED.
      await db.giftzDeployment
        .update({ where: { id: createdDeploymentId }, data: { status: "FAILED", error: message } })
        .catch(() => undefined);
    }
    return { ok: false, status: 500, message: `The rollback failed: ${message}` };
  }
}

/**
 * Extract + normalize the site.config.json stored inside a deployment
 * artifact — used to restore the legacy publishedConfig viewer snapshot when
 * a rollback has to revive a site that was left unpublished. Null when the
 * artifact carries no valid config (honest absence, never fabricated).
 */
function extractArtifactConfig(filesJson: string): string | null {
  try {
    const parsed = JSON.parse(filesJson) as { files?: unknown };
    if (!Array.isArray(parsed.files)) return null;
    for (const f of parsed.files) {
      if (
        f &&
        typeof f === "object" &&
        (f as { path?: unknown }).path === "site.config.json" &&
        typeof (f as { content?: unknown }).content === "string"
      ) {
        const normalized = normalizeConfig((f as { content: string }).content);
        return normalized ? JSON.stringify(normalized) : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ unpublish

/**
 * Deployment-state half of unpublishing: every LIVE deployment becomes
 * ROLLED_BACK with the honest "unpublished" note (the public file route then
 * serves nothing). The route keeps its existing site-level behavior (status
 * DRAFT, publishedConfig/publishedAt cleared) and adds deployStatus DRAFT.
 */
export async function unpublishGiftzSiteProject(
  user: { id: string },
  site: Pick<GiftzSite, "id" | "userId">
): Promise<void> {
  const result = await db.giftzDeployment.updateMany({
    where: { siteId: site.id, status: "LIVE" },
    data: { status: "ROLLED_BACK", error: "unpublished" },
  });
  if (result.count > 0) {
    await recordGiftzActivity(site.id, site.userId, "deploy", {
      status: "ROLLED_BACK",
      reason: "unpublished",
      deployments: result.count,
    });
  }
}
