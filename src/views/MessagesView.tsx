"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ArrowLeft, Check, CheckCheck, CloudOff, ImagePlus, Inbox, Loader2, MailQuestion, Send, Search, X } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/bean/EmptyState";
import { SectionHeader } from "@/components/bean/SectionHeader";
import { api, uploadFile } from "@/lib/client";
import { useSession } from "@/lib/session";
import { navigate, useHashRoute } from "@/lib/hash-router";
import type { MessagesResponse, SharedPostCard, ThreadResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Direct messages — one-to-one conversations with message requests.
 * Database-backed polling (2.5s while a thread is open; a reliable fallback
 * by design, since every read re-authorizes the participant and re-validates
 * shared-post viewability server-side).
 */

const POLL_MS = 2500;

export default function MessagesView() {
  const { segments } = useHashRoute();
  const activeId = segments[1] ? decodeURIComponent(segments[1]) : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <SectionHeader title="Messages" description="Private conversations with other creators. Message requests keep your inbox yours." />
      <div className="mt-6 grid gap-6 md:grid-cols-[minmax(0,300px)_1fr]">
        <ConversationList activeId={activeId} />
        <div className="min-h-[420px]">
          {activeId ? (
            <Thread conversationId={activeId} />
          ) : (
            <EmptyState
              icon={Inbox}
              title="Select a conversation"
              description="Pick a thread on the left, or start one from a creator's profile with the Message button."
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- list

function ConversationList({ activeId }: { activeId: string | null }) {
  const { user } = useSession();
  const [data, setData] = useState<MessagesResponse | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [q, setQ] = useState("");

  const load = useCallback(() => {
    api<MessagesResponse>(`/api/me/messages${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`)
      .then((r) => {
        setData(r);
        setPhase("ready");
      })
      .catch(() => setPhase("error"));
  }, [q]);

  useEffect(() => {
    load();
  }, [load]);

  // Light polling keeps unread counts + request states honest while open.
  useEffect(() => {
    const t = setInterval(load, POLL_MS * 4);
    return () => clearInterval(t);
  }, [load]);

  if (phase === "loading") {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </div>
    );
  }
  if (phase === "error") {
    return (
      <EmptyState icon={CloudOff} title="Could not load messages" description="Please try again in a moment." action={<Button variant="outline" onClick={load}>Try again</Button>} />
    );
  }
  if (!data || data.conversations.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No conversations yet"
        description="Open a creator's profile and tap Message to start a private conversation."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations…" aria-label="Search conversations" className="pl-9" maxLength={80} />
      </div>
      {data.pendingRequests > 0 ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600">
          {data.pendingRequests} message request{data.pendingRequests === 1 ? "" : "s"} awaiting your reply.
        </p>
      ) : null}
      <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
        {data.conversations.map((c) => {
          const pending = c.requestState === "PENDING";
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => navigate(`/messages/${c.id}`)}
              aria-current={activeId === c.id}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                activeId === c.id ? "border-primary/60 bg-gold-soft" : "border-border/60 hover:border-primary/30",
                pending && "border-amber-500/50"
              )}
            >
              <Avatar className="size-10 shrink-0 ring-1 ring-border">
                <AvatarImage src={c.partner?.avatarUrl ?? undefined} alt={c.partner?.name ?? "Conversation"} />
                <AvatarFallback className="text-xs">{(c.partner?.name ?? "?").slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{c.partner?.name ?? "Conversation"}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {pending ? "Message request" : c.unread > 0 ? `${c.unread} unread` : "Conversation"}
                </p>
              </div>
              {c.unread > 0 ? <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="unread" /> : null}
            </button>
          );
        })}
      </div>
      {!user ? null : null}
    </div>
  );
}

// ---------------------------------------------------------------- thread

function Thread({ conversationId }: { conversationId: string }) {
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [shared, setShared] = useState<SharedPostCard | null>(null);
  const [shareInput, setShareInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    (quiet = false) => {
      if (!quiet) setPhase("loading");
      api<ThreadResponse>(`/api/me/messages/${conversationId}`)
        .then((r) => {
          setThread(r);
          setPhase("ready");
        })
        .catch(() => !quiet && setPhase("error"));
    },
    [conversationId]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Polling: messages, typing indicator, read state (DB-backed, authorized).
  useEffect(() => {
    const t = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread?.messages.length]);

  // Typing indicator — refresh while the composer has content.
  useEffect(() => {
    if (!draft) return;
    const t = setInterval(() => {
      api(`/api/me/messages/${conversationId}`, { method: "PATCH", json: { typing: true } }).catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [draft, conversationId]);

  async function send(payload: { body?: string; mediaAssetId?: string; sharedPostId?: string }) {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/me/messages/${conversationId}`, { method: "POST", json: payload });
      setDraft("");
      setShared(null);
      setShareInput("");
      load(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the message");
    } finally {
      setBusy(false);
    }
  }

  async function attachMedia(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      toast.error("Messages accept images and videos");
      return;
    }
    setUploading(true);
    try {
      const res = await uploadFile(file);
      await send({ mediaAssetId: res.media.id, body: draft.trim() || undefined });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (mediaInputRef.current) mediaInputRef.current.value = "";
    }
  }

  async function attachSharedPost() {
    const m = shareInput.match(/\/post\/([A-Za-z0-9]+)/);
    const postId = m ? m[1] : shareInput.trim();
    if (!postId) return;
    await send({ sharedPostId: postId, body: draft.trim() || undefined });
  }

  async function respond(accept: boolean) {
    try {
      await api(`/api/me/messages/${conversationId}`, { method: "PATCH", json: { accept } });
      load();
      toast.success(accept ? "Request accepted" : "Request declined");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the request");
    }
  }

  async function archive() {
    try {
      await api(`/api/me/messages/${conversationId}`, { method: "PATCH", json: { archive: true } });
      toast.success("Conversation archived");
      navigate("/messages");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not archive");
    }
  }

  if (phase === "loading") return <Skeleton className="h-[420px] rounded-xl" />;
  if (phase === "error" || !thread) {
    return <EmptyState icon={CloudOff} title="Could not load this conversation" description="It may not exist or you may not have access." action={<Button variant="outline" onClick={() => load()}>Try again</Button>} />;
  }

  const myState = thread.requestState;
  const partnerPending = thread.partnerRequestState === "PENDING";
  const canSend = !thread.blocked && myState === "ACTIVE";

  return (
    <div className="flex h-full min-h-[420px] flex-col rounded-xl border border-border/60 bg-card">
      {/* header */}
      <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
        <Button variant="ghost" size="icon" className="size-8 md:hidden" aria-label="Back to conversations" onClick={() => navigate("/messages")}>
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {thread.partnerTyping ? <span className="text-primary">typing…</span> : "Conversation"}
          </p>
          {thread.blocked ? <p className="text-xs text-destructive">You cannot exchange messages with this account.</p> : null}
        </div>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Archive conversation" onClick={() => void archive()}>
          <Archive className="size-4" aria-hidden />
        </Button>
      </div>

      {/* request banners */}
      {myState === "PENDING" ? (
        <div className="border-b border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
          <p className="inline-flex items-center gap-2 text-amber-600"><MailQuestion className="size-4" aria-hidden /> Message request — accept to read and reply.</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => void respond(true)}>Accept</Button>
            <Button size="sm" variant="outline" onClick={() => void respond(false)}>Decline</Button>
          </div>
        </div>
      ) : null}
      {myState === "ACTIVE" && partnerPending ? (
        <p className="border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
          Waiting for {thread.messages[0]?.sender.name ?? "them"} to accept your message request — you can keep sending, and they will see everything once they accept.
        </p>
      ) : null}

      {/* messages */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {thread.messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No messages yet — say hello.</p>
        ) : (
          thread.messages.map((m) => (
            <div key={m.id} className={cn("flex", m.mine ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm",
                  m.mine ? "bg-gold-soft text-foreground" : "bg-secondary/60 text-foreground"
                )}
              >
                {m.sharedPost ? (
                  <a href={`#/post/${m.sharedPost.id}`} className="mb-1.5 flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 p-2 transition-colors hover:border-primary/40">
                    {m.sharedPost.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.sharedPost.thumbUrl} alt="Shared post thumbnail" className="size-10 rounded object-cover" />
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{m.sharedPost.authorName}</span>
                      <span className="block truncate text-xs text-muted-foreground">{m.sharedPost.body || "View post"}</span>
                    </span>
                  </a>
                ) : null}
                {m.mediaUrl ? (
                  m.mediaUrl.includes("video") || m.mediaUrl.startsWith("/api/media/") ? (
                    <video src={m.mediaUrl} controls preload="metadata" className="mb-1.5 max-h-64 rounded-lg" aria-label="Shared video" />
                  ) : null
                ) : null}
                {m.body ? <p className="whitespace-pre-wrap break-words">{m.body}</p> : null}
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {new Date(m.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  {m.mine ? <CheckCheck className="ml-1 inline size-3" aria-label="sent" /> : null}
                </p>
              </div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      {/* composer */}
      {canSend ? (
        <div className="border-t border-border/60 px-4 py-3">
          {shared ? (
            <p className="mb-2 inline-flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/40 px-2 py-1 text-xs">
              Sharing a post <button type="button" onClick={() => setShared(null)} aria-label="Remove shared post"><X className="size-3" /></button>
            </p>
          ) : null}
          <div className="flex items-end gap-2">
            <Button variant="outline" size="icon" className="size-10 shrink-0" aria-label="Attach an image or video" onClick={() => mediaInputRef.current?.click()} disabled={uploading || busy}>
              {uploading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ImagePlus className="size-4" aria-hidden />}
            </Button>
            <input ref={mediaInputRef} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" className="sr-only" aria-label="Choose media" onChange={(e) => void attachMedia(e.target.files?.[0])} />
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send({ body: draft.trim() });
                }
              }}
              placeholder="Write a message…"
              aria-label="Write a message"
              rows={1}
              maxLength={2000}
              className="max-h-40 min-h-10 flex-1 resize-none rounded-lg border border-border/60 bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
            <Button size="icon" className="size-10 shrink-0" aria-label="Send message" onClick={() => void send({ body: draft.trim() })} disabled={busy || (!draft.trim() && !shared)}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Input
              value={shareInput}
              onChange={(e) => setShareInput(e.target.value)}
              placeholder="…or paste a post link / id to share it here"
              aria-label="Share a post into this conversation"
              className="h-8 text-xs"
              maxLength={120}
            />
            <Button variant="outline" size="sm" onClick={() => void attachSharedPost()} disabled={!shareInput.trim() || busy} className="h-8 gap-1 text-xs">
              <Check className="size-3" aria-hidden /> Attach
            </Button>
          </div>
        </div>
      ) : myState === "DECLINED" ? (
        <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">You declined this request — the conversation is closed for you.</p>
      ) : null}
    </div>
  );
}
