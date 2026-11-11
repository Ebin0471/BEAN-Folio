"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileUp,
  Files,
  Globe,
  GripVertical,
  History,
  LayoutPanelLeft,
  LayoutTemplate,
  Link2,
  Loader2,
  Monitor,
  MousePointerClick,
  Palette,
  PanelRight,
  Pencil,
  Plus,
  RotateCcw,
  Settings2,
  Smartphone,
  Sparkles,
  Tablet,
  Trash2,
  Undo2,
  Redo2,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { MediaDTO, ProjectCardDTO } from "@/lib/types";
import type { PageConfig, PortfolioConfig, SectionConfig, WidgetConfig } from "@/lib/portfolio-schema";
import { SECTION_TYPES, type SectionType, WIDGET_TYPES, type WidgetType } from "@/lib/portfolio-schema";
import { buildDefaultConfig } from "@/lib/portfolio-defaults";
import { TEMPLATES, applyTemplate, getTemplate } from "@/components/bean/portfolio/templates";
import { WIDGET_LABELS } from "@/components/bean/portfolio/widgets";
import { PortfolioRenderer } from "@/components/bean/portfolio/PortfolioRenderer";
import { MediaUploadButton } from "@/components/bean/MediaUploadButton";
import { TagInput } from "@/components/bean/TagInput";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// ---------------------------------------------------------------- metadata

const SECTION_META: Record<SectionType, { label: string; hint: string }> = {
  current: { label: "Currently working on", hint: "A live card for the project you're building right now." },
  stats: { label: "Professional statistics", hint: "Numbers YOU provide (years, clients, releases). Hidden while empty." },
  services: { label: "Professions & services", hint: "What you offer, as editorial cards." },
  featured: { label: "Featured projects", hint: "Hand-picked projects, first one large." },
  gallery: { label: "Project gallery", hint: "All your published public projects, optionally filterable." },
  about: { label: "About me", hint: "Long-form bio in paragraphs." },
  skills: { label: "Skills & stack", hint: "Chip cloud of skills and tools." },
  experience: { label: "Experience & education", hint: "Timeline of roles and studies you enter." },
  testimonials: { label: "Testimonials", hint: "Real quotes from real people. Hidden while empty." },
  writing: { label: "Writing & articles", hint: "Links to things you've written." },
  resume: { label: "Resume download", hint: "Upload a PDF visitors can download." },
  contact: { label: "Contact & social", hint: "Message form (BEAN inbox), email and links." },
  footer: { label: "Footer", hint: "Copyright line and availability." },
};

const WIDGET_HINTS: Partial<Record<WidgetType, string>> = {
  techStack: "Chips of tools & technologies",
  githubRepos: "Cards linking to your repositories (manual entries — nothing is fetched on your behalf)",
  featuredVideo: "One uploaded video, front and center",
  imageGallery: "Your uploaded images with lightbox",
  audioPlayer: "Uploaded tracks with native players",
  projectTimeline: "Milestones of a project or career",
  experienceTimeline: "Work & education timeline",
  achievements: "Awards, certificates, credentials",
  resumeDownload: "Resume PDF + download button",
  socialLinks: "Row of social links",
  availability: "Live availability + location chip (from your BEAN profile)",
  testimonials: "Quote cards",
  writingFeed: "Linked article list",
  currentProgress: "Progress bar on your current project",
  faq: "Expandable questions & answers",
  linkButtons: "Custom button row",
  stats: "Metric grid you provide",
  ctaBanner: "Accent banner with a button",
  codeShowcase: "Syntax-highlighted snippet with copy button",
  beforeAfter: "Drag-to-compare media",
  comparison: "Two projects side by side",
  demoPreview: "Screenshot + live demo link",
  codeSandbox: "Live HTML/CSS/JS demo — runs in a locked-down sandbox only",
  terminalDemo: "Terminal-style command walkthrough",
  codeCompare: "Two code versions side by side",
  archDiagram: "Architecture / pipeline diagram",
  githubSummary: "GitHub numbers you enter — never auto-fetched",
  embedCard: "Approved-source link card (screenshot + link)",
  readmePreview: "README-style document block",
};

const SOCIAL_ICON_OPTIONS = [
  { value: "website", label: "Website" },
  { value: "mail", label: "Email" },
  { value: "github", label: "GitHub" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "x", label: "X / Twitter" },
  { value: "instagram", label: "Instagram" },
  { value: "youtube", label: "YouTube" },
  { value: "dribbble", label: "Dribbble" },
  { value: "behance", label: "Behance" },
  { value: "medium", label: "Medium" },
  { value: "other", label: "Other" },
];

let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}${uidCounter.toString(36)}`;
}

const DEFAULT_WIDGET_DATA: Partial<Record<WidgetType, Record<string, unknown>>> = {
  ctaBanner: { text: "Have a project in mind? Let's talk.", buttonLabel: "Get in touch" },
  codeShowcase: { language: "ts", code: "", caption: "" },
  codeSandbox: {
    html: '<div class="card">\n  <h2>Hello, sandbox</h2>\n  <p>Edit me in the inspector.</p>\n</div>',
    css: '.card { padding: 24px; border: 1px solid #ddd; border-radius: 12px; font-family: system-ui; }\n.card h2 { margin: 0 0 6px; }',
    js: 'document.querySelector(".card").addEventListener("click", () => {\n  document.querySelector(".card").style.background = "#f5edda";\n});',
    note: "Runs fully sandboxed: no network, no cookies, no access to this site.",
    height: 220,
  },
  terminalDemo: { title: "quickstart", lines: [{ cmd: "git clone your-project", output: "" }] },
  codeCompare: { language: "ts", labelA: "Before", labelB: "After", codeA: "", codeB: "" },
  archDiagram: { steps: [] },
  githubSummary: { handle: "", profileUrl: "https://github.com/", items: [] },
  embedCard: { title: "Case study write-up", url: "https://", source: "", note: "" },
  readmePreview: { body: "## About this project\n\nWrite your README here — **bold**, `code` and [links](https://example.com) are supported.", sourceUrl: "" },
};

const DEFAULT_WIDGET_TITLE: Partial<Record<WidgetType, string>> = {
  techStack: "Tech stack",
  githubRepos: "Open source",
  featuredVideo: "Showreel",
  imageGallery: "Gallery",
  audioPlayer: "Listen",
  projectTimeline: "Timeline",
  experienceTimeline: "Experience",
  achievements: "Achievements",
  resumeDownload: "Resume",
  socialLinks: "Elsewhere",
  availability: "Availability",
  testimonials: "Testimonials",
  writingFeed: "Writing",
  currentProgress: "In progress",
  faq: "FAQ",
  linkButtons: "Links",
  stats: "Numbers",
  ctaBanner: "",
  codeShowcase: "Snippet",
  beforeAfter: "Before & after",
  comparison: "Compare",
  demoPreview: "Live demo",
  codeSandbox: "Live demo",
  terminalDemo: "Terminal",
  codeCompare: "Code comparison",
  archDiagram: "Architecture",
  githubSummary: "GitHub",
  embedCard: "Source",
  readmePreview: "README",
};

function slugifyPageName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

// ---------------------------------------------------------------- tiny form atoms

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

interface RowSpec {
  key: string;
  label: string;
  type?: "text" | "textarea" | "select" | "number";
  placeholder?: string;
  options?: { value: string; label: string }[];
  width?: "full" | "half";
}

/** Generic repeatable-row editor used by most list-based sections/widgets. */
function RowEditor({
  items,
  specs,
  defaults,
  onChange,
  addLabel,
  max = 24,
}: {
  items: Record<string, unknown>[];
  specs: RowSpec[];
  defaults: Record<string, unknown>;
  onChange: (items: Record<string, unknown>[]) => void;
  addLabel: string;
  max?: number;
}) {
  const setField = (idx: number, key: string, value: unknown) => {
    const next = items.map((it, i) => (i === idx ? { ...it, [key]: value } : it));
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {items.map((item, idx) => (
        <div key={idx} className="rounded-lg border border-border/70 bg-card/60 p-3">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {specs.map((spec) => (
              <div key={spec.key} className={spec.width === "half" ? "" : "sm:col-span-2"}>
                <Label className="mb-1 block text-[11px] text-muted-foreground">{spec.label}</Label>
                {spec.type === "textarea" ? (
                  <Textarea
                    value={String(item[spec.key] ?? "")}
                    onChange={(e) => setField(idx, spec.key, e.target.value)}
                    placeholder={spec.placeholder}
                    rows={2}
                    className="text-sm"
                    maxLength={spec.key === "quote" || spec.key === "a" ? 600 : 400}
                  />
                ) : spec.type === "select" ? (
                  <Select value={String(item[spec.key] ?? "")} onValueChange={(v) => setField(idx, spec.key, v)}>
                    <SelectTrigger className="text-sm" aria-label={spec.label}>
                      <SelectValue placeholder={spec.label} />
                    </SelectTrigger>
                    <SelectContent>
                      {(spec.options ?? []).map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type={spec.type === "number" ? "number" : "text"}
                    value={String(item[spec.key] ?? "")}
                    onChange={(e) => setField(idx, spec.key, spec.type === "number" ? Number(e.target.value) : e.target.value)}
                    placeholder={spec.placeholder}
                    className="text-sm"
                  />
                )}
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-end">
            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => onChange(items.filter((_, i) => i !== idx))}>
              <Trash2 className="size-3.5" aria-hidden /> Remove
            </Button>
          </div>
        </div>
      ))}
      {items.length < max && (
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onChange([...items, { ...defaults }])}>
          <Plus className="size-3.5" aria-hidden /> {addLabel}
        </Button>
      )}
    </div>
  );
}

function SegRow<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; icon?: React.ComponentType<{ className?: string }> }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors",
              value === o.value ? "border-primary/60 bg-gold-soft text-primary" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {o.icon && <o.icon className="size-3.5" aria-hidden />}
            {o.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => {
            const v = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) onChange(v);
          }}
          className="h-8 w-24 font-mono text-xs uppercase"
          maxLength={7}
          aria-label={`${label} hex value`}
        />
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="size-8 cursor-pointer rounded border border-border bg-transparent p-0.5"
          aria-label={`${label} color picker`}
        />
      </div>
    </div>
  );
}

function ItemMover({ onUp, onDown, first, last }: { onUp: () => void; onDown: () => void; first: boolean; last: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Button variant="ghost" size="icon" className="size-6" onClick={onUp} disabled={first} aria-label="Move up">
        <ArrowUp className="size-3.5" aria-hidden />
      </Button>
      <Button variant="ghost" size="icon" className="size-6" onClick={onDown} disabled={last} aria-label="Move down">
        <ArrowDown className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- main view

type SaveState = "idle" | "saving" | "saved" | "error";
type Device = "desktop" | "tablet" | "mobile";
type Selection = { kind: "hero" } | { kind: "section"; id: string } | { kind: "widget"; id: string } | { kind: "page" } | null;

interface PortfolioMeta {
  slug: string;
  publishedAt: string | null;
  hasPublished: boolean;
  updatedAt: string;
}

interface AiProposal {
  summary: string;
  rationale: string;
  config: PortfolioConfig;
}

export default function PortfolioStudioView() {
  const { user } = useSession();
  const [status, setStatus] = useState<"loading" | "ready" | "no-username" | "error">("loading");
  const [config, setConfig] = useState<PortfolioConfig | null>(null);
  const [meta, setMeta] = useState<PortfolioMeta | null>(null);
  const [projects, setProjects] = useState<ProjectCardDTO[]>([]);
  const [device, setDevice] = useState<Device>("desktop");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [slugDraft, setSlugDraft] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);

  // multi-page + selection
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [deletePageOpen, setDeletePageOpen] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(false); // mobile drawer
  const [rightPanelOpen, setRightPanelOpen] = useState(false); // mobile drawer

  // Code Giftz AI designer
  const [aiOpen, setAiOpen] = useState(false);

  // undo/redo history of JSON snapshots
  const histRef = useRef<{ stack: string[]; idx: number; lastTag: string | null; lastAt: number }>({ stack: [], idx: -1, lastTag: null, lastAt: 0 });
  const savedJsonRef = useRef<string>("");
  const configRef = useRef<PortfolioConfig | null>(null); // event-level mirror for pure mutations
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [histVer, setHistVer] = useState(0); // re-render undo/redo buttons

  // ------------------------------------------------------------ load

  useEffect(() => {
    let alive = true;
    setStatus("loading");
    Promise.all([
      api<{ portfolio: PortfolioMeta; config: PortfolioConfig }>("/api/portfolio"),
      api<{ projects: ProjectCardDTO[] }>("/api/projects?status=PUBLISHED").catch(() => ({ projects: [] })),
    ])
      .then(([pf, pr]) => {
        if (!alive) return;
        setConfig(pf.config);
        configRef.current = pf.config;
        setMeta(pf.portfolio);
        setSlugDraft(pf.portfolio.slug);
        setProjects(pr.projects);
        const json = JSON.stringify(pf.config);
        savedJsonRef.current = json;
        histRef.current = { stack: [json], idx: 0, lastTag: null, lastAt: 0 };
        setActivePageId(pf.config.pages[0]?.id ?? null);
        setStatus("ready");
        setPreviewNonce((n) => n + 1);
      })
      .catch((e: Error & { status?: number }) => {
        if (!alive) return;
        if (e.status === 400) setStatus("no-username");
        else setStatus("error");
      });
    return () => {
      alive = false;
    };
  }, []);

  // ------------------------------------------------------------ mutation core

  const commit = useCallback((next: PortfolioConfig, tag?: string) => {
    const h = histRef.current;
    const json = JSON.stringify(next);
    const now = Date.now();
    if (tag && h.lastTag === tag && now - h.lastAt < 900 && h.idx >= 0) {
      h.stack[h.idx] = json; // coalesce rapid keystrokes into one undo step
    } else {
      h.stack = h.stack.slice(0, h.idx + 1);
      h.stack.push(json);
      if (h.stack.length > 60) h.stack.shift();
      h.idx = h.stack.length - 1;
      h.lastTag = tag ?? null;
    }
    h.lastAt = now;
    configRef.current = next;
    setHistVer((v) => v + 1);
    setConfig(next);
    setDirty(json !== savedJsonRef.current);
  }, []);

  const mutate = useCallback(
    (fn: (c: PortfolioConfig) => void, tag?: string) => {
      const cur = configRef.current;
      if (!cur) return;
      // Pure flow: clone from the ref, mutate the clone, commit at event level.
      // (Calling setState inside a setConfig updater is impure and breaks
      // under StrictMode double-invocation — some updates were lost.)
      const next = JSON.parse(JSON.stringify(cur)) as PortfolioConfig;
      fn(next);
      commit(next, tag);
    },
    [commit]
  );

  /** Mutate the page with the given id (sections/widgets/hero/page-meta editors). */
  const mutatePage = useCallback(
    (pageId: string | null | undefined, fn: (p: PageConfig) => void, tag?: string) => {
      mutate((c) => {
        const p = c.pages.find((x) => x.id === (pageId ?? activePageId));
        if (p) fn(p);
      }, tag);
    },
    [mutate, activePageId]
  );

  // ------------------------------------------------------------ derived

  const activePage = useMemo(
    () => config?.pages.find((p) => p.id === activePageId) ?? config?.pages[0] ?? null,
    [config, activePageId]
  );
  useEffect(() => {
    // keep selection valid when the page/config changes
    if (!config) return;
    if (!activePage) {
      setActivePageId(config.pages[0]?.id ?? null);
      return;
    }
    setSelection((sel) => {
      if (!sel) return sel;
      if (sel.kind === "hero" && !activePage.isHome) return { kind: "page" };
      if (sel.kind === "section" && !activePage.sections.some((s) => s.id === sel.id)) return null;
      if (sel.kind === "widget" && !activePage.widgets.some((w) => w.id === sel.id)) return null;
      return sel;
    });
  }, [config, activePage]);

  // ------------------------------------------------------------ autosave

  useEffect(() => {
    if (!dirty || !config || status !== "ready") return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("idle");
    saveTimer.current = setTimeout(async () => {
      setSaveState("saving");
      try {
        await api("/api/portfolio", { method: "PATCH", json: { config } });
        savedJsonRef.current = JSON.stringify(config);
        setDirty(false);
        setSaveState("saved");
        setSavedAt(new Date());
        setMeta((m) => (m ? { ...m, updatedAt: new Date().toISOString() } : m));
        setPreviewNonce((n) => n + 1);
      } catch (e) {
        setSaveState("error");
        toast.error(e instanceof Error ? e.message : "Autosave failed — press Save to retry.");
      }
    }, 1200);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [config, dirty, status]);

  // warn before leaving with unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ------------------------------------------------------------ undo/redo/save/publish

  const undo = useCallback(() => {
    const h = histRef.current;
    if (h.idx <= 0) return;
    h.idx -= 1;
    h.lastTag = null;
    const cfg = JSON.parse(h.stack[h.idx]) as PortfolioConfig;
    configRef.current = cfg;
    setConfig(cfg);
    setDirty(JSON.stringify(cfg) !== savedJsonRef.current);
    setHistVer((v) => v + 1);
  }, []);

  const redo = useCallback(() => {
    const h = histRef.current;
    if (h.idx >= h.stack.length - 1) return;
    h.idx += 1;
    h.lastTag = null;
    const cfg = JSON.parse(h.stack[h.idx]) as PortfolioConfig;
    configRef.current = cfg;
    setConfig(cfg);
    setDirty(JSON.stringify(cfg) !== savedJsonRef.current);
    setHistVer((v) => v + 1);
  }, []);

  // Keyboard shortcuts: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable;
      if (typing && !(e.metaKey || e.ctrlKey)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  async function saveNow() {
    if (!config) return;
    setSaveState("saving");
    try {
      await api("/api/portfolio", { method: "PATCH", json: { config } });
      savedJsonRef.current = JSON.stringify(config);
      setDirty(false);
      setSaveState("saved");
      setSavedAt(new Date());
      setPreviewNonce((n) => n + 1);
      toast.success("Draft saved");
    } catch (e) {
      setSaveState("error");
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  }

  function publicSiteUrl(slug: string): string {
    return `${window.location.origin}${window.location.pathname}#/site/${slug}`;
  }

  async function publish() {
    if (!config) return;
    if (dirty) {
      await saveNow();
    }
    setPublishing(true);
    try {
      const res = await api<{ portfolio: { slug: string; publishedAt: string } }>("/api/portfolio/publish", { method: "POST" });
      setMeta((m) => (m ? { ...m, hasPublished: true, publishedAt: res.portfolio.publishedAt, slug: res.portfolio.slug } : m));
      setSlugDraft(res.portfolio.slug);
      setPublishing(false);
      setPublishedUrl(publicSiteUrl(res.portfolio.slug));
      setPreviewNonce((n) => n + 1);
    } catch (e) {
      setPublishing(false);
      toast.error(e instanceof Error ? e.message : "Publish failed");
    }
  }

  async function saveSlug() {
    const slug = slugDraft.trim().toLowerCase();
    if (!meta || slug === meta.slug) return;
    try {
      await api("/api/portfolio", { method: "PATCH", json: { slug } });
      setMeta((m) => (m ? { ...m, slug } : m));
      toast.success(`Public address saved: #/site/${slug}`);
      setPreviewNonce((n) => n + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the address");
    }
  }

  async function unpublish() {
    try {
      await api("/api/portfolio/unpublish", { method: "POST" });
      setMeta((m) => (m ? { ...m, hasPublished: false, publishedAt: null } : m));
      toast.success("Portfolio unpublished — the public address is offline.");
      setPreviewNonce((n) => n + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unpublish failed");
    }
  }

  async function rebuildFromProfile() {
    if (!user) return;
    try {
      const me = await api<{ user: import("@/lib/types").PublicMe | null }>("/api/auth/me");
      if (!me.user) throw new Error("Session expired");
      const pubProjects = projects.map((p) => ({
        id: p.id,
        title: p.title,
        summary: p.summary,
        category: p.category,
        coverMediaId: p.coverUrl ? p.coverUrl.replace("/api/media/", "").replace("/raw", "") : null,
      }));
      const fresh = buildDefaultConfig(
        {
          name: me.user.name,
          username: me.user.username,
          headline: me.user.headline,
          bio: me.user.bio,
          location: me.user.location,
          availability: me.user.availability,
          avatarMediaId: me.user.avatarUrl ? me.user.avatarUrl.replace("/api/media/", "").replace("/raw", "") : null,
          coverMediaId: me.user.coverUrl ? me.user.coverUrl.replace("/api/media/", "").replace("/raw", "") : null,
          contactEmail: me.user.contactEmail,
          websiteUrl: me.user.websiteUrl,
          skills: me.user.skills,
          professions: me.user.professions,
        },
        pubProjects
      );
      // keep current template identity
      if (config) fresh.templateId = config.templateId;
      commit(fresh, "rebuild");
      setActivePageId(fresh.pages[0]?.id ?? null);
      setSelection(null);
      setResetOpen(false);
      toast.success("Draft rebuilt from your BEAN Folio profile. Press Save when happy.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rebuild failed");
    }
  }

  async function importJson(file: File) {
    try {
      const text = await file.text();
      await api("/api/portfolio/import", { method: "POST", json: { json: text.slice(0, 220_000) } });
      const pf = await api<{ portfolio: PortfolioMeta; config: PortfolioConfig }>("/api/portfolio");
      setConfig(pf.config);
      configRef.current = pf.config;
      setMeta(pf.portfolio);
      setActivePageId(pf.config.pages[0]?.id ?? null);
      setSelection(null);
      savedJsonRef.current = JSON.stringify(pf.config);
      histRef.current = { stack: [JSON.stringify(pf.config)], idx: 0, lastTag: null, lastAt: 0 };
      setDirty(false);
      setPreviewNonce((n) => n + 1);
      toast.success("Configuration imported into your draft");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    }
  }

  // ------------------------------------------------------------ page operations

  function addPage() {
    if (!config) return;
    mutate((c) => {
      const taken = new Set(c.pages.map((p) => p.slug));
      let slug = "new-page";
      for (let i = 2; i < 40; i++) {
        if (!taken.has(slug)) break;
        slug = `new-page-${i}`;
      }
      c.pages.push({
        id: uid("page"),
        name: "New page",
        slug: taken.has(slug) ? "" : slug,
        isHome: false,
        inNav: true,
        isPublished: true,
        seoTitle: "",
        seoDescription: "",
        hero: {
          name: "", title: "", intro: "", location: "", availability: "",
          avatarMediaId: null, coverMediaId: null, metrics: [], currentProjectId: null,
          showCursorGlow: false, primaryCtaLabel: "View my work", secondaryCtaLabel: "Contact me",
        },
        sections: [],
        widgets: [],
      });
      setActivePageId(c.pages[c.pages.length - 1].id);
      setSelection({ kind: "page" });
    });
  }

  function duplicatePage(pageId: string) {
    mutate((c) => {
      const src = c.pages.find((p) => p.id === pageId);
      if (!src || c.pages.length >= 12) return;
      const taken = new Set(c.pages.map((p) => p.slug));
      let slug = `${src.isHome ? "home-copy" : src.slug}-copy`.slice(0, 24);
      for (let i = 2; i < 40; i++) {
        if (!taken.has(slug) && slug.length >= 3) break;
        slug = `${slug}-${i}`.slice(0, 24);
      }
      const copy: PageConfig = JSON.parse(JSON.stringify(src));
      copy.id = uid("page");
      copy.name = `${src.name} copy`;
      copy.isHome = false;
      copy.slug = slug;
      copy.sections = copy.sections.map((s) => ({ ...s, id: uid("sec") }));
      copy.widgets = copy.widgets.map((w) => ({ ...w, id: uid("w") }));
      c.pages.push(copy);
      setActivePageId(copy.id);
      setSelection({ kind: "page" });
    });
  }

  function deleteActivePage() {
    if (!activePage || activePage.isHome) return;
    const doomedId = activePage.id;
    mutate((c) => {
      c.pages = c.pages.filter((p) => p.id !== doomedId);
    });
    setActivePageId(configRef.current?.pages[0]?.id ?? null);
    setSelection(null);
    setDeletePageOpen(false);
    toast.success("Page deleted from the draft");
  }

  // ------------------------------------------------------------ section/widget ops (selected page)

  function addSection(type: SectionType) {
    if (!activePage) return;
    const id = uid("sec");
    mutatePage(activePage.id, (p) => {
      p.sections.push({ id, type, visible: true, title: SECTION_META[type].label, data: {} });
    });
    setSelection({ kind: "section", id });
    toast.success(`Added “${SECTION_META[type].label}”`);
  }

  function duplicateSection(sectionId: string) {
    if (!activePage) return;
    const newId = uid("sec");
    mutatePage(activePage.id, (p) => {
      const idx = p.sections.findIndex((s) => s.id === sectionId);
      if (idx < 0) return;
      const copy: SectionConfig = JSON.parse(JSON.stringify(p.sections[idx]));
      copy.id = newId;
      copy.title = `${copy.title} copy`;
      p.sections.splice(idx + 1, 0, copy);
    });
    setSelection({ kind: "section", id: newId });
  }

  function addWidget(type: WidgetType) {
    if (!activePage) return;
    const id = uid("w");
    mutatePage(activePage.id, (p) => {
      p.widgets.push({
        id,
        type,
        visible: true,
        title: DEFAULT_WIDGET_TITLE[type] ?? WIDGET_LABELS[type],
        description: "",
        span: "full",
        after: null,
        data: { ...(DEFAULT_WIDGET_DATA[type] ?? {}) },
      });
    });
    setSelection({ kind: "widget", id });
  }

  function duplicateWidget(widgetId: string) {
    if (!activePage) return;
    const newId = uid("w");
    mutatePage(activePage.id, (p) => {
      const idx = p.widgets.findIndex((w) => w.id === widgetId);
      if (idx < 0) return;
      const copy: WidgetConfig = JSON.parse(JSON.stringify(p.widgets[idx]));
      copy.id = newId;
      copy.title = `${copy.title} copy`;
      p.widgets.splice(idx + 1, 0, copy);
    });
    setSelection({ kind: "widget", id: newId });
  }

  // ------------------------------------------------------------ preview click-to-select + inline edit

  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const attachPreviewHandlers = useCallback(
    (frame: HTMLIFrameElement | null) => {
      if (!frame) return;
      let doc: Document | null = null;
      try {
        doc = frame.contentDocument;
      } catch {
        doc = null;
      }
      if (!doc) return;
      const selectFromEvent = (target: EventTarget | null): boolean => {
        // NOTE: the event comes from the iframe's realm — never use instanceof
        // against parent-window classes; duck-type instead.
        const el = target as HTMLElement | null;
        const node = el && typeof el.closest === "function" ? (el.closest("[data-pf-id]") as HTMLElement | null) : null;
        if (!node) return false;
        const id = node.getAttribute("data-pf-id") ?? "";
        const kind = node.getAttribute("data-pf-kind") ?? "";
        if (kind === "hero") setSelection({ kind: "hero" });
        else if (kind === "section") setSelection({ kind: "section", id });
        else if (kind === "widget") setSelection({ kind: "widget", id });
        return true;
      };
      // click: select the node under the pointer; let real controls keep working
      doc.addEventListener(
        "click",
        (e) => {
          const el = e.target as HTMLElement | null;
          const interactive =
            el && typeof el.closest === "function" && el.closest("input, textarea, select, button, a, [contenteditable='true']");
          if (interactive) {
            if (!selectFromEvent(e.target)) return;
            const nav = typeof interactive.closest === "function" ? interactive.closest("a, button") : null;
            if (nav) e.preventDefault(); // selecting ≠ navigating
            return;
          }
          if (selectFromEvent(e.target)) {
            e.preventDefault();
            e.stopPropagation();
          }
        },
        true
      );
      // double-click a marked text node → inline-edit it in place
      doc.addEventListener(
        "dblclick",
        (e) => {
          const el = e.target as HTMLElement | null;
          const fieldEl = el && typeof el.closest === "function" ? (el.closest("[data-pf-field]") as HTMLElement | null) : null;
          if (!fieldEl) return;
          const field = fieldEl.getAttribute("data-pf-field") ?? "";
          const node = fieldEl.closest("[data-pf-id]") as HTMLElement | null;
          const nodeId = node?.getAttribute("data-pf-id") ?? "";
          const kind = node?.getAttribute("data-pf-kind") ?? "";
          if (kind === "hero") setSelection({ kind: "hero" });
          else if (kind === "section") setSelection({ kind: "section", id: nodeId });
          fieldEl.contentEditable = "true";
          fieldEl.focus();
          const sync = () => {
            const value = (fieldEl.textContent ?? "").slice(0, 300);
            if (kind === "hero" && ["name", "title", "intro"].includes(field)) {
              mutatePage(activePage?.id, (p) => {
                (p.hero as unknown as Record<string, string>)[field] = value;
              }, `hero.${field}`);
            } else if (kind === "section" && field === "sectionTitle") {
              mutatePage(activePage?.id, (p) => {
                const t = p.sections.find((s) => s.id === nodeId);
                if (t) t.title = value;
              }, `sec-${nodeId}.title`);
            }
          };
          fieldEl.addEventListener("input", sync);
          fieldEl.addEventListener(
            "blur",
            () => {
              fieldEl.contentEditable = "false";
              fieldEl.removeEventListener("input", sync);
            },
            { once: true }
          );
          e.preventDefault();
        },
        true
      );
    },
    [mutatePage, activePage?.id]
  );

  // ------------------------------------------------------------ render states

  const projectOptions = projects.map((p) => ({ value: p.id, label: `${p.title}${p.visibility !== "PUBLIC" ? " (unlisted — hidden on public site)" : ""}` }));

  const previewSrc = useMemo(() => {
    if (!meta) return "";
    if (activePage && !activePage.isHome && activePage.slug) return `#/embed/draft/${meta.slug}/${activePage.slug}`;
    return `#/embed/draft/${meta.slug}`;
  }, [meta, activePage]);

  if (status === "loading") {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading studio" />
      </div>
    );
  }
  if (status === "no-username") {
    return (
      <div className="mx-auto max-w-xl px-4 py-20">
        <Emptyish
          title="Pick a username first"
          body="Your portfolio's public address comes from your BEAN Folio username. Set it in My Folio, then come back."
          action={<Button onClick={() => navigate("/folio")}>Open My Folio</Button>}
        />
      </div>
    );
  }
  if (status === "error" || !config || !meta || !activePage) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20">
        <Emptyish
          title="The studio couldn't load"
          body="A connection problem got in the way. Retry before doing anything else."
          action={<Button variant="outline" onClick={() => window.location.reload()}>Retry</Button>}
        />
      </div>
    );
  }

  const selectedSection = selection?.kind === "section" ? activePage.sections.find((s) => s.id === selection.id) ?? null : null;
  const selectedWidget = selection?.kind === "widget" ? activePage.widgets.find((w) => w.id === selection.id) ?? null : null;

  const leftPanel = (
    <StudioLeftPanel
      config={config}
      activePage={activePage}
      onSelectPage={(id) => {
        setActivePageId(id);
        setSelection(null);
        setLeftPanelOpen(false);
      }}
      onAddPage={addPage}
      onDuplicatePage={duplicatePage}
      onMovePage={(pageId, dir) => mutate((c) => {
        const i = c.pages.findIndex((p) => p.id === pageId);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= c.pages.length) return;
        [c.pages[i], c.pages[j]] = [c.pages[j], c.pages[i]];
      })}
      onDeletePage={() => setDeletePageOpen(true)}
      selection={selection}
      onSelect={(sel) => {
        setSelection(sel);
        setLeftPanelOpen(false);
        setRightPanelOpen(false);
      }}
      onAddSection={addSection}
      onDuplicateSection={duplicateSection}
      onAddWidget={addWidget}
      onDuplicateWidget={duplicateWidget}
      mutatePage={mutatePage}
    />
  );

  const rightPanel = (
    <StudioInspector
      config={config}
      activePage={activePage}
      selection={selection}
      selectedSection={selectedSection}
      selectedWidget={selectedWidget}
      mutatePage={mutatePage}
      mutate={mutate}
      projectOptions={projectOptions}
      onOpenTemplates={() => setTemplateOpen(true)}
      onDeletePage={() => setDeletePageOpen(true)}
      onReset={() => setResetOpen(true)}
    />
  );

  return (
    <TooltipProvider>
      <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden">
        {/* ------------------------------------------------ top toolbar */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/70 bg-background/95 px-2 py-2 sm:px-3">
          {/* mobile panel buttons */}
          <Button variant="outline" size="sm" className="h-8 gap-1.5 lg:hidden" onClick={() => setLeftPanelOpen(true)} aria-label="Open structure panel">
            <LayoutPanelLeft className="size-4" aria-hidden />
            <span className="hidden sm:inline">Structure</span>
          </Button>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 lg:hidden" onClick={() => setRightPanelOpen(true)} aria-label="Open design panel">
            <PanelRight className="size-4" aria-hidden />
            <span className="hidden sm:inline">Design</span>
          </Button>

          <div className="mr-1 hidden items-center gap-2 lg:flex">
            <LayoutTemplate className="size-4 text-primary" aria-hidden />
            <span className="text-sm font-semibold">Portfolio Studio</span>
          </div>

          <Button variant="outline" size="sm" className="h-8" onClick={() => setTemplateOpen(true)}>
            <Palette className="size-3.5" aria-hidden />
            <span className="hidden xl:inline">{getTemplate(config.templateId).name}</span>
          </Button>

          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" onClick={undo} disabled={histRef.current.idx <= 0} aria-label="Undo (Ctrl+Z)">
                  <Undo2 className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Undo</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" onClick={redo} disabled={histRef.current.idx >= histRef.current.stack.length - 1} aria-label="Redo (Ctrl+Shift+Z)">
                  <Redo2 className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Redo</TooltipContent>
            </Tooltip>
          </div>

          <div className="ml-1 hidden items-center gap-1.5 md:flex" aria-live="polite">
            {saveState === "saving" && <Badge variant="secondary" className="gap-1 text-[10px]"><Loader2 className="size-3 animate-spin" aria-hidden /> Saving…</Badge>}
            {saveState === "saved" && savedAt && <Badge variant="secondary" className="text-[10px]">Saved {savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Badge>}
            {saveState === "error" && <Badge variant="destructive" className="text-[10px]">Save failed</Badge>}
            {saveState === "idle" && dirty && <span className="text-[10px] text-muted-foreground">Unsaved changes</span>}
            {saveState === "idle" && !dirty && savedAt && <span className="text-[10px] text-muted-foreground">All changes saved</span>}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <div className="hidden items-center gap-0.5 rounded-md border border-border p-0.5 sm:flex">
              {(
                [
                  { d: "desktop" as Device, icon: Monitor, label: "Desktop preview" },
                  { d: "tablet" as Device, icon: Tablet, label: "Tablet preview" },
                  { d: "mobile" as Device, icon: Smartphone, label: "Mobile preview" },
                ]
              ).map(({ d, icon: Icon, label }) => (
                <Button key={d} variant="ghost" size="icon" className={cn("size-7", device === d && "bg-gold-soft text-primary")} onClick={() => setDevice(d)} aria-label={label} aria-pressed={device === d}>
                  <Icon className="size-4" aria-hidden />
                </Button>
              ))}
            </div>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 border-primary/40 text-primary hover:bg-gold-soft/40" onClick={() => setAiOpen(true)}>
              <Bot className="size-4" aria-hidden />
              <span className="hidden md:inline">Code Giftz AI</span>
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => setRevisionsOpen(true)}>
                  <History className="size-3.5" aria-hidden />
                  <span className="hidden xl:inline">Versions</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Restore a previously published version</TooltipContent>
            </Tooltip>
            <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => window.open(`#/site/${meta.slug}`, "_blank")}>
              <ExternalLink className="size-3.5" aria-hidden />
              <span className="hidden xl:inline">View site</span>
            </Button>
            <Button variant="outline" size="sm" className="h-8" onClick={() => void saveNow()} disabled={saveState === "saving"}>
              {saveState === "saving" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
              Save
            </Button>
            <Button size="sm" className="h-8" onClick={() => void publish()} disabled={publishing}>
              {publishing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}
              {meta.hasPublished ? "Republish" : "Publish"}
            </Button>
          </div>
        </div>

        {/* ------------------------------------------------ workspace */}
        <div className="flex min-h-0 flex-1">
          {/* left: pages + structure (desktop column) */}
          <div className="hidden w-[300px] shrink-0 border-r border-border/70 lg:flex lg:flex-col">
            <ScrollArea className="min-h-0 flex-1">{leftPanel}</ScrollArea>
          </div>

          {/* center: live preview */}
          <div className="flex min-w-0 flex-1 flex-col bg-[radial-gradient(circle_at_top,rgba(232,188,81,0.05),transparent_55%)]">
            <div className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span className="hidden items-center gap-1.5 text-[11px] uppercase tracking-widest text-muted-foreground sm:flex">
                <MousePointerClick className="size-3.5" aria-hidden />
                Click a block to edit · double-click text to type
              </span>
              <span className="truncate text-[11px] text-muted-foreground sm:hidden">{activePage.name} · preview</span>
              <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setPreviewNonce((n) => n + 1)}>
                <RotateCcw className="size-3" aria-hidden /> Refresh
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden px-3 pb-3">
              <div
                className={cn(
                  "mx-auto h-full overflow-hidden rounded-xl border border-border/80 bg-background shadow-2xl transition-all",
                  device === "mobile" && "w-[390px] max-w-full",
                  device === "tablet" && "w-[834px] max-w-full"
                )}
              >
                <iframe
                  key={previewNonce}
                  ref={iframeRef}
                  title="Portfolio live preview"
                  src={previewSrc}
                  onLoad={(e) => attachPreviewHandlers(e.currentTarget)}
                  className="h-full w-full"
                  sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
                />
              </div>
            </div>
          </div>

          {/* right: inspector (desktop column) */}
          <div className="hidden w-[340px] shrink-0 border-l border-border/70 lg:flex lg:flex-col">
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-3">{rightPanel}</div>
            </ScrollArea>
          </div>
        </div>
      </div>

      {/* mobile drawers */}
      <Sheet open={leftPanelOpen} onOpenChange={setLeftPanelOpen}>
        <SheetContent side="left" className="w-[320px] max-w-[88vw] p-0">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="text-sm">Pages & structure</SheetTitle>
          </SheetHeader>
          <ScrollArea className="h-[calc(100vh-8rem)]">
            {leftPanel}
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <Sheet open={rightPanelOpen} onOpenChange={setRightPanelOpen}>
        <SheetContent side="right" className="w-[340px] max-w-[92vw] overflow-y-auto p-0">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="text-sm">Inspector</SheetTitle>
          </SheetHeader>
          <div className="p-3">{rightPanel}</div>
        </SheetContent>
      </Sheet>

      {/* ------------------------------------------------ dialogs */}
      <TemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} current={config.templateId} onPick={(id) => { mutate((c) => { Object.assign(c, applyTemplate(c, id)); }, `tpl-${id}`); setTemplateOpen(false); toast.success(`Template applied: ${getTemplate(id).name} — your content is untouched`); }} />

      <RevisionsDialog open={revisionsOpen} onOpenChange={setRevisionsOpen} onRestored={async () => {
        const pf = await api<{ portfolio: PortfolioMeta; config: PortfolioConfig }>("/api/portfolio");
        setConfig(pf.config);
        configRef.current = pf.config;
        setMeta(pf.portfolio);
        setActivePageId(pf.config.pages[0]?.id ?? null);
        setSelection(null);
        savedJsonRef.current = JSON.stringify(pf.config);
        histRef.current = { stack: [JSON.stringify(pf.config)], idx: 0, lastTag: null, lastAt: 0 };
        setDirty(false);
        setHistVer((v) => v + 1);
        setPreviewNonce((n) => n + 1);
      }} />

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild the draft from your profile?</AlertDialogTitle>
            <AlertDialogDescription>
              Hero text, bio, skills and project picks are re-seeded from your BEAN Folio profile and published projects. Your current draft (including custom styling) is replaced. This can be undone with Undo before saving.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void rebuildFromProfile()}>Rebuild draft</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deletePageOpen} onOpenChange={setDeletePageOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the page “{activePage.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The page and its sections are removed from the draft. The published site is unchanged until you publish again. This can be undone with Undo before saving.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={deleteActivePage}>
              Delete page
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Publish confirmation — real URL + copy action */}
      <Dialog open={publishedUrl !== null} onOpenChange={(o) => !o && setPublishedUrl(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Globe className="size-4 text-primary" aria-hidden /> Your site is live</DialogTitle>
            <DialogDescription>
              The published snapshot is now public at this address — no sign-in needed. Draft edits stay private until you publish again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-card/60 px-3 py-2.5">
            <Link2 className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{publishedUrl}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(publishedUrl ?? "");
                  toast.success("Link copied");
                } catch {
                  toast.error("Copy failed — select the link text manually.");
                }
              }}
            >
              <Copy className="size-3.5" aria-hidden /> Copy
            </Button>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPublishedUrl(null)}>Keep editing</Button>
            <Button onClick={() => window.open(publishedUrl ?? "#/", "_blank")}>
              <ExternalLink className="size-4" aria-hidden /> Open site
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Code Giftz AI — website designer */}
      <AiDesignerDialog
        open={aiOpen}
        onOpenChange={setAiOpen}
        slug={meta.slug}
        activePageId={activePage.id}
        activePageName={activePage.name}
        selectionKind={selection?.kind ?? null}
        onApply={(proposal) => {
          commit(proposal.config, "ai");
          const home = proposal.config.pages.find((p) => p.isHome);
          if (home) setActivePageId(home.id);
          setSelection(null);
          toast.success("AI proposal applied to the draft — press Undo to revert", {
            description: "Changes are saved to your draft only. Publish to make them live.",
          });
        }}
      />
    </TooltipProvider>
  );
}

function Emptyish({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 bg-card/40 px-6 py-14 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-gold-soft text-primary">
        <MousePointerClick className="size-6" aria-hidden />
      </div>
      <h3 className="font-display text-lg font-semibold">{title}</h3>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      <div className="mt-2">{action}</div>
    </div>
  );
}

// ================================================================ LEFT PANEL

type Mutate = (fn: (c: PortfolioConfig) => void, tag?: string) => void;
/** Page-scoped mutator: pageId=null/undefined targets the currently active page. */
type PageMutate = (pageId: string | null | undefined, fn: (p: PageConfig) => void, tag?: string) => void;

function StudioLeftPanel({
  config,
  activePage,
  onSelectPage,
  onAddPage,
  onDuplicatePage,
  onMovePage,
  onDeletePage,
  selection,
  onSelect,
  onAddSection,
  onDuplicateSection,
  onAddWidget,
  onDuplicateWidget,
  mutatePage,
}: {
  config: PortfolioConfig;
  activePage: PageConfig;
  onSelectPage: (id: string) => void;
  onAddPage: () => void;
  onDuplicatePage: (id: string) => void;
  onMovePage: (id: string, dir: -1 | 1) => void;
  onDeletePage: () => void;
  selection: Selection;
  onSelect: (sel: Selection) => void;
  onAddSection: (t: SectionType) => void;
  onDuplicateSection: (id: string) => void;
  onAddWidget: (t: WidgetType) => void;
  onDuplicateWidget: (id: string) => void;
  mutatePage: PageMutate;
}) {
  const [adding, setAdding] = useState<"section" | "widget" | null>(null);
  const dragId = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const sectionTypesInUse = activePage.sections.map((s) => s.type);
  const missingSectionTypes = SECTION_TYPES.filter((t) => !sectionTypesInUse.includes(t));

  return (
    <div className="space-y-4 p-3">
      {/* pages */}
      <div className="rounded-xl border border-border/70 bg-card/60 p-2.5">
        <div className="mb-2 flex items-center justify-between px-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Pages</p>
          <Button variant="ghost" size="icon" className="size-6" onClick={onAddPage} aria-label="Add page" disabled={config.pages.length >= 12}>
            <Plus className="size-3.5" aria-hidden />
          </Button>
        </div>
        <div className="space-y-1">
          {config.pages.map((p, idx) => {
            const active = p.id === activePage.id;
            return (
              <div
                key={p.id}
                className={cn(
                  "group flex items-center gap-1 rounded-lg border px-2 py-1.5 transition-colors",
                  active ? "border-primary/50 bg-gold-soft/50" : "border-transparent hover:bg-accent"
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => onSelectPage(p.id)}
                  aria-current={active ? "true" : undefined}
                >
                  <Globe className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")} aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{p.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {p.isHome ? "home page" : `/${p.slug}`}
                      {!p.isPublished && !p.isHome ? " · draft" : ""}
                      {!p.inNav ? " · not in nav" : ""}
                    </span>
                  </span>
                </button>
                <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <Button variant="ghost" size="icon" className="size-6" onClick={() => onMovePage(p.id, -1)} disabled={idx === 0} aria-label={`Move ${p.name} up`}>
                    <ArrowUp className="size-3" aria-hidden />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-6" onClick={() => onMovePage(p.id, 1)} disabled={idx === config.pages.length - 1} aria-label={`Move ${p.name} down`}>
                    <ArrowDown className="size-3" aria-hidden />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-6" onClick={() => onDuplicatePage(p.id)} aria-label={`Duplicate ${p.name}`} disabled={config.pages.length >= 12}>
                    <Files className="size-3" aria-hidden />
                  </Button>
                  {!p.isHome && (
                    <Button variant="ghost" size="icon" className="size-6 hover:text-destructive" onClick={() => { onSelectPage(p.id); onDeletePage(); }} aria-label={`Delete ${p.name}`}>
                      <Trash2 className="size-3" aria-hidden />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* structure of the active page */}
      <div className="rounded-xl border border-border/70 bg-card/60 p-2.5">
        <div className="mb-2 flex items-center justify-between px-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Structure · {activePage.name}</p>
          <Button variant="ghost" size="icon" className="size-6" onClick={() => onSelect({ kind: "page" })} aria-label="Page settings">
            <Settings2 className="size-3.5" aria-hidden />
          </Button>
        </div>

        <div className="space-y-1">
          {activePage.isHome && (
            <StructureRow
              label="Hero"
              sub="Name, intro, CTAs — double-click text in the preview to edit inline"
              icon={Sparkles}
              active={selection?.kind === "hero"}
              onClick={() => onSelect({ kind: "hero" })}
              visible
            />
          )}
          {activePage.sections.map((s, idx) => (
            <StructureRow
              key={s.id}
              draggable
              dragging={dragOverId === s.id}
              label={s.title || SECTION_META[s.type].label}
              sub={`${SECTION_META[s.type].hint}${s.visible ? "" : " · hidden"}`}
              icon={Pencil}
              active={selection?.kind === "section" && selection.id === s.id}
              onClick={() => onSelect({ kind: "section", id: s.id })}
              visible={s.visible}
              onToggleVisible={() => mutatePage(activePage.id, (p) => {
                const t = p.sections.find((x) => x.id === s.id);
                if (t) t.visible = !t.visible;
              })}
              onDuplicate={() => onDuplicateSection(s.id)}
              onRemove={() => mutatePage(activePage.id, (p) => { p.sections = p.sections.filter((x) => x.id !== s.id); })}
              onMoveUp={() => mutatePage(activePage.id, (p) => {
                if (idx <= 0) return;
                [p.sections[idx - 1], p.sections[idx]] = [p.sections[idx], p.sections[idx - 1]];
              })}
              onMoveDown={() => mutatePage(activePage.id, (p) => {
                if (idx >= p.sections.length - 1) return;
                [p.sections[idx + 1], p.sections[idx]] = [p.sections[idx], p.sections[idx + 1]];
              })}
              onDragStart={() => { dragId.current = s.id; }}
              onDragOver={() => setDragOverId(s.id)}
              onDrop={() => {
                const from = dragId.current;
                dragId.current = null;
                setDragOverId(null);
                if (!from || from === s.id) return;
                mutatePage(activePage.id, (p) => {
                  const i = p.sections.findIndex((x) => x.id === from);
                  const j = p.sections.findIndex((x) => x.id === s.id);
                  if (i < 0 || j < 0) return;
                  const [moved] = p.sections.splice(i, 1);
                  p.sections.splice(j, 0, moved);
                });
              }}
              onDragEnd={() => { dragId.current = null; setDragOverId(null); }}
            />
          ))}
          {activePage.widgets.map((w, idx) => (
            <StructureRow
              key={w.id}
              draggable
              dragging={dragOverId === w.id}
              label={w.title || WIDGET_LABELS[w.type]}
              sub={`${WIDGET_HINTS[w.type] ?? "Widget"}${w.visible ? "" : " · hidden"}`}
              icon={Bot}
              badge="widget"
              active={selection?.kind === "widget" && selection.id === w.id}
              onClick={() => onSelect({ kind: "widget", id: w.id })}
              visible={w.visible}
              onToggleVisible={() => mutatePage(activePage.id, (p) => {
                const t = p.widgets.find((x) => x.id === w.id);
                if (t) t.visible = !t.visible;
              })}
              onDuplicate={() => onDuplicateWidget(w.id)}
              onRemove={() => mutatePage(activePage.id, (p) => { p.widgets = p.widgets.filter((x) => x.id !== w.id); })}
              onMoveUp={() => mutatePage(activePage.id, (p) => {
                if (idx <= 0) return;
                [p.widgets[idx - 1], p.widgets[idx]] = [p.widgets[idx], p.widgets[idx - 1]];
              })}
              onMoveDown={() => mutatePage(activePage.id, (p) => {
                if (idx >= p.widgets.length - 1) return;
                [p.widgets[idx + 1], p.widgets[idx]] = [p.widgets[idx], p.widgets[idx + 1]];
              })}
              onDragStart={() => { dragId.current = w.id; }}
              onDragOver={() => setDragOverId(w.id)}
              onDrop={() => {
                const from = dragId.current;
                dragId.current = null;
                setDragOverId(null);
                if (!from || from === w.id) return;
                mutatePage(activePage.id, (p) => {
                  const i = p.widgets.findIndex((x) => x.id === from);
                  const j = p.widgets.findIndex((x) => x.id === w.id);
                  if (i < 0 || j < 0) return;
                  const [moved] = p.widgets.splice(i, 1);
                  p.widgets.splice(j, 0, moved);
                });
              }}
              onDragEnd={() => { dragId.current = null; setDragOverId(null); }}
            />
          ))}
          {activePage.sections.length === 0 && activePage.widgets.length === 0 && (
            <p className="px-2 py-3 text-[11px] text-muted-foreground">This page has no content yet — add a section below.</p>
          )}
        </div>

        <div className="mt-2 space-y-1.5">
          <Button variant="outline" size="sm" className="h-8 w-full text-xs" onClick={() => setAdding(adding === "section" ? null : "section")} aria-expanded={adding === "section"}>
            <Plus className="size-3.5" aria-hidden /> Add section
          </Button>
          {adding === "section" && (
            <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-border/60 p-1">
              {missingSectionTypes.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  onClick={() => { onAddSection(t); setAdding(null); }}
                >
                  {SECTION_META[t].label}
                </button>
              ))}
              {missingSectionTypes.length === 0 && <p className="px-2 py-1.5 text-[11px] text-muted-foreground">Every section type is already on this page.</p>}
            </div>
          )}
          <Button variant="outline" size="sm" className="h-8 w-full text-xs" onClick={() => setAdding(adding === "widget" ? null : "widget")} aria-expanded={adding === "widget"}>
            <Plus className="size-3.5" aria-hidden /> Add widget
          </Button>
          {adding === "widget" && (
            <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-border/60 p-1">
              {WIDGET_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  onClick={() => { onAddWidget(t); setAdding(null); }}
                >
                  <span className="block font-medium">{WIDGET_LABELS[t]}</span>
                  <span className="block text-[10px] text-muted-foreground">{WIDGET_HINTS[t]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StructureRow({
  label,
  sub,
  icon: Icon,
  badge,
  active,
  visible,
  onClick,
  onToggleVisible,
  onDuplicate,
  onRemove,
  onMoveUp,
  onMoveDown,
  draggable,
  dragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  label: string;
  sub: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  active: boolean;
  visible: boolean;
  onClick: () => void;
  onToggleVisible?: () => void;
  onDuplicate?: () => void;
  onRemove?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
}) {
  return (
    <div
      className={cn(
        "group rounded-lg border px-2 py-1.5 transition-colors",
        active ? "border-primary/50 bg-gold-soft/50" : "border-transparent hover:bg-accent",
        dragging && "border-primary/70 ring-1 ring-primary/30",
        !visible && "opacity-60"
      )}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragOver={draggable ? (e) => { e.preventDefault(); onDragOver?.(); } : undefined}
      onDrop={draggable ? (e) => { e.preventDefault(); onDrop?.(); } : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
    >
      <div className="flex items-center gap-1.5">
        {draggable && <GripVertical className="size-3 shrink-0 cursor-grab text-muted-foreground/50" aria-hidden />}
        <button type="button" className="flex min-w-0 flex-1 items-start gap-2 text-left" onClick={onClick} aria-pressed={active}>
          <Icon className={cn("mt-0.5 size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")} aria-hidden />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-medium">{label}</span>
              {badge && <Badge variant="outline" className="px-1 py-0 text-[9px] font-normal">{badge}</Badge>}
              {!visible && <EyeOff className="size-3 shrink-0 text-muted-foreground" aria-label="Hidden from visitors" />}
            </span>
            <span className="block truncate text-[10px] text-muted-foreground">{sub}</span>
          </span>
        </button>
        <div className="flex shrink-0 flex-col opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {onMoveUp && onMoveDown && (
            <span className="flex">
              <Button variant="ghost" size="icon" className="size-5" onClick={onMoveUp} aria-label={`Move ${label} up`}>
                <ArrowUp className="size-3" aria-hidden />
              </Button>
              <Button variant="ghost" size="icon" className="size-5" onClick={onMoveDown} aria-label={`Move ${label} down`}>
                <ArrowDown className="size-3" aria-hidden />
              </Button>
            </span>
          )}
          <span className="flex">
            {onToggleVisible && (
              <Button variant="ghost" size="icon" className="size-5" onClick={onToggleVisible} aria-label={visible ? `Hide ${label}` : `Show ${label}`}>
                {visible ? <Eye className="size-3" aria-hidden /> : <EyeOff className="size-3" aria-hidden />}
              </Button>
            )}
            {onDuplicate && (
              <Button variant="ghost" size="icon" className="size-5" onClick={onDuplicate} aria-label={`Duplicate ${label}`}>
                <Files className="size-3" aria-hidden />
              </Button>
            )}
            {onRemove && (
              <Button variant="ghost" size="icon" className="size-5 hover:text-destructive" onClick={onRemove} aria-label={`Remove ${label}`}>
                <Trash2 className="size-3" aria-hidden />
              </Button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

// ================================================================ INSPECTOR (right panel)

function StudioInspector({
  config,
  activePage,
  selection,
  selectedSection,
  selectedWidget,
  mutatePage,
  mutate,
  projectOptions,
  onOpenTemplates,
  onDeletePage,
  onReset,
}: {
  config: PortfolioConfig;
  activePage: PageConfig;
  selection: Selection;
  selectedSection: SectionConfig | null;
  selectedWidget: WidgetConfig | null;
  mutatePage: PageMutate;
  mutate: Mutate;
  projectOptions: { value: string; label: string }[];
  onOpenTemplates: () => void;
  onDeletePage: () => void;
  onReset: () => void;
}) {
  const hero = activePage.hero;

  if (selection?.kind === "hero" && activePage.isHome) {
    return (
      <div className="space-y-4">
        <InspectorHeader icon={Sparkles} title="Hero" sub="The first thing visitors see — lives on the home page." />
        <div className="space-y-3 rounded-xl border border-border/70 bg-card/60 p-3.5">
          <Field label="Name">
            <Input value={hero.name} onChange={(e) => mutatePage(activePage.id, (p) => { p.hero.name = e.target.value; }, "hero.name")} maxLength={80} />
          </Field>
          <Field label="Profession / title line">
            <Input value={hero.title} onChange={(e) => mutatePage(activePage.id, (p) => { p.hero.title = e.target.value; }, "hero.title")} maxLength={120} placeholder="e.g. Documentary filmmaker & colorist" />
          </Field>
          <Field label="Short introduction">
            <Textarea value={hero.intro} onChange={(e) => mutatePage(activePage.id, (p) => { p.hero.intro = e.target.value; }, "hero.intro")} maxLength={400} rows={3} placeholder="One or two sentences that introduce you." />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Location">
              <Input value={hero.location} onChange={(e) => mutatePage(activePage.id, (p) => { p.hero.location = e.target.value; }, "hero.loc")} maxLength={80} placeholder="City, Country" />
            </Field>
            <Field label="Availability">
              <Input value={hero.availability} onChange={(e) => mutatePage(activePage.id, (p) => { p.hero.availability = e.target.value; }, "hero.avail")} maxLength={80} placeholder="Open to commissions" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Primary button label">
              <Input value={hero.primaryCtaLabel} onChange={(e) => mutatePage(activePage.id, (p) => { p.hero.primaryCtaLabel = e.target.value; }, "hero.cta1")} maxLength={40} />
            </Field>
            <Field label="Secondary button label">
              <Input value={hero.secondaryCtaLabel} onChange={(e) => mutatePage(activePage.id, (p) => { p.hero.secondaryCtaLabel = e.target.value; }, "hero.cta2")} maxLength={40} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Portrait / avatar</Label>
              {hero.avatarMediaId && (
                <div className="flex items-center gap-2">
                  <img src={`/api/media/${hero.avatarMediaId}/raw`} alt="Current avatar" className="size-10 rounded-full object-cover" />
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => mutatePage(activePage.id, (p) => { p.hero.avatarMediaId = null; })}>
                    <X className="size-3" aria-hidden /> Remove
                  </Button>
                </div>
              )}
              <MediaUploadButton kind="IMAGE" label="Upload portrait" size="sm" onUploaded={(m: MediaDTO) => mutatePage(activePage.id, (p) => { p.hero.avatarMediaId = m.id; })} />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Backdrop / artwork</Label>
              {hero.coverMediaId && (
                <div className="flex items-center gap-2">
                  <img src={`/api/media/${hero.coverMediaId}/raw`} alt="Current backdrop" className="h-10 w-16 rounded object-cover" />
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => mutatePage(activePage.id, (p) => { p.hero.coverMediaId = null; })}>
                    <X className="size-3" aria-hidden /> Remove
                  </Button>
                </div>
              )}
              <MediaUploadButton kind="IMAGE" label="Upload backdrop" size="sm" onUploaded={(m: MediaDTO) => mutatePage(activePage.id, (p) => { p.hero.coverMediaId = m.id; })} />
            </div>
          </div>
          <Field label="Featured current project" hint="Shown as a live “Currently building” card in the hero.">
            <Select
              value={hero.currentProjectId ?? "none"}
              onValueChange={(v) => mutatePage(activePage.id, (p) => { p.hero.currentProjectId = v === "none" ? null : v; })}
            >
              <SelectTrigger aria-label="Featured current project"><SelectValue placeholder="Pick a project" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {projectOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <MetricsEditor items={hero.metrics} onChange={(items) => mutatePage(activePage.id, (p) => { p.hero.metrics = items; }, "hero.metrics")} />
          <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2">
            <div>
              <Label className="text-xs">Cursor glow effect</Label>
              <p className="text-[11px] text-muted-foreground">A soft light follows the visitor's pointer (desktop only).</p>
            </div>
            <Switch checked={hero.showCursorGlow} onCheckedChange={(v) => mutatePage(activePage.id, (p) => { p.hero.showCursorGlow = v; })} aria-label="Cursor glow effect" />
          </div>
        </div>
      </div>
    );
  }

  if (selection?.kind === "page") {
    return (
      <div className="space-y-4">
        <InspectorHeader icon={Settings2} title="Page settings" sub={`/${activePage.isHome ? "" : activePage.slug}`} />
        <div className="space-y-3 rounded-xl border border-border/70 bg-card/60 p-3.5">
          <Field label="Page name" hint="Shown in the site navigation and the browser tab fallback.">
            <Input value={activePage.name} onChange={(e) => mutatePage(activePage.id, (p) => { p.name = e.target.value; }, `page-${activePage.id}.name`)} maxLength={40} />
          </Field>
          {!activePage.isHome && (
            <Field label="Page address (slug)" hint="3–24 characters: lowercase letters, numbers, hyphens. Lives at #/site/<your-site>/<slug>.">
              <Input
                value={activePage.slug}
                onChange={(e) => mutatePage(activePage.id, (p) => { p.slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""); }, `page-${activePage.id}.slug`)}
                maxLength={24}
                className="font-mono text-sm"
              />
            </Field>
          )}
          <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2">
            <div>
              <Label className="text-xs">Show in navigation</Label>
              <p className="text-[11px] text-muted-foreground">Add this page to the site's menu.</p>
            </div>
            <Switch checked={activePage.inNav} onCheckedChange={(v) => mutatePage(activePage.id, (p) => { p.inNav = v; })} aria-label="Show in navigation" />
          </div>
          {!activePage.isHome && (
            <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2">
              <div>
                <Label className="text-xs">Published</Label>
                <p className="text-[11px] text-muted-foreground">Off = a draft page only you can preview, even on the live site.</p>
              </div>
              <Switch checked={activePage.isPublished} onCheckedChange={(v) => mutatePage(activePage.id, (p) => { p.isPublished = v; })} aria-label="Published" />
            </div>
          )}
          <Field label="SEO title" hint="Overrides the browser tab + Open Graph title for this page.">
            <Input value={activePage.seoTitle} onChange={(e) => mutatePage(activePage.id, (p) => { p.seoTitle = e.target.value; }, `page-${activePage.id}.seo1`)} maxLength={120} placeholder={`${activePage.name} — ${activePage.isHome ? activePage.hero.name || "Portfolio" : "Portfolio"}`} />
          </Field>
          <Field label="SEO description">
            <Textarea value={activePage.seoDescription} onChange={(e) => mutatePage(activePage.id, (p) => { p.seoDescription = e.target.value; }, `page-${activePage.id}.seo2`)} maxLength={300} rows={3} placeholder="Up to 300 characters shown in search results and link previews." />
          </Field>
          {!activePage.isHome && (
            <Button variant="outline" size="sm" className="h-8 w-full text-xs hover:text-destructive" onClick={onDeletePage}>
              <Trash2 className="size-3.5" aria-hidden /> Delete this page
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (selection?.kind === "section" && selectedSection) {
    const meta = SECTION_META[selectedSection.type];
    return (
      <div className="space-y-4">
        <InspectorHeader icon={Pencil} title={meta.label} sub={meta.hint} />
        <div className="space-y-3 rounded-xl border border-border/70 bg-card/60 p-3.5">
          <Field label="Section heading">
            <Input
              value={selectedSection.title}
              onChange={(e) => mutatePage(activePage.id, (p) => {
                const t = p.sections.find((x) => x.id === selectedSection.id);
                if (t) t.title = e.target.value;
              }, `sec-${selectedSection.id}.title`)}
              placeholder={meta.label}
              className="text-sm"
            />
          </Field>
          <SectionEditor section={selectedSection} mutatePage={mutatePage} projectOptions={projectOptions} />
        </div>
      </div>
    );
  }

  if (selection?.kind === "widget" && selectedWidget) {
    const sectionChoices = [
      { value: "end", label: "End of page (before contact/footer)" },
      ...activePage.sections.map((s) => ({ value: s.id, label: `After “${s.title || SECTION_META[s.type].label}”` })),
    ];
    return (
      <div className="space-y-4">
        <InspectorHeader icon={Bot} title={WIDGET_LABELS[selectedWidget.type]} sub={WIDGET_HINTS[selectedWidget.type] ?? "Widget"} />
        <div className="space-y-3 rounded-xl border border-border/70 bg-card/60 p-3.5">
          <Field label="Widget title">
            <Input value={selectedWidget.title} onChange={(e) => mutatePage(activePage.id, (p) => { const t = p.widgets.find((x) => x.id === selectedWidget.id); if (t) t.title = e.target.value; }, `w-${selectedWidget.id}.title`)} placeholder={WIDGET_LABELS[selectedWidget.type]} className="text-sm" />
          </Field>
          <Field label="Optional description">
            <Input value={selectedWidget.description} onChange={(e) => mutatePage(activePage.id, (p) => { const t = p.widgets.find((x) => x.id === selectedWidget.id); if (t) t.description = e.target.value; }, `w-${selectedWidget.id}.desc`)} maxLength={240} className="text-sm" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Width">
              <Select value={selectedWidget.span} onValueChange={(v) => mutatePage(activePage.id, (p) => { const t = p.widgets.find((x) => x.id === selectedWidget.id); if (t) t.span = v as "full" | "half"; })}>
                <SelectTrigger aria-label="Widget width"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Full width</SelectItem>
                  <SelectItem value="half">Half width</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Position">
              <Select value={selectedWidget.after ?? "end"} onValueChange={(v) => mutatePage(activePage.id, (p) => { const t = p.widgets.find((x) => x.id === selectedWidget.id); if (t) t.after = v === "end" ? null : v; })}>
                <SelectTrigger aria-label="Widget position"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {sectionChoices.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <WidgetDataEditor widget={selectedWidget} mutatePage={mutatePage} projectOptions={projectOptions} />
        </div>
      </div>
    );
  }

  // default: site-wide design + advanced
  return (
    <div className="space-y-4">
      <InspectorHeader icon={Palette} title="Design" sub="Site-wide tokens: colors, type, layout, motion." />
      <DesignControls config={config} mutate={mutate} onOpenTemplates={onOpenTemplates} />
      <LayoutControls config={config} mutate={mutate} />
      <AdvancedControls config={config} mutate={mutate} onReset={onReset} />
    </div>
  );
}

function AdvancedControls({
  config,
  mutate,
  onReset,
}: {
  config: PortfolioConfig;
  mutate: Mutate;
  onReset: () => void;
}) {
  const [cssDraft, setCssDraft] = useState(config.advanced.customCss);
  const importFileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/70 bg-card/60 p-4">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-sm font-semibold"><ClipboardPaste className="size-4 text-primary" aria-hidden /> Custom CSS</p>
          <Switch checked={config.advanced.customCssEnabled} onCheckedChange={(v) => mutate((c) => { c.advanced.customCssEnabled = v; })} aria-label="Enable custom CSS" />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Scoped to your portfolio only: selectors are prefixed automatically, <code>html/body/:root</code> are rewritten to your site root, and <code>@import</code> / <code>javascript:</code> URLs are stripped. Max 8,000 characters.
        </p>
        <Textarea
          value={cssDraft}
          onChange={(e) => {
            setCssDraft(e.target.value);
            mutate((c) => { c.advanced.customCss = e.target.value; }, "adv.css");
          }}
          rows={8}
          className="mt-3 font-mono text-xs"
          placeholder={".pf-hero-name { letter-spacing: -0.03em; }"}
          aria-label="Custom CSS"
          maxLength={8000}
          disabled={!config.advanced.customCssEnabled}
        />
        <p className="mt-1 text-right text-[10px] text-muted-foreground">{cssDraft.length} / 8000</p>
      </div>

      <div className="rounded-xl border border-border/70 bg-card/60 p-4">
        <p className="mb-3 text-sm font-semibold">Developer tools</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => window.open("/api/portfolio/export", "_blank")}>
            <Download className="size-3.5" aria-hidden /> Export JSON
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => importFileRef.current?.click()}>
            <FileUp className="size-3.5" aria-hidden /> Import JSON
          </Button>
          <input
            ref={importFileRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="Import configuration JSON"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              void (async () => {
                try {
                  const text = await f.text();
                  await api("/api/portfolio/import", { method: "POST", json: { json: text.slice(0, 220_000) } });
                  toast.success("Imported — reload to see it");
                  setTimeout(() => window.location.reload(), 600);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Import failed");
                }
              })();
            }}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Export gives you the full JSON config (great for backing up or cloning to another account). Import replaces the current draft — never the live site.</p>
        <Button variant="outline" size="sm" className="mt-3 h-8 text-xs" onClick={onReset}>
          <RotateCcw className="size-3.5" aria-hidden /> Rebuild from profile
        </Button>
      </div>
    </div>
  );
}

function InspectorHeader({ icon: Icon, title, sub }: { icon: React.ComponentType<{ className?: string }>; title: string; sub: string }) {
  return (
    <div className="flex items-start gap-2.5 px-1">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gold-soft text-primary">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{title}</p>
        <p className="text-[11px] leading-snug text-muted-foreground">{sub}</p>
      </div>
    </div>
  );
}

// ================================================================ shared editors

function MetricsEditor({ items, onChange }: { items: { value: string; label: string }[]; onChange: (items: { value: string; label: string }[]) => void }) {
  return (
    <Field label="Metrics" hint="Only real, verifiable numbers — visitors can tell the difference.">
      <div className="space-y-2">
        {items.map((m, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input value={m.value} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="12" className="w-20 text-sm" aria-label="Metric value" />
            <Input value={m.label} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="years in film" className="flex-1 text-sm" aria-label="Metric label" />
            <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove metric">
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </div>
        ))}
        {items.length < 6 && (
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onChange([...items, { value: "", label: "" }])}>
            <Plus className="size-3.5" aria-hidden /> Add metric
          </Button>
        )}
      </div>
    </Field>
  );
}

function SectionEditor({
  section,
  mutatePage,
  projectOptions,
}: {
  section: SectionConfig;
  mutatePage: PageMutate;
  projectOptions: { value: string; label: string }[];
}) {
  const data = section.data;
  switch (section.type) {
    case "current":
      return (
        <div className="space-y-3">
          <Field label="Project">
            <Select value={String(data.projectId ?? "none")} onValueChange={(v) => mutatePage(undefined, (p) => {
              const t = p.sections.find((x) => x.id === section.id);
              if (t) (t.data as { projectId: string | null }).projectId = v === "none" ? null : v;
            })}>
              <SelectTrigger aria-label="Current project"><SelectValue placeholder="Pick a project" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {projectOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Note">
            <Textarea value={String(data.note ?? "")} onChange={(e) => mutatePage(undefined, (p) => {
              const t = p.sections.find((x) => x.id === section.id);
              if (t) (t.data as { note: string }).note = e.target.value;
            }, `sec-${section.id}.note`)} rows={2} maxLength={300} className="text-sm" placeholder="What are you building right now?" />
          </Field>
        </div>
      );
    case "stats":
      return <MetricsEditor items={(data.items as { value: string; label: string }[] | undefined) ?? []} onChange={(items) => mutatePage(undefined, (p) => {
        const t = p.sections.find((x) => x.id === section.id);
        if (t) (t.data as { items: typeof items }).items = items;
      }, `sec-${section.id}.items`)} />;
    case "services":
      return (
        <RowEditor
          items={(data.items as Record<string, unknown>[] | undefined) ?? []}
          specs={[
            { key: "title", label: "Service", placeholder: "Brand films", width: "half" },
            { key: "description", label: "Description", placeholder: "What it covers" },
          ]}
          defaults={{ title: "New service", description: "" }}
          addLabel="Add service"
          onChange={(items) => mutatePage(undefined, (p) => {
            const t = p.sections.find((x) => x.id === section.id);
            if (t) (t.data as { items: unknown[] }).items = items;
          }, `sec-${section.id}.items`)}
        />
      );
    case "featured":
      return (
        <Field label="Featured projects" hint="Toggle projects below. The first selected one is shown large.">
          <div className="space-y-1.5">
            {projectOptions.length === 0 && <p className="text-xs text-muted-foreground">No published projects yet — create one in the Studio first.</p>}
            {projectOptions.map((o) => {
              const ids = (data.projectIds as string[] | undefined) ?? [];
              const checked = ids.includes(o.value);
              return (
                <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => mutatePage(undefined, (p) => {
                      const t = p.sections.find((x) => x.id === section.id);
                      if (!t) return;
                      const arr = ((t.data as { projectIds: string[] }).projectIds ?? []).filter((x) => x !== o.value);
                      (t.data as { projectIds: string[] }).projectIds = checked ? arr : [...arr, o.value];
                    }, `sec-${section.id}.feat-${o.value}`)}
                    className="size-4 accent-[var(--primary)]"
                  />
                  <span className="truncate">{o.label}</span>
                  {checked && (
                    <span className="ml-auto flex items-center gap-0.5">
                      <ItemMover
                        first={ids[0] === o.value}
                        last={ids[ids.length - 1] === o.value}
                        onUp={() => mutatePage(undefined, (p) => {
                          const t = p.sections.find((x) => x.id === section.id);
                          if (!t) return;
                          const arr = (t.data as { projectIds: string[] }).projectIds;
                          const i = arr.indexOf(o.value);
                          if (i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
                        })}
                        onDown={() => mutatePage(undefined, (p) => {
                          const t = p.sections.find((x) => x.id === section.id);
                          if (!t) return;
                          const arr = (t.data as { projectIds: string[] }).projectIds;
                          const i = arr.indexOf(o.value);
                          if (i >= 0 && i < arr.length - 1) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
                        })}
                      />
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </Field>
      );
    case "gallery":
      return (
        <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2">
          <div>
            <Label className="text-xs">Category filter chips</Label>
            <p className="text-[11px] text-muted-foreground">Visitors can filter by project category.</p>
          </div>
          <Switch
            checked={data.filterable === true}
            onCheckedChange={(v) => mutatePage(undefined, (p) => {
              const t = p.sections.find((x) => x.id === section.id);
              if (t) (t.data as { filterable: boolean }).filterable = v;
            })}
            aria-label="Category filter"
          />
        </div>
      );
    case "about":
      return (
        <Field label="Bio" hint="Separate paragraphs with a blank line.">
          <Textarea
            value={String(data.body ?? "")}
            onChange={(e) => mutatePage(undefined, (p) => {
              const t = p.sections.find((x) => x.id === section.id);
              if (t) (t.data as { body: string }).body = e.target.value;
            }, `sec-${section.id}.body`)}
            rows={6}
            maxLength={6000}
            className="text-sm"
            placeholder="Tell the story of your work…"
          />
        </Field>
      );
    case "skills":
      return (
        <Field label="Skills & tools">
          <TagInput
            value={(data.items as string[] | undefined) ?? []}
            max={40}
            onChange={(items) => mutatePage(undefined, (p) => {
              const t = p.sections.find((x) => x.id === section.id);
              if (t) (t.data as { items: string[] }).items = items;
            }, `sec-${section.id}.skills`)}
            placeholder="Type a skill and press Enter"
          />
        </Field>
      );
    case "experience":
      return (
        <RowEditor
          items={(data.items as Record<string, unknown>[] | undefined) ?? []}
          specs={[
            { key: "org", label: "Organisation / school", placeholder: "Studio Noir", width: "half" },
            { key: "kind", label: "Type", type: "select", options: [{ value: "work", label: "Work" }, { value: "education", label: "Education" }], width: "half" },
            { key: "role", label: "Role / degree", placeholder: "Senior editor", width: "half" },
            { key: "period", label: "Period", placeholder: "2019 — 2023", width: "half" },
            { key: "summary", label: "Summary", placeholder: "What you did there" },
          ]}
          defaults={{ kind: "work", org: "New entry", role: "", period: "", summary: "" }}
          addLabel="Add entry"
          onChange={(items) => mutatePage(undefined, (p) => {
            const t = p.sections.find((x) => x.id === section.id);
            if (t) (t.data as { items: unknown[] }).items = items;
          }, `sec-${section.id}.items`)}
        />
      );
    case "testimonials":
      return (
        <RowEditor
          items={(data.items as Record<string, unknown>[] | undefined) ?? []}
          specs={[
            { key: "quote", label: "Quote", type: "textarea", placeholder: "What they said about working with you" },
            { key: "author", label: "Author", placeholder: "Jane Doe", width: "half" },
            { key: "role", label: "Role / context", placeholder: "Creative Director, Studio X", width: "half" },
          ]}
          defaults={{ quote: "", author: "", role: "" }}
          addLabel="Add testimonial"
          onChange={(items) => mutatePage(undefined, (p) => {
            const t = p.sections.find((x) => x.id === section.id);
            if (t) (t.data as { items: unknown[] }).items = items;
          }, `sec-${section.id}.items`)}
        />
      );
    case "writing":
      return (
        <RowEditor
          items={(data.items as Record<string, unknown>[] | undefined) ?? []}
          specs={[
            { key: "title", label: "Title", placeholder: "Essay title", width: "half" },
            { key: "year", label: "Year", placeholder: "2024", width: "half" },
            { key: "url", label: "Link", placeholder: "https://…" },
          ]}
          defaults={{ title: "New article", url: "https://", year: "" }}
          addLabel="Add article"
          onChange={(items) => mutatePage(undefined, (p) => {
            const t = p.sections.find((x) => x.id === section.id);
            if (t) (t.data as { items: unknown[] }).items = items;
          }, `sec-${section.id}.items`)}
        />
      );
    case "resume":
      return (
        <div className="space-y-3">
          <Field label="Resume PDF">
            {data.mediaId ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="rounded bg-gold-soft px-2 py-0.5 text-xs text-primary">PDF attached</span>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => mutatePage(undefined, (p) => {
                  const t = p.sections.find((x) => x.id === section.id);
                  if (t) (t.data as { mediaId: string | null }).mediaId = null;
                })}>
                  <X className="size-3" aria-hidden /> Remove
                </Button>
              </div>
            ) : (
              <MediaUploadButton
                kind="DOCUMENT"
                label="Upload resume (PDF)"
                size="sm"
                onUploaded={(m: MediaDTO) => mutatePage(undefined, (p) => {
                  const t = p.sections.find((x) => x.id === section.id);
                  if (t) (t.data as { mediaId: string | null }).mediaId = m.id;
                })}
              />
            )}
          </Field>
          <Field label="Label">
            <Input value={String(data.note ?? "")} onChange={(e) => mutatePage(undefined, (p) => {
              const t = p.sections.find((x) => x.id === section.id);
              if (t) (t.data as { note: string }).note = e.target.value;
            }, `sec-${section.id}.note`)} placeholder="Resume — 2025" maxLength={200} className="text-sm" />
          </Field>
        </div>
      );
    case "contact":
      return (
        <div className="space-y-3">
          <Field label="Intro line">
            <Textarea value={String(data.sub ?? "")} onChange={(e) => mutatePage(undefined, (p) => {
              const t = p.sections.find((x) => x.id === section.id);
              if (t) (t.data as { sub: string }).sub = e.target.value;
            }, `sec-${section.id}.sub`)} rows={2} maxLength={300} className="text-sm" placeholder="Tell me about your project…" />
          </Field>
          <Field label="Public email">
            <Input value={String(data.email ?? "")} onChange={(e) => mutatePage(undefined, (p) => {
              const t = p.sections.find((x) => x.id === section.id);
              if (t) (t.data as { email: string }).email = e.target.value;
            }, `sec-${section.id}.email`)} type="email" maxLength={120} className="text-sm" placeholder="you@example.com" />
          </Field>
          <div>
            <Label className="mb-1.5 block text-[11px] text-muted-foreground">Social & other links</Label>
            <RowEditor
              items={(data.links as Record<string, unknown>[] | undefined) ?? []}
              specs={[
                { key: "label", label: "Label", placeholder: "Instagram", width: "half" },
                { key: "icon", label: "Icon", type: "select", options: SOCIAL_ICON_OPTIONS, width: "half" },
                { key: "url", label: "URL", placeholder: "https://…" },
              ]}
              defaults={{ label: "New link", url: "https://", icon: "other" }}
              addLabel="Add link"
              onChange={(items) => mutatePage(undefined, (p) => {
                const t = p.sections.find((x) => x.id === section.id);
                if (t) (t.data as { links: unknown[] }).links = items;
              }, `sec-${section.id}.links`)}
            />
          </div>
        </div>
      );
    case "footer":
      return (
        <div className="space-y-3">
          <Field label="Footer text">
            <Input value={String(data.text ?? "")} onChange={(e) => mutatePage(undefined, (p) => {
              const t = p.sections.find((x) => x.id === section.id);
              if (t) (t.data as { text: string }).text = e.target.value;
            }, `sec-${section.id}.text`)} maxLength={200} className="text-sm" placeholder="© 2025 Your Name" />
          </Field>
          <Field label="Availability line">
            <Input value={String(data.availability ?? "")} onChange={(e) => mutatePage(undefined, (p) => {
              const t = p.sections.find((x) => x.id === section.id);
              if (t) (t.data as { availability: string }).availability = e.target.value;
            }, `sec-${section.id}.avail`)} maxLength={80} className="text-sm" />
          </Field>
        </div>
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------ design controls

function DesignControls({ config, mutate, onOpenTemplates }: { config: PortfolioConfig; mutate: Mutate; onOpenTemplates: () => void }) {
  const t = config.theme;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/70 bg-card/60 p-4">
        <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><LayoutTemplate className="size-4 text-primary" aria-hidden /> Template</p>
        <p className="mb-3 text-[11px] text-muted-foreground">Twelve starting identities. Switching keeps all your content.</p>
        <Button variant="outline" size="sm" className="h-8 w-full" onClick={onOpenTemplates}>
          Browse templates — {getTemplate(config.templateId).name}
        </Button>
      </div>

      <div className="rounded-xl border border-border/70 bg-card/60 p-4">
        <p className="mb-3 flex items-center gap-2 text-sm font-semibold"><Palette className="size-4 text-primary" aria-hidden /> Colors</p>
        <SegRow
          label="Theme mode"
          value={t.mode}
          onChange={(mode) => mutate((c) => {
            c.theme.mode = mode;
            if (mode === "dark") Object.assign(c.theme, { accent: "#E8BC51", background: "#090A0C", surface: "#17191D", text: "#F7F5EF", muted: "#A5A6A8" });
            if (mode === "light") Object.assign(c.theme, { accent: "#C99A2E", background: "#F7F5EF", surface: "#FFFDF8", text: "#090A0C", muted: "#63656A" });
            // custom: leave the user's colors untouched
          }, "theme.mode")}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "custom", label: "Custom" },
          ]}
        />
        <div className="mt-3 space-y-2.5">
          <ColorField label="Accent" value={t.accent} onChange={(v) => mutate((c) => { c.theme.accent = v.toUpperCase(); }, "theme.accent")} />
          <ColorField label="Background" value={t.background} onChange={(v) => mutate((c) => { c.theme.background = v.toUpperCase(); }, "theme.bg")} />
          <ColorField label="Surface (cards)" value={t.surface} onChange={(v) => mutate((c) => { c.theme.surface = v.toUpperCase(); }, "theme.surface")} />
          <ColorField label="Text" value={t.text} onChange={(v) => mutate((c) => { c.theme.text = v.toUpperCase(); }, "theme.text")} />
          <ColorField label="Secondary text" value={t.muted} onChange={(v) => mutate((c) => { c.theme.muted = v.toUpperCase(); }, "theme.muted")} />
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-card/60 p-4">
        <p className="mb-3 text-sm font-semibold">Typography</p>
        <Field label="Font pairing">
          <Select value={t.fontPairing} onValueChange={(v) => mutate((c) => { c.theme.fontPairing = v as PortfolioConfig["theme"]["fontPairing"]; })}>
            <SelectTrigger aria-label="Font pairing"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="editorial">Editorial — Fraunces display + sans body</SelectItem>
              <SelectItem value="modern">Modern — sans display + sans body</SelectItem>
              <SelectItem value="technical">Technical — mono display + sans body</SelectItem>
              <SelectItem value="classic">Classic — serif throughout</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div className="mt-3">
          <Label className="text-xs text-muted-foreground">Text size — {Math.round(t.fontScale * 100)}%</Label>
          <Slider value={[t.fontScale]} min={0.85} max={1.25} step={0.05} onValueChange={([v]) => mutate((c) => { c.theme.fontScale = v; }, "theme.scale")} className="mt-2" aria-label="Text size" />
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-card/60 p-4">
        <p className="mb-3 text-sm font-semibold">Surfaces & effects</p>
        <Field label="Content width">
          <Select value={t.contentWidth} onValueChange={(v) => mutate((c) => { c.theme.contentWidth = v as PortfolioConfig["theme"]["contentWidth"]; })}>
            <SelectTrigger aria-label="Content width"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="narrow">Narrow — reading column</SelectItem>
              <SelectItem value="regular">Regular</SelectItem>
              <SelectItem value="wide">Wide — full bleed feel</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div className="mt-3">
          <Label className="text-xs text-muted-foreground">Corner radius — {t.radius}px</Label>
          <Slider value={[t.radius]} min={0} max={24} step={2} onValueChange={([v]) => mutate((c) => { c.theme.radius = v; }, "theme.radius")} className="mt-2" aria-label="Corner radius" />
        </div>
        <Field label="Card density">
          <Select value={t.density} onValueChange={(v) => mutate((c) => { c.theme.density = v as PortfolioConfig["theme"]["density"]; })}>
            <SelectTrigger className="mt-3" aria-label="Density"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="compact">Compact</SelectItem>
              <SelectItem value="regular">Regular</SelectItem>
              <SelectItem value="spacious">Spacious</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div className="mt-4 space-y-2">
          {([
            { key: "shadows" as const, label: "Soft shadows" },
            { key: "glass" as const, label: "Glass navigation" },
            { key: "grain" as const, label: "Film grain texture" },
          ]).map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">{label}</Label>
              <Switch checked={t[key]} onCheckedChange={(v) => mutate((c) => { c.theme[key] = v; }, `theme.${key}`)} aria-label={label} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LayoutControls({ config, mutate }: { config: PortfolioConfig; mutate: Mutate }) {
  const l = config.layout;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/70 bg-card/60 p-4">
        <p className="mb-3 text-sm font-semibold">Structure</p>
        <SegRow label="Navigation" value={l.nav} onChange={(v) => mutate((c) => { c.layout.nav = v; }, "layout.nav")} options={[{ value: "top" as const, label: "Top bar" }, { value: "sidebar" as const, label: "Sidebar (desktop)" }]} />
        <div className="mt-3">
          <SegRow
            label="Hero layout"
            value={l.heroLayout}
            onChange={(v) => mutate((c) => { c.layout.heroLayout = v; }, "layout.hero")}
            options={[
              { value: "centered" as const, label: "Centered editorial" },
              { value: "split" as const, label: "Split screen" },
              { value: "cinematic" as const, label: "Cinematic full-width" },
              { value: "portrait" as const, label: "Portrait focus" },
              { value: "minimal" as const, label: "Typography only" },
            ]}
          />
        </div>
        <div className="mt-3">
          <SegRow label="Section alignment" value={l.align} onChange={(v) => mutate((c) => { c.layout.align = v; }, "layout.align")} options={[{ value: "left" as const, label: "Left" }, { value: "center" as const, label: "Center" }]} />
        </div>
      </div>
      <div className="rounded-xl border border-border/70 bg-card/60 p-4">
        <p className="mb-3 text-sm font-semibold">Project cards</p>
        <SegRow label="Gallery layout" value={l.projectGrid} onChange={(v) => mutate((c) => { c.layout.projectGrid = v; }, "layout.grid")} options={[{ value: "grid" as const, label: "Grid" }, { value: "masonry" as const, label: "Masonry" }]} />
        <div className="mt-3">
          <SegRow
            label="Card aspect"
            value={l.cardAspect}
            onChange={(v) => mutate((c) => { c.layout.cardAspect = v; }, "layout.aspect")}
            options={[
              { value: "landscape" as const, label: "4:3" },
              { value: "cinema" as const, label: "16:9" },
              { value: "square" as const, label: "1:1" },
              { value: "portrait" as const, label: "3:4" },
            ]}
          />
        </div>
        <div className="mt-3">
          <SegRow label="Columns" value={String(l.columns) as "2" | "3" | "4"} onChange={(v) => mutate((c) => { c.layout.columns = Number(v) as 2 | 3 | 4; }, "layout.cols")} options={[{ value: "2" as const, label: "2" }, { value: "3" as const, label: "3" }, { value: "4" as const, label: "4" }]} />
        </div>
        <div className="mt-3">
          <SegRow label="Section spacing" value={l.sectionSpacing} onChange={(v) => mutate((c) => { c.layout.sectionSpacing = v; }, "layout.space")} options={[{ value: "compact" as const, label: "Compact" }, { value: "regular" as const, label: "Regular" }, { value: "spacious" as const, label: "Spacious" }]} />
        </div>
      </div>
      <div className="rounded-xl border border-border/70 bg-card/60 p-4">
        <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-primary" aria-hidden /> Motion</p>
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Entrance animations</Label>
          <Switch checked={config.motion.enabled} onCheckedChange={(v) => mutate((c) => { c.motion.enabled = v; }, "motion.on")} aria-label="Entrance animations" />
        </div>
        <div className="mt-3">
          <SegRow
            label="Entrance style"
            value={config.motion.entrance}
            onChange={(v) => mutate((c) => { c.motion.entrance = v; }, "motion.entrance")}
            options={[
              { value: "none" as const, label: "None" },
              { value: "fade" as const, label: "Fade" },
              { value: "rise" as const, label: "Rise" },
              { value: "blur" as const, label: "Blur" },
            ]}
          />
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">Visitors with reduced-motion enabled always see a still page.</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ widget data editor

function WidgetDataEditor({ widget, mutatePage, projectOptions }: { widget: WidgetConfig; mutatePage: PageMutate; projectOptions: { value: string; label: string }[] }) {
  const set = (fn: (data: Record<string, unknown>) => void, tag?: string) =>
    mutatePage(undefined, (p) => {
      const t = p.widgets.find((x) => x.id === widget.id);
      if (t) fn(t.data);
    }, `w-${widget.id}.${tag ?? "data"}`);

  const list = (key: string) => (widget.data[key] as Record<string, unknown>[] | undefined) ?? [];
  const setList = (key: string, items: Record<string, unknown>[]) => set((d) => { d[key] = items; }, key);

  const projectSelect = (key: string, label: string) => (
    <Field label={label}>
      <Select value={String(widget.data[key] ?? "none")} onValueChange={(v) => set((d) => { d[key] = v === "none" ? null : v; }, key)}>
        <SelectTrigger aria-label={label}><SelectValue placeholder="Pick a project" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">None</SelectItem>
          {projectOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );

  const mediaPick = (key: string, label: string, kind: "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT") => (
    <Field label={label}>
      {widget.data[key] ? (
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">Attached</Badge>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => set((d) => { d[key] = null; }, key)}>
            <X className="size-3" aria-hidden /> Remove
          </Button>
        </div>
      ) : (
        <MediaUploadButton kind={kind} label={`Upload ${kind.toLowerCase()}`} size="sm" onUploaded={(m: MediaDTO) => set((d) => { d[key] = m.id; }, key)} />
      )}
    </Field>
  );

  switch (widget.type) {
    case "techStack":
      return (
        <Field label="Technologies">
          <TagInput value={(widget.data.items as string[] | undefined) ?? []} max={40} onChange={(items) => set((d) => { d.items = items; }, "items")} placeholder="Type a tool and press Enter" />
        </Field>
      );
    case "githubRepos":
      return (
        <RowEditor
          items={list("items")}
          specs={[
            { key: "name", label: "Repository", placeholder: "beanfolio/app", width: "half" },
            { key: "language", label: "Language", placeholder: "TypeScript", width: "half" },
            { key: "description", label: "Description", placeholder: "What it does" },
            { key: "url", label: "URL", placeholder: "https://github.com/…" },
          ]}
          defaults={{ name: "New repository", url: "https://github.com/", description: "", language: "" }}
          addLabel="Add repository"
          onChange={(items) => setList("items", items)}
        />
      );
    case "featuredVideo":
      return (
        <div className="space-y-3">
          {mediaPick("mediaId", "Video file", "VIDEO")}
          <Field label="Caption">
            <Input value={String(widget.data.caption ?? "")} onChange={(e) => set((d) => { d.caption = e.target.value; }, "caption")} maxLength={200} className="text-sm" />
          </Field>
        </div>
      );
    case "imageGallery":
      return (
        <div className="space-y-2">
          {(list("items") as { mediaId: string; caption: string }[]).map((it, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-border/70 p-2">
              <img src={`/api/media/${it.mediaId}/raw`} alt="" className="size-10 rounded object-cover" />
              <Input value={it.caption} onChange={(e) => setList("items", list("items").map((x, j) => (j === i ? { ...x, caption: e.target.value } : x)))} placeholder="Caption (optional)" className="h-8 flex-1 text-xs" aria-label="Image caption" />
              <Button variant="ghost" size="icon" className="size-7" onClick={() => setList("items", list("items").filter((_, j) => j !== i))} aria-label="Remove image">
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          <MediaUploadButton kind="IMAGE" label="Add images" size="sm" onUploaded={(m: MediaDTO) => set((d) => { d.items = [...((d.items as { mediaId: string; caption: string }[]) ?? []), { mediaId: m.id, caption: "" }]; }, "items")} />
        </div>
      );
    case "audioPlayer":
      return (
        <div className="space-y-2">
          {(list("items") as { mediaId: string; title: string }[]).map((it, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-border/70 p-2">
              <Input value={it.title} onChange={(e) => setList("items", list("items").map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} placeholder="Track title" className="h-8 flex-1 text-xs" aria-label="Track title" />
              <Button variant="ghost" size="icon" className="size-7" onClick={() => setList("items", list("items").filter((_, j) => j !== i))} aria-label="Remove track">
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          <MediaUploadButton kind="AUDIO" label="Add audio" size="sm" onUploaded={(m: MediaDTO) => set((d) => { d.items = [...((d.items as { mediaId: string; title: string }[]) ?? []), { mediaId: m.id, title: "" }]; }, "items")} />
        </div>
      );
    case "projectTimeline":
      return (
        <RowEditor
          items={list("items")}
          specs={[
            { key: "title", label: "Milestone", placeholder: "Kickoff", width: "half" },
            { key: "period", label: "Period", placeholder: "Spring 2025", width: "half" },
            { key: "note", label: "Note", placeholder: "What happened" },
          ]}
          defaults={{ title: "New milestone", period: "", note: "", projectId: null }}
          addLabel="Add milestone"
          onChange={(items) => setList("items", items)}
        />
      );
    case "experienceTimeline":
      return (
        <RowEditor
          items={list("items")}
          specs={[
            { key: "org", label: "Organisation", placeholder: "Studio", width: "half" },
            { key: "kind", label: "Type", type: "select", options: [{ value: "work", label: "Work" }, { value: "education", label: "Education" }], width: "half" },
            { key: "role", label: "Role / degree", width: "half" },
            { key: "period", label: "Period", width: "half" },
            { key: "summary", label: "Summary" },
          ]}
          defaults={{ kind: "work", org: "New entry", role: "", period: "", summary: "" }}
          addLabel="Add entry"
          onChange={(items) => setList("items", items)}
        />
      );
    case "achievements":
      return (
        <RowEditor
          items={list("items")}
          specs={[
            { key: "title", label: "Achievement", placeholder: "Best short film", width: "half" },
            { key: "year", label: "Year", placeholder: "2024", width: "half" },
            { key: "issuer", label: "Issuer", placeholder: "Festival", width: "half" },
            { key: "url", label: "Credential URL", placeholder: "https://…" },
          ]}
          defaults={{ title: "New achievement", issuer: "", year: "", url: "" }}
          addLabel="Add achievement"
          onChange={(items) => setList("items", items)}
        />
      );
    case "resumeDownload":
      return (
        <div className="space-y-3">
          {mediaPick("mediaId", "Resume PDF", "DOCUMENT")}
          <Field label="Label">
            <Input value={String(widget.data.note ?? "")} onChange={(e) => set((d) => { d.note = e.target.value; }, "note")} maxLength={200} className="text-sm" placeholder="Resume — 2025" />
          </Field>
        </div>
      );
    case "socialLinks":
      return (
        <RowEditor
          items={list("items")}
          specs={[
            { key: "label", label: "Label", placeholder: "Instagram", width: "half" },
            { key: "icon", label: "Icon", type: "select", options: SOCIAL_ICON_OPTIONS, width: "half" },
            { key: "url", label: "URL", placeholder: "https://…" },
          ]}
          defaults={{ label: "New link", url: "https://", icon: "other" }}
          addLabel="Add link"
          onChange={(items) => setList("items", items)}
        />
      );
    case "availability":
      return <p className="text-xs text-muted-foreground">This widget shows your availability and location straight from your BEAN Folio profile — set them in My Folio.</p>;
    case "testimonials":
      return (
        <RowEditor
          items={list("items")}
          specs={[
            { key: "quote", label: "Quote", type: "textarea" },
            { key: "author", label: "Author", width: "half" },
            { key: "role", label: "Role / context", width: "half" },
          ]}
          defaults={{ quote: "", author: "", role: "" }}
          addLabel="Add testimonial"
          onChange={(items) => setList("items", items)}
        />
      );
    case "writingFeed":
      return (
        <RowEditor
          items={list("items")}
          specs={[
            { key: "title", label: "Title", width: "half" },
            { key: "year", label: "Year", width: "half" },
            { key: "url", label: "URL", placeholder: "https://…" },
          ]}
          defaults={{ title: "New article", url: "https://", year: "" }}
          addLabel="Add article"
          onChange={(items) => setList("items", items)}
        />
      );
    case "currentProgress":
      return (
        <div className="space-y-3">
          {projectSelect("projectId", "Project")}
          <div>
            <Label className="text-xs text-muted-foreground">Progress — {Number(widget.data.percent ?? 0)}%</Label>
            <Slider value={[Number(widget.data.percent ?? 0)]} min={0} max={100} step={5} onValueChange={([v]) => set((d) => { d.percent = v; }, "percent")} className="mt-2" aria-label="Progress percent" />
          </div>
          <Field label="Note">
            <Input value={String(widget.data.note ?? "")} onChange={(e) => set((d) => { d.note = e.target.value; }, "note")} maxLength={300} className="text-sm" />
          </Field>
        </div>
      );
    case "faq":
      return (
        <RowEditor
          items={list("items")}
          specs={[
            { key: "q", label: "Question", placeholder: "Do you take commissions?" },
            { key: "a", label: "Answer", type: "textarea" },
          ]}
          defaults={{ q: "New question", a: "" }}
          addLabel="Add question"
          onChange={(items) => setList("items", items)}
        />
      );
    case "linkButtons":
      return (
        <RowEditor
          items={list("items")}
          specs={[
            { key: "label", label: "Button label", width: "half" },
            { key: "url", label: "URL", width: "half" },
          ]}
          defaults={{ label: "New button", url: "https://" }}
          addLabel="Add button"
          onChange={(items) => setList("items", items)}
        />
      );
    case "stats":
      return <MetricsEditor items={(widget.data.items as { value: string; label: string }[] | undefined) ?? []} onChange={(items) => set((d) => { d.items = items; }, "items")} />;
    case "ctaBanner":
      return (
        <div className="space-y-3">
          <Field label="Banner text">
            <Input value={String(widget.data.text ?? "")} onChange={(e) => set((d) => { d.text = e.target.value; }, "text")} maxLength={200} className="text-sm" />
          </Field>
          <Field label="Button label">
            <Input value={String(widget.data.buttonLabel ?? "")} onChange={(e) => set((d) => { d.buttonLabel = e.target.value; }, "buttonLabel")} maxLength={40} className="text-sm" />
          </Field>
        </div>
      );
    case "codeShowcase":
      return (
        <div className="space-y-3">
          <Field label="Language">
            <Select value={String(widget.data.language ?? "ts")} onValueChange={(v) => set((d) => { d.language = v; }, "language")}>
              <SelectTrigger aria-label="Language"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["ts", "tsx", "js", "python", "rust", "go", "css", "html", "sql", "bash", "json"].map((l) => (
                  <SelectItem key={l} value={l}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Code">
            <Textarea value={String(widget.data.code ?? "")} onChange={(e) => set((d) => { d.code = e.target.value; }, "code")} rows={6} maxLength={4000} className="font-mono text-xs" />
          </Field>
          <Field label="Caption">
            <Input value={String(widget.data.caption ?? "")} onChange={(e) => set((d) => { d.caption = e.target.value; }, "caption")} maxLength={140} className="text-sm" />
          </Field>
        </div>
      );
    case "beforeAfter":
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {mediaPick("beforeMediaId", "Before image", "IMAGE")}
            {mediaPick("afterMediaId", "After image", "IMAGE")}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Before label">
              <Input value={String(widget.data.beforeLabel ?? "")} onChange={(e) => set((d) => { d.beforeLabel = e.target.value; }, "beforeLabel")} maxLength={40} className="text-sm" />
            </Field>
            <Field label="After label">
              <Input value={String(widget.data.afterLabel ?? "")} onChange={(e) => set((d) => { d.afterLabel = e.target.value; }, "afterLabel")} maxLength={40} className="text-sm" />
            </Field>
          </div>
        </div>
      );
    case "comparison":
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {projectSelect("projectIdA", "Project A")}
            {projectSelect("projectIdB", "Project B")}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label A">
              <Input value={String(widget.data.labelA ?? "")} onChange={(e) => set((d) => { d.labelA = e.target.value; }, "labelA")} maxLength={40} className="text-sm" />
            </Field>
            <Field label="Label B">
              <Input value={String(widget.data.labelB ?? "")} onChange={(e) => set((d) => { d.labelB = e.target.value; }, "labelB")} maxLength={40} className="text-sm" />
            </Field>
          </div>
        </div>
      );
    case "demoPreview":
      return (
        <div className="space-y-3">
          <Field label="Live demo URL">
            <Input value={String(widget.data.url ?? "")} onChange={(e) => set((d) => { d.url = e.target.value; }, "url")} placeholder="https://…" className="text-sm" />
          </Field>
          {mediaPick("screenshotMediaId", "Screenshot", "IMAGE")}
          <Field label="Note">
            <Input value={String(widget.data.note ?? "")} onChange={(e) => set((d) => { d.note = e.target.value; }, "note")} maxLength={200} className="text-sm" />
          </Field>
        </div>
      );
    case "codeSandbox":
      return (
        <div className="space-y-3">
          <Field label="HTML" hint="Rendered inside a sandboxed iframe — scripts can't touch this site, cookies or the network.">
            <Textarea value={String(widget.data.html ?? "")} onChange={(e) => set((d) => { d.html = e.target.value; }, "html")} rows={5} maxLength={8000} className="font-mono text-xs" />
          </Field>
          <Field label="CSS">
            <Textarea value={String(widget.data.css ?? "")} onChange={(e) => set((d) => { d.css = e.target.value; }, "css")} rows={4} maxLength={4000} className="font-mono text-xs" />
          </Field>
          <Field label="JavaScript">
            <Textarea value={String(widget.data.js ?? "")} onChange={(e) => set((d) => { d.js = e.target.value; }, "js")} rows={4} maxLength={4000} className="font-mono text-xs" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Height (px)">
              <Input
                type="number"
                value={String(widget.data.height ?? 320)}
                onChange={(e) => set((d) => { d.height = Math.max(120, Math.min(900, Number(e.target.value) || 320)); }, "height")}
                className="text-sm"
              />
            </Field>
            <Field label="Note">
              <Input value={String(widget.data.note ?? "")} onChange={(e) => set((d) => { d.note = e.target.value; }, "note")} maxLength={200} className="text-sm" />
            </Field>
          </div>
        </div>
      );
    case "terminalDemo":
      return (
        <div className="space-y-3">
          <Field label="Terminal title">
            <Input value={String(widget.data.title ?? "")} onChange={(e) => set((d) => { d.title = e.target.value; }, "title")} maxLength={80} className="text-sm" />
          </Field>
          <RowEditor
            items={list("lines")}
            specs={[
              { key: "cmd", label: "Command", width: "half", placeholder: "npm run build" },
              { key: "output", label: "Output (optional)", width: "half", placeholder: "✓ built in 1.2s" },
            ]}
            defaults={{ cmd: "", output: "" }}
            addLabel="Add line"
            max={12}
            onChange={(items) => setList("lines", items)}
          />
        </div>
      );
    case "codeCompare":
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Language">
              <Select value={String(widget.data.language ?? "ts")} onValueChange={(v) => set((d) => { d.language = v; }, "language")}>
                <SelectTrigger aria-label="Language"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["ts", "tsx", "js", "python", "rust", "go", "css", "html", "sql", "bash"].map((l) => (
                    <SelectItem key={l} value={l}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Left label">
              <Input value={String(widget.data.labelA ?? "")} onChange={(e) => set((d) => { d.labelA = e.target.value; }, "labelA")} maxLength={40} className="text-sm" />
            </Field>
            <Field label="Right label">
              <Input value={String(widget.data.labelB ?? "")} onChange={(e) => set((d) => { d.labelB = e.target.value; }, "labelB")} maxLength={40} className="text-sm" />
            </Field>
          </div>
          <Field label="Left code">
            <Textarea value={String(widget.data.codeA ?? "")} onChange={(e) => set((d) => { d.codeA = e.target.value; }, "codeA")} rows={5} maxLength={4000} className="font-mono text-xs" />
          </Field>
          <Field label="Right code">
            <Textarea value={String(widget.data.codeB ?? "")} onChange={(e) => set((d) => { d.codeB = e.target.value; }, "codeB")} rows={5} maxLength={4000} className="font-mono text-xs" />
          </Field>
        </div>
      );
    case "archDiagram":
      return (
        <RowEditor
          items={list("steps")}
          specs={[
            { key: "title", label: "Step", width: "half", placeholder: "Client" },
            { key: "note", label: "Note", width: "half", placeholder: "Next.js on Vercel" },
          ]}
          defaults={{ title: "New step", note: "" }}
          addLabel="Add step"
          max={8}
          onChange={(items) => setList("steps", items)}
        />
      );
    case "githubSummary":
      return (
        <div className="space-y-3">
          <Field label="GitHub handle">
            <Input value={String(widget.data.handle ?? "")} onChange={(e) => set((d) => { d.handle = e.target.value; }, "handle")} maxLength={60} placeholder="your-handle" className="text-sm" />
          </Field>
          <Field label="Profile URL">
            <Input value={String(widget.data.profileUrl ?? "")} onChange={(e) => set((d) => { d.profileUrl = e.target.value; }, "profileUrl")} placeholder="https://github.com/…" className="text-sm" />
          </Field>
          <RowEditor
            items={list("items")}
            specs={[
              { key: "label", label: "Metric", width: "half", placeholder: "Public repos" },
              { key: "value", label: "Value", width: "half", placeholder: "24" },
            ]}
            defaults={{ label: "", value: "" }}
            addLabel="Add metric"
            max={8}
            onChange={(items) => setList("items", items)}
          />
          <p className="text-[11px] text-muted-foreground">Numbers are shown exactly as you enter them — the widget never fetches live data, so keep them honest.</p>
        </div>
      );
    case "embedCard":
      return (
        <div className="space-y-3">
          <Field label="Title">
            <Input value={String(widget.data.title ?? "")} onChange={(e) => set((d) => { d.title = e.target.value; }, "title")} maxLength={120} className="text-sm" />
          </Field>
          <Field label="Link">
            <Input value={String(widget.data.url ?? "")} onChange={(e) => set((d) => { d.url = e.target.value; }, "url")} placeholder="https://…" className="text-sm" />
          </Field>
          {mediaPick("screenshotMediaId", "Screenshot", "IMAGE")}
          <Field label="Source name">
            <Input value={String(widget.data.source ?? "")} onChange={(e) => set((d) => { d.source = e.target.value; }, "source")} maxLength={80} className="text-sm" placeholder="e.g. MDN Web Docs" />
          </Field>
          <Field label="Note">
            <Input value={String(widget.data.note ?? "")} onChange={(e) => set((d) => { d.note = e.target.value; }, "note")} maxLength={240} className="text-sm" />
          </Field>
          <p className="text-[11px] text-muted-foreground">External pages open in a new tab — they are never embedded live on your site.</p>
        </div>
      );
    case "readmePreview":
      return (
        <div className="space-y-3">
          <Field label="README content" hint="Markdown-lite: headings (#), bullets (-), **bold**, `code`, [links](https://…).">
            <Textarea value={String(widget.data.body ?? "")} onChange={(e) => set((d) => { d.body = e.target.value; }, "body")} rows={7} maxLength={4000} className="font-mono text-xs" />
          </Field>
          <Field label="Source URL (optional)">
            <Input value={String(widget.data.sourceUrl ?? "")} onChange={(e) => set((d) => { d.sourceUrl = e.target.value; }, "sourceUrl")} placeholder="https://github.com/…" className="text-sm" />
          </Field>
        </div>
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------ dialogs

function TemplateDialog({ open, onOpenChange, current, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; current: string; onPick: (id: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose a template</DialogTitle>
          <DialogDescription>Each template is a distinct visual identity built on the same data — switching never touches your content.</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[60vh] grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onPick(t.id)}
              className={cn(
                "rounded-xl border p-4 text-left transition-all hover:-translate-y-0.5",
                current === t.id ? "border-primary ring-1 ring-primary/40" : "border-border"
              )}
            >
              <div className="flex items-center gap-2">
                <span className="flex -space-x-1">
                  {[t.swatch.bg, t.swatch.surface, t.swatch.accent].map((c) => (
                    <span key={c} className="size-5 rounded-full border border-border" style={{ background: c }} />
                  ))}
                </span>
                {current === t.id && <Badge variant="secondary" className="ml-auto text-[10px]">Current</Badge>}
              </div>
              <p className="mt-3 text-sm font-semibold">{t.name}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t.blurb}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {t.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-[10px] font-normal">{tag}</Badge>
                ))}
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface RevisionItem {
  id: string;
  label: string | null;
  createdAt: string;
}

function RevisionsDialog({ open, onOpenChange, onRestored }: { open: boolean; onOpenChange: (o: boolean) => void; onRestored: () => Promise<void> }) {
  const [revisions, setRevisions] = useState<RevisionItem[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRevisions(null);
    api<{ revisions: RevisionItem[] }>("/api/portfolio/revisions")
      .then((r) => setRevisions(r.revisions))
      .catch(() => setRevisions([]));
  }, [open]);

  async function restore(id: string) {
    setRestoring(id);
    try {
      await api(`/api/portfolio/revisions/${id}/restore`, { method: "POST" });
      toast.success("Version restored into your draft");
      await onRestored();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Restore failed");
    } finally {
      setRestoring(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Published versions</DialogTitle>
          <DialogDescription>Each publish keeps a snapshot. Restoring copies it into your draft — publish again to make it live.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
          {revisions === null && <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" aria-label="Loading versions" />}
          {revisions?.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No published versions yet.</p>}
          {revisions?.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{r.label ?? "Published version"}</p>
                <p className="text-[11px] text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</p>
              </div>
              <Button variant="outline" size="sm" className="h-7 text-xs" disabled={restoring !== null} onClick={() => void restore(r.id)}>
                {restoring === r.id ? <Loader2 className="size-3 animate-spin" aria-hidden /> : "Restore"}
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------ Code Giftz AI designer

const AI_STARTERS = [
  "Create a premium black-and-gold portfolio for a full-stack developer.",
  "Make my hero section more professional and visually striking.",
  "Add a responsive project grid with image previews.",
  "Create a clean contact section with social links.",
  "Improve the typography and spacing without changing my brand colors.",
  "Create a terminal-style code showcase for my GitHub projects.",
];

function AiDesignerDialog({
  open,
  onOpenChange,
  slug,
  activePageId,
  activePageName,
  selectionKind,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  slug: string;
  activePageId: string;
  activePageName: string;
  selectionKind: string | null;
  onApply: (p: AiProposal) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "preview">("idle");
  const [proposal, setProposal] = useState<AiProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<number | null>(null);
  const [siteData, setSiteData] = useState<import("@/lib/portfolio-schema").SiteResponse | null>(null);
  const [tab, setTab] = useState<"proposed" | "current">("proposed");

  // Reset transient state when the dialog closes (no effect — this runs in the event).
  function handleClose(o: boolean) {
    onOpenChange(o);
    if (!o) {
      setPhase("idle");
      setProposal(null);
      setError(null);
      setErrorCode(null);
      setPrompt("");
      setTab("proposed");
    }
  }

  // Load the owner's own site payload so the after-preview can render for real.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api<import("@/lib/portfolio-schema").SiteResponse>(`/api/site/${encodeURIComponent(slug)}?draft=1`)
      .then((res) => alive && setSiteData(res))
      .catch(() => alive && setSiteData(null));
    return () => {
      alive = false;
    };
  }, [open, slug]);

  async function run(text: string) {
    setPhase("loading");
    setError(null);
    setErrorCode(null);
    try {
      const res = await api<AiProposal>("/api/ai/design", {
        method: "POST",
        json: {
          prompt: text,
          pageId: activePageId,
          selection: selectionKind,
        },
      });
      setProposal(res);
      setPhase("preview");
      setTab("proposed");
    } catch (e) {
      const err = e as Error & { status?: number };
      setPhase("idle");
      setError(err.message || "The AI could not be reached.");
      setErrorCode(err.status ?? null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-5 text-primary" aria-hidden /> Code Giftz AI — website designer
          </DialogTitle>
          <DialogDescription>
            Describe the change in plain language. You'll preview the proposal before anything touches your draft — the published site is never modified until you publish.
          </DialogDescription>
        </DialogHeader>

        {phase === "idle" && (
          <div className="space-y-3">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder={`e.g. "Make the ${activePageName} page feel more cinematic" or "Add a skills section with a dark terminal vibe"`}
              aria-label="Describe the design change"
            />
            <div className="flex flex-wrap gap-1.5">
              {AI_STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="rounded-full border border-border px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => setPrompt(s)}
                >
                  {s.length > 46 ? `${s.slice(0, 46)}…` : s}
                </button>
              ))}
            </div>
            {error && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
                {error}
                {errorCode === 403 && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    BEAN Intelligence is off for your account.{" "}
                    <button type="button" className="underline" onClick={() => { handleClose(false); navigate("/intelligence"); }}>
                      Enable it in BEAN Intelligence
                    </button>
                    .
                  </p>
                )}
                {errorCode === 429 && <p className="mt-1.5 text-xs text-muted-foreground">The daily AI limit resets at midnight UTC.</p>}
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">The assistant reads your draft config and your own profile/projects. Other people's content is never shared with the model.</p>
              <Button disabled={prompt.trim().length < 4} onClick={() => void run(prompt.trim())}>
                <Wand2 className="size-4" aria-hidden /> Propose design
              </Button>
            </div>
          </div>
        )}

        {phase === "loading" && (
          <div className="flex flex-col items-center gap-3 py-10" aria-busy="true">
            <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
            <p className="text-sm text-muted-foreground">Code Giftz AI is reading your site and drafting a proposal…</p>
          </div>
        )}

        {phase === "preview" && proposal && (
          <div className="space-y-3">
            <div className="rounded-lg border border-primary/30 bg-gold-soft/30 p-3">
              <p className="text-sm font-medium">{proposal.summary}</p>
              {proposal.rationale && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{proposal.rationale}</p>}
            </div>
            <div className="flex items-center justify-between">
              <div className="flex gap-1 rounded-lg border border-border p-0.5" role="tablist" aria-label="Preview version">
                {(
                  [
                    { v: "proposed" as const, label: "After (proposed)" },
                    { v: "current" as const, label: "Before (current)" },
                  ]
                ).map(({ v, label }) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={tab === v}
                    onClick={() => setTab(v)}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                      tab === v ? "bg-gold-soft text-primary" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="h-[46vh] overflow-y-auto rounded-xl border border-border/70 bg-background">
              {siteData ? (
                <div className="origin-top" style={{ transform: "scale(1)" }}>
                  <PortfolioRenderer
                    config={tab === "proposed" ? proposal.config : siteData.config}
                    page={(tab === "proposed" ? proposal.config : siteData.config).pages.find((p) => p.id === activePageId) ?? (tab === "proposed" ? proposal.config : siteData.config).pages[0]}
                    pages={(tab === "proposed" ? proposal.config : siteData.config).pages.map((p) => ({
                      id: p.id, name: p.name, slug: p.slug, isHome: p.isHome, inNav: p.inNav, isPublished: p.isPublished, seoTitle: p.seoTitle, seoDescription: p.seoDescription,
                    }))}
                    owner={siteData.owner}
                    projects={siteData.projects}
                    slug={siteData.slug}
                    interactive={false}
                    pageBase={`#/embed/draft/${siteData.slug}`}
                  />
                </div>
              ) : (
                <div className="grid h-full place-items-center p-6 text-sm text-muted-foreground">Loading preview…</div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" onClick={() => { setPhase("idle"); setProposal(null); }}>
                <RotateCcw className="size-4" aria-hidden /> Refine
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => handleClose(false)}>Discard</Button>
                <Button onClick={() => { onApply(proposal); handleClose(false); }}>
                  <Check className="size-4" aria-hidden /> Apply to draft
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

