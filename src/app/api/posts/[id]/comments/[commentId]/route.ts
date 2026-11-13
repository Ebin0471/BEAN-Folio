import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; commentId: string }> };

/**
 * DELETE /api/posts/:id/comments/:commentId — the comment's author may delete
 * their own comment; the post's author may moderate comments on their own
 * post. Everyone else gets 403. Replies cascade.
 */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id, commentId } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  const comment = await db.postComment.findUnique({
    where: { id: commentId },
    select: { id: true, postId: true, authorId: true, post: { select: { authorId: true } } },
  });
  if (!comment || comment.postId !== id) return ERR.notFound();

  const isCommentAuthor = comment.authorId === sessionUser.id;
  const isPostAuthor = comment.post.authorId === sessionUser.id;
  if (!isCommentAuthor && !isPostAuthor) return ERR.forbidden();

  await db.postComment.delete({ where: { id: commentId } });

  const comments = await db.postComment.count({ where: { postId: id } });
  return ok({ deleted: true, comments });
});
