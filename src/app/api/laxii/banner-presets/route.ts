import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { bannerPresetsForClient } from "@/lib/laxii/banner-presets";

export const dynamic = "force-dynamic";

/**
 * GET /api/laxii/banner-presets — Banner Studio presets with official
 * platform dimensions and safe-area rectangles (e.g. YouTube channel banner
 * 2560×1440 with its 1546×423 central safe area) so the UI can draw guides
 * and the export pipeline can verify constraints.
 */
export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  return ok({ presets: bannerPresetsForClient() });
});
