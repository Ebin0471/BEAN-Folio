"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Bookmark, Eye, Heart, Loader2, MessageCircle, MoreHorizontal, Share2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PostMediaView } from "@/components/bean/PostMediaView";
import { PostComments, timeAgo } from "@/components/bean/PostComments";
import { categoryLabel } from "@/components/bean/ProjectCard";
import { api } from "@/lib/client";
import { useSession } from "@/lib/session";
import { navigate } from "@/lib/hash-router";
import type { PublicPost } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The creator social post card (Discover feed + post detail page).
 * Real interactions only: like / comment / share / save / views all hit the
 * post API and persist; counts come from the server response.
 */
export function PostCard({
  post,
  onChange,
  onDelete,
  defaultCommentsOpen = false,
  compact = false,
}: {
  post: PublicPost;
  /** Parent feed hook: swap in the updated post after any interaction. */
  onChange?: (next: PublicPost) => void;
  onDelete?: (id: string) => void;
  defaultCommentsOpen?: boolean;
  compact?: boolean;
}) {
  const { user } = useSession();
  const [showComments, setShowComments] = useState(defaultCommentsOpen);
  const [busy, setBusy] = useState<"like" | "save" | "share" | "delete" | null>(null);

  const patch = useCallback(
    (partial: Partial<PublicPost>) => {
      onChange?.({ ...post, ...partial });
    },
    [post, onChange]
  );

  async function toggleLike() {
    if (!user) {
      navigate("/auth");
      return;
    }
    if (busy) return;
    setBusy("like");
    try {
      const r = await api<{ liked: boolean; likes: number }>(`/api/posts/${post.id}/like`, {
        method: post.liked ? "DELETE" : "POST",
      });
      patch({ liked: r.liked, counts: { ...post.counts, likes: r.likes } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the like");
    } finally {
      setBusy(null);
    }
  }

  async function toggleSave() {
    if (!user) {
      navigate("/auth");
      return;
    }
    if (busy) return;
    setBusy("save");
    try {
      const r = await api<{ bookmarked: boolean; bookmarks: number }>(`/api/posts/${post.id}/bookmark`, {
        method: post.bookmarked ? "DELETE" : "POST",
      });
      patch({ bookmarked: r.bookmarked, counts: { ...post.counts, bookmarks: r.bookmarks } });
      toast.success(r.bookmarked ? "Saved" : "Removed from saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the save");
    } finally {
      setBusy(null);
    }
  }

  async function share() {
    if (busy) return;
    setBusy("share");
    try {
      const r = await api<{ shareUrl: string; shares: number }>(`/api/posts/${post.id}/share`, { method: "POST" });
      patch({ shares: r.shares });
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ url: r.shareUrl, text: post.body.slice(0, 120) || undefined }).catch(() => undefined);
      } else {
        await navigator.clipboard.writeText(r.shareUrl).catch(() => undefined);
        toast.success("Link copied");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not share");
    } finally {
      setBusy(null);
    }
  }

  async function removePost() {
    if (busy) return;
    setBusy("delete");
    try {
      await api(`/api/posts/${post.id}`, { method: "DELETE" });
      onDelete?.(post.id);
      toast.success("Post deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the post");
    } finally {
      setBusy(null);
    }
  }

  // View tracking: one deduped view per viewer per day (server-enforced).
  // Fired from the feed/detail mount via recordPostView (below), not here.

  const initials = post.author.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const isAuthor = user?.id === post.author.id;

  return (
    <article className="overflow-hidden rounded-xl border border-border/60 bg-card transition-colors hover:border-primary/25">
      {/* author header */}
      <div className="flex items-center gap-3 px-4 pt-4">
        <Avatar className="size-10 shrink-0 ring-1 ring-border">
          <AvatarImage src={post.author.avatarUrl ?? undefined} alt={`${post.author.name}'s avatar`} />
          <AvatarFallback className="text-xs">{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <Link
            href={`#/u/${post.author.username}`}
            className="truncate text-sm font-medium text-foreground transition-colors hover:text-primary"
          >
            {post.author.name}
          </Link>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <time dateTime={post.createdAt}>{timeAgo(post.createdAt)}</time>
            {post.profession ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{categoryLabel(post.profession)}</span>
              </>
            ) : null}
          </div>
        </div>
        {isAuthor ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="Post options">
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onClick={() => void removePost()}
                disabled={busy === "delete"}
              >
                <Trash2 className="size-4" aria-hidden /> Delete post
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {/* caption */}
      {post.body.trim() ? (
        <div className={cn("px-4 pt-3 text-sm leading-relaxed text-foreground/90", compact && "line-clamp-3")}>
          <p className="whitespace-pre-wrap break-words">{post.body}</p>
        </div>
      ) : null}

      {/* hashtags */}
      {post.hashtags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-4 pt-2">
          {post.hashtags.map((t) => (
            <Badge key={t} variant="secondary" className="text-[11px] font-normal text-primary">
              #{t}
            </Badge>
          ))}
        </div>
      ) : null}

      {/* media */}
      {post.media.length > 0 ? (
        <div className="px-4 pt-3">
          <PostMediaView media={post.media} />
        </div>
      ) : null}

      {/* interaction bar */}
      <div className="mt-3 flex items-center gap-1 px-2 pb-1">
        <ActionButton
          label={post.liked ? "Unlike" : "Like"}
          onClick={() => void toggleLike()}
          active={post.liked}
          activeClass="text-primary"
          busy={busy === "like"}
        >
          <Heart className={cn("size-4", post.liked && "fill-current")} aria-hidden />
          <span>{post.counts.likes}</span>
        </ActionButton>
        <ActionButton
          label="Comments"
          onClick={() => setShowComments((v) => !v)}
          active={showComments}
          busy={null}
        >
          <MessageCircle className="size-4" aria-hidden />
          <span>{post.counts.comments}</span>
        </ActionButton>
        <ActionButton label="Share" onClick={() => void share()} busy={busy === "share"}>
          <Share2 className="size-4" aria-hidden />
          <span>{post.shares}</span>
        </ActionButton>
        <ActionButton
          label={post.bookmarked ? "Remove save" : "Save"}
          onClick={() => void toggleSave()}
          active={post.bookmarked}
          activeClass="text-primary"
          busy={busy === "save"}
          className="ml-auto"
        >
          <Bookmark className={cn("size-4", post.bookmarked && "fill-current")} aria-hidden />
          <span>{post.counts.bookmarks}</span>
        </ActionButton>
        <span className="mr-2 inline-flex items-center gap-1 text-xs text-muted-foreground" title={`${post.counts.views} views`}>
          <Eye className="size-3.5" aria-hidden /> {post.counts.views}
        </span>
      </div>

      {/* comments */}
      {showComments ? (
        <div className="mt-2">
          <PostComments postId={post.id} commentsCount={post.counts.comments} postAuthorId={post.author.id} />
        </div>
      ) : null}
    </article>
  );
}

function ActionButton({
  children,
  label,
  onClick,
  active,
  activeClass,
  busy,
  className,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  activeClass?: string;
  busy: boolean | null;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "gap-1.5 text-muted-foreground hover:text-foreground",
        active && activeClass,
        className
      )}
      disabled={busy ?? false}
    >
      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : children}
      {busy ? null : null}
    </Button>
  );
}

/** Fire-and-forget deduped view registration (feed + detail both call this). */
export function recordPostView(postId: string) {
  api(`/api/posts/${postId}/view`, { method: "POST" }).catch(() => undefined);
}
