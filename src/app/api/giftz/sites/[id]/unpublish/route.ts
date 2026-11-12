import { handler, ok, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/giftz/sites/[id]/unpublish — take THIS generated site offline.
 * Owner-scoped; the draft config is untouched — only the public snapshot
 * stops being served.
 */
export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findUnique({ where: { id }, select: { id: true, userId: true } });
  if (!site || site.userId !== user.id) return ERR.notFound();

  await db.giftzSite.update({
    where: { id: site.id },
    data: { status: "DRAFT", publishedConfig: null, publishedAt: null, updatedAt: new Date() },
  });

  return ok({ status: "DRAFT", publishedAt: null });
});
