import { NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { ERR, handler, ok } from "@/lib/api-helpers";
import { GiftzTaskError, loadTaskDetail } from "@/lib/giftz/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/giftz/tasks/[id] — full task detail (plan, timeline, diffs, runs, report). */
export const GET = handler(async (_req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;
  try {
    const detail = await loadTaskDetail(user.id, id);
    return ok(detail);
  } catch (error) {
    if (error instanceof GiftzTaskError) return ERR.notFound();
    return ERR.server();
  }
});
