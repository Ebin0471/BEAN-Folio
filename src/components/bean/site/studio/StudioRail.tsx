"use client";

/**
 * StudioRail — the right zone: an organized, scrollable panel of collapsible
 * groups holding the REAL design controls regrouped from the old
 * Design/Content tabs. Every control is wired to the same mutation functions
 * the builder always used (updateTheme/applyPalette/applyFont/
 * applyMotionPreset/applyTemplate/applyDesignPreset/section CRUD) — this is a
 * REORGANIZATION, not a behavior change.
 *
 * Groups: Templates (sibling-built TemplateGallery) · Colors · Typography ·
 * Layout & sections (pages + sections + per-section editor) · Motion ·
 * Presentation (identity, logo, buttons/links, glass, presets, attribution).
 */

import { useMemo, useRef } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  Layers,
  Loader2,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Star,
  Trash2,
  Type as TypeIcon,
  Wand2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateGallery } from "./TemplateGallery";
import { SectionEditor } from "./SectionEditor";
import {
  ContrastRow,
  FontSelect,
  MotionPicker,
  PaletteLibrary,
  PanelGroup,
  SECTION_TYPE_LABELS,
  SectionSummary,
  type FontRole,
  type LibraryPrefsApi,
} from "./controls";
import {
  applyGlassPreset,
  designPresets,
  GLASS_PRESETS,
  mixHex,
  siteLogoSrc,
  type SiteConfig,
  type SiteGlass,
  type SitePage,
  type SiteSection,
  type SiteSectionType,
  type SiteTheme,
  type GlassPresetId,
} from "@/lib/site-config";
import { SITE_FONTS } from "@/lib/site-fonts";
import { getMotionPreset, motionPresetsByScope } from "@/lib/site-motion";
import { cn } from "@/lib/utils";
export interface StudioRailProps {
  config: SiteConfig;
  activePage: SitePage | null;
  activePageId: string;
  selectedSectionId: string | null;
  categoryOptions: string[];
  logoUploading: boolean;
  watermark: boolean;
  disabled?: boolean;
  libraryPrefs: LibraryPrefsApi;
  /** A template apply is undoable (a pre-apply snapshot exists). */
  canRevertLastApply?: boolean;
  /** Restores the exact pre-apply state of the most recent template apply. */
  onRevertLastApply?: () => void;

  onSelectPage: (id: string) => void;
  onSelectSection: (id: string | null) => void;

  updateTheme: (patch: Partial<SiteTheme>) => void;
  updateMotion: (patch: Partial<SiteConfig["motion"]>) => void;
  updateGlass: (patch: Partial<SiteGlass>) => void;
  setPerformanceMode: (on: boolean) => void;

  applyPalette: (id: string) => void;
  applyFont: (role: FontRole, id: string) => void;
  applyMotionPreset: (id: string) => void;
  applyTemplate: (id: SiteConfig["template"]) => void;
  previewTemplate: (id: string) => void;
  applyDesignPreset: (id: string) => void;
  resetToTemplateDefaults: () => void;

  addPage: () => void;
  duplicatePage: (id: string) => void;
  removePage: (id: string) => void;
  movePage: (id: string, dir: -1 | 1) => void;
  renamePage: (id: string, name: string) => void;
  togglePageVisible: (id: string) => void;

  addSection: (type: SiteSectionType) => void;
  duplicateSection: (id: string) => void;
  removeSection: (id: string) => void;
  moveSection: (id: string, dir: -1 | 1) => void;
  updateSection: (id: string, patch: Partial<SiteSection>) => void;

  onTaglineChange: (v: string) => void;
  onLogoUpload: (file: File) => void;
  onBeanLogo: () => void;
  onRemoveLogo: () => void;
  onWatermarkChange: (v: boolean) => void;
}

export function StudioRail(props: StudioRailProps) {
  const {
    config, activePage, activePageId, selectedSectionId, categoryOptions, logoUploading,
    watermark, disabled = false, libraryPrefs, canRevertLastApply = false, onRevertLastApply,
  } = props;

  const logoFileRef = useRef<HTMLInputElement>(null);
  const glassEnabled = Boolean(config.theme.glass?.enabled);

  const selectedSection: SiteSection | null =
    activePage?.sections.find((s) => s.id === selectedSectionId) ?? null;

  const motionRevealCount = useMemo(() => motionPresetsByScope("reveal").length, []);

  return (
    <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 pb-8 pt-3" style={{ scrollbarWidth: "thin" }}>
      {/* ---------------- 1. Templates — COMPLETE website templates only. Fonts,
          animations and color systems live in their own sections below. ------ */}
      <PanelGroup title="Templates" icon={<Layers className="size-3.5" aria-hidden />} defaultOpen>
        <p className="text-[11px] text-muted-foreground">
          Complete website templates — each one is a whole design: structure, section arrangement, colors, typography,
          motion and responsive behavior. Preview live, then apply; your content is always kept. Individual fonts,
          animations and color systems live in their own sections below.
        </p>
        {/* Template apply undo — the REAL revert path for any applied template:
            restores the exact pre-apply state (design AND section layout). */}
        {canRevertLastApply && onRevertLastApply && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full"
            disabled={disabled}
            onClick={onRevertLastApply}
            title="Undo the most recent template apply — restores the exact design and layout from before it (your content is kept either way)"
          >
            <RotateCcw className="size-4" aria-hidden /> Revert last apply
          </Button>
        )}
        {/* The gallery renders its collection groups one card per row — sized
            for this rail's width. */}
        <TemplateGallery
          currentTemplateId={config.template}
          onApply={(id) => props.applyTemplate(id as SiteConfig["template"])}
          onPreview={(id) => props.previewTemplate(id)}
          onRevert={props.resetToTemplateDefaults}
          disabled={disabled}
        />
      </PanelGroup>

      {/* ---------------- 2. Colors ---------------- */}
      <PaletteLibrary
        onApply={props.applyPalette}
        fav={libraryPrefs.prefs.fav.palette}
        recent={libraryPrefs.prefs.recent.palette}
        onToggleFav={(id) => libraryPrefs.toggleFav("palette", id)}
      />

      <PanelGroup title="Colors &amp; gradients" icon={<Palette className="size-3.5" aria-hidden />} defaultOpen>
        {(
          [
            { key: "background", label: "Background" },
            { key: "surface", label: "Cards" },
            { key: "foreground", label: "Text" },
            { key: "muted", label: "Secondary text" },
            { key: "accent", label: "Accent" },
            { key: "accent2", label: "Accent 2" },
            { key: "border", label: "Borders" },
            { key: "focus", label: "Focus ring" },
          ] as const
        ).map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-3">
            <Label htmlFor={`ws-${row.key}`} className="text-sm">
              {row.label}
            </Label>
            <div className="flex items-center gap-2">
              <input
                id={`ws-${row.key}`}
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(config.theme[row.key] ?? "") ? (config.theme[row.key] as string) : "#090a0c"}
                onChange={(e) => {
                  if (row.key === "background" && config.theme.gradient) {
                    // While a background gradient is active the gradient IS the
                    // page background — a solid Background pick would be
                    // invisible. Keep the user's gradient (never silently
                    // discard it) and apply the picked color to its dominant
                    // start color so the picker always affects the background.
                    props.updateTheme({ background: e.target.value, gradient: { ...config.theme.gradient, from: e.target.value } });
                    return;
                  }
                  props.updateTheme({ [row.key]: e.target.value } as Partial<SiteTheme>);
                }}
                className="size-8 cursor-pointer rounded border border-border/60 bg-transparent"
                aria-label={`${row.label} color`}
              />
              <span className="w-[68px] font-mono text-[11px] text-muted-foreground">{config.theme[row.key]}</span>
            </div>
          </div>
        ))}

        {/* background gradient */}
        <div className="rounded-md border border-border/50 p-2.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="ws-grad-on" className="text-sm">Background gradient</Label>
            <Switch
              id="ws-grad-on"
              checked={Boolean(config.theme.gradient)}
              onCheckedChange={(v) =>
                props.updateTheme({ gradient: v ? { from: config.theme.accent, to: config.theme.background, angle: 160 } : null })
              }
            />
          </div>
          {config.theme.gradient && (
            <div className="mt-2.5 space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="ws-grad-from" className="text-xs text-muted-foreground">From</Label>
                <input
                  id="ws-grad-from"
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(config.theme.gradient.from) ? config.theme.gradient.from : "#090a0c"}
                  onChange={(e) => props.updateTheme({ gradient: { ...(config.theme.gradient ?? { to: "#000", angle: 160 }), from: e.target.value } })}
                  className="size-7 cursor-pointer rounded border border-border/60 bg-transparent"
                  aria-label="Gradient start color"
                />
                <Label htmlFor="ws-grad-to" className="text-xs text-muted-foreground">To</Label>
                <input
                  id="ws-grad-to"
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(config.theme.gradient.to) ? config.theme.gradient.to : "#090a0c"}
                  onChange={(e) => props.updateTheme({ gradient: { ...(config.theme.gradient ?? { from: "#fff", angle: 160 }), to: e.target.value } })}
                  className="size-7 cursor-pointer rounded border border-border/60 bg-transparent"
                  aria-label="Gradient end color"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ws-grad-angle" className="text-xs">Angle · {config.theme.gradient.angle}°</Label>
                <Slider
                  id="ws-grad-angle"
                  value={[config.theme.gradient.angle]}
                  min={0}
                  max={360}
                  step={5}
                  onValueChange={(v) => props.updateTheme({ gradient: { ...(config.theme.gradient ?? { from: "#fff", to: "#000" }), angle: v[0] } })}
                />
              </div>
            </div>
          )}
        </div>

        {/* surface opacity */}
        <div className="space-y-1">
          <Label htmlFor="ws-surf-op" className="text-sm">Card surface opacity · {config.theme.surfaceOpacity}%</Label>
          <Slider
            id="ws-surf-op"
            value={[config.theme.surfaceOpacity]}
            min={20}
            max={100}
            step={5}
            onValueChange={(v) => props.updateTheme({ surfaceOpacity: v[0] })}
          />
          <p className="text-[11px] text-muted-foreground">Below 100% cards become translucent over the background.</p>
        </div>

        {/* contrast checks — live, with one-click fix */}
        <div className="space-y-1.5 rounded-md border border-border/50 p-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">Contrast (WCAG)</p>
          <ContrastRow
            label="Text on background"
            fg={config.theme.foreground}
            bg={config.theme.background}
            onFix={(c) => props.updateTheme({ foreground: c })}
          />
          <ContrastRow
            label="Accent on background"
            fg={config.theme.accent}
            bg={config.theme.background}
            onFix={(c) => props.updateTheme({ accent: c })}
          />
          <ContrastRow
            label="Secondary text on background"
            fg={config.theme.muted ?? mixHex(config.theme.foreground, config.theme.background, 0.42)}
            bg={config.theme.background}
            onFix={(c) => props.updateTheme({ muted: c })}
          />
        </div>
      </PanelGroup>

      {/* ---------------- 3. Typography ---------------- */}
      <PanelGroup title="Typography" icon={<TypeIcon className="size-3.5" aria-hidden />} count={SITE_FONTS.length}>
        <div className="space-y-1.5">
          <Label htmlFor="ws-hfont">Heading font</Label>
          <FontSelect
            id="ws-hfont"
            label="Heading font"
            value={config.theme.headingFont ?? config.theme.font}
            onChange={(id) => props.applyFont("headingFont", id)}
            fav={libraryPrefs.prefs.fav.font}
            recent={libraryPrefs.prefs.recent.font}
            onToggleFav={(id) => libraryPrefs.toggleFav("font", id)}
            onPick={() => undefined}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ws-bfont">Body font</Label>
          <FontSelect
            id="ws-bfont"
            label="Body font"
            value={config.theme.bodyFont ?? config.theme.font}
            onChange={(id) => props.applyFont("bodyFont", id)}
            fav={libraryPrefs.prefs.fav.font}
            recent={libraryPrefs.prefs.recent.font}
            onToggleFav={(id) => libraryPrefs.toggleFav("font", id)}
            onPick={() => undefined}
          />
        </div>
        <div className="grid grid-cols-1 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="ws-afont">Accent font <span className="text-[10px] text-muted-foreground">(labels, attributions)</span></Label>
            <FontSelect
              id="ws-afont"
              label="Accent font"
              value={config.theme.accentFont ?? config.theme.headingFont ?? config.theme.font}
              onChange={(id) => props.applyFont("accentFont", id)}
              fav={libraryPrefs.prefs.fav.font}
              recent={libraryPrefs.prefs.recent.font}
              onToggleFav={(id) => libraryPrefs.toggleFav("font", id)}
              onPick={() => undefined}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-cfont">Code font <span className="text-[10px] text-muted-foreground">(stats, handle, meta)</span></Label>
            <FontSelect
              id="ws-cfont"
              label="Code font"
              value={config.theme.codeFont ?? "geist-mono"}
              onChange={(id) => props.applyFont("codeFont", id)}
              fav={libraryPrefs.prefs.fav.font}
              recent={libraryPrefs.prefs.recent.font}
              onToggleFav={(id) => libraryPrefs.toggleFav("font", id)}
              onPick={() => undefined}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="ws-nfont">Navigation font <span className="text-[10px] text-muted-foreground">(masthead links)</span></Label>
            <FontSelect
              id="ws-nfont"
              label="Navigation font"
              value={config.theme.navFont ?? config.theme.bodyFont ?? config.theme.font}
              onChange={(id) => props.applyFont("navFont", id)}
              fav={libraryPrefs.prefs.fav.font}
              recent={libraryPrefs.prefs.recent.font}
              onToggleFav={(id) => libraryPrefs.toggleFav("font", id)}
              onPick={() => undefined}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-btfont">Button font <span className="text-[10px] text-muted-foreground">(every button)</span></Label>
            <FontSelect
              id="ws-btfont"
              label="Button font"
              value={config.theme.buttonFont ?? config.theme.bodyFont ?? config.theme.font}
              onChange={(id) => props.applyFont("buttonFont", id)}
              fav={libraryPrefs.prefs.fav.font}
              recent={libraryPrefs.prefs.recent.font}
              onToggleFav={(id) => libraryPrefs.toggleFav("font", id)}
              onPick={() => undefined}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="ws-scale">Type scale</Label>
            <Select value={config.theme.typeScale} onValueChange={(v) => props.updateTheme({ typeScale: v as SiteTheme["typeScale"] })}>
              <SelectTrigger id="ws-scale" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="intimate">Intimate</SelectItem>
                <SelectItem value="balanced">Balanced</SelectItem>
                <SelectItem value="grand">Grand</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-weight">Heading weight</Label>
            <Select value={config.theme.headingWeight} onValueChange={(v) => props.updateTheme({ headingWeight: v as SiteTheme["headingWeight"] })}>
              <SelectTrigger id="ws-weight" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="semibold">Semibold</SelectItem>
                <SelectItem value="bold">Bold</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-leading">Line height</Label>
            <Select value={config.theme.lineHeight} onValueChange={(v) => props.updateTheme({ lineHeight: v as SiteTheme["lineHeight"] })}>
              <SelectTrigger id="ws-leading" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="tight">Tight</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="relaxed">Relaxed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-tracking">Tracking</Label>
            <Select value={config.theme.letterSpacing} onValueChange={(v) => props.updateTheme({ letterSpacing: v as SiteTheme["letterSpacing"] })}>
              <SelectTrigger id="ws-tracking" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="tight">Tight</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="wide">Wide</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-halign">Heading alignment</Label>
            <Select value={config.theme.headingAlign} onValueChange={(v) => props.updateTheme({ headingAlign: v as SiteTheme["headingAlign"] })}>
              <SelectTrigger id="ws-halign" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="left">Left</SelectItem>
                <SelectItem value="center">Centered</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">Only the selected families are downloaded; the closest available weight is used when a family lacks one.</p>
      </PanelGroup>

      {/* ---------------- 4. Layout & sections ---------------- */}
      <PanelGroup title="Layout &amp; sections" icon={<Layers className="size-3.5" aria-hidden />} count={activePage?.sections.length}>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="ws-density">Spacing</Label>
            <Select value={config.theme.density} onValueChange={(v) => props.updateTheme({ density: v as SiteTheme["density"] })}>
              <SelectTrigger id="ws-density" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="compact">Compact</SelectItem>
                <SelectItem value="regular">Regular</SelectItem>
                <SelectItem value="relaxed">Relaxed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-width">Content width</Label>
            <Select value={config.theme.contentWidth} onValueChange={(v) => props.updateTheme({ contentWidth: v as SiteTheme["contentWidth"] })}>
              <SelectTrigger id="ws-width" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="narrow">Narrow</SelectItem>
                <SelectItem value="regular">Regular</SelectItem>
                <SelectItem value="wide">Wide</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-columns">Grid columns</Label>
            <Select value={String(config.theme.columns)} onValueChange={(v) => props.updateTheme({ columns: Number(v) as SiteTheme["columns"] })}>
              <SelectTrigger id="ws-columns" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Auto</SelectItem>
                <SelectItem value="2">2</SelectItem>
                <SelectItem value="3">3</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-radius">Corners</Label>
            <Select value={config.theme.radius} onValueChange={(v) => props.updateTheme({ radius: v as SiteTheme["radius"] })}>
              <SelectTrigger id="ws-radius" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Square</SelectItem>
                <SelectItem value="md">Rounded</SelectItem>
                <SelectItem value="full">Pill</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-ratio">Image ratio</Label>
            <Select value={config.theme.imageRatio} onValueChange={(v) => props.updateTheme({ imageRatio: v as SiteTheme["imageRatio"] })}>
              <SelectTrigger id="ws-ratio" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="4/3">4 : 3</SelectItem>
                <SelectItem value="3/2">3 : 2</SelectItem>
                <SelectItem value="1/1">1 : 1</SelectItem>
                <SelectItem value="16/9">16 : 9</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-navlayout">Navigation layout</Label>
            <Select value={config.theme.navLayout} onValueChange={(v) => props.updateTheme({ navLayout: v as SiteTheme["navLayout"] })}>
              <SelectTrigger id="ws-navlayout" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="inline">Inline row</SelectItem>
                <SelectItem value="stacked">Stacked</SelectItem>
                <SelectItem value="centered">Centered</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-transition">Page transition</Label>
            <Select value={config.theme.pageTransition} onValueChange={(v) => props.updateTheme({ pageTransition: v as SiteTheme["pageTransition"] })}>
              <SelectTrigger id="ws-transition" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="fade">Fade</SelectItem>
                <SelectItem value="slide">Slide</SelectItem>
                <SelectItem value="rise">Rise</SelectItem>
                <SelectItem value="zoom">Zoom</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-divider">Dividers</Label>
            <Select value={config.theme.divider} onValueChange={(v) => props.updateTheme({ divider: v as SiteTheme["divider"] })}>
              <SelectTrigger id="ws-divider" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="line">Hairline</SelectItem>
                <SelectItem value="accent">Accent</SelectItem>
                <SelectItem value="none">None</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">These shape the layout at every breakpoint — use the device switcher to check mobile and tablet.</p>

        {/* pages */}
        <div className="space-y-1.5 border-t border-border/40 pt-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pages</p>
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={props.addPage} disabled={disabled}>
              <Plus className="size-3.5" aria-hidden /> Page
            </Button>
          </div>
          <ul className="max-h-40 space-y-1 overflow-y-auto pr-0.5" style={{ scrollbarWidth: "thin" }}>
            {config.pages.map((p, i) => (
              <li key={p.id}>
                <div
                  className={cn(
                    "group flex items-center gap-1 rounded-lg border px-2.5 py-1.5 transition-colors",
                    activePageId === p.id ? "border-primary/40 bg-gold-soft/40" : "border-transparent hover:bg-accent"
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm"
                    onClick={() => props.onSelectPage(p.id)}
                    aria-label={`Edit page ${p.name}`}
                  >
                    {p.name}
                    {!p.visible && <span className="ml-1.5 text-[10px] text-muted-foreground">(hidden)</span>}
                  </button>
                  <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Button variant="ghost" size="icon" className="size-6" aria-label={`Rename ${p.name}`} onClick={() => {
                      const name = window.prompt("Page name", p.name);
                      if (name && name.trim()) props.renamePage(p.id, name.trim().slice(0, 60));
                    }}>
                      <Pencil className="size-3" aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon" className="size-6" aria-label={`Move ${p.name} left`} disabled={i === 0} onClick={() => props.movePage(p.id, -1)}>
                      <ArrowUp className="size-3 rotate-[-90deg]" aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon" className="size-6" aria-label={`Move ${p.name} right`} disabled={i === config.pages.length - 1} onClick={() => props.movePage(p.id, 1)}>
                      <ArrowDown className="size-3 rotate-[-90deg]" aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon" className="size-6" aria-label={`Duplicate ${p.name}`} onClick={() => props.duplicatePage(p.id)}>
                      <Copy className="size-3" aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon" className="size-6" aria-label={p.visible ? `Hide ${p.name}` : `Show ${p.name}`} onClick={() => props.togglePageVisible(p.id)}>
                      {p.visible ? <Eye className="size-3" aria-hidden /> : <EyeOff className="size-3" aria-hidden />}
                    </Button>
                    <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label={`Delete ${p.name}`} onClick={() => props.removePage(p.id)}>
                      <Trash2 className="size-3" aria-hidden />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* sections of the active page */}
        <div className="space-y-1.5 border-t border-border/40 pt-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Sections <span className="normal-case text-muted-foreground/70">· {activePage?.name ?? "Home"}</span>
            </p>
            <Select onValueChange={(t) => props.addSection(t as SiteSectionType)}>
              <SelectTrigger size="sm" className="h-8 w-[130px]" aria-label="Add a section">
                <Plus className="size-3.5" aria-hidden /> <SelectValue placeholder="Add" />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SECTION_TYPE_LABELS) as SiteSectionType[]).map((t) => (
                  <SelectItem key={t} value={t}>
                    {SECTION_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto pr-0.5" style={{ scrollbarWidth: "thin" }}>
            {(activePage?.sections ?? []).map((s, i) => (
              <div
                key={s.id}
                className={cn(
                  "group rounded-lg border px-2.5 py-2 transition-colors",
                  selectedSectionId === s.id ? "border-primary/40 bg-gold-soft/40" : "border-transparent hover:bg-accent"
                )}
              >
                <button
                  type="button"
                  className="block w-full text-left"
                  onClick={() => props.onSelectSection(s.id)}
                  aria-label={`Edit the ${SECTION_TYPE_LABELS[s.type]} section`}
                >
                  <span className="flex items-center gap-2">
                    <span className={cn("text-[10px] font-semibold uppercase tracking-wider", s.visible ? "text-primary" : "text-muted-foreground")}>
                      {SECTION_TYPE_LABELS[s.type]}
                    </span>
                    {!s.visible && <EyeOff className="size-3 text-muted-foreground" aria-hidden />}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">{s.title}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/70">
                    <SectionSummary section={s} />
                  </span>
                </button>
                <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <Button variant="ghost" size="icon" className="size-6" aria-label={`Move ${s.title} up`} disabled={i === 0} onClick={() => props.moveSection(s.id, -1)}>
                    <ArrowUp className="size-3" aria-hidden />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-6" aria-label={`Move ${s.title} down`} disabled={i === (activePage?.sections.length ?? 1) - 1} onClick={() => props.moveSection(s.id, 1)}>
                    <ArrowDown className="size-3" aria-hidden />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-6" aria-label={`Duplicate ${s.title}`} onClick={() => props.duplicateSection(s.id)}>
                    <Copy className="size-3" aria-hidden />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label={`Remove ${s.title}`} onClick={() => props.removeSection(s.id)}>
                    <Trash2 className="size-3" aria-hidden />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-6" aria-label={s.visible ? `Hide ${s.title}` : `Show ${s.title}`} onClick={() => props.updateSection(s.id, { visible: !s.visible } as Partial<SiteSection>)}>
                    {s.visible ? <Eye className="size-3" aria-hidden /> : <EyeOff className="size-3" aria-hidden />}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* per-section editor (the old Content tab, condensed) */}
        {selectedSection && (
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Editing section</p>
              <Button variant="ghost" size="icon" className="size-6" aria-label="Close section editor" onClick={() => props.onSelectSection(null)}>
                <X className="size-3.5" aria-hidden />
              </Button>
            </div>
            <SectionEditor
              section={selectedSection}
              siteMotion={config.motion}
              theme={config.theme}
              categoryOptions={categoryOptions}
              onChange={(patch) => props.updateSection(selectedSection.id, patch)}
              libraryPrefs={libraryPrefs}
            />
          </div>
        )}
      </PanelGroup>

      {/* ---------------- 5. Motion ---------------- */}
      <PanelGroup title="Motion" icon={<Wand2 className="size-3.5" aria-hidden />} count={motionRevealCount}>
        <div className="flex items-center justify-between">
          <Label htmlFor="ws-motion-enabled" className="text-sm">Animations</Label>
          <Switch id="ws-motion-enabled" checked={config.motion.enabled} onCheckedChange={(v) => props.updateMotion({ enabled: v })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ws-motion-preset">Reveal preset</Label>
          <MotionPicker
            id="ws-motion-preset"
            label="Reveal preset"
            value={config.motion.preset}
            onChange={props.applyMotionPreset}
            fav={libraryPrefs.prefs.fav.motion}
            recent={libraryPrefs.prefs.recent.motion}
            onToggleFav={(id) => libraryPrefs.toggleFav("motion", id)}
            onPick={() => undefined}
          />
          {config.motion.preset !== "none" && (
            <p className="text-[11px] text-muted-foreground">{getMotionPreset(config.motion.preset)?.description}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="ws-motion-dur">Duration · {config.motion.duration} ms</Label>
          <Slider id="ws-motion-dur" value={[config.motion.duration]} min={150} max={1200} step={50} onValueChange={(v) => props.updateMotion({ duration: v[0] })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ws-motion-stagger">Stagger · {config.motion.stagger} ms</Label>
          <Slider id="ws-motion-stagger" value={[config.motion.stagger]} min={0} max={240} step={10} onValueChange={(v) => props.updateMotion({ stagger: v[0] })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ws-motion-delay">Delay · {config.motion.delay} ms <span className="text-[10px] text-muted-foreground">(before each reveal starts)</span></Label>
          <Slider id="ws-motion-delay" value={[config.motion.delay]} min={0} max={600} step={25} onValueChange={(v) => props.updateMotion({ delay: v[0] })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ws-motion-int">Intensity · {config.motion.intensity}%</Label>
          <Slider id="ws-motion-int" value={[config.motion.intensity]} min={0} max={100} step={5} onValueChange={(v) => props.updateMotion({ intensity: v[0] })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ws-motion-ease">Easing</Label>
          <Select value={config.motion.easing} onValueChange={(v) => props.updateMotion({ easing: v as SiteConfig["motion"]["easing"] })}>
            <SelectTrigger id="ws-motion-ease" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="smooth">Smooth</SelectItem>
              <SelectItem value="snap">Snap</SelectItem>
              <SelectItem value="drift">Drift</SelectItem>
              <SelectItem value="swift">Swift</SelectItem>
              <SelectItem value="gentle">Gentle</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="ws-motion-once" className="text-sm">Play once <span className="text-[10px] text-muted-foreground">(off = replay on re-entry)</span></Label>
          <Switch id="ws-motion-once" checked={config.motion.once} onCheckedChange={(v) => props.updateMotion({ once: v })} />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="ws-motion-hover" className="text-sm">Hover micro-interactions</Label>
          <Switch id="ws-motion-hover" checked={config.motion.hoverEffects} onCheckedChange={(v) => props.updateMotion({ hoverEffects: v })} />
        </div>
        {config.motion.hoverEffects && (
          <div className="space-y-1.5">
            <Label htmlFor="ws-motion-micro">Micro-interaction style <span className="text-[10px] text-muted-foreground">(nav &amp; buttons)</span></Label>
            <Select value={config.motion.microInteractions} onValueChange={(v) => props.updateMotion({ microInteractions: v })}>
              <SelectTrigger id="ws-motion-micro" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {motionPresetsByScope("hover").map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{getMotionPreset(config.motion.microInteractions)?.description}</p>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="ws-motion-bg">Animated background</Label>
          <Select value={config.motion.background} onValueChange={(v) => props.updateMotion({ background: v })}>
            <SelectTrigger id="ws-motion-bg" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {motionPresetsByScope("background").map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{getMotionPreset(config.motion.background)?.description}</p>
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="ws-motion-scroll" className="text-sm">Scroll reveals</Label>
          <Switch id="ws-motion-scroll" checked={config.motion.scrollReveal} onCheckedChange={(v) => props.updateMotion({ scrollReveal: v })} />
        </div>
        <p className="text-[11px] text-muted-foreground">Motion automatically respects each visitor's <code className="font-mono">prefers-reduced-motion</code> preference — everything stays visible and static.</p>
      </PanelGroup>

      {/* ---------------- 6. Presentation ---------------- */}
      <PanelGroup title="Presentation" icon={<Star className="size-3.5" aria-hidden />}>
        {/* identity */}
        <div className="space-y-1.5">
          <Label htmlFor="ws-tagline">Tagline (optional)</Label>
          <Input
            id="ws-tagline"
            value={config.tagline}
            maxLength={160}
            placeholder="One line under your name"
            onChange={(e) => props.onTaglineChange(e.target.value)}
          />
        </div>

        {/* design presets */}
        <div className="space-y-2 border-t border-border/40 pt-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Design styles</p>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[10px]"
              title="Reset colors, type and motion to this template's defaults — content is kept"
              onClick={props.resetToTemplateDefaults}
            >
              <RotateCcw className="size-3" aria-hidden /> Reset
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Curated token sets — colors, type and motion together. Sections stay untouched.</p>
          <div className="grid grid-cols-2 gap-2">
            {designPresets().map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => props.applyDesignPreset(p.id)}
                className="rounded-lg border border-border/60 p-2.5 text-left transition-colors hover:border-primary/40"
              >
                <span className="flex gap-1" aria-hidden>
                  {[p.theme.background, p.theme.foreground, p.theme.accent, p.theme.surface ?? p.theme.background].map((c, i) => (
                    <span key={i} className="size-3.5 rounded-full border border-border/60" style={{ background: c }} />
                  ))}
                </span>
                <span className="mt-1.5 block text-xs font-medium leading-tight">{p.label}</span>
                <span className="mt-0.5 line-clamp-2 block text-[10px] leading-snug text-muted-foreground">{p.description}</span>
              </button>
            ))}
          </div>
        </div>

        {/* logo */}
        <div className="space-y-2 border-t border-border/40 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Branding &amp; logo</p>
          <p className="text-[11px] text-muted-foreground">
            Optional logo for your website's header. Your site name stays until you pick one — nothing is forced onto your pages.
          </p>
          <div className="flex items-center gap-3 rounded-md border border-border/50 bg-muted/20 p-2.5">
            {siteLogoSrc(config) ? (
              // Current logo — real proportions, object-contain (never stretched).
              <span className="flex h-12 w-24 shrink-0 items-center justify-center overflow-hidden rounded border border-border/50 bg-background/60">
                <img
                  src={siteLogoSrc(config) ?? undefined}
                  alt="Current website logo"
                  className="max-h-11 max-w-full object-contain"
                  onError={(e) => {
                    e.currentTarget.style.visibility = "hidden";
                  }}
                />
              </span>
            ) : (
              <span className="flex h-12 w-24 shrink-0 items-center justify-center rounded border border-dashed border-border/50 text-[10px] text-muted-foreground">
                No logo
              </span>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap gap-1.5">
                <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[11px]" disabled={logoUploading} onClick={() => logoFileRef.current?.click()}>
                  {logoUploading ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Plus className="size-3" aria-hidden />}
                  Upload logo
                </Button>
                <Button
                  variant={config.logoPreset === "bean-folio" ? "secondary" : "outline"}
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px]"
                  onClick={props.onBeanLogo}
                  title="Use the built-in BEAN Folio brand mark as your website logo"
                >
                  <Star className="size-3" aria-hidden /> BEAN Folio logo
                </Button>
                {siteLogoSrc(config) && (
                  <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-destructive" onClick={props.onRemoveLogo}>
                    <X className="size-3" aria-hidden /> Remove
                  </Button>
                )}
              </div>
              <p className="text-[10px] leading-snug text-muted-foreground">PNG, JPG, WebP, GIF or SVG · up to 8MB · shown at its real proportions.</p>
            </div>
          </div>
          <input
            ref={logoFileRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label="Upload a logo image"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) props.onLogoUpload(f);
              if (logoFileRef.current) logoFileRef.current.value = "";
            }}
          />
        </div>

        {/* buttons & links */}
        <div className="grid grid-cols-2 gap-2 border-t border-border/40 pt-3">
          <div className="space-y-1.5">
            <Label htmlFor="ws-buttons">Buttons</Label>
            <Select value={config.theme.buttonStyle} onValueChange={(v) => props.updateTheme({ buttonStyle: v as SiteTheme["buttonStyle"] })}>
              <SelectTrigger id="ws-buttons" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sharp">Sharp</SelectItem>
                <SelectItem value="rounded">Rounded</SelectItem>
                <SelectItem value="pill">Pill</SelectItem>
                <SelectItem value="outline">Outline</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-links">Links</Label>
            <Select value={config.theme.linkStyle} onValueChange={(v) => props.updateTheme({ linkStyle: v as SiteTheme["linkStyle"] })}>
              <SelectTrigger id="ws-links" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="accent">Accent</SelectItem>
                <SelectItem value="underline">Underlined</SelectItem>
                <SelectItem value="plain">Plain</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* glass system */}
        <div className="space-y-2.5 border-t border-border/40 pt-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Glass effects</p>
            <div className="flex items-center gap-1.5">
              <Label htmlFor="ws-glass-on" className="text-xs">Enable</Label>
              <Switch id="ws-glass-on" checked={glassEnabled} onCheckedChange={(v) => props.updateGlass({ enabled: v })} />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">Frosted translucency on the elements you choose — never forced onto every section. Browsers without backdrop-filter get a solid tint fallback.</p>
          {glassEnabled && (
            <>
              <div className="space-y-1.5">
                <Label>Preset</Label>
                <div className="flex flex-wrap gap-1.5">
                  {(Object.keys(GLASS_PRESETS) as Exclude<GlassPresetId, "custom">[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => props.updateGlass({ preset: p, ...applyGlassPreset(p) })}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-[11px] capitalize transition-colors",
                        config.theme.glass?.preset === p ? "border-primary/50 bg-gold-soft/40 text-primary" : "border-border/60 hover:border-primary/30"
                      )}
                      aria-pressed={config.theme.glass?.preset === p}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5 rounded-md border border-border/50 p-2.5">
                <p className="text-[11px] font-medium text-muted-foreground">Apply to</p>
                {(
                  [
                    { key: "nav", label: "Navigation" },
                    { key: "cards", label: "Cards & panels" },
                    { key: "buttons", label: "Buttons" },
                  ] as const
                ).map((t) => (
                  <div key={t.key} className="flex items-center justify-between">
                    <Label htmlFor={`ws-glass-${t.key}`} className="text-sm">{t.label}</Label>
                    <Switch
                      id={`ws-glass-${t.key}`}
                      checked={config.theme.glass?.targets[t.key] ?? false}
                      onCheckedChange={(v) => props.updateGlass({ targets: { ...(config.theme.glass?.targets ?? { nav: true, cards: true, buttons: false }), [t.key]: v } })}
                    />
                  </div>
                ))}
              </div>
              <div className="space-y-1">
                <Label htmlFor="ws-glass-blur">Blur · {config.theme.glass?.blur ?? 16}px</Label>
                <Slider id="ws-glass-blur" value={[config.theme.glass?.blur ?? 16]} min={0} max={40} step={1} onValueChange={(v) => props.updateGlass({ blur: v[0] })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ws-glass-op">Tint opacity · {config.theme.glass?.opacity ?? 42}%</Label>
                <Slider id="ws-glass-op" value={[config.theme.glass?.opacity ?? 42]} min={0} max={90} step={2} onValueChange={(v) => props.updateGlass({ opacity: v[0] })} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="ws-glass-tint" className="text-sm">Tint color</Label>
                <input
                  id="ws-glass-tint"
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(config.theme.glass?.tint ?? "") ? config.theme.glass!.tint : "#ffffff"}
                  onChange={(e) => props.updateGlass({ tint: e.target.value, preset: "custom" })}
                  className="size-8 cursor-pointer rounded border border-border/60 bg-transparent"
                  aria-label="Glass tint color"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ws-glass-bo">Border opacity · {config.theme.glass?.borderOpacity ?? 35}%</Label>
                <Slider id="ws-glass-bo" value={[config.theme.glass?.borderOpacity ?? 35]} min={0} max={100} step={5} onValueChange={(v) => props.updateGlass({ borderOpacity: v[0] })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ws-glass-bw">Border thickness · {config.theme.glass?.borderWidth ?? 1}px</Label>
                <Slider id="ws-glass-bw" value={[config.theme.glass?.borderWidth ?? 1]} min={0} max={4} step={1} onValueChange={(v) => props.updateGlass({ borderWidth: v[0] })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ws-glass-hl">Highlight · {config.theme.glass?.highlight ?? 35}%</Label>
                <Slider id="ws-glass-hl" value={[config.theme.glass?.highlight ?? 35]} min={0} max={100} step={5} onValueChange={(v) => props.updateGlass({ highlight: v[0] })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ws-glass-sh">Shadow elevation · {config.theme.glass?.shadow ?? 35}%</Label>
                <Slider id="ws-glass-sh" value={[config.theme.glass?.shadow ?? 35]} min={0} max={100} step={5} onValueChange={(v) => props.updateGlass({ shadow: v[0] })} />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="ws-glass-grad" className="text-sm">Subtle inner gradient</Label>
                <Switch id="ws-glass-grad" checked={config.theme.glass?.gradient ?? true} onCheckedChange={(v) => props.updateGlass({ gradient: v })} />
              </div>
            </>
          )}
        </div>

        {/* accessibility & performance */}
        <div className="space-y-2 border-t border-border/40 pt-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="ws-perf-mode" className="text-sm">Performance mode</Label>
            <Switch id="ws-perf-mode" checked={!config.motion.enabled} onCheckedChange={(v) => props.setPerformanceMode(v)} />
          </div>
          <p className="text-[11px] text-muted-foreground">Turns off all animation and glass for maximum speed and reduced-motion safety. The site remains fully usable either way.</p>
          <ContrastRow
            label="Text on background"
            fg={config.theme.foreground}
            bg={config.theme.background}
          />
        </div>

        {/* footer attribution — platform setting, NOT site content */}
        <div className="space-y-1.5 border-t border-border/40 pt-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="ws-watermark" className="text-sm">Show platform credit</Label>
            <Switch id="ws-watermark" checked={watermark} onCheckedChange={(v) => props.onWatermarkChange(v)} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Adds a small "Made with BEAN Folio · GIFTZ" line to your website's footer, below your own
            branding. It applies immediately — no republish needed — and can never alter your content.
          </p>
        </div>
      </PanelGroup>
    </div>
  );
}
