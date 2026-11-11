import { NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody } from "@/lib/api-helpers";
import { library, setFavourite, type LibraryView } from "@/lib/laxii/conversations";
import { LaxiiError } from "@/lib/laxii/types";

export const dynamic = "force-dynamic";

/**
 * GET   /api/laxii/library?view=images|banners|favourites — my LAXII outputs
 *       (provenance-tagged MediaAssets; served owner-only by /api/media/:id/raw).
 * PATCH /api/laxii/library — toggle favourite on one of my assets.
 */

const patchSchema = z.object({
  assetId: z.string().trim().min(1).max(100),
  favourite: z.boolean(),
});

export const GET = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const viewRaw = req.nextUrl.searchParams.get("view") ?? "images";
  const view: LibraryView = ["images", "banners", "favourites"].includes(viewRaw) ? (viewRaw as LibraryView) : "images";
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "60");
  const assets = await library(user.id, view, Number.isFinite(limit) ? limit : 60);
  return ok({ assets, view });
});

export const PATCH = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;
  try {
    const updated = await setFavourite(user.id, r.data.assetId, r.data.favourite);
    if (!updated) return ERR.notFound();
    return ok(updated);
  } catch (e) {
    if (e instanceof LaxiiError) return err(e.message, 400);
    throw e;
  }
});
