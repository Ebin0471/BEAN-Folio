import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { ensurePortfolio } from "@/lib/portfolio-server";

/** POST /api/portfolio/unpublish — take the public site offline (draft is kept). */
export const POST = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const row = await ensurePortfolio(user);
  if (!row) return ERR.notFound();

  await db.portfolio.update({ where: { id: row.id }, data: { published: null, publishedAt: null } });
  return ok({ ok: true });
});
