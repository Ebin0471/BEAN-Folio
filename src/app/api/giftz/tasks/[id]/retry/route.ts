import { NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok, rateLimit } from "@/lib/api-helpers";
import { GiftzTaskError, retryTask } from "@/lib/giftz/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/giftz/tasks/[id]/retry — re-run a FAILED task (bounded attempts).
 * Only the plan's already-approved steps run again; no re-planning.
 */
export const POST = handler(async (_req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`giftz-retry:${user.id}`, 10, 60 * 60 * 1000)) return ERR.rateLimited();
  const { id } = await params;

  try {
    await retryTask(user.id, id);
    return ok({ retried: true, status: "EXECUTING" }, 202);
  } catch (error) {
    if (error instanceof GiftzTaskError) return err(error.message, error.status);
    return ERR.server();
  }
});
