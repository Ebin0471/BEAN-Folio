"use client";

/**
 * SectionEditor — the per-section content editor.
 *
 * MOVED from the old WebsiteBuilderView Content tab: every real editing
 * capability (hero variant/subtitle/CTA, about/contact body, projects
 * layout/category/limit, featured-work curation, video reel selection,
 * collections limit, gallery source/layout/limit, services items, experience
 * entries, testimonials quotes, per-section motion override, per-section
 * style overrides) with identical update semantics. Sections drive the REAL
 * SiteRenderer.
 */

import { useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { categoryLabel } from "@/lib/categories";
import { api, uploadFile } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { cn } from "@/lib/utils";
import type { ProjectCardDTO } from "@/lib/types";
import type { SiteConfig, SiteSection } from "@/lib/site-config";
import { SECTION_TYPE_HINTS, SECTION_TYPE_LABELS, FontSelect, MotionPicker, type LibraryPrefsApi } from "./controls";

export interface SectionEditorProps {
  section: SiteSection;
  /** Site-wide motion — the fallback for per-section override sliders. */
  siteMotion: SiteConfig["motion"];
  /** Site-wide theme — the fallback for per-section style overrides. */
  theme: SiteConfig["theme"];
  categoryOptions: string[];
  /**
   * The creator's published projects (owner-scoped) — powers the Featured
   * Work curation picker. Absent in contexts without project data.
   */
  projectOptions?: ProjectCardDTO[];
  onChange: (patch: Partial<SiteSection>) => void;
  libraryPrefs: LibraryPrefsApi;
}

export function SectionEditor({ section, siteMotion, theme, categoryOptions, projectOptions, onChange, libraryPrefs }: SectionEditorProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {SECTION_TYPE_LABELS[section.type]} section
        </p>
        <div className="flex items-center gap-1.5">
          <Switch
            id="sec-visible"
            checked={section.visible}
            onCheckedChange={(v) => onChange({ visible: v } as Partial<SiteSection>)}
            aria-label="Section visible"
          />
          <Label htmlFor="sec-visible" className="text-xs">Visible</Label>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sec-title">Title</Label>
        <Input
          id="sec-title"
          value={section.title}
          maxLength={120}
          onChange={(e) => onChange({ title: e.target.value } as Partial<SiteSection>)}
        />
      </div>

      {SECTION_TYPE_HINTS[section.type] && (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">{SECTION_TYPE_HINTS[section.type]}</p>
      )}

      {section.type === "hero" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="sec-variant">Hero style</Label>
            <Select value={section.variant ?? "classic"} onValueChange={(v) => onChange({ variant: v } as Partial<SiteSection>)}>
              <SelectTrigger id="sec-variant" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="classic">Classic</SelectItem>
                <SelectItem value="centered">Centered</SelectItem>
                <SelectItem value="split">Split</SelectItem>
                <SelectItem value="cover">Full-bleed cover</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-subtitle">Subtitle</Label>
            <Textarea
              id="sec-subtitle"
              value={section.subtitle}
              maxLength={280}
              className="min-h-16"
              placeholder="Supports {name} {headline} {location} {tagline}"
              onChange={(e) => onChange({ subtitle: e.target.value } as Partial<SiteSection>)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-cta">Button label (optional)</Label>
            <Input
              id="sec-cta"
              value={section.ctaLabel ?? ""}
              maxLength={40}
              placeholder="e.g. See my work"
              onChange={(e) => onChange({ ctaLabel: e.target.value } as Partial<SiteSection>)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-cta-href">Button link (optional)</Label>
            <Input
              id="sec-cta-href"
              value={section.ctaHref ?? ""}
              maxLength={300}
              placeholder="#bs-contact or https://example.com"
              onChange={(e) => onChange({ ctaHref: e.target.value } as Partial<SiteSection>)}
            />
            <p className="text-[10px] text-muted-foreground">
              An in-page anchor like #bs-contact (the contact section) or a full https:// URL. Empty = jumps to your contact section. Unsafe links are ignored.
            </p>
          </div>
        </>
      )}

      {(section.type === "about" || section.type === "contact") && (
        <div className="space-y-1.5">
          <Label htmlFor="sec-body">Body</Label>
          <Textarea
            id="sec-body"
            value={section.body}
            maxLength={section.type === "about" ? 4000 : 1200}
            className="min-h-32"
            placeholder="Supports {bio} {availability} {name}"
            onChange={(e) => onChange({ body: e.target.value } as Partial<SiteSection>)}
          />
        </div>
      )}

      {section.type === "projects" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="sec-layout">Layout</Label>
            <Select value={section.layout} onValueChange={(v) => onChange({ layout: v } as Partial<SiteSection>)}>
              <SelectTrigger id="sec-layout" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="grid">Grid</SelectItem>
                <SelectItem value="featured">Featured first</SelectItem>
                <SelectItem value="list">Editorial list</SelectItem>
                <SelectItem value="editorial">Image + text rows</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-category">Category filter (optional)</Label>
            <Select value={section.category || "all"} onValueChange={(v) => onChange({ category: v === "all" ? "" : v } as Partial<SiteSection>)}>
              <SelectTrigger id="sec-category" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categoryOptions.map((c) => (
                  <SelectItem key={c} value={c}>{categoryLabel(c)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-limit">Show up to {section.limit} projects</Label>
            <Slider id="sec-limit" value={[section.limit]} min={1} max={24} step={1} onValueChange={(v) => onChange({ limit: v[0] } as Partial<SiteSection>)} />
          </div>
        </>
      )}

      {section.type === "featured" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="sec-flayout">Layout</Label>
            <Select value={section.layout} onValueChange={(v) => onChange({ layout: v } as Partial<SiteSection>)}>
              <SelectTrigger id="sec-flayout" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="featured">First project large</SelectItem>
                <SelectItem value="grid">Grid</SelectItem>
                <SelectItem value="editorial">Image + text rows</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-fsubtitle">Subtitle (optional)</Label>
            <Input
              id="sec-fsubtitle"
              value={section.subtitle}
              maxLength={280}
              placeholder="A one-line introduction to your best work"
              onChange={(e) => onChange({ subtitle: e.target.value } as Partial<SiteSection>)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Featured projects (up to 6)</Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              An editorial showcase, independent from All Projects: only these projects render in this section. Leave
              it empty to show projects you have starred on the platform instead — never the whole collection.
            </p>
            {section.projectIds.length > 0 && (
              <ul className="space-y-1.5">
                {section.projectIds.map((pid, i) => {
                  const p = (projectOptions ?? []).find((x) => x.id === pid);
                  return (
                    <li key={pid} className="flex items-center gap-1 rounded-lg border border-border/60 p-2">
                      <span className="min-w-0 flex-1 truncate text-xs">{p?.title ?? pid}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground"
                        aria-label={`Move ${p?.title ?? "project"} up`}
                        disabled={i === 0}
                        onClick={() => {
                          const next = [...section.projectIds];
                          [next[i - 1], next[i]] = [next[i], next[i - 1]];
                          onChange({ projectIds: next } as Partial<SiteSection>);
                        }}
                      >
                        <ChevronUp className="size-3" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground"
                        aria-label={`Move ${p?.title ?? "project"} down`}
                        disabled={i === section.projectIds.length - 1}
                        onClick={() => {
                          const next = [...section.projectIds];
                          [next[i + 1], next[i]] = [next[i], next[i + 1]];
                          onChange({ projectIds: next } as Partial<SiteSection>);
                        }}
                      >
                        <ChevronDown className="size-3" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground hover:text-destructive"
                        aria-label={`Remove ${p?.title ?? "project"} from featured`}
                        onClick={() => onChange({ projectIds: section.projectIds.filter((x) => x !== pid) } as Partial<SiteSection>)}
                      >
                        <X className="size-3" aria-hidden />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-1.5">
              {(projectOptions ?? []).length === 0 ? (
                <p className="px-1.5 py-2 text-xs text-muted-foreground">
                  No published projects yet — publish projects to feature them here.
                </p>
              ) : (
                (projectOptions ?? []).map((p) => {
                  const checked = section.projectIds.includes(p.id);
                  const full = section.projectIds.length >= 6;
                  return (
                    <label
                      key={p.id}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-1.5 py-1.5 text-xs",
                        checked ? "bg-accent" : "hover:bg-accent/60",
                        !checked && full && "opacity-50"
                      )}
                    >
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={checked}
                        disabled={!checked && full}
                        onChange={() => {
                          if (checked) {
                            onChange({ projectIds: section.projectIds.filter((x) => x !== p.id) } as Partial<SiteSection>);
                          } else if (!full) {
                            onChange({ projectIds: [...section.projectIds, p.id] } as Partial<SiteSection>);
                          }
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                      {p.featured && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">starred</span>}
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}

      {section.type === "reel" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="sec-rlayout">Layout</Label>
            <Select value={section.layout} onValueChange={(v) => onChange({ layout: v } as Partial<SiteSection>)}>
              <SelectTrigger id="sec-rlayout" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="strip">Film strip</SelectItem>
                <SelectItem value="grid">Grid</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-rsubtitle">Subtitle (optional)</Label>
            <Input
              id="sec-rsubtitle"
              value={section.subtitle}
              maxLength={280}
              placeholder="A one-line introduction to your reel"
              onChange={(e) => onChange({ subtitle: e.target.value } as Partial<SiteSection>)}
            />
          </div>
          <ReelVideosEditor
            videos={section.videos}
            onChangeVideos={(videos) => onChange({ videos } as Partial<SiteSection>)}
          />
        </>
      )}

      {section.type === "collections" && (
        <div className="space-y-1.5">
          <Label htmlFor="sec-climit">Show up to {section.limit} collections</Label>
          <Slider id="sec-climit" value={[section.limit]} min={1} max={12} step={1} onValueChange={(v) => onChange({ limit: v[0] } as Partial<SiteSection>)} />
        </div>
      )}

      {section.type === "gallery" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="sec-gsource">Image source</Label>
            <Select value={section.source} onValueChange={(v) => onChange({ source: v } as Partial<SiteSection>)}>
              <SelectTrigger id="sec-gsource" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="projects">Project covers</SelectItem>
                <SelectItem value="collections">Collection items</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-glayout">Layout</Label>
            <Select value={section.layout} onValueChange={(v) => onChange({ layout: v } as Partial<SiteSection>)}>
              <SelectTrigger id="sec-glayout" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="masonry">Masonry</SelectItem>
                <SelectItem value="grid">Grid</SelectItem>
                <SelectItem value="strip">Film strip</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-glimit">Show up to {section.limit} images</Label>
            <Slider id="sec-glimit" value={[section.limit]} min={1} max={24} step={1} onValueChange={(v) => onChange({ limit: v[0] } as Partial<SiteSection>)} />
          </div>
        </>
      )}

      {section.type === "services" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="sec-slayout">Layout</Label>
            <Select value={section.layout} onValueChange={(v) => onChange({ layout: v } as Partial<SiteSection>)}>
              <SelectTrigger id="sec-slayout" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cards">Cards</SelectItem>
                <SelectItem value="rows">Numbered rows</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {section.items.map((item, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/60 p-3">
              <div className="flex items-center justify-between">
                <Label htmlFor={`sec-sv-t-${i}`} className="text-xs text-muted-foreground">Service {i + 1}</Label>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label={`Remove service ${i + 1}`} onClick={() => onChange({ items: section.items.filter((_, j) => j !== i) } as Partial<SiteSection>)}>
                  <X className="size-3" aria-hidden />
                </Button>
              </div>
              <Input
                id={`sec-sv-t-${i}`}
                value={item.title}
                maxLength={80}
                placeholder="Service title"
                onChange={(e) => onChange({ items: section.items.map((it, j) => (j === i ? { ...it, title: e.target.value } : it)) } as Partial<SiteSection>)}
              />
              <Textarea
                value={item.description}
                maxLength={300}
                className="min-h-14"
                placeholder="One or two lines describing it"
                onChange={(e) => onChange({ items: section.items.map((it, j) => (j === i ? { ...it, description: e.target.value } : it)) } as Partial<SiteSection>)}
              />
            </div>
          ))}
          {section.items.length < 8 && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                // Schema-valid defaults (title min(1) server-side): the new
                // service renders immediately and saves without blocking.
                onChange({ items: [...section.items, { title: "New service", description: "" }] } as Partial<SiteSection>)
              }
            >
              <Plus className="size-3.5" aria-hidden /> Add service
            </Button>
          )}
        </>
      )}

      {section.type === "experience" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="sec-elayout">Layout</Label>
            <Select value={section.layout} onValueChange={(v) => onChange({ layout: v } as Partial<SiteSection>)}>
              <SelectTrigger id="sec-elayout" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="timeline">Timeline</SelectItem>
                <SelectItem value="rows">Rows</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {section.entries.map((entry, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/60 p-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Entry {i + 1}</Label>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label={`Remove entry ${i + 1}`} onClick={() => onChange({ entries: section.entries.filter((_, j) => j !== i) } as Partial<SiteSection>)}>
                  <X className="size-3" aria-hidden />
                </Button>
              </div>
              <Input
                value={entry.role}
                maxLength={80}
                placeholder="Role or degree"
                aria-label={`Role for entry ${i + 1}`}
                onChange={(e) => onChange({ entries: section.entries.map((en, j) => (j === i ? { ...en, role: e.target.value } : en)) } as Partial<SiteSection>)}
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={entry.org}
                  maxLength={80}
                  placeholder="Company / school"
                  aria-label={`Organization for entry ${i + 1}`}
                  onChange={(e) => onChange({ entries: section.entries.map((en, j) => (j === i ? { ...en, org: e.target.value } : en)) } as Partial<SiteSection>)}
                />
                <Input
                  value={entry.period}
                  maxLength={40}
                  placeholder="2021 — now"
                  aria-label={`Period for entry ${i + 1}`}
                  onChange={(e) => onChange({ entries: section.entries.map((en, j) => (j === i ? { ...en, period: e.target.value } : en)) } as Partial<SiteSection>)}
                />
              </div>
              <Textarea
                value={entry.description}
                maxLength={400}
                className="min-h-14"
                placeholder="One line about it (optional)"
                onChange={(e) => onChange({ entries: section.entries.map((en, j) => (j === i ? { ...en, description: e.target.value } : en)) } as Partial<SiteSection>)}
              />
            </div>
          ))}
          {section.entries.length < 10 && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                // Schema-valid default (role min(1) server-side).
                onChange({ entries: [...section.entries, { role: "New role", org: "", period: "", description: "" }] } as Partial<SiteSection>)
              }
            >
              <Plus className="size-3.5" aria-hidden /> Add entry
            </Button>
          )}
        </>
      )}

      {section.type === "testimonials" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="sec-tlayout">Layout</Label>
            <Select value={section.layout} onValueChange={(v) => onChange({ layout: v } as Partial<SiteSection>)}>
              <SelectTrigger id="sec-tlayout" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cards">Cards</SelectItem>
                <SelectItem value="stack">Large quotes</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {section.items.map((item, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/60 p-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Quote {i + 1}</Label>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label={`Remove quote ${i + 1}`} onClick={() => onChange({ items: section.items.filter((_, j) => j !== i) } as Partial<SiteSection>)}>
                  <X className="size-3" aria-hidden />
                </Button>
              </div>
              <Textarea
                value={item.quote}
                maxLength={500}
                className="min-h-16"
                placeholder="The genuine quote"
                onChange={(e) => onChange({ items: section.items.map((it, j) => (j === i ? { ...it, quote: e.target.value } : it)) } as Partial<SiteSection>)}
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={item.name}
                  maxLength={80}
                  placeholder="Who said it"
                  aria-label={`Name for quote ${i + 1}`}
                  onChange={(e) => onChange({ items: section.items.map((it, j) => (j === i ? { ...it, name: e.target.value } : it)) } as Partial<SiteSection>)}
                />
                <Input
                  value={item.role}
                  maxLength={80}
                  placeholder="Their role (optional)"
                  aria-label={`Role for quote ${i + 1}`}
                  onChange={(e) => onChange({ items: section.items.map((it, j) => (j === i ? { ...it, role: e.target.value } : it)) } as Partial<SiteSection>)}
                />
              </div>
            </div>
          ))}
          {section.items.length < 8 && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                // Schema-valid defaults (quote/name min(1) server-side).
                onChange({ items: [...section.items, { quote: "Their words about working with you.", name: "Client name", role: "" }] } as Partial<SiteSection>)
              }
            >
              <Plus className="size-3.5" aria-hidden /> Add quote
            </Button>
          )}
        </>
      )}

      {section.type === "process" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="sec-proc-layout">Layout</Label>
            <Select value={section.layout} onValueChange={(v) => onChange({ layout: v } as Partial<SiteSection>)}>
              <SelectTrigger id="sec-proc-layout" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="steps">Numbered rail</SelectItem>
                <SelectItem value="numbers">Big-number cards</SelectItem>
                <SelectItem value="grid">Simple cards</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {section.items.map((item, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/60 p-3">
              <div className="flex items-center justify-between">
                <Label htmlFor={`sec-proc-t-${i}`} className="text-xs text-muted-foreground">Step {i + 1}</Label>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label={`Remove step ${i + 1}`} onClick={() => onChange({ items: section.items.filter((_, j) => j !== i) } as Partial<SiteSection>)}>
                  <X className="size-3" aria-hidden />
                </Button>
              </div>
              <Input
                id={`sec-proc-t-${i}`}
                value={item.title}
                maxLength={80}
                placeholder="Step name"
                onChange={(e) => onChange({ items: section.items.map((it, j) => (j === i ? { ...it, title: e.target.value } : it)) } as Partial<SiteSection>)}
              />
              <Textarea
                value={item.description}
                maxLength={400}
                className="min-h-14"
                placeholder="What happens in this step (optional)"
                onChange={(e) => onChange({ items: section.items.map((it, j) => (j === i ? { ...it, description: e.target.value } : it)) } as Partial<SiteSection>)}
              />
            </div>
          ))}
          {section.items.length < 8 && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                // Schema-valid default (title min(1) server-side).
                onChange({ items: [...section.items, { title: "New step", description: "" }] } as Partial<SiteSection>)
              }
            >
              <Plus className="size-3.5" aria-hidden /> Add step
            </Button>
          )}
        </>
      )}

      {section.type === "faq" && (
        <>
          {section.items.map((item, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/60 p-3">
              <div className="flex items-center justify-between">
                <Label htmlFor={`sec-faq-q-${i}`} className="text-xs text-muted-foreground">Question {i + 1}</Label>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label={`Remove question ${i + 1}`} onClick={() => onChange({ items: section.items.filter((_, j) => j !== i) } as Partial<SiteSection>)}>
                  <X className="size-3" aria-hidden />
                </Button>
              </div>
              <Input
                id={`sec-faq-q-${i}`}
                value={item.question}
                maxLength={200}
                placeholder="The question"
                onChange={(e) => onChange({ items: section.items.map((it, j) => (j === i ? { ...it, question: e.target.value } : it)) } as Partial<SiteSection>)}
              />
              <Textarea
                value={item.answer}
                maxLength={800}
                className="min-h-14"
                placeholder="The answer, in your own words"
                onChange={(e) => onChange({ items: section.items.map((it, j) => (j === i ? { ...it, answer: e.target.value } : it)) } as Partial<SiteSection>)}
              />
            </div>
          ))}
          {section.items.length < 10 && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                // Schema-valid default (question min(1) server-side).
                onChange({ items: [...section.items, { question: "A question clients actually ask", answer: "" }] } as Partial<SiteSection>)
              }
            >
              <Plus className="size-3.5" aria-hidden /> Add question
            </Button>
          )}
        </>
      )}

      {section.type === "pricing" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="sec-prc-layout">Layout</Label>
            <Select value={section.layout} onValueChange={(v) => onChange({ layout: v } as Partial<SiteSection>)}>
              <SelectTrigger id="sec-prc-layout" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cards">Cards</SelectItem>
                <SelectItem value="rows">Rows</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {section.tiers.map((tier, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/60 p-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Tier {i + 1}</Label>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label={`Remove tier ${i + 1}`} onClick={() => onChange({ tiers: section.tiers.filter((_, j) => j !== i) } as Partial<SiteSection>)}>
                  <X className="size-3" aria-hidden />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={tier.name}
                  maxLength={80}
                  placeholder="Tier name"
                  aria-label={`Name for tier ${i + 1}`}
                  onChange={(e) => onChange({ tiers: section.tiers.map((t, j) => (j === i ? { ...t, name: e.target.value } : t)) } as Partial<SiteSection>)}
                />
                <Input
                  value={tier.price}
                  maxLength={40}
                  placeholder="Price (e.g. $900)"
                  aria-label={`Price for tier ${i + 1}`}
                  onChange={(e) => onChange({ tiers: section.tiers.map((t, j) => (j === i ? { ...t, price: e.target.value } : t)) } as Partial<SiteSection>)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={tier.period}
                  maxLength={40}
                  placeholder="Period (e.g. /project)"
                  aria-label={`Period for tier ${i + 1}`}
                  onChange={(e) => onChange({ tiers: section.tiers.map((t, j) => (j === i ? { ...t, period: e.target.value } : t)) } as Partial<SiteSection>)}
                />
                <Input
                  value={tier.ctaLabel}
                  maxLength={40}
                  placeholder="Button text (optional)"
                  aria-label={`Button text for tier ${i + 1}`}
                  onChange={(e) => onChange({ tiers: section.tiers.map((t, j) => (j === i ? { ...t, ctaLabel: e.target.value } : t)) } as Partial<SiteSection>)}
                />
              </div>
              <Textarea
                value={tier.description}
                maxLength={200}
                className="min-h-14"
                placeholder="One line about what's included"
                onChange={(e) => onChange({ tiers: section.tiers.map((t, j) => (j === i ? { ...t, description: e.target.value } : t)) } as Partial<SiteSection>)}
              />
              <Input
                value={tier.features.join(", ")}
                placeholder="Features, comma-separated"
                aria-label={`Features for tier ${i + 1} (comma-separated)`}
                onChange={(e) =>
                  onChange({
                    tiers: section.tiers.map((t, j) =>
                      j === i ? { ...t, features: e.target.value.split(",").map((f) => f.trim().slice(0, 80)).filter(Boolean).slice(0, 6) } : t
                    ),
                  } as Partial<SiteSection>)
                }
              />
              <div className="flex items-center justify-between">
                <Label htmlFor={`sec-tier-hl-${i}`} className="text-xs">Highlight this tier</Label>
                <Switch
                  id={`sec-tier-hl-${i}`}
                  checked={tier.highlighted}
                  onCheckedChange={(v) => onChange({ tiers: section.tiers.map((t, j) => (j === i ? { ...t, highlighted: v } : t)) } as Partial<SiteSection>)}
                />
              </div>
            </div>
          ))}
          {section.tiers.length < 4 && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                // Schema-valid default (name min(1) server-side).
                onChange({ tiers: [...section.tiers, { name: "New tier", price: "", period: "", description: "", features: [], ctaLabel: "", highlighted: false }] } as Partial<SiteSection>)
              }
            >
              <Plus className="size-3.5" aria-hidden /> Add tier
            </Button>
          )}
        </>
      )}

      {section.type === "logos" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="sec-logos-note">Note (optional)</Label>
            <Input
              id="sec-logos-note"
              value={section.note}
              maxLength={200}
              placeholder="A line about your clients"
              onChange={(e) => onChange({ note: e.target.value } as Partial<SiteSection>)}
            />
          </div>
          {section.items.map((item, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/60 p-3">
              <div className="flex items-center justify-between">
                <Label htmlFor={`sec-logo-n-${i}`} className="text-xs text-muted-foreground">Client {i + 1}</Label>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label={`Remove client ${i + 1}`} onClick={() => onChange({ items: section.items.filter((_, j) => j !== i) } as Partial<SiteSection>)}>
                  <X className="size-3" aria-hidden />
                </Button>
              </div>
              <Input
                id={`sec-logo-n-${i}`}
                value={item.name}
                maxLength={60}
                placeholder="Client name"
                onChange={(e) => onChange({ items: section.items.map((it, j) => (j === i ? { ...it, name: e.target.value } : it)) } as Partial<SiteSection>)}
              />
            </div>
          ))}
          {section.items.length < 12 && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                // Schema-valid default (name min(1) server-side). The live site
                // never invents clients — these rows hold the USER's names.
                onChange({ items: [...section.items, { name: "New client" }] } as Partial<SiteSection>)
              }
            >
              <Plus className="size-3.5" aria-hidden /> Add client
            </Button>
          )}
          <p className="text-[11px] text-muted-foreground">
            Real client names only — until you add them, the site shows clearly-labelled placeholders. GIFTZ never invents clients.
          </p>
        </>
      )}

      {(section.type === "skills" || section.type === "stats") && (
        <p className="text-xs text-muted-foreground">
          This section pulls straight from your profile data — manage skills and stats in{" "}
          <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => navigate("/folio")}>
            My Folio
          </button>
          .
        </p>
      )}

      {/* per-section animation override */}
      <div className="space-y-2.5 rounded-lg border border-border/60 p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Animation for this section</p>
        <MotionPicker
          id={`sec-motion-${section.id}`}
          label="Section motion"
          value={section.motion?.preset ?? "__inherit"}
          onChange={(v) =>
            onChange(
              // Picking a preset re-enables the section: a previously
              // disabled override ({disabled:true}) must not silently
              // swallow the newly chosen preset.
              { motion: v === "__inherit" ? undefined : { ...(section.motion ?? {}), preset: v, disabled: false } } as Partial<SiteSection>
            )
          }
          fav={libraryPrefs.prefs.fav.motion}
          recent={libraryPrefs.prefs.recent.motion}
          onToggleFav={(id) => libraryPrefs.toggleFav("motion", id)}
          onPick={() => undefined}
          allowInherit
        />
        {section.motion && (
          <>
            <div className="space-y-1">
              <Label htmlFor={`sec-motion-dur-${section.id}`} className="text-xs">
                Duration · {section.motion.duration ?? siteMotion.duration} ms
              </Label>
              <Slider
                id={`sec-motion-dur-${section.id}`}
                value={[section.motion.duration ?? siteMotion.duration]}
                min={150}
                max={1200}
                step={50}
                onValueChange={(v) => onChange({ motion: { ...section.motion!, duration: v[0] } } as Partial<SiteSection>)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`sec-motion-int-${section.id}`} className="text-xs">
                Intensity · {section.motion.intensity ?? siteMotion.intensity}%
              </Label>
              <Slider
                id={`sec-motion-int-${section.id}`}
                value={[section.motion.intensity ?? siteMotion.intensity]}
                min={0}
                max={100}
                step={5}
                onValueChange={(v) => onChange({ motion: { ...section.motion!, intensity: v[0] } } as Partial<SiteSection>)}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor={`sec-motion-off-${section.id}`} className="text-xs">No animation here</Label>
              <Switch
                id={`sec-motion-off-${section.id}`}
                checked={section.motion.disabled ?? false}
                onCheckedChange={(v) => onChange({ motion: { ...section.motion!, disabled: v } } as Partial<SiteSection>)}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-full px-2 text-[11px]"
              onClick={() => onChange({ motion: undefined } as Partial<SiteSection>)}
            >
              <RotateCcw className="size-3" aria-hidden /> Back to site-wide motion
            </Button>
          </>
        )}
      </div>

      {/* per-section style overrides (direct editing) — same controls as
          the site-wide Typography group, scoped to THIS section only */}
      <div className="space-y-2.5 rounded-lg border border-border/60 p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Style for this section</p>
        <p className="text-[11px] text-muted-foreground">Overrides for this section only — headings elsewhere keep the site-wide design.</p>
        <div className="space-y-1.5">
          <Label htmlFor={`sec-style-font-${section.id}`}>Heading font</Label>
          <FontSelect
            id={`sec-style-font-${section.id}`}
            label="Section heading font"
            value={section.style?.headingFont ?? theme.headingFont ?? theme.font}
            onChange={(id) => onChange({ style: { ...(section.style ?? {}), headingFont: id } } as Partial<SiteSection>)}
            fav={libraryPrefs.prefs.fav.font}
            recent={libraryPrefs.prefs.recent.font}
            onToggleFav={(id) => libraryPrefs.toggleFav("font", id)}
            onPick={(id) => libraryPrefs.pushRecent("font", id)}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor={`sec-style-weight-${section.id}`}>Heading weight</Label>
            <Select
              value={section.style?.headingWeight ?? theme.headingWeight}
              onValueChange={(v) =>
                onChange({ style: { ...(section.style ?? {}), headingWeight: v as "light" | "semibold" | "bold" } } as Partial<SiteSection>)
              }
            >
              <SelectTrigger id={`sec-style-weight-${section.id}`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="semibold">Semibold</SelectItem>
                <SelectItem value="bold">Bold</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`sec-style-color-${section.id}`}>Title color</Label>
            <div className="flex items-center gap-2">
              <input
                id={`sec-style-color-${section.id}`}
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(section.style?.titleColor ?? "") ? (section.style?.titleColor as string) : theme.foreground}
                onChange={(e) =>
                  onChange({ style: { ...(section.style ?? {}), titleColor: e.target.value } } as Partial<SiteSection>)
                }
                className="size-8 cursor-pointer rounded border border-border/60 bg-transparent"
                aria-label="Section title color"
              />
              <span className="w-[60px] font-mono text-[11px] text-muted-foreground">{section.style?.titleColor ?? "site"}</span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor={`sec-style-width-${section.id}`}>Section width</Label>
            <Select
              value={section.style?.width ?? "__site"}
              onValueChange={(v) =>
                onChange({ style: { ...(section.style ?? {}), width: v === "__site" ? undefined : (v as "narrow" | "regular" | "wide") } } as Partial<SiteSection>)
              }
            >
              <SelectTrigger id={`sec-style-width-${section.id}`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__site">Site default</SelectItem>
                <SelectItem value="narrow">Narrow</SelectItem>
                <SelectItem value="regular">Regular</SelectItem>
                <SelectItem value="wide">Wide</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`sec-style-spacing-${section.id}`}>Vertical spacing</Label>
            <Select
              value={section.style?.spacing ?? "__site"}
              onValueChange={(v) =>
                onChange({ style: { ...(section.style ?? {}), spacing: v === "__site" ? undefined : (v as "compact" | "regular" | "relaxed") } } as Partial<SiteSection>)
              }
            >
              <SelectTrigger id={`sec-style-spacing-${section.id}`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__site">Site default</SelectItem>
                <SelectItem value="compact">Compact</SelectItem>
                <SelectItem value="regular">Regular</SelectItem>
                <SelectItem value="relaxed">Relaxed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`sec-style-halign-${section.id}`}>Heading alignment</Label>
            <Select
              value={section.style?.headingAlign ?? "__site"}
              onValueChange={(v) =>
                onChange({ style: { ...(section.style ?? {}), headingAlign: v === "__site" ? undefined : (v as "left" | "center") } } as Partial<SiteSection>)
              }
            >
              <SelectTrigger id={`sec-style-halign-${section.id}`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__site">Site default</SelectItem>
                <SelectItem value="left">Left</SelectItem>
                <SelectItem value="center">Centered</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`sec-style-bg-${section.id}`}>Background</Label>
            <Select
              value={
                section.style?.background == null ? "__site"
                : section.style.background === "none" || section.style.background === "surface" || section.style.background === "wash"
                  ? section.style.background
                  : "__custom"
              }
              onValueChange={(v) =>
                onChange({
                  style: {
                    ...(section.style ?? {}),
                    background:
                      v === "__site" ? undefined
                      : v === "__custom" ? (/^#[0-9a-fA-F]{6}$/.test(section.style?.background ?? "") ? section.style?.background : theme.surface)
                      : (v as "none" | "surface" | "wash"),
                  },
                } as Partial<SiteSection>)
              }
            >
              <SelectTrigger id={`sec-style-bg-${section.id}`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__site">Site default</SelectItem>
                <SelectItem value="none">Transparent</SelectItem>
                <SelectItem value="surface">Surface color</SelectItem>
                <SelectItem value="wash">Accent wash</SelectItem>
                <SelectItem value="__custom">Custom color…</SelectItem>
              </SelectContent>
            </Select>
            {section.style?.background != null &&
              !["none", "surface", "wash"].includes(section.style.background as string) && (
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(section.style.background as string) ? (section.style.background as string) : "#000000"}
                  onChange={(e) =>
                    onChange({ style: { ...(section.style ?? {}), background: e.target.value } } as Partial<SiteSection>)
                  }
                  className="size-8 cursor-pointer rounded border border-border/60 bg-transparent"
                  aria-label="Section background color"
                />
                <span className="w-[60px] font-mono text-[11px] text-muted-foreground">{section.style.background as string}</span>
              </div>
            )}
          </div>
        </div>
        {section.style && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-full px-2 text-[11px]"
            onClick={() => onChange({ style: undefined } as Partial<SiteSection>)}
          >
            <RotateCcw className="size-3" aria-hidden /> Back to site-wide style
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Reel video picker — the creator's own VIDEO media assets, up to five, in
 * creator-controlled order. Two sources: the Studio asset library
 * (GET /api/media?kind=VIDEO — owner-scoped) and a direct upload through the
 * platform's existing upload transport (multipart with presigned fallback).
 * Every entry is a real MediaAsset id; ownership and VIDEO-kind are enforced
 * again server-side at the save boundary, so a stale or foreign id can never
 * reach a published page.
 */
function ReelVideosEditor({
  videos,
  onChangeVideos,
}: {
  videos: { mediaId: string; caption: string }[];
  onChangeVideos: (next: { mediaId: string; caption: string }[]) => void;
}) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState<{ id: string; filename: string }[] | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const full = videos.length >= 5;

  async function loadLibrary() {
    setLibraryLoading(true);
    try {
      const res = await api<{ assets: { id: string; filename: string }[]; total: number }>(
        "/api/media?kind=VIDEO&limit=60"
      );
      setLibrary(res.assets);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load your video library");
      setLibrary([]);
    } finally {
      setLibraryLoading(false);
    }
  }

  function toggleLibrary() {
    const next = !libraryOpen;
    setLibraryOpen(next);
    if (next && library === null) void loadLibrary();
  }

  async function onUpload(file: File) {
    if (full) {
      toast.warning("The reel holds up to five videos — remove one first.");
      return;
    }
    setUploading(true);
    try {
      const res = await uploadFile(file);
      onChangeVideos([...videos, { mediaId: res.media.id, caption: "" }]);
      setLibrary((l) => (l ? [{ id: res.media.id, filename: file.name }, ...l.filter((x) => x.id !== res.media.id)] : l));
      toast.success("Video added to the reel");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= videos.length) return;
    const next = [...videos];
    [next[i], next[j]] = [next[j], next[i]];
    onChangeVideos(next);
  }

  return (
    <div className="space-y-1.5">
      <Label>Reel videos ({videos.length}/5)</Label>
      {videos.length > 0 && (
        <ul className="space-y-1.5">
          {videos.map((v, i) => (
            <li key={`${v.mediaId}-${i}`} className="space-y-1.5 rounded-lg border border-border/60 p-2">
              <div className="flex items-center gap-2">
                <video
                  src={`/api/media/${encodeURIComponent(v.mediaId)}/raw`}
                  className="h-10 w-16 shrink-0 rounded border border-border/60 bg-black object-cover"
                  muted
                  playsInline
                  preload="metadata"
                  aria-label={`Reel video ${i + 1}`}
                />
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  Video {i + 1} · {v.mediaId.slice(0, 10)}…
                </span>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground" aria-label={`Move video ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ChevronUp className="size-3" aria-hidden />
                </Button>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground" aria-label={`Move video ${i + 1} down`} disabled={i === videos.length - 1} onClick={() => move(i, 1)}>
                  <ChevronDown className="size-3" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove video ${i + 1} from the reel`}
                  onClick={() => onChangeVideos(videos.filter((_, j) => j !== i))}
                >
                  <X className="size-3" aria-hidden />
                </Button>
              </div>
              <Input
                value={v.caption}
                maxLength={160}
                placeholder="Caption (optional)"
                aria-label={`Caption for video ${i + 1}`}
                onChange={(e) => onChangeVideos(videos.map((x, j) => (j === i ? { ...x, caption: e.target.value } : x)))}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={full || uploading} onClick={() => fileRef.current?.click()}>
          <Upload className="size-3.5" aria-hidden /> {uploading ? "Uploading…" : "Upload video"}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={full} onClick={toggleLibrary} aria-expanded={libraryOpen}>
          <Plus className="size-3.5" aria-hidden /> {libraryOpen ? "Hide library" : "From library"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/webm,video/quicktime"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onUpload(f);
          }}
        />
      </div>
      {full && <p className="text-xs text-muted-foreground">Reel is full (5/5) — remove a video to add another.</p>}
      {libraryOpen && (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-1.5">
          {libraryLoading ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">Loading your videos…</p>
          ) : (library ?? []).length === 0 ? (
            <p className="px-1.5 py-2 text-xs text-muted-foreground">
              No videos in your asset library yet — upload one above.
            </p>
          ) : (
            (library ?? []).map((a) => {
              const already = videos.some((v) => v.mediaId === a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={already || full}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs transition-colors",
                    already ? "opacity-50" : "hover:bg-accent"
                  )}
                  onClick={() => {
                    onChangeVideos([...videos, { mediaId: a.id, caption: "" }]);
                    setLibraryOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                  {already && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">in reel</span>}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
