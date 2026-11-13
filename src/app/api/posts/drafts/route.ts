import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimit, parseBody } from "@/lib/api-helpers";
import {
  createDraftSchema,
  resolvePostMedia,
  resolveProfessionSlug,
  normalizeHashtags,
  extractHashtagsFromText,
  postCardInclude,
  toPublicPost,
} from "@/lib/posts";

export const dynamic = "force-dynamic";

/**
 * POST /api/posts/drafts — save a DRAFT or SCHEDULED post (author-only until
 * published through PATCH /api/posts/:id with { timing }). Drafts accept an
 * empty caption (a draft may hold only media or an intent). SCHEDULED posts
 * publish automatically when due (feed-read sweep + queue worker).
 */
export const POST = handler(async (req: NextRequest) => {
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  // Same create budget as instant posts (shared bucket).
  if (!rateLimit(`post-create:${sessionUser.id}`, 20, 60 * 60_000)) return ERR.rateLimited();

  const parsed = await parseBody(req, createDraftSchema);
  if (parsed.response) return parsed.response;
  const input = parsed.data;

  const resolved = await resolvePostMedia(sessionUser.id, input);
  if (resolved.error) return err(resolved.error, 400);

  const profession = await resolveProfessionSlug(input.profession);
  if (profession === "invalid") return err("Unknown profession — pick a category from the list", 400);

  const hashtags = normalizeHashtags([...(input.hashtags ?? []), ...extractHashtagsFromText(input.body ?? "")]);

  const scheduled = typeof input.scheduledAt === "string" && new Date(input.scheduledAt).getTime() > Date.now();
  const status = scheduled ? "SCHEDULED" : "DRAFT";

  const post = await db.post.create({
    data: {
      authorId: sessionUser.id,
      body: input.body ?? "",
      hashtags: JSON.stringify(hashtags),
      kind: input.kind,
      location: input.location?.trim() || null,
      profession: profession ?? null,
      mediaKind: resolved.mediaKind,
      visibility: input.visibility ?? "PUBLIC",
      status,
      ...(scheduled ? { scheduledAt: new Date(input.scheduledAt as string) } : {}),
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

/**
 * GET /api/posts/drafts — the author's own DRAFT + SCHEDULED posts (newest
 * first). Nobody else's, ever — the where clause is owner-scoped.
 */
export const GET = handler(async () => {
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  const rows = await db.post.findMany({
    where: { authorId: sessionUser.id, status: { in: ["DRAFT", "SCHEDULED"] } },
    include: postCardInclude,
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  return ok({ items: rows.map((p) => toPublicPost(p)) });
});
