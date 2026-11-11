import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, parseBody, rateLimit, getClientKey, handler } from "@/lib/api-helpers";
import { ensurePortfolio, validateConfig, isValidSlug, RESERVED_SLUGS } from "@/lib/portfolio-server";

/** GET /api/portfolio — the signed-in user's portfolio (created on first access). */
export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const row = await ensurePortfolio(user);
  if (!row) return err("Set a username in My Folio before creating your portfolio site.", 400);

  const v = validateConfig(JSON.parse(row.draft));
  if (!v.ok) return ERR.server();
  const config = JSON.parse(v.json);
  return ok({
    portfolio: {
      id: row.id,
      slug: row.slug,
      templateId: row.templateId,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      hasPublished: Boolean(row.published),
      updatedAt: row.updatedAt.toISOString(),
    },
    config,
  });
});

const patchSchema = z.object({
  config: z.unknown().optional(),
  slug: z.string().trim().max(24).optional(),
});

/** PATCH /api/portfolio — save the draft config and/or rename the public slug. */
export const PATCH = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`pf:${getClientKey(req)}`, 240, 60_000)) return ERR.rateLimited();

  const row = await ensurePortfolio(user);
  if (!row) return err("Set a username in My Folio before creating your portfolio site.", 400);

  const parsed = await parseBody(req, patchSchema);
  if (parsed.response) return parsed.response;
  const { config, slug } = parsed.data;

  const data: { draft?: string; templateId?: string; slug?: string } = {};

  if (config !== undefined) {
    const v = validateConfig(config);
    if (!v.ok) return err(v.message, 400);
    data.draft = v.json;
    try {
      const parsedConfig = JSON.parse(v.json) as { templateId?: string };
      if (parsedConfig.templateId) data.templateId = parsedConfig.templateId;
    } catch {
      /* unreachable — validateConfig round-trips JSON */
    }
  }

  if (slug !== undefined && slug !== row.slug) {
    const normalized = slug.toLowerCase();
    if (!isValidSlug(normalized) || RESERVED_SLUGS.has(normalized)) {
      return err("Slug must be 3-24 characters: lowercase letters, numbers or hyphens.", 400);
    }
    const clash = await db.portfolio.findUnique({ where: { slug: normalized } });
    if (clash && clash.userId !== user.id) return err("That address is already taken.", 409);
    data.slug = normalized;
  }

  if (Object.keys(data).length === 0) return err("Nothing to update", 400);

  const updated = await db.portfolio.update({ where: { id: row.id }, data });
  return ok({
    portfolio: {
      id: updated.id,
      slug: updated.slug,
      templateId: updated.templateId,
      publishedAt: updated.publishedAt?.toISOString() ?? null,
      hasPublished: Boolean(updated.published),
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
});
