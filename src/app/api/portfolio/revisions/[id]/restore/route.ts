import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler } from "@/lib/api-helpers";
import { ensurePortfolio, validateConfig } from "@/lib/portfolio-server";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/portfolio/revisions/:id/restore — copy a snapshot back into the draft. */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const row = await ensurePortfolio(user);
  if (!row) return ERR.notFound();
  const { id } = await params;

  const revision = await db.portfolioRevision.findFirst({
    where: { id, portfolioId: row.id }, // ownership scoped — foreign ids 404
  });
  if (!revision) return ERR.notFound();

  const v = validateConfig(JSON.parse(revision.data));
  if (!v.ok) return err("That snapshot is no longer compatible with the current schema.", 400);

  await db.portfolio.update({ where: { id: row.id }, data: { draft: v.json } });
  return ok({ ok: true });
});
