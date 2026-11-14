import { NextRequest } from "next/server";
import { ok, ERR, getClientKey, rateLimit, handler, sameOriginOk } from "@/lib/api-helpers";
import { revokeSession, clearSessionCookie } from "@/lib/auth";

export const POST = handler(async (req: NextRequest) => {
  if (!sameOriginOk(req)) return ERR.forbidden(); // logout-CSRF: cross-host Origin can never clear a cookie
  if (!rateLimit("auth:" + getClientKey(req), 10, 60_000)) return ERR.rateLimited();
  await revokeSession();
  await clearSessionCookie(req);
  return ok({ ok: true });
});
