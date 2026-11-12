import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";
import { stopAllAutomations } from "@/lib/riishe/engine";

export const dynamic = "force-dynamic";

/**
 * POST /api/riishe/automations/stop-all — one-step revoke of ALL of the
 * owner's active automations. The explicit "easy stop control".
 */
export const POST = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const cancelled = await stopAllAutomations(user.id);
  return ok({ cancelled });
});
