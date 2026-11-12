"use client";

/**
 * Studio control building blocks.
 *
 * MOVED verbatim-in-behavior from the old WebsiteBuilderView design/content
 * tabs — the same real components (FontSelect, MotionPicker, PaletteLibrary,
 * ContrastRow, PanelGroup, library favorites/recents) with identical props so
 * every control stays wired to the same mutations. This is a reorganization,
 * not a behavior change.
 */

import { useMemo, useState } from "react";
import {
  ChevronDown,
  Contrast,
  Palette,
  Search,
  Star,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { SITE_FONTS, fontCategoryList, fontStack, resolveFont } from "@/lib/site-fonts";
import { PALETTES, contrastRatio, paletteCategories, readableTextOn } from "@/lib/site-palettes";
import { getMotionPreset, motionCategoryList, motionPresetsByScope } from "@/lib/site-motion";
import type { SiteConfig, SiteSection, SiteSectionType } from "@/lib/site-config";

// ------------------------------------------------------------------ section labels

export const SECTION_TYPE_LABELS: Record<SiteSectionType, string> = {
  hero: "Hero",
  about: "About",
  projects: "Projects",
  featured: "Featured work",
  reel: "Video reel",
  skills: "Skills",
  stats: "Stats",
  collections: "Collections",
  contact: "Contact",
  services: "Services",
  experience: "Experience",
  gallery: "Gallery",
  testimonials: "Testimonials",
  process: "Process",
  faq: "FAQ",
  pricing: "Pricing",
  logos: "Client logos",
};

export const SECTION_TYPE_HINTS: Partial<Record<SiteSectionType, string>> = {
  testimonials: "Add only genuine quotes you have permission to publish.",
  experience: "Your real roles, education and milestones — nothing is invented.",
  services: "What you offer clients, in your own words.",
  gallery: "Pulls real cover images from your published work.",
  featured: "Your best work only — an editorial showcase, separate from All Projects.",
  reel: "Up to five of your videos, in your order — real playable video content.",
  process: "How you work, step by step.",
  faq: "Answer real questions your clients actually ask.",
  pricing: "Your real rates — numbers you are comfortable publishing.",
  logos: "Real client names only — placeholders render until you add them.",
};

export function SectionSummary({ section }: { section: SiteSection }) {
  switch (section.type) {
    case "hero":
      return section.subtitle || "Opening headline";
    case "about":
      return section.body ? section.body.slice(0, 60) : "Story and bio";
    case "projects":
      return `Up to ${section.limit} projects · ${section.layout}${section.category ? ` · ${section.category}` : ""}`;
    case "featured":
      return section.projectIds.length
        ? `${section.projectIds.length} selected · ${section.layout}`
        : "Editorial showcase — starred projects";
    case "reel":
      return section.videos.length ? `${section.videos.length} videos · ${section.layout}` : "Up to five videos";
    case "collections":
      return `Up to ${section.limit} collections`;
    case "services":
      return section.items.length ? `${section.items.length} services · ${section.layout}` : "What you offer";
    case "experience":
      return section.entries.length ? `${section.entries.length} entries · ${section.layout}` : "Roles and education";
    case "process":
      return section.items.length ? `${section.items.length} steps · ${section.layout}` : "How you work";
    case "faq":
      return section.items.length ? `${section.items.length} Q&As` : "Common questions";
    case "pricing":
      return section.tiers.length ? `${section.tiers.length} tiers · ${section.layout}` : "Your rates";
    case "logos":
      return section.items.length ? `${section.items.length} wordmarks` : "Client names";
    case "gallery":
      return `${section.limit} images · ${section.layout}`;
    case "testimonials":
      return section.items.length ? `${section.items.length} quotes · ${section.layout}` : "Genuine client quotes";
    case "contact":
      return section.body ? section.body.slice(0, 60) : "Contact details";
    default:
      return "Profile data section";
  }
}

// ------------------------------------------------------------------ unsaved-change summary

/** Human-readable list of unsaved draft changes (theme/motion/pages). */
export function summarizeConfigDiff(before: SiteConfig | null, after: SiteConfig): string[] {
  if (!before) return ["New draft"];
  const out: string[] = [];
  if (before.name !== after.name) out.push(`Renamed the website to “${after.name}”`);
  if (before.tagline !== after.tagline) out.push("Changed the tagline");
  if (before.template !== after.template) out.push(`Switched template to ${after.template}`);
  for (const key of Object.keys(after.theme) as (keyof SiteConfig["theme"])[]) {
    if (JSON.stringify(before.theme[key]) !== JSON.stringify(after.theme[key])) out.push(`Changed ${String(key)}`);
  }
  for (const key of Object.keys(after.motion) as (keyof SiteConfig["motion"])[]) {
    if (JSON.stringify(before.motion[key]) !== JSON.stringify(after.motion[key])) out.push(`Changed motion “${String(key)}”`);
  }
  const beforePages = new Map(before.pages.map((p) => [p.id, p]));
  for (const page of after.pages) {
    const bp = beforePages.get(page.id);
    if (!bp) { out.push(`Added page “${page.name}”`); continue; }
    if (bp.name !== page.name) out.push(`Renamed page to “${page.name}”`);
    const beforeIds = new Map(bp.sections.map((s) => [s.id, s]));
    for (const s of page.sections) {
      if (!beforeIds.has(s.id)) out.push(`Added ${s.type} section on “${page.name}”`);
      else if (JSON.stringify(beforeIds.get(s.id)) !== JSON.stringify(s)) out.push(`Edited the ${s.type} section (“${s.title}”)`);
    }
    for (const s of bp.sections) if (!page.sections.some((x) => x.id === s.id)) out.push(`Removed the ${s.type} section (“${s.title}”)`);
  }
  for (const p of before.pages) if (!after.pages.some((ap) => ap.id === p.id)) out.push(`Removed page “${p.name}”`);
  return out.slice(0, 9);
}

// ------------------------------------------------------------------ panel group

/** Collapsible settings group used across the Studio rail. */
export function PanelGroup({
  title, icon, defaultOpen = false, count, children, action,
}: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  count?: number;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border border-border/60">
        <div className="flex items-stretch">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-l-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
              aria-expanded={open}
            >
              <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {icon}
                {title}
                {typeof count === "number" && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium normal-case">{count}</span>}
              </span>
              <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
            </button>
          </CollapsibleTrigger>
          {action && <span className="flex shrink-0 items-center pr-1.5">{action}</span>}
        </div>
        {open && <div className="space-y-3 border-t border-border/40 px-3 pb-3 pt-3">{children}</div>}
      </div>
    </Collapsible>
  );
}

// ------------------------------------------------------------------ library prefs (favorites + recents)

export type LibraryKind = "font" | "palette" | "motion";
export interface LibraryPrefs {
  fav: Record<LibraryKind, string[]>;
  recent: Record<LibraryKind, string[]>;
}
export interface LibraryPrefsApi {
  prefs: LibraryPrefs;
  toggleFav: (kind: LibraryKind, id: string) => void;
  pushRecent: (kind: LibraryKind, id: string) => void;
}

const LIB_PREFS_KEY = "bean:ws-library-prefs";
const EMPTY_PREFS: LibraryPrefs = { fav: { font: [], palette: [], motion: [] }, recent: { font: [], palette: [], motion: [] } };

function readLibraryPrefs(): LibraryPrefs {
  if (typeof window === "undefined") return EMPTY_PREFS;
  try {
    const raw = window.localStorage.getItem(LIB_PREFS_KEY);
    if (!raw) return EMPTY_PREFS;
    const p = JSON.parse(raw) as LibraryPrefs;
    return {
      fav: { font: p.fav?.font ?? [], palette: p.fav?.palette ?? [], motion: p.fav?.motion ?? [] },
      recent: { font: p.recent?.font ?? [], palette: p.recent?.palette ?? [], motion: p.recent?.motion ?? [] },
    };
  } catch {
    return EMPTY_PREFS;
  }
}

export function useLibraryPrefs(): LibraryPrefsApi {
  const [prefs, setPrefs] = useState<LibraryPrefs>(readLibraryPrefs);
  const update = (fn: (p: LibraryPrefs) => LibraryPrefs) => {
    setPrefs((prev) => {
      const next = fn(prev);
      try {
        window.localStorage.setItem(LIB_PREFS_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };
  const toggleFav = (kind: LibraryKind, id: string) =>
    update((p) => ({
      ...p,
      fav: { ...p.fav, [kind]: p.fav[kind].includes(id) ? p.fav[kind].filter((x) => x !== id) : [...p.fav[kind], id] },
    }));
  const pushRecent = (kind: LibraryKind, id: string) =>
    update((p) => ({
      ...p,
      recent: { ...p.recent, [kind]: [id, ...p.recent[kind].filter((x) => x !== id)].slice(0, 6) },
    }));
  return { prefs, toggleFav, pushRecent };
}

export function FavStar({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className={cn("shrink-0 rounded p-0.5 transition-colors", active ? "text-primary" : "text-muted-foreground/50 hover:text-foreground")}
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Star className={cn("size-3.5", active && "fill-current")} aria-hidden />
    </button>
  );
}

/** Div-based list row acting as a button — safe to contain the FavStar button
 * (a real <button> may never nest inside another <button>). */
export function RowButton({
  selected, onClick, children, ariaLabel,
}: {
  selected?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary",
        selected && "bg-gold-soft/50"
      )}
    >
      {children}
    </div>
  );
}

/** Search + category filter bar shared by the font/palette/motion libraries. */
export function LibraryFilter({
  query, onQuery, category, onCategory, categories, categoryLabel, placeholder,
}: {
  query: string;
  onQuery: (v: string) => void;
  category: string;
  onCategory: (v: string) => void;
  categories: string[];
  categoryLabel: string;
  placeholder: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder={placeholder} className="h-7 pl-7 text-xs" aria-label={placeholder} />
      </div>
      <Select value={category} onValueChange={onCategory}>
        <SelectTrigger size="sm" className="h-7 w-[110px] text-xs" aria-label={categoryLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          <SelectItem value="favorites">Favorites</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c} value={c}>{c}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ------------------------------------------------------------------ font picker

export type FontRole = "headingFont" | "bodyFont" | "accentFont" | "codeFont" | "navFont" | "buttonFont";

/** Font picker with live specimen, search, category filter and favorites. */
export function FontSelect({
  id, label, value, onChange, fav, recent, onToggleFav, onPick,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (id: string) => void;
  fav: string[];
  recent: string[];
  onToggleFav: (id: string) => void;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [open, setOpen] = useState(false);
  const current = resolveFont(value);
  const categories = fontCategoryList();

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SITE_FONTS.filter((f) => {
      if (category === "favorites" && !fav.includes(f.id)) return false;
      if (category !== "all" && category !== "favorites" && f.category !== category) return false;
      if (!q) return true;
      return f.family.toLowerCase().includes(q) || f.category.toLowerCase().includes(q) || f.blurb.toLowerCase().includes(q);
    });
  }, [query, category, fav]);

  const ordered = useMemo(() => {
    const rank = (fId: string) => (fav.includes(fId) ? 0 : recent.includes(fId) ? 1 : 2);
    return [...list].sort((a, b) => rank(a.id) - rank(b.id));
  }, [list, fav, recent]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm transition-colors hover:bg-accent/40"
          aria-label={`${label}: ${current.family}`}
        >
          <span className="min-w-0 truncate" style={{ fontFamily: fontStack(current.id) }}>
            {current.family}
          </span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{current.category}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[300px] space-y-2 p-2">
        <LibraryFilter
          query={query} onQuery={setQuery}
          category={category} onCategory={setCategory}
          categories={categories} categoryLabel={`${label} category`}
          placeholder="Search fonts…"
        />
        <ul className="max-h-72 space-y-0.5 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
          {ordered.length === 0 && <li className="px-2 py-4 text-center text-xs text-muted-foreground">No fonts match.</li>}
          {ordered.map((f) => (
            <li key={f.id}>
              <RowButton
                selected={f.id === value}
                ariaLabel={`Use ${f.family} (${f.category})`}
                onClick={() => {
                  onChange(f.id);
                  onPick(f.id);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm leading-tight" style={{ fontFamily: fontStack(f.id) }}>
                    {f.family}
                  </span>
                  <span className="block truncate text-[10px] leading-tight text-muted-foreground">{f.blurb}</span>
                </span>
                <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/70">{f.weights.length}w</span>
                <FavStar active={fav.includes(f.id)} onClick={() => onToggleFav(f.id)} label={`${fav.includes(f.id) ? "Remove" : "Add"} ${f.family} ${fav.includes(f.id) ? "from" : "to"} favorites`} />
              </RowButton>
            </li>
          ))}
        </ul>
        <p className="px-1 text-[10px] text-muted-foreground">{ordered.length} of {SITE_FONTS.length} fonts · weights are loaded per selection only</p>
      </PopoverContent>
    </Popover>
  );
}

// ------------------------------------------------------------------ motion picker

/** Animation preset picker (reveal scope) with search, categories, favorites. */
export function MotionPicker({
  id, label, value, onChange, fav, recent, onToggleFav, onPick, allowInherit,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (id: string) => void;
  fav: string[];
  recent: string[];
  onToggleFav: (id: string) => void;
  onPick: (id: string) => void;
  allowInherit?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [open, setOpen] = useState(false);
  const current = getMotionPreset(value);
  const categories = motionCategoryList();
  const reveal = motionPresetsByScope("reveal");

  const list = reveal.filter((p) => {
    if (category === "favorites" && !fav.includes(p.id)) return false;
    if (category !== "all" && category !== "favorites" && p.category !== category) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return p.label.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.category.toLowerCase().includes(q);
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm transition-colors hover:bg-accent/40"
          aria-label={`${label}: ${allowInherit && value === "__inherit" ? "Inherit site motion" : current?.label ?? value}`}
        >
          <span className="min-w-0 truncate">{allowInherit && value === "__inherit" ? "Inherit site motion" : current?.label ?? value}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{allowInherit && value === "__inherit" ? "" : current?.category}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] space-y-2 p-2">
        <LibraryFilter
          query={query} onQuery={setQuery}
          category={category} onCategory={setCategory}
          categories={categories} categoryLabel={`${label} category`}
          placeholder="Search presets…"
        />
        <ul className="max-h-72 space-y-0.5 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
          {allowInherit && (
            <li>
              <button
                type="button"
                className={cn("flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent", value === "__inherit" && "bg-gold-soft/50")}
                onClick={() => {
                  onChange("__inherit");
                  setOpen(false);
                }}
              >
                Inherit site motion
              </button>
            </li>
          )}
          {list.map((p) => (
            <li key={p.id}>
              <RowButton
                selected={p.id === value}
                ariaLabel={`Use ${p.label} — ${p.description}`}
                onClick={() => {
                  onChange(p.id);
                  onPick(p.id);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm leading-tight">{p.label}</span>
                  <span className="block truncate text-[10px] leading-tight text-muted-foreground">{p.description}</span>
                </span>
                <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/70">{p.category.split(" ")[0]}</span>
                <FavStar active={fav.includes(p.id)} onClick={() => onToggleFav(p.id)} label={`${fav.includes(p.id) ? "Remove" : "Add"} ${p.label} ${fav.includes(p.id) ? "from" : "to"} favorites`} />
              </RowButton>
            </li>
          ))}
        </ul>
        <p className="px-1 text-[10px] text-muted-foreground">{list.length} of {reveal.length} reveal presets · every preset has its own real motion implementation</p>
      </PopoverContent>
    </Popover>
  );
}

// ------------------------------------------------------------------ contrast readout

/** Live WCAG contrast readout with a one-click readable suggestion. */
export function ContrastRow({ label, fg, bg, onFix }: { label: string; fg: string; bg: string; onFix?: (color: string) => void }) {
  const ratio = contrastRatio(fg, bg);
  const pass = ratio >= 4.5;
  const largePass = ratio >= 3;
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Contrast className="size-3.5" aria-hidden /> {label}
      </span>
      <span className="flex items-center gap-1.5">
        <span className={cn("font-mono", pass ? "text-emerald-600 dark:text-emerald-400" : largePass ? "text-amber-600 dark:text-amber-400" : "text-destructive")}>
          {ratio.toFixed(2)}:1 {pass ? "AA" : largePass ? "AA-Large" : "Fail"}
        </span>
        {!pass && onFix && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => onFix(readableTextOn(bg, ["#ffffff", "#000000"]))}>
            Fix
          </Button>
        )}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ palette library

/** Color-system library: search + category filter + favorites; applies color tokens only. */
export function PaletteLibrary({
  onApply, fav, recent, onToggleFav,
}: {
  onApply: (id: string) => void;
  fav: string[];
  recent: string[];
  onToggleFav: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const categories = paletteCategories();
  const list = PALETTES.filter((p) => {
    if (category === "favorites" && !fav.includes(p.id)) return false;
    if (category !== "all" && category !== "favorites" && p.category !== category) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return p.label.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.category.toLowerCase().includes(q);
  });
  const ordered = useMemo(() => {
    const rank = (id: string) => (fav.includes(id) ? 0 : recent.includes(id) ? 1 : 2);
    return [...list].sort((a, b) => rank(a.id) - rank(b.id));
  }, [list, fav, recent]);

  return (
    <PanelGroup title="Color systems" icon={<Palette className="size-3.5" aria-hidden />} count={PALETTES.length}>
      <p className="text-[11px] text-muted-foreground">Complete semantic palettes — they change color tokens only, never your typography, layout or motion.</p>
      <LibraryFilter
        query={query} onQuery={setQuery}
        category={category} onCategory={setCategory}
        categories={categories} categoryLabel="Palette category"
        placeholder="Search palettes…"
      />
      <div className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto pr-0.5" style={{ scrollbarWidth: "thin" }}>
        {ordered.length === 0 && <p className="col-span-2 py-4 text-center text-xs text-muted-foreground">No palettes match.</p>}
        {ordered.map((p) => (
          <RowButton
            key={p.id}
            ariaLabel={`Apply ${p.label} color system`}
            onClick={() => onApply(p.id)}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center justify-between gap-1">
                <span className="flex gap-0.5" aria-hidden>
                  {[p.tokens.background, p.tokens.surface, p.tokens.accent, p.tokens.accent2, p.tokens.foreground].map((c, i) => (
                    <span key={i} className="size-3 rounded-full border border-border/50" style={{ background: c }} />
                  ))}
                </span>
                <FavStar active={fav.includes(p.id)} onClick={() => onToggleFav(p.id)} label={`${fav.includes(p.id) ? "Remove" : "Add"} ${p.label} ${fav.includes(p.id) ? "from" : "to"} favorites`} />
              </span>
              <span className="mt-1 block truncate text-[11px] font-medium leading-tight">{p.label}</span>
              <span className="mt-0.5 block truncate text-[9px] uppercase tracking-wide text-muted-foreground">{p.category} · {p.dark ? "dark" : "light"}</span>
            </span>
          </RowButton>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground">{ordered.length} of {PALETTES.length} color systems · favorites and recents sort first</p>
    </PanelGroup>
  );
}
