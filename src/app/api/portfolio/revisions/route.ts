import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { ensurePortfolio } from "@/lib/portfolio-server";

/** GET /api/portfolio/revisions — list saved published snapshots (owner only). */
export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const row = await ensurePortfolio(user);
  if (!row) return ERR.notFound();

  const revisions = await db.portfolioRevision.findMany({
    where: { portfolioId: row.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, label: true, createdAt: true },
  });
  return ok({ revisions: revisions.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) });
});
