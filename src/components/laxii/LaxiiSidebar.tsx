"use client";

/**
 * LAXII studio left sidebar: unified creation-type dropdown (Banner / Avatar /
 * Resume), recent conversations, My images, My banners, My resumes, Favourites
 * and per-thread history entry points.
 */

import { useState } from "react";
import {
  FileText,
  Heart,
  Images,
  Layers,
  Loader2,
  MessageSquare,
  Plus,
  RectangleHorizontal,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/client";
import type {
  LaxiiCapabilities,
  LaxiiConversationSummary,
  LaxiiGalleryImage,
  ResumeSummary,
} from "@/lib/laxii-client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type SidebarTab = "chats" | "images" | "banners" | "avatars" | "resumes" | "favourites";
export type CreationMode = "banner" | "avatar" | "resume";

const CREATION_OPTIONS: { id: CreationMode; label: string; description: string }[] = [
  { id: "banner", label: "Banner", description: "Design the 2048 × 687 BEAN Folio portfolio banner." },
  { id: "avatar", label: "Avatar", description: "Generate professional photographs, headshots and stylized avatars." },
  { id: "resume", label: "Resume", description: "Create professional, ATS-friendly resumes with AI." },
];

/** Library filters — icon above an equal-width label so nothing overlaps at any width. */
const SIDEBAR_TABS: { id: SidebarTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "chats", label: "Chats", icon: MessageSquare },
  { id: "images", label: "All", icon: Images },
  { id: "banners", label: "Banners", icon: Layers },
  { id: "avatars", label: "Avatars", icon: UserRound },
  { id: "resumes", label: "Resumes", icon: FileText },
  { id: "favourites", label: "Saved", icon: Heart },
];

/** Keep in sync with RESUME_TEMPLATES in src/lib/laxii/resume-schema.ts. */
const RESUME_TEMPLATE_COUNT = 4;

export function LaxiiSidebar({
  conversations,
  activeId,
  tab,
  gallery,
  galleryLoading,
  caps,
  resumes,
  creationMode,
  onTabChange,
  onOpenConversation,
  onCreationModeChange,
  onNewCreation,
  onDeleteConversation,
  onOpenImage,
  onPreviewImage,
  onToggleFavourite,
  onToggleFavouriteFromGallery,
}: {
  conversations: LaxiiConversationSummary[];
  activeId: string | null;
  tab: SidebarTab;
  gallery: LaxiiGalleryImage[];
  galleryLoading: boolean;
  caps: LaxiiCapabilities | null;
  resumes: ResumeSummary[];
  creationMode: CreationMode;
  onTabChange: (t: SidebarTab) => void;
  onOpenConversation: (id: string) => void;
  onCreationModeChange: (mode: CreationMode) => void;
  onNewCreation: () => void;
  onDeleteConversation: (id: string) => void;
  onOpenImage: (img: LaxiiGalleryImage) => void;
  /** Opens the click-to-open image preview (full resolution). When omitted
      the gallery falls back to opening the conversation. */
  onPreviewImage?: (img: LaxiiGalleryImage) => void;
  onToggleFavourite: (versionId: string) => void;
  onToggleFavouriteFromGallery: (img: LaxiiGalleryImage) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = conversations.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()));

  // Availability of the active engine — derived internally; provider names/details never surface.
  const engineReady = caps ? (caps.providers.find((p) => p.id === caps.defaultProvider)?.available ?? false) : false;

  const kindIcon = (kind: string) =>
    kind === "BANNER" ? (
      <RectangleHorizontal className="size-4 shrink-0 text-primary" aria-hidden />
    ) : kind === "RESUME" ? (
      <FileText className="size-4 shrink-0 text-primary" aria-hidden />
    ) : kind === "AVATAR" ? (
      <UserRound className="size-4 shrink-0 text-primary" aria-hidden />
    ) : (
      <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4" data-testid="laxii-sidebar">
      {/* Unified creation-type selector — default Banner */}
      <div className="shrink-0 space-y-2">
        <Select value={creationMode} onValueChange={(v) => onCreationModeChange(v as CreationMode)}>
          {/* ONE dropdown indicator only: the shadcn Select trigger renders its
              own chevron — no custom icon here, which previously produced two
              arrows side by side. */}
          <SelectTrigger
            className="h-10 w-full justify-between gap-2 border-white/15 bg-white/[0.04] text-sm font-medium"
            aria-label="Creation type"
            data-testid="laxii-creation-type"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-muted-foreground">Create:</span>
              <span className="truncate">{CREATION_OPTIONS.find((o) => o.id === creationMode)?.label}</span>
            </span>
          </SelectTrigger>
          <SelectContent>
            {CREATION_OPTIONS.map((o) => (
              <SelectItem key={o.id} value={o.id} data-testid={`laxii-create-${o.id}`}>
                <span className="block">
                  <span className="block text-sm font-medium">{o.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{o.description}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="grid grid-cols-1 gap-2">
          <Button
            onClick={onNewCreation}
            className="h-10 justify-start gap-2 bg-primary/90 text-primary-foreground hover:bg-primary"
            data-testid="laxii-new-creation"
          >
            <Plus className="size-4" aria-hidden /> New {creationMode}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => onTabChange(v as SidebarTab)} className="w-full shrink-0">
        {/* Six equal filters must share the 288px sidebar width: tighter list
            padding/gaps + 9px labels keep every full word visible (measured
            widest label "Resumes" = 40.8px at 9px vs 41.7px per tab) — no
            truncation, no overlap, no clipped controls at any width. */}
        <TabsList className="flex h-auto w-full gap-0.5 rounded-xl bg-white/[0.04] p-0.5">
          {SIDEBAR_TABS.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-0 py-1.5 text-[9px] font-medium leading-none"
              data-testid={`laxii-tab-${t.id}`}
            >
              <t.icon className="size-4" aria-hidden />
              <span className="max-w-full truncate tracking-tight">{t.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tab === "chats" ? (
        <>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="h-9 shrink-0 border-white/10 bg-white/[0.04] text-sm"
          />
          <div className="laxii-scroll min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="flex flex-col gap-1.5 pb-3" data-testid="laxii-conversation-list">
              {filtered.length === 0 && (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  No conversations yet. Start a new creation.
                </p>
              )}
              {filtered.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onOpenConversation(c.id)}
                  className={cn(
                    "group flex w-full max-w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                    c.id === activeId
                      ? "border-primary/40 bg-primary/10"
                      : "border-transparent hover:border-white/10 hover:bg-white/[0.05]"
                  )}
                  data-testid="laxii-conversation-item"
                >
                  {kindIcon(c.kind)}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.title}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {c.kind === "BANNER" && c.canvasWidth
                        ? `${c.canvasWidth}×${c.canvasHeight} · `
                        : ""}
                      {formatDate(c.updatedAt)}
                    </span>
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Delete ${c.title}`}
                    className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteConversation(c.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        onDeleteConversation(c.id);
                      }
                    }}
                  >
                    <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" aria-hidden />
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      ) : tab === "resumes" ? (
        <div className="laxii-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="flex flex-col gap-1.5 pb-3" data-testid="laxii-resume-list">
            {resumes.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                No resumes yet — pick “Resume” in the Create dropdown to start one.
              </p>
            ) : (
              resumes.map((r) => (
                <button
                  key={r.conversationId}
                  type="button"
                  onClick={() => onOpenConversation(r.conversationId)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                    r.conversationId === activeId
                      ? "border-primary/40 bg-primary/10"
                      : "border-transparent hover:border-white/10 hover:bg-white/[0.05]"
                  )}
                  data-testid="laxii-resume-item"
                >
                  <FileText className="size-4 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{r.title}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {r.targetTitle ? `${r.targetTitle} · ` : ""}
                      {formatDate(r.updatedAt)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="laxii-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          {galleryLoading ? (
            <div className="grid place-items-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading gallery" />
            </div>
          ) : gallery.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {tab === "favourites"
                ? "Nothing saved yet. Tap the heart on an image."
                : tab === "banners"
                  ? "No banners yet — create one from the Banner studio."
                  : tab === "avatars"
                    ? "No avatars yet — pick Avatar in the Create dropdown to make one."
                    : "Your generated images and avatars will appear here."}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 pb-3" data-testid="laxii-gallery-grid">
              {gallery.map((img) => (
                <div key={img.id} className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
                  <button
                    type="button"
                    onClick={() => (onPreviewImage ? onPreviewImage(img) : onOpenImage(img))}
                    className="block w-full cursor-zoom-in"
                    aria-label={`Preview image${img.prompt ? `: ${img.prompt.slice(0, 40)}` : ""}`}
                  >
                    <img
                      src={img.url}
                      alt={img.prompt ?? "Generated image"}
                      className="aspect-square w-full object-cover transition-transform group-hover:scale-[1.03]"
                      loading="lazy"
                    />
                  </button>
                  <button
                    type="button"
                    aria-label={img.isFavourite ? "Remove from favourites" : "Add to favourites"}
                    onClick={() =>
                      img.conversationKind === "BANNER" ? onToggleFavouriteFromGallery(img) : onToggleFavourite(img.id)
                    }
                    className={cn(
                      "absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1.5 backdrop-blur transition-opacity",
                      img.isFavourite ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    )}
                  >
                    <Heart className={cn("size-3.5", img.isFavourite ? "fill-primary text-primary" : "text-white")} aria-hidden />
                  </button>
                  {img.conversationKind === "BANNER" && img.canvasWidth ? (
                    <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                      {img.canvasWidth}×{img.canvasHeight}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Engine status card — one unified LAXII identity; underlying
          providers stay internal (routing/capability data is never shown).
          shrink-0 keeps it anchored at the bottom: the scroll area above
          absorbs all remaining height and content never renders beneath it. */}
      <div className="shrink-0 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[11px] text-muted-foreground" data-testid="laxii-engine-card">
        <p className="mb-0.5 flex items-center gap-1.5 font-medium text-foreground">
          <Sparkles className="size-3.5 text-primary" aria-hidden /> LAXII
        </p>
        <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-primary/80">AI Creative Engine</p>
        <p className="flex items-center gap-1.5" data-testid="laxii-engine-status">
          <span
            className={cn("size-1.5 shrink-0 rounded-full", engineReady ? "bg-primary" : caps ? "bg-destructive" : "bg-muted-foreground")}
            aria-hidden
          />
          {engineReady ? "Engine ready" : caps ? "Engine unavailable" : "Checking engine…"}
        </p>
        <p className="mt-1">{caps ? `Daily quota · ${caps.limits.dailyImages} images` : "\u00a0"}</p>
        <p className="mt-1">
          {caps ? `Cooldown · ≈${Math.max(1, Math.ceil(60 / caps.limits.burstPerMinute))}s between generations` : "\u00a0"}
        </p>
        <p className="mt-1">
          {caps?.avatarPresets.length ?? 10} avatar presets · {RESUME_TEMPLATE_COUNT} resume templates
        </p>
      </div>
    </div>
  );
}
