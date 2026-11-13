import { NextRequest } from "next/server";

import { handler, ok, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { deploymentAdapterStatus, serializeDeployment } from "@/lib/giftz/project-deploy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/giftz/sites/[id]/deployments — newest 20 deployment records of
 * this generated site with their honest lifecycle state (DEPLOYING / LIVE /
 * FAILED / ROLLED_BACK), the stored public url (path form) and the real
 * error/rollback notes. `adapter` reports the hosting-adapter configuration
 * truthfully (none configured in this environment — contract §7.1).
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const deployments = await db.giftzDeployment.findMany({
    where: { siteId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return ok({
    deployments: deployments.map(serializeDeployment),
    adapter: deploymentAdapterStatus(),
  });
});
