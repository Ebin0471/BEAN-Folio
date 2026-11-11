import { NextRequest } from "next/server";
import { ok, handler } from "@/lib/api-helpers";

/**
 * GET /api — service banner. Same payload as /api/health; wrapped in the
 * standard handler() so it also carries the `x-request-id` response header
 * (scale phase, 2-a).
 */
export const GET = handler(async (_req: NextRequest) => {
  return ok({ ok: true, service: "bean-folio", time: new Date().toISOString() });
});
