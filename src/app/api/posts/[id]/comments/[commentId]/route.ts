import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, parseBody } from "@/lib/api-helpers";
import { z } from "zod";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; commentId: string }> };

const patchSchema = z
  .object({
    body: z.string().trim().min(1, "Comment cannot be empty").max(1000).optional(),
    /** Post-owner only: approve a HIDDEN (restricted) comment. */
    approve: z.boolean().optional(),
  })
  .strict();

/**
 * PATCH /api/posts/:id/comments/:commentId
 *  - the comment's AUTHOR may edit its body;
 *  - the post's OWNER may approve a HIDDEN (restricted-author) comment →
 *    VISIBLE (public again).
 */
export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const { id, commentId } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  const parsed = await parseBody(req, patchSchema);
  if (parsed.response) return parsed.response;
  const input = parsed.data;

  const comment = await db.postComment.findUnique({
    where: { id: commentId },
    select: { id: true, postId: true, authorId: true, status: true, post: { select: { authorId: true } } },
  });
  if (!comment || comment.postId !== id) return ERR.notFound();

  const isCommentAuthor = comment.authorId === sessionUser.id;
  const isPostOwner = comment.post.authorId === sessionUser.id;
  if (!isCommentAuthor && !isPostOwner) return ERR.forbidden();

  const data: Record<string, unknown> = {};
  if (input.body !== undefined) {
    if (!isCommentAuthor) return ERR.forbidden();
    data.body = input.body;
  }
  if (input.approve !== undefined) {
    if (!isPostOwner) return ERR.forbidden();
    data.status = input.approve ? "VISIBLE" : "HIDDEN";
  }
  if (Object.keys(data).length === 0) return ok({ updated: false });

  await db.postComment.update({ where: { id: commentId }, data });
  return ok({ updated: true });
});

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

  const comments = await db.postComment.count({ where: { postId: id, status: "VISIBLE" } });
  return ok({ deleted: true, comments });
});
