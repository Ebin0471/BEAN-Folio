import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimit } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/posts/:id/hide — "Not interested" negative relevance feedback.
 * Private to the viewer: the post is excluded from the viewer's For You and
 * Trending rankings forever (PostHidden composite PK is idempotent) and never
 * affects what anyone else sees. No notification, no counter, no trace.
 */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  if (!rateLimit(`post-hide:${sessionUser.id}`, 60, 60_000)) return ERR.rateLimited();

  const post = await db.post.findUnique({ where: { id }, select: { id: true } });
  if (!post) return ERR.notFound();

  await db.postHidden
    .upsert({
      where: { userId_postId: { userId: sessionUser.id, postId: id } },
      create: { userId: sessionUser.id, postId: id },
      update: {},
    })
    .catch(() => undefined);

  return ok({ hidden: true });
});
