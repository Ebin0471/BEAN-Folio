import { NextRequest } from "next/server";

import { handler, ok, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { toVersionDetail } from "@/lib/giftz/project-versions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; versionId: string }> };

/**
 * GET /api/giftz/sites/[id]/versions/[versionId] — one snapshot's metadata
 * plus its file inventory (paths + sizes; contents are only served through
 * the diff/restore flows to keep responses bounded).
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id, versionId } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const version = await db.giftzProjectVersion.findFirst({ where: { id: versionId, siteId: id } });
  if (!version) return ERR.notFound();

  return ok({ version: toVersionDetail(version) });
});
