import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimit, getClientKey } from "@/lib/api-helpers";
import { loadViewablePost } from "@/lib/posts";
import { seoOrigin } from "@/lib/site-url";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/posts/:id/share — record a share click and return the public
 * share URL. The canonical public URL is the PATH form /post/<id> (served by
 * the proxy with real SEO metadata); only public, viewable posts get a share
 * endpoint response.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();

  const loaded = await loadViewablePost(id, sessionUser?.id ?? null);
  if (!loaded) return ERR.notFound();

  if (!rateLimit(`post-share:${sessionUser?.id ?? getClientKey(req)}`, 120, 60_000)) return ERR.rateLimited();

  await db.post
    .update({ where: { id }, data: { shares: { increment: 1 } } })
    .catch(() => undefined);

  const post = await db.post.findUnique({ where: { id }, select: { shares: true } });
  const origin = seoOrigin();
  return ok({
    shares: post?.shares ?? 0,
    shareUrl: origin ? `${origin}/post/${id}` : `/post/${id}`,
  });
});
