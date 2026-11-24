import { getSessionUser } from "@/lib/auth";
import { availableSpecialists, serializeSpecialistForUI } from "@/lib/riishe/specialists";
import { ok, ERR, handler } from "@/lib/api-helpers";

/**
 * GET /api/riishe/specialists — the specialist catalog as the UI may show it.
 * Only specialists whose registered tools are ALL available right now are
 * exposed (real capability, never a placeholder card). BEAN identities only
 * — underlying provider/model names never surface.
 */
export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  return ok({ specialists: availableSpecialists().map(serializeSpecialistForUI) });
});
