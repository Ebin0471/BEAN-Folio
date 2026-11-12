"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  Lock,
  Plus,
  Send,
  ServerCrash,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

import { EmptyState } from "@/components/bean/EmptyState";
import { Spinner } from "@/components/bean/Spinner";
import { AutomationActionCard } from "@/components/bean/riishe/AutomationActionCard";

import { api, ApiError, formatDate } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useSession } from "@/lib/session";
import type {
  AiCapabilitiesDTO,
  AiConversationSummary,
  AiMessageDTO,
  RiisheActionCard,
} from "@/lib/types";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------ helpers

interface AiFailure {
  title: string;
  hint?: string;
  /** "retry" → same request can succeed; "settings" → user action required elsewhere. */
  action?: "retry" | "settings";
}

/** Map any thrown value to an honest, user-safe failure description. Never fakes success. */
function aiFailure(e: unknown): AiFailure {
  if (e instanceof ApiError) {
    if (e.status === 403) {
      return {
        title: e.message,
        hint: "Enable RIISHE in Settings → Privacy — AI stays off until you do.",
        action: "settings",
      };
    }
    if (e.status === 429) {
      return { title: e.message, hint: "Daily usage resets at midnight UTC.", action: "retry" };
    }
    if (e.status === 502) {
      return { title: "The AI service is temporarily unavailable.", hint: e.message, action: "retry" };
    }
    if (e.status === 0) {
      return { title: "Network error — check your connection and try again.", action: "retry" };
    }
    return { title: e.message, action: "retry" };
  }
  return { title: "Something went wrong. Please try again.", action: "retry" };
}

const SUGGESTED_PROMPTS = [
  "How can I improve my project descriptions?",
  "Draft a short intro I can send to a potential client",
  "Which of my projects should I feature first?",
] as const;

function InlineError({ failure, onRetry }: { failure: AiFailure; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-foreground">{failure.title}</p>
        {failure.hint && <p className="mt-0.5 text-muted-foreground">{failure.hint}</p>}
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * Small, contextual consent pointer — NOT the old blocking consent page.
 * The interface stays fully visible; only AI operations are held back until
 * the user grants consent in Settings → Privacy. Consent is NEVER granted
 * implicitly by opening RIISHE, and this component contains no toggle —
 * Settings → Privacy remains the single place consent is managed.
 */
function ConsentNotice({ prompted }: { prompted: boolean }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border border-border/60 bg-background/50 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground",
        prompted && "border-primary/30"
      )}
      role={prompted ? "status" : undefined}
    >
      <Lock className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1">
        {prompted
          ? "RIISHE needs your consent before it can reply. Nothing was sent. "
          : "AI replies are off until you enable RIISHE — your portfolio data is not used or sent anywhere. "}
        <button
          type="button"
          className="font-medium underline decoration-primary/50 underline-offset-2 transition-colors hover:text-primary"
          onClick={() => navigate("/settings")}
        >
          Enable in Settings → Privacy
        </button>
        .
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ chat (the full-screen RIISHE experience — the default landing)

function ChatTab({
  consented,
  onQuotaUsed,
  usedToday,
  dailyLimit,
}: {
  consented: boolean;
  onQuotaUsed: () => void;
  usedToday: number;
  dailyLimit: number;
}) {
  const [conversations, setConversations] = useState<AiConversationSummary[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [thread, setThread] = useState<AiMessageDTO[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState("");
  const [failure, setFailure] = useState<AiFailure | null>(null);
  /** Set when a send was attempted without consent — surfaces the small notice, never a blocking page. */
  const [consentPrompted, setConsentPrompted] = useState(false);
  const [delegation, setDelegation] = useState<
    | { taskId: string; kind: string; targetAgent: string; brief: string; destinationUrl: string; destinationLabel: string }
    | null
  >(null);
  /** Structured action card from an automation intent (same side-channel pattern as delegation). */
  const [automation, setAutomation] = useState<RiisheActionCard | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const refreshConversations = useCallback(async (silent = false) => {
    if (!silent) setConvLoading(true);
    try {
      const res = await api<{ conversations: AiConversationSummary[] }>("/api/ai/conversations");
      setConversations(res.conversations);
    } catch (e) {
      // A 403 here means consent is off (never granted or revoked) — the
      // server refuses to serve history, so keep the list empty; never fake data.
      if (!(e instanceof ApiError && e.status === 403)) {
        if (!silent) toast.error(e instanceof ApiError ? e.message : "Couldn't load conversations.");
      }
    } finally {
      if (!silent) setConvLoading(false);
    }
  }, []);

  // Load on mount — the SERVER decides whether history is available (403
  // without consent keeps the list empty). The interface itself is always viewable.
  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  // A consent change (Settings → Privacy) re-syncs what the server exposes.
  useEffect(() => {
    if (consented) {
      setConsentPrompted(false);
      void refreshConversations(true);
    }
  }, [consented, refreshConversations]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, sending]);

  const openConversation = async (id: string) => {
    if (sending) return;
    setActiveId(id);
    setThreadLoading(true);
    setFailure(null);
    setDelegation(null);
    setAutomation(null);
    try {
      const res = await api<{ conversation: { id: string; title: string; messages: AiMessageDTO[] } }>(
        `/api/ai/conversations/${id}`
      );
      setThread(res.conversation.messages);
    } catch (e) {
      setThread([]);
      setFailure(aiFailure(e));
    } finally {
      setThreadLoading(false);
    }
  };

  const newChat = () => {
    if (sending) return;
    setActiveId(null);
    setThread([]);
    setFailure(null);
    setDelegation(null);
    setAutomation(null);
    setConsentPrompted(false);
    setInput("");
  };

  const send = async (raw: string) => {
    const message = raw.trim();
    if (!message || sending) return;
    // Client-side consent guard (defense in depth — the server independently
    // enforces consent and would return 403): without consent NOTHING is
    // transmitted — no message, no portfolio context, no provider call.
    if (!consented) {
      setConsentPrompted(true);
      return;
    }
    setFailure(null);
    setConsentPrompted(false);
    setSending(true);
    const optimistic: AiMessageDTO = { role: "user", content: message, createdAt: new Date().toISOString() };
    setThread((t) => [...t, optimistic]);
    setInput("");
    try {
      const res = await api<{
        conversationId: string;
        reply: string;
        delegation?: { taskId: string; kind: string; targetAgent: string; brief: string; destinationUrl: string; destinationLabel: string };
        automation?: RiisheActionCard;
      }>("/api/ai/chat", {
        method: "POST",
        json: { conversationId: activeId ?? undefined, message },
      });
      setThread((t) => [
        ...t,
        { role: "assistant", content: res.reply, createdAt: new Date().toISOString() },
      ]);
      setActiveId(res.conversationId);
      setDelegation(res.delegation ?? null);
      setAutomation(res.automation ?? null);
      onQuotaUsed();
      void refreshConversations(true);
    } catch (e) {
      // The optimistic message was never persisted — remove it so the thread stays honest.
      setThread((t) => t.filter((m) => m !== optimistic));
      setInput(message);
      setFailure(aiFailure(e));
    } finally {
      setSending(false);
    }
  };

  const mobilePicker = (
    <div className="mb-4 flex items-center gap-2 md:hidden">
      <Select
        value={activeId ?? "__new"}
        onValueChange={(v) => (v === "__new" ? newChat() : void openConversation(v))}
      >
        <SelectTrigger className="h-10 flex-1" aria-label="Choose a conversation">
          <SelectValue placeholder="Conversations" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__new">＋ New chat</SelectItem>
          {conversations.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.title || "Untitled conversation"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" size="icon" className="size-10 shrink-0" onClick={newChat} aria-label="Start a new chat">
        <Plus className="size-4" aria-hidden />
      </Button>
    </div>
  );

  return (
    <div className="grid h-full min-w-0 grid-rows-[auto_1fr] gap-4 md:grid-cols-[260px_1fr] md:grid-rows-1 md:gap-6">
      {mobilePicker}

      {/* Sidebar (desktop) */}
      <aside className="hidden md:flex md:flex-col">
        <div className="flex items-center justify-between pb-2">
          <h3 className="text-sm font-medium text-foreground">Conversations</h3>
          <Button variant="outline" size="sm" onClick={newChat}>
            <Plus className="size-3.5" aria-hidden /> New
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pb-2 pr-1" aria-busy={convLoading}>
          {convLoading ? (
            <div className="space-y-2 py-1">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : conversations.length === 0 ? (
            <p className="px-1 py-3 text-xs leading-relaxed text-muted-foreground">
              {consented
                ? "No conversations yet. Your chats with the assistant will appear here."
                : "Conversations appear here once RIISHE is enabled and you start chatting."}
            </p>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => void openConversation(c.id)}
                aria-current={activeId === c.id ? "true" : undefined}
                className={cn(
                  "block w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
                  activeId === c.id
                    ? "border-primary/40 bg-gold-soft"
                    : "border-border/50 bg-card hover:border-primary/25 hover:bg-accent"
                )}
              >
                <p className="truncate text-sm font-medium text-foreground">{c.title || "Untitled conversation"}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{formatDate(c.updatedAt)}</p>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Thread — full-screen: fills the available content area */}
      <div className="flex min-h-0 min-w-0 flex-col rounded-xl border border-border/60 bg-card">
        <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto p-4" aria-live="polite">
          {failure && (
            <div className="mb-4 space-y-2">
              <InlineError failure={failure} onRetry={failure.action === "retry" ? () => setFailure(null) : undefined} />
              {failure.action === "settings" && (
                <Button variant="outline" size="sm" onClick={() => navigate("/settings")}>
                  Open Settings
                </Button>
              )}
            </div>
          )}

          {threadLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-14 w-3/4" />
              <Skeleton className="ml-auto h-10 w-1/2" />
              <Skeleton className="h-14 w-2/3" />
            </div>
          ) : thread.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
              <div className="grid size-12 place-items-center rounded-full bg-gold-soft text-primary">
                <Sparkles className="size-6" aria-hidden />
              </div>
              <div>
                <p className="font-display text-lg font-semibold text-foreground">Ask your portfolio assistant</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  {consented
                    ? "It can see your own profile and projects only — try one of these to start:"
                    : "Once enabled in Settings → Privacy, it can see your own profile and projects only — nothing until then."}
                </p>
              </div>
              <div className="flex w-full max-w-md flex-col gap-2">
                {SUGGESTED_PROMPTS.map((p) => (
                  <Button
                    key={p}
                    type="button"
                    variant="outline"
                    className="h-auto justify-start whitespace-normal py-2.5 text-left text-sm"
                    disabled={!consented || sending}
                    onClick={() => void send(p)}
                  >
                    {p}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {thread.map((m, i) => {
                const isUser = m.role === "user";
                return (
                  <div key={`${m.createdAt}-${i}`} className={cn("flex", isUser ? "justify-end" : "justify-start")}>
                    <div
                      className={cn(
                        "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed sm:max-w-[75%]",
                        isUser
                          ? "rounded-br-md bg-primary text-primary-foreground"
                          : "rounded-bl-md border border-border/70 bg-background/60 text-foreground"
                      )}
                    >
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    </div>
                  </div>
                );
              })}
              {delegation && !sending && (
                <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-primary/30 bg-gold-soft/40 p-4">
                  <div className="flex items-center gap-2">
                    <ArrowRightLeft className="size-4 text-primary" aria-hidden />
                    <p className="text-sm font-semibold text-foreground">
                      RIISHE prepared a {delegation.kind === "WEBSITE_DESIGN" ? "website plan" : "design brief"} for {delegation.targetAgent === "LAXII" ? "LAXII" : "GIFTZ"}
                    </p>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Nothing is created automatically — review the brief, then create it yourself in the studio.
                  </p>
                  <pre className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-background/70 p-3 text-xs leading-relaxed text-foreground/90">
                    {delegation.brief}
                  </pre>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard?.writeText(delegation.brief).catch(() => undefined);
                        // Phase 3: carry the durable brief taskId across the
                        // navigation (the hash router strips query params) so
                        // LAXII can fetch the STRUCTURED brief, not a summary.
                        if (delegation.targetAgent === "LAXII") {
                          try {
                            sessionStorage.setItem("bean:laxii-pending-brief", delegation.taskId);
                          } catch {
                            // storage unavailable — the studio simply shows no brief card
                          }
                        }
                        navigate(delegation.destinationUrl.replace(/^#/, ""));
                      }}
                    >
                      {delegation.destinationLabel}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDelegation(null)}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              )}
              {automation && !sending && (
                <AutomationActionCard action={automation} onDismiss={() => setAutomation(null)} />
              )}
              {sending && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-border/70 bg-background/60 px-4 py-3">
                    <Spinner label="Assistant is thinking…" />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border/60 p-3">
          {!consented && (
            <div className="mb-2">
              <ConsentNotice prompted={consentPrompted} />
            </div>
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
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
              placeholder={consented ? "Ask about your portfolio…" : "Enable RIISHE in Settings → Privacy to start chatting"}
              rows={1}
              disabled={!consented || sending}
              className="max-h-32 min-h-[44px] flex-1 resize-none"
              aria-label="Message to RIISHE"
            />
            <Button type="submit" size="icon" className="size-[44px] shrink-0" disabled={!consented || sending || !input.trim()} aria-label="Send message">
              <Send className="size-4" aria-hidden />
            </Button>
          </form>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-muted-foreground/80">
            <span>Enter sends · Shift+Enter for a new line. The assistant sees your own profile and projects only.</span>
            {/* Usage tracking + consent — compact, always visible (the old
                overview dashboard was removed; the limits themselves stay). */}
            <span>
              Daily usage {usedToday} / {dailyLimit} · resets midnight UTC
            </span>
            <span>
              {consented ? (
                <>
                  Consent is on — revoke anytime in{" "}
                  <button
                    type="button"
                    className="underline decoration-primary/50 underline-offset-2 transition-colors hover:text-primary"
                    onClick={() => navigate("/settings")}
                  >
                    Settings → Privacy
                  </button>
                  .
                </>
              ) : (
                <>
                  Consent is off — manage it in{" "}
                  <button
                    type="button"
                    className="underline decoration-primary/50 underline-offset-2 transition-colors hover:text-primary"
                    onClick={() => navigate("/settings")}
                  >
                    Settings → Privacy
                  </button>
                  .
                </>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function IntelligenceView() {
  const { user } = useSession();
  const [caps, setCaps] = useState<AiCapabilitiesDTO | null>(null);
  const [capsLoading, setCapsLoading] = useState(true);
  const [capsFailure, setCapsFailure] = useState<string | null>(null);

  const loadCaps = useCallback(async (opts: { silent?: boolean } = {}) => {
    // Silent refreshes (after each AI request) must NOT flip the view to the
    // skeleton — that unmounts ChatTab and destroys the live thread state.
    if (!opts.silent) setCapsLoading(true);
    setCapsFailure(null);
    try {
      const res = await api<AiCapabilitiesDTO>("/api/ai/capabilities");
      setCaps(res);
    } catch (e) {
      if (!opts.silent) {
        setCapsFailure(e instanceof ApiError ? e.message : "Couldn't load RIISHE status.");
      }
      // A failed silent refresh keeps the last good quota display — the
      // request flows themselves surface their own failures honestly.
    } finally {
      if (!opts.silent) setCapsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  const consented = useMemo(() => Boolean(user?.aiConsent), [user]);

  if (capsLoading) {
    return (
      <div className="mx-auto flex h-[calc(100dvh-9rem)] min-h-[420px] w-full max-w-6xl flex-col px-4 py-6 sm:px-6" aria-busy="true">
        <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[260px_1fr] md:gap-6">
          <Skeleton className="hidden rounded-xl md:block" />
          <Skeleton className="min-h-[320px] rounded-xl" />
        </div>
      </div>
    );
  }

  if (capsFailure || !caps) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <EmptyState
          icon={ServerCrash}
          title="Couldn't load RIISHE"
          description={capsFailure ?? "The service status is unavailable right now."}
          action={<Button onClick={() => void loadCaps()}>Try again</Button>}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-[calc(100dvh-9rem)] min-h-[420px] w-full max-w-6xl flex-col px-4 py-6 sm:px-6">
      {/* RIISHE opens DIRECTLY as the assistant — the conversation area,
          composer, history and empty state are the landing page. The old
          standalone enable-consent gate is gone: without consent the
          interface stays fully viewable while AI operations are disabled, and
          a small contextual notice points to Settings → Privacy (the only
          place consent is granted or revoked). Opening RIISHE never grants
          consent, and the server independently refuses every AI request
          (403) until consent exists. */}
      {!caps.available && (
        <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground">
          The AI provider isn&apos;t configured on this deployment, so RIISHE is unavailable here.
        </p>
      )}

      {caps.available ? (
        <div className="min-h-0 flex-1">
          <ChatTab
            consented={consented}
            onQuotaUsed={() => void loadCaps({ silent: true })}
            usedToday={caps.usedToday}
            dailyLimit={caps.dailyLimit}
          />
        </div>
      ) : null}
    </div>
  );
}
