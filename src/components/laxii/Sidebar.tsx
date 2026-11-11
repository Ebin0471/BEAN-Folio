"use client";

import {
  Clock,
  Heart,
  Image as ImageIcon,
  Images,
  LayoutTemplate,
  MessageSquarePlus,
  X,
} from "lucide-react";

import type { LaxiiConversationSummary, ProviderInfo } from "./types";

/**
 * LAXII Studio left sidebar (§Phase 6): new creation, recent conversations,
 * My images / My banners / Favourites / History, provider status and the
 * existing Profile Studio entry (avatar & banner integration preserved).
 */
export function Sidebar({
  conversations,
  activeId,
  view,
  providers,
  onNew,
  onOpenConversation,
  onNavigate,
  onOpenProfileStudio,
}: {
  conversations: LaxiiConversationSummary[];
  activeId: string | null;
  view: "chat" | "images" | "banners" | "favourites" | "history";
  providers: ProviderInfo[];
  onNew: () => void;
  onOpenConversation: (id: string) => void;
  onNavigate: (v: "images" | "banners" | "favourites" | "history") => void;
  onOpenProfileStudio: () => void;
}) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between gap-2 p-3 pb-2">
        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
        >
          <MessageSquarePlus className="size-4" aria-hidden />
          New creation
        </button>
        <button type="button" onClick={onNew} className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent md:hidden" aria-label="Close menu">
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {/* recent conversations */}
      <nav aria-label="Recent conversations" className="min-h-24 flex-1 overflow-y-auto px-2 pb-2 laxii-scroll">
        <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Recent</p>
        {conversations.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
            No conversations yet. Describe what you want to create — LAXII generates, then refines with you turn by turn.
          </p>
        ) : (
          <ul className="grid gap-0.5">
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onOpenConversation(c.id)}
                  aria-current={c.id === activeId ? "page" : undefined}
                  className={`w-full truncate rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                    c.id === activeId && view === "chat" ? "bg-gold-soft/40 text-primary" : "text-foreground/90 hover:bg-accent"
                  }`}
                >
                  {c.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      {/* library + history */}
      <div className="shrink-0 border-t border-border/60 p-2">
        <p className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Workspace</p>
        <ul className="grid gap-0.5">
          <SidebarItem icon={Images} label="My images" active={view === "images"} onClick={() => onNavigate("images")} />
          <SidebarItem icon={LayoutTemplate} label="My banners" active={view === "banners"} onClick={() => onNavigate("banners")} />
          <SidebarItem icon={Heart} label="Favourites" active={view === "favourites"} onClick={() => onNavigate("favourites")} />
          <SidebarItem icon={Clock} label="History" active={view === "history"} onClick={() => onNavigate("history")} />
          <SidebarItem icon={ImageIcon} label="Profile Studio" hint="Avatar & cover" onClick={onOpenProfileStudio} />
        </ul>
      </div>

      {/* provider status */}
      <div className="shrink-0 border-t border-border/60 p-3">
        <p className="pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Providers</p>
        <ul className="grid gap-1">
          {(providers.length ? providers : [{ id: "managed", label: "Managed inference", available: true, isDefault: true, kind: "managed-api" as const, capabilities: null }]).map(
            (p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={`size-1.5 shrink-0 rounded-full ${p.available ? "bg-emerald-500" : "bg-red-400"}`} aria-hidden />
                  <span className={`truncate ${p.isDefault ? "font-medium text-primary" : "text-foreground/80"}`} title={p.label}>
                    {p.label}
                  </span>
                </span>
                {!p.available && "reason" in p && p.reason ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground" title={p.reason}>
                    needs key
                  </span>
                ) : p.isDefault ? (
                  <span className="shrink-0 text-[10px] text-primary">default</span>
                ) : null}
              </li>
            )
          )}
        </ul>
      </div>
    </div>
  );
}

function SidebarItem({
  icon: Icon,
  label,
  hint,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
          active ? "bg-gold-soft/40 font-medium text-primary" : "text-foreground/90 hover:bg-accent"
        }`}
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{label}</span>
        {hint ? <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{hint}</span> : null}
      </button>
    </li>
  );
}
