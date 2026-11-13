import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimit, parseBody } from "@/lib/api-helpers";
import { createCommentSchema, loadViewablePost } from "@/lib/posts";
import { extractMentions, resolveMentions } from "@/lib/posts";
import { notify } from "@/lib/notify";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Serializable comment DTO shared by GET and POST. */
function toComment(
  c: {
    id: string;
    postId: string;
    parentId: string | null;
    body: string;
    status: string;
    createdAt: Date;
    author: { id: string; username: string | null; name: string; avatarMediaId: string | null };
  },
  viewer: { liked: boolean; likes: number; canModerate: boolean }
) {
  return {
    id: c.id,
    postId: c.postId,
    parentId: c.parentId,
    body: c.body,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    author: {
      id: c.author.id,
      username: c.author.username ?? "",
      name: c.author.name,
      avatarUrl: c.author.avatarMediaId ? `/api/media/${c.author.avatarMediaId}/raw` : null,
    },
    likes: viewer.likes,
    liked: viewer.liked,
    canModerate: viewer.canModerate, // hidden-comment approval only for the post owner
  };
}

/**
 * GET /api/posts/:id/comments — paged comment list (newest first).
 * Public viewers see VISIBLE comments only. A RESTRICTED author's comments
 * (status HIDDEN) stay visible to their author and to the post owner (who can
 * approve them); everyone else never learns they exist. Comment like counts
 * and the viewer's own like state are batched per page.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();

  const loaded = await loadViewablePost(id, sessionUser?.id ?? null);
  if (!loaded) return ERR.notFound();

  const isPostOwner = Boolean(sessionUser && loaded.post.authorId === sessionUser.id);

  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);

  // Visibility rule (server-side): VISIBLE for everyone; HIDDEN only for its
  // author or the post owner.
  const visibleOrOwn = {
    AND: [
      { postId: id },
      sessionUser && !isPostOwner
        ? { OR: [{ status: "VISIBLE" }, { authorId: sessionUser.id }] }
        : sessionUser && isPostOwner
          ? {} // the owner sees everything on their own post (moderation view)
          : { status: "VISIBLE" },
    ],
  };

  const [rows, total] = await Promise.all([
    db.postComment.findMany({
      where: visibleOrOwn,
      include: { author: { select: { id: true, username: true, name: true, avatarMediaId: true } } },
      orderBy: { createdAt: "desc" },
      skip: cursor,
      take: limit,
    }),
    db.postComment.count({ where: visibleOrOwn }),
  ]);

  const ids = rows.map((r) => r.id);
  const likeCounts = ids.length
    ? await db.postCommentLike.groupBy({ by: ["commentId"], where: { commentId: { in: ids } }, _count: { userId: true } })
    : [];
  const myLikes =
    sessionUser && ids.length
      ? await db.postCommentLike.findMany({ where: { userId: sessionUser.id, commentId: { in: ids } }, select: { commentId: true } })
      : [];
  const countMap = new Map(likeCounts.map((l) => [l.commentId, l._count.userId]));
  const likedSet = new Set(myLikes.map((l) => l.commentId));

  return ok({
    items: rows.map((c) =>
      toComment(c, { likes: countMap.get(c.id) ?? 0, liked: likedSet.has(c.id), canModerate: isPostOwner })
    ),
    nextCursor: cursor + rows.length < total ? String(cursor + rows.length) : null,
    total,
  });
});

/**
 * POST /api/posts/:id/comments — add a comment or a reply (parentId).
 * Replies must reference a comment on the SAME post. Notifications (post
 * author / parent author / @mentions) fire only after the comment row exists.
 * A RESTRICTED author's new comments start HIDDEN (server-side gate).
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

  // Restricted authors' comments land HIDDEN — the post owner approves them
  // (PATCH status) before anyone else sees them.
  const restrictEdge = await db.accountEdge.findUnique({
    where: { userId_targetId: { userId: loaded.post.authorId, targetId: sessionUser.id } },
    select: { restricted: true },
  });
  const status = restrictEdge?.restricted ? "HIDDEN" : "VISIBLE";

  const comment = await db.postComment.create({
    data: { postId: id, authorId: sessionUser.id, body, parentId: parentId ?? null, status },
    include: { author: { select: { id: true, username: true, name: true, avatarMediaId: true } } },
  });

  const isReply = Boolean(parentId);
  const parentAuthor = parentId
    ? (await db.postComment.findUnique({ where: { id: parentId }, select: { authorId: true } }))?.authorId ?? null
    : null;

  const notified = new Set<string>();
  if (parentAuthor && parentAuthor !== sessionUser.id) {
    notified.add(parentAuthor);
    await notify({
      userId: parentAuthor,
      actorId: sessionUser.id,
      type: "COMMENT_REPLY",
      targetId: comment.id,
      dedupKey: `comment-reply:${sessionUser.id}:${comment.id}`,
      payload: { actor: sessionUser.name, actorUsername: sessionUser.username, postId: id, commentId: comment.id, excerpt: body.slice(0, 140) },
    });
  }
  if (loaded.post.authorId !== sessionUser.id && !notified.has(loaded.post.authorId)) {
    notified.add(loaded.post.authorId);
    await notify({
      userId: loaded.post.authorId,
      actorId: sessionUser.id,
      type: "POST_COMMENT",
      targetId: comment.id,
      dedupKey: `post-comment:${sessionUser.id}:${comment.id}`,
      payload: { actor: sessionUser.name, actorUsername: sessionUser.username, postId: id, commentId: comment.id, excerpt: body.slice(0, 140) },
    });
  }

  // @mentions in comments → real users → MENTION (excluding already-notified).
  const mentioned = await resolveMentions(extractMentions(body), sessionUser.id);
  for (const u of mentioned) {
    if (notified.has(u.id)) continue;
    await notify({
      userId: u.id,
      actorId: sessionUser.id,
      type: "MENTION",
      targetId: comment.id,
      dedupKey: `mention:${sessionUser.id}:${comment.id}`,
      payload: { actor: sessionUser.name, actorUsername: sessionUser.username, postId: id, commentId: comment.id, excerpt: body.slice(0, 140) },
    });
  }

  const comments = await db.postComment.count({ where: { postId: id, status: "VISIBLE" } });
  return ok(
    {
      comment: toComment(comment, { likes: 0, liked: false, canModerate: loaded.post.authorId === sessionUser.id }),
      comments,
    },
    201
  );
});
