import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, resolveViewerKey, utcDay } from "@/lib/api-helpers";
import { loadViewablePost } from "@/lib/posts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/posts/:id/view — record a deduped view (one per viewer per UTC
 * day, same scheme as ProjectView). Author views are never counted; PRIVATE
 * posts are only viewable (and therefore only countable) by their author.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();

  const loaded = await loadViewablePost(id, sessionUser?.id ?? null);
  if (!loaded) return ERR.notFound();

  const res = ok({ ok: true });

  if (!loaded.isSelf) {
    const viewerKey = resolveViewerKey(req, res, sessionUser?.id ?? null);
    await db.postView
      .upsert({
        where: { postId_viewerKey_day: { postId: id, viewerKey, day: utcDay() } },
        update: {},
        create: { postId: id, viewerKey, day: utcDay() },
      })
      .catch(() => undefined);
  }

  return res;
});
