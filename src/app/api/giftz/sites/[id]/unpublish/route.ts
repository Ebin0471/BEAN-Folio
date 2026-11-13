import { handler, ok, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { unpublishGiftzSiteProject } from "@/lib/giftz/project-deploy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/giftz/sites/[id]/unpublish — take THIS generated site offline.
 * Owner-scoped; the draft config is untouched — only the public snapshot
 * stops being served.
 *
 * Standalone-platform addition (contract §7.1, additive): when the site has
 * file-based deployments, the newest LIVE rows become ROLLED_BACK with the
 * honest "unpublished" note (so the public file route stops serving) and
 * deployStatus returns to DRAFT. The legacy response shape is unchanged.
 */
export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findUnique({ where: { id }, select: { id: true, userId: true } });
  if (!site || site.userId !== user.id) return ERR.notFound();

  await db.giftzSite.update({
    where: { id: site.id },
    data: {
      status: "DRAFT",
      publishedConfig: null,
      publishedAt: null,
      deployStatus: "DRAFT",
      updatedAt: new Date(),
    },
  });
  await unpublishGiftzSiteProject(user, site);

  return ok({ status: "DRAFT", publishedAt: null });
});
