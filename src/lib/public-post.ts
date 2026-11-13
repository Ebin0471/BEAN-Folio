import { db } from "@/lib/db";
import { publicOwnerFilter } from "@/lib/visibility";

/**
 * Server-side SEO metadata for PUBLIC creator posts (`/post/<id>`).
 *
 * Mirrors lib/public-profile.ts: data comes ONLY from the public,
 * viewer-independent payload path. A post whose author is not publicly
 * visible (demo fixture, soft-deleted, PRIVATE profile) or whose visibility
 * is PRIVATE resolves to null → the document emits default metadata with
 * `noindex`, so restricted content can never leak through metadata.
 */

export interface PublicPostMeta {
  id: string;
  /** First line / caption excerpt for the title. */
  excerpt: string | null;
  description: string | null;
  hashtags: string[];
  profession: string | null;
  mediaKind: "TEXT" | "IMAGE" | "VIDEO";
  authorName: string;
  authorUsername: string | null;
  authorHeadline: string | null;
  /** First IMAGE asset id (carousel image or video poster) for og:image. */
  imageMediaId: string | null;
  /** VIDEO asset id + poster for VideoObject / og:video. */
  videoMediaId: string | null;
  createdAt: Date;
}

export async function getPublicPostMeta(postId: string): Promise<PublicPostMeta | null> {
  if (!postId || postId.length > 64) return null;

  const post = await db.post.findFirst({
    where: {
      id: postId,
      status: "PUBLISHED",
      visibility: "PUBLIC",
      author: publicOwnerFilter,
    },
    select: {
      id: true,
      body: true,
      hashtags: true,
      profession: true,
      mediaKind: true,
      createdAt: true,
      author: { select: { username: true, name: true, headline: true } },
      media: {
        orderBy: { order: "asc" as const },
        select: {
          altText: true,
          mediaAsset: { select: { id: true, kind: true } },
          posterMediaAsset: { select: { id: true, kind: true } },
        },
      },
    },
  });
  if (!post) return null;

  const firstImage =
    post.media.find((m) => m.mediaAsset.kind === "IMAGE")?.mediaAsset.id ??
    post.media.find((m) => m.posterMediaAsset?.kind === "IMAGE")?.posterMediaAsset?.id ??
    null;
  const videoId = post.media.find((m) => m.mediaAsset.kind === "VIDEO")?.mediaAsset.id ?? null;
  const alt = post.media.find((m) => m.altText.trim())?.altText.trim() ?? null;

  const excerpt = post.body.trim().split("\n")[0]?.slice(0, 120) || null;
  const description =
    post.body.trim().slice(0, 200) ||
    (post.mediaKind === "VIDEO" && alt ? alt.slice(0, 200) : null) ||
    `A post by ${post.author.name} on BEAN Folio.`;

  let hashtags: string[] = [];
  try {
    const parsed = JSON.parse(post.hashtags);
    if (Array.isArray(parsed)) hashtags = parsed.filter((t): t is string => typeof t === "string").slice(0, 12);
  } catch {
    // unreadable tag JSON → no tags in metadata (never fabricated)
  }

  return {
    id: post.id,
    excerpt,
    description,
    hashtags,
    profession: post.profession,
    mediaKind: post.mediaKind as PublicPostMeta["mediaKind"],
    authorName: post.author.name,
    authorUsername: post.author.username,
    authorHeadline: post.author.headline,
    imageMediaId: firstImage,
    videoMediaId: videoId,
    createdAt: post.createdAt,
  };
}
