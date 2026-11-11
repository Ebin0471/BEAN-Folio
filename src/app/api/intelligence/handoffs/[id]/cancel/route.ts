import { NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok, rateLimit } from "@/lib/api-helpers";
import { HandoffError, cancelHandoff } from "@/lib/intelligence/handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** POST /api/intelligence/handoffs/[id]/cancel — cancels the handoff and (cooperatively) the downstream task. */
export const POST = handler(async (_req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`handoff-cancel:${user.id}`, 20, 60 * 60 * 1000)) return ERR.rateLimited();
  const { id } = await params;
  try {
    await cancelHandoff(user.id, id);
    return ok({ cancelled: true, status: "CANCELLED" });
  } catch (error) {
    if (error instanceof HandoffError) return err(error.message, error.status);
    return ERR.server();
  }
});
