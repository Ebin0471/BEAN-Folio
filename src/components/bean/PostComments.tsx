"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Heart, Loader2, Pencil, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";
import { useSession } from "@/lib/session";
import { navigate } from "@/lib/hash-router";
import type { PublicComment } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Comments + one-level replies for a post. Paginated (newest first), with
 * ownership enforced server-side (comment author edits/deletes their own
 * comment; the post's owner approves restricted authors' HIDDEN comments and
 * moderates their own post). Comment likes are real persistent rows.
 */
export function PostComments({ postId, commentsCount, postAuthorId }: { postId: string; commentsCount: number; postAuthorId: string }) {
  const { user } = useSession();
  const [comments, setComments] = useState<PublicComment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [total, setTotal] = useState(commentsCount);
  const reqRef = useRef(0);

  const load = useCallback(
    (nextCursor: string | null, append: boolean) => {
      const id = ++reqRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      const params = new URLSearchParams({ limit: "20" });
      if (nextCursor) params.set("cursor", nextCursor);
      api<{ items: PublicComment[]; nextCursor: string | null; total: number }>(`/api/posts/${postId}/comments?${params}`)
        .then((r) => {
          if (reqRef.current !== id) return;
          setComments((prev) => (append ? [...prev, ...r.items] : r.items));
          setCursor(r.nextCursor);
          setTotal(r.total);
        })
        .catch((e) => toast.error(e instanceof Error ? e.message : "Could not load comments"))
        .finally(() => {
          setLoading(false);
          setLoadingMore(false);
        });
    },
    [postId]
  );

  useEffect(() => {
    load(null, false);
  }, [load]);

  async function submit() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const r = await api<{ comment: PublicComment; comments: number }>(`/api/posts/${postId}/comments`, {
        method: "POST",
        json: { body, parentId: replyTo },
      });
      setComments((prev) => [r.comment, ...prev]);
      setTotal(r.comments);
      setDraft("");
      setReplyTo(null);
      if (r.comment.status === "HIDDEN") {
        toast.info("Your comment is pending approval by the post owner");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the comment");
    } finally {
      setBusy(false);
    }
  }

  async function remove(commentId: string) {
    try {
      const r = await api<{ comments: number }>(`/api/posts/${postId}/comments/${commentId}`, { method: "DELETE" });
      setComments((prev) => prev.filter((c) => c.id !== commentId && c.parentId !== commentId));
      setTotal(r.comments);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the comment");
    }
  }

  async function saveEdit(commentId: string) {
    const body = editDraft.trim();
    if (!body) return;
    try {
      await api(`/api/posts/${postId}/comments/${commentId}`, { method: "PATCH", json: { body } });
      setComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, body } : c)));
      setEditing(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the comment");
    }
  }

  async function approve(commentId: string) {
    try {
      await api(`/api/posts/${postId}/comments/${commentId}`, { method: "PATCH", json: { approve: true } });
      setComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, status: "VISIBLE" } : c)));
      toast.success("Comment approved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not approve the comment");
    }
  }

  async function toggleLike(comment: PublicComment) {
    if (!user) {
      navigate("/auth");
      return;
    }
    try {
      const r = await api<{ liked: boolean; likes: number }>(`/api/posts/${postId}/comments/${comment.id}/like`, {
        method: comment.liked ? "DELETE" : "POST",
      });
      setComments((prev) => prev.map((c) => (c.id === comment.id ? { ...c, liked: r.liked, likes: r.likes } : c)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the like");
    }
  }

  async function report(comment: PublicComment) {
    try {
      await api("/api/reports", {
        method: "POST",
        json: { targetType: "COMMENT", targetId: comment.id, reason: "inappropriate", details: "Reported from the comment thread" },
      });
      toast.success("Reported to moderators");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not report");
    }
  }

  const topLevel = comments.filter((c) => !c.parentId);

  return (
    <div className="border-t border-border/60 px-4 py-3">
      {user ? (
        replyTo ? (
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>Replying to a comment</span>
            <button type="button" className="underline hover:text-foreground" onClick={() => setReplyTo(null)}>
              cancel
            </button>
          </div>
        ) : null
      ) : null}
      {user ? (
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={replyTo ? "Write a reply… (mention with @username)" : "Add a comment… (mention with @username)"}
            aria-label="Write a comment"
            rows={1}
            className="min-h-10 resize-none text-sm"
            maxLength={1000}
          />
          <Button size="sm" onClick={() => void submit()} disabled={busy || !draft.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null} Post
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Sign in to join the conversation.</p>
      )}

      <div className="mt-3 space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading comments…
          </div>
        ) : topLevel.length === 0 ? (
          <p className="text-sm text-muted-foreground">No comments yet.</p>
        ) : (
          topLevel.map((c) => (
            <CommentRow
              key={c.id}
              comment={c}
              canDelete={!!user && (user.id === c.author.id || user.id === postAuthorId)}
              canEdit={!!user && user.id === c.author.id}
              onReply={user ? () => setReplyTo(c.id) : undefined}
              onDelete={user ? () => void remove(c.id) : undefined}
              onLike={user ? () => void toggleLike(c) : undefined}
              onEdit={
                user && user.id === c.author.id
                  ? () => {
                      setEditing(c.id);
                      setEditDraft(c.body);
                    }
                  : undefined
              }
              onApprove={c.status === "HIDDEN" ? () => void approve(c.id) : undefined}
              onReport={user && user.id !== c.author.id ? () => void report(c) : undefined}
            >
              {editing === c.id ? (
                <div className="mt-2 space-y-2">
                  <Textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} rows={2} maxLength={1000} className="text-sm" aria-label="Edit comment" />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void saveEdit(c.id)} disabled={!editDraft.trim()}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              ) : null}
              {comments
                .filter((r) => r.parentId === c.id)
                .map((r) => (
                  <CommentRow
                    key={r.id}
                    comment={r}
                    nested
                    canDelete={!!user && (user.id === r.author.id || user.id === postAuthorId)}
                    canEdit={!!user && user.id === r.author.id}
                    onDelete={user ? () => void remove(r.id) : undefined}
                    onLike={user ? () => void toggleLike(r) : undefined}
                    onEdit={
                      user && user.id === r.author.id
                        ? () => {
                            setEditing(r.id);
                            setEditDraft(r.body);
                          }
                        : undefined
                    }
                    onApprove={r.status === "HIDDEN" ? () => void approve(r.id) : undefined}
                  />
                ))}
            </CommentRow>
          ))
        )}
        {cursor && !loading ? (
          <Button variant="ghost" size="sm" onClick={() => void load(cursor, true)} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null} Load more comments
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  nested,
  children,
  canDelete,
  canEdit,
  onReply,
  onDelete,
  onLike,
  onEdit,
  onApprove,
  onReport,
}: {
  comment: PublicComment;
  nested?: boolean;
  children?: React.ReactNode;
  canDelete?: boolean;
  canEdit?: boolean;
  onReply?: () => void;
  onDelete?: () => void;
  onLike?: () => void;
  onEdit?: () => void;
  onApprove?: () => void;
  onReport?: () => void;
}) {
  const initials = comment.author.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className={nested ? "ml-8" : undefined}>
      <div className="flex items-start gap-2">
        <Avatar className="size-7 shrink-0 ring-1 ring-border">
          <AvatarImage src={comment.author.avatarUrl ?? undefined} alt={`${comment.author.name}'s avatar`} />
          <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
        </Avatar>
        <div className={cn("min-w-0 flex-1 rounded-lg px-3 py-2", comment.status === "HIDDEN" ? "border border-amber-500/40 bg-amber-500/5" : "bg-secondary/40")}>
          <div className="flex items-center justify-between gap-2">
            <a href={`#/u/${comment.author.username}`} className="truncate text-sm font-medium hover:text-primary">
              {comment.author.name}
            </a>
            <div className="flex items-center gap-2">
              {onApprove ? (
                <button type="button" onClick={onApprove} aria-label="Approve hidden comment" title="Approve (visible to everyone)" className="text-amber-600 transition-colors hover:text-foreground">
                  <Check className="size-3.5" aria-hidden />
                </button>
              ) : null}
              {onEdit ? (
                <button type="button" onClick={onEdit} aria-label="Edit comment" className="text-muted-foreground transition-colors hover:text-foreground">
                  <Pencil className="size-3.5" aria-hidden />
                </button>
              ) : null}
              {onReport ? (
                <button type="button" onClick={onReport} aria-label="Report comment" className="text-muted-foreground transition-colors hover:text-foreground">
                  <ShieldAlert className="size-3.5" aria-hidden />
                </button>
              ) : null}
              {canDelete ? (
                <button
                  type="button"
                  onClick={onDelete}
                  aria-label="Delete comment"
                  className="text-muted-foreground transition-colors hover:text-destructive"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{comment.body}</p>
          {comment.status === "HIDDEN" ? (
            <p className="mt-1 text-[11px] text-amber-600">Hidden — only you and the post owner can see this comment until it is approved.</p>
          ) : null}
          <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
            <time dateTime={comment.createdAt}>{timeAgo(comment.createdAt)}</time>
            {onLike ? (
              <button
                type="button"
                onClick={onLike}
                aria-pressed={comment.liked}
                className={cn("inline-flex items-center gap-1 transition-colors hover:text-foreground", comment.liked && "text-primary")}
              >
                <Heart className={cn("size-3", comment.liked && "fill-current")} aria-hidden /> {comment.likes}
              </button>
            ) : comment.likes > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Heart className="size-3" aria-hidden /> {comment.likes}
              </span>
            ) : null}
            {onReply ? (
              <button type="button" onClick={onReply} className="transition-colors hover:text-foreground">
                Reply
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {children ? <div className="mt-2 space-y-2">{children}</div> : null}
    </div>
  );
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
