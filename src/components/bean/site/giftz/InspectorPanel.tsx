"use client";

/**
 * InspectorPanel — the GIFTZ visual element inspector (GZ-2).
 *
 * When an element of the website canvas is clicked in CODE GIFTZ mode, this
 * panel edits the SOURCE OF TRUTH of the selected element: the SiteConfig
 * section (the same authoritative structured configuration the deterministic
 * compiler projects into the real project files on save). It is NOT a DOM
 * mutation: every change flows through updateSection → the config → Save →
 * syncGeneratedFiles, so the edit persists to the actual project source.
 *
 * Editable surface (mapped 1:1 to real schema fields — nothing invented):
 *   · Text: the section title/heading; hero subtitle + CTA label; about /
 *     contact body — only fields the section type actually has.
 *   · Color: the heading color + the section background band
 *     (none | surface | accent wash | custom hex).
 *   · Layout: content width, vertical spacing, heading alignment
 *     (the section's own overrides — never site-wide leaks).
 *
 * Elements that do NOT map to the content model (custom user/AI files
 * rendered only by the file-level preview) are honestly out of scope here:
 * the panel states that they belong in the Code workspace.
 */

import { Type, Palette, Paintbrush, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SiteSection } from "@/lib/site-config";
import { cn } from "@/lib/utils";

export function InspectorPanel({
  section,
  onPatch,
  onClose,
  saving,
  onOpenSectionEditor,
}: {
  section: SiteSection | null;
  /** Partial patch onto the section — the parent routes it through updateSection. */
  onPatch: (patch: Partial<SiteSection>) => void;
  onClose: () => void;
  /** Whether the section exists on the ACTIVE page (null when stale). */
  saving?: boolean;
  /** Opens the full section editor in the Customization rail for advanced editing. */
  onOpenSectionEditor?: () => void;
}) {
  if (!section) return null;

  const style = section.style ?? {};
  const hasSubtitle = "subtitle" in section && typeof (section as { subtitle?: unknown }).subtitle === "string";
  const hasCta = "ctaLabel" in section && typeof (section as { ctaLabel?: unknown }).ctaLabel === "string";
  const hasBody = "body" in section && typeof (section as { body?: unknown }).body === "string";

  const patchStyle = (patch: Partial<NonNullable<SiteSection["style"]>>) => {
    onPatch({ style: { ...style, ...patch } } as Partial<SiteSection>);
  };

  return (
    <section
      aria-label="Element inspector"
      className="rounded-lg border border-border/60 bg-card/80 p-3 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Paintbrush className="size-4 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <p className="truncate text-[12px] font-semibold">
              {section.title || section.type}
            </p>
            <p className="truncate text-[10px] text-muted-foreground">
              {section.type} · {section.id} — edits persist to the website source on save
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <Label className="flex items-center gap-1 text-[10px]">
            <Type className="size-3" aria-hidden /> Heading text
          </Label>
          <Input
            className="h-8 text-xs"
            value={section.title}
            onChange={(e) => onPatch({ title: e.target.value } as Partial<SiteSection>)}
            placeholder={section.type === "hero" ? "Hero heading" : "Section heading (empty = no heading)"}
            aria-label="Section heading text"
          />
        </div>

        {hasSubtitle ? (
          <div className="col-span-2">
            <Label className="text-[10px]">Subtitle</Label>
            <Input
              className="h-8 text-xs"
              value={String((section as { subtitle: string }).subtitle)}
              onChange={(e) => onPatch({ subtitle: e.target.value } as Partial<SiteSection>)}
              aria-label="Section subtitle"
            />
          </div>
        ) : null}

        {hasCta ? (
          <div>
            <Label className="text-[10px]">Button label</Label>
            <Input
              className="h-8 text-xs"
              value={String((section as { ctaLabel: string }).ctaLabel)}
              onChange={(e) => onPatch({ ctaLabel: e.target.value } as Partial<SiteSection>)}
              aria-label="Button label"
            />
          </div>
        ) : null}

        {hasBody ? (
          <div className="col-span-2">
            <Label className="text-[10px]">Body text</Label>
            <textarea
              className="min-h-[72px] w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-xs leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={String((section as { body: string }).body)}
              onChange={(e) => onPatch({ body: e.target.value } as Partial<SiteSection>)}
              aria-label="Section body text"
            />
          </div>
        ) : null}

        <div className="col-span-2 mt-1 flex items-center gap-1.5 border-t border-border/50 pt-2">
          <Palette className="size-3.5 text-primary" aria-hidden />
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Colors &amp; layout — this section only
          </p>
        </div>

        <div>
          <Label className="text-[10px]">Background</Label>
          <Select
            value={
              style.background === undefined
                ? "inherit"
                : style.background === "none" || style.background === "surface" || style.background === "wash"
                  ? style.background
                  : "custom"
            }
            onValueChange={(v) => {
              if (v === "inherit") patchStyle({ background: undefined });
              else if (v === "custom") patchStyle({ background: style.background && !["none", "surface", "wash"].includes(style.background) ? style.background : "#1a1a1f" });
              else patchStyle({ background: v as "none" | "surface" | "wash" });
            }}
          >
            <SelectTrigger className="h-8 text-[11px]" aria-label="Section background"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit" className="text-[11px]">Inherit site theme</SelectItem>
              <SelectItem value="none" className="text-[11px]">None (transparent)</SelectItem>
              <SelectItem value="surface" className="text-[11px]">Surface (cards)</SelectItem>
              <SelectItem value="wash" className="text-[11px]">Accent wash</SelectItem>
              <SelectItem value="custom" className="text-[11px]">Custom color…</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {style.background !== undefined && !["none", "surface", "wash"].includes(style.background) ? (
          <div>
            <Label className="text-[10px]">Custom background</Label>
            <Input
              className="h-8 font-mono text-[11px]"
              value={style.background}
              onChange={(e) => patchStyle({ background: e.target.value })}
              aria-label="Custom background color"
            />
          </div>
        ) : (
          <div>
            <Label className="text-[10px]">Heading color</Label>
            <Input
              className="h-8 font-mono text-[11px]"
              placeholder="inherit"
              value={style.titleColor ?? ""}
              onChange={(e) => patchStyle({ titleColor: e.target.value.trim() ? e.target.value : undefined })}
              aria-label="Heading color"
            />
          </div>
        )}

        <div>
          <Label className="text-[10px]">Content width</Label>
          <Select
            value={style.width ?? "inherit"}
            onValueChange={(v) => patchStyle({ width: v === "inherit" ? undefined : (v as "narrow" | "regular" | "wide") })}
          >
            <SelectTrigger className="h-8 text-[11px]" aria-label="Section width"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit" className="text-[11px]">Inherit site theme</SelectItem>
              <SelectItem value="narrow" className="text-[11px]">Narrow</SelectItem>
              <SelectItem value="regular" className="text-[11px]">Regular</SelectItem>
              <SelectItem value="wide" className="text-[11px]">Wide</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[10px]">Spacing</Label>
          <Select
            value={style.spacing ?? "inherit"}
            onValueChange={(v) => patchStyle({ spacing: v === "inherit" ? undefined : (v as "compact" | "regular" | "relaxed") })}
          >
            <SelectTrigger className="h-8 text-[11px]" aria-label="Section spacing"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit" className="text-[11px]">Inherit site theme</SelectItem>
              <SelectItem value="compact" className="text-[11px]">Compact</SelectItem>
              <SelectItem value="regular" className="text-[11px]">Regular</SelectItem>
              <SelectItem value="relaxed" className="text-[11px]">Relaxed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[10px]">Heading align</Label>
          <Select
            value={style.headingAlign ?? "inherit"}
            onValueChange={(v) => patchStyle({ headingAlign: v === "inherit" ? undefined : (v as "left" | "center") })}
          >
            <SelectTrigger className="h-8 text-[11px]" aria-label="Heading alignment"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit" className="text-[11px]">Inherit site theme</SelectItem>
              <SelectItem value="left" className="text-[11px]">Left</SelectItem>
              <SelectItem value="center" className="text-[11px]">Center</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p className={cn("col-span-2 text-[10px] leading-relaxed text-muted-foreground")}>
          These are real content-model edits: they persist through Save (which regenerates the project files) —
          the same files the Code workspace and the AI agent edit.
        </p>
        {onOpenSectionEditor ? (
          <div className="col-span-2">
            <Button variant="outline" size="sm" className="h-7 w-full px-2 text-[11px]" onClick={onOpenSectionEditor} disabled={saving}>
              More editing options (Studio rail)
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default InspectorPanel;
