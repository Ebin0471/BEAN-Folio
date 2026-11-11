"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clock,
  Image as ImageIcon,
  Images,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  Wand2,
} from "lucide-react";

import { api } from "@/lib/client";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/bean/Spinner";
import { ProfileStudio } from "@/components/bean/ProfileStudio";

import { Sidebar } from "./Sidebar";
import { Thread } from "./Thread";
import { Composer } from "./Composer";
import { LibraryPanel } from "./LibraryPanel";
import { mediaUrl, type LaxiiChatMessage, type LaxiiConversationSummary, type LibraryAsset, type ProviderInfo } from "./types";

/**
 * LAXII — conversational creative studio (§Phase 6).
 *
 * Layout: left sidebar (new creation / recent conversations / library /
 * history / Profile Studio entry), centre conversational thread with
 * variation cards + image actions, bottom composer. Premium dark surface
 * with the BEAN Folio champagne-gold accent. The existing Profile Studio
 * (avatar/banner integration) remains one click away — one engine, two doors.
 */
export function Studio() {
  const [view, setView] = useState<"chat" | "images" | "banners" | "favourites" | "history">("chat");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [conversations, setConversations] = useState<LaxiiConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LaxiiChatMessage[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryAsset[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [profileStudioOpen, setProfileStudioOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const pollingRef = useRef(false);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3600);
  }, []);

  // ---------------------------------------------------------------- data load
  const loadConversations = useCallback(() => {
    let alive = true;
    api<{ conversations: LaxiiConversationSummary[] }>("/api/laxii/conversations")
      .then((r) => alive && setConversations(r.conversations))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    api<{ providers: ProviderInfo[] }>("/api/laxii/capabilities")
      .then((r) => alive && setProviders(r.providers))
      .catch(() => undefined);
    const off = loadConversations();
    return () => {
      alive = false;
      off();
    };
  }, [loadConversations]);

  const openConversation = useCallback(
    (id: string | null) => {
      setSidebarOpen(false);
      if (!id) {
        setConversationId(null);
        setMessages([]);
        setSelectedAssetId(null);
        setView("chat");
        return;
      }
      setView("chat");
      let alive = true;
      api<{ conversation: { id: string }; messages: LaxiiChatMessage[] }>(`/api/laxii/conversations/${id}`)
        .then((r) => {
          if (!alive) return;
          setConversationId(id);
          setMessages(r.messages);
          const lastSelected = [...r.messages].reverse().find((m) => m.selectedAssetId)?.selectedAssetId ?? null;
          setSelectedAssetId(lastSelected);
        })
        .catch(() => notify("Could not open that conversation"));
      return () => {
        alive = false;
      };
    },
    [notify]
  );

  const loadLibrary = useCallback(
    (v: "images" | "banners" | "favourites") => {
      let alive = true;
      // No synchronous setState in the effect body — the loading flag flips
      // inside the async chain (stale-guard pattern used across the shell).
      Promise.resolve().then(() => {
        if (alive) setLibraryLoading(true);
      });
      api<{ assets: LibraryAsset[] }>(`/api/laxii/library?view=${v}`)
        .then((r) => {
          if (!alive) return;
          setLibrary(r.assets);
          setLibraryLoading(false);
        })
        .catch(() => {
          if (!alive) return;
          notify("Could not load your library");
          setLibraryLoading(false);
        });
      return () => {
        alive = false;
      };
    },
    [notify]
  );

  useEffect(() => {
    if (view === "images" || view === "banners" || view === "favourites") {
      const off = loadLibrary(view);
      return off;
    }
  }, [view, loadLibrary]);

  // ---------------------------------------------------------------- polling
  const pollActive = useCallback(
    (convId: string) => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      const tick = async () => {
        try {
          const r = await api<{ messages: LaxiiChatMessage[] }>(`/api/laxii/conversations/${convId}`);
          setMessages(r.messages);
          const lastSelected = [...r.messages].reverse().find((m) => m.selectedAssetId)?.selectedAssetId ?? null;
          setSelectedAssetId((cur) => cur ?? lastSelected);
          const pending = r.messages.some((m) => m.role === "ASSISTANT" && (m.status === "QUEUED" || m.status === "RUNNING"));
          if (pending) {
            window.setTimeout(tick, 2200);
          } else {
            pollingRef.current = false;
            loadConversations();
          }
        } catch {
          pollingRef.current = false;
        }
      };
      window.setTimeout(tick, 1200);
    },
    [loadConversations]
  );

  const onSent = useCallback(
    (convId: string) => {
      setView("chat");
      setConversationId(convId);
      // Optimistic: pull the thread immediately; polling keeps it fresh.
      let alive = true;
      api<{ messages: LaxiiChatMessage[] }>(`/api/laxii/conversations/${convId}`)
        .then((r) => {
          if (!alive) return;
          setMessages(r.messages);
          const pending = r.messages.some((m) => m.role === "ASSISTANT" && (m.status === "QUEUED" || m.status === "RUNNING"));
          if (pending) pollActive(convId);
        })
        .catch(() => undefined);
      loadConversations();
      return () => {
        alive = false;
      };
    },
    [loadConversations, pollActive]
  );

  const retryMessage = useCallback(
    async (jobId: string) => {
      try {
        await api(`/api/laxii/jobs/${jobId}/retry`, { method: "POST" });
        if (conversationId) {
          onSent(conversationId);
          pollActive(conversationId);
        }
        notify("Retrying generation");
      } catch {
        notify("Retry failed — try again in a moment");
      }
    },
    [conversationId, notify, onSent, pollActive]
  );

  const selectOutput = useCallback(
    async (messageId: string, assetId: string) => {
      setSelectedAssetId(assetId);
      setMessages((msgs) => msgs.map((m) => (m.id === messageId ? { ...m, selectedAssetId: assetId } : m)));
      try {
        await api(`/api/laxii/messages/${messageId}`, { method: "PATCH", json: { selectedAssetId: assetId } });
      } catch {
        /* selection is optimistic; the server truth catches up on next poll */
      }
    },
    []
  );

  const toggleFavourite = useCallback(
    async (assetId: string, favourite: boolean) => {
      try {
        await api("/api/laxii/library", { method: "PATCH", json: { assetId, favourite } });
        notify(favourite ? "Saved to Favourites" : "Removed from Favourites");
      } catch {
        notify("Could not update favourite");
      }
    },
    [notify]
  );

  const startFromAsset = useCallback(
    (assetId: string) => {
      setSelectedAssetId(assetId);
      setView("chat");
      if (!conversationId) {
        api<{ conversation: { id: string } }>("/api/laxii/conversations", { method: "POST", json: {} })
          .then((r) => {
            setConversationId(r.conversation.id);
            loadConversations();
          })
          .catch(() => notify("Could not start a new creation"));
      }
      notify("Image selected — describe your edit below");
    },
    [conversationId, loadConversations, notify]
  );

  const activeProvider = useMemo(() => providers.find((p) => p.available) ?? providers[0], [providers]);

  return (
    <div className="flex h-[calc(100dvh-4rem-4.5rem)] min-h-[560px] w-full overflow-hidden bg-background md:h-[calc(100dvh-4rem)]" data-testid="laxii-studio">
      {/* ---------------- left sidebar */}
      <div
        className={`${sidebarOpen ? "flex" : "hidden"} absolute inset-y-0 left-0 z-50 h-full w-64 shrink-0 flex-col border-r border-border/60 bg-background/95 backdrop-blur md:relative md:flex md:h-auto`}
      >
        <Sidebar
          conversations={conversations}
          activeId={conversationId}
          view={view}
          providers={providers}
          onNew={() => openConversation(null)}
          onOpenConversation={(id) => openConversation(id)}
          onNavigate={(v) => {
            setSidebarOpen(false);
            setView(v);
          }}
          onOpenProfileStudio={() => {
            setSidebarOpen(false);
            setProfileStudioOpen(true);
          }}
        />
      </div>

      {/* ---------------- main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* header */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/60 bg-background/70 px-3 backdrop-blur sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              className="grid size-9 place-items-center rounded-lg border border-border/60 text-muted-foreground md:hidden"
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label={sidebarOpen ? "Close menu" : "Open menu"}
            >
              {sidebarOpen ? <PanelLeftClose className="size-4" aria-hidden /> : <PanelLeftOpen className="size-4" aria-hidden />}
            </button>
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-gold-soft ring-1 ring-primary/30">
              <Wand2 className="size-4 text-primary" aria-hidden />
            </span>
            <div className="min-w-0">
              <h1 className="truncate font-display text-sm font-semibold tracking-tight sm:text-base">LAXII Studio</h1>
              <p className="truncate text-[11px] text-muted-foreground sm:text-xs">
                {view === "chat"
                  ? "Conversational image generation & editing"
                  : view === "history"
                    ? "Generation history"
                    : view === "banners"
                      ? "My banners"
                      : view === "favourites"
                        ? "Favourites"
                        : "My images"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {activeProvider ? (
              <span
                className="hidden items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-2.5 py-1 text-[11px] text-muted-foreground sm:inline-flex"
                title={activeProvider.available ? activeProvider.capabilities.costBasis : (activeProvider.reason ?? "unavailable")}
              >
                <span className={`size-1.5 rounded-full ${activeProvider.available ? "bg-emerald-500" : "bg-red-400"}`} aria-hidden />
                {activeProvider.label}
              </span>
            ) : (
              <Spinner className="size-4" />
            )}
            <Button size="sm" variant="outline" className="hidden gap-1.5 border-border/60 sm:inline-flex" onClick={() => openConversation(null)}>
              <MessageSquarePlus className="size-3.5" aria-hidden /> New
            </Button>
          </div>
        </header>

        {/* body */}
        {view === "chat" ? (
          <>
            <Thread
              messages={messages}
              hasConversation={Boolean(conversationId)}
              selectedAssetId={selectedAssetId}
              onSelectOutput={selectOutput}
              onRetry={retryMessage}
              onToggleFavourite={toggleFavourite}
              onUseImage={(assetId) => startFromAsset(assetId)}
            />
            <Composer
              conversationId={conversationId}
              selectedAssetId={selectedAssetId}
              providers={providers}
              onSent={(id) => {
                onSent(id);
                if (!conversationId) setConversationId(id);
              }}
              onError={notify}
              onCreateConversation={async () => {
                const r = await api<{ conversation: { id: string } }>("/api/laxii/conversations", { method: "POST", json: {} });
                setConversationId(r.conversation.id);
                loadConversations();
                return r.conversation.id;
              }}
            />
          </>
        ) : view === "history" ? (
          <HistoryPanel onOpen={openConversation} />
        ) : (
          <LibraryPanel
            view={view}
            assets={library}
            loading={libraryLoading}
            onToggleFavourite={toggleFavourite}
            onUse={(assetId) => startFromAsset(assetId)}
            onRefresh={() => loadLibrary(view)}
          />
        )}
      </div>

      {/* toast */}
      {toast ? (
        <div className="pointer-events-none fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-primary/30 bg-card/95 px-4 py-2 text-sm shadow-lg backdrop-blur" role="status">
          {toast}
        </div>
      ) : null}

      {/* Profile Studio — the existing avatar/banner integration, one click away */}
      <ProfileStudioProvider open={profileStudioOpen} onOpenChange={setProfileStudioOpen} />
    </div>
  );
}

/**
 * The EXISTING Profile Studio is hosted in a small subcomponent that loads
 * the user's current avatar/cover urls for its before/after views.
 */
function ProfileStudioProvider({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [urls, setUrls] = useState<{ avatarUrl?: string; coverUrl?: string } | null>(null);
  useEffect(() => {
    if (!open || urls) return;
    let alive = true;
    api<{ user: { avatarUrl?: string; coverUrl?: string } }>("/api/me/profile")
      .then((r) => alive && setUrls({ avatarUrl: r.user?.avatarUrl, coverUrl: r.user?.coverUrl }))
      .catch(() => alive && setUrls({}));
    return () => {
      alive = false;
    };
  }, [open, urls]);
  return (
    <ProfileStudio
      open={open}
      onOpenChange={onOpenChange}
      initialTab="avatar"
      currentAvatarUrl={urls?.avatarUrl ?? null}
      currentCoverUrl={urls?.coverUrl ?? null}
      onApplied={() => undefined}
    />
  );
}

// ---------------------------------------------------------------- history panel (inline)
function HistoryPanel({ onOpen }: { onOpen: (id: string | null) => void }) {
  const [jobs, setJobs] = useState<
    { id: string; kind: string; status: string; provider: string; progress: number; error: string | null; createdAt: string; results: { mediaAssetId: string }[] }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api<{ jobs: { id: string; kind: string; status: string; provider: string; progress: number; error: string | null; createdAt: string; results: { mediaAssetId: string }[] }[] }>("/api/laxii/jobs?limit=30")
      .then((r) => alive && setJobs(r.jobs))
      .catch(() => undefined)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="grid flex-1 place-items-center">
        <Spinner className="size-6 text-primary" />
      </div>
    );
  }

  if (!jobs.length) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-center">
        <div>
          <Clock className="mx-auto size-8 text-muted-foreground/50" aria-hidden />
          <p className="mt-3 text-sm text-muted-foreground">No generations yet — your history will appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <ul className="mx-auto grid max-w-3xl gap-2">
        {jobs.map((j) => (
          <li key={j.id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 p-3">
            <span
              className={`grid size-9 shrink-0 place-items-center rounded-lg ${
                j.status === "SUCCEEDED" ? "bg-emerald-500/10 text-emerald-500" : j.status === "FAILED" ? "bg-red-500/10 text-red-400" : "bg-gold-soft text-primary"
              }`}
            >
              {j.status === "SUCCEEDED" ? <Images className="size-4" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {j.kind.replace("_", " ")} <span className="text-muted-foreground">· {j.provider}</span>
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {new Date(j.createdAt).toLocaleString()}
                {j.error ? ` — ${j.error}` : j.status !== "SUCCEEDED" ? ` — ${j.status.toLowerCase()} ${j.progress}%` : ""}
              </p>
            </div>
            {j.results?.[0] ? (
              <img src={mediaUrl(j.results[0].mediaAssetId)} alt="" className="size-10 rounded-md border border-border/60 object-cover" loading="lazy" />
            ) : null}
          </li>
        ))}
      </ul>
      <div className="mt-4 text-center">
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => onOpen(null)}>
          <ImageIcon className="size-3.5" aria-hidden /> Start a new creation
        </Button>
      </div>
    </div>
  );
}
