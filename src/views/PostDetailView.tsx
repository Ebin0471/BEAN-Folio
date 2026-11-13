"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, CloudOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PostCard, recordPostView } from "@/components/bean/PostCard";
import { EmptyState } from "@/components/bean/EmptyState";
import { api } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useSeo } from "@/lib/seo";
import type { PublicPost } from "@/lib/types";

/**
 * Public post detail page — the /post/<id> route (path form via proxy with
 * server metadata; hash form inside the SPA). Client SEO manager composes
 * with the server metadata: same public payload, JSON-LD structured data
 * (SocialMediaPosting + VideoObject for reels) — restricted/private posts
 * resolve to 404 here and never receive indexable metadata.
 */
export default function PostDetailView({ postId }: { postId: string }) {
  const [post, setPost] = useState<PublicPost | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "missing">("loading");

  const load = useCallback(() => {
    api<{ post: PublicPost }>(`/api/posts/${postId}`)
      .then((r) => {
        setPost(r.post);
        setPhase("ready");
      })
      .catch(() => setPhase("missing"));
  }, [postId]);

  useEffect(() => {
    load();
  }, [load]);

  // Deduped view registration (one per viewer per day, server-enforced).
  useEffect(() => {
    if (post) recordPostView(post.id);
  }, [post?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const ogImage = useMemo(() => {
    if (!post) return null;
    const img = post.media.find((m) => m.kind === "IMAGE") ?? null;
    return img?.url ?? post.media[0]?.posterUrl ?? post.author.avatarUrl ?? null;
  }, [post]);

  useSeo(
    post
      ? {
          title: `${post.author.name}: ${post.body.trim().split("\n")[0]?.slice(0, 80) || (post.mediaKind === "VIDEO" ? "a new reel" : "a new post")}`,
          description: post.body.trim().slice(0, 200) || `A post by ${post.author.name} on BEAN Folio.`,
          path: `/post/${post.id}`,
          type: "article",
          image: ogImage,
          jsonLd: {
            "@context": "https://schema.org",
            "@type": post.mediaKind === "VIDEO" ? "VideoObject" : "SocialMediaPosting",
            headline: post.body.trim().split("\n")[0]?.slice(0, 110) || `Post by ${post.author.name}`,
            description: post.body.trim().slice(0, 300) || undefined,
            datePublished: post.createdAt,
            author: {
              "@type": "Person",
              name: post.author.name,
              ...(post.author.username ? { url: `/u/${post.author.username}` } : {}),
            },
            ...(post.mediaKind === "VIDEO" && post.media[0]
              ? {
                  contentUrl: post.media[0].url,
                  ...(post.media[0].posterUrl ? { thumbnailUrl: post.media[0].posterUrl } : {}),
                  name: post.media[0].altText || post.body.slice(0, 110) || `Video by ${post.author.name}`,
                }
              : {}),
            ...(post.hashtags.length > 0 ? { keywords: post.hashtags.join(", ") } : {}),
            ...(post.profession ? { articleSection: post.profession } : {}),
            commentCount: post.counts.comments,
            interactionStatistic: [
              {
                "@type": "InteractionCounter",
                interactionType: "https://schema.org/LikeAction",
                userInteractionCount: post.counts.likes,
              },
              {
                "@type": "InteractionCounter",
                interactionType: "https://schema.org/ViewAction",
                userInteractionCount: post.counts.views,
              },
            ],
          },
        }
      : null
  );

  if (phase === "loading") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <Skeleton className="h-10 w-10 rounded-full" />
        <Skeleton className="mt-4 h-6 w-2/3" />
        <Skeleton className="mt-3 h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (phase === "missing" || !post) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={CloudOff}
          title="This post is not available"
          description="It may have been deleted, or it is private."
          action={
            <Button variant="outline" onClick={() => navigate("/")}>
              <ArrowLeft className="size-4" aria-hidden /> Back to Discover
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <Button variant="ghost" size="sm" onClick={() => navigate("/")} className="mb-4 gap-1.5 text-muted-foreground">
        <ArrowLeft className="size-4" aria-hidden /> Discover
      </Button>
      <PostCard post={post} onChange={setPost} defaultCommentsOpen />
    </div>
  );
}
