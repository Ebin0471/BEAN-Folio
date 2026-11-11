import { NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok } from "@/lib/api-helpers";
import { HandoffError, loadHandoffDetail } from "@/lib/intelligence/handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/intelligence/handoffs/[id] — handoff detail (owner only). */
export const GET = handler(async (_req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;
  try {
    return ok(await loadHandoffDetail(user.id, id));
  } catch (error) {
    if (error instanceof HandoffError) return err(error.message, error.status);
    return ERR.server();
  }
});
