import { NextRequest } from "next/server";
import { z } from "zod";

import { handler, ok, parseBody, rateLimit, getClientKey, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeConfig } from "@/lib/site-config";
import { siteConfigMediaError } from "@/lib/site-media-guard";

export const dynamic = "force-dynamic";

/**
 * GIFTZ generated sites — the independent prompt-driven website artifacts.
 *
 * A GiftzSite is fully separate from the user's portfolio website
 * (SiteDesign): creating, listing, saving or publishing one never touches the
 * portfolio draft/published snapshot, and Customization never touches a
 * GiftzSite. This route is OWNER-scoped end to end.
 */

/** GET /api/giftz/sites — the caller's generated sites, newest first. */
export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const sites = await db.giftzSite.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: {
      id: true,
      title: true,
      status: true,
      sourcePrompt: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return ok({
    sites: sites.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      sourcePrompt: s.sourcePrompt,
      publishedAt: s.publishedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    })),
  });
});

const createSchema = z.object({
  title: z.string().trim().max(120).optional(),
  /** The prompt that starts the generation — stored as provenance. */
  sourcePrompt: z.string().max(50_000).optional(),
});

/** POST /api/giftz/sites — create an empty generated-site draft. */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`giftz-sites:${getClientKey(req)}`, 20, 60_000)) return ERR.rateLimited();

  const r = await parseBody(req, createSchema);
  if (r.response) return r.response;

  const site = await db.giftzSite.create({
    data: {
      userId: user.id,
      title: r.data.title?.trim().slice(0, 120) || "Untitled site",
      sourcePrompt: r.data.sourcePrompt?.slice(0, 50_000) ?? null,
    },
  });

  return ok({
    site: {
      id: site.id,
      title: site.title,
      status: site.status,
      sourcePrompt: site.sourcePrompt,
      config: null,
      publishedAt: null,
      createdAt: site.createdAt.toISOString(),
      updatedAt: site.updatedAt.toISOString(),
    },
  });
});

export const putSchema = z.object({
  title: z.string().trim().max(120).optional(),
  config: z.unknown().optional(),
});

export type PutData = z.infer<typeof putSchema>;

/**
 * Save helper shared by the [id] PUT route (exported for tests): owner check,
 * schema normalize, the SAME media IDOR guard the portfolio saves enforce,
 * and a bounded "Before save" revision snapshot so earlier generated versions
 * stay recoverable.
 */
export async function saveGiftzSiteConfig(
  userId: string,
  siteId: string,
  input: { title?: string; config?: unknown }
): Promise<{ ok: true; config: ReturnType<typeof normalizeConfig> } | { ok: false; message: string; status: number }> {
  const site = await db.giftzSite.findUnique({ where: { id: siteId }, select: { id: true, userId: true, config: true } });
  if (!site || site.userId !== userId) {
    return { ok: false, message: "Generated site not found", status: 404 };
  }

  let configJson: string | null = null;
  if (input.config !== undefined) {
    const normalized = normalizeConfig(input.config);
    if (!normalized) {
      return { ok: false, message: "This website configuration is not valid.", status: 400 };
    }
    // Same IDOR guard as the portfolio site saves: every referenced media id
    // must be the owner's own, and reel media must be VIDEO assets.
    const mediaError = await siteConfigMediaError(normalized, userId);
    if (mediaError) return { ok: false, message: mediaError, status: 400 };
    configJson = JSON.stringify(normalized);
  }

  // Revision snapshot — when a save CHANGES an existing draft config, the
  // previous version is kept so earlier generated versions stay recoverable
  // (bounded: newest 10 per site).
  if (site.config && configJson && site.config !== configJson) {
    await db.giftzSiteRevision.create({
      data: { siteId: site.id, label: "Before save", config: site.config },
    });
    const stale = await db.giftzSiteRevision.findMany({
      where: { siteId: site.id },
      orderBy: { createdAt: "desc" },
      skip: 10,
      select: { id: true },
    });
    if (stale.length > 0) {
      await db.giftzSiteRevision.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
  }

  await db.giftzSite.update({
    where: { id: site.id },
    data: {
      ...(input.title !== undefined ? { title: input.title.trim().slice(0, 120) || "Untitled site" } : {}),
      ...(configJson !== null ? { config: configJson } : {}),
      updatedAt: new Date(),
    },
  });

  const saved = configJson ? normalizeConfig(configJson) : null;
  return { ok: true, config: saved };
}
