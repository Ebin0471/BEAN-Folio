import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { loadViewablePost, postCardInclude, toPublicPost } from "@/lib/posts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/posts/:id — one post the viewer may see.
 * PUBLIC posts require a publicly visible author (lib/visibility ladder);
 * PRIVATE posts resolve only for their author. Everything else is a 404 that
 * never reveals whether a private post exists.
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();

  const loaded = await loadViewablePost(id, sessionUser?.id ?? null);
  if (!loaded) return ERR.notFound();

  const post = await db.post.findUnique({ where: { id }, include: postCardInclude });
  if (!post) return ERR.notFound();

  let liked = false;
  let bookmarked = false;
  if (sessionUser) {
    const [like, bookmark] = await Promise.all([
      db.postLike.findUnique({ where: { postId_userId: { postId: id, userId: sessionUser.id } } }),
      db.postBookmark.findUnique({ where: { postId_userId: { postId: id, userId: sessionUser.id } } }),
    ]);
    liked = Boolean(like);
    bookmarked = Boolean(bookmark);
  }

  return ok({
    post: toPublicPost(post, { liked, bookmarked }),
    isAuthor: loaded.isSelf,
  });
});

/** DELETE /api/posts/:id — author only. Cascades to media, likes, comments, bookmarks, views. */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  const post = await db.post.findUnique({ where: { id }, select: { authorId: true } });
  if (!post) return ERR.notFound();
  if (post.authorId !== sessionUser.id) return ERR.forbidden();

  await db.post.delete({ where: { id } });
  return ok({ deleted: true });
});
