import { NextRequest } from "next/server";

import { handler, ok, ERR } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { normalizeConfig } from "@/lib/site-config";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/giftz/sites/[id]/public — PUBLIC render data for a PUBLISHED
 * GIFTZ generated site: the immutable publishedConfig snapshot + the
 * creator's public identity (username/name only). Drafts and unpublished
 * sites are 404 for everyone except the owner (who uses the owner GET).
 *
 * Profile/projects/collections data comes from the standard public profile
 * endpoint (/api/profiles/:username) — the exact same public filters the
 * portfolio website renders through. A PRIVATE profile therefore keeps its
 * generated sites unreachable to visitors, exactly like the portfolio site.
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const site = await db.giftzSite.findUnique({
    where: { id },
    select: {
      status: true,
      publishedConfig: true,
      publishedAt: true,
      title: true,
      userId: true,
      user: { select: { username: true, name: true, deletedAt: true } },
    },
  });

  if (!site || site.status !== "PUBLISHED" || !site.publishedConfig || site.user.deletedAt) {
    return ERR.notFound();
  }

  const config = normalizeConfig(site.publishedConfig);
  if (!config) return ERR.notFound();

  return ok({
    site: {
      id,
      title: site.title,
      config,
      publishedAt: site.publishedAt?.toISOString() ?? null,
    },
    owner: {
      username: site.user.username,
      name: site.user.name,
    },
  });
});
