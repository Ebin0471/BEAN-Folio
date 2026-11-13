"use client";

import { useState } from "react";
import { Bookmark, Eye, Heart, MessageCircle } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FeedVideoPlayer } from "@/components/bean/FeedVideoPlayer";
import { VideoPlayerDialog } from "@/components/bean/PostMediaView";
import { PostComments, timeAgo } from "@/components/bean/PostComments";
import { api } from "@/lib/client";
import { useSession } from "@/lib/session";
import { navigate } from "@/lib/hash-router";
import type { PublicPost } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * A reel-style vertical video card for the Discover "Reels & Video" feed.
 * The preview is an inline muted-autoplay player (one active video at a
 * time, coordinated through the feed-video store); the full player dialog
 * (expand button) also carries the real like/save interaction row and the
 * comments thread.
 */
export function VideoCard({ post, onChange }: { post: PublicPost; onChange?: (next: PublicPost) => void }) {
  const { user } = useSession();
  const [playerOpen, setPlayerOpen] = useState(false);
  const [showComments, setShowComments] = useState(false);

  const media = post.media[0];
  const initials = post.author.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  async function toggleLike() {
    if (!user) {
      navigate("/auth");
      return;
    }
    const r = await api<{ liked: boolean; likes: number }>(`/api/posts/${post.id}/like`, {
      method: post.liked ? "DELETE" : "POST",
    });
    onChange?.({ ...post, liked: r.liked, counts: { ...post.counts, likes: r.likes } });
  }

  async function toggleSave() {
    if (!user) {
      navigate("/auth");
      return;
    }
    const r = await api<{ bookmarked: boolean; bookmarks: number }>(`/api/posts/${post.id}/bookmark`, {
      method: post.bookmarked ? "DELETE" : "POST",
    });
    onChange?.({ ...post, bookmarked: r.bookmarked, counts: { ...post.counts, bookmarks: r.bookmarks } });
  }

  return (
    <>
      <article className="group overflow-hidden rounded-xl border border-border/60 bg-card transition-colors hover:border-primary/25">
        <div className="relative w-full">
          <FeedVideoPlayer media={media} aspect="aspect-[9/16]" rounded="rounded-none" onExpand={() => setPlayerOpen(true)} />
          <span className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 text-xs text-white/90">
            <Eye className="size-3.5" aria-hidden /> {post.counts.views}
          </span>
        </div>

        {/* creator + quick actions */}
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Avatar className="size-7 shrink-0 ring-1 ring-border">
            <AvatarImage src={post.author.avatarUrl ?? undefined} alt={`${post.author.name}'s avatar`} />
            <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
          </Avatar>
          <a href={`#/u/${post.author.username}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:text-primary">
            {post.author.name}
          </a>
          <button
            type="button"
            onClick={() => void toggleLike()}
            aria-label={post.liked ? "Unlike" : "Like"}
            aria-pressed={post.liked}
            className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground", post.liked && "text-primary")}
          >
            <Heart className={cn("size-4", post.liked && "fill-current")} aria-hidden /> {post.counts.likes}
          </button>
          <button
            type="button"
            onClick={() => void toggleSave()}
            aria-label={post.bookmarked ? "Remove save" : "Save"}
            aria-pressed={post.bookmarked}
            className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground", post.bookmarked && "text-primary")}
          >
            <Bookmark className={cn("size-4", post.bookmarked && "fill-current")} aria-hidden />
          </button>
        </div>
      </article>

      <VideoPlayerDialog media={media} open={playerOpen} onOpenChange={setPlayerOpen}>
        <div className="px-1 pb-1 pt-2">
          <div className="flex items-center gap-2">
            <Avatar className="size-8 shrink-0 ring-1 ring-border">
              <AvatarImage src={post.author.avatarUrl ?? undefined} alt="" />
              <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <a href={`#/u/${post.author.username}`} className="block truncate text-sm font-medium hover:text-primary">
                {post.author.name}
              </a>
              <span className="text-[11px] text-muted-foreground">{timeAgo(post.createdAt)}</span>
            </div>
            <ReelActions
              post={post}
              onChange={onChange}
              commentsOpen={showComments}
              onToggleComments={() => setShowComments((v) => !v)}
            />
          </div>
          {post.body.trim() ? <p className="mt-2 line-clamp-3 text-sm text-foreground/90">{post.body}</p> : null}
          <a
            href={`#/post/${post.id}`}
            className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
            onClick={() => setPlayerOpen(false)}
          >
            Open post
          </a>
          {showComments ? (
            <div className="mt-2 max-h-72 overflow-y-auto">
              <PostComments postId={post.id} commentsCount={post.counts.comments} postAuthorId={post.author.id} />
            </div>
          ) : null}
        </div>
      </VideoPlayerDialog>
    </>
  );
}

function ReelActions({
  post,
  onChange,
  commentsOpen,
  onToggleComments,
}: {
  post: PublicPost;
  onChange?: (next: PublicPost) => void;
  commentsOpen: boolean;
  onToggleComments: () => void;
}) {
  const { user } = useSession();

  async function toggleLike() {
    if (!user) {
      navigate("/auth");
      return;
    }
    const r = await api<{ liked: boolean; likes: number }>(`/api/posts/${post.id}/like`, {
      method: post.liked ? "DELETE" : "POST",
    });
    onChange?.({ ...post, liked: r.liked, counts: { ...post.counts, likes: r.likes } });
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void toggleLike()}
        aria-label={post.liked ? "Unlike" : "Like"}
        aria-pressed={post.liked}
        className={cn("gap-1.5 text-muted-foreground hover:text-foreground", post.liked && "text-primary")}
      >
        <Heart className={cn("size-4", post.liked && "fill-current")} aria-hidden /> {post.counts.likes}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggleComments}
        aria-label="Comments"
        aria-pressed={commentsOpen}
        className="gap-1.5 text-muted-foreground hover:text-foreground"
      >
        <MessageCircle className="size-4" aria-hidden /> {post.counts.comments}
      </Button>
    </div>
  );
}
