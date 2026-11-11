import { NextRequest } from "next/server";
import { ok, ERR, getClientKey, rateLimit, handler } from "@/lib/api-helpers";
import { revokeSession, clearSessionCookie } from "@/lib/auth";

export const POST = handler(async (req: NextRequest) => {
  if (!rateLimit("auth:" + getClientKey(req), 10, 60_000)) return ERR.rateLimited();
  await revokeSession();
  await clearSessionCookie(req);
  return ok({ ok: true });
});
