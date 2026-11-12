"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Eraser, History, Loader2, Send, Sparkles, WifiOff, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * RIISHE — the floating portfolio assistant. Streams real replies from the
 * server-side AI gateway (SSE); never fabricates an offline answer. The
 * assistant only PROPOSES — it has no write access to any content.
 */

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: string;
}

const STARTERS = [
  "Write a punchy one-line headline for my profile",
  "Suggest which website sections fit a filmmaker",
  "Explain how publishing my portfolio works",
  "Help me write alt text for my project images",
];

export default function RiisheAssistant() {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<ConversationMeta[] | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const lastSentRef = useRef<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    setOffline(!navigator.onLine);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, open]);

  const loadConversations = useCallback(async () => {
    try {
      const res = await api<{ conversations: ConversationMeta[] }>("/api/ai/conversations");
      setConversations(res.conversations);
    } catch {
      setConversations([]);
    }
  }, []);

  function openPanel() {
    setOpen(true);
    setError(null);
    void loadConversations();
  }

  async function openConversation(id: string) {
    setHistoryOpen(false);
    setError(null);
    try {
      const res = await api<{ conversation: { id: string; messages: { role: string; content: string }[] } }>(`/api/ai/conversations/${id}`);
      setConversationId(id);
      setMessages(res.conversation.messages.map((m) => ({ role: m.role === "USER" ? ("user" as const) : ("assistant" as const), content: m.content })));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open that conversation");
    }
  }

  async function clearConversation() {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    try {
      await api(`/api/ai/conversations/${conversationId}`, { method: "DELETE" });
      setMessages([]);
      setConversationId(null);
      setConversations((c) => (c ? c.filter((x) => x.id !== conversationId) : c));
      toast.success("Conversation cleared");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not clear the conversation");
    }
  }

  function newConversation() {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setHistoryOpen(false);
  }

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || streaming || waiting) return;
      if (!user) {
        toast.error("Sign in to talk with RIISHE", {
          action: { label: "Sign in", onClick: () => navigate("/auth") },
        });
        return;
      }
      lastSentRef.current = content;
      setHistoryOpen(false);
      setError(null);
      setMessages((m) => [...m, { role: "user", content }]);
      setInput("");
      setWaiting(true);

      // The streaming message slot.
      setMessages((m) => [...m, { role: "assistant", content: "" }]);

      try {
        const res = await fetch("/api/ai/chat-stream", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Bean-Embed": window.self !== window.top ? "1" : "0" },
          body: JSON.stringify({ conversationId: conversationId ?? undefined, message: content }),
          credentials: "same-origin",
        });

        if (!res.ok || !res.body) {
          let msg = "The assistant is unavailable right now.";
          try {
            const j = (await res.json()) as { error?: string };
            if (j.error) msg = j.error;
          } catch {
            /* non-JSON error */
          }
          if (res.status === 429) msg = msg || "Daily AI limit reached.";
          throw new Error(msg);
        }

        setWaiting(false);
        setStreaming(true);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamErrored: string | null = null;
        let done = false;
        for (;;) {
          const { done: fin, value } = await reader.read();
          if (fin) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
            if (!payload) continue;
            try {
              const evt = JSON.parse(payload) as { delta?: string; done?: boolean; conversationId?: string; error?: string };
              if (evt.error) streamErrored = evt.error;
              if (evt.delta) {
                setMessages((m) => {
                  const next = [...m];
                  next[next.length - 1] = { role: "assistant", content: next[next.length - 1].content + evt.delta };
                  return next;
                });
              }
              if (evt.done) {
                done = true;
                if (evt.conversationId && !conversationId) setConversationId(evt.conversationId);
              }
            } catch {
              /* ignore malformed frames */
            }
          }
        }
        setStreaming(false);
        if (streamErrored) {
          setError(streamErrored);
        } else if (!done) {
          setError("The connection ended early. Press Retry to continue the conversation.");
        }
      } catch (e) {
        setStreaming(false);
        setWaiting(false);
        const msg = e instanceof Error ? e.message : "Something went wrong.";
        setError(msg);
        // Drop the empty assistant slot so the error is the last thing visible.
        setMessages((m) => (m[m.length - 1]?.role === "assistant" && m[m.length - 1].content === "" ? m.slice(0, -1) : m));
      }
    },
    [conversationId, streaming, waiting, user]
  );

  function retry() {
    if (lastSentRef.current) void send(lastSentRef.current);
  }

  if (!user) return null;

  return (
    <>
      {/* launcher */}
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-label={open ? "Close RIISHE assistant" : "Open RIISHE assistant"}
        aria-expanded={open}
        className={cn(
          "fixed bottom-24 right-4 z-50 flex h-12 items-center gap-2 rounded-full border border-primary/40 bg-card px-4 shadow-xl transition-all hover:-translate-y-0.5 md:bottom-6 md:right-6",
          open && "opacity-0 pointer-events-none"
        )}
      >
        <span className="grid size-8 place-items-center rounded-full bg-gold-soft text-primary">
          <Bot className="size-4" aria-hidden />
        </span>
        <span className="text-sm font-semibold">RIISHE</span>
      </button>

      {/* panel */}
      {open && (
        <div
          role="dialog"
          aria-label="RIISHE portfolio assistant"
          className="fixed inset-x-2 bottom-2 z-50 flex max-h-[calc(100dvh-1rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl sm:inset-x-auto sm:bottom-24 sm:right-6 sm:h-[600px] sm:w-[400px] md:bottom-6"
        >
          {/* header */}
          <div className="flex items-center gap-2.5 border-b border-border/70 px-4 py-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-gold-soft text-primary">
              <Bot className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-tight">RIISHE</p>
              <p className="text-[11px] text-muted-foreground">Portfolio assistant · proposes, never applies</p>
            </div>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Conversation history" onClick={() => { setHistoryOpen((o) => !o); if (!historyOpen && conversations === null) void loadConversations(); }}>
              <History className="size-4" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Clear this conversation" onClick={() => void clearConversation()}>
              <Eraser className="size-4" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Close assistant" onClick={() => setOpen(false)}>
              <X className="size-4" aria-hidden />
            </Button>
          </div>

          {/* history drawer */}
          {historyOpen && (
            <div className="max-h-48 overflow-y-auto border-b border-border/70 bg-card/50 p-2">
              <button type="button" className="block w-full rounded-md px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-accent" onClick={newConversation}>
                <Sparkles className="mr-2 inline size-3.5" aria-hidden /> New conversation
              </button>
              {conversations === null && <div className="grid place-items-center py-3"><Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading history" /></div>}
              {conversations?.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No previous conversations.</p>}
              {conversations?.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={cn("block w-full truncate rounded-md px-3 py-2 text-left text-xs transition-colors hover:bg-accent", conversationId === c.id && "bg-gold-soft/60 text-primary")}
                  onClick={() => void openConversation(c.id)}
                >
                  {c.title || "Untitled"}
                </button>
              ))}
            </div>
          )}

          {/* messages */}
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {offline && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <WifiOff className="size-3.5" aria-hidden /> You're offline — replies need a connection.
              </div>
            )}
            {messages.length === 0 && !waiting && (
              <div className="space-y-3 pt-2">
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  Hi — I'm RIISHE. I can draft headlines and bios, rewrite your project copy without inventing facts, suggest sections for your website, or explain how publishing works. What are we working on?
                </p>
                <div className="grid gap-1.5">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={offline}
                      className="rounded-lg border border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                      onClick={() => void send(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed",
                    m.role === "user" ? "bg-primary text-primary-foreground" : "border border-border/70 bg-card"
                  )}
                >
                  {m.content || (waiting && i === messages.length - 1 ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Thinking" /> : "")}
                </div>
              </div>
            ))}
            {error && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive" role="alert">
                {error}
                <div className="mt-2 flex gap-2">
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={retry} disabled={offline || waiting}>
                    Retry
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* input */}
          <div className="border-t border-border/70 p-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
              className="flex items-end gap-2"
            >
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                rows={1}
                maxLength={2000}
                placeholder={offline ? "Offline — reconnect to chat" : "Ask RIISHE about your portfolio…"}
                aria-label="Message RIISHE"
                disabled={offline || streaming || waiting}
                className="max-h-28 min-h-10 flex-1 resize-none text-sm"
              />
              <Button type="submit" size="icon" className="size-10 shrink-0" disabled={!input.trim() || offline || streaming || waiting} aria-label="Send message">
                {waiting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
              </Button>
            </form>
            <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
              RIISHE streams from the real AI gateway with your own portfolio as context. It never edits anything by itself.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
