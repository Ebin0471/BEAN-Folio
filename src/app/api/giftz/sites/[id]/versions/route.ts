import { NextRequest } from "next/server";
import { z } from "zod";

import { handler, ok, ERR, parseBody, rateLimitShared } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { recordGiftzActivity } from "@/lib/giftz/project-activity";
import { snapshotProjectVersion, toVersionSummary } from "@/lib/giftz/project-versions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const postSchema = z.object({
  label: z.string().trim().max(200).optional(),
});

/**
 * GET /api/giftz/sites/[id]/versions — newest 20 snapshots of this project
 * (publish-protected rows included in the listing; only pruning skips them).
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const versions = await db.giftzProjectVersion.findMany({
    where: { siteId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return ok({ versions: versions.map(toVersionSummary) });
});

/**
 * POST /api/giftz/sites/[id]/versions — take a manual snapshot (source
 * "user") of the current working tree + config.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  // Snapshots store the full tree — keep them bounded per account.
  const limited = await rateLimitShared(`giftz-version:${user.id}`, 30, 60_000);
  if (limited) return limited;

  const { id } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const r = await parseBody(req, postSchema);
  if (r.response) return r.response;

  const version = await snapshotProjectVersion(id, user.id, r.data.label?.trim() || "Manual snapshot", "user");
  await recordGiftzActivity(id, user.id, "version.save", {
    versionId: version.id,
    label: version.label,
    source: version.source,
  });

  return ok({ version: toVersionSummary(version) });
});
