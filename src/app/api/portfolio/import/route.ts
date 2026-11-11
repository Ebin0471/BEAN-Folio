import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, parseBody, rateLimit, getClientKey, handler } from "@/lib/api-helpers";
import { ensurePortfolio, validateConfig } from "@/lib/portfolio-server";
import { tryParseConfig } from "@/lib/portfolio-schema";
import { reIdConfig } from "@/lib/portfolio-defaults";

const importSchema = z.object({
  json: z.string().min(2).max(220_000),
});

/**
 * POST /api/portfolio/import — replace the DRAFT with an exported config.
 * Never publishes; ids are re-generated to avoid collisions; the exported
 * wrapper or a bare config is accepted.
 */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`pf-imp:${getClientKey(req)}`, 10, 60_000)) return ERR.rateLimited();

  const row = await ensurePortfolio(user);
  if (!row) return err("Set a username in My Folio before creating your portfolio site.", 400);

  const parsed = await parseBody(req, importSchema);
  if (parsed.response) return parsed.response;

  let raw: unknown;
  try {
    raw = JSON.parse(parsed.data.json);
  } catch {
    return err("That file is not valid JSON.", 400);
  }

  const unwrapped =
    raw && typeof raw === "object" && "kind" in raw && (raw as { kind?: unknown }).kind === "beanfolio-portfolio"
      ? (raw as unknown as { config: unknown }).config
      : raw;

  const check = tryParseConfig(unwrapped);
  if (!check.ok) return err(`Import failed — ${check.message}`, 400);

  const normalized = reIdConfig(check.config);
  const v = validateConfig(normalized);
  if (!v.ok) return err(`Import failed — ${v.message}`, 400);

  await db.portfolio.update({
    where: { id: row.id },
    data: {
      draft: v.json,
      templateId: (normalized as { templateId?: string }).templateId ?? row.templateId,
    },
  });
  return ok({ ok: true });
});
