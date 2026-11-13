import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimit, parseBody } from "@/lib/api-helpers";
import {
  createPostSchema,
  resolvePostMedia,
  resolveProfessionSlug,
  normalizeHashtags,
  extractHashtagsFromText,
  extractMentions,
  resolveMentions,
  postCardInclude,
  toPublicPost,
  syncPostHashtags,
} from "@/lib/posts";
import { notify } from "@/lib/notify";

export const dynamic = "force-dynamic";

/**
 * POST /api/posts — create a creator post (text | image carousel | video/reel;
 * UPDATE | ANNOUNCEMENT | WIP | TUTORIAL | QUESTION; PUBLIC | PRIVATE;
 * PUBLISHED | DRAFT | SCHEDULED). REAL persistence against the Post/PostMedia
 * tables; media reuses the existing MediaAsset uploads (ownership + kind
 * enforced per slot by resolvePostMedia). No simulation: a failed validation
 * or failed create returns an error response, never a success.
 *
 * Notifications for @mentions are sent only AFTER the post row exists and
 * only to real, non-deleted accounts (never fabricated).
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

  const location = input.location?.trim() || null;
  const status = "PUBLISHED"; // drafts go through POST /api/posts/drafts
  const post = await db.post.create({
    data: {
      authorId: sessionUser.id,
      body: input.body ?? "",
      hashtags: JSON.stringify(hashtags),
      kind: input.kind,
      location,
      profession: profession ?? null,
      mediaKind: resolved.mediaKind,
      visibility: input.visibility ?? "PUBLIC",
      status,
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

  // Hashtag dictionary sync — only PUBLIC PUBLISHED posts count toward
  // discovery (private posts and drafts never feed hashtags). Failures
  // never fail the post (the dictionary is derivable).
  await syncPostHashtags(post.id, (input.visibility ?? "PUBLIC") === "PUBLIC" ? hashtags : []);

  // @mentions → real users → MENTION notifications (post already persisted).
  const mentioned = await resolveMentions(extractMentions(input.body ?? ""), sessionUser.id);
  for (const u of mentioned) {
    await notify({
      userId: u.id,
      actorId: sessionUser.id,
      type: "MENTION",
      targetId: post.id,
      dedupKey: `mention:${sessionUser.id}:${post.id}`,
      payload: { actor: sessionUser.name, actorUsername: sessionUser.username, postId: post.id, excerpt: (input.body ?? "").slice(0, 120) },
    });
  }

  return ok(toPublicPost(post), 201);
});
