import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimit, getClientKey } from "@/lib/api-helpers";
import { loadViewablePost } from "@/lib/posts";
import { seoOrigin } from "@/lib/site-url";
import { notify } from "@/lib/notify";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/posts/:id/share — record a share click AND the underlying
 * share-event row (PostShareEvent — the analytics ledger behind the counter),
 * then return the public share URL. The canonical public URL is the PATH form
 * /post/<id> (served by the proxy with real SEO metadata); only public,
 * viewable posts get a share response — private content is never shareable.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();

  const loaded = await loadViewablePost(id, sessionUser?.id ?? null);
  if (!loaded) return ERR.notFound();

  if (!rateLimit(`post-share:${sessionUser?.id ?? getClientKey(req)}`, 120, 60_000)) return ERR.rateLimited();

  await db.$transaction([
    db.post.update({ where: { id }, data: { shares: { increment: 1 } } }),
    db.postShareEvent.create({
      data: { postId: id, userId: sessionUser?.id ?? null, channel: "link" },
    }),
  ]).catch(() => undefined);

  // Best-effort notification (never for self-shares, deduped per retry).
  if (sessionUser && loaded.post.authorId !== sessionUser.id) {
    await notify({
      userId: loaded.post.authorId,
      actorId: sessionUser.id,
      type: "POST_SHARE",
      targetId: id,
      dedupKey: `post-share:${sessionUser.id}:${id}`,
      payload: { actor: sessionUser.name, actorUsername: sessionUser.username, postId: id, excerpt: loaded.post.body.slice(0, 120) },
    });
  }

  const post = await db.post.findUnique({ where: { id }, select: { shares: true } });
  const origin = seoOrigin();
  return ok({
    shares: post?.shares ?? 0,
    shareUrl: origin ? `${origin}/post/${id}` : `/post/${id}`,
  });
});
