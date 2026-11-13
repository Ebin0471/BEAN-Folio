import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimit } from "@/lib/api-helpers";
import { loadViewablePost } from "@/lib/posts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/posts/:id/bookmark — save a post.
 * Composite PK (postId, userId) → duplicate bookmarks are structurally
 * impossible; toggling is idempotent and counts stay accurate.
 */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  if (!rateLimit(`post-save:${sessionUser.id}`, 120, 60_000)) return ERR.rateLimited();

  const loaded = await loadViewablePost(id, sessionUser.id);
  if (!loaded) return ERR.notFound();

  const existed = await db.postBookmark.findUnique({
    where: { postId_userId: { postId: id, userId: sessionUser.id } },
  });
  if (!existed) {
    await db.postBookmark
      .create({ data: { postId: id, userId: sessionUser.id } })
      .catch(() => undefined);
  }

  const bookmarks = await db.postBookmark.count({ where: { postId: id } });
  return ok({ bookmarked: true, bookmarks });
});

/** DELETE /api/posts/:id/bookmark — remove the save (idempotent). */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  if (!rateLimit(`post-save:${sessionUser.id}`, 120, 60_000)) return ERR.rateLimited();

  const loaded = await loadViewablePost(id, sessionUser.id);
  if (!loaded) return ERR.notFound();

  await db.postBookmark
    .delete({ where: { postId_userId: { postId: id, userId: sessionUser.id } } })
    .catch(() => undefined);

  const bookmarks = await db.postBookmark.count({ where: { postId: id } });
  return ok({ bookmarked: false, bookmarks });
});
