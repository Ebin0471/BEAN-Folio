import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimit, parseBody } from "@/lib/api-helpers";
import { createCommentSchema, loadViewablePost } from "@/lib/posts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/posts/:id/comments — paged comment list (newest first).
 * Offset cursor; every page resolves author identity server-side.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();

  const loaded = await loadViewablePost(id, sessionUser?.id ?? null);
  if (!loaded) return ERR.notFound();

  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);

  const [rows, total] = await Promise.all([
    db.postComment.findMany({
      where: { postId: id },
      include: { author: { select: { id: true, username: true, name: true, avatarMediaId: true } } },
      orderBy: { createdAt: "desc" },
      skip: cursor,
      take: limit,
    }),
    db.postComment.count({ where: { postId: id } }),
  ]);

  return ok({
    items: rows.map((c) => ({
      id: c.id,
      postId: c.postId,
      parentId: c.parentId,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      author: {
        id: c.author.id,
        username: c.author.username ?? "",
        name: c.author.name,
        avatarUrl: c.author.avatarMediaId ? `/api/media/${c.author.avatarMediaId}/raw` : null,
      },
    })),
    nextCursor: cursor + rows.length < total ? String(cursor + rows.length) : null,
    total,
  });
});

/**
 * POST /api/posts/:id/comments — add a comment or a reply (parentId).
 * Replies must reference a comment on the SAME post. The post author (and,
 * for replies, the parent's author) receive POST_COMMENT notifications.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  if (!rateLimit(`post-comment:${sessionUser.id}`, 30, 60_000)) return ERR.rateLimited();

  const loaded = await loadViewablePost(id, sessionUser.id);
  if (!loaded) return ERR.notFound();

  const parsed = await parseBody(req, createCommentSchema);
  if (parsed.response) return parsed.response;
  const { body, parentId } = parsed.data;

  if (parentId) {
    const parent = await db.postComment.findUnique({ where: { id: parentId }, select: { id: true, postId: true } });
    if (!parent || parent.postId !== id) return err("The comment being replied to was not found on this post", 400);
  }

  const comment = await db.postComment.create({
    data: { postId: id, authorId: sessionUser.id, body, parentId: parentId ?? null },
    include: { author: { select: { id: true, username: true, name: true, avatarMediaId: true } } },
  });

  // Notifications: post author (unless self) + parent-comment author on replies.
  const notifyIds = new Set<string>();
  if (loaded.post.authorId !== sessionUser.id) notifyIds.add(loaded.post.authorId);
  if (parentId) {
    const parent = await db.postComment.findUnique({ where: { id: parentId }, select: { authorId: true } });
    if (parent && parent.authorId !== sessionUser.id) notifyIds.add(parent.authorId);
  }
  for (const userId of notifyIds) {
    await db.notification
      .create({
        data: {
          userId,
          type: "POST_COMMENT",
          payload: JSON.stringify({ actor: sessionUser.name, actorUsername: sessionUser.username, postId: id, commentId: comment.id }),
        },
      })
      .catch(() => undefined);
  }

  return ok(
    {
      comment: {
        id: comment.id,
        postId: comment.postId,
        parentId: comment.parentId,
        body: comment.body,
        createdAt: comment.createdAt.toISOString(),
        author: {
          id: comment.author.id,
          username: comment.author.username ?? "",
          name: comment.author.name,
          avatarUrl: comment.author.avatarMediaId ? `/api/media/${comment.author.avatarMediaId}/raw` : null,
        },
      },
      comments: await db.postComment.count({ where: { postId: id } }),
    },
    201
  );
});
