import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";
import { listAutomations, stopAllAutomations } from "@/lib/riishe/engine";
import { listNotes } from "@/lib/riishe/reports";

export const dynamic = "force-dynamic";

/**
 * GET /api/riishe/automations — the owner's automations (with recent run
 * state) and their private contact notes. Strictly owner-scoped.
 */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const [automations, notes] = await Promise.all([listAutomations(user.id), listNotes(user.id, 10)]);
  return ok({ automations, notes });
});

/**
 * POST /api/riishe/automations — bulk revoke control: stop-all cancels every
 * active automation in one step (the "easy stop control" for automation).
 */
export const POST = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const cancelled = await stopAllAutomations(user.id);
  return ok({ cancelled });
});
