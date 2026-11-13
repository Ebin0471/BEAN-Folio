"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";
import { useSession } from "@/lib/session";
import type { PublicComment } from "@/lib/types";

/**
 * Comments + one-level replies for a post. Paginated (newest first), with
 * ownership enforced server-side (comment author deletes their own comment;
 * the post's author moderates their own post). Renders inline under a post
 * card and on the post detail page.
 */
export function PostComments({ postId, commentsCount, postAuthorId }: { postId: string; commentsCount: number; postAuthorId: string }) {
  const { user } = useSession();
  const [comments, setComments] = useState<PublicComment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [total, setTotal] = useState(commentsCount);
  const reqRef = useRef(0);

  const load = useCallback(
    (nextCursor: string | null, append: boolean) => {
      const id = ++reqRef.current;
      append ? setLoadingMore(true) : setLoading(true);
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
      // Optimistic local append for the new leaf; counts stay server-accurate.
      setComments((prev) => [r.comment, ...prev]);
      setTotal(r.comments);
      setDraft("");
      setReplyTo(null);
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
            placeholder={replyTo ? "Write a reply…" : "Add a comment…"}
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
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground">No comments yet.</p>
        ) : (
          topLevel.map((c) => (
            <CommentRow key={c.id} comment={c} canDelete={!!user && (user.id === c.author.id || user.id === postAuthorId)} onReply={user ? () => setReplyTo(c.id) : undefined} onDelete={user ? () => void remove(c.id) : undefined}>
              {comments
                .filter((r) => r.parentId === c.id)
                .map((r) => (
                  <CommentRow key={r.id} comment={r} nested canDelete={!!user && (user.id === r.author.id || user.id === postAuthorId)} onDelete={user ? () => void remove(r.id) : undefined} />
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
  onReply,
  onDelete,
}: {
  comment: PublicComment;
  nested?: boolean;
  children?: React.ReactNode;
  canDelete?: boolean;
  onReply?: () => void;
  onDelete?: () => void;
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
        <div className="min-w-0 flex-1 rounded-lg bg-secondary/40 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <a href={`#/u/${comment.author.username}`} className="truncate text-sm font-medium hover:text-primary">
              {comment.author.name}
            </a>
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
          <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{comment.body}</p>
          <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
            <time dateTime={comment.createdAt}>{timeAgo(comment.createdAt)}</time>
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
