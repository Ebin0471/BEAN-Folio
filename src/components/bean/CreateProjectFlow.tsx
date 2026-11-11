"use client";

import { useMemo, useState } from "react";
import { LayoutTemplate, Search, Sparkles, Wand2 } from "lucide-react";

import { navigate } from "@/lib/hash-router";
import { useSession } from "@/lib/session";
import { categoryLabel } from "@/lib/categories";
import {
  familyForProfession,
  kindLabel,
  workProfileForFamily,
  workProfileForProfessions,
  type ProjectKind,
} from "@/lib/studio-schema";
import {
  familyIndustryLabel,
  searchTemplates,
  templateSuggestedFields,
  templatesForFamily,
  type ProjectTemplate,
} from "@/lib/studio-templates";
import type { SuggestedField } from "@/lib/studio-schema";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * SessionStorage intent handed from the creation flow to the project editor:
 * the editor consumes and clears it once on mount. (The hash router strips
 * query params, so a storage handoff keeps /studio/new as the single URL.)
 */
export const STUDIO_INTENT_KEY = "bean:studio-intent";

export interface StudioIntent {
  kind?: string;
  templateId?: string;
  /** Profession-slug category prefilled from the creator's first profession (consumed by the editor). */
  category?: string;
}

export function storeStudioIntent(intent: StudioIntent): void {
  try {
    window.sessionStorage.setItem(STUDIO_INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* storage unavailable — the editor simply starts blank */
  }
}

// ------------------------------------------------------------------ parts

function KindCard({
  kind,
  selected,
  onSelect,
}: {
  kind: ProjectKind;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-testid={`cp-kind-${kind.slug}`}
      className={cn(
        "rounded-xl border p-3.5 text-left transition-colors",
        selected
          ? "border-primary/60 bg-gold-soft/40"
          : "border-border/60 bg-card hover:border-primary/30"
      )}
    >
      <p className="text-sm font-medium leading-tight">{kind.label}</p>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{kind.description}</p>
    </button>
  );
}

function TemplateStructurePreview({ template }: { template: ProjectTemplate }) {
  // A miniature wireframe of the template's SHAPE — sections derive from the
  // guidance keys (order: brief → process → challenges → outcome), plus a
  // tag row when skills/tools are suggested. Pure presentation: same look
  // for every profession, gold accents per BEAN Folio identity.
  const sections = (
    ["brief", "process", "challenges", "outcome"] as const
  ).filter((k) => template.guides?.[k]);
  const hasTags = Boolean(template.skills?.length || template.tools?.length);
  const hasFields = Boolean(template.suggestedFieldKeys?.length);

  return (
    <div
      aria-hidden="true"
      className="rounded-lg border border-border/50 bg-background/60 p-3"
      title={`Structure: ${sections.length} narrative section${sections.length === 1 ? "" : "s"}${hasFields ? ", profession fields" : ""}${hasTags ? ", starter tags" : ""}`}
    >
      <div className="h-2 w-3/5 rounded-full bg-primary/35" />
      <div className="mt-2 space-y-1.5">
        {sections.map((s, i) => (
          <div
            key={s}
            className="flex items-center gap-1.5"
            style={{ marginLeft: `${i * 6}px` }}
          >
            <span className="size-1.5 shrink-0 rounded-full bg-primary/50" />
            <span
              className="h-1.5 rounded-full bg-muted-foreground/25"
              style={{ width: `${72 - i * 9}%` }}
            />
          </div>
        ))}
      </div>
      {(hasTags || hasFields) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {hasFields && <span className="h-2 w-10 rounded-full bg-primary/25" />}
          {hasTags && <span className="h-2 w-8 rounded-full bg-muted-foreground/20" />}
          {hasTags && <span className="h-2 w-12 rounded-full bg-muted-foreground/20" />}
        </div>
      )}
    </div>
  );
}

function TemplateCard({
  template,
  fields,
  industryLabels,
  matchesProfession,
  onUse,
}: {
  template: ProjectTemplate;
  fields: SuggestedField[];
  industryLabels: string[];
  matchesProfession: boolean;
  onUse: () => void;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-border/60 bg-card p-4" data-testid={`cp-template-${template.id}`}>
      <TemplateStructurePreview template={template} />
      <div className="mt-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{template.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {template.style} · {industryLabels[0] ?? "Universal"}
          </p>
        </div>
        <Badge variant="outline" className="shrink-0 rounded-full text-[10px] font-normal">
          <LayoutTemplate className="mr-1 size-3" aria-hidden /> Template
        </Badge>
      </div>
      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{template.description}</p>
      <p className="mt-2 text-[11px] text-muted-foreground">
        <span className="text-foreground/70">Compatible with:</span>{" "}
        {industryLabels.length > 0 ? industryLabels.slice(0, 3).join(", ") : "every profession"}
      </p>
      {fields.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Adds fields: {fields.map((f) => f.label).join(", ")}
        </p>
      )}
      {matchesProfession && (
        <p className="mt-2 inline-flex w-fit items-center gap-1 rounded-full bg-gold-soft/60 px-2 py-0.5 text-[10px] font-medium text-primary ring-1 ring-primary/20">
          <Sparkles className="size-3" aria-hidden /> Recommended for you
        </p>
      )}
      <div className="mt-3 flex justify-end">
        <Button type="button" size="sm" variant="outline" onClick={onUse}>
          <Wand2 className="size-3.5 text-primary" aria-hidden /> Use template
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ view

/**
 * CreateProjectFlow — the profession-aware front door of the EXISTING Studio.
 *
 * Opened by the current "New project" action (no new navigation entry, no new
 * page): it reads the creator's declared professions, shows the work types
 * their family schema actually uses, recommends matching templates and hands
 * the choice to the existing editor via a sessionStorage intent. "Start
 * blank" keeps the old direct path intact.
 *
 * Transient state lives in an inner component that mounts only while the
 * dialog is open (Radix unmounts content on close), so every open starts
 * fresh without setState-in-effect resets.
 */
export default function CreateProjectFlow({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <CreateFlowInner onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function CreateFlowInner({ onClose }: { onClose: () => void }) {
  const { user, loading } = useSession();
  const [query, setQuery] = useState("");
  const [selectedKind, setSelectedKind] = useState<string | null>(null);

  const profile = useMemo(() => workProfileForProfessions(user?.professions ?? []), [user]);
  const hasProfession = (user?.professions?.length ?? 0) > 0;

  const kinds = profile.projectKinds;
  const recommendedCount = Math.max(kinds.length - 6, 0); // universal kinds close the list
  const recommended = kinds.slice(0, recommendedCount);
  const universal = kinds.slice(recommendedCount);

  const templates = useMemo(() => {
    const familySlug = hasProfession ? profile.familySlug : null;
    // Specialization-aware ranking: the creator's first declared profession
    // narrows matches when a template targets specific professions.
    const professionSlug = user?.professions?.[0] ?? null;
    return searchTemplates(query, { familySlug, professionSlug });
  }, [query, profile.familySlug, hasProfession, user]);

  /**
   * The declared profession whose family actually OWNS the selected work
   * kind — this seeds the editor's schema so the fields match the work
   * being recorded (picking “Showreel” must open the film fields, not the
   * developer's stack/repo fields). Falls back to the first declared
   * profession, then to undefined (editor derives from the session user).
   */
  function professionForKind(kindSlug: string | undefined): string | undefined {
    const declared = user?.professions ?? [];
    if (!kindSlug) return declared[0] ?? undefined;
    const owner = declared.find((slug) => {
      const fam = familyForProfession(slug);
      return fam ? workProfileForFamily(fam).projectKinds.some((k) => k.slug === kindSlug) : false;
    });
    return owner ?? declared[0] ?? undefined;
  }

  function startKind(kindSlug: string) {
    // The category seeds the editor's profession-aware schema immediately —
    // kind + category together drive the relevant fields and templates.
    storeStudioIntent({ kind: kindSlug, category: professionForKind(kindSlug) });
    onClose();
    navigate("/studio/new");
  }

  function startTemplate(template: ProjectTemplate) {
    const effectiveKind = selectedKind ?? template.kinds[0];
    storeStudioIntent({
      kind: effectiveKind,
      templateId: template.id,
      // The template's own hint wins; otherwise the declared profession that
      // owns the template's work type keeps the editor schema consistent.
      category: template.categoryHint ?? professionForKind(effectiveKind),
    });
    onClose();
    navigate("/studio/new");
  }

  return (
    <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display">New project</DialogTitle>
          <DialogDescription>
            {loading
              ? "Reading your profession…"
              : hasProfession
                ? `Adapted for ${user!.professions
                    .map((p) => categoryLabel(p))
                    .slice(0, 2)
                    .join(" · ")} — pick the kind of work, or start from a template.`
                : "Pick the kind of work to record. Set a profession in Settings to tailor the Studio to your field."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          {/* ---- work kinds */}
          <section aria-label="Project types">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              What kind of work is this?
            </p>
            {loading ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2" aria-busy="true">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-[74px] rounded-xl" />
                ))}
              </div>
            ) : (
              <>
                {recommended.length > 0 && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {recommended.map((k) => (
                      <KindCard key={k.slug} kind={k} selected={selectedKind === k.slug} onSelect={() => setSelectedKind(k.slug)} />
                    ))}
                  </div>
                )}
                <details className="mt-2" open={recommended.length === 0}>
                  <summary className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground">
                    {recommended.length > 0 ? "More work types (universal)" : "All work types"}
                  </summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {universal.map((k) => (
                      <KindCard key={k.slug} kind={k} selected={selectedKind === k.slug} onSelect={() => setSelectedKind(k.slug)} />
                    ))}
                  </div>
                </details>
              </>
            )}
          </section>

          {/* ---- templates */}
          <section aria-label="Project templates">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Start from a template
            </p>
            <div className="relative mt-2">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by profession, industry, project type or style…"
                className="pl-9"
                aria-label="Search templates"
              />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {templates.slice(0, 8).map((t) => {
                const industries = t.families.filter((f) => f !== "*").map(familyIndustryLabel);
                return (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    fields={templateSuggestedFields(t, profile.suggestedFields)}
                    industryLabels={industries}
                    matchesProfession={
                      hasProfession &&
                      (t.professions?.some((p) => user!.professions.includes(p)) ?? false)
                    }
                    onUse={() => startTemplate(t)}
                  />
                );
              })}
            </div>
            {templates.length === 0 && (
              <p className="mt-3 rounded-lg border border-dashed border-border/70 bg-background/30 p-4 text-center text-sm text-muted-foreground">
                No templates match “{query}”. You can still start blank below.
              </p>
            )}
            {templates.length > 8 && (
              <p className="mt-2 text-xs text-muted-foreground">
                {templates.length - 8} more match — refine your search to see them.
              </p>
            )}
          </section>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Sparkles className="size-3.5 text-primary" aria-hidden />
            {selectedKind ? `Starting as “${kindLabel(profile, selectedKind)}”` : "Templates only fill empty fields — your words stay yours."}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                onClose();
                navigate("/studio/new");
              }}
              data-testid="cp-start-blank"
            >
              Start blank
            </Button>
            <Button disabled={!selectedKind} onClick={() => selectedKind && startKind(selectedKind)} data-testid="cp-continue-kind">
              Continue
            </Button>
          </div>
        </div>
      </DialogContent>
  );
}
