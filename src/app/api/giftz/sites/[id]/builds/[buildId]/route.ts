import { NextRequest } from "next/server";

import { handler, ok, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { serializeBuild } from "@/lib/giftz/project-build";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; buildId: string }> };

/**
 * GET /api/giftz/sites/[id]/builds/[buildId] — one build with its full
 * diagnostics (per-check path/severity/message). Owner-scoped: a build id
 * from another site is a 404.
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id, buildId } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const build = await db.giftzBuild.findFirst({ where: { id: buildId, siteId: id } });
  if (!build) return ERR.notFound();

  return ok({ build: serializeBuild(build) });
});
