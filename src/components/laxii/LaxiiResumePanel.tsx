"use client";

/**
 * LAXII Resume Studio panel — guided resume generation + full document
 * editing + template switching + PDF/DOCX export, all on the shared LAXII
 * conversation infrastructure.
 *
 * Universal professional coverage:
 *  - 26 profession families adapt section labels, skills hints and offer
 *    profession-specific custom sections (publications, licences, reels…).
 *  - 17 resume formats produce genuinely different document structures
 *    (section order comes from the format, not just the colours).
 *  - Every section can be added, removed, reordered and renamed.
 *  - A missing-information report lists what was NOT supplied — the AI is
 *    never allowed to fill gaps.
 *
 * Provenance honesty rules surfaced here:
 *  - Sections whose wording the AI touched are badged "AI wording".
 *  - AI notes are shown as suggestions, always editable afterwards.
 *  - No ATS pass is ever promised; uploads are source material, not truth.
 *
 * Layout contract: the panel fills its flex container (h-full grid) so both
 * columns reach the bottom of the viewport — the form scrolls internally to
 * its final section and the preview stays aligned, with no dead vertical
 * band below (the previous `max-h-[calc(100dvh-16rem)]` guesswork is gone).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Briefcase,
  Download,
  FileText,
  GraduationCap,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Trash2,
  TriangleAlert,
  Upload,
  UserRound,
  Wand2,
  Award,
  BadgeCheck,
  FolderKanban,
  Layers,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import {
  laxiiApi,
  type LaxiiCapabilities,
  type ResumeCustomSection,
  type ResumeData,
  type ResumeDetail,
  type ResumeFacts,
  type ResumeImportProposal,
  type ResumeSectionKey,
} from "@/lib/laxii-client";
import {
  RESUME_PROFESSION_FAMILIES,
  findResumeProfession,
  type ResumeCoreSectionKey,
  type ResumeCustomSectionDef,
} from "@/lib/laxii/resume-professions";
import { RESUME_TYPES, RESUME_DEFAULT_ORDER, RESUME_CORE_TITLES } from "@/lib/laxii/resume-schema";
import { LaxiiResumePreview } from "./LaxiiResumePreview";
import { LaxiiResumeImportReview, type ApplyPayload } from "./LaxiiResumeImportReview";
import { LaxiiResumeAnalysisPanel } from "./LaxiiResumeAnalysisPanel";
import { LaxiiResumeVersions } from "./LaxiiResumeVersions";
import { LaxiiCoverLetterPanel } from "./LaxiiCoverLetterPanel";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type TemplateId = "classic" | "modern" | "minimal" | "creative";

const TEMPLATES: { id: TemplateId; label: string }[] = [
  { id: "classic", label: "Classic (ATS serif)" },
  { id: "modern", label: "Modern" },
  { id: "minimal", label: "Minimal" },
  { id: "creative", label: "Creative" },
];

const CORE_ORDER_KEYS = ["summary", "work", "education", "skills", "projects", "certificates", "awards"] as const;

function emptyEntry() {
  return { title: "", subtitle: "", meta: "", summary: "", highlights: [] as string[], url: "" };
}

function emptyFacts(): ResumeFacts {
  return {
    basics: { name: "", label: "", email: "", phone: "", website: "", location: "", summary: "" },
    work: [],
    education: [],
    skills: [],
    projects: [],
    certificates: [],
    awards: [],
    custom: [],
  };
}

function emptyResumeData(): ResumeData {
  return {
    basics: { name: "", label: "", email: "", phone: "", website: "", location: "", summary: "" },
    work: [],
    education: [],
    skills: [],
    projects: [],
    certificates: [],
    awards: [],
    custom: [],
    order: [],
    titles: {},
  };
}

/** Materialize the document order into concrete refs for the manager.
 *  Core keys are NOT force-re-added here — the SectionManager renders core
 *  sections absent from the order as hidden rows (with Restore), so a user
 *  removal actually persists. */
function withMaterializedOrder(data: ResumeData): ResumeData {
  const base = data.order.length > 0 ? [...data.order] : [...RESUME_DEFAULT_ORDER];
  const out: string[] = [];
  for (const ref of base) {
    if (ref === "custom:*") {
      for (const c of data.custom) out.push(`custom:${c.key}`);
    } else {
      out.push(ref);
    }
  }
  for (const c of data.custom) if (!out.includes(`custom:${c.key}`)) out.push(`custom:${c.key}`);
  return { ...data, order: out };
}

// ------------------------------------------------------------------ widgets

function Field({ label, value, onChange, placeholder, type = "text", testid }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  testid?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 border-white/10 bg-white/[0.04] text-sm"
        data-testid={testid}
      />
    </label>
  );
}

function Area({ label, value, onChange, placeholder, rows = 3 }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="resize-none border-white/10 bg-white/[0.04] text-sm"
      />
    </label>
  );
}

function SectionCard({ title, icon, children, action }: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3.5">
      <div className="mb-3 flex min-h-7 items-center gap-2">
        <span className="text-primary">{icon}</span>
        <h4 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
        {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

function ItemShell({ title, onRemove, children }: { title: string; onRemove: () => void; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex-1 truncate text-[11px] font-semibold text-foreground/80">{title}</span>
        <button type="button" onClick={onRemove} aria-label={`Remove ${title}`} className="text-muted-foreground hover:text-destructive">
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      </div>
      {children}
    </div>
  );
}

/** Move an entry within an array (immutably). */
function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr;
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// ------------------------------------------------------ custom section card

function CustomSectionCard({ section, index, total, onChange, onRemove, onMove }: {
  section: ResumeCustomSection;
  index: number;
  total: number;
  onChange: (next: ResumeCustomSection) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3.5">
      <div className="mb-3 flex min-h-7 items-center gap-2">
        <span className="text-primary"><Layers className="size-4" aria-hidden /></span>
        <Input
          value={section.title}
          onChange={(e) => onChange({ ...section, title: e.target.value })}
          placeholder="Section name"
          aria-label={`Rename section ${section.title || section.key}`}
          className="h-7 min-w-0 flex-1 border-transparent bg-transparent px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:border-white/10"
        />
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" aria-label="Move section up" disabled={index === 0} onClick={() => onMove(-1)} className="text-muted-foreground hover:text-foreground disabled:opacity-30">
            <ArrowUp className="size-3.5" aria-hidden />
          </button>
          <button type="button" aria-label="Move section down" disabled={index === total - 1} onClick={() => onMove(1)} className="text-muted-foreground hover:text-foreground disabled:opacity-30">
            <ArrowDown className="size-3.5" aria-hidden />
          </button>
          <button type="button" onClick={onRemove} aria-label={`Remove ${section.title || section.key} section`} className="text-muted-foreground hover:text-destructive">
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {section.entries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No entries yet — add the first one.</p>
      ) : null}
      <div className="space-y-2.5">
        {section.entries.map((e, i) => (
          <ItemShell key={i} title={e.title || `Entry ${i + 1}`} onRemove={() => onChange({ ...section, entries: section.entries.filter((_, j) => j !== i) })}>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Title" value={e.title} onChange={(v) => onChange({ ...section, entries: section.entries.map((x, j) => (j === i ? { ...x, title: v } : x)) })} />
              <Field label="Subtitle (outlet, issuer…)" value={e.subtitle} onChange={(v) => onChange({ ...section, entries: section.entries.map((x, j) => (j === i ? { ...x, subtitle: v } : x)) })} />
              <Field label="Date / reference" value={e.meta} onChange={(v) => onChange({ ...section, entries: section.entries.map((x, j) => (j === i ? { ...x, meta: v } : x)) })} />
              <Field label="Link (optional)" value={e.url} onChange={(v) => onChange({ ...section, entries: section.entries.map((x, j) => (j === i ? { ...x, url: v } : x)) })} />
            </div>
            <div className="mt-2">
              <Area label="Description" value={e.summary} onChange={(v) => onChange({ ...section, entries: section.entries.map((x, j) => (j === i ? { ...x, summary: v } : x)) })} rows={2} />
            </div>
            <div className="mt-2">
              <Area label="Highlights (one per line)" value={e.highlights.join("\n")} onChange={(v) => onChange({ ...section, entries: section.entries.map((x, j) => (j === i ? { ...x, highlights: v.split("\n").map((s) => s.trimStart()).filter(Boolean) } : x)) })} rows={2} />
            </div>
          </ItemShell>
        ))}
      </div>
      <Button variant="ghost" size="sm" className="mt-2 h-7 gap-1 text-[11px]" onClick={() => onChange({ ...section, entries: [...section.entries, emptyEntry()] })}>
        <Plus className="size-3" aria-hidden /> Add entry
      </Button>
    </div>
  );
}

// ------------------------------------------------------- section manager

interface ManagerRow {
  ref: string; // core key or custom:<key>
  title: string;
  kind: "core" | "custom";
  hidden: boolean;
}

function SectionManager({ data, onChange }: {
  data: ResumeData;
  onChange: (next: ResumeData) => void;
}) {
  const mat = useMemo(() => withMaterializedOrder(data), [data]);
  const rows: ManagerRow[] = [];
  for (const ref of mat.order) {
    if (ref.startsWith("custom:")) {
      const c = data.custom.find((x) => x.key === ref.slice(7));
      if (c) rows.push({ ref, title: c.title || c.key, kind: "custom", hidden: false });
    } else {
      rows.push({ ref, title: data.titles[ref]?.trim() || RESUME_CORE_TITLES[ref] || ref, kind: "core", hidden: false });
    }
  }
  for (const k of CORE_ORDER_KEYS) if (!mat.order.includes(k)) rows.push({ ref: k, title: data.titles[k]?.trim() || RESUME_CORE_TITLES[k], kind: "core", hidden: true });
  const visibleRows = rows.filter((r) => r.hidden || r.kind === "core" || r.ref.startsWith("custom:"));

  const setOrder = (order: string[]) => onChange({ ...data, order });

  const move = (idx: number, dir: -1 | 1) => {
    const ordered = visibleRows.filter((r) => !r.hidden).map((r) => r.ref);
    const pos = ordered.indexOf(visibleRows[idx].ref);
    setOrder(moveItem(ordered, pos, pos + dir));
  };

  const remove = (row: ManagerRow) => {
    if (row.kind === "custom") {
      onChange({
        ...data,
        custom: data.custom.filter((c) => c.key !== row.ref.slice(7)),
        order: withMaterializedOrder(data).order.filter((r) => r !== row.ref),
      });
    } else {
      setOrder(withMaterializedOrder(data).order.filter((r) => r !== row.ref));
    }
  };

  const restore = (ref: string) => setOrder([...withMaterializedOrder(data).order, ref]);

  const rename = (row: ManagerRow, title: string) => {
    if (row.kind === "custom") {
      onChange({ ...data, custom: data.custom.map((c) => (c.key === row.ref.slice(7) ? { ...c, title } : c)) });
    } else {
      onChange({ ...data, titles: { ...data.titles, [row.ref]: title } });
    }
  };

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">Drag-free ordering — use the arrows. Renaming a section changes its heading in the preview and exports.</p>
      {visibleRows.map((r, idx) => (
        <div key={r.ref} className={cn("flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5", r.hidden && "opacity-50")}>
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/80">{r.title}</span>
          {r.hidden ? (
            <button type="button" aria-label={`Restore ${r.title}`} onClick={() => restore(r.ref)} className="text-muted-foreground hover:text-primary" title="Restore section">
              <RotateCcw className="size-3.5" aria-hidden />
            </button>
          ) : (
            <>
              <Input
                value={r.title}
                onChange={(e) => rename(r, e.target.value)}
                aria-label={`Rename ${r.title} section`}
                className="h-7 w-28 border-white/10 bg-white/[0.04] px-1.5 text-[11px]"
                placeholder={r.title}
              />
              <button type="button" aria-label={`Move ${r.title} up`} onClick={() => move(idx, -1)} className="text-muted-foreground hover:text-foreground">
                <ArrowUp className="size-3.5" aria-hidden />
              </button>
              <button type="button" aria-label={`Move ${r.title} down`} onClick={() => move(idx, 1)} className="text-muted-foreground hover:text-foreground">
                <ArrowDown className="size-3.5" aria-hidden />
              </button>
              <button type="button" aria-label={`Remove ${r.title}`} onClick={() => remove(r)} className="text-muted-foreground hover:text-destructive" title={r.kind === "core" ? "Hide section (content kept)" : "Delete section"}>
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- panel

export function LaxiiResumePanel({
  conversationId,
  caps,
  onOpenConversation,
  onLibraryChanged,
}: {
  conversationId: string | null;
  caps: LaxiiCapabilities | null;
  onOpenConversation: (id: string) => void;
  onLibraryChanged: () => void;
}) {
  const [detail, setDetail] = useState<ResumeDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(conversationId));

  // New-resume facts form
  const [facts, setFacts] = useState<ResumeFacts>(emptyFacts());
  const [profession, setProfession] = useState<string>("");
  const [resumeType, setResumeType] = useState("ats");
  const [targetTitle, setTargetTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [parsing, setParsing] = useState(false);
  // M33.5-A: structured import review — the proposal must be confirmed by the
  // user before any of its fields reach the facts form.
  const [importProposal, setImportProposal] = useState<ResumeImportProposal | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // Document editor state
  const [data, setData] = useState<ResumeData>(emptyResumeData());
  const [template, setTemplate] = useState<TemplateId>("classic");
  const [aiTouched, setAiTouched] = useState<ResumeSectionKey[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);

  // M33.5-C: tailored copy state (JD privacy toggle + busy flag)
  const [saveFullJd, setSaveFullJd] = useState(false);
  // M33.5-D: career-document workspace tab ("resume" | "cover-letter").
  const [workspaceTab, setWorkspaceTab] = useState<string>("resume");
  // Action state
  const [busyAction, setBusyAction] = useState<"" | "generate" | "tailor" | "rephrase" | "tailor_copy" | "save" | "export">("");
  const [exportFormat, setExportFormat] = useState<"pdf" | "docx">("pdf");
  const fileRef = useRef<HTMLInputElement>(null);

  const professionDef = findResumeProfession(profession || detail?.profession || null);
  const sectionLabel = useCallback(
    (key: ResumeCoreSectionKey, fallback: string) => professionDef?.sectionLabels?.[key] ?? fallback,
    [professionDef]
  );

  const loadDetail = useCallback((id: string) => {
    setLoading(true);
    let alive = true;
    laxiiApi
      .resumeDetail(id)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setData(d.data);
        setTemplate(d.template);
        setAiTouched(d.aiTouched);
        setResumeType(d.resumeType);
        setTargetTitle(d.targetTitle ?? "");
        setJobDescription(d.jobDescription ?? "");
        setMissing(d.missing ?? []);
        setDirty(false);
      })
      .catch((e) => {
        if (alive) toast.error(e instanceof Error ? e.message : "Could not load the resume.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (conversationId) return loadDetail(conversationId);
    setDetail(null);
    setLoading(false);
    return undefined;
  }, [conversationId, loadDetail]);

  function updateFacts(patch: Partial<ResumeFacts>) {
    setFacts((f) => ({ ...f, ...patch }));
  }

  async function handleUploadResume(file: File) {
    setParsing(true);
    try {
      // M33.5-A: one call returns the extracted text plus a deterministic
      // structured proposal. Nothing is stored server-side; the review
      // dialog decides what reaches the facts form.
      const res = await laxiiApi.resumeImport(file);
      setSourceText(res.text);
      setSourceName(file.name);
      setImportProposal(res.proposal);
      setImportOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read the file.");
    } finally {
      setParsing(false);
    }
  }

  /** Merge user-confirmed import fields into the facts form. */
  function applyImport(payload: ApplyPayload) {
    setFacts((f) => {
      const basics = { ...f.basics };
      for (const b of payload.basics) {
        (basics as unknown as Record<string, string>)[b.key] = b.value;
      }
      return {
        ...f,
        basics,
        work: [...f.work, ...payload.work.map((w) => ({ ...w, highlights: [...w.highlights] }))].slice(0, 15),
        education: [...f.education, ...payload.education.map((e) => ({ ...e }))].slice(0, 10),
        skills: [...f.skills, ...payload.skills.map((name) => ({ name, level: "" }))].slice(0, 40),
        projects: [...f.projects, ...payload.projects.map((p) => ({ ...p, highlights: [...p.highlights] }))].slice(0, 10),
        certificates: [...f.certificates, ...payload.certificates.map((c) => ({ ...c }))].slice(0, 15),
        awards: [...f.awards, ...payload.awards.map((a) => ({ ...a }))].slice(0, 10),
      };
    });
    setImportOpen(false);
    const n = payload.basics.length + payload.work.length + payload.education.length + payload.skills.length + payload.projects.length + payload.certificates.length + payload.awards.length;
    toast.success(
      `${n} field${n === 1 ? "" : "s"} added to the facts form — review them, then generate. The extracted text stays as source material.`
    );
  }

  function discardImport() {
    setImportOpen(false);
    setImportProposal(null);
  }

  // ------------------------------------------------------- custom sections
  const suggestedSections = (professionDef?.customSections ?? []).filter(
    (def) => !facts.custom.some((c) => c.key === def.key)
  );

  function addCustomSection(def: ResumeCustomSectionDef) {
    if (facts.custom.length >= 8) {
      toast.info("At most 8 custom sections per resume.");
      return;
    }
    updateFacts({
      custom: [
        ...facts.custom,
        { key: def.key, title: def.label, entries: [{ ...emptyEntry(), title: "" }] },
      ],
    });
  }

  function updateCustomSection(idx: number, next: ResumeCustomSection) {
    updateFacts({ custom: facts.custom.map((c, i) => (i === idx ? next : c)) });
  }

  function removeCustomSection(idx: number) {
    updateFacts({ custom: facts.custom.filter((_, i) => i !== idx) });
  }

  function moveCustomSection(idx: number, dir: -1 | 1) {
    updateFacts({ custom: moveItem(facts.custom, idx, idx + dir) });
  }

  // ------------------------------------------------------------- AI actions
  async function runGenerate() {
    if (!facts.basics.name.trim()) {
      toast.error("Your name is required to generate a resume.");
      return;
    }
    setBusyAction("generate");
    try {
      const res = await laxiiApi.resumeGenerate({
        conversationId: conversationId ?? undefined,
        facts,
        resumeType,
        targetTitle,
        jobDescription,
        ...(profession ? { profession } : {}),
        ...(sourceText ? { sourceText } : {}),
      });
      setNotes(res.notes);
      setAiTouched(res.aiTouched);
      setMissing(res.missing ?? []);
      setData(res.resume);
      if (res.profession) setProfession(res.profession);
      onOpenConversation(res.conversationId);
      onLibraryChanged();
      toast.success("Resume draft generated — every fact came from your input.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Generation failed.");
    } finally {
      setBusyAction("");
    }
  }

  async function runTailor() {
    if (!conversationId) return;
    if (!jobDescription.trim()) {
      toast.error("Paste the job description to tailor against.");
      return;
    }
    setBusyAction("tailor");
    try {
      const res = await laxiiApi.resumeTailor(conversationId, jobDescription, targetTitle || undefined);
      setNotes(res.notes);
      setAiTouched(res.aiTouched);
      setMissing(res.missing ?? []);
      setData(res.resume);
      setDirty(false);
      toast.success("Resume tailored to the job description.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Tailoring failed.");
    } finally {
      setBusyAction("");
    }
  }

  /** M33.5-C: create a job-specific copy; the master resume stays untouched. */
  async function runTailorCopy() {
    if (!conversationId) return;
    if (!jobDescription.trim()) {
      toast.error("Paste the job description first — the copy is tailored against it.");
      return;
    }
    setBusyAction("tailor_copy");
    try {
      const res = await laxiiApi.resumeTailorCopy({
        conversationId,
        jobDescription,
        ...(targetTitle ? { targetTitle } : {}),
        saveFullJobDescription: saveFullJd,
      });
      setNotes(res.notes);
      setAiTouched(res.aiTouched);
      setDirty(false);
      onOpenConversation(res.conversationId);
      onLibraryChanged();
      toast.success("Tailored copy created — your master resume was not modified.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the tailored copy.");
    } finally {
      setBusyAction("");
    }
  }

  async function runRephrase(section: ResumeSectionKey) {
    if (!conversationId) return;
    setBusyAction("rephrase");
    try {
      const res = await laxiiApi.resumeRephrase(conversationId, section);
      setNotes(res.notes);
      setAiTouched(res.aiTouched);
      setData(res.resume);
      setDirty(false);
      toast.success("Wording improved — content unchanged.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rephrasing failed.");
    } finally {
      setBusyAction("");
    }
  }

  async function saveEdits(nextTemplate?: TemplateId, silent = false) {
    if (!conversationId) return;
    setBusyAction("save");
    try {
      await laxiiApi.resumeSave({
        conversationId,
        data,
        ...(nextTemplate ? { template: nextTemplate } : {}),
      });
      setDirty(false);
      if (nextTemplate) setTemplate(nextTemplate);
      if (!silent) toast.success("Resume saved.");
      onLibraryChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusyAction("");
    }
  }

  async function switchTemplate(next: TemplateId) {
    setTemplate(next);
    if (conversationId) {
      await saveEdits(next, true);
      toast.info(`Template switched to ${next}.`);
    }
  }

  async function runExport(format: "pdf" | "docx") {
    if (!conversationId) return;
    setBusyAction("export");
    setExportFormat(format);
    try {
      const res = await laxiiApi.resumeExport(conversationId, format, template);
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? "Export failed.");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = match?.[1] ?? `resume.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`${format.toUpperCase()} exported.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusyAction("");
    }
  }

  const badge = (section: ResumeSectionKey) =>
    aiTouched.includes(section) ? (
      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
        <Sparkles className="size-2.5" aria-hidden /> AI wording
      </span>
    ) : null;

  if (loading) {
    return (
      <div className="grid place-items-center py-20" data-testid="laxii-resume-loading">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading resume" />
      </div>
    );
  }

  const isExisting = Boolean(detail);

  if (workspaceTab === "cover-letter") {
    return <LaxiiCoverLetterPanel onBackToResume={() => setWorkspaceTab("resume")} />;
  }

  return (
    <div
      className="mx-auto grid h-full w-full max-w-7xl grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-4 px-4 py-4 lg:grid-cols-[minmax(340px,440px)_1fr] lg:grid-rows-[minmax(0,1fr)]"
      data-testid="laxii-resume-panel"
    >
      <LaxiiResumeImportReview proposal={importProposal} open={importOpen} onApply={applyImport} onDiscard={discardImport} />
      {/* M33.5-D: career-document workspace tabs — cover letters live INSIDE
          the existing resume studio surface (no new navigation item). */}
      <div className="flex items-center gap-1 px-1 pt-1" role="tablist" aria-label="Career document workspace">
        <button
          type="button"
          role="tab"
          aria-selected={workspaceTab === "resume"}
          onClick={() => setWorkspaceTab("resume")}
          className={cn(
            "rounded-full px-3 py-1.5 text-[11.5px] font-medium transition-colors",
            workspaceTab === "resume" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
          )}
          data-testid="laxii-workspace-tab-resume"
        >
          Resume
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={workspaceTab === "cover-letter"}
          onClick={() => setWorkspaceTab("cover-letter")}
          className={cn(
            "rounded-full px-3 py-1.5 text-[11.5px] font-medium transition-colors",
            workspaceTab === "cover-letter" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
          )}
          data-testid="laxii-workspace-tab-cover-letter"
        >
          Cover letter
        </button>
      </div>
      {/* LEFT — form / editor (scrolls internally, fills the viewport height) */}
      <div className="laxii-scroll min-h-0 space-y-3 overflow-y-auto pb-6 pr-1">
        {!isExisting ? (
          <>
            <SectionCard title="Profession" icon={<UserRound className="size-4" aria-hidden />}>
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Profession family</span>
                <Select value={profession || "none"} onValueChange={(v) => setProfession(v === "none" ? "" : v)}>
                  <SelectTrigger
                    className="h-9 w-full min-w-0 border-white/10 bg-white/[0.04] text-sm"
                    aria-label="Profession family"
                    data-testid="laxii-resume-profession"
                  >
                    <SelectValue placeholder="Choose a profession (optional)" />
                  </SelectTrigger>
                  <SelectContent className="max-w-[calc(100vw-2rem)]">
                    <SelectItem value="none">General — no profession selected</SelectItem>
                    {RESUME_PROFESSION_FAMILIES.map((p) => (
                      <SelectItem key={p.slug} value={p.slug} className="whitespace-normal">
                        <span className="block whitespace-normal">{p.label}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {professionDef ? (
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  {professionDef.blurb} — e.g. {professionDef.roles.slice(0, 3).join(", ")}.
                </p>
              ) : null}
            </SectionCard>

            <SectionCard title="Upload existing resume (optional)" icon={<Upload className="size-4" aria-hidden />}>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.txt,.md,application/pdf"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleUploadResume(f);
                  e.currentTarget.value = "";
                }}
              />
              <Button variant="outline" size="sm" className="w-full border-white/15 bg-white/[0.04]" onClick={() => fileRef.current?.click()} disabled={parsing}>
                {parsing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <FileText className="size-3.5" aria-hidden />}
                {parsing ? "Reading file…" : sourceName ? `Replace: ${sourceName}` : "Upload PDF, DOCX or TXT"}
              </Button>
              {sourceText ? (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {sourceText.length.toLocaleString()} characters extracted — used as source material for generation.
                </p>
              ) : (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  We extract the text and propose structured fields for your review — nothing is saved until you confirm. Scans (image-only PDFs) can’t be read.
                </p>
              )}
              {importProposal ? (
                <Button variant="ghost" size="sm" className="mt-1 h-7 gap-1 text-[11px]" onClick={() => setImportOpen(true)} data-testid="laxii-import-review-reopen">
                  Re-open the fact review ({[importProposal.basics.name, importProposal.basics.email, importProposal.basics.phone, importProposal.basics.website, importProposal.basics.location, importProposal.basics.summary].filter(Boolean).length + importProposal.work.length + importProposal.education.length + importProposal.skills.length} proposals)
                </Button>
              ) : null}
            </SectionCard>

            <SectionCard title="Personal details" icon={<UserRound className="size-4" aria-hidden />}>
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="Full name *" value={facts.basics.name} onChange={(v) => updateFacts({ basics: { ...facts.basics, name: v } })} placeholder="Asha Verma" testid="laxii-resume-name" />
                <Field label="Target role" value={facts.basics.label} onChange={(v) => updateFacts({ basics: { ...facts.basics, label: v } })} placeholder="Frontend Engineer" />
                <Field label="Email" value={facts.basics.email} onChange={(v) => updateFacts({ basics: { ...facts.basics, email: v } })} placeholder="you@example.com" type="email" />
                <Field label="Phone" value={facts.basics.phone} onChange={(v) => updateFacts({ basics: { ...facts.basics, phone: v } })} placeholder="+91 …" />
                <Field label="Location" value={facts.basics.location} onChange={(v) => updateFacts({ basics: { ...facts.basics, location: v } })} placeholder="Bengaluru, India" />
                <Field label="Website" value={facts.basics.website} onChange={(v) => updateFacts({ basics: { ...facts.basics, website: v } })} placeholder="beanfolio.app/u/…" />
              </div>
            </SectionCard>

            <SectionCard
              title={sectionLabel("work", "Experience")}
              icon={<Briefcase className="size-4" aria-hidden />}
              action={
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={() => updateFacts({ work: [...facts.work, { company: "", position: "", startDate: "", endDate: "", current: false, summary: "", highlights: [] }] })}>
                  <Plus className="size-3" aria-hidden /> Add
                </Button>
              }
            >
              {facts.work.length === 0 ? <p className="text-[11px] text-muted-foreground">No roles yet — add the positions you have held.</p> : null}
              <div className="space-y-2.5">
                {facts.work.map((w, i) => (
                  <ItemShell key={i} title={w.position || w.company || `Role ${i + 1}`} onRemove={() => updateFacts({ work: facts.work.filter((_, j) => j !== i) })}>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Company" value={w.company} onChange={(v) => updateFacts({ work: facts.work.map((x, j) => (j === i ? { ...x, company: v } : x)) })} />
                      <Field label="Position" value={w.position} onChange={(v) => updateFacts({ work: facts.work.map((x, j) => (j === i ? { ...x, position: v } : x)) })} />
                      <Field label="Start" value={w.startDate} onChange={(v) => updateFacts({ work: facts.work.map((x, j) => (j === i ? { ...x, startDate: v } : x)) })} placeholder="2021-03" />
                      <Field label="End" value={w.endDate} onChange={(v) => updateFacts({ work: facts.work.map((x, j) => (j === i ? { ...x, endDate: v } : x)) })} placeholder={w.current ? "Present" : "2023-06"} />
                    </div>
                    <label className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <input type="checkbox" checked={w.current} onChange={(e) => updateFacts({ work: facts.work.map((x, j) => (j === i ? { ...x, current: e.target.checked } : x)) })} className="accent-[#C9A24B]" />
                      Currently work here
                    </label>
                    <div className="mt-2">
                      <Area label="What you did" value={w.summary} onChange={(v) => updateFacts({ work: facts.work.map((x, j) => (j === i ? { ...x, summary: v } : x)) })} rows={2} />
                    </div>
                  </ItemShell>
                ))}
              </div>
            </SectionCard>

            <SectionCard
              title={sectionLabel("education", "Education")}
              icon={<GraduationCap className="size-4" aria-hidden />}
              action={
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={() => updateFacts({ education: [...facts.education, { institution: "", area: "", studyType: "", startDate: "", endDate: "", score: "" }] })}>
                  <Plus className="size-3" aria-hidden /> Add
                </Button>
              }
            >
              {facts.education.length === 0 ? <p className="text-[11px] text-muted-foreground">Degrees and courses you have completed.</p> : null}
              <div className="space-y-2.5">
                {facts.education.map((e, i) => (
                  <ItemShell key={i} title={e.institution || `Education ${i + 1}`} onRemove={() => updateFacts({ education: facts.education.filter((_, j) => j !== i) })}>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Institution" value={e.institution} onChange={(v) => updateFacts({ education: facts.education.map((x, j) => (j === i ? { ...x, institution: v } : x)) })} />
                      <Field label="Degree" value={e.studyType} onChange={(v) => updateFacts({ education: facts.education.map((x, j) => (j === i ? { ...x, studyType: v } : x)) })} />
                      <Field label="Field" value={e.area} onChange={(v) => updateFacts({ education: facts.education.map((x, j) => (j === i ? { ...x, area: v } : x)) })} />
                      <Field label="Score" value={e.score} onChange={(v) => updateFacts({ education: facts.education.map((x, j) => (j === i ? { ...x, score: v } : x)) })} placeholder="8.6 CGPA" />
                      <Field label="Start" value={e.startDate} onChange={(v) => updateFacts({ education: facts.education.map((x, j) => (j === i ? { ...x, startDate: v } : x)) })} />
                      <Field label="End" value={e.endDate} onChange={(v) => updateFacts({ education: facts.education.map((x, j) => (j === i ? { ...x, endDate: v } : x)) })} />
                    </div>
                  </ItemShell>
                ))}
              </div>
            </SectionCard>

            <SectionCard title={sectionLabel("skills", "Skills")} icon={<BadgeCheck className="size-4" aria-hidden />}>
              <Area
                label="Comma-separated"
                value={facts.skills.map((s) => (typeof s === "string" ? s : s.name)).join(", ")}
                onChange={(v) => updateFacts({ skills: v.split(",").map((s) => s.trim()).filter(Boolean) })}
                placeholder={professionDef?.skillPlaceholder ?? "React, TypeScript, Figma"}
                rows={2}
              />
            </SectionCard>

            <SectionCard
              title={sectionLabel("projects", "Projects")}
              icon={<FolderKanban className="size-4" aria-hidden />}
              action={
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={() => updateFacts({ projects: [...facts.projects, { name: "", description: "", highlights: [], url: "" }] })}>
                  <Plus className="size-3" aria-hidden /> Add
                </Button>
              }
            >
              {facts.projects.length === 0 ? <p className="text-[11px] text-muted-foreground">Optional — standout projects.</p> : null}
              <div className="space-y-2.5">
                {facts.projects.map((p, i) => (
                  <ItemShell key={i} title={p.name || `Project ${i + 1}`} onRemove={() => updateFacts({ projects: facts.projects.filter((_, j) => j !== i) })}>
                    <Field label="Name" value={p.name} onChange={(v) => updateFacts({ projects: facts.projects.map((x, j) => (j === i ? { ...x, name: v } : x)) })} />
                    <div className="mt-2">
                      <Area label="Description" value={p.description} onChange={(v) => updateFacts({ projects: facts.projects.map((x, j) => (j === i ? { ...x, description: v } : x)) })} rows={2} />
                    </div>
                  </ItemShell>
                ))}
              </div>
            </SectionCard>

            <SectionCard
              title={sectionLabel("certificates", "Certifications")}
              icon={<Award className="size-4" aria-hidden />}
              action={
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={() => updateFacts({ certificates: [...facts.certificates, { name: "", issuer: "", date: "" }] })}>
                  <Plus className="size-3" aria-hidden /> Add
                </Button>
              }
            >
              {facts.certificates.length === 0 ? <p className="text-[11px] text-muted-foreground">Optional — certifications you have earned.</p> : null}
              <div className="space-y-2.5">
                {facts.certificates.map((c, i) => (
                  <ItemShell key={i} title={c.name || `Certificate ${i + 1}`} onRemove={() => updateFacts({ certificates: facts.certificates.filter((_, j) => j !== i) })}>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Name" value={c.name} onChange={(v) => updateFacts({ certificates: facts.certificates.map((x, j) => (j === i ? { ...x, name: v } : x)) })} />
                      <Field label="Issuer" value={c.issuer} onChange={(v) => updateFacts({ certificates: facts.certificates.map((x, j) => (j === i ? { ...x, issuer: v } : x)) })} />
                      <Field label="Date" value={c.date} onChange={(v) => updateFacts({ certificates: facts.certificates.map((x, j) => (j === i ? { ...x, date: v } : x)) })} />
                    </div>
                  </ItemShell>
                ))}
              </div>
            </SectionCard>

            <SectionCard
              title={sectionLabel("awards", "Achievements")}
              icon={<Award className="size-4" aria-hidden />}
              action={
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={() => updateFacts({ awards: [...facts.awards, { title: "", awarder: "", date: "", summary: "" }] })}>
                  <Plus className="size-3" aria-hidden /> Add
                </Button>
              }
            >
              {facts.awards.length === 0 ? <p className="text-[11px] text-muted-foreground">Optional — awards and recognitions.</p> : null}
              <div className="space-y-2.5">
                {facts.awards.map((a, i) => (
                  <ItemShell key={i} title={a.title || `Achievement ${i + 1}`} onRemove={() => updateFacts({ awards: facts.awards.filter((_, j) => j !== i) })}>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Title" value={a.title} onChange={(v) => updateFacts({ awards: facts.awards.map((x, j) => (j === i ? { ...x, title: v } : x)) })} />
                      <Field label="Awarded by" value={a.awarder} onChange={(v) => updateFacts({ awards: facts.awards.map((x, j) => (j === i ? { ...x, awarder: v } : x)) })} />
                    </div>
                  </ItemShell>
                ))}
              </div>
            </SectionCard>

            {facts.custom.map((c, i) => (
              <CustomSectionCard
                key={c.key}
                section={c}
                index={i}
                total={facts.custom.length}
                onChange={(next) => updateCustomSection(i, next)}
                onRemove={() => removeCustomSection(i)}
                onMove={(dir) => moveCustomSection(i, dir)}
              />
            ))}

            {suggestedSections.length > 0 ? (
              <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-3.5">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {professionDef?.label ?? "Profession"} sections you can add
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {suggestedSections.map((def) => (
                    <button
                      key={def.key}
                      type="button"
                      onClick={() => addCustomSection(def)}
                      title={def.blurb}
                      className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] text-primary transition-colors hover:bg-primary/20"
                    >
                      <Plus className="size-3" aria-hidden /> {def.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <SectionCard title="Targeting" icon={<Wand2 className="size-4" aria-hidden />}>
              <div className="space-y-2.5">
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Resume format</span>
                  <Select value={resumeType} onValueChange={setResumeType}>
                    {/* w-full + min-w-0: the long value text must never force
                        the trigger past its card/viewport (was `w-fit` by
                        default — on a 390px screen it rendered 576px wide). */}
                    <SelectTrigger
                      className="h-9 w-full min-w-0 border-white/10 bg-white/[0.04] text-sm"
                      aria-label="Resume format"
                      data-testid="laxii-resume-type"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    {/* Viewport-safe: capped to the screen so options stay
                        inside the visible layout (long blurbs wrap instead of
                        overflowing); Radix's available-height cap + internal
                        scroll handles height, so scrolling appears only when
                        the option count requires it. */}
                    <SelectContent className="max-w-[calc(100vw-2rem)]">
                      {RESUME_TYPES.map((t) => (
                        <SelectItem key={t.slug} value={t.slug} className="whitespace-normal">
                          <span className="block whitespace-normal">
                            {t.label} — {t.blurb}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <Field label="Target job title (optional)" value={targetTitle} onChange={setTargetTitle} placeholder="Senior Frontend Engineer" />
                <Area label="Job description (optional — for tailoring)" value={jobDescription} onChange={setJobDescription} rows={4} placeholder="Paste the posting you want the resume aligned to…" />
              </div>
            </SectionCard>

            <Button
              onClick={runGenerate}
              disabled={busyAction === "generate"}
              className="h-11 w-full gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
              data-testid="laxii-resume-generate"
            >
              {busyAction === "generate" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Wand2 className="size-4" aria-hidden />}
              {busyAction === "generate" ? "Writing your resume…" : "Generate resume draft"}
            </Button>
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
              The AI only reorganizes and rewords what you provide — it never invents experience. Every section stays editable, and AI-touched wording is badged.
            </p>
          </>
        ) : (
          <>
            {detail?.variantKind === "tailored" ? (
              <p className="rounded-xl border border-primary/25 bg-primary/[0.06] px-3 py-2 text-[11px] leading-relaxed text-primary" data-testid="laxii-resume-variant-badge">
                Tailored copy — the master resume it came from is unchanged and stays in your library.
              </p>
            ) : null}
            {/* Document editor — every section editable */}
            <SectionCard
              title="Template"
              icon={<Wand2 className="size-4" aria-hidden />}
            >
              <div className="grid grid-cols-2 gap-2">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => void switchTemplate(t.id)}
                    className={cn(
                      "rounded-lg border px-2.5 py-2 text-left text-xs transition-colors",
                      template === t.id ? "border-primary/60 bg-primary/10 text-primary" : "border-white/10 bg-white/[0.03] hover:border-white/25"
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </SectionCard>

            <SectionCard title="Sections" icon={<SquarePen className="size-4" aria-hidden />}>
              <SectionManager data={data} onChange={(next) => { setData(next); setDirty(true); }} />
            </SectionCard>

            <SectionCard title="Personal details" icon={<UserRound className="size-4" aria-hidden />} action={badge("basics")}>
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="Full name" value={data.basics.name} onChange={(v) => { setData((d) => ({ ...d, basics: { ...d.basics, name: v } })); setDirty(true); }} />
                <Field label="Title" value={data.basics.label} onChange={(v) => { setData((d) => ({ ...d, basics: { ...d.basics, label: v } })); setDirty(true); }} />
                <Field label="Email" value={data.basics.email} onChange={(v) => { setData((d) => ({ ...d, basics: { ...d.basics, email: v } })); setDirty(true); }} />
                <Field label="Phone" value={data.basics.phone} onChange={(v) => { setData((d) => ({ ...d, basics: { ...d.basics, phone: v } })); setDirty(true); }} />
                <Field label="Location" value={data.basics.location} onChange={(v) => { setData((d) => ({ ...d, basics: { ...d.basics, location: v } })); setDirty(true); }} />
                <Field label="Website" value={data.basics.website} onChange={(v) => { setData((d) => ({ ...d, basics: { ...d.basics, website: v } })); setDirty(true); }} />
              </div>
            </SectionCard>

            <SectionCard title={data.titles.summary?.trim() || "Summary"} icon={<FileText className="size-4" aria-hidden />} action={<>
              {badge("summary")}
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={() => void runRephrase("summary")} disabled={busyAction !== ""}>
                <Sparkles className="size-3" aria-hidden /> Improve wording
              </Button>
            </>}>
              <Area label={data.titles.summary?.trim() || "Summary"} value={data.basics.summary} onChange={(v) => { setData((d) => ({ ...d, basics: { ...d.basics, summary: v } })); setDirty(true); }} rows={4} />
            </SectionCard>

            <SectionCard title={data.titles.work?.trim() || "Experience"} icon={<Briefcase className="size-4" aria-hidden />} action={badge("work")}>
              <div className="space-y-2.5">
                {data.work.map((w, i) => (
                  <ItemShell key={i} title={w.position || w.company || `Role ${i + 1}`} onRemove={() => { setData((d) => ({ ...d, work: d.work.filter((_, j) => j !== i) })); setDirty(true); }}>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Company" value={w.company} onChange={(v) => { setData((d) => ({ ...d, work: d.work.map((x, j) => (j === i ? { ...x, company: v } : x)) })); setDirty(true); }} />
                      <Field label="Position" value={w.position} onChange={(v) => { setData((d) => ({ ...d, work: d.work.map((x, j) => (j === i ? { ...x, position: v } : x)) })); setDirty(true); }} />
                      <Field label="Start" value={w.startDate} onChange={(v) => { setData((d) => ({ ...d, work: d.work.map((x, j) => (j === i ? { ...x, startDate: v } : x)) })); setDirty(true); }} />
                      <Field label="End" value={w.endDate} onChange={(v) => { setData((d) => ({ ...d, work: d.work.map((x, j) => (j === i ? { ...x, endDate: v } : x)) })); setDirty(true); }} />
                    </div>
                    <div className="mt-2">
                      <Area label="Summary" value={w.summary} onChange={(v) => { setData((d) => ({ ...d, work: d.work.map((x, j) => (j === i ? { ...x, summary: v } : x)) })); setDirty(true); }} rows={2} />
                    </div>
                    <div className="mt-2">
                      <Area label="Highlights (one per line)" value={w.highlights.join("\n")} onChange={(v) => { setData((d) => ({ ...d, work: d.work.map((x, j) => (j === i ? { ...x, highlights: v.split("\n").map((s) => s.trimStart()).filter(Boolean) } : x)) })); setDirty(true); }} rows={3} />
                    </div>
                  </ItemShell>
                ))}
              </div>
              <Button variant="ghost" size="sm" className="mt-2 h-7 gap-1 text-[11px]" onClick={() => { setData((d) => ({ ...d, work: [...d.work, { company: "", position: "", startDate: "", endDate: "", current: false, summary: "", highlights: [] }] })); setDirty(true); }}>
                <Plus className="size-3" aria-hidden /> Add role
              </Button>
            </SectionCard>

            <SectionCard title={data.titles.education?.trim() || "Education"} icon={<GraduationCap className="size-4" aria-hidden />} action={badge("education")}>
              <div className="space-y-2.5">
                {data.education.map((e, i) => (
                  <ItemShell key={i} title={e.institution || `Education ${i + 1}`} onRemove={() => { setData((d) => ({ ...d, education: d.education.filter((_, j) => j !== i) })); setDirty(true); }}>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Institution" value={e.institution} onChange={(v) => { setData((d) => ({ ...d, education: d.education.map((x, j) => (j === i ? { ...x, institution: v } : x)) })); setDirty(true); }} />
                      <Field label="Degree" value={e.studyType} onChange={(v) => { setData((d) => ({ ...d, education: d.education.map((x, j) => (j === i ? { ...x, studyType: v } : x)) })); setDirty(true); }} />
                      <Field label="Field" value={e.area} onChange={(v) => { setData((d) => ({ ...d, education: d.education.map((x, j) => (j === i ? { ...x, area: v } : x)) })); setDirty(true); }} />
                      <Field label="Score" value={e.score} onChange={(v) => { setData((d) => ({ ...d, education: d.education.map((x, j) => (j === i ? { ...x, score: v } : x)) })); setDirty(true); }} />
                    </div>
                  </ItemShell>
                ))}
              </div>
              <Button variant="ghost" size="sm" className="mt-2 h-7 gap-1 text-[11px]" onClick={() => { setData((d) => ({ ...d, education: [...d.education, { institution: "", area: "", studyType: "", startDate: "", endDate: "", score: "" }] })); setDirty(true); }}>
                <Plus className="size-3" aria-hidden /> Add education
              </Button>
            </SectionCard>

            <SectionCard title={data.titles.skills?.trim() || "Skills"} icon={<BadgeCheck className="size-4" aria-hidden />} action={badge("skills")}>
              <Area label="Comma-separated" value={data.skills.map((s) => s.name).join(", ")} onChange={(v) => { setData((d) => ({ ...d, skills: v.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name, level: "" })) })); setDirty(true); }} rows={2} />
            </SectionCard>

            <SectionCard title={data.titles.projects?.trim() || "Projects"} icon={<FolderKanban className="size-4" aria-hidden />} action={badge("projects")}>
              <div className="space-y-2.5">
                {data.projects.map((p, i) => (
                  <ItemShell key={i} title={p.name || `Project ${i + 1}`} onRemove={() => { setData((d) => ({ ...d, projects: d.projects.filter((_, j) => j !== i) })); setDirty(true); }}>
                    <Field label="Name" value={p.name} onChange={(v) => { setData((d) => ({ ...d, projects: d.projects.map((x, j) => (j === i ? { ...x, name: v } : x)) })); setDirty(true); }} />
                    <div className="mt-2">
                      <Area label="Description" value={p.description} onChange={(v) => { setData((d) => ({ ...d, projects: d.projects.map((x, j) => (j === i ? { ...x, description: v } : x)) })); setDirty(true); }} rows={2} />
                    </div>
                  </ItemShell>
                ))}
              </div>
              <Button variant="ghost" size="sm" className="mt-2 h-7 gap-1 text-[11px]" onClick={() => { setData((d) => ({ ...d, projects: [...d.projects, { name: "", description: "", highlights: [], url: "" }] })); setDirty(true); }}>
                <Plus className="size-3" aria-hidden /> Add project
              </Button>
            </SectionCard>

            <SectionCard title={data.titles.certificates?.trim() || "Certifications"} icon={<Award className="size-4" aria-hidden />} action={badge("certificates")}>
              <div className="space-y-2.5">
                {data.certificates.map((c, i) => (
                  <ItemShell key={i} title={c.name || `Certificate ${i + 1}`} onRemove={() => { setData((d) => ({ ...d, certificates: d.certificates.filter((_, j) => j !== i) })); setDirty(true); }}>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Name" value={c.name} onChange={(v) => { setData((d) => ({ ...d, certificates: d.certificates.map((x, j) => (j === i ? { ...x, name: v } : x)) })); setDirty(true); }} />
                      <Field label="Issuer" value={c.issuer} onChange={(v) => { setData((d) => ({ ...d, certificates: d.certificates.map((x, j) => (j === i ? { ...x, issuer: v } : x)) })); setDirty(true); }} />
                    </div>
                  </ItemShell>
                ))}
              </div>
              <Button variant="ghost" size="sm" className="mt-2 h-7 gap-1 text-[11px]" onClick={() => { setData((d) => ({ ...d, certificates: [...d.certificates, { name: "", issuer: "", date: "" }] })); setDirty(true); }}>
                <Plus className="size-3" aria-hidden /> Add certification
              </Button>
            </SectionCard>

            <SectionCard title={data.titles.awards?.trim() || "Achievements"} icon={<Award className="size-4" aria-hidden />} action={badge("awards")}>
              <div className="space-y-2.5">
                {data.awards.map((a, i) => (
                  <ItemShell key={i} title={a.title || `Achievement ${i + 1}`} onRemove={() => { setData((d) => ({ ...d, awards: d.awards.filter((_, j) => j !== i) })); setDirty(true); }}>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Title" value={a.title} onChange={(v) => { setData((d) => ({ ...d, awards: d.awards.map((x, j) => (j === i ? { ...x, title: v } : x)) })); setDirty(true); }} />
                      <Field label="Awarded by" value={a.awarder} onChange={(v) => { setData((d) => ({ ...d, awards: d.awards.map((x, j) => (j === i ? { ...x, awarder: v } : x)) })); setDirty(true); }} />
                    </div>
                  </ItemShell>
                ))}
              </div>
              <Button variant="ghost" size="sm" className="mt-2 h-7 gap-1 text-[11px]" onClick={() => { setData((d) => ({ ...d, awards: [...d.awards, { title: "", awarder: "", date: "", summary: "" }] })); setDirty(true); }}>
                <Plus className="size-3" aria-hidden /> Add achievement
              </Button>
            </SectionCard>

            {data.custom.map((c, i) => (
              <CustomSectionCard
                key={c.key}
                section={c}
                index={i}
                total={data.custom.length}
                onChange={(next) => { setData((d) => ({ ...d, custom: d.custom.map((x, j) => (j === i ? next : x)) })); setDirty(true); }}
                onRemove={() => { setData((d) => ({ ...d, custom: d.custom.filter((_, j) => j !== i), order: d.order.filter((r) => r !== `custom:${c.key}`) })); setDirty(true); }}
                onMove={(dir) => { setData((d) => ({ ...d, custom: moveItem(d.custom, i, i + dir) })); setDirty(true); }}
              />
            ))}

            {conversationId ? (
              <LaxiiResumeVersions
                conversationId={conversationId}
                liveData={data}
                onRestored={(resume) => {
                  setData(resume);
                  setDirty(false);
                  toast.success("Version restored — the previous state was saved as a new version first.");
                }}
              />
            ) : null}

            <SectionCard title="Tailor to a job" icon={<Wand2 className="size-4" aria-hidden />}>
              <Area label="Job description" value={jobDescription} onChange={setJobDescription} rows={4} placeholder="Paste the posting — emphasis will be aligned using only your real experience." />
              <Button onClick={runTailor} disabled={busyAction !== ""} variant="outline" className="mt-2.5 h-9 w-full gap-2 border-primary/40 bg-primary/10 text-primary hover:bg-primary/20" data-testid="laxii-resume-tailor">
                {busyAction === "tailor" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Wand2 className="size-3.5" aria-hidden />}
                Tailor this resume in place
              </Button>
              <div className="mt-3 rounded-xl border border-dashed border-white/15 p-2.5">
                <p className="text-[11px] font-medium text-foreground/80">Keep the master — create a separate tailored copy</p>
                <Button onClick={() => void runTailorCopy()} disabled={busyAction !== ""} variant="outline" className="mt-2 h-9 w-full gap-2 border-primary/40 bg-primary/10 text-primary hover:bg-primary/20" data-testid="laxii-resume-tailor-copy">
                  {busyAction === "tailor_copy" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Layers className="size-3.5" aria-hidden />}
                  Create tailored copy
                </Button>
                <label className="mt-2 flex items-start gap-2 text-[10.5px] leading-relaxed text-muted-foreground">
                  <input type="checkbox" checked={saveFullJd} onChange={(e) => setSaveFullJd(e.target.checked)} className="mt-0.5 accent-[#C9A24B]" />
                  <span>
                    Save the full job description text with this copy. Off by default — only its hash is stored, so the
                    posting text stays on your device unless you opt in.
                  </span>
                </label>
              </div>
            </SectionCard>

            <div className="flex gap-2">
              <Button onClick={() => void saveEdits()} disabled={busyAction !== "" || !dirty} variant="outline" className="h-10 flex-1 gap-2 border-white/15 bg-white/[0.04]" data-testid="laxii-resume-save">
                {busyAction === "save" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
                {dirty ? "Save changes" : "Saved"}
              </Button>
              <Button onClick={() => void runExport("pdf")} disabled={busyAction !== ""} className="h-10 flex-1 gap-2 bg-primary text-primary-foreground hover:bg-primary/90" data-testid="laxii-resume-export-pdf">
                {busyAction === "export" && exportFormat === "pdf" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
                Export PDF
              </Button>
              <Button onClick={() => void runExport("docx")} disabled={busyAction !== ""} variant="outline" className="h-10 flex-1 gap-2 border-primary/40 bg-primary/10 text-primary hover:bg-primary/20" data-testid="laxii-resume-export-docx">
                {busyAction === "export" && exportFormat === "docx" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
                Export DOCX
              </Button>
            </div>
          </>
        )}
      </div>

      {/* RIGHT — preview + provenance (scrolls internally, fills the height) */}
      <div className="laxii-scroll min-h-0 space-y-3 overflow-y-auto pb-6 pr-1">
        {missing.length > 0 ? (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-3.5" data-testid="laxii-resume-missing">
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-400">
              <TriangleAlert className="size-3.5" aria-hidden /> Missing information
            </p>
            <ul className="space-y-0.5 text-[11.5px] text-muted-foreground">
              {missing.map((m, i) => (
                <li key={i}>· {m}</li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Nothing is invented to fill these gaps — add the real details and regenerate.
            </p>
          </div>
        ) : null}

        {notes.length > 0 ? (
          <div className="rounded-2xl border border-primary/25 bg-primary/[0.06] p-3.5" data-testid="laxii-resume-notes">
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-primary">
              <Sparkles className="size-3.5" aria-hidden /> What the AI changed
            </p>
            <ul className="space-y-0.5 text-[11.5px] text-muted-foreground">
              {notes.map((n, i) => (
                <li key={i}>· {n}</li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Suggestions only — every line above is editable, and you are responsible for the final content.
            </p>
          </div>
        ) : null}

        {isExisting ? (
          <>
            {conversationId ? <LaxiiResumeAnalysisPanel conversationId={conversationId} savedJobDescription={detail?.jobDescription ?? ""} /> : null}
            <LaxiiResumePreview data={data} template={template} />
            <p className="flex items-start gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[11px] leading-relaxed text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
              Exports render the exact content above. Structure follows ATS-safe conventions (single column, standard headings, real text), but no tool can guarantee a specific ATS result — always verify.
            </p>
          </>
        ) : (
          <div className="grid min-h-[320px] place-items-center rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-8 text-center">
            <div>
              <FileText className="mx-auto size-8 text-muted-foreground" aria-hidden />
              <p className="mt-3 text-sm font-medium">Your resume preview appears here</p>
              <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                Fill the facts on the left (or upload an existing resume), pick a profession and a format, then generate a draft. Everything stays editable before export.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
