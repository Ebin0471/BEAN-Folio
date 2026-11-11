import { NextRequest } from "next/server";

import { handler, ok } from "@/lib/api-helpers";
import { listFlat, listTree } from "@/lib/professions/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/professions — profession taxonomy for pickers.
 *
 * Default (unchanged legacy shape):
 *   { professions: [{ slug, label, group }] }
 *   — active professions: the 18 legacy rows first in their historical order
 *   (byte-compatible with the pre-expansion route), then new professions by
 *   family order then row order.
 *
 * Tree mode (?tree=1):
 *   { families: [{ slug, label, description, order,
 *       professions: [{ slug, label, description, aliases, order,
 *                      specialisms: [{ slug, label }] }] }] }
 */
export const GET = handler(async (req: NextRequest) => {
  const tree = new URL(req.url).searchParams.get("tree");
  if (tree === "1" || tree === "true") {
    return ok(await listTree());
  }
  return ok({ professions: await listFlat() });
});
