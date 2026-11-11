"use client";

/**
 * StudioChatPanel — the Website Studio's conversational coding pane.
 *
 * The user describes website changes in plain language; Code Giftz inspects
 * the REAL draft (server-side digest + portfolio grounding), produces a
 * validated structured plan, executes it in a DURABLE job (atomic lease,
 * per-step persistence) and streams progress back:
 *
 *   POST /api/ai/design/chat   (SSE: status → plan/reply → done)
 *   GET  /api/ai/design/job    (drives the job chunk-by-chunk; step progress)
 *
 * The finished proposal is handed to the studio via `onProposal` — the canvas
 * previews it and the user Accepts (applies to draft) or Discards. Nothing
 * here ever writes the saved website directly; Save/Publish stay in the
 * studio toolbar with their own explicit approval.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Loader2,
  MessageSquarePlus,
  RotateCcw,
  Send,
  Sparkles,
  SquarePen,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/client";
import type { SiteConfig } from "@/lib/site-config";
import { cn } from "@/lib/utils";

export interface StudioProposal {
  config: SiteConfig;
  changes: string[];
  reply: string;
  request: string;
  baseConfig: SiteConfig;
}

/**
 * Locally-generated message ids. `Date.now()` alone can collide when two
 * messages land in the same millisecond (optimistic + reply, error + retry),
 * which React reports as duplicate keys — the counter keeps them unique.
 */
let localMessageSeq = 0;
function nextLocalMessageId(): string {
  localMessageSeq += 1;
  return `a-${Date.now()}-${localMessageSeq}`;
}

export interface StudioChatContext {
  device: string;
  pageName: string | null;
  sectionType: string | null;
  sectionTitle: string | null;
}

interface ChatMessage {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  meta: {
    jobId?: string;
    steps?: { id: string; title: string; tool: string }[];
    error?: boolean;
    clarifying?: string | null;
  } | null;
  createdAt: string;
}

interface ConversationSummary {
  conversationId: string;
  title: string;
  updatedAt: string;
  count: number;
}

interface JobStepView {
  id: string;
  title: string;
  status: string;
  changes?: string[];
  error?: string | null;
}

interface JobSnapshotView {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  steps: JobStepView[];
  changes: string[];
  config?: SiteConfig;
  baseConfig?: SiteConfig;
  error?: string | null;
  events?: { ts: number; level: string; message: string }[];
}

const SUGGESTIONS = [
  "Make the hero headline bolder and more premium",
  "Improve spacing without changing the layout",
  "Add a testimonials section",
  "Use a more editorial font pairing",
  "Highlight my best three projects",
];

export default function StudioChatPanel({
  currentConfig,
  context,
  onProposal,
  onOpenSection,
}: {
  currentConfig: SiteConfig | null;
  context: StudioChatContext;
  /** Finished proposal → the studio previews it on the canvas (stale-guarded). */
  onProposal: (p: StudioProposal) => void;
  /** "Refine on canvas" helper — open the section inspector. */
  onOpenSection?: () => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [phase, setPhase] = useState<"inspect" | "plan" | null>(null);
  const [job, setJob] = useState<JobSnapshotView | null>(null);
  const [proposedJobIds, setProposedJobIds] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeJobId = job?.id ?? null;

  /** Load conversation summaries (history popover). */
  const refreshConversations = useCallback(async () => {
    try {
      const data = await api<{ conversations: ConversationSummary[] }>("/api/ai/design/chat");
      setConversations(data.conversations);
    } catch {
      /* history is an enhancement — never block the composer on it */
    }
  }, []);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  /** Keep the thread scrolled to the newest message. */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, phase, job?.status, job?.steps.length]);

  /** Stop any job poll when the panel unmounts or the job changes. */
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const openConversation = useCallback(async (id: string | null) => {
    setHistoryOpen(false);
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setJob(null);
    setPhase(null);
    if (!id) {
      setConversationId(null);
      setMessages([]);
      return;
    }
    setConversationId(id);
    try {
      const data = await api<{ messages: ChatMessage[] }>(`/api/ai/design/chat?conversationId=${encodeURIComponent(id)}`);
      setMessages(data.messages);
      // Re-attach to the newest job mentioned in history (restart-safe).
      const withJob = [...data.messages].reverse().find((m) => m.meta?.jobId);
      if (withJob?.meta?.jobId) attachJob(withJob.meta.jobId, true);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not load that conversation.");
    }
  }, []);

  /** Poll a durable job until it reaches a terminal state. */
  const attachJob = useCallback(
    (jobId: string, quiet = false) => {
      if (pollRef.current) clearInterval(pollRef.current);
      const poll = async () => {
        try {
          const data = await api<{ job: JobSnapshotView }>(`/api/ai/design/job?id=${encodeURIComponent(jobId)}`);
          const snap = data.job;
          setJob(snap);
          if (snap.status === "completed" || snap.status === "failed" || snap.status === "cancelled") {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            if (snap.status === "completed" && snap.config && snap.baseConfig) {
              const proposal: StudioProposal = {
                config: snap.config,
                changes: snap.changes,
                reply: "",
                request: "",
                baseConfig: snap.baseConfig,
              };
              setProposedJobIds((prev) => new Set(prev).add(jobId));
              onProposal(proposal);
            }
          }
        } catch {
          /* transient poll errors retry on the next tick */
        }
      };
      if (!quiet) void poll();
      pollRef.current = setInterval(poll, 2000);
    },
    [onProposal]
  );

  /** Retry a failed job (durable store keeps completed steps). */
  const retryJob = useCallback(async (jobId: string) => {
    try {
      await api("/api/ai/design/job", { method: "POST", json: { jobId, action: "retry" } });
      setJob((j) => (j && j.id === jobId ? { ...j, status: "queued" } : j));
      attachJob(jobId);
      toast.success("Retrying from where it stopped — completed steps are kept.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not retry that execution.");
    }
  }, [attachJob]);

  /** Send a chat turn and consume the SSE stream. */
  const send = useCallback(
    async (text: string, mode: "edit" | "create" = "edit") => {
      const trimmed = text.trim();
      if (trimmed.length < 2 || !currentConfig || sending) return;
      setSending(true);
      setPhase("inspect");
      setInput("");
      const optimisticId = `local-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: optimisticId, role: "USER", content: trimmed, meta: null, createdAt: new Date().toISOString() },
      ]);

      try {
        const res = await fetch("/api/ai/design/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            currentConfig,
            conversationId: conversationId ?? undefined,
            mode,
            context,
          }),
        });
        if (!res.ok || !res.body) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "Code Giftz could not start this request. Try again in a moment.");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assistantShown = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            let evt: Record<string, unknown>;
            try {
              evt = JSON.parse(line.slice(6)) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (evt.type === "status") {
              setPhase(evt.phase === "plan" ? "plan" : "inspect");
            } else if (evt.type === "reply") {
              assistantShown = true;
              setPhase(null);
              setMessages((prev) => [
                ...prev,
                { id: nextLocalMessageId(), role: "ASSISTANT", content: String(evt.reply ?? ""), meta: { steps: [] }, createdAt: new Date().toISOString() },
              ]);
            } else if (evt.type === "plan") {
              assistantShown = true;
              setPhase(null);
              const steps = (evt.steps as { id: string; title: string; tool: string }[]) ?? [];
              setMessages((prev) => [
                ...prev,
                {
                  id: nextLocalMessageId(),
                  role: "ASSISTANT",
                  content: String(evt.reply ?? "Working on it."),
                  meta: { steps },
                  createdAt: new Date().toISOString(),
                },
              ]);
              if (typeof evt.jobId === "string") attachJob(evt.jobId);
            } else if (evt.type === "done") {
              if (typeof evt.conversationId === "string") setConversationId(evt.conversationId);
              void refreshConversations();
            } else if (evt.type === "error") {
              assistantShown = true;
              setPhase(null);
              setMessages((prev) => [
                ...prev,
                { id: nextLocalMessageId(), role: "ASSISTANT", content: String(evt.message ?? "Something went wrong."), meta: { error: true }, createdAt: new Date().toISOString() },
              ]);
            }
          }
        }
        if (!assistantShown && phase === null) {
          // Stream ended without any assistant frame — surface an honest gap.
          setMessages((prev) => [
            ...prev,
            { id: nextLocalMessageId(), role: "ASSISTANT", content: "Code Giftz's reply did not arrive. Try sending that again.", meta: { error: true }, createdAt: new Date().toISOString() },
          ]);
        }
      } catch (e) {
        setPhase(null);
        setMessages((prev) => [
          ...prev,
          {
            id: nextLocalMessageId(),
            role: "ASSISTANT",
            content: e instanceof Error ? e.message : "Code Giftz could not be reached. Check your connection and try again.",
            meta: { error: true },
            createdAt: new Date().toISOString(),
          },
        ]);
      } finally {
        setSending(false);
        setPhase(null);
      }
    },
    [attachJob, conversationId, context, currentConfig, onProposal, phase, refreshConversations, sending]
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        await api(`/api/ai/design/chat?conversationId=${encodeURIComponent(id)}`, { method: "DELETE" });
        setConversations((prev) => prev.filter((c) => c.conversationId !== id));
        if (conversationId === id) void openConversation(null);
      } catch {
        /* non-fatal */
      }
    },
    [conversationId, openConversation]
  );

  const placeholder = useMemo(
    () => (currentConfig ? "Describe the change — e.g. make the navigation sticky" : "The website is still loading…"),
    [currentConfig]
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="studio-chat">
      {/* header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="truncate">Code Giftz</span>
          <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">· website coder</span>
        </p>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon" className="size-7" aria-label="Conversation history" aria-expanded={historyOpen} onClick={() => setHistoryOpen((v) => !v)}>
            <ChevronDown className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="New conversation"
            title="New conversation"
            onClick={() => void openConversation(null)}
          >
            <MessageSquarePlus className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      {/* history popover */}
      {historyOpen && (
        <div className="max-h-52 shrink-0 overflow-y-auto border-b border-border/60 bg-muted/20 p-2" style={{ scrollbarWidth: "thin" }}>
          {conversations.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">No previous conversations yet.</p>
          ) : (
            conversations.map((c) => (
              <div key={c.conversationId} className={cn("group mb-1 flex items-center gap-1 rounded-lg border px-2.5 py-1.5 transition-colors", conversationId === c.conversationId ? "border-primary/40 bg-gold-soft/40" : "border-transparent hover:bg-accent")}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void openConversation(c.conversationId)}>
                  <span className="block truncate text-xs font-medium">{c.title}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{c.count} messages</span>
                </button>
                <Button variant="ghost" size="icon" className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100" aria-label="Delete conversation" onClick={() => void deleteConversation(c.conversationId)}>
                  <X className="size-3" aria-hidden />
                </Button>
              </div>
            ))
          )}
        </div>
      )}

      {/* thread */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" style={{ scrollbarWidth: "thin" }}>
        {messages.length === 0 && !phase && (
          <div className="space-y-3 pt-6 text-center">
            <Wand2 className="mx-auto size-6 text-primary/70" aria-hidden />
            <p className="mx-auto max-w-[240px] text-sm text-muted-foreground">
              Describe what to change — Code Giftz inspects your real website, plans the exact edits, applies them in an isolated workspace and shows the result on the canvas.
            </p>
            <div className="flex flex-wrap justify-center gap-1.5 px-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  disabled={sending || !currentConfig}
                  className="rounded-full border border-border/70 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === "USER" ? (
            <div key={m.id} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-gold-soft/50 px-3 py-2 text-sm text-foreground" data-testid="studio-chat-user">
                {m.content}
              </p>
            </div>
          ) : (
            <div key={m.id} className="space-y-2" data-testid="studio-chat-assistant">
              <div className={cn("max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border px-3 py-2 text-sm", m.meta?.error ? "border-destructive/40 bg-destructive/10 text-foreground" : "border-border/60 bg-card text-foreground")}>
                {m.content}
              </div>
              {m.meta?.steps && m.meta.steps.length > 0 && !m.meta.jobId && (
                <ul className="space-y-1 pl-1">
                  {m.meta.steps.map((s) => (
                    <li key={s.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Check className="size-3 text-primary" aria-hidden /> {s.title}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        )}

        {/* phase indicator */}
        {phase && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="studio-chat-phase">
            <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
            {phase === "inspect" ? "Inspecting your website…" : "Planning the changes…"}
          </div>
        )}

        {/* live job progress */}
        {job && (job.status === "queued" || job.status === "running") && (
          <div className="space-y-2 rounded-xl border border-primary/25 bg-gold-soft/20 p-3" data-testid="studio-job-progress">
            <p className="flex items-center gap-1.5 text-xs font-medium text-primary">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Applying changes — {job.steps.filter((s) => s.status === "done" || s.status === "repaired").length}/{job.steps.length}
            </p>
            <ul className="space-y-1">
              {job.steps.map((s) => (
                <li key={s.id} className="flex items-center gap-1.5 text-[11px]">
                  {s.status === "done" || s.status === "repaired" ? (
                    <Check className="size-3 text-primary" aria-hidden />
                  ) : s.status === "running" ? (
                    <Loader2 className="size-3 animate-spin text-primary" aria-hidden />
                  ) : s.status === "failed" ? (
                    <CircleAlert className="size-3 text-destructive" aria-hidden />
                  ) : (
                    <span className="size-3 rounded-full border border-border/70" aria-hidden />
                  )}
                  <span className={cn(s.status === "pending" && "text-muted-foreground")}>{s.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* terminal job states */}
        {job && job.status === "completed" && proposedJobIds.has(job.id) && (
          <div className="space-y-1.5 rounded-xl border border-primary/30 bg-gold-soft/30 p-3 text-xs">
            <p className="font-medium text-primary">Changes ready — previewing on the canvas.</p>
            {job.changes.length > 0 && (
              <ul className="list-inside list-disc space-y-0.5 text-muted-foreground">
                {job.changes.slice(0, 5).map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
            <p className="text-muted-foreground">
              Accept the proposal above the canvas to apply it to your draft, discard it, or keep chatting to refine it.
            </p>
            {onOpenSection && (
              <Button variant="ghost" size="sm" className="h-6 w-full px-2 text-[11px]" onClick={onOpenSection}>
                <SquarePen className="size-3" aria-hidden /> Fine-tune on the canvas
              </Button>
            )}
          </div>
        )}
        {job && job.status === "failed" && (
          <div className="space-y-1.5 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs">
            <p className="font-medium text-destructive">{job.error ?? "The execution failed."}</p>
            <p className="text-muted-foreground">Your draft was not touched — completed steps remain previewable.</p>
            <Button variant="outline" size="sm" className="h-7 w-full" onClick={() => void retryJob(job.id)}>
              <RotateCcw className="size-3.5" aria-hidden /> Retry the failed steps
            </Button>
          </div>
        )}
        {job && job.status === "cancelled" && (
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
            Execution cancelled — completed steps were kept out of your draft.
          </div>
        )}
      </div>

      {/* composer */}
      <div className="shrink-0 border-t border-border/60 p-2.5">
        <Label htmlFor="studio-chat-input" className="sr-only">
          Describe a website change for Code Giftz
        </Label>
        <Textarea
          id="studio-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          placeholder={placeholder}
          rows={2}
          maxLength={2000}
          disabled={!currentConfig || sending}
          className="min-h-[56px] resize-none border-border/60 bg-background/60 text-sm"
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => void send("Create my own website from scratch using my portfolio content", "create")}
            disabled={!currentConfig || sending}
            className="rounded-full border border-primary/30 px-2.5 py-1 text-[11px] text-primary transition-colors hover:bg-gold-soft/40 disabled:opacity-50"
            title="Start a fresh composition from your real portfolio data (replaces the current draft layout)"
          >
            Create my own website
          </button>
          <Button size="sm" className="h-8 gap-1.5" onClick={() => void send(input)} disabled={!currentConfig || sending || input.trim().length < 2}>
            {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
