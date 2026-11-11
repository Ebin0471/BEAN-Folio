import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ERR, handler } from "@/lib/api-helpers";
import { ensurePortfolio } from "@/lib/portfolio-server";

/**
 * GET /api/portfolio/export — download the draft config as JSON (owner only).
 * Content-Disposition: attachment so the browser saves it as a file.
 */
export const GET = handler(async (_req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const row = await ensurePortfolio(user);
  if (!row) return ERR.notFound();

  const body = JSON.stringify(
    { kind: "beanfolio-portfolio", version: 1, slug: row.slug, templateId: row.templateId, config: JSON.parse(row.draft) },
    null,
    2
  );
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="beanfolio-portfolio-${row.slug}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
