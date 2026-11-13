import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimit } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; commentId: string }> };

/**
 * POST /api/posts/:id/comments/:commentId/like — like a comment (idempotent;
 * the composite PK makes duplicates structurally impossible).
 */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id, commentId } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  if (!rateLimit(`comment-like:${sessionUser.id}`, 120, 60_000)) return ERR.rateLimited();

  const comment = await db.postComment.findUnique({
    where: { id: commentId },
    select: { id: true, postId: true, status: true },
  });
  if (!comment || comment.postId !== id) return ERR.notFound();

  const existed = await db.postCommentLike.findUnique({
    where: { commentId_userId: { commentId, userId: sessionUser.id } },
  });
  if (!existed) {
    await db.postCommentLike
      .create({ data: { commentId, userId: sessionUser.id } })
      .catch(() => undefined); // concurrent duplicate — success either way
  }

  const likes = await db.postCommentLike.count({ where: { commentId } });
  return ok({ liked: true, likes });
});

/** DELETE — unlike (idempotent). */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id, commentId } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  if (!rateLimit(`comment-like:${sessionUser.id}`, 120, 60_000)) return ERR.rateLimited();

  await db.postCommentLike
    .delete({ where: { commentId_userId: { commentId, userId: sessionUser.id } } })
    .catch(() => undefined);

  const likes = await db.postCommentLike.count({ where: { commentId } });
  return ok({ liked: false, likes });
});
