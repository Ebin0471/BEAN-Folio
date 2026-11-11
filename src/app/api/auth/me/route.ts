import { NextRequest } from "next/server";
import { ok, ERR, getClientKey, rateLimit, handler } from "@/lib/api-helpers";
import { getSessionUser, getUserWithTaxonomy, buildPublicMe } from "@/lib/auth";

export const GET = handler(async (_req: NextRequest) => {
  // This is a cheap, read-only session lookup that runs on every page load.
  // It must NOT share the aggressive login/register bucket (10/min per IP):
  // a shared bucket let bursts of page loads or other visitors behind the
  // same gateway IP 429 the check, which used to surface as a bogus logout.
  if (!rateLimit("auth-me:" + getClientKey(_req), 120, 60_000)) return ERR.rateLimited();

  const user = await getSessionUser();
  if (!user) return ok({ user: null });
  const full = await getUserWithTaxonomy(user.id);
  if (!full) return ok({ user: null });
  return ok({ user: buildPublicMe(full) });
});
