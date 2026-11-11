import { NextRequest } from "next/server";

import { handler, ok, ERR } from "@/lib/api-helpers";
import { getProfession } from "@/lib/professions/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/**
 * GET /api/professions/:slug — single profession detail (active only; legacy
 * slugs included). 404 for unknown or retired slugs.
 *
 *   { profession: { slug, label, group, description, aliases, order, active,
 *                   family: { slug, label } | null,
 *                   specialisms: [{ slug, label, order }] } }
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { slug } = await params;
  const profession = await getProfession(slug);
  if (!profession) return ERR.notFound();
  return ok({ profession });
});
