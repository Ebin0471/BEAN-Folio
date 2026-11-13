import { NextRequest } from "next/server";

import { handler, ok, err, ERR, rateLimitShared } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { restoreProjectVersion } from "@/lib/giftz/project-versions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; versionId: string }> };

/**
 * POST /api/giftz/sites/[id]/versions/[versionId]/restore — replace the
 * working tree atomically with this snapshot (files NOT in the snapshot are
 * deleted; each restored file keeps its original generated/user/ai source)
 * and restore the snapshot's config when it carries one. A "restore" version
 * snapshot is recorded afterwards. Rate-limited; unsaved working-tree state
 * is replaced — the UI confirms before calling this.
 */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const limited = await rateLimitShared(`giftz-restore:${user.id}`, 10, 60_000);
  if (limited) return limited;

  const { id, versionId } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id } });
  if (!site) return ERR.notFound();

  const exists = await db.giftzProjectVersion.findFirst({
    where: { id: versionId, siteId: site.id },
    select: { id: true },
  });
  if (!exists) return ERR.notFound();

  const result = await restoreProjectVersion(site, versionId, user.id);
  if (!result.ok) return err(result.error, 500);

  return ok({
    restored: true,
    fileCount: result.fileCount,
    config: result.config,
  });
});
