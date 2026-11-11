import { NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok, rateLimit } from "@/lib/api-helpers";
import { CreativeTaskError, approveCreativeAssetTask } from "@/lib/giftz/creative";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/giftz/creative/[id]/approve — the LAXII handoff gate. Approval
 * runs the REAL LAXII banner pipeline (generation + quality evaluation) and
 * registers the validated asset as a shared artifact. Runs asynchronously:
 * the route returns immediately and the task status shows progress.
 */
export const POST = handler(async (_req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`giftz-creative-approve:${user.id}`, 10, 60 * 60 * 1000)) return ERR.rateLimited();
  const { id } = await params;

  try {
    // Fire-and-forget: generation takes ~1–2 minutes; the client polls the detail.
    void approveCreativeAssetTask({ userId: user.id, taskId: id }).catch(() => undefined);
    return ok({ approved: true, status: "GENERATING" }, 202);
  } catch (error) {
    if (error instanceof CreativeTaskError) return err(error.message, error.status);
    return ERR.server();
  }
});
