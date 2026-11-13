import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimit } from "@/lib/api-helpers";
import { loadViewablePost } from "@/lib/posts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/posts/:id/like — like a viewable post.
 * The composite PK (postId, userId) makes duplicate likes structurally
 * impossible; re-liking is idempotent. The author receives one POST_LIKE
 * notification per like (not per actor toggling).
 */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  if (!rateLimit(`post-like:${sessionUser.id}`, 120, 60_000)) return ERR.rateLimited();

  const loaded = await loadViewablePost(id, sessionUser.id);
  if (!loaded) return ERR.notFound();

  const existed = await db.postLike.findUnique({
    where: { postId_userId: { postId: id, userId: sessionUser.id } },
  });
  if (!existed) {
    await db.postLike
      .create({ data: { postId: id, userId: sessionUser.id } })
      .catch(() => undefined); // concurrent duplicate — treat as success
    if (loaded.post.authorId !== sessionUser.id) {
      await db.notification
        .create({
          data: {
            userId: loaded.post.authorId,
            type: "POST_LIKE",
            payload: JSON.stringify({ actor: sessionUser.name, actorUsername: sessionUser.username, postId: id }),
          },
        })
        .catch(() => undefined);
    }
  }

  const likes = await db.postLike.count({ where: { postId: id } });
  return ok({ liked: true, likes });
});

/** DELETE /api/posts/:id/like — unlike (idempotent). */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  if (!rateLimit(`post-like:${sessionUser.id}`, 120, 60_000)) return ERR.rateLimited();

  const loaded = await loadViewablePost(id, sessionUser.id);
  if (!loaded) return ERR.notFound();

  await db.postLike.delete({ where: { postId_userId: { postId: id, userId: sessionUser.id } } }).catch(() => undefined);

  const likes = await db.postLike.count({ where: { postId: id } });
  return ok({ liked: false, likes });
});
