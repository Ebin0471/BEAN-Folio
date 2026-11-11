"use client";

/**
 * ContentEditor — the LEFT workspace panel: direct website-content editing.
 *
 * Lets the user edit the real content of their website WITHOUT describing
 * every text change to the AI chat:
 *   · Website identity   — site title + tagline (the site's own name).
 *   · Section content    — per-section headings and text/items of the active
 *                          page (hero copy + CTA, about body, contact body,
 *                          services items, experience entries, testimonials…)
 *                          with add/remove for supported content items.
 *   · Profile content    — the portfolio identity every mode shares
 *                          (headline, introduction/bio, skills, contact
 *                          details) saved through the profile API.
 *
 * Clear labeling (task requirement): content edits here are DIRECT edits to
 * the saved website draft — they surface through the top-bar Save/Discard and
 * preview in the site canvas. They are never mixed with CODE GIFTZ code
 * proposals, which arrive as isolated, separately-previewed changes.
 *
 * Honesty rules preserved: nothing is invented — every field starts empty or
 * with the user's existing data, and testimonial/experience hints repeat that
 * only real, user-owned content belongs here.
 */

import { useMemo, useState } from "react";
import {
  ChevronDown,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  UserRound,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PanelGroup, SECTION_TYPE_LABELS, SectionSummary } from "./controls";
import type { SiteConfig, SitePage, SiteSection } from "@/lib/site-config";
import { cn } from "@/lib/utils";

/** The profile fields the content editor owns (saved via PATCH /api/me/profile).
 *  All strings — empty means "clear"; the caller maps optional links to null. */
export interface ProfileContentPatch {
  headline: string;
  bio: string;
  location: string;
  availability: string;
  contactEmail: string;
  websiteUrl: string;
  skills: string[];
}

export interface ContentEditorProfile {
  headline: string | null;
  bio: string | null;
  location: string | null;
  availability: string | null;
  contactEmail: string | null;
  websiteUrl: string | null;
  skills: string[];
}

export interface ContentEditorProps {
  config: SiteConfig;
  activePage: SitePage | null;
  disabled?: boolean;
  categoryOptions: string[];

  onNameChange: (v: string) => void;
  onTaglineChange: (v: string) => void;
  updateSection: (id: string, patch: Partial<SiteSection>) => void;

  profile: ContentEditorProfile | null;
  profileSaving: boolean;
  onProfileSave: (patch: ProfileContentPatch) => Promise<boolean>;
}

// ---------------------------------------------------------------- item editors

function ItemShell({
  label, onRemove, disabled, children,
}: {
  label: string;
  onRemove: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/50 bg-background/40 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="truncate text-[11px] font-medium text-muted-foreground">{label}</p>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${label}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 className="size-3" aria-hidden />
        </Button>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

/** services items — { title, description }. */
function ServicesItems({
  section, disabled, onChange,
}: {
  section: Extract<SiteSection, { type: "services" }>;
  disabled?: boolean;
  onChange: (patch: Partial<SiteSection>) => void;
}) {
  const items = section.items;
  function patchItem(i: number, patch: Partial<{ title: string; description: string }>) {
    onChange({ items: items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) } as Partial<SiteSection>);
  }
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <ItemShell
          key={i}
          label={it.title.trim() || `Service ${i + 1}`}
          disabled={disabled}
          onRemove={() => onChange({ items: items.filter((_, idx) => idx !== i) } as Partial<SiteSection>)}
        >
          <Input
            value={it.title}
            maxLength={80}
            placeholder="Service name"
            className="h-8 text-xs"
            aria-label={`Service ${i + 1} name`}
            disabled={disabled}
            onChange={(e) => patchItem(i, { title: e.target.value })}
          />
          <Textarea
            value={it.description}
            maxLength={300}
            placeholder="One or two sentences describing it"
            className="min-h-14 text-xs"
            aria-label={`Service ${i + 1} description`}
            disabled={disabled}
            onChange={(e) => patchItem(i, { description: e.target.value })}
          />
        </ItemShell>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-[11px]"
        disabled={disabled || items.length >= 8}
        onClick={() => onChange({ items: [...items, { title: "", description: "" }] } as Partial<SiteSection>)}
      >
        <Plus className="size-3" aria-hidden /> Add service
      </Button>
      {items.length === 0 && (
        <p className="text-[11px] text-muted-foreground">No services yet — add the offers you actually provide.</p>
      )}
    </div>
  );
}

/** experience entries — { role, org, period, description }. Doubles for education. */
function ExperienceEntries({
  section, disabled, onChange,
}: {
  section: Extract<SiteSection, { type: "experience" }>;
  disabled?: boolean;
  onChange: (patch: Partial<SiteSection>) => void;
}) {
  const entries = section.entries;
  function patchEntry(i: number, patch: Partial<{ role: string; org: string; period: string; description: string }>) {
    onChange({ entries: entries.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) } as Partial<SiteSection>);
  }
  return (
    <div className="space-y-2">
      {entries.map((it, i) => (
        <ItemShell
          key={i}
          label={it.role.trim() || it.org.trim() || `Entry ${i + 1}`}
          disabled={disabled}
          onRemove={() => onChange({ entries: entries.filter((_, idx) => idx !== i) } as Partial<SiteSection>)}
        >
          <div className="grid grid-cols-2 gap-1.5">
            <Input
              value={it.role}
              maxLength={80}
              placeholder="Role or qualification"
              className="h-8 text-xs"
              aria-label={`Entry ${i + 1} role`}
              disabled={disabled}
              onChange={(e) => patchEntry(i, { role: e.target.value })}
            />
            <Input
              value={it.org}
              maxLength={80}
              placeholder="Company / school"
              className="h-8 text-xs"
              aria-label={`Entry ${i + 1} organization`}
              disabled={disabled}
              onChange={(e) => patchEntry(i, { org: e.target.value })}
            />
          </div>
          <Input
            value={it.period}
            maxLength={40}
            placeholder="Period (e.g. 2021 — 2024)"
            className="h-8 text-xs"
            aria-label={`Entry ${i + 1} period`}
            disabled={disabled}
            onChange={(e) => patchEntry(i, { period: e.target.value })}
          />
          <Textarea
            value={it.description}
            maxLength={400}
            placeholder="What you did or studied (your own words)"
            className="min-h-14 text-xs"
            aria-label={`Entry ${i + 1} description`}
            disabled={disabled}
            onChange={(e) => patchEntry(i, { description: e.target.value })}
          />
        </ItemShell>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-[11px]"
        disabled={disabled || entries.length >= 10}
        onClick={() => onChange({ entries: [...entries, { role: "", org: "", period: "", description: "" }] } as Partial<SiteSection>)}
      >
        <Plus className="size-3" aria-hidden /> Add entry
      </Button>
      <p className="text-[11px] text-muted-foreground">
        Use entries for real roles, education and milestones — nothing is invented or auto-filled.
      </p>
    </div>
  );
}

/** testimonials items — { quote, name, role }. Real quotes only. */
function TestimonialItems({
  section, disabled, onChange,
}: {
  section: Extract<SiteSection, { type: "testimonials" }>;
  disabled?: boolean;
  onChange: (patch: Partial<SiteSection>) => void;
}) {
  const items = section.items;
  function patchItem(i: number, patch: Partial<{ quote: string; name: string; role: string }>) {
    onChange({ items: items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) } as Partial<SiteSection>);
  }
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <ItemShell
          key={i}
          label={it.name.trim() || `Quote ${i + 1}`}
          disabled={disabled}
          onRemove={() => onChange({ items: items.filter((_, idx) => idx !== i) } as Partial<SiteSection>)}
        >
          <Textarea
            value={it.quote}
            maxLength={500}
            placeholder="The quote, word for word"
            className="min-h-14 text-xs"
            aria-label={`Quote ${i + 1} text`}
            disabled={disabled}
            onChange={(e) => patchItem(i, { quote: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <Input
              value={it.name}
              maxLength={80}
              placeholder="Person's name"
              className="h-8 text-xs"
              aria-label={`Quote ${i + 1} name`}
              disabled={disabled}
              onChange={(e) => patchItem(i, { name: e.target.value })}
            />
            <Input
              value={it.role}
              maxLength={80}
              placeholder="Their role"
              className="h-8 text-xs"
              aria-label={`Quote ${i + 1} role`}
              disabled={disabled}
              onChange={(e) => patchItem(i, { role: e.target.value })}
            />
          </div>
        </ItemShell>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-[11px]"
        disabled={disabled || items.length >= 8}
        onClick={() => onChange({ items: [...items, { quote: "", name: "", role: "" }] } as Partial<SiteSection>)}
      >
        <Plus className="size-3" aria-hidden /> Add quote
      </Button>
      <p className="text-[11px] text-muted-foreground">Only genuine quotes you have permission to publish.</p>
    </div>
  );
}

/** process items — { title, description }. How you actually work, in your words. */
function ProcessItems({
  section, disabled, onChange,
}: {
  section: Extract<SiteSection, { type: "process" }>;
  disabled?: boolean;
  onChange: (patch: Partial<SiteSection>) => void;
}) {
  const items = section.items;
  function patchItem(i: number, patch: Partial<{ title: string; description: string }>) {
    onChange({ items: items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) } as Partial<SiteSection>);
  }
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <ItemShell
          key={i}
          label={it.title.trim() || `Step ${i + 1}`}
          disabled={disabled}
          onRemove={() => onChange({ items: items.filter((_, idx) => idx !== i) } as Partial<SiteSection>)}
        >
          <Input
            value={it.title}
            maxLength={80}
            placeholder="Step name"
            className="h-8 text-xs"
            aria-label={`Step ${i + 1} name`}
            disabled={disabled}
            onChange={(e) => patchItem(i, { title: e.target.value })}
          />
          <Textarea
            value={it.description}
            maxLength={400}
            placeholder="What happens in this step (optional)"
            className="min-h-14 text-xs"
            aria-label={`Step ${i + 1} description`}
            disabled={disabled}
            onChange={(e) => patchItem(i, { description: e.target.value })}
          />
        </ItemShell>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-[11px]"
        disabled={disabled || items.length >= 8}
        onClick={() => onChange({ items: [...items, { title: "", description: "" }] } as Partial<SiteSection>)}
      >
        <Plus className="size-3" aria-hidden /> Add step
      </Button>
      {items.length === 0 && (
        <p className="text-[11px] text-muted-foreground">No steps yet — describe how you actually work.</p>
      )}
    </div>
  );
}

/** faq items — { question, answer }. Real questions your clients ask. */
function FaqItems({
  section, disabled, onChange,
}: {
  section: Extract<SiteSection, { type: "faq" }>;
  disabled?: boolean;
  onChange: (patch: Partial<SiteSection>) => void;
}) {
  const items = section.items;
  function patchItem(i: number, patch: Partial<{ question: string; answer: string }>) {
    onChange({ items: items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) } as Partial<SiteSection>);
  }
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <ItemShell
          key={i}
          label={it.question.trim() || `Question ${i + 1}`}
          disabled={disabled}
          onRemove={() => onChange({ items: items.filter((_, idx) => idx !== i) } as Partial<SiteSection>)}
        >
          <Input
            value={it.question}
            maxLength={200}
            placeholder="The question"
            className="h-8 text-xs"
            aria-label={`Question ${i + 1}`}
            disabled={disabled}
            onChange={(e) => patchItem(i, { question: e.target.value })}
          />
          <Textarea
            value={it.answer}
            maxLength={800}
            placeholder="The answer, in your own words"
            className="min-h-14 text-xs"
            aria-label={`Answer ${i + 1}`}
            disabled={disabled}
            onChange={(e) => patchItem(i, { answer: e.target.value })}
          />
        </ItemShell>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-[11px]"
        disabled={disabled || items.length >= 10}
        onClick={() => onChange({ items: [...items, { question: "", answer: "" }] } as Partial<SiteSection>)}
      >
        <Plus className="size-3" aria-hidden /> Add question
      </Button>
      {items.length === 0 && (
        <p className="text-[11px] text-muted-foreground">No questions yet — answer the ones clients actually ask.</p>
      )}
    </div>
  );
}

/** pricing tiers — { name, price, period, description, features, ctaLabel, highlighted }. */
function PricingTiers({
  section, disabled, onChange,
}: {
  section: Extract<SiteSection, { type: "pricing" }>;
  disabled?: boolean;
  onChange: (patch: Partial<SiteSection>) => void;
}) {
  const tiers = section.tiers;
  function patchTier(i: number, patch: Partial<{ name: string; price: string; period: string; description: string; ctaLabel: string; highlighted: boolean; features: string[] }>) {
    onChange({ tiers: tiers.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) } as Partial<SiteSection>);
  }
  return (
    <div className="space-y-2">
      {tiers.map((tier, i) => (
        <ItemShell
          key={i}
          label={tier.name.trim() || `Tier ${i + 1}`}
          disabled={disabled}
          onRemove={() => onChange({ tiers: tiers.filter((_, idx) => idx !== i) } as Partial<SiteSection>)}
        >
          <div className="grid grid-cols-2 gap-1.5">
            <Input
              value={tier.name}
              maxLength={80}
              placeholder="Tier name"
              className="h-8 text-xs"
              aria-label={`Tier ${i + 1} name`}
              disabled={disabled}
              onChange={(e) => patchTier(i, { name: e.target.value })}
            />
            <Input
              value={tier.price}
              maxLength={40}
              placeholder="Price (e.g. $900)"
              className="h-8 text-xs"
              aria-label={`Tier ${i + 1} price`}
              disabled={disabled}
              onChange={(e) => patchTier(i, { price: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Input
              value={tier.period}
              maxLength={40}
              placeholder="Period (e.g. /project)"
              className="h-8 text-xs"
              aria-label={`Tier ${i + 1} period`}
              disabled={disabled}
              onChange={(e) => patchTier(i, { period: e.target.value })}
            />
            <Input
              value={tier.ctaLabel}
              maxLength={40}
              placeholder="Button text (optional)"
              className="h-8 text-xs"
              aria-label={`Tier ${i + 1} button text`}
              disabled={disabled}
              onChange={(e) => patchTier(i, { ctaLabel: e.target.value })}
            />
          </div>
          <Textarea
            value={tier.description}
            maxLength={200}
            placeholder="One line about what's included"
            className="min-h-12 text-xs"
            aria-label={`Tier ${i + 1} description`}
            disabled={disabled}
            onChange={(e) => patchTier(i, { description: e.target.value })}
          />
          <Input
            value={tier.features.join(", ")}
            placeholder="Features, comma-separated"
            className="h-8 text-xs"
            aria-label={`Tier ${i + 1} features (comma-separated)`}
            disabled={disabled}
            onChange={(e) =>
              patchTier(i, {
                features: e.target.value.split(",").map((f) => f.trim().slice(0, 80)).filter(Boolean).slice(0, 6),
              })
            }
          />
          <p className="text-[10px] text-muted-foreground">Up to 6 features, separated by commas.</p>
          <div className="flex items-center justify-between">
            <Label htmlFor={`ce-${section.id}-tier-${i}-hl`} className="text-xs text-muted-foreground">Highlight this tier</Label>
            <Switch
              id={`ce-${section.id}-tier-${i}-hl`}
              checked={tier.highlighted}
              disabled={disabled}
              onCheckedChange={(v) => patchTier(i, { highlighted: v })}
            />
          </div>
        </ItemShell>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-[11px]"
        disabled={disabled || tiers.length >= 4}
        onClick={() =>
          onChange({ tiers: [...tiers, { name: "", price: "", period: "", description: "", features: [], ctaLabel: "", highlighted: false }] } as Partial<SiteSection>)
        }
      >
        <Plus className="size-3" aria-hidden /> Add tier
      </Button>
      {tiers.length === 0 && (
        <p className="text-[11px] text-muted-foreground">No tiers yet — your real rates, nothing invented.</p>
      )}
    </div>
  );
}

/** logos items — { name }. Real client names only; empty renders placeholders. */
function LogoNameItems({
  section, disabled, onChange,
}: {
  section: Extract<SiteSection, { type: "logos" }>;
  disabled?: boolean;
  onChange: (patch: Partial<SiteSection>) => void;
}) {
  const items = section.items;
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={it.name}
            maxLength={60}
            placeholder="Client name"
            className="h-8 text-xs"
            aria-label={`Client ${i + 1} name`}
            disabled={disabled}
            onChange={(e) =>
              onChange({ items: items.map((row, idx) => (idx === i ? { ...row, name: e.target.value } : row)) } as Partial<SiteSection>)
            }
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`Remove client ${i + 1}`}
            disabled={disabled}
            onClick={() => onChange({ items: items.filter((_, idx) => idx !== i) } as Partial<SiteSection>)}
          >
            <Trash2 className="size-3" aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-[11px]"
        disabled={disabled || items.length >= 12}
        onClick={() => onChange({ items: [...items, { name: "" }] } as Partial<SiteSection>)}
      >
        <Plus className="size-3" aria-hidden /> Add client
      </Button>
      {items.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          No client names yet — the site shows clearly-labelled placeholders. GIFTZ never invents clients.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- section editor

/** One section's content fields (content ONLY — layout lives in the Studio rail). */
function SectionContentFields({
  section, disabled, categoryOptions, onChange,
}: {
  section: SiteSection;
  disabled?: boolean;
  categoryOptions: string[];
  onChange: (patch: Partial<SiteSection>) => void;
}) {
  switch (section.type) {
    case "hero":
      return (
        <>
          <FieldRow label="Heading" htmlFor={`ce-${section.id}-title`}>
            <Input
              id={`ce-${section.id}-title`}
              value={section.title}
              maxLength={120}
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </FieldRow>
          <FieldRow label="Subheading" htmlFor={`ce-${section.id}-subtitle`}>
            <Input
              id={`ce-${section.id}-subtitle`}
              value={section.subtitle}
              maxLength={280}
              placeholder="{headline} — {location} render your real profile data"
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => onChange({ subtitle: e.target.value } as Partial<SiteSection>)}
            />
          </FieldRow>
          <div className="grid grid-cols-2 gap-2">
            <FieldRow label="Button text" htmlFor={`ce-${section.id}-cta`}>
              <Input
                id={`ce-${section.id}-cta`}
                value={section.ctaLabel}
                maxLength={40}
                placeholder="Empty = no button"
                className="h-8 text-xs"
                disabled={disabled}
                onChange={(e) => onChange({ ctaLabel: e.target.value } as Partial<SiteSection>)}
              />
            </FieldRow>
            <FieldRow label="Button link" htmlFor={`ce-${section.id}-href`}>
              <Input
                id={`ce-${section.id}-href`}
                value={section.ctaHref}
                maxLength={300}
                placeholder="#contact or https://…"
                className="h-8 text-xs"
                disabled={disabled}
                onChange={(e) => onChange({ ctaHref: e.target.value } as Partial<SiteSection>)}
              />
            </FieldRow>
          </div>
        </>
      );
    case "about":
      return (
        <FieldRow label="Text" htmlFor={`ce-${section.id}-body`}>
          <Textarea
            id={`ce-${section.id}-body`}
            value={section.body}
            maxLength={4000}
            className="min-h-28 text-xs"
            placeholder="{bio}, {name}, {headline}, {location}, {availability} render your real profile data"
            disabled={disabled}
            onChange={(e) => onChange({ body: e.target.value } as Partial<SiteSection>)}
          />
        </FieldRow>
      );
    case "contact":
      return (
        <FieldRow label="Text" htmlFor={`ce-${section.id}-body`}>
          <Textarea
            id={`ce-${section.id}-body`}
            value={section.body}
            maxLength={1200}
            className="min-h-20 text-xs"
            placeholder="{availability} inserts your availability"
            disabled={disabled}
            onChange={(e) => onChange({ body: e.target.value } as Partial<SiteSection>)}
          />
        </FieldRow>
      );
    case "projects":
      return (
        <>
          <FieldRow label="Heading" htmlFor={`ce-${section.id}-title`}>
            <Input
              id={`ce-${section.id}-title`}
              value={section.title}
              maxLength={120}
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </FieldRow>
          <div className="grid grid-cols-2 gap-2">
            <FieldRow label="Show up to" htmlFor={`ce-${section.id}-limit`}>
              <Select
                value={String(section.limit)}
                onValueChange={(v) => onChange({ limit: Number(v) } as Partial<SiteSection>)}
              >
                <SelectTrigger id={`ce-${section.id}-limit`} className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[3, 4, 6, 8, 9, 12, 16, 24].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n} projects</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
            <FieldRow label="Category filter" htmlFor={`ce-${section.id}-cat`}>
              <Select
                value={section.category || "all"}
                onValueChange={(v) => onChange({ category: v === "all" ? "" : v } as Partial<SiteSection>)}
              >
                <SelectTrigger id={`ce-${section.id}-cat`} className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {categoryOptions.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          </div>
          <p className="text-[11px] text-muted-foreground">Projects themselves are managed on your portfolio — this section decides what shows here.</p>
        </>
      );
    case "skills":
      return (
        <>
          <FieldRow label="Heading" htmlFor={`ce-${section.id}-title`}>
            <Input
              id={`ce-${section.id}-title`}
              value={section.title}
              maxLength={120}
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </FieldRow>
          <p className="text-[11px] text-muted-foreground">This section renders your profile skills — edit them in “Profile content” below.</p>
        </>
      );
    case "stats":
    case "collections":
    case "gallery":
      return (
        <>
          <FieldRow label="Heading" htmlFor={`ce-${section.id}-title`}>
            <Input
              id={`ce-${section.id}-title`}
              value={section.title}
              maxLength={120}
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </FieldRow>
          {"limit" in section && (
            <FieldRow label="Show up to" htmlFor={`ce-${section.id}-limit`}>
              <Select
                value={String(section.limit)}
                onValueChange={(v) => onChange({ limit: Number(v) } as Partial<SiteSection>)}
              >
                <SelectTrigger id={`ce-${section.id}-limit`} className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(section.type === "collections" ? [1, 2, 3, 4, 6, 9, 12] : [3, 6, 9, 12, 16, 24]).map((n) => (
                    <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          )}
          <p className="text-[11px] text-muted-foreground">Renders your real portfolio data ({section.type === "stats" ? "profile stats" : section.type === "collections" ? "your collections" : "project imagery"}).</p>
        </>
      );
    case "services":
      return (
        <>
          <FieldRow label="Heading" htmlFor={`ce-${section.id}-title`}>
            <Input
              id={`ce-${section.id}-title`}
              value={section.title}
              maxLength={120}
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </FieldRow>
          <ServicesItems section={section} disabled={disabled} onChange={onChange} />
        </>
      );
    case "experience":
      return (
        <>
          <FieldRow label="Heading" htmlFor={`ce-${section.id}-title`}>
            <Input
              id={`ce-${section.id}-title`}
              value={section.title}
              maxLength={120}
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </FieldRow>
          <ExperienceEntries section={section} disabled={disabled} onChange={onChange} />
        </>
      );
    case "testimonials":
      return (
        <>
          <FieldRow label="Heading" htmlFor={`ce-${section.id}-title`}>
            <Input
              id={`ce-${section.id}-title`}
              value={section.title}
              maxLength={120}
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </FieldRow>
          <TestimonialItems section={section} disabled={disabled} onChange={onChange} />
        </>
      );
    case "process":
      return (
        <>
          <FieldRow label="Heading" htmlFor={`ce-${section.id}-title`}>
            <Input
              id={`ce-${section.id}-title`}
              value={section.title}
              maxLength={120}
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </FieldRow>
          <ProcessItems section={section} disabled={disabled} onChange={onChange} />
        </>
      );
    case "faq":
      return (
        <>
          <FieldRow label="Heading" htmlFor={`ce-${section.id}-title`}>
            <Input
              id={`ce-${section.id}-title`}
              value={section.title}
              maxLength={120}
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </FieldRow>
          <FaqItems section={section} disabled={disabled} onChange={onChange} />
        </>
      );
    case "pricing":
      return (
        <>
          <FieldRow label="Heading" htmlFor={`ce-${section.id}-title`}>
            <Input
              id={`ce-${section.id}-title`}
              value={section.title}
              maxLength={120}
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </FieldRow>
          <PricingTiers section={section} disabled={disabled} onChange={onChange} />
        </>
      );
    case "logos":
      return (
        <>
          <FieldRow label="Heading" htmlFor={`ce-${section.id}-title`}>
            <Input
              id={`ce-${section.id}-title`}
              value={section.title}
              maxLength={120}
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </FieldRow>
          <FieldRow label="Note" htmlFor={`ce-${section.id}-note`}>
            <Input
              id={`ce-${section.id}-note`}
              value={section.note}
              maxLength={200}
              placeholder="Optional line about your clients"
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => onChange({ note: e.target.value } as Partial<SiteSection>)}
            />
          </FieldRow>
          <LogoNameItems section={section} disabled={disabled} onChange={onChange} />
        </>
      );
    default:
      return null;
  }
}

function FieldRow({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- profile editor

function toProfileDraft(profile: ContentEditorProfile): ProfileContentPatch {
  return {
    headline: profile.headline ?? "",
    bio: profile.bio ?? "",
    location: profile.location ?? "",
    availability: profile.availability ?? "",
    contactEmail: profile.contactEmail ?? "",
    websiteUrl: profile.websiteUrl ?? "",
    skills: profile.skills,
  };
}

function ProfileEditor({
  profile, saving, disabled, onSave,
}: {
  profile: ContentEditorProfile;
  saving: boolean;
  disabled?: boolean;
  onSave: (patch: ProfileContentPatch) => Promise<boolean>;
}) {
  // Local draft, seeded from the server profile at mount. The parent remounts
  // this component (key) whenever the SAVED profile changes, so a fresh draft
  // always starts from the real, existing values — nothing invented.
  const [draft, setDraft] = useState<ProfileContentPatch>(() => toProfileDraft(profile));

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(toProfileDraft(profile)),
    [draft, profile]
  );

  const emailOk = draft.contactEmail === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.contactEmail);
  const urlOk = draft.websiteUrl === "" || /^https?:\/\/\S+$/i.test(draft.websiteUrl);
  const valid = emailOk && urlOk;

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-1 gap-2">
        <FieldRow label="Professional headline" htmlFor="ce-profile-headline">
          <Input
            id="ce-profile-headline"
            value={draft.headline}
            maxLength={120}
            placeholder="One line under your name"
            className="h-8 text-xs"
            disabled={disabled}
            onChange={(e) => setDraft((d) => ({ ...d, headline: e.target.value }))}
          />
        </FieldRow>
        <FieldRow label="Introduction (bio)" htmlFor="ce-profile-bio">
          <Textarea
            id="ce-profile-bio"
            value={draft.bio}
            maxLength={2000}
            className="min-h-24 text-xs"
            placeholder="A short introduction in your own words"
            disabled={disabled}
            onChange={(e) => setDraft((d) => ({ ...d, bio: e.target.value }))}
          />
        </FieldRow>
        <div className="grid grid-cols-2 gap-2">
          <FieldRow label="Location" htmlFor="ce-profile-location">
            <Input
              id="ce-profile-location"
              value={draft.location}
              maxLength={100}
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => setDraft((d) => ({ ...d, location: e.target.value }))}
            />
          </FieldRow>
          <FieldRow label="Availability" htmlFor="ce-profile-availability">
            <Input
              id="ce-profile-availability"
              value={draft.availability}
              maxLength={80}
              className="h-8 text-xs"
              disabled={disabled}
              onChange={(e) => setDraft((d) => ({ ...d, availability: e.target.value }))}
            />
          </FieldRow>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <FieldRow label="Contact email" htmlFor="ce-profile-email">
            <Input
              id="ce-profile-email"
              value={draft.contactEmail}
              type="email"
              maxLength={200}
              className="h-8 text-xs"
              aria-invalid={!emailOk}
              disabled={disabled}
              onChange={(e) => setDraft((d) => ({ ...d, contactEmail: e.target.value }))}
            />
          </FieldRow>
          <FieldRow label="Website" htmlFor="ce-profile-url">
            <Input
              id="ce-profile-url"
              value={draft.websiteUrl}
              inputMode="url"
              maxLength={300}
              placeholder="https://…"
              className="h-8 text-xs"
              aria-invalid={!urlOk}
              disabled={disabled}
              onChange={(e) => setDraft((d) => ({ ...d, websiteUrl: e.target.value }))}
            />
          </FieldRow>
        </div>
        <FieldRow label="Skills" htmlFor="ce-profile-skills">
          <TagInputLite
            value={draft.skills}
            disabled={disabled}
            onChange={(skills) => setDraft((d) => ({ ...d, skills }))}
          />
        </FieldRow>
      </div>
      {!valid && (
        <p className="text-[11px] text-destructive" role="alert">
          {emailOk ? "The website link must start with http:// or https://" : "Enter a valid email address."}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-8 gap-1.5"
          disabled={disabled || saving || !dirty || !valid}
          onClick={() => void onSave(draft)}
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />}
          Save profile
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5"
          disabled={disabled || saving || !dirty}
          onClick={() => setDraft(toProfileDraft(profile))}
        >
          <RotateCcw className="size-3.5" aria-hidden /> Discard
        </Button>
        {dirty && <span className="text-[11px] text-muted-foreground">Unsaved profile edits</span>}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">
        Your profile identity is shared by the whole platform — the website, your public profile and
        CODE GIFTZ all read the same data. Saving here updates it everywhere; nothing is invented.
      </p>
    </div>
  );
}

/** Minimal chip input (keeps ContentEditor self-contained; same UX as TagInput). */
function TagInputLite({
  value, onChange, disabled,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  function add(raw: string) {
    const t = raw.trim().replace(/,+$/, "").slice(0, 40);
    if (!t || value.some((v) => v.toLowerCase() === t.toLowerCase()) || value.length >= 20) {
      setDraft("");
      return;
    }
    onChange([...value, t]);
    setDraft("");
  }
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5">
      {value.map((tag) => (
        <span key={tag} className="flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px]">
          {tag}
          <button
            type="button"
            aria-label={`Remove skill ${tag}`}
            className="text-muted-foreground hover:text-foreground"
            disabled={disabled}
            onClick={() => onChange(value.filter((v) => v !== tag))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        id="ce-profile-skills"
        value={draft}
        disabled={disabled}
        placeholder={value.length === 0 ? "Type a skill and press Enter" : "Add…"}
        aria-label="Add a skill"
        className="min-w-24 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => add(draft)}
      />
    </div>
  );
}

// ---------------------------------------------------------------- main panel

export function ContentEditor({
  config, activePage, disabled = false, categoryOptions,
  onNameChange, onTaglineChange, updateSection,
  profile, profileSaving, onProfileSave,
}: ContentEditorProps) {
  const [openSectionId, setOpenSectionId] = useState<string | null>(null);

  const sections = activePage?.sections ?? [];
  const openSection = sections.find((s) => s.id === openSectionId) ?? null;

  return (
    <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 pb-8 pt-3" style={{ scrollbarWidth: "thin" }}>
      {/* clarity: content edits vs code changes */}
      <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <UserRound className="size-3.5" aria-hidden /> Content editing
        </p>
        <p className="mt-1">
          Direct edits to your website's words and items — saved with the top bar
          (<span className="text-foreground">Save draft</span> / <span className="text-foreground">Discard</span>) and previewed
          on the site canvas. AI code changes made in CODE GIFTZ are separate, isolated proposals.
        </p>
      </div>

      {/* 1. website identity */}
      <PanelGroup title="Website identity" defaultOpen>
        <FieldRow label="Website title" htmlFor="ce-site-name">
          <Input
            id="ce-site-name"
            value={config.name}
            maxLength={80}
            className="h-8 text-xs"
            disabled={disabled}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </FieldRow>
        <FieldRow label="Tagline" htmlFor="ce-site-tagline">
          <Input
            id="ce-site-tagline"
            value={config.tagline}
            maxLength={160}
            placeholder="One line under the title (optional)"
            className="h-8 text-xs"
            disabled={disabled}
            onChange={(e) => onTaglineChange(e.target.value)}
          />
        </FieldRow>
      </PanelGroup>

      {/* 2. section content of the active page */}
      <PanelGroup title={`Section content${activePage ? ` · ${activePage.name}` : ""}`} count={sections.length} defaultOpen>
        {sections.length === 0 && (
          <p className="text-xs text-muted-foreground">This page has no sections yet.</p>
        )}
        <div className="space-y-1.5">
          {sections.map((s) => {
            const open = openSectionId === s.id;
            return (
              <div key={s.id} className={cn("rounded-lg border", open ? "border-primary/40 bg-gold-soft/20" : "border-border/50")}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left"
                  aria-expanded={open}
                  onClick={() => setOpenSectionId(open ? null : s.id)}
                >
                  <span className="min-w-0">
                    <span className="block text-[10px] font-semibold uppercase tracking-wider text-primary">
                      {SECTION_TYPE_LABELS[s.type]}
                    </span>
                    <span className="mt-0.5 block truncate text-xs font-medium">{s.title || "(untitled)"}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      <SectionSummary section={s} />
                    </span>
                  </span>
                  <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
                </button>
                {open && (
                  <div className="border-t border-border/40 px-2.5 pb-3 pt-2.5">
                    <SectionContentFields
                      section={s}
                      disabled={disabled}
                      categoryOptions={categoryOptions}
                      onChange={(patch) => updateSection(s.id, patch)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {openSection && (
          <p className="text-[11px] text-muted-foreground">
            Editing the {SECTION_TYPE_LABELS[openSection.type]} section — changes appear on the site canvas immediately and
            save with the top bar.
          </p>
        )}
      </PanelGroup>

      {/* 3. profile content (shared identity) */}
      {profile && (
        <PanelGroup title="Profile content" icon={<UserRound className="size-3.5" aria-hidden />} defaultOpen={false}>
          <ProfileEditor
            key={JSON.stringify(profile)}
            profile={profile}
            saving={profileSaving}
            disabled={disabled}
            onSave={onProfileSave}
          />
        </PanelGroup>
      )}
    </div>
  );
}
