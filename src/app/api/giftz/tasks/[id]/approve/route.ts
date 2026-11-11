import { NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok, rateLimit } from "@/lib/api-helpers";
import { GiftzTaskError, approveAndExecuteTask } from "@/lib/giftz/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/giftz/tasks/[id]/approve — the approval gate (spec §6). Only the
 * owner, only from AWAITING_APPROVAL. Approving starts the bounded,
 * plan-scoped execution: file edits inside the isolated workspace, then
 * allowlisted validation commands, then diff + report.
 */
export const POST = handler(async (_req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`giftz-approve:${user.id}`, 20, 60 * 60 * 1000)) return ERR.rateLimited();
  const { id } = await params;

  try {
    await approveAndExecuteTask({ userId: user.id, taskId: id });
    return ok({ approved: true, status: "EXECUTING" }, 202);
  } catch (error) {
    if (error instanceof GiftzTaskError) return err(error.message, error.status);
    return ERR.server();
  }
});
