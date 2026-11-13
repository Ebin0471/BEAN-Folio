import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publicOwnerFilter } from "@/lib/visibility";

/**
 * BEAN Folio — creator social feed (Discover homepage).
 *
 * Shared validation, normalization and serialization for posts. All PUBLIC
 * reach is derived from the author's LIVE visibility ladder (lib/visibility
 * .ts) and enforced server-side on every read path; the frontend never
 * filters. Media reuses the existing MediaAsset upload + `/api/media/[id]/raw`
 * streaming infrastructure — no new storage system, no mock media.
 */

// ---------------------------------------------------------------- hashtags

const HASHTAG_RE = /^[a-z0-9_]{1,24}$/;
export const MAX_HASHTAGS = 12;

/**
 * Normalize creator-selected hashtags: lowercase, strip leading '#', trim,
 * dedupe, cap at MAX_HASHTAGS. Tags must survive [a-z0-9_]. Hashtags are
 * ALWAYS creator-selected (caption #tags or explicit tag input) — the system
 * never auto-generates or stuffs keywords.
 */
export function normalizeHashtags(input: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const tag = raw.trim().replace(/^#+/, "").toLowerCase();
    if (!tag || !HASHTAG_RE.test(tag)) continue;
    if (!out.includes(tag)) out.push(tag);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}

/** Extract creator-written #tags from a caption/body (merged with explicit tags). */
export function extractHashtagsFromText(body: string): string[] {
  const tags: string[] = [];
  const re = /(?:^|[\s(])#([A-Za-z0-9_]{1,24})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    tags.push(m[1]);
    if (tags.length >= MAX_HASHTAGS * 2) break; // plenty — normalize() dedupes + caps
  }
  return normalizeHashtags(tags);
}

// ---------------------------------------------------------------- mentions

const MENTION_RE = /(?:^|[\s(])@([a-z0-9][a-z0-9-]{2,23})(?=[\s).,!?]|$)/g;

/**
 * Extract @username mentions from a body (lowercased, deduped, capped).
 * Mentions are RESOLVED TO REAL USERS at notify time — a string that matches
 * no account is silently ignored, never fabricating a notification.
 */
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(MENTION_RE);
  while ((m = re.exec(body)) !== null) {
    const uname = m[1].toLowerCase();
    if (!out.includes(uname)) out.push(uname);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * Resolve mention usernames to REAL, followable users (existing accounts,
 * not soft-deleted). Demo fixtures and deleted accounts never receive
 * notifications. Returns [{ id, username }].
 */
export async function resolveMentions(usernames: string[], excludeUserId: string | null): Promise<{ id: string; username: string }[]> {
  if (usernames.length === 0) return [];
  const users = await db.user.findMany({
    where: { username: { in: usernames }, deletedAt: null, isDemo: false },
    select: { id: true, username: true },
  });
  return users
    .filter((u): u is { id: string; username: string } => u.username !== null)
    .filter((u) => u.id !== excludeUserId);
}

// ---------------------------------------------------------------- zod schemas

export const MAX_POST_BODY = 2000;
export const MAX_POST_IMAGES = 8;
export const MAX_POST_ALT = 240;

const bodySchema = z.string().max(MAX_POST_BODY, `Caption must be ${MAX_POST_BODY} characters or fewer`);

export const postMediaInputSchema = z
  .object({
    mediaAssetId: z.string().min(1, "mediaAssetId is required"),
    altText: z.string().max(MAX_POST_ALT).optional().default(""),
  })
  .strict();

export const createPostSchema = z
  .object({
    body: bodySchema.optional().default(""),
    hashtags: z.array(z.string()).max(MAX_HASHTAGS * 2).optional().default([]),
    profession: z.string().max(64).nullish(),
    visibility: z.enum(["PUBLIC", "PRIVATE"]).optional().default("PUBLIC"),
    media: z.array(postMediaInputSchema).max(MAX_POST_IMAGES + 2).optional().default([]),
    /** VIDEO posts only: IMAGE asset used as the thumbnail. */
    posterMediaAssetId: z.string().max(64).nullish(),
    /** Professional post type — creator-selected, never inferred. */
    kind: z.enum(["UPDATE", "ANNOUNCEMENT", "WIP", "TUTORIAL", "QUESTION"]).optional().default("UPDATE"),
    /** Optional creator-written location tag (plain text, never GPS). */
    location: z.string().max(80).nullish(),
  })
  .strict()
  .refine((v) => v.body.trim().length > 0 || v.media.length > 0, {
    message: "A post needs a caption or attached media",
    path: ["body"],
  });

export type CreatePostInput = z.infer<typeof createPostSchema>;

/** Draft payload: like createPostSchema but allows an empty body + scheduling. */
export const createDraftSchema = z
  .object({
    body: bodySchema.optional().default(""),
    hashtags: z.array(z.string()).max(MAX_HASHTAGS * 2).optional().default([]),
    profession: z.string().max(64).nullish(),
    visibility: z.enum(["PUBLIC", "PRIVATE"]).optional().default("PUBLIC"),
    media: z.array(postMediaInputSchema).max(MAX_POST_IMAGES + 2).optional().default([]),
    posterMediaAssetId: z.string().max(64).nullish(),
    kind: z.enum(["UPDATE", "ANNOUNCEMENT", "WIP", "TUTORIAL", "QUESTION"]).optional().default("UPDATE"),
    location: z.string().max(80).nullish(),
    scheduledAt: z.string().datetime().nullish(),
  })
  .strict();

export const publishTimingSchema = z
  .object({
    status: z.enum(["PUBLISHED", "DRAFT", "SCHEDULED"]),
    /** Required for SCHEDULED: ISO timestamp, must be in the future at save time. */
    scheduledAt: z.string().datetime().nullish(),
  })
  .strict()
  .refine((v) => v.status !== "SCHEDULED" || (typeof v.scheduledAt === "string" && new Date(v.scheduledAt).getTime() > Date.now()), {
    message: "Scheduled posts need a future publish time",
    path: ["scheduledAt"],
  });

export type PublishTiming = z.infer<typeof publishTimingSchema>;

export const createCommentSchema = z
  .object({
    body: z.string().trim().min(1, "Comment cannot be empty").max(1000, "Comment must be 1000 characters or fewer"),
    parentId: z.string().max(64).nullish(),
  })
  .strict();

// ---------------------------------------------------------------- visibility

/** Where-clause every PUBLIC post read must include (feeds, detail, sitemap, meta). */
export const publicPostFilter: Prisma.PostWhereInput = {
  status: "PUBLISHED",
  visibility: "PUBLIC",
  author: publicOwnerFilter,
};

/**
 * Load one post the viewer may actually see: PUBLIC posts require a publicly
 * visible author (the lib/visibility ladder); PRIVATE posts are only ever
 * returned to their author. Everything else resolves to null — the caller
 * answers 404 without revealing whether a private post exists.
 */
export async function loadViewablePost(postId: string, viewerId: string | null) {
  const post = await db.post.findUnique({
    where: { id: postId },
    include: { author: { select: { id: true, isDemo: true, deletedAt: true, profileVisibility: true } } },
  });
  if (!post || post.status !== "PUBLISHED") return null;
  const isSelf = viewerId !== null && post.authorId === viewerId;
  if (!isSelf) {
    if (post.visibility !== "PUBLIC") return null;
    const a = post.author;
    if (a.isDemo || a.deletedAt !== null || a.profileVisibility !== "PUBLIC") return null;
  }
  return { post, isSelf };
}

// ---------------------------------------------------------------- serialization

export const postCardInclude = {
  author: {
    select: { id: true, username: true, name: true, headline: true, avatarMediaId: true, isDemo: true },
  },
  media: {
    orderBy: { order: "asc" as const },
    include: {
      mediaAsset: { select: { id: true, kind: true, mime: true, width: true, height: true } },
      posterMediaAsset: { select: { id: true, kind: true } },
    },
  },
  _count: { select: { likes: true, comments: true, bookmarks: true, views: true } },
} satisfies Prisma.PostInclude;

export type PostWithCardRelations = Prisma.PostGetPayload<{ include: typeof postCardInclude }>;

function mediaUrl(id: string): string {
  return `/api/media/${id}/raw`;
}

/** Serialize a post (with postCardInclude relations) as the public DTO. */
export function toPublicPost(
  p: PostWithCardRelations,
  viewer: { liked?: boolean; bookmarked?: boolean } = {}
) {
  return {
    id: p.id,
    body: p.body,
    hashtags: safeStringArray(p.hashtags),
    kind: p.kind,
    location: p.location,
    profession: p.profession,
    mediaKind: p.mediaKind,
    visibility: p.visibility,
    shares: p.shares,
    createdAt: p.createdAt.toISOString(),
    ...(p.status !== "PUBLISHED" ? { status: p.status, scheduledAt: p.scheduledAt?.toISOString() ?? null } : {}),
    author: {
      id: p.author.id,
      username: p.author.username ?? "",
      name: p.author.name,
      headline: p.author.headline,
      avatarUrl: p.author.avatarMediaId ? mediaUrl(p.author.avatarMediaId) : null,
    },
    media: p.media.map((m) => ({
      id: m.id,
      mediaAssetId: m.mediaAssetId,
      url: mediaUrl(m.mediaAssetId),
      kind: m.mediaAsset.kind,
      mime: m.mediaAsset.mime,
      width: m.mediaAsset.width,
      height: m.mediaAsset.height,
      altText: m.altText,
      posterUrl: m.posterMediaAssetId ? mediaUrl(m.posterMediaAssetId) : null,
    })),
    counts: {
      likes: p._count.likes,
      comments: p._count.comments,
      bookmarks: p._count.bookmarks,
      views: p._count.views,
    },
    liked: viewer.liked ?? false,
    bookmarked: viewer.bookmarked ?? false,
  };
}

function safeStringArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- creation

export type ResolvedPostMedia = {
  order: number;
  mediaAssetId: string;
  altText: string;
  posterMediaAssetId: string | null;
};

/**
 * Validate + resolve the media payload for a new post against the REAL
 * MediaAsset table: every asset must be the author's own, READY, and of the
 * kind its slot requires. Returns the resolved media rows (or an error
 * message). VIDEO posts: exactly one VIDEO (+ optional IMAGE poster). IMAGE
 * posts: 1..MAX_POST_IMAGES images (carousel). TEXT posts: no media.
 */
export async function resolvePostMedia(
  authorId: string,
  input: CreatePostInput
): Promise<{ media: ResolvedPostMedia[]; mediaKind: "TEXT" | "IMAGE" | "VIDEO"; error?: string }> {
  const listed = input.media ?? [];
  const ids = [...new Set(listed.map((m) => m.mediaAssetId))];
  if (ids.length !== listed.length) return { media: [], mediaKind: "TEXT", error: "Duplicate media entries in a post are not allowed" };

  let posterId: string | null = null;
  if (input.posterMediaAssetId) {
    posterId = input.posterMediaAssetId;
    if (!ids.includes(posterId)) ids.push(posterId);
  }
  if (ids.length === 0) {
    if (posterId) return { media: [], mediaKind: "TEXT", error: "A poster image requires a video post" };
    return { media: [], mediaKind: "TEXT" };
  }

  const assets = await db.mediaAsset.findMany({
    where: { id: { in: ids }, ownerId: authorId, status: "READY" },
    select: { id: true, kind: true },
  });
  const byId = new Map(assets.map((a) => [a.id, a.kind]));

  const videoEntries = listed.filter((m) => byId.get(m.mediaAssetId) === "VIDEO");
  const imageEntries = listed.filter((m) => byId.get(m.mediaAssetId) === "IMAGE");

  if (videoEntries.length > 1) return { media: [], mediaKind: "TEXT", error: "A video post can contain only one video" };
  if (videoEntries.length === 1) {
    if (listed.length !== 1) return { media: [], mediaKind: "TEXT", error: "A video post contains exactly one video" };
    if (posterId && byId.get(posterId) !== "IMAGE") {
      return { media: [], mediaKind: "TEXT", error: "The video thumbnail must be an image" };
    }
    const m = videoEntries[0];
    return {
      mediaKind: "VIDEO",
      media: [{ order: 0, mediaAssetId: m.mediaAssetId, altText: m.altText ?? "", posterMediaAssetId: posterId }],
    };
  }

  if (posterId) return { media: [], mediaKind: "TEXT", error: "A thumbnail (poster) only applies to video posts" };
  if (imageEntries.length === 0) {
    const first = listed[0];
    const kind = first ? byId.get(first.mediaAssetId) : undefined;
    if (kind === undefined) return { media: [], mediaKind: "TEXT", error: "Attached media was not found among your READY uploads" };
    return { media: [], mediaKind: "TEXT", error: `A post accepts images or one video — ${kind.toLowerCase()} assets are not supported` };
  }
  if (imageEntries.length !== listed.length) {
    return { media: [], mediaKind: "TEXT", error: "Image posts cannot mix videos with images" };
  }
  if (imageEntries.length > MAX_POST_IMAGES) {
    return { media: [], mediaKind: "TEXT", error: `An image post can contain at most ${MAX_POST_IMAGES} images` };
  }

  return {
    mediaKind: "IMAGE",
    media: imageEntries.map((m, i) => ({ order: i, mediaAssetId: m.mediaAssetId, altText: m.altText ?? "", posterMediaAssetId: null })),
  };
}

/** Validate the optional profession slug against the live taxonomy. */
export async function resolveProfessionSlug(slug: string | null | undefined): Promise<string | null | "invalid"> {
  const s = slug?.trim() ?? "";
  if (!s) return null;
  const row = await db.profession.findUnique({ where: { slug: s }, select: { slug: true } });
  return row ? row.slug : "invalid";
}

// ---------------------------------------------------------------- hashtag sync

/**
 * Sync the Hashtag/PostHashtag dictionary rows for one post. Only PUBLIC,
 * PUBLISHED posts count toward postCount (private posts and drafts never
 * feed discovery). Pass previousTags when a post's tags change — the
 * counters are adjusted in ONE transaction so counts never drift.
 */
export async function syncPostHashtags(postId: string, tags: string[], previousTags: string[] = []): Promise<void> {
  const added = tags.filter((t) => !previousTags.includes(t));
  const removed = previousTags.filter((t) => !tags.includes(t));
  if (added.length === 0 && removed.length === 0) return;

  await db.$transaction(async (tx) => {
    if (added.length > 0) {
      for (const tag of added) {
        const row = await tx.hashtag.upsert({
          where: { name: tag },
          create: { name: tag, postCount: 1, lastUsedAt: new Date() },
          update: { postCount: { increment: 1 }, lastUsedAt: new Date() },
        });
        await tx.postHashtag.upsert({
          where: { postId_hashtagId: { postId, hashtagId: row.id } },
          create: { postId, hashtagId: row.id },
          update: {},
        });
      }
    }
    if (removed.length > 0) {
      const rows = await tx.hashtag.findMany({ where: { name: { in: removed } }, select: { id: true, name: true } });
      await tx.postHashtag.deleteMany({ where: { postId, hashtagId: { in: rows.map((r) => r.id) } } });
      for (const r of rows) {
        await tx.hashtag.update({ where: { id: r.id }, data: { postCount: { decrement: 1 } } });
      }
    }
  }).catch(() => undefined); // hashtag dictionary is derivable — a sync failure never fails the post write
}
