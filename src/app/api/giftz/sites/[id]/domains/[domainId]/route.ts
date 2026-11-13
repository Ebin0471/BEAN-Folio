import { NextRequest } from "next/server";

import { handler, ok, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; domainId: string }> };

/**
 * DELETE /api/giftz/sites/[id]/domains/[domainId] — remove a custom domain
 * claim. Strictly owner-scoped through the site: another user's site id (or a
 * domain belonging to a different site) is a 404.
 */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id, domainId } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const domain = await db.giftzDomain.findFirst({ where: { id: domainId, siteId: site.id } });
  if (!domain) return ERR.notFound();

  await db.giftzDomain.delete({ where: { id: domain.id } });
  return ok({ deleted: true });
});
