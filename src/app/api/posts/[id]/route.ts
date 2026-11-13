import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimit, parseBody } from "@/lib/api-helpers";
import {
  loadViewablePost,
  postCardInclude,
  toPublicPost,
  syncPostHashtags,
  normalizeHashtags,
  extractHashtagsFromText,
  resolveProfessionSlug,
  publishTimingSchema,
  type PublishTiming,
} from "@/lib/posts";
import { z } from "zod";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const editSchema = z
  .object({
    body: z.string().max(2000, "Caption must be 2000 characters or fewer").optional(),
    hashtags: z.array(z.string()).max(24).optional(),
    kind: z.enum(["UPDATE", "ANNOUNCEMENT", "WIP", "TUTORIAL", "QUESTION"]).optional(),
    location: z.string().max(80).nullish(),
    profession: z.string().max(64).nullish(),
    visibility: z.enum(["PUBLIC", "PRIVATE"]).optional(),
    timing: publishTimingSchema.optional(),
  })
  .strict();

/**
 * GET /api/posts/:id — one post the viewer may see.
 * PUBLIC posts require a publicly visible author (lib/visibility ladder);
 * PRIVATE posts resolve only for their author, DRAFT/SCHEDULED only for their
 * author. Everything else is a 404 that never reveals whether a private post
 * exists.
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

/**
 * PATCH /api/posts/:id — author-only edits: caption, hashtags, kind,
 * location, profession, visibility and status timing (publish a draft,
 * schedule, back to draft). Hashtag dictionary rows are re-synced in one
 * transaction whenever the tag set changes.
 */
export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  const parsed = await parseBody(req, editSchema);
  if (parsed.response) return parsed.response;
  const input = parsed.data;

  const post = await db.post.findUnique({ where: { id }, select: { authorId: true, body: true, hashtags: true, status: true, profession: true } });
  if (!post) return ERR.notFound();
  if (post.authorId !== sessionUser.id) return ERR.forbidden();

  const data: Record<string, unknown> = {};
  const previousTags = (() => {
    try {
      const v = JSON.parse(post.hashtags);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  })();

  if (input.body !== undefined) data.body = input.body;
  if (input.kind !== undefined) data.kind = input.kind;
  if (input.location !== undefined) data.location = input.location?.trim() || null;
  if (input.visibility !== undefined) data.visibility = input.visibility;

  if (input.hashtags !== undefined) {
    const tags = normalizeHashtags([...input.hashtags, ...extractHashtagsFromText(input.body ?? post.body ?? "")]);
    data.hashtags = JSON.stringify(tags);
  }

  if (input.profession !== undefined) {
    const resolved = await resolveProfessionSlug(input.profession);
    if (resolved === "invalid") return err("Unknown profession — pick a category from the list", 400);
    data.profession = resolved;
  }

  if (input.timing) {
    const t: PublishTiming = input.timing;
    if (t.status === "SCHEDULED") {
      data.status = "SCHEDULED";
      data.scheduledAt = new Date(t.scheduledAt as string);
    } else {
      data.status = t.status;
      data.scheduledAt = null;
    }
  }

  const updated = await db.post.update({
    where: { id },
    data,
    include: postCardInclude,
  });

  if (data.hashtags !== undefined || data.visibility !== undefined || data.status !== undefined) {
    await syncPostHashtags(
      id,
      updated.status === "PUBLISHED" && updated.visibility === "PUBLIC"
        ? safeTags(updated.hashtags)
        : [], // private posts / drafts / scheduled posts do not count toward discovery
      previousTags
    );
  }

  return ok({ post: toPublicPost(updated) });
});

/** DELETE /api/posts/:id — author only. Cascades to media, likes, comments, bookmarks, views. */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  const post = await db.post.findUnique({ where: { id }, select: { authorId: true, hashtags: true, status: true, visibility: true } });
  if (!post) return ERR.notFound();
  if (post.authorId !== sessionUser.id) return ERR.forbidden();

  // Keep the hashtag dictionary consistent when a counted post disappears.
  if (post.status === "PUBLISHED" && post.visibility === "PUBLIC") {
    await syncPostHashtags(id, [], safeTags(post.hashtags));
  }

  await db.post.delete({ where: { id } });
  return ok({ deleted: true });
});

function safeTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
