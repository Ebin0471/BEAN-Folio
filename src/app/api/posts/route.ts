import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimit } from "@/lib/api-helpers";
import { parseBody } from "@/lib/api-helpers";
import {
  createPostSchema,
  resolvePostMedia,
  resolveProfessionSlug,
  normalizeHashtags,
  extractHashtagsFromText,
  postCardInclude,
  toPublicPost,
} from "@/lib/posts";

export const dynamic = "force-dynamic";

/**
 * POST /api/posts — create a creator post (text | image carousel | video/reel).
 * REAL persistence against the Post/PostMedia tables; media reuses the
 * existing MediaAsset uploads (ownership + kind enforced per slot by
 * resolvePostMedia). No simulation: a failed validation or failed create
 * returns an error response, never a success.
 */

export const POST = handler(async (req: NextRequest) => {
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  // 20 posts per hour per account — bounds feed flooding without limiting
  // normal creative posting.
  if (!rateLimit(`post-create:${sessionUser.id}`, 20, 60 * 60_000)) return ERR.rateLimited();

  const parsed = await parseBody(req, createPostSchema);
  if (parsed.response) return parsed.response;
  const input = parsed.data;

  const resolved = await resolvePostMedia(sessionUser.id, input);
  if (resolved.error) return err(resolved.error, 400);

  const profession = await resolveProfessionSlug(input.profession);
  if (profession === "invalid") return err("Unknown profession — pick a category from the list", 400);

  const hashtags = normalizeHashtags([...(input.hashtags ?? []), ...extractHashtagsFromText(input.body ?? "")]);

  const post = await db.post.create({
    data: {
      authorId: sessionUser.id,
      body: input.body ?? "",
      hashtags: JSON.stringify(hashtags),
      profession: profession ?? null,
      mediaKind: resolved.mediaKind,
      visibility: input.visibility ?? "PUBLIC",
      status: "PUBLISHED",
      ...(resolved.media.length > 0
        ? { media: { create: resolved.media.map((m) => ({
            order: m.order,
            mediaAssetId: m.mediaAssetId,
            altText: m.altText,
            ...(m.posterMediaAssetId ? { posterMediaAssetId: m.posterMediaAssetId } : {}),
          })) } }
        : {}),
    },
    include: postCardInclude,
  });

  return ok(toPublicPost(post), 201);
});
