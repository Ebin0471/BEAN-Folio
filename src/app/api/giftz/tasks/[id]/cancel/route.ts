import { NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok } from "@/lib/api-helpers";
import { GiftzTaskError, cancelTask } from "@/lib/giftz/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/giftz/tasks/[id]/cancel — cooperative cancellation between steps
 * PLUS a hard kill of any running validation commands. Terminal state is
 * CANCELLED with an honest note.
 */
export const POST = handler(async (_req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;

  try {
    await cancelTask(user.id, id);
    return ok({ cancelled: true, status: "CANCELLED" });
  } catch (error) {
    if (error instanceof GiftzTaskError) return err(error.message, error.status);
    return ERR.server();
  }
});
