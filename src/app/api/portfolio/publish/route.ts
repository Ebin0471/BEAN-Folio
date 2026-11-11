import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, rateLimit, getClientKey, handler } from "@/lib/api-helpers";
import { ensurePortfolio } from "@/lib/portfolio-server";
import { homePage, tryParseConfig } from "@/lib/portfolio-schema";

const KEEP_REVISIONS = 20;

/** POST /api/portfolio/publish — snapshot the draft as the live public site. */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`pf-pub:${getClientKey(req)}`, 30, 60_000)) return ERR.rateLimited();

  const row = await ensurePortfolio(user);
  if (!row) return err("Set a username in My Folio before creating your portfolio site.", 400);

  const raw = (() => {
    try {
      return JSON.parse(row.draft);
    } catch {
      return null;
    }
  })();
  const parsed = raw === null ? { ok: false as const, message: "invalid json" } : tryParseConfig(raw);
  if (!parsed.ok) {
    return err("Your draft configuration is invalid. Reload the studio and try again.", 400);
  }
  const heroName = homePage(parsed.config).hero.name.trim();
  if (!heroName) return err("Add your name in the Hero section before publishing.", 400);
  const templateId = parsed.config.templateId ?? row.templateId;

  const now = new Date();
  await db.$transaction([
    db.portfolio.update({
      where: { id: row.id },
      data: { published: row.draft, publishedAt: now, templateId },
    }),
    db.portfolioRevision.create({
      data: { portfolioId: row.id, data: row.draft, label: `Published ${now.toISOString().slice(0, 16).replace("T", " ")}` },
    }),
  ]);

  // Keep only the newest KEEP_REVISIONS snapshots.
  const stale = await db.portfolioRevision.findMany({
    where: { portfolioId: row.id },
    orderBy: { createdAt: "desc" },
    skip: KEEP_REVISIONS,
    select: { id: true },
  });
  if (stale.length > 0) {
    await db.portfolioRevision.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
  }

  const fresh = await db.portfolio.findUnique({ where: { id: row.id } });
  return ok({
    portfolio: {
      slug: fresh?.slug ?? row.slug,
      publishedAt: (fresh?.publishedAt ?? now).toISOString(),
      hasPublished: true,
    },
  });
});
