"use client";

/**
 * TemplateGallery — the studio's COMPLETE-website-template picker.
 *
 * Renders the 54-template style library (STYLE_TEMPLATE_IDS) organized into
 * the 15 TEMPLATE_CATEGORY_IDS collections as collapsible groups, plus a
 * search box. Each card shows a REAL mini visual preview built from the
 * template's own theme tokens AND its structural swatch layout (a pure-CSS
 * composition — no images, no screenshots), plus the template label,
 * collection, one-line description and Apply / Live preview / Revert actions.
 *
 * This section contains ONLY complete website templates — a template is one
 * whole design (structure, layout, section arrangement, visual style, color
 * treatment, typography configuration, responsive behavior). Individual
 * fonts, animations, hover effects, motion presets and color presets
 * deliberately live in their own Customization panels (Typography / Motion /
 * Colors), never here.
 *
 * Brand styling: dark cards, champagne (#e8bc51) accent, rounded-lg, hover
 * lift. No indigo/blue anywhere.
 */

import { useMemo, useState, type CSSProperties } from "react";
import { ChevronDown, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  STYLE_TEMPLATE_IDS,
  STYLE_TEMPLATE_META,
  TEMPLATE_CATEGORY_IDS,
  TEMPLATE_CATEGORY_LABELS,
  deriveTheme,
  templatePresets,
  type ResolvedTheme,
  type StyleTemplateId,
  type TemplateCategoryId,
  type TemplatePreset,
  type TemplateSwatchLayout,
} from "@/lib/site-config";
import { cn } from "@/lib/utils";

export interface TemplateGalleryProps {
  /** Template id currently applied to the site (drives the "Applied" state). */
  currentTemplateId?: string;
  /** Called with the template id when the user applies a template. */
  onApply: (id: string) => void;
  /** Optional live-preview callback (the parent opens the iframe preview dialog). */
  onPreview?: (id: string) => void;
  /** Reverts the APPLIED template back to its own design defaults
   * (theme + motion) while keeping all user content. Only shown on the
   * applied card — there is nothing to design-reset elsewhere. */
  onRevert?: () => void;
  /** Disables all card actions (e.g. while an apply/save request is in flight). */
  disabled?: boolean;
}

/** Hex → rgba() string, for glass tints and translucent borders in the swatch. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const SWATCH_RADIUS: Record<ResolvedTheme["radius"], string> = {
  none: "2px",
  md: "6px",
  full: "12px",
};

const RATIO_HEIGHT: Record<ResolvedTheme["imageRatio"], string> = {
  "16/9": "1.5rem",
  "3/2": "1.75rem",
  "4/3": "2rem",
  "1/1": "2.5rem",
};

/**
 * Abstract layout swatch rendered purely from the template's theme tokens AND
 * its structural layout hint: masthead + hero arrangement + content blocks
 * that genuinely differ per TEMPLATE_SWATCH_LAYOUTS value, so a masonry
 * gallery template never previews like a list-index template even when their
 * palettes are similar. Geometry reacts to radius / columns / imageRatio /
 * headingAlign / navLayout / glass / density.
 */
function TemplateSwatch({ theme, layout }: { theme: ResolvedTheme; layout: TemplateSwatchLayout }) {
  const radius = SWATCH_RADIUS[theme.radius];
  const blockHeight = RATIO_HEIGHT[theme.imageRatio];
  const glass = theme.glass?.enabled ? theme.glass : null;
  const centered = theme.headingAlign === "center";
  const compact = theme.density === "compact";

  const bar = (w: string, color: string, h = "0.375rem", extra?: CSSProperties): CSSProperties => ({
    width: w,
    height: h,
    background: color,
    borderRadius: "9999px",
    marginLeft: centered ? "auto" : undefined,
    marginRight: centered ? "auto" : undefined,
    ...extra,
  });

  const blockStyle: CSSProperties = glass
    ? {
        background: withAlpha(glass.tint, glass.opacity / 100),
        border: `${glass.borderWidth}px solid ${withAlpha(theme.border, glass.borderOpacity / 100)}`,
        borderRadius: radius,
        boxShadow: `0 6px 18px ${withAlpha("#000000", glass.shadow / 220)}, inset 0 1px 0 ${withAlpha("#ffffff", glass.highlight / 260)}`,
        backdropFilter: `blur(${Math.min(glass.blur, 40) / 2}px)`,
      }
    : {
        background: withAlpha(theme.surface, theme.surfaceOpacity / 100),
        border: `1px solid ${theme.border}`,
        borderRadius: radius,
      };

  const linkDash = (accent: boolean): CSSProperties => ({
    width: "0.75rem",
    height: "0.25rem",
    borderRadius: "9999px",
    background: accent ? theme.accent : withAlpha(theme.foreground, 0.35),
  });

  const headline = (align: "left" | "center" = centered ? "center" : "left") => (
    <div className={cn("flex flex-col gap-1", align === "center" && "items-center")}>
      <span style={bar("62%", theme.foreground, "0.55rem")} />
      <span style={bar("38%", theme.foreground, "0.55rem", { opacity: 0.75 })} />
      <span style={bar("22%", theme.accent, "0.2rem", { marginTop: "0.1rem" })} />
    </div>
  );

  const masthead = (
    <div className={cn("flex items-center justify-between gap-2 px-3 pt-2.5", theme.navLayout !== "inline" && "flex-col items-stretch")}>
      <span style={{ ...bar("1.75rem", withAlpha(theme.foreground, 0.9), "0.375rem"), marginLeft: theme.navLayout !== "inline" ? "auto" : undefined, marginRight: theme.navLayout !== "inline" ? "auto" : undefined }} />
      <span className={cn("flex items-center gap-1", theme.navLayout === "centered" && "justify-center")}>
        <i style={linkDash(false)} />
        <i style={linkDash(false)} />
        <i style={linkDash(true)} />
      </span>
    </div>
  );

  // Per-layout content compositions — genuinely different structures.
  let content: React.ReactNode;
  switch (layout) {
    case "featured":
      content = (
        <>
          <div className="px-3 pt-3">{headline()}</div>
          <div className="flex gap-1.5 px-3 pb-3 pt-2.5">
            <span className="block flex-[2]" style={{ ...blockStyle, height: blockHeight }} />
            <div className="flex flex-1 flex-col gap-1.5">
              <span className="block flex-1" style={{ ...blockStyle, opacity: 0.8 }} />
              <span className="block flex-1" style={{ ...blockStyle, opacity: 0.65 }} />
            </div>
          </div>
        </>
      );
      break;
    case "list":
      content = (
        <>
          <div className="px-3 pt-3">{headline()}</div>
          <div className="flex flex-col gap-1 px-3 pb-3 pt-2.5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-1.5" style={{ opacity: 1 - i * 0.14 }}>
                <span style={{ ...bar("18%", theme.accent, "0.2rem") }} />
                <span style={{ ...bar(`${68 - i * 6}%`, withAlpha(theme.foreground, 0.5), "0.25rem") }} />
              </div>
            ))}
          </div>
        </>
      );
      break;
    case "masonry": {
      const heights = compact ? ["1.5rem", "2.25rem", "1.9rem"] : ["1.75rem", "2.6rem", "2.1rem"];
      content = (
        <>
          <div className="px-3 pt-3">{headline()}</div>
          <div className="flex gap-1.5 px-3 pb-3 pt-2.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-1 flex-col gap-1.5">
                <span className="block" style={{ ...blockStyle, height: heights[i] }} />
                <span className="block" style={{ ...blockStyle, height: heights[(i + 1) % 3], opacity: 0.75 }} />
              </div>
            ))}
          </div>
        </>
      );
      break;
    }
    case "strip":
      content = (
        <>
          <div className="px-3 pt-3">{headline()}</div>
          <div className="flex flex-col gap-1.5 px-3 pb-3 pt-2.5">
            <span className="block w-full" style={{ ...blockStyle, height: "1.9rem" }} />
            <div className="flex gap-1.5">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="block flex-1" style={{ ...blockStyle, height: "1rem", opacity: 1 - i * 0.15 }} />
              ))}
            </div>
          </div>
        </>
      );
      break;
    case "editorial":
      content = (
        <div className="flex gap-2 px-3 pb-3 pt-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <span style={bar("88%", theme.foreground, "0.55rem")} />
            <span style={bar("70%", theme.foreground, "0.4rem", { opacity: 0.7 })} />
            <span style={bar("82%", withAlpha(theme.foreground, 0.35), "0.25rem")} />
            <span style={bar("76%", withAlpha(theme.foreground, 0.35), "0.25rem")} />
            <span style={bar("34%", theme.accent, "0.2rem", { marginTop: "0.15rem" })} />
          </div>
          <span className="block flex-1" style={{ ...blockStyle, height: "3.4rem" }} />
        </div>
      );
      break;
    case "split":
      content = (
        <div className="flex items-stretch gap-2 px-3 pb-3 pt-3">
          <div className="flex flex-1 flex-col justify-center gap-1.5">
            <span style={bar("92%", theme.foreground, "0.55rem")} />
            <span style={bar("64%", theme.foreground, "0.55rem", { opacity: 0.75 })} />
            <span style={bar("40%", theme.accent, "0.2rem", { marginTop: "0.15rem" })} />
          </div>
          <span className="block flex-1" style={{ ...blockStyle, height: "3.2rem" }} />
        </div>
      );
      break;
    case "cover":
      content = (
        <>
          <div className="px-3 pt-2.5">{headline("center")}</div>
          <div className="px-3 pb-3 pt-2">
            <span className="block w-full" style={{ ...blockStyle, height: "3.1rem" }} />
          </div>
        </>
      );
      break;
    case "timeline":
      content = (
        <>
          <div className="px-3 pt-3">{headline()}</div>
          <div className="flex gap-1.5 px-3 pb-3 pt-2.5">
            <div className="flex flex-col items-center gap-1 pt-0.5" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span key={i} className="flex flex-col items-center gap-1">
                  <i className="block size-1.5 rounded-full" style={{ background: i === 0 ? theme.accent : withAlpha(theme.foreground, 0.4) }} />
                  {i < 2 && <i className="block w-px flex-1" style={{ background: withAlpha(theme.foreground, 0.3), minHeight: "0.55rem" }} />}
                </span>
              ))}
            </div>
            <div className="flex flex-1 flex-col gap-1.5 pt-0.5">
              {[0, 1, 2].map((i) => (
                <span key={i} style={{ ...bar(`${74 - i * 10}%`, withAlpha(theme.foreground, 0.5 - i * 0.08), "0.25rem") }} />
              ))}
            </div>
          </div>
        </>
      );
      break;
    case "centered":
      content = (
        <>
          <div className="px-3 pt-3">{headline("center")}</div>
          <div className="flex justify-center gap-1.5 px-3 pb-3 pt-2.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="block w-1/4" style={{ ...blockStyle, height: blockHeight, opacity: i === 1 ? 1 : 0.78 }} />
            ))}
          </div>
        </>
      );
      break;
    case "grid":
    default: {
      const blockCount = theme.columns === 2 ? 2 : 3;
      content = (
        <>
          <div className="px-3 pt-3">{headline()}</div>
          <div className={cn("grid gap-1.5 px-3 pb-3 pt-2.5", blockCount === 2 ? "grid-cols-2" : "grid-cols-3")}>
            {Array.from({ length: blockCount }).map((_, i) => (
              <span key={i} className="block" style={{ ...blockStyle, height: blockHeight, opacity: i === 0 ? 1 : 0.82 }} />
            ))}
          </div>
        </>
      );
    }
  }

  return (
    <div
      aria-hidden="true"
      className="relative overflow-hidden rounded-md border"
      style={{
        background: theme.gradient
          ? `linear-gradient(${theme.gradient.angle}deg, ${theme.gradient.from}, ${theme.gradient.to})`
          : theme.background,
        borderColor: theme.border,
      }}
    >
      {masthead}
      {content}
    </div>
  );
}

interface GalleryCard {
  preset: TemplatePreset;
  theme: ResolvedTheme;
  category: TemplateCategoryId;
  swatch: TemplateSwatchLayout;
}

export function TemplateGallery({
  currentTemplateId,
  onApply,
  onPreview,
  onRevert,
  disabled = false,
}: TemplateGalleryProps) {
  const [query, setQuery] = useState("");
  // The applied template's collection starts expanded; the first collection is
  // the fallback (applied id is known at mount — the rail renders the gallery
  // only after the config loads).
  const [openCategories, setOpenCategories] = useState<Set<TemplateCategoryId>>(
    () => new Set([STYLE_TEMPLATE_META[currentTemplateId as StyleTemplateId]?.category ?? "minimal-clean"])
  );

  const cards = useMemo<GalleryCard[]>(() => {
    const all = templatePresets();
    return STYLE_TEMPLATE_IDS.map((id) => {
      const preset = all.find((t) => t.id === id);
      if (!preset) return null;
      const meta = STYLE_TEMPLATE_META[id];
      return { preset, theme: deriveTheme(preset.theme), category: meta.category, swatch: meta.swatch };
    }).filter((c): c is GalleryCard => Boolean(c));
  }, []);

  const searching = query.trim().length > 0;
  const q = query.trim().toLowerCase();

  const searchMatches = useMemo(() => {
    if (!searching) return [];
    return cards.filter(
      (c) =>
        c.preset.label.toLowerCase().includes(q) ||
        c.preset.description.toLowerCase().includes(q) ||
        TEMPLATE_CATEGORY_LABELS[c.category].toLowerCase().includes(q)
    );
  }, [cards, q, searching]);

  function toggleCategory(id: TemplateCategoryId) {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const renderCard = ({ preset: t, theme, category, swatch }: GalleryCard) => {
    const active = t.id === currentTemplateId;
    return (
      <li
        key={t.id}
        data-template-id={t.id}
        className={cn(
          "group flex flex-col overflow-hidden rounded-lg border bg-[#141519] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/30",
          active ? "border-[#e8bc51] ring-2 ring-[#e8bc51]/70" : "border-[#26272c] hover:border-[#3a3b41]"
        )}
      >
        <div className="p-3 pb-0">
          <TemplateSwatch theme={theme} layout={swatch} />
        </div>

        <div className="flex flex-1 flex-col gap-1.5 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-[#f2efe8]">{t.label}</h3>
            {active && (
              <Badge className="border-none bg-[#e8bc51] text-[#1c1408] hover:bg-[#e8bc51]">Applied</Badge>
            )}
          </div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-[#8a8578]">{TEMPLATE_CATEGORY_LABELS[category]}</p>
          <p className="text-xs leading-relaxed text-[#a3a09a]">{t.description}</p>
          <p className="text-[10px] leading-snug text-[#6f6c66]">
            Complete website design · structure, colors, typography, motion · works on desktop, tablet and mobile ·
            your content is preserved
          </p>
        </div>

        <div className="mt-auto flex items-center gap-2 border-t border-[#26272c] p-3">
          <Button
            size="sm"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onApply(t.id)}
            className={cn(
              "flex-1",
              active
                ? "border border-[#e8bc51]/60 bg-transparent text-[#e8bc51] hover:bg-[#e8bc51]/10"
                : "bg-[#e8bc51] text-[#1c1408] hover:bg-[#f0cf87]"
            )}
          >
            {active ? "Applied" : "Apply"}
          </Button>
          {onPreview ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onPreview(t.id)}
              className="text-[#cfc9bd] hover:bg-white/5 hover:text-[#f2efe8]"
            >
              Live preview
            </Button>
          ) : null}
          {active && onRevert ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={onRevert}
              title="Reset this template's design (colors, fonts, motion) back to its defaults — your content stays"
              className="text-[#cfc9bd] hover:bg-white/5 hover:text-[#f2efe8]"
            >
              Revert
            </Button>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-2.5" aria-label="Complete website templates">
      {/* search + count */}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[#6f6c66]" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search 54 templates…"
            aria-label="Search website templates"
            className="h-8 border-[#26272c] bg-[#101114] pl-7 text-xs text-[#f2efe8] placeholder:text-[#6f6c66]"
          />
          {searching && (
            <button
              type="button"
              aria-label="Clear template search"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[#6f6c66] hover:text-[#f2efe8]"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {searching ? (
        <div className="space-y-2">
          <p className="text-[11px] text-[#8a8578]" role="status">
            {searchMatches.length} {searchMatches.length === 1 ? "template" : "templates"} match “{query.trim()}”
          </p>
          {searchMatches.length === 0 ? (
            <p className="rounded-md border border-[#26272c] bg-[#101114] p-3 text-xs text-[#a3a09a]">
              No template matches that name — try “minimal”, “dark”, “glass”, “film”…
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-4">{searchMatches.map(renderCard)}</ul>
          )}
        </div>
      ) : (
        /* collection groups */
        <div className="space-y-1.5">
          {TEMPLATE_CATEGORY_IDS.map((catId) => {
            const group = cards.filter((c) => c.category === catId);
            if (group.length === 0) return null;
            const open = openCategories.has(catId);
            const hasApplied = group.some((c) => c.preset.id === currentTemplateId);
            return (
              <div key={catId} className="overflow-hidden rounded-lg border border-[#26272c] bg-[#101114]">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggleCategory(catId)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/5",
                    hasApplied && "text-[#e8bc51]"
                  )}
                >
                  <ChevronDown className={cn("size-3.5 shrink-0 text-[#6f6c66] transition-transform", open && "rotate-180")} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[#f2efe8]">
                    {TEMPLATE_CATEGORY_LABELS[catId]}
                  </span>
                  {hasApplied && <span className="size-1.5 shrink-0 rounded-full bg-[#e8bc51]" aria-label="Applied template in this collection" />}
                  <span className="shrink-0 text-[10px] text-[#6f6c66]">{group.length}</span>
                </button>
                {open && (
                  <ul className="grid grid-cols-1 gap-4 border-t border-[#26272c] p-2.5">{group.map(renderCard)}</ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default TemplateGallery;
