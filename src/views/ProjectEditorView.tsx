"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Crop,
  Eye,
  ImagePlus,
  LayoutTemplate,
  Loader2,
  Plus,
  Sparkles,
  Star,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { api, ApiError, uploadFile } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useSession } from "@/lib/session";
import { categoryLabel } from "@/lib/categories";
import {
  familyForProfession,
  fieldIsRelevant,
  kindLabel,
  UNIVERSAL_PROJECT_KINDS,
  workProfileForFamily,
  workProfileForProfessions,
  type FamilyWorkProfile,
  type SuggestedField,
  type StudioFieldKey,
} from "@/lib/studio-schema";
import {
  PROJECT_TEMPLATES,
  templateById,
  templateMerges,
  templatesForFamily,
  type ProjectTemplate,
  type TemplateNarrativeField,
} from "@/lib/studio-templates";
import type { CoverAdjust, FullProject, MediaDTO, ProjectCustomFields } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EmptyState } from "@/components/bean/EmptyState";
import { MediaThumb } from "@/components/bean/MediaThumb";
import { MediaUploadButton } from "@/components/bean/MediaUploadButton";
import { ProjectCoverEditor, cropCoverToBlob } from "@/components/bean/ProjectCoverEditor";
import { TagInput } from "@/components/bean/TagInput";
import { Progress } from "@/components/ui/progress";
import { useProfessionOptions } from "@/lib/use-professions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { STUDIO_INTENT_KEY, type StudioIntent } from "@/components/bean/CreateProjectFlow";

// ------------------------------------------------------------------ types

type Visibility = "PUBLIC" | "UNLISTED" | "PRIVATE";

interface MediaItem {
  mediaId: string;
  url: string;
  kind: string;
  mime?: string;
  caption: string;
}

interface Contributor {
  name: string;
  role: string;
  contribution: string;
}

/**
 * Dedicated project cover — independent of the media gallery. `mediaId`
 * points at a MediaAsset owned by the caller (a 16:9 derivative generated
 * from the uploaded original, or a gallery item chosen via "Set as cover").
 * `original` (client-only) keeps the untouched source image so the crop can
 * be re-adjusted later without re-uploading it.
 */
interface CoverState {
  mediaId: string | null;
  url: string | null;
  kind: string | null;
  original: { mediaId: string; url: string } | null;
}

const EMPTY_COVER: CoverState = { mediaId: null, url: null, kind: null, original: null };

const COVER_ACCEPT = "image/jpeg,image/png,image/webp";
const COVER_ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const COVER_MAX_BYTES = 8 * 1024 * 1024; // mirrors MEDIA_RULES.IMAGE

interface FormState {
  title: string;
  summary: string;
  category: string; // slug or ""
  visibility: Visibility;
  brief: string;
  process: string;
  challenges: string;
  outcome: string;
  role: string;
  description: string;
  skills: string[];
  tools: string[];
  externalUrl: string;
  repoUrl: string;
  contributors: Contributor[];
  media: MediaItem[];
  cover: CoverState;
  // ---- Universal Studio profession-aware state (additive) ----
  /** Work type slug from the profession schema (stored in customFields). */
  kind: string;
  /** Template provenance (stored in customFields). */
  templateId: string;
  /** Profession-specific structured fields, keyed by schema key. */
  suggested: Record<string, string>;
  /** User-defined custom fields. */
  custom: { label: string; value: string }[];
}

const EMPTY_FORM: FormState = {
  title: "",
  summary: "",
  category: "",
  visibility: "PUBLIC",
  brief: "",
  process: "",
  challenges: "",
  outcome: "",
  role: "",
  description: "",
  skills: [],
  tools: [],
  externalUrl: "",
  repoUrl: "",
  contributors: [],
  media: [],
  cover: EMPTY_COVER,
  kind: "",
  templateId: "",
  suggested: {},
  custom: [],
};

const LIMITS = {
  title: 140,
  summary: 200,
  description: 20000,
  brief: 6000,
  process: 6000,
  challenges: 6000,
  outcome: 6000,
  role: 120,
  url: 300,
};

const VISIBILITY_HELP: Record<Visibility, string> = {
  PUBLIC: "Discoverable on Discover, Explore and your public profile.",
  UNLISTED: "Anyone with the link can view — hidden from feeds and search.",
  PRIVATE: "Only you can see this project. Share work-in-progress safely.",
};

const KIND_LABELS: Record<string, string> = {
  IMAGE: "Image",
  VIDEO: "Video",
  AUDIO: "Audio",
  DOCUMENT: "Document",
};

const CUSTOM_FIELD_LIMITS = { label: 60, value: 600, max: 8 };

/** "clinical-experience" → "Clinical Experience" (fallback labels for fields from other schemas). */
function prettifyKey(key: string): string {
  return key
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Build the stored customFields envelope from form state (never emits empties). */
function buildCustomFieldsEnvelope(f: FormState): ProjectCustomFields | null {
  const envelope: ProjectCustomFields = {};
  if (f.kind.trim()) envelope.kind = f.kind.trim();
  if (f.templateId.trim()) envelope.templateId = f.templateId.trim();
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(f.suggested)) {
    if (v.trim()) fields[k] = v.trim().slice(0, CUSTOM_FIELD_LIMITS.value);
  }
  if (Object.keys(fields).length > 0) envelope.fields = fields;
  const custom = f.custom
    .filter((c) => c.label.trim() && c.value.trim())
    .slice(0, CUSTOM_FIELD_LIMITS.max)
    .map((c) => ({ label: c.label.trim().slice(0, CUSTOM_FIELD_LIMITS.label), value: c.value.trim().slice(0, CUSTOM_FIELD_LIMITS.value) }));
  if (custom.length > 0) envelope.custom = custom;
  return Object.keys(envelope).length > 0 ? envelope : null;
}

function snapshotOf(f: FormState): string {
  return JSON.stringify(f);
}

// ------------------------------------------------------------------ small parts

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span
      className={cn(
        "text-xs tabular-nums",
        value.length >= max ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {value.length}/{max}
    </span>
  );
}

function FieldLabel({
  htmlFor,
  children,
  hint,
  counter,
}: {
  htmlFor: string;
  children: React.ReactNode;
  hint?: string;
  counter?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <Label htmlFor={htmlFor}>{children}</Label>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {counter}
    </div>
  );
}

function FormSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading editor">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-xl border border-border/60 bg-card p-6">
          <Skeleton className="h-5 w-40" />
          <div className="mt-4 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-10 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ view

export default function ProjectEditorView({ projectId }: { projectId?: string }) {
  const { user } = useSession();
  const [loading, setLoading] = useState(Boolean(projectId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // Live category taxonomy (Profession table) — all real disciplines, not a static subset.
  const professionOptions = useProfessionOptions();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [snapshot, setSnapshot] = useState<string>(() => snapshotOf(EMPTY_FORM));
  const [savedId, setSavedId] = useState<string | null>(projectId ?? null);
  const [status, setStatus] = useState<"DRAFT" | "PUBLISHED">("DRAFT");

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // AI assist state — never auto-applied, always reviewed
  const [aiBusy, setAiBusy] = useState<"improve-description" | "improve-summary" | "suggest" | null>(null);
  const [improvePanel, setImprovePanel] = useState<{ field: "description" | "summary"; text: string } | null>(null);
  const [suggestPanel, setSuggestPanel] = useState<{ summary?: string; skills?: string[]; category?: string | null } | null>(null);

  // Dedicated cover state — upload → crop → optimized derivative
  const [coverBusy, setCoverBusy] = useState<"uploading" | null>(null);
  const [coverProgress, setCoverProgress] = useState(0);
  const [coverDialog, setCoverDialog] = useState<{
    open: boolean;
    src: string;
    saving: boolean;
    error: string | null;
  }>({ open: false, src: "", saving: false, error: null });
  const coverFileRef = useRef<HTMLInputElement>(null);
  // Asset used as the crop source for the open dialog (original upload or the
  // current cover). Client-only — lets a later re-crop reuse the same source.
  const cropSourceRef = useRef<{ mediaId: string; url: string } | null>(null);

  const formRef = useRef(form);
  useEffect(() => {
    formRef.current = form;
  }, [form]);

  const dirty = snapshotOf(form) !== snapshot;

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  // ---------------------------------------------------- profession schema

  /**
   * The active work profile: the chosen category's family leads when set
   * (the project belongs to that field); otherwise the creator's declared
   * professions. Universal fallback keeps every control working.
   */
  const userWorkProfile = useMemo(() => workProfileForProfessions(user?.professions ?? []), [user]);
  const activeProfile: FamilyWorkProfile = useMemo(() => {
    if (form.category) {
      const fam = familyForProfession(form.category);
      if (fam) return workProfileForFamily(fam);
    }
    return userWorkProfile;
  }, [form.category, userWorkProfile]);

  /** Template-derived structure: guidance placeholders + extra schema fields. */
  const activeTemplate = useMemo(
    () => (form.templateId ? templateById(form.templateId) : null),
    [form.templateId]
  );
  const activeGuides = activeTemplate?.guides ?? null;

  /** Structured fields rendered: the active schema plus any keys already saved. */
  const suggestedFieldDefs: SuggestedField[] = useMemo(() => {
    const defs = [...activeProfile.suggestedFields];
    const seen = new Set(defs.map((d) => d.key));
    for (const key of Object.keys(form.suggested)) {
      if (!seen.has(key)) {
        seen.add(key);
        defs.push({ key, label: prettifyKey(key), placeholder: "" });
      }
    }
    for (const key of activeTemplate?.suggestedFieldKeys ?? []) {
      if (!seen.has(key)) {
        seen.add(key);
        const fromProfile = activeProfile.suggestedFields.find((f) => f.key === key);
        defs.push(fromProfile ?? { key, label: prettifyKey(key), placeholder: "" });
      }
    }
    return defs;
  }, [activeProfile, form.suggested, activeTemplate]);

  /** Kind options: the active schema's kinds first, universal kinds after. */
  const kindOptions = useMemo(() => {
    const seen = new Set(activeProfile.projectKinds.map((k) => k.slug));
    return [...activeProfile.projectKinds, ...UNIVERSAL_PROJECT_KINDS.filter((k) => !seen.has(k.slug))];
  }, [activeProfile]);

  const kindLabelFor = useCallback(
    (slug: string | null | undefined): string => {
      if (!slug) return "";
      return (
        kindLabel(activeProfile, slug) ||
        kindLabel(userWorkProfile, slug) ||
        UNIVERSAL_PROJECT_KINDS.find((k) => k.slug === slug)?.label ||
        slug
      );
    },
    [activeProfile, userWorkProfile]
  );

  /** Label/placeholder override for an existing column under the active schema. */
  const fieldOverride = useCallback(
    (key: StudioFieldKey) => activeProfile.fieldOverrides[key] ?? {},
    [activeProfile]
  );

  /** Placeholder resolution: template guidance (empty fields only) → schema → static default. */
  const placeholderFor = useCallback(
    (key: TemplateNarrativeField, fallback: string): string => {
      const guide = activeGuides?.[key];
      if (guide && !formRef.current[key as keyof FormState]?.toString().trim()) return guide;
      return fieldOverride(key).placeholder ?? fallback;
    },
    [activeGuides, fieldOverride]
  );

  // ---------------------------------------------------- template applying

  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<ProjectTemplate | null>(null);

  const editorTemplates = useMemo(
    () => templatesForFamily(form.category ? familyForProfession(form.category) : null),
    [form.category]
  );

  function requestApplyTemplate(t: ProjectTemplate) {
    const merges = templateMerges(t, { skills: form.skills, tools: form.tools });
    if (merges.length > 0) {
      // Never touch existing tags without an explicit confirmation.
      setPendingTemplate(t);
      return;
    }
    applyTemplate(t);
    setTemplateDialogOpen(false);
  }

  function applyTemplate(t: ProjectTemplate) {
    setForm((f) => ({
      ...f,
      kind: f.kind || t.kinds[0] || f.kind,
      templateId: t.id,
      category: f.category || t.categoryHint || "",
      skills:
        t.skills?.length && f.skills.length === 0
          ? t.skills.slice(0, 15)
          : t.skills?.length
            ? Array.from(new Set([...f.skills, ...t.skills])).slice(0, 15)
            : f.skills,
      tools:
        t.tools?.length && f.tools.length === 0
          ? t.tools.slice(0, 15)
          : t.tools?.length
            ? Array.from(new Set([...f.tools, ...t.tools])).slice(0, 15)
            : f.tools,
    }));
    toast.success(`“${t.name}” applied`, {
      description: "Guidance appears in empty fields as placeholder text — your content is never overwritten.",
    });
  }

  // ------------------------------------------------------------ load

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setLoadError(null);
    setForbidden(false);
    try {
      const res = await api<{ project: FullProject; canEdit: boolean }>(`/api/projects/${projectId}`);
      if (!res.canEdit) {
        setForbidden(true);
        return;
      }
      const p = res.project;
      const next: FormState = {
        title: p.title,
        summary: p.summary ?? "",
        category: p.category ?? "",
        visibility: (p.visibility as Visibility) || "PUBLIC",
        brief: p.brief ?? "",
        process: p.process ?? "",
        challenges: p.challenges ?? "",
        outcome: p.outcome ?? "",
        role: p.role ?? "",
        description: p.description ?? "",
        skills: p.skills ?? [],
        tools: p.tools ?? [],
        externalUrl: p.externalUrl ?? "",
        repoUrl: p.repoUrl ?? "",
        contributors: p.contributors.map((c) => ({ name: c.name, role: c.role ?? "", contribution: c.contribution ?? "" })),
        media: p.media.map((m) => ({ mediaId: m.mediaId, url: m.url, kind: m.kind, caption: m.caption ?? "" })),
        // Real dedicated cover — may live outside the media gallery, so it is
        // read from the DTO fields rather than matched against gallery URLs.
        cover: {
          mediaId: p.coverMediaId ?? null,
          url: p.coverUrl ?? null,
          kind: p.coverKind ?? null,
          original: null,
        },
        // Universal Studio envelope — kind, template provenance, structured
        // and custom fields. Unknown keys are kept verbatim so switching
        // professions never loses data.
        kind: p.customFields?.kind ?? "",
        templateId: p.customFields?.templateId ?? "",
        suggested: { ...(p.customFields?.fields ?? {}) },
        custom: (p.customFields?.custom ?? []).map((c) => ({ label: c.label, value: c.value })),
      };
      setForm(next);
      setSnapshot(snapshotOf(next));
      setSavedId(p.id);
      setStatus(p.status === "PUBLISHED" ? "PUBLISHED" : "DRAFT");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this project");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ------------------------------------------- creation intent (one-shot)
  // A kind/template chosen in the CreateProjectFlow is handed over here via
  // sessionStorage — the /studio/new URL stays clean and shareable.
  useEffect(() => {
    if (projectId) return;
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(STUDIO_INTENT_KEY);
      window.sessionStorage.removeItem(STUDIO_INTENT_KEY);
    } catch {
      return; // storage unavailable — start blank
    }
    if (!raw) return;
    try {
      const intent = JSON.parse(raw) as StudioIntent;
      if (!intent || typeof intent !== "object") return;
      setForm((f) => ({
        ...f,
        kind: typeof intent.kind === "string" ? intent.kind : f.kind,
        templateId: typeof intent.templateId === "string" ? intent.templateId : f.templateId,
        category:
          f.category ||
          (typeof intent.category === "string" ? intent.category : "") ||
          templateById(intent.templateId ?? "")?.categoryHint ||
          "",
      }));
    } catch {
      /* malformed intent — start blank */
    }
  }, [projectId]);

  // Unsaved-changes guard (beforeunload only — hash nav stays simple)
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ------------------------------------------------------------ media helpers

  function addMedia(m: MediaDTO) {
    setForm((f) => {
      if (f.media.length >= 30) return f;
      if (f.media.some((x) => x.mediaId === m.id)) return f;
      return {
        ...f,
        media: [...f.media, { mediaId: m.id, url: m.url, kind: m.kind, mime: m.mime, caption: "" }],
      };
    });
  }

  function moveMedia(index: number, dir: -1 | 1) {
    setForm((f) => {
      const next = [...f.media];
      const target = index + dir;
      if (target < 0 || target >= next.length) return f;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...f, media: next };
    });
  }

  function removeMedia(index: number) {
    setForm((f) => {
      const item = f.media[index];
      const media = f.media.filter((_, i) => i !== index);
      return {
        ...f,
        media,
        cover: f.cover.mediaId === item.mediaId ? EMPTY_COVER : f.cover,
      };
    });
  }

  function setCoverFromMedia(mediaId: string) {
    setForm((f) => {
      if (f.cover.mediaId === mediaId) return { ...f, cover: EMPTY_COVER };
      const item = f.media.find((m) => m.mediaId === mediaId);
      if (!item) return f;
      return { ...f, cover: { mediaId, url: item.url, kind: item.kind, original: null } };
    });
  }

  // ------------------------------------------------- dedicated cover flow

  /** Validate + upload the chosen original, then open the 16:9 crop editor. */
  async function onCoverFileChosen(file: File) {
    if (!COVER_ALLOWED_TYPES.includes(file.type)) {
      toast.error("Covers must be JPG, PNG or WebP images.");
      return;
    }
    if (file.size > COVER_MAX_BYTES) {
      toast.error("Cover images can be up to 8 MB.");
      return;
    }
    if (file.size === 0) {
      toast.error("That file is empty.");
      return;
    }
    setCoverBusy("uploading");
    setCoverProgress(0);
    try {
      const res = await uploadFile(file, setCoverProgress);
      const media = res.media;
      // The server sniffs magic bytes — a file with an image extension but
      // non-image content comes back as another kind. Never let it become
      // the cover.
      if (media.kind !== "IMAGE") {
        toast.error("That file isn't a valid image — covers must be JPG, PNG or WebP.");
        return;
      }
      cropSourceRef.current = { mediaId: media.id, url: media.url };
      setCoverDialog({ open: true, src: media.url, saving: false, error: null });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Cover upload failed");
    } finally {
      setCoverBusy(null);
      setCoverProgress(0);
      if (coverFileRef.current) coverFileRef.current.value = "";
    }
  }

  /** Open the crop editor on the best available source for the current cover. */
  function openCoverEditor() {
    const source = form.cover.original ?? (form.cover.mediaId && form.cover.url ? { mediaId: form.cover.mediaId, url: form.cover.url } : null);
    if (!source) return;
    cropSourceRef.current = source;
    setCoverDialog({ open: true, src: source.url, saving: false, error: null });
  }

  /** Generate the optimized 16:9 derivative and make it the project cover. */
  async function saveCoverCrop(adjust: CoverAdjust) {
    const source = cropSourceRef.current;
    if (!source) return;
    setCoverDialog((d) => ({ ...d, saving: true, error: null }));
    try {
      const blob = await cropCoverToBlob(coverDialog.src, adjust);
      const file = new File([blob], "project-cover-16x9.jpg", { type: "image/jpeg" });
      const res = await uploadFile(file);
      const derivative = res.media;
      setForm((f) => ({
        ...f,
        cover: { mediaId: derivative.id, url: derivative.url, kind: "IMAGE", original: source },
      }));
      setCoverDialog({ open: false, src: "", saving: false, error: null });
      toast.success("Cover saved — an optimized 16:9 crop is used for display");
    } catch (e) {
      // The original upload already exists — fall back to using it as-is
      // rather than losing the user's selection.
      setForm((f) => ({
        ...f,
        cover: { mediaId: source.mediaId, url: source.url, kind: "IMAGE", original: source },
      }));
      setCoverDialog({ open: false, src: "", saving: false, error: null });
      toast.message("Cover set from the original image", {
        description: e instanceof Error ? e.message : "The optimized crop could not be saved.",
      });
    }
  }

  /** Remove the dedicated cover. Never touches project media. */
  function removeCover() {
    setForm((f) => ({ ...f, cover: EMPTY_COVER }));
    cropSourceRef.current = null;
  }

  // ------------------------------------------------------------ contributors

  function addContributor() {
    setForm((f) =>
      f.contributors.length >= 20 ? f : { ...f, contributors: [...f.contributors, { name: "", role: "", contribution: "" }] }
    );
  }

  function updateContributor(i: number, patch: Partial<Contributor>) {
    setForm((f) => ({
      ...f,
      contributors: f.contributors.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
    }));
  }

  function removeContributor(i: number) {
    setForm((f) => ({ ...f, contributors: f.contributors.filter((_, idx) => idx !== i) }));
  }

  // ---------------------------------------------------- custom fields

  function addCustomField() {
    setForm((f) =>
      f.custom.length >= CUSTOM_FIELD_LIMITS.max
        ? f
        : { ...f, custom: [...f.custom, { label: "", value: "" }] }
    );
  }

  function updateCustomField(i: number, patch: Partial<{ label: string; value: string }>) {
    setForm((f) => ({
      ...f,
      custom: f.custom.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
    }));
  }

  function removeCustomField(i: number) {
    setForm((f) => ({ ...f, custom: f.custom.filter((_, idx) => idx !== i) }));
  }

  // ------------------------------------------------------------ AI assist

  function aiError(e: unknown) {
    if (e instanceof ApiError) {
      if (e.status === 403) toast.error("Enable BEAN Intelligence in Settings first");
      else toast.error(e.message);
    } else {
      toast.error("Something went wrong");
    }
  }

  async function runImprove(field: "description" | "summary") {
    const content = field === "description" ? form.description : form.summary;
    if (!content.trim()) {
      toast.error("Write a first draft first — the AI improves what you've written.");
      return;
    }
    setAiBusy(field === "description" ? "improve-description" : "improve-summary");
    try {
      // Profession context grounds the copyedit in the creator's field —
      // the server never fabricates facts from it (existing contract).
      const contextBits = [
        form.title.trim() && `Title: ${form.title.trim()}`,
        form.category && `Field: ${categoryLabel(form.category)}`,
        form.kind && `Work type: ${kindLabelFor(form.kind)}`,
        form.role.trim() && `Role: ${form.role.trim()}`,
      ].filter(Boolean);
      const res = await api<{ text: string }>("/api/ai/improve", {
        method: "POST",
        json: {
          field,
          content: content.slice(0, 8000),
          ...(contextBits.length ? { projectContext: contextBits.join(" · ") } : {}),
        },
      });
      setImprovePanel({ field, text: res.text });
    } catch (e) {
      aiError(e);
    } finally {
      setAiBusy(null);
    }
  }

  async function runSuggest() {
    if (!form.title.trim() && !form.description.trim()) {
      toast.error("Add a title or some description text first.");
      return;
    }
    setAiBusy("suggest");
    try {
      const res = await api<{ summary?: string; skills?: string[]; category?: string | null }>("/api/ai/suggest", {
        method: "POST",
        json: { title: form.title.trim() || undefined, description: form.description.trim().slice(0, 4000) || undefined },
      });
      if (!res.summary && !res.skills?.length && !res.category) {
        toast.error("The AI couldn't come up with suggestions — add more detail and try again.");
        return;
      }
      setSuggestPanel(res);
    } catch (e) {
      aiError(e);
    } finally {
      setAiBusy(null);
    }
  }

  // ------------------------------------------------------------ save

  function buildPayload() {
    const f = formRef.current;
    const clean = (s: string) => s.trim();
    return {
      title: clean(f.title),
      summary: clean(f.summary),
      description: clean(f.description),
      category: clean(f.category),
      visibility: f.visibility,
      brief: clean(f.brief),
      process: clean(f.process),
      challenges: clean(f.challenges),
      outcome: clean(f.outcome),
      role: clean(f.role),
      externalUrl: clean(f.externalUrl),
      repoUrl: clean(f.repoUrl),
      skills: f.skills.map((s) => s.trim()).filter(Boolean).slice(0, 15),
      tools: f.tools.map((s) => s.trim()).filter(Boolean).slice(0, 15),
      media: f.media.slice(0, 30).map((m) => ({ mediaId: m.mediaId, caption: m.caption.trim() || undefined })),
      contributors: f.contributors
        .filter((c) => c.name.trim())
        .slice(0, 20)
        .map((c) => ({
          name: c.name.trim(),
          role: c.role.trim() || undefined,
          contribution: c.contribution.trim() || undefined,
        })),
      // Sent explicitly — coverMediaId: null tells the server "clear the cover";
      // omitting the key would mean "leave it unchanged" (PATCH semantics).
      coverMediaId: f.cover.mediaId,
      // Universal Studio envelope — the server stores it as one additive JSON
      // column; null clears it (explicit "remove all custom fields").
      customFields: buildCustomFieldsEnvelope(f),
    };
  }

  const titleMissing = !form.title.trim();

  async function save(): Promise<string | null> {
    if (titleMissing) {
      toast.error("Add a title before saving.");
      return null;
    }
    setSaving(true);
    try {
      const payload = buildPayload();
      if (savedId) {
        const res = await api<{ project: FullProject }>(`/api/projects/${savedId}`, { method: "PATCH", json: payload });
        setSnapshot(snapshotOf(formRef.current));
        setStatus(res.project.status === "PUBLISHED" ? "PUBLISHED" : "DRAFT");
        return res.project.id;
      }
      const res = await api<{ project: FullProject }>("/api/projects", { method: "POST", json: payload });
      setSnapshot(snapshotOf(formRef.current));
      setSavedId(res.project.id);
      // Replace the URL so a refresh keeps editing this same project.
      navigate(`/studio/${res.project.id}/edit`, true);
      return res.project.id;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save project");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndPublish() {
    if (titleMissing) {
      toast.error("Add a title before publishing.");
      return;
    }
    setPublishing(true);
    try {
      const id = await save();
      if (!id) return;
      const res = await api<{ project: FullProject }>(`/api/projects/${id}/publish`, { method: "POST" });
      setStatus("PUBLISHED");
      toast.success("Project published — it's now live on your profile");
      // Refresh local snapshot status from server truth
      setSnapshot(snapshotOf({ ...formRef.current }));
      if (!savedId) setSavedId(res.project.id);
    } catch (e) {
      // e.g. 400 "Add a cover or at least one media item before publishing"
      toast.error(e instanceof Error ? e.message : "Could not publish project");
    } finally {
      setPublishing(false);
    }
  }

  // ------------------------------------------------------------ render guards

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <FormSkeleton />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={X}
          title="You can't edit this project"
          description="This project belongs to another creator, or your session doesn't have access to it."
          action={<Button onClick={() => navigate("/studio")}>Back to Studio</Button>}
        />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={X}
          title="Could not open the editor"
          description={loadError}
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void load()}>
                Try again
              </Button>
              <Button onClick={() => navigate("/studio")}>Back to Studio</Button>
            </div>
          }
        />
      </div>
    );
  }

  const canPublishClient = form.title.trim().length > 0 && (form.cover.mediaId !== null || form.media.length > 0);
  const coverInGallery = Boolean(form.cover.mediaId && form.media.some((m) => m.mediaId === form.cover.mediaId));

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="icon" aria-label="Back to Studio" onClick={() => navigate("/studio")}>
            <ArrowLeft className="size-4" aria-hidden />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate font-display text-2xl font-semibold tracking-tight">
              {projectId ? "Edit project" : "New project"}
            </h1>
            <p className="text-xs text-muted-foreground">
              {form.title.trim() || "Untitled"} · {status === "PUBLISHED" ? "Published" : "Draft"}
              {dirty && " · Unsaved changes"}
            </p>
          </div>
        </div>
        {status === "PUBLISHED" ? (
          <Badge className="rounded-full bg-gold-soft text-primary ring-1 ring-primary/25 border-transparent">
            <Eye className="size-3" aria-hidden /> Live
          </Badge>
        ) : (
          <Badge variant="secondary" className="rounded-full">
            Draft
          </Badge>
        )}
      </div>

      <div className="mt-6 space-y-6">
        {/* -------------------------------- 1. Essentials */}
        <section className="rounded-xl border border-border/60 bg-card p-6">
          <h2 className="font-display text-lg font-semibold">Essentials</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">The first things people see on cards, feeds and search.</p>

          <div className="mt-5 space-y-5">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="pe-title" counter={<Counter value={form.title} max={LIMITS.title} />}>
                Project title
              </FieldLabel>
              <Input
                id="pe-title"
                value={form.title}
                maxLength={LIMITS.title}
                placeholder="e.g. Harbor House — a coastal retreat in timber"
                onChange={(e) => set("title", e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <FieldLabel
                htmlFor="pe-summary"
                hint="A one-line pitch shown on cards and feeds."
                counter={<Counter value={form.summary} max={LIMITS.summary} />}
              >
                Summary
              </FieldLabel>
              <div className="relative">
                <Input
                  id="pe-summary"
                  value={form.summary}
                  maxLength={LIMITS.summary}
                  placeholder="e.g. A minimal timber residence shaped by the tide line and local craft."
                  onChange={(e) => set("summary", e.target.value)}
                  className="pr-24"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="absolute right-1 top-1/2 h-7 -translate-y-1/2 gap-1 text-xs"
                  disabled={aiBusy !== null}
                  onClick={() => void runImprove("summary")}
                >
                  <Sparkles className="size-3 text-primary" aria-hidden />
                  {aiBusy === "improve-summary" ? "Thinking…" : "Improve with AI"}
                </Button>
              </div>
              {improvePanel?.field === "summary" && (
                <AiReviewPanel
                  text={improvePanel.text}
                  onApply={() => {
                    set("summary", improvePanel.text.slice(0, LIMITS.summary));
                    setImprovePanel(null);
                    toast.success("Summary updated from AI suggestion");
                  }}
                  onDiscard={() => setImprovePanel(null)}
                />
              )}
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="pe-category">Category</Label>
                <Select
                  value={form.category || undefined}
                  onValueChange={(v) => set("category", v)}
                >
                  <SelectTrigger id="pe-category" className="w-full">
                    <SelectValue placeholder="Choose a discipline" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {(() => {
                      // The creator's own professions lead the list; everything
                      // else from the live taxonomy follows unchanged.
                      const mine = user?.professions ?? [];
                      const mineSet = new Set(mine);
                      const userOpts = professionOptions.filter((p) => mineSet.has(p.slug));
                      const restOpts = professionOptions.filter((p) => !mineSet.has(p.slug));
                      return (
                        <>
                          {userOpts.length > 0 && (
                            <SelectGroup>
                              <SelectLabel>Your professions</SelectLabel>
                              {userOpts.map((p) => (
                                <SelectItem key={p.slug} value={p.slug}>
                                  {p.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          )}
                          <SelectGroup>
                            <SelectLabel>All professions</SelectLabel>
                            {restOpts.map((p) => (
                              <SelectItem key={p.slug} value={p.slug}>
                                {p.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </>
                      );
                    })()}
                  </SelectContent>
                </Select>
                {form.category && activeProfile.familySlug !== userWorkProfile.familySlug && (
                  <p className="text-xs text-muted-foreground">
                    Fields adapted to {categoryLabel(form.category)}.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pe-kind">Project type</Label>
                <Select
                  value={form.kind || "none"}
                  onValueChange={(v) => set("kind", v === "none" ? "" : v)}
                >
                  <SelectTrigger id="pe-kind" className="w-full">
                    <SelectValue placeholder="What kind of work is this?" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value="none">Not specified</SelectItem>
                    {kindOptions.map((k) => (
                      <SelectItem key={k.slug} value={k.slug}>
                        {kindLabelFor(k.slug)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {form.category
                    ? `Types suited to ${categoryLabel(form.category)} work.`
                    : "Set a category to see its work types."}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pe-visibility">Visibility</Label>
              <Select value={form.visibility} onValueChange={(v) => set("visibility", v as Visibility)}>
                <SelectTrigger id="pe-visibility" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PUBLIC">Public</SelectItem>
                  <SelectItem value="UNLISTED">Unlisted</SelectItem>
                  <SelectItem value="PRIVATE">Private</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{VISIBILITY_HELP[form.visibility]}</p>
            </div>
          </div>
        </section>

        {/* -------------------------------- 2. Story */}
        <section className="rounded-xl border border-border/60 bg-card p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold">The work behind the work</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {form.category
                  ? `Structured for ${categoryLabel(form.category)} work — clients and peers read the story.`
                  : "Clients and peers read the story — process is what makes a folio memorable."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setTemplateDialogOpen(true)}
                data-testid="editor-templates"
              >
                <LayoutTemplate className="size-3.5 text-primary" aria-hidden />
                Templates
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={aiBusy !== null}
                onClick={() => void runSuggest()}
              >
                <Sparkles className="size-3.5 text-primary" aria-hidden />
                {aiBusy === "suggest" ? "Thinking…" : "Suggest metadata"}
              </Button>
            </div>
          </div>

          {activeTemplate && (
            <p className="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <LayoutTemplate className="size-3.5 text-primary" aria-hidden />
              Using the “{activeTemplate.name}” template
              {activeTemplate.style ? ` (${activeTemplate.style})` : ""} — guidance shows in empty fields only.
            </p>
          )}

          {suggestPanel && (
            <div className="mt-4 rounded-xl border border-primary/30 bg-gold-soft/40 p-4">
              <p className="flex items-center gap-1.5 text-sm font-medium text-primary">
                <Sparkles className="size-3.5" aria-hidden /> BEAN Intelligence suggestions
              </p>
              <div className="mt-3 space-y-2.5">
                {suggestPanel.summary && (
                  <SuggestRow
                    label="Summary"
                    value={suggestPanel.summary}
                    active={form.summary !== suggestPanel.summary}
                    onAccept={() => {
                      set("summary", suggestPanel.summary!.slice(0, LIMITS.summary));
                      toast.success("Summary accepted");
                    }}
                  />
                )}
                {!!suggestPanel.skills?.length && (
                  <SuggestRow
                    label="Skills"
                    value={suggestPanel.skills.join(", ")}
                    active
                    onAccept={() => {
                      const merged = Array.from(new Set([...form.skills, ...suggestPanel.skills!])).slice(0, 15);
                      set("skills", merged);
                      toast.success("Skills accepted");
                    }}
                  />
                )}
                {suggestPanel.category && (
                  <SuggestRow
                    label="Category"
                    value={
                      professionOptions.find((p) => p.slug === suggestPanel.category)?.label ??
                      suggestPanel.category
                    }
                    active={form.category !== suggestPanel.category}
                    onAccept={() => {
                      set("category", suggestPanel.category!);
                      toast.success("Category accepted");
                    }}
                  />
                )}
              </div>
              <div className="mt-3 flex justify-end">
                <Button type="button" variant="ghost" size="sm" onClick={() => setSuggestPanel(null)}>
                  Discard
                </Button>
              </div>
            </div>
          )}

          <div className="mt-5 space-y-5">
            <LongField
              id="pe-brief"
              label={fieldOverride("brief").label ?? "Brief / objective"}
              placeholder={placeholderFor("brief", "What was the assignment or goal? Who was it for?")}
              value={form.brief}
              max={LIMITS.brief}
              onChange={(v) => set("brief", v)}
            />
            <LongField
              id="pe-process"
              label={fieldOverride("process").label ?? "Process & iterations"}
              placeholder={placeholderFor("process", "How did you move from brief to result? Key decisions, iterations, versions…")}
              value={form.process}
              max={LIMITS.process}
              onChange={(v) => set("process", v)}
            />
            <LongField
              id="pe-challenges"
              label={fieldOverride("challenges").label ?? "Challenges & decisions"}
              placeholder={placeholderFor("challenges", "What was hard? Trade-offs you made, dead ends, problems you solved…")}
              value={form.challenges}
              max={LIMITS.challenges}
              onChange={(v) => set("challenges", v)}
            />
            <LongField
              id="pe-outcome"
              label={fieldOverride("outcome").label ?? "Results & outcomes"}
              placeholder={placeholderFor("outcome", "What happened in the end? Reception, metrics, lessons…")}
              value={form.outcome}
              max={LIMITS.outcome}
              onChange={(v) => set("outcome", v)}
            />
            <div className="space-y-1.5">
              <FieldLabel htmlFor="pe-role" counter={<Counter value={form.role} max={LIMITS.role} />}>
                {fieldOverride("role").label ?? "Your role / contribution"}
              </FieldLabel>
              <Input
                id="pe-role"
                value={form.role}
                maxLength={LIMITS.role}
                placeholder={fieldOverride("role").placeholder ?? "e.g. Lead designer — research, UI, design system"}
                onChange={(e) => set("role", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <FieldLabel
                htmlFor="pe-description"
                hint="The main long-form story visitors read."
                counter={<Counter value={form.description} max={LIMITS.description} />}
              >
                Description
              </FieldLabel>
              <Textarea
                id="pe-description"
                value={form.description}
                maxLength={LIMITS.description}
                placeholder="Tell the full story — context, approach, and what makes this project worth showing."
                className="min-h-40"
                onChange={(e) => set("description", e.target.value)}
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={aiBusy !== null}
                  onClick={() => void runImprove("description")}
                >
                  <Sparkles className="size-3.5 text-primary" aria-hidden />
                  {aiBusy === "improve-description" ? "Thinking…" : "Improve with AI"}
                </Button>
              </div>
              {improvePanel?.field === "description" && (
                <AiReviewPanel
                  text={improvePanel.text}
                  onApply={() => {
                    set("description", improvePanel.text.slice(0, LIMITS.description));
                    setImprovePanel(null);
                    toast.success("Description updated from AI suggestion");
                  }}
                  onDiscard={() => setImprovePanel(null)}
                />
              )}
            </div>
          </div>
        </section>

        {/* -------------------------------- 3. Project cover image (dedicated, independent of media) */}
        <section className="rounded-xl border border-border/60 bg-card p-6">
          <h2 className="font-display text-lg font-semibold">Project cover image</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            The primary image for project cards, portfolio grids, Discover/Explore and the project page hero — separate from the media gallery below.
          </p>

          <div className="mt-4">
            {/* Large 16:9 cover preview */}
            <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
              {form.cover.url ? (
                <MediaThumb
                  src={form.cover.url}
                  alt="Project cover preview"
                  kind={form.cover.kind ?? undefined}
                  aspect="aspect-video"
                />
              ) : (
                <div className="grid aspect-video w-full place-items-center bg-muted/30 text-muted-foreground">
                  <div className="px-6 text-center">
                    <ImagePlus className="mx-auto size-8 opacity-50" aria-hidden />
                    <p className="mt-2 text-sm">No cover yet</p>
                    <p className="mt-0.5 text-xs">Cards use the default placeholder until a cover is uploaded.</p>
                  </div>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                ref={coverFileRef}
                type="file"
                accept={COVER_ACCEPT}
                className="sr-only"
                aria-label="Upload Cover Image"
                data-testid="cover-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onCoverFileChosen(f);
                }}
              />
              {!form.cover.mediaId ? (
                <Button
                  type="button"
                  onClick={() => coverFileRef.current?.click()}
                  disabled={coverBusy !== null}
                  data-testid="cover-upload"
                >
                  {coverBusy === "uploading" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />}
                  {coverBusy === "uploading" ? `Uploading ${coverProgress}%` : "Upload Cover Image"}
                </Button>
              ) : (
                <>
                  <Button type="button" variant="outline" onClick={openCoverEditor} disabled={coverBusy !== null} data-testid="cover-adjust">
                    <Crop className="size-4" aria-hidden /> Adjust crop
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => coverFileRef.current?.click()}
                    disabled={coverBusy !== null}
                    data-testid="cover-replace"
                  >
                    {coverBusy === "uploading" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />}
                    {coverBusy === "uploading" ? `Uploading ${coverProgress}%` : "Replace"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={removeCover}
                    disabled={coverBusy !== null}
                    data-testid="cover-remove"
                  >
                    <X className="size-4" aria-hidden /> Remove
                  </Button>
                </>
              )}
            </div>
            {coverBusy === "uploading" && <Progress value={coverProgress} className="mt-2 h-1.5" aria-label="Cover upload progress" />}

            <p className="mt-2 text-xs text-muted-foreground">
              JPG, PNG or WebP · up to 8 MB · recommended 16:9. The original upload stays intact in your library; an optimized 1600×900 crop is generated for display.
              {form.cover.mediaId && coverInGallery && " Currently using a project media item as the cover."}
            </p>
          </div>
        </section>

        {/* -------------------------------- 4. Project media (gallery) */}
        <section className="rounded-xl border border-border/60 bg-card p-6">
          <h2 className="font-display text-lg font-semibold">Project media</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Images, video, audio, PDFs, presentations, documents or design files — up to 30 items shown inside the project page. The cover is managed in the dedicated section above.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <MediaUploadButton kind="ANY" label="Add media" onUploaded={addMedia} disabled={form.media.length >= 30} />
            {form.media.length >= 30 && <span className="text-xs text-muted-foreground">Media limit reached (30)</span>}
          </div>

          {/* Media list */}
          {form.media.length > 0 ? (
            <ul className="mt-4 max-h-96 space-y-2 overflow-y-auto pr-1">
              {form.media.map((m, i) => {
                const isCover = form.cover.mediaId === m.mediaId;
                return (
                  <li
                    key={m.mediaId}
                    className={cn(
                      "flex flex-wrap items-center gap-3 rounded-lg border p-2.5 sm:flex-nowrap",
                      isCover ? "border-primary/40 bg-gold-soft/30" : "border-border/60 bg-background/40"
                    )}
                  >
                    <div className="w-14 shrink-0 overflow-hidden rounded">
                      <MediaThumb src={m.url} alt={`Media ${i + 1}`} kind={m.kind} aspect="aspect-square" className="rounded" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline" className="rounded-full px-1.5 text-[10px] font-normal">
                          {KIND_LABELS[m.kind] ?? m.kind}
                        </Badge>
                        <span>Order {i + 1}</span>
                        {isCover && <span className="font-medium text-primary">· Cover</span>}
                      </p>
                      <Input
                        value={m.caption}
                        maxLength={300}
                        placeholder="Caption (optional)"
                        aria-label={`Caption for media ${i + 1}`}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            media: f.media.map((x, idx) => (idx === i ? { ...x, caption: e.target.value } : x)),
                          }))
                        }
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label="Move up"
                        disabled={i === 0}
                        onClick={() => moveMedia(i, -1)}
                      >
                        <ChevronUp className="size-4" aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label="Move down"
                        disabled={i === form.media.length - 1}
                        onClick={() => moveMedia(i, 1)}
                      >
                        <ChevronDown className="size-4" aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1 px-2 text-xs"
                        aria-label={isCover ? "Remove cover" : "Set as cover"}
                        onClick={() => setCoverFromMedia(m.mediaId)}
                      >
                        <Star className={cn("size-3.5", isCover && "fill-primary text-primary")} aria-hidden />
                        {isCover ? "Unset" : "Set as cover"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        aria-label={`Remove media ${i + 1}`}
                        onClick={() => removeMedia(i)}
                      >
                        <X className="size-4" aria-hidden />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-4 rounded-lg border border-dashed border-border/70 bg-background/30 p-4 text-center text-sm text-muted-foreground">
              Nothing uploaded yet — gallery items appear inside the project page.
            </p>
          )}
        </section>

        {/* -------------------------------- 5. Details */}
        <section className="rounded-xl border border-border/60 bg-card p-6">
          <h2 className="font-display text-lg font-semibold">Details</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Metadata helps the right people find this project.</p>

          <div className="mt-5 space-y-5">
            {fieldIsRelevant(activeProfile, "skills", form.skills.length > 0) && (
              <div className="space-y-1.5">
                <Label htmlFor="pe-skills">Skills</Label>
              <TagInput
                value={form.skills}
                onChange={(v) => set("skills", v)}
                max={15}
                placeholder="e.g. Art direction, Figma, Ceramics…"
                ariaLabel="Add skills"
              />
              <p className="text-xs text-muted-foreground">Press Enter or comma to add · max 15</p>
              {activeProfile.skills.length > 0 && form.skills.length === 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Suggested for your field:</span>
                  {activeProfile.skills.slice(0, 6).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => set("skills", [...form.skills, s].slice(0, 15))}
                      className="rounded-full border border-border/70 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                      + {s}
                    </button>
                  ))}
                </div>
              )}
              </div>
            )}

            {fieldIsRelevant(activeProfile, "tools", form.tools.length > 0) && (
              <div className="space-y-1.5">
                <Label htmlFor="pe-tools">Tools</Label>
              <TagInput
                value={form.tools}
                onChange={(v) => set("tools", v)}
                max={15}
                placeholder="e.g. Blender, Rhino, Ableton…"
                ariaLabel="Add tools"
              />
              {activeProfile.tools.length > 0 && form.tools.length === 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Common in your field:</span>
                  {activeProfile.tools.slice(0, 6).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => set("tools", [...form.tools, t].slice(0, 15))}
                      className="rounded-full border border-border/70 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                      + {t}
                    </button>
                  ))}
                </div>
              )}
              </div>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <FieldLabel htmlFor="pe-ext" counter={<Counter value={form.externalUrl} max={LIMITS.url} />}>
                  {fieldOverride("externalUrl").label ?? "External URL"}
                </FieldLabel>
                <Input
                  id="pe-ext"
                  type="url"
                  value={form.externalUrl}
                  maxLength={LIMITS.url}
                  placeholder={fieldOverride("externalUrl").urlPlaceholder ?? "https://…"}
                  onChange={(e) => set("externalUrl", e.target.value)}
                />
              </div>
              {fieldIsRelevant(activeProfile, "repoUrl", form.repoUrl.trim().length > 0) && (
                <div className="space-y-1.5">
                  <FieldLabel htmlFor="pe-repo" counter={<Counter value={form.repoUrl} max={LIMITS.url} />}>
                    {fieldOverride("repoUrl").label ?? "Repository URL"}
                  </FieldLabel>
                  <Input
                    id="pe-repo"
                    type="url"
                    value={form.repoUrl}
                    maxLength={LIMITS.url}
                    placeholder={fieldOverride("repoUrl").urlPlaceholder ?? "https://github.com/…"}
                    onChange={(e) => set("repoUrl", e.target.value)}
                  />
                </div>
              )}
            </div>

            {/* Contributors */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Contributors</Label>
                <Button type="button" variant="outline" size="sm" onClick={addContributor} disabled={form.contributors.length >= 20}>
                  Add contributor
                </Button>
              </div>
              {form.contributors.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Credit collaborators — name is required, role and contribution optional.
                </p>
              )}
              {form.contributors.length > 0 && (
                <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
                  {form.contributors.map((c, i) => (
                    <li key={i} className="rounded-lg border border-border/60 bg-background/40 p-3">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input
                          value={c.name}
                          maxLength={80}
                          placeholder="Name (required)"
                          aria-label={`Contributor ${i + 1} name`}
                          onChange={(e) => updateContributor(i, { name: e.target.value })}
                          className="h-8 text-sm"
                        />
                        <Input
                          value={c.role}
                          maxLength={80}
                          placeholder="Role (e.g. Sound design)"
                          aria-label={`Contributor ${i + 1} role`}
                          onChange={(e) => updateContributor(i, { role: e.target.value })}
                          className="h-8 text-sm"
                        />
                        <Input
                          value={c.contribution}
                          maxLength={500}
                          placeholder="Contribution (what did they do?)"
                          aria-label={`Contributor ${i + 1} contribution`}
                          onChange={(e) => updateContributor(i, { contribution: e.target.value })}
                          className="h-8 text-sm sm:col-span-2"
                        />
                      </div>
                      <div className="mt-2 flex justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 text-xs text-muted-foreground hover:text-destructive"
                          onClick={() => removeContributor(i)}
                        >
                          <X className="size-3.5" aria-hidden /> Remove
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        {/* -------------------------------- 6. Profession details (structured + custom fields) */}
        <section className="rounded-xl border border-border/60 bg-card p-6">
          <h2 className="font-display text-lg font-semibold">Profession details</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {form.category
              ? `Structured fields for ${categoryLabel(form.category)} work — plus anything else you want to record.`
              : "Structured fields for your field of work — plus anything else you want to record."}
          </p>

          {suggestedFieldDefs.length > 0 && (
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              {suggestedFieldDefs.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`pe-sf-${f.key}`}>{f.label}</Label>
                  {f.multiline ? (
                    <Textarea
                      id={`pe-sf-${f.key}`}
                      value={form.suggested[f.key] ?? ""}
                      maxLength={600}
                      placeholder={f.placeholder}
                      className="min-h-16"
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, suggested: { ...prev.suggested, [f.key]: e.target.value } }))
                      }
                    />
                  ) : (
                    <Input
                      id={`pe-sf-${f.key}`}
                      value={form.suggested[f.key] ?? ""}
                      maxLength={600}
                      placeholder={f.placeholder}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, suggested: { ...prev.suggested, [f.key]: e.target.value } }))
                      }
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* User-defined custom fields */}
          <div className="mt-6 space-y-2">
            <div className="flex items-center justify-between">
              <Label>Custom fields</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addCustomField}
                disabled={form.custom.length >= CUSTOM_FIELD_LIMITS.max}
                data-testid="add-custom-field"
              >
                <Plus className="size-3.5" aria-hidden /> Add field
              </Button>
            </div>
            {form.custom.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Anything the structured fields missed — e.g. “Exhibition dates”, “Second language”. Up to {CUSTOM_FIELD_LIMITS.max}.
              </p>
            ) : (
              <ul className="space-y-2">
                {form.custom.map((c, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background/40 p-2.5">
                    <Input
                      value={c.label}
                      maxLength={CUSTOM_FIELD_LIMITS.label}
                      placeholder="Label (e.g. Venue)"
                      aria-label={`Custom field ${i + 1} label`}
                      className="h-8 w-full text-sm sm:w-44"
                      onChange={(e) => updateCustomField(i, { label: e.target.value })}
                    />
                    <Input
                      value={c.value}
                      maxLength={CUSTOM_FIELD_LIMITS.value}
                      placeholder="Value"
                      aria-label={`Custom field ${i + 1} value`}
                      className="h-8 min-w-0 flex-1 text-sm"
                      onChange={(e) => updateCustomField(i, { value: e.target.value })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove custom field ${i + 1}`}
                      onClick={() => removeCustomField(i)}
                    >
                      <X className="size-4" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* -------------------------------- Template gallery dialog */}
      <Dialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen}>
        <DialogContent className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-display">Templates</DialogTitle>
            <DialogDescription>
              {form.category
                ? `Matched to ${categoryLabel(form.category)}. Applying never overwrites your text — guidance lands in empty fields only.`
                : "Templates add structure. Your text is never overwritten."}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {editorTemplates.map((t) => (
              <div key={t.id} className="rounded-xl border border-border/60 bg-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{t.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t.style}</p>
                  </div>
                  {form.templateId === t.id && (
                    <Badge className="shrink-0 rounded-full bg-gold-soft text-primary ring-1 ring-primary/25 border-transparent">
                      In use
                    </Badge>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{t.description}</p>
                <div className="mt-3 flex justify-end">
                  <Button type="button" size="sm" variant="outline" onClick={() => requestApplyTemplate(t)}>
                    <LayoutTemplate className="size-3.5 text-primary" aria-hidden />
                    {form.templateId === t.id ? "Reapply" : "Apply"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Merge confirmation — required whenever a template would touch existing tags */}
      <AlertDialog open={pendingTemplate !== null} onOpenChange={(open) => !open && setPendingTemplate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply “{pendingTemplate?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              You already have {pendingTemplate && templateMerges(pendingTemplate, { skills: form.skills, tools: form.tools }).includes("skills") ? "skills" : ""}
              {pendingTemplate && templateMerges(pendingTemplate, { skills: form.skills, tools: form.tools }).length === 2 ? " and " : ""}
              {pendingTemplate && templateMerges(pendingTemplate, { skills: form.skills, tools: form.tools }).includes("tools") ? "tools" : ""}{" "}
              filled in. The template will merge its suggestions into those tags — nothing is removed or rewritten. Your
              written content is never changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (pendingTemplate) {
                  applyTemplate(pendingTemplate);
                  setPendingTemplate(null);
                  setTemplateDialogOpen(false);
                }
              }}
            >
              Merge & apply
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* -------------------------------- Save bar */}
      <TooltipProvider>
        <div className="glass-surface sticky bottom-4 z-30 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 p-3 shadow-[0_8px_30px_rgba(0,0,0,0.35)]">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground" aria-live="polite">
            {titleMissing
              ? "Add a title to save your draft."
              : !canPublishClient
                ? "Ready to save · publishing also needs a cover or at least one media item."
                : "Ready to save."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={savedId ? 0 : -1}>
                  <Button
                    variant="outline"
                    disabled={!savedId || saving || publishing}
                    onClick={() => savedId && navigate(`/p/${savedId}`)}
                  >
                    <Eye className="size-4" aria-hidden /> Preview
                  </Button>
                </span>
              </TooltipTrigger>
              {!savedId && (
                <TooltipContent>Save first to preview the project page</TooltipContent>
              )}
            </Tooltip>
            <Button variant="outline" disabled={saving || publishing} onClick={() => void save()}>
              {saving ? "Saving…" : "Save draft"}
            </Button>
            <Button
              disabled={saving || publishing}
              onClick={() => void saveAndPublish()}
            >
              {publishing ? "Publishing…" : "Publish"}
            </Button>
          </div>
        </div>
      </TooltipProvider>

      {/* Dedicated cover crop editor */}
      {coverDialog.open && (
        <ProjectCoverEditor
          open={coverDialog.open}
          onOpenChange={(v) => setCoverDialog((d) => ({ ...d, open: v, error: null }))}
          src={coverDialog.src}
          initial={{ zoom: 1, posX: 50, posY: 50 }}
          saving={coverDialog.saving}
          error={coverDialog.error}
          onSave={(adjust) => void saveCoverCrop(adjust)}
        />
      )}

      <div className="h-4" />
    </div>
  );
}

// ------------------------------------------------------------------ sub components

function AiReviewPanel({ text, onApply, onDiscard }: { text: string; onApply: () => void; onDiscard: () => void }) {
  return (
    <div className="rounded-xl border border-primary/30 bg-gold-soft/40 p-4" role="region" aria-label="AI suggestion review">
      <p className="flex items-center gap-1.5 text-sm font-medium text-primary">
        <Sparkles className="size-3.5" aria-hidden /> AI suggestion — review before applying
      </p>
      <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{text}</p>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>
          Discard
        </Button>
        <Button type="button" size="sm" onClick={onApply}>
          <Check className="size-3.5" aria-hidden /> Apply
        </Button>
      </div>
    </div>
  );
}

function SuggestRow({
  label,
  value,
  active,
  onAccept,
}: {
  label: string;
  value: string;
  active: boolean;
  onAccept: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg bg-background/50 p-2.5">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-0.5 text-sm text-foreground/90">{value}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 gap-1 text-xs"
        disabled={!active || accepted}
        onClick={() => {
          onAccept();
          setAccepted(true);
        }}
      >
        {accepted ? <Check className="size-3" aria-hidden /> : null}
        {accepted ? "Applied" : "Accept"}
      </Button>
    </div>
  );
}

function LongField({
  id,
  label,
  placeholder,
  value,
  max,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  max: number;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={id} counter={<Counter value={value} max={max} />}>
        {label}
      </FieldLabel>
      <Textarea
        id={id}
        value={value}
        maxLength={max}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-20"
      />
    </div>
  );
}
