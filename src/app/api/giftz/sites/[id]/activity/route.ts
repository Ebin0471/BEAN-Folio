import { NextRequest } from "next/server";

import { handler, ok, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { listGiftzActivity } from "@/lib/giftz/project-activity";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/giftz/sites/[id]/activity — newest 50 activity rows for this
 * project (config saves, file writes/deletes, builds, restores). Owner-scoped.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(Math.trunc(limitParam), 100)) : 50;
  const activity = await listGiftzActivity(id, limit);

  return ok({ activity });
});
