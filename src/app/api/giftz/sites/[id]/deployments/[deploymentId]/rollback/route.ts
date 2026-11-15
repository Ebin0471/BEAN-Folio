import { NextRequest } from "next/server";

import { handler, ok, err, ERR, rateLimitShared } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { rollbackDeployment, serializeDeployment } from "@/lib/giftz/project-deploy";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string; deploymentId: string }> };

/**
 * POST /api/giftz/sites/[id]/deployments/[deploymentId]/rollback — make a
 * previous deployment the LIVE one again (contract §7.1): its stored artifact
 * is copied into a NEW deployment (noted "rollback of <id>"), the current
 * newest LIVE row becomes ROLLED_BACK, and the working tree is untouched.
 * Only LIVE / ROLLED_BACK rows with an artifact are restorable — anything
 * else is an honest 400.
 */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const limited = await rateLimitShared(`giftz-rollback:${user.id}`, 10, 60_000);
  if (limited) return limited;

  const { id, deploymentId } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id } });
  if (!site) return ERR.notFound();

  const result = await rollbackDeployment(user, site, deploymentId);
  if (!result.ok) return err(result.message, result.status);

  return ok({ deployment: serializeDeployment(result.deployment) });
});
