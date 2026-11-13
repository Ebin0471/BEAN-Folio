import { NextRequest, NextResponse } from "next/server";

import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeConfig } from "@/lib/site-config";
import { saveGiftzSiteConfig, putSchema } from "../route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/giftz/sites/[id] — the owner's generated site (config included).
 * Strictly owner-scoped: another user's site id is a 404.
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findUnique({ where: { id } });
  if (!site || site.userId !== user.id) return ERR.notFound();

  return ok({
    site: {
      id: site.id,
      title: site.title,
      status: site.status,
      sourcePrompt: site.sourcePrompt,
      config: site.config ? normalizeConfig(site.config) : null,
      publishedConfig: site.publishedConfig ? normalizeConfig(site.publishedConfig) : null,
      publishedAt: site.publishedAt?.toISOString() ?? null,
      createdAt: site.createdAt.toISOString(),
      updatedAt: site.updatedAt.toISOString(),
    },
  });
});

/**
 * PUT /api/giftz/sites/[id] — save the generated site's working draft
 * (config and/or title). Owner-scoped; runs the same media IDOR guard as the
 * portfolio saves; snapshots "Before save" revisions (newest 10 kept).
 */
export const PUT = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const r = await parseBody(req, putSchema);
  if (r.response) return r.response;

  const result = await saveGiftzSiteConfig(user.id, id, {
    title: r.data.title,
    config: r.data.config,
  });
  if (!result.ok) return err(result.message, result.status);

  return ok({ saved: true, savedAt: new Date().toISOString(), config: result.config });
});

/**
 * DELETE /api/giftz/sites/[id] — the OWNER's own explicit deletion of one
 * generated site (cascades to its revisions). Owner-scoped; never called by
 * any automated flow.
 */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findUnique({ where: { id }, select: { id: true, userId: true } });
  if (!site || site.userId !== user.id) return ERR.notFound();

  await db.giftzSite.delete({ where: { id: site.id } });
  return NextResponse.json({ deleted: true }, { status: 200 });
});
