"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Eye,
  FilePlus2,
  Info,
  Loader2,
  MinusCircle,
  MonitorSmartphone,
  Paperclip,
  Play,
  RotateCcw,
  ScanSearch,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Telescope,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, uploadFile } from "@/lib/client";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { SiteConfig } from "@/lib/site-config";
import type { DesignPlan } from "@/lib/ai-design/plan";
import type { BrowserCheck } from "@/lib/ai-design/browser-checks";
import { buildSiteDigest, digestSummaryLine } from "@/lib/ai-design/digest";
import type { AiDesignProposal, SiteMaterialDTO } from "@/lib/types";

export interface CodeGiftzProposal extends AiDesignProposal {
  request: string;
  /**
   * The exact editor config this proposal was generated from. The builder
   * compares it against the live draft to detect stale proposals — a proposal
   * must never silently overwrite edits the user made after requesting it.
   */
  baseConfig: SiteConfig;
}

export interface CodeGiftzContext {
  device: string;
  pageName: string | null;
  sectionType: string | null;
  sectionTitle: string | null;
}

// ---------------------------------------------------------------- job views
// Client-side projections of the server's job snapshot (see
// src/lib/ai-design/jobs.ts). `config`/`baseConfig` are present only on
// finished jobs.

type JobStepStatus = "pending" | "running" | "done" | "repaired" | "failed" | "skipped";

interface JobStepView {
  id: string;
  title: string;
  tool: string;
  kind: string;
  targets: string[];
  summary: string;
  risk: string;
  status: JobStepStatus;
  changes: string[];
  error: string | null;
}

interface VerificationView {
  checks: { id: string; label: string; status: "pass" | "warn" | "fail"; detail: string }[];
  passed: number;
  warned: number;
  failed: number;
  untested: string[];
}

interface JobView {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  reply: string;
  notes: string | null;
  constraints: { text: string; targets: string[] }[];
  steps: JobStepView[];
  changes: string[];
  verification: VerificationView | null;
  error: string | null;
  cancelRequested: boolean;
  config?: SiteConfig;
  baseConfig?: SiteConfig;
}

interface AuditFinding {
  severity: "high" | "medium" | "low";
  area: string;
  finding: string;
  evidence: string;
  suggestion: string;
}

type Phase =
  | { k: "idle" }
  | { k: "planning" }
  | { k: "plan"; plan: DesignPlan; base: SiteConfig; request: string; /** Source-material media ids this plan was composed with (create workflow) — must ride along to execute, or the job runs without the user's materials. */ materialIds: string[] }
  | { k: "running"; jobId: string; base: SiteConfig | null; request: string }
  | { k: "review"; job: JobView; base: SiteConfig | null; request: string }
  | { k: "auditing" }
  | { k: "audit"; reply: string; findings: AuditFinding[] };

/** The two Code Giftz workflows: repair the current draft, or compose a
 *  personalized website from the user's own uploaded materials. */
type Workflow = "fix" | "create";

interface Turn {
  role: "user" | "assistant";
  text: string;
  kind?: "proposal" | "audit" | "plan" | "execution" | "text";
}

/** Finished jobs the user already dealt with — never re-suggested after a remount. */
const dismissedJobs = new Set<string>();

/**
 * Code Giftz — the website-ENGINEERING agent INSIDE Website Studio.
 *
 * A distinct agent from RIISHE (the general assistant at #/intelligence).
 * The panel drives the full agentic workflow against real server endpoints:
 *
 *  1. PLAN      — POST /api/ai/design/plan turns the request into a validated
 *                 implementation plan (steps bound to real mutation tools,
 *                 preservation constraints, dependencies). Grounded in the
 *                 server-computed site digest + the user's own portfolio.
 *  2. APPROVE   — the user reviews the plan; nothing executes without it.
 *  3. EXECUTE   — POST /api/ai/design/execute runs the plan as an owned job;
 *                 the panel polls /api/ai/design/job for per-step progress,
 *                 supports cooperative cancellation and retry-from-failure.
 *  4. VERIFY    — the finished job carries a verification report (schema,
 *                 fonts, WCAG contrast, motion restraint, structure,
 *                 preserved regions, id stability) with untested checks
 *                 listed honestly.
 *  5. PREVIEW   — the result goes to the builder canvas through the same
 *                 proposal flow as before (stale-guard, accept-as-draft,
 *                 undo/redo). Code Giftz never saves or publishes.
 *
 * AUDIT mode inspects the site (computed evidence + model review) and
 * returns prioritized findings with severity, area, evidence and fix — it
 * changes nothing.
 */

const EDIT_EXAMPLES = [
  "Make my portfolio feel like a premium editorial design studio.",
  "Improve the hero without changing my project grid.",
  "Make the layout more cinematic but keep it fast on mobile.",
  "Use a consistent typography scale throughout the site.",
  "Create a better case-study layout for my visual projects.",
  "Reduce the empty space and align all sections.",
  "Keep the design, but improve mobile responsiveness.",
];

/** The fix workflow — concrete repair requests. */
const FIX_EXAMPLES = [
  "Fix the overlapping text and buttons.",
  "Correct the spacing and alignment.",
  "Make this section responsive on mobile.",
  "Fix the broken images and links.",
  "Improve the readability without changing my design.",
  "Change the hero section but keep the rest of my website unchanged.",
];

/** Materials the create workflow accepts — mirrored from the media rules. */
const MATERIAL_ACCEPT = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/html",
  "text/css",
  "application/javascript",
  ".pdf", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".webm", ".mov",
  ".txt", ".md", ".csv", ".json", ".html", ".css", ".js",
].join(",");

const AUDIT_EXAMPLES = [
  "Audit my visual hierarchy and spacing.",
  "Check my typography for consistency problems.",
  "Is my section order right for my profession?",
  "Am I over-animating my portfolio?",
];

const KIND_LABEL: Record<string, string> = {
  design: "design",
  content: "content",
  functionality: "functionality",
  architecture: "architecture",
};

const AREA_LABEL: Record<string, string> = {
  visual: "Visual design",
  accessibility: "Accessibility",
  responsive: "Responsive",
  performance: "Performance",
  content: "Content",
  quality: "Implementation",
};

function suggestionsFor(config: SiteConfig): string[] {
  const out: string[] = [];
  const types = new Set(config.pages.flatMap((p) => p.sections.map((s) => s.type)));
  if (!types.has("testimonials")) out.push("Add a testimonials section (I'll leave it empty until you add real quotes).");
  if (!types.has("services")) out.push("Add a services section to explain what I offer.");
  if (!types.has("experience")) out.push("Add an experience timeline I can fill in.");
  if (config.motion.preset === "none" || !config.motion.enabled) out.push("Add subtle scroll reveals without hurting performance.");
  if (config.theme.typeScale === "intimate") out.push("Make the headings more commanding.");
  if (config.theme.density === "relaxed") out.push("Tighten the spacing for a denser, faster feel.");
  if (out.length < 3) out.push("Recommend a visual direction for my profession.");
  return out.slice(0, 4);
}

/** Human label for an extracted-character count ("1.2k chars"). */
function MATERIAL_CHAR_LABEL(chars: number): string {
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}k chars`;
  return `${chars} chars`;
}

function StepStatusIcon({ status }: { status: JobStepStatus }) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" aria-label="done" />;
    case "repaired":
      return <Wrench className="size-3.5 shrink-0 text-amber-500" aria-label="protected content restored" />;
    case "failed":
      return <XCircle className="size-3.5 shrink-0 text-destructive" aria-label="failed" />;
    case "skipped":
      return <MinusCircle className="size-3.5 shrink-0 text-muted-foreground" aria-label="skipped" />;
    case "running":
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-label="running" />;
    default:
      return <MinusCircle className="size-3.5 shrink-0 text-muted-foreground/50" aria-label="pending" />;
  }
}

function CheckIcon({ status }: { status: "pass" | "warn" | "fail" }) {
  if (status === "pass") return <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" aria-hidden />;
  if (status === "warn") return <AlertTriangle className="size-3.5 shrink-0 text-amber-500" aria-hidden />;
  return <XCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />;
}

export function CodeGiftzPanel({
  currentConfig,
  lastProposal,
  context,
  onProposal,
  onRunPreviewChecks,
  onOpenSection,
}: {
  currentConfig: SiteConfig;
  lastProposal: SiteConfig | null;
  context: CodeGiftzContext;
  onProposal: (proposal: CodeGiftzProposal | null) => void;
  /** REAL browser checks against the live canvas preview (owned by the
   *  builder, which owns the iframe). Absent → the browser-checks section
   *  is honestly omitted rather than faked. */
  onRunPreviewChecks?: () => Promise<BrowserCheck[]>;
  onOpenSection?: () => void;
}) {
  const { user, refresh } = useSession();
  const [request, setRequest] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [jobView, setJobView] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [approving, setApproving] = useState(false);
  const [siteContextOpen, setSiteContextOpen] = useState(false);
  const [browserChecks, setBrowserChecks] = useState<BrowserCheck[] | null>(null);
  const [checkingBrowser, setCheckingBrowser] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  // Two-workflow state: repair (default) vs create-from-my-materials.
  const [workflow, setWorkflow] = useState<Workflow>("fix");
  const [materials, setMaterials] = useState<SiteMaterialDTO[]>([]);
  const [materialsLoaded, setMaterialsLoaded] = useState(false);
  const [materialsBusy, setMaterialsBusy] = useState(false);
  const materialInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const lastRequestRef = useRef<{ text: string; mode: "edit" | "audit" | "create" } | null>(null);
  const consented = Boolean(user?.aiConsent);

  const busy = phase.k === "planning" || phase.k === "running" || phase.k === "auditing" || approving;
  const digest = useMemo(() => buildSiteDigest(currentConfig), [currentConfig]);
  const suggestions = useMemo(() => suggestionsFor(currentConfig), [currentConfig]);
  const contrastFails = digest.contrast.filter((c) => !c.aaLargePass).length;

  useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, phase]);

  function pushTurn(t: Turn) {
    setTurns((prev) => [...prev, t]);
  }

  // ---------------------------------------------- reconnect on mount
  // A refresh or tab switch must never orphan a running execution: pick up
  // the user's most recent job (ownership enforced server-side) and resume
  // polling or offer its review card. Jobs the user already dismissed are
  // not re-suggested.
  const resumeRef = useRef(false);
  useEffect(() => {
    if (resumeRef.current) return;
    resumeRef.current = true;
    let disposed = false;
    void (async () => {
      try {
        const res = await api<{ job: JobView | null }>("/api/ai/design/job");
        if (disposed || !res.job || dismissedJobs.has(res.job.id)) return;
        const job = res.job;
        if (job.status === "running" || job.status === "queued") {
          setJobView(job);
          setPhase({ k: "running", jobId: job.id, base: null, request: "(resumed execution)" });
          pushTurn({ role: "assistant", text: "Reconnected to your running Code Giftz execution.", kind: "execution" });
        } else if (job.config) {
          setPhase({ k: "review", job, base: job.baseConfig ?? null, request: "(resumed execution)" });
          pushTurn({ role: "assistant", text: "Your last Code Giftz execution finished — review it below.", kind: "execution" });
        }
      } catch {
        // No job / expired / offline — the panel simply starts idle.
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // ---------------------------------------------- execution polling
  const runningJobId = phase.k === "running" ? phase.jobId : null;
  useEffect(() => {
    if (!runningJobId) return;
    let disposed = false;
    let failures = 0;
    async function tick() {
      try {
        const res = await api<{ job: JobView }>(`/api/ai/design/job?id=${encodeURIComponent(runningJobId!)}`);
        if (disposed) return;
        failures = 0;
        setJobView(res.job);
        if (res.job.status !== "running" && res.job.status !== "queued") {
          setPhase((p) =>
            p.k === "running" && p.jobId === res.job.id
              ? { k: "review", job: res.job, base: res.job.baseConfig ?? p.base, request: p.request }
              : p
          );
          if (res.job.status === "completed") toast.success("Execution finished — review the changes below");
          else if (res.job.status === "cancelled") toast.info("Execution cancelled — completed steps are kept");
          else toast.error("Execution did not finish — see the details below");
        }
      } catch (e) {
        if (disposed) return;
        failures += 1;
        if (e instanceof Error && e.message.includes("404")) {
          setPhase({ k: "idle" });
          pushTurn({ role: "assistant", text: "The execution record expired before it finished. Ask me again and I'll redo the plan.", kind: "text" });
          return;
        }
        if (failures >= 5) {
          setPhase({ k: "idle" });
          pushTurn({ role: "assistant", text: "Lost contact with the execution. Your draft is unchanged — ask again to retry.", kind: "text" });
        }
      }
    }
    const timer = setInterval(() => void tick(), 1500);
    void tick();
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [runningJobId]);

  // ---------------------------------------------- consent
  async function enableConsent(next: boolean) {
    try {
      await api("/api/me/privacy", { method: "PATCH", json: { aiConsent: next } });
      await refresh();
      if (next) toast.success("Code Giftz design assistance enabled");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update AI consent");
    }
  }

  function stopPlanning() {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase({ k: "idle" });
  }

  // ---------------------------------------------- materials (create workflow)
  // Loaded lazily the first time the user switches to the create workflow.
  useEffect(() => {
    if (workflow !== "create" || materialsLoaded) return;
    setMaterialsLoaded(true);
    api<{ materials: SiteMaterialDTO[] }>("/api/me/site/materials")
      .then((r) => setMaterials(r.materials))
      .catch(() => setMaterials([]));
  }, [workflow, materialsLoaded]);

  /** Upload picked files through the standard media boundary, then register
   *  them as site materials (server-side extraction). */
  async function addMaterialFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setMaterialsBusy(true);
    try {
      const ids: string[] = [];
      let lastError: string | null = null;
      for (const f of Array.from(files).slice(0, 8)) {
        try {
          const res = await uploadFile(f);
          ids.push(res.media.id);
        } catch (e) {
          lastError = e instanceof Error ? e.message : "upload failed";
        }
      }
      if (ids.length === 0) {
        toast.error(lastError ?? "No files could be uploaded");
        return;
      }
      if (lastError) toast.warning(`Some files were skipped: ${lastError}`);
      const r = await api<{ materials: SiteMaterialDTO[]; described: number }>("/api/me/site/materials", {
        method: "POST",
        json: { mediaIds: ids },
      });
      setMaterials(r.materials);
      toast.success(`${ids.length} file${ids.length === 1 ? "" : "s"} added as source material${ids.length === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the materials");
    } finally {
      setMaterialsBusy(false);
      if (materialInputRef.current) materialInputRef.current.value = "";
    }
  }

  async function removeMaterial(id: string) {
    try {
      await api(`/api/me/site/materials?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setMaterials((prev) => prev.filter((m) => m.id !== id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the material");
    }
  }

  // ---------------------------------------------- PLAN (phase 1)
  async function submitPlan(text: string, wf: Workflow = "fix") {
    const trimmed = text.trim();
    if (trimmed.length < 3) {
      setError("Describe what you want (at least a few words).");
      return;
    }
    lastRequestRef.current = { text: trimmed, mode: wf === "create" ? "create" : "edit" };
    setError(null);
    setRequest("");
    pushTurn({ role: "user", text: wf === "create" ? `[Create my own website] ${trimmed}` : trimmed });
    setPhase({ k: "planning" });
    const controller = new AbortController();
    abortRef.current = controller;
    const history = turns.slice(-6).map((t) => ({ role: t.role, content: t.text.slice(0, 1000) }));
    try {
      const res = await api<
        | { kind: "plan"; plan: DesignPlan }
        | { kind: "reply"; reply: string; clarifyingQuestion: string | null }
        | { kind: "invalid"; reply: string; issues: { code: string; message: string; stepId?: string }[] }
      >("/api/ai/design/plan", {
        method: "POST",
        json: {
          request: trimmed,
          currentConfig,
          context,
          history,
          ...(wf === "create"
            ? { mode: "create" as const, materialIds: materials.map((m) => m.mediaId) }
            : {}),
        },
        signal: controller.signal,
      });
      if (res.kind === "plan") {
        pushTurn({ role: "assistant", text: res.plan.reply || "Here's my plan.", kind: "plan" });
        setPhase({
          k: "plan",
          plan: res.plan,
          base: currentConfig,
          request: trimmed,
          materialIds: wf === "create" ? materials.map((m) => m.mediaId) : [],
        });
      } else if (res.kind === "invalid") {
        pushTurn({
          role: "assistant",
          text: `I rejected my own plan before showing it to you — it failed validation against your current website:\n${res.issues
            .map((i) => `• ${i.message}`)
            .join("\n")}\nTry rephrasing, or run an audit first.`,
          kind: "text",
        });
        setPhase({ k: "idle" });
      } else {
        pushTurn({ role: "assistant", text: res.reply, kind: "text" });
        setPhase({ k: "idle" });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        pushTurn({ role: "assistant", text: "Stopped.", kind: "text" });
      } else {
        const message = e instanceof Error ? e.message : "Code Giftz is unavailable right now";
        setError(message);
        pushTurn({ role: "assistant", text: `Couldn't plan that: ${message}`, kind: "text" });
      }
      setPhase({ k: "idle" });
    } finally {
      abortRef.current = null;
    }
  }

  // ---------------------------------------------- EXECUTE (phase 2)
  async function approvePlan() {
    if (phase.k !== "plan") return;
    // The approval applies to the draft the plan was drawn against. If the
    // user edited since, the server would (correctly) reject — catch it here
    // with an actionable message instead.
    if (JSON.stringify(phase.base) !== JSON.stringify(currentConfig)) {
      pushTurn({
        role: "assistant",
        text: "Your draft changed since this plan was drawn up, so I discarded it. Ask me again and I'll re-plan against the current draft.",
        kind: "text",
      });
      setPhase({ k: "idle" });
      return;
    }
    setApproving(true);
    setError(null);
    const { plan, base, request: req, materialIds } = phase;
    try {
      const res = await api<{ jobId: string; status: string }>("/api/ai/design/execute", {
        method: "POST",
        json: { plan, currentConfig: base, materialIds },
      });
      setJobView(null);
      setPhase({ k: "running", jobId: res.jobId, base, request: req });
      pushTurn({ role: "assistant", text: `Approved — executing ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}. You can cancel any time.`, kind: "execution" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "The execution could not start";
      setError(message);
      toast.error(message);
    } finally {
      setApproving(false);
    }
  }

  // ---------------------------------------------- job controls
  async function cancelJob() {
    if (phase.k !== "running") return;
    setCancelling(true);
    try {
      await api("/api/ai/design/job", { method: "POST", json: { jobId: phase.jobId, action: "cancel" } });
      toast.info("Cancellation requested — stops at the end of the current step");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not cancel the execution");
    } finally {
      setCancelling(false);
    }
  }

  async function retryJob() {
    if (phase.k !== "review") return;
    const { job, base, request } = phase;
    try {
      await api("/api/ai/design/job", { method: "POST", json: { jobId: job.id, action: "retry" } });
      setJobView(null);
      setPhase({ k: "running", jobId: job.id, base: base ?? job.baseConfig ?? currentConfig, request });
      pushTurn({ role: "assistant", text: "Retrying the failed steps — completed steps stay untouched.", kind: "execution" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not retry the execution");
    }
  }

  // ---------------------------------------------- review → canvas proposal
  // The proposal goes onto the canvas (preview-before-apply, unchanged), and
  // — because a REAL preview is now visible — the review card stays open and
  // runs the browser preview checks against it.
  function previewOnCanvas() {
    if (phase.k !== "review") return;
    const { job, base, request } = phase;
    const baseConfig = base ?? job.baseConfig ?? null;
    if (!job.config || !baseConfig) {
      toast.error("The result configuration is missing — discard this result and ask again.");
      return;
    }
    onProposal({
      request: request === "(resumed execution)" ? job.reply || "Code Giftz execution" : request,
      config: job.config,
      changes: job.changes.length > 0 ? job.changes : ["Adjusted the website configuration."],
      reply: job.reply || "Execution finished — preview the result on the canvas.",
      baseConfig,
    });
    dismissedJobs.add(job.id);
    setPreviewed(true);
    pushTurn({ role: "assistant", text: "The result is on the canvas — accept it there to apply it as a draft. Running the browser preview checks now…", kind: "proposal" });
    void runBrowserChecks();
  }

  /** REAL browser checks (overflow, assets, runtime, render) against the
   *  live canvas preview — measured by the builder's iframe, never faked. */
  function runBrowserChecks() {
    if (!onRunPreviewChecks || checkingBrowser) return;
    setCheckingBrowser(true);
    setBrowserChecks(null);
    void (async () => {
      try {
        setBrowserChecks(await onRunPreviewChecks());
      } catch (e) {
        setBrowserChecks([
          {
            id: "browser-error",
            label: "Checks (browser)",
            status: "warn",
            detail: e instanceof Error ? e.message : "The browser checks could not run in this preview.",
          },
        ]);
      } finally {
        setCheckingBrowser(false);
      }
    })();
  }

  // Review state (proposal previewed / browser checks) only belongs to the
  // current review — reset whenever the panel leaves the review phase.
  useEffect(() => {
    if (phase.k !== "review") {
      setPreviewed(false);
      setBrowserChecks(null);
      setCheckingBrowser(false);
    }
  }, [phase.k]);

  function hideReview() {
    if (phase.k !== "review") return;
    dismissedJobs.add(phase.job.id);
    if (previewed) {
      pushTurn({ role: "assistant", text: "The proposal preview stays on the canvas — accept it from the banner (or undo from there).", kind: "text" });
    } else {
      pushTurn({ role: "assistant", text: "Discarded — your draft was never touched by this run.", kind: "text" });
    }
    setPhase({ k: "idle" });
  }

  // ---------------------------------------------- AUDIT
  async function submitAudit(text: string) {
    const trimmed = text.trim() || AUDIT_EXAMPLES[0];
    if (trimmed.length < 3) return;
    lastRequestRef.current = { text: trimmed, mode: "audit" };
    setError(null);
    setRequest("");
    pushTurn({ role: "user", text: trimmed, kind: "audit" });
    setPhase({ k: "auditing" });
    const controller = new AbortController();
    abortRef.current = controller;
    const history = turns.slice(-6).map((t) => ({ role: t.role, content: t.text.slice(0, 1000) }));
    try {
      const res = await api<{ reply: string; findings: AuditFinding[] }>("/api/ai/design/audit", {
        method: "POST",
        json: {
          request: trimmed,
          currentConfig,
          context,
          history,
          // Real measured evidence from the last browser check run — the audit
          // must not contradict what the preview actually showed.
          ...(browserChecks ? { browserEvidence: browserChecks } : {}),
        },
        signal: controller.signal,
      });
      const findings = (res.findings ?? []).filter((f) => f && f.finding);
      pushTurn({
        role: "assistant",
        text: [res.reply, findings.length ? `(${findings.length} finding${findings.length === 1 ? "" : "s"} — details below)` : ""]
          .filter(Boolean)
          .join(" "),
        kind: "audit",
      });
      setPhase({ k: "audit", reply: res.reply, findings });
      toast.success("Audit complete — nothing was changed");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        pushTurn({ role: "assistant", text: "Stopped.", kind: "text" });
      } else {
        const message = e instanceof Error ? e.message : "Code Giftz is unavailable right now";
        setError(message);
        pushTurn({ role: "assistant", text: `Couldn't audit: ${message}`, kind: "text" });
      }
      setPhase({ k: "idle" });
    } finally {
      abortRef.current = null;
    }
  }

  /** Compose an edit request from the top audit findings — the user still
   *  reviews the plan before anything runs. */
  function planFixesFromAudit() {
    if (phase.k !== "audit") return;
    const top = phase.findings.slice(0, 2).map((f) => f.suggestion || f.finding).join("; ");
    if (!top) return;
    setRequest(`Fix the top audit findings: ${top}`);
    setPhase({ k: "idle" });
  }

  // ------------------------------------------------------------ consent gate
  if (!consented) {
    return (
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Telescope className="size-4 text-primary" aria-hidden />
          <p className="text-sm font-medium">Code Giftz</p>
        </div>
        <p className="text-sm text-muted-foreground">
          Code Giftz is the website-engineering agent for Website Studio, powered by BEAN Intelligence. With
          your consent it can FIX your current website from a plain-language description (planned as reviewable
          steps, verified, previewed on the canvas before anything applies) or CREATE your own personalized
          website from the materials you upload — PDFs, text documents, images and more — without forcing a
          preset template. It runs on the shared server-side AI provider, never publishes anything, and
          reports unsupported actions honestly.
        </p>
        <div className="flex items-center gap-2">
          <Switch id="giftz-consent" checked={false} onCheckedChange={(v) => void enableConsent(v)} aria-label="Enable Code Giftz design assistance" />
          <Label htmlFor="giftz-consent" className="text-sm">
            Enable Code Giftz design assistance
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">You can also manage this in Trust &amp; settings.</p>
      </div>
    );
  }

  // ------------------------------------------------------------ main panel
  const doneSteps = jobView ? jobView.steps.filter((s) => s.status === "done" || s.status === "repaired").length : 0;
  const totalSteps = jobView ? jobView.steps.length : 0;

  return (
    <div ref={historyRef} className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain" style={{ scrollbarWidth: "thin" }}>
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <Telescope className="size-4 text-primary" aria-hidden />
        <p className="text-sm font-medium">Code Giftz</p>
        <span className="ml-auto rounded-full bg-gold-soft px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
          Preview only
        </span>
      </div>

      {/* context — computed from the REAL config, same digest the server grounds on */}
      <div className="border-b border-border/60 px-4 py-2">
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground" title={`Template: ${digest.template}`}>
            {digestSummaryLine(digest)}
          </span>
          <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground">
            {context.device} preview
          </span>
          {context.pageName && (
            <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground">
              page: {context.pageName}
            </span>
          )}
          {context.sectionType && (
            <button
              type="button"
              onClick={onOpenSection}
              className="rounded-full border border-primary/40 bg-gold-soft/40 px-2 py-0.5 text-[10px] text-primary"
              title="Open the selected section in the content editor"
            >
              editing: {context.sectionTitle || context.sectionType}
            </button>
          )}
          {contrastFails > 0 && (
            <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive" title="WCAG contrast pairs below AA-large">
              {contrastFails} contrast issue{contrastFails === 1 ? "" : "s"}
            </span>
          )}
          {digest.warnings.length > 0 && (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-500" title={digest.warnings.join(" · ")}>
              {digest.warnings.length} site warning{digest.warnings.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <Collapsible open={siteContextOpen} onOpenChange={setSiteContextOpen} className="mt-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground">
            <ChevronDown className={cn("size-3 transition-transform", siteContextOpen && "rotate-180")} aria-hidden />
            Site structure
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto overscroll-contain rounded-md border border-border/50 bg-background/50 p-2" style={{ scrollbarWidth: "thin" }}>
              {digest.pages.map((p) => (
                <div key={p.id}>
                  <p className={cn("text-[10px] font-medium", p.visible ? "text-foreground" : "text-muted-foreground line-through")}>
                    {p.name}
                  </p>
                  <ul className="ml-2">
                    {p.sections.map((s) => (
                      <li key={s.id} className={cn("text-[10px] text-muted-foreground", !s.visible && "line-through")}>
                        {s.type} · {s.title}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* conversation history — plain flow inside the panel's single scroll
          container (the root): no inner scroll box, no nested scrollbar. */}
      <div className="space-y-3 px-4 py-3">
        {turns.length === 0 && (
          <div className="space-y-2 text-xs text-muted-foreground">
            {workflow === "fix" ? (
              <>
                <p>
                  Describe what&apos;s wrong or what to improve — overlapping elements, spacing, alignment,
                  responsiveness, broken images or links, readability. I&apos;ll inspect your site, return a
                  reviewable plan of the smallest concrete steps, run it only after you approve it, verify the
                  result, and put it on the canvas as a preview. Your draft is only touched when you accept.
                </p>
                <p className="text-[11px] opacity-80">
                  Constraints are honored mechanically — say “keep the rest of my website unchanged” and every
                  region you didn&apos;t mention is restored byte-identically if a step drifts. General
                  (non-design) questions belong to RIISHE in BEAN Intelligence.
                </p>
              </>
            ) : (
              <>
                <p>
                  Build a website that is truly yours: upload your materials (resume, PDFs, text documents,
                  images and more), describe the website you want — layout, colors, typography, sections,
                  style — and I&apos;ll compose a complete custom site around YOUR content. No preset template
                  required. You preview, refine conversationally, then accept it as your draft.
                </p>
                <p className="text-[11px] opacity-80">
                  Your materials stay private to your account and are only used to generate your site. Content
                  is derived from what you provide — nothing is invented.
                </p>
              </>
            )}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={cn("flex", t.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[92%] whitespace-pre-wrap rounded-xl px-3 py-2 text-xs leading-relaxed",
                t.role === "user"
                  ? "bg-gold-soft/50 text-foreground"
                  : t.kind === "audit"
                    ? "border border-primary/30 bg-background/60"
                    : t.kind === "plan" || t.kind === "execution"
                      ? "border border-primary/20 bg-primary/5"
                      : "bg-muted/60"
              )}
            >
              {t.kind === "audit" && (
                <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  <ScanSearch className="size-3" aria-hidden /> Audit
                </p>
              )}
              {t.kind === "plan" && (
                <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  <ClipboardList className="size-3" aria-hidden /> Plan
                </p>
              )}
              {t.kind === "execution" && (
                <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  <Play className="size-3" aria-hidden /> Execution
                </p>
              )}
              {t.kind === "proposal" && (
                <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  <Sparkles className="size-3" aria-hidden /> Proposal on canvas
                </p>
              )}
              {t.text}
            </div>
          </div>
        ))}
        {(phase.k === "planning" || phase.k === "auditing") && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {phase.k === "planning" ? "Code Giftz is analyzing your site and drafting a plan…" : "Code Giftz is auditing your site…"}
          </div>
        )}
      </div>

      {/* phase card */}
      {(phase.k === "plan" || phase.k === "running" || phase.k === "review" || phase.k === "audit") && (
        <div className="max-h-[46vh] shrink-0 overflow-y-auto border-t border-border/60 px-4 py-3" style={{ scrollbarWidth: "thin" }}>
          {/* ---------- PLAN CARD ---------- */}
          {phase.k === "plan" && (
            <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                <ClipboardList className="size-3.5" aria-hidden /> Implementation plan · {phase.plan.steps.length} step{phase.plan.steps.length === 1 ? "" : "s"}
              </p>
              {phase.plan.notes && <p className="text-[11px] leading-relaxed text-muted-foreground">{phase.plan.notes}</p>}
              <ol className="space-y-2">
                {phase.plan.steps.map((s, i) => (
                  <li key={s.id} className="rounded-md border border-border/60 bg-background/60 p-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-bold text-muted-foreground">{i + 1}.</span>
                      <p className="min-w-0 flex-1 truncate text-[11px] font-medium">{s.title}</p>
                      <Badge variant="outline" className="px-1 py-0 text-[9px] uppercase">
                        {KIND_LABEL[s.kind] ?? s.kind}
                      </Badge>
                      {s.risk !== "low" && (
                        <span className={cn("text-[9px] font-semibold uppercase", s.risk === "high" ? "text-destructive" : "text-amber-600 dark:text-amber-500")}>
                          {s.risk}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{s.summary}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="rounded bg-muted/70 px-1 py-0.5 font-mono text-[9px] text-muted-foreground">{s.tool}</span>
                      {s.targets.slice(0, 3).map((t) => (
                        <span key={t} className="max-w-[120px] truncate rounded bg-gold-soft/40 px-1 py-0.5 text-[9px] text-primary" title={t}>
                          {t}
                        </span>
                      ))}
                      {s.dependsOn.length > 0 && (
                        <span className="text-[9px] text-muted-foreground">after: {s.dependsOn.join(", ")}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {phase.plan.constraints.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {phase.plan.constraints.map((c, i) => (
                    <span key={i} className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[9px] text-emerald-700 dark:text-emerald-500" title={`Protected: ${c.targets.join(", ")}`}>
                      <ShieldCheck className="mr-0.5 inline size-2.5" aria-hidden />
                      keep: {c.text}
                    </span>
                  ))}
                </div>
              )}
              {error && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
              <div className="flex gap-2">
                <Button size="sm" className="flex-1" onClick={() => void approvePlan()} disabled={approving || busy}>
                  {approving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
                  Approve &amp; run
                </Button>
                <Button size="sm" variant="outline" onClick={() => { pushTurn({ role: "assistant", text: "Plan discarded — nothing ran.", kind: "text" }); setPhase({ k: "idle" }); }} disabled={approving}>
                  Discard
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Nothing executes until you approve. Deterministic steps apply exact token values; content
                steps run per-step through the validated site schema.
              </p>
            </div>
          )}

          {/* ---------- RUNNING CARD ---------- */}
          {phase.k === "running" && (
            <div className="space-y-3 rounded-lg border border-border/70 bg-background/60 p-3">
              <div className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
                <p className="text-xs font-semibold">Executing…</p>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {doneSteps}/{totalSteps} steps
                </span>
              </div>
              <Progress value={totalSteps > 0 ? (doneSteps / totalSteps) * 100 : 5} className="h-1.5" aria-label="Execution progress" />
              <ol className="space-y-1.5">
                {(jobView?.steps ?? []).map((s, i) => (
                  <li key={s.id} className="flex items-start gap-2">
                    <StepStatusIcon status={s.status} />
                    <div className="min-w-0 flex-1">
                      <p className={cn("truncate text-[11px]", s.status === "pending" ? "text-muted-foreground" : "font-medium")}>
                        {i + 1}. {s.title}
                      </p>
                      {s.error && <p className="text-[10px] text-destructive">{s.error}</p>}
                      {s.changes.length > 0 && (s.status === "done" || s.status === "repaired") && (
                        <p className="truncate text-[10px] text-muted-foreground" title={s.changes.join(" · ")}>
                          {s.changes[0]}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              <Button size="sm" variant="outline" className="w-full" onClick={() => void cancelJob()} disabled={cancelling}>
                <Square className="size-3.5" aria-hidden /> {cancelling ? "Cancelling…" : "Cancel execution"}
              </Button>
              <p className="text-[10px] text-muted-foreground">
                Cancellation is cooperative — the current step finishes, everything after it is skipped.
                Your draft is untouched until you accept the result on the canvas.
              </p>
            </div>
          )}

          {/* ---------- REVIEW CARD ---------- */}
          {phase.k === "review" && (
            <div className="space-y-3 rounded-lg border border-border/70 bg-background/60 p-3">
              <div className="flex items-center gap-2">
                {phase.job.status === "completed" ? (
                  <CheckCircle2 className="size-4 text-emerald-500" aria-hidden />
                ) : phase.job.status === "cancelled" ? (
                  <MinusCircle className="size-4 text-muted-foreground" aria-hidden />
                ) : (
                  <XCircle className="size-4 text-destructive" aria-hidden />
                )}
                <p className="text-xs font-semibold">
                  {phase.job.status === "completed"
                    ? "Execution complete"
                    : phase.job.status === "cancelled"
                      ? "Execution cancelled"
                      : "Execution failed"}
                </p>
              </div>

              {phase.job.error && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                  {phase.job.error}
                </p>
              )}

              {phase.job.constraints.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {phase.job.constraints.map((c, i) => (
                    <span key={i} className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[9px] text-emerald-700 dark:text-emerald-500" title={`Protected: ${c.targets.join(", ")}`}>
                      <ShieldCheck className="mr-0.5 inline size-2.5" aria-hidden />
                      kept: {c.text}
                    </span>
                  ))}
                </div>
              )}

              {phase.job.verification && (
                <div className="space-y-1.5 rounded-md border border-border/60 p-2">
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <ShieldCheck className="size-3" aria-hidden /> Verification
                    <span className="ml-auto font-normal normal-case">
                      {phase.job.verification.passed} passed · {phase.job.verification.warned} warnings
                      {phase.job.verification.failed > 0 ? ` · ${phase.job.verification.failed} failed` : ""}
                    </span>
                  </p>
                  <ul className="space-y-1">
                    {phase.job.verification.checks.map((c) => (
                      <li key={c.id} className="flex items-start gap-1.5">
                        <CheckIcon status={c.status} />
                        <div className="min-w-0">
                          <p className="text-[10px] font-medium">{c.label}</p>
                          <p className="text-[10px] leading-snug text-muted-foreground">{c.detail}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {phase.job.verification.untested.length > 0 && (
                    <div className="border-t border-border/50 pt-1.5">
                      <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                        <Info className="size-2.5" aria-hidden /> Not verified here
                      </p>
                      <ul className="ml-3 list-disc">
                        {phase.job.verification.untested.map((u) => (
                          <li key={u} className="text-[10px] text-muted-foreground">{u}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* ---------- REAL browser preview checks (measured, never faked) ---------- */}
              {(checkingBrowser || browserChecks) && (
                <div className="space-y-1.5 rounded-md border border-border/60 p-2">
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <MonitorSmartphone className="size-3" aria-hidden /> Browser preview checks
                    {checkingBrowser ? (
                      <Loader2 className="size-3 animate-spin" aria-hidden />
                    ) : (
                      <span className="ml-auto font-normal normal-case">{context.device} viewport</span>
                    )}
                  </p>
                  {browserChecks && (
                    <ul className="space-y-1">
                      {browserChecks.map((c) => (
                        <li key={c.id} className="flex items-start gap-1.5">
                          <CheckIcon status={c.status} />
                          <div className="min-w-0">
                            <p className="text-[10px] font-medium">{c.label}</p>
                            <p className="text-[10px] leading-snug text-muted-foreground">{c.detail}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-[9px] leading-snug text-muted-foreground">
                    Measured on the live canvas preview{context.device ? ` at the ${context.device} viewport` : ""}. Switch the device selector and re-run to check another width.
                  </p>
                </div>
              )}

              {phase.job.changes.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Changes ({phase.job.changes.length})</p>
                  <ul className="ml-3 mt-1 max-h-24 list-disc space-y-0.5 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
                    {phase.job.changes.slice(0, 12).map((c, i) => (
                      <li key={i} className="text-[10px] leading-snug text-muted-foreground">{c}</li>
                    ))}
                  </ul>
                </div>
              )}

              {previewed && (
                <p className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[10px] leading-snug text-muted-foreground">
                  {lastProposal
                    ? "The proposal is previewing on the canvas — accept it from the banner (history-tracked, undoable) or keep editing; nothing is saved until you say so."
                    : "The proposal left the canvas — if you accepted it, it's in your draft history (undo/redo from the toolbar)."}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                {(phase.job.status === "completed" || phase.job.status === "cancelled") && phase.job.config && !previewed && (
                  <Button size="sm" className="flex-1" onClick={previewOnCanvas}>
                    <Eye className="size-4" aria-hidden /> Preview on canvas
                  </Button>
                )}
                {previewed && onRunPreviewChecks && (
                  <Button size="sm" variant="outline" className="flex-1" onClick={runBrowserChecks} disabled={checkingBrowser}>
                    {checkingBrowser ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <MonitorSmartphone className="size-4" aria-hidden />}
                    Re-run browser checks
                  </Button>
                )}
                {phase.job.status === "failed" && (
                  <Button size="sm" className="flex-1" onClick={() => void retryJob()}>
                    <RotateCcw className="size-4" aria-hidden /> Retry failed steps
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={hideReview}>
                  {previewed ? "Hide this card" : "Discard"}
                </Button>
              </div>
            </div>
          )}

          {/* ---------- AUDIT CARD ---------- */}
          {phase.k === "audit" && (
            <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                <ScanSearch className="size-3.5" aria-hidden /> Audit findings · {phase.findings.length}
              </p>
              {phase.reply && <p className="text-[11px] leading-relaxed text-muted-foreground">{phase.reply}</p>}
              <ul className="space-y-2">
                {phase.findings.map((f, i) => (
                  <li key={i} className="rounded-md border border-border/60 bg-background/60 p-2">
                    <div className="flex items-center gap-1.5">
                      <Badge variant={f.severity === "high" ? "destructive" : f.severity === "medium" ? "default" : "secondary"} className="px-1 py-0 text-[9px] uppercase">
                        {f.severity}
                      </Badge>
                      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{AREA_LABEL[f.area] ?? f.area}</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed">{f.finding}</p>
                    {f.evidence && <p className="mt-0.5 text-[10px] italic leading-snug text-muted-foreground">Evidence: {f.evidence}</p>}
                    {f.suggestion && <p className="mt-0.5 text-[10px] leading-snug text-primary">Fix: {f.suggestion}</p>}
                  </li>
                ))}
                {phase.findings.length === 0 && <li className="text-[11px] text-muted-foreground">No specific findings — the checks that ran came back clean.</li>}
              </ul>
              {phase.findings.length > 0 && (
                <Button size="sm" variant="outline" className="w-full" onClick={planFixesFromAudit}>
                  <ClipboardList className="size-3.5" aria-hidden /> Draft a fix plan for the top findings
                </Button>
              )}
              <p className="text-[10px] text-muted-foreground">Audits never change anything. Fixes run only after you approve a plan.</p>
            </div>
          )}
        </div>
      )}

      {/* suggestions — workflow-aware quick starts */}
      {turns.length === 0 && phase.k === "idle" && workflow === "fix" && (
        <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-4 pt-2">
          {[...FIX_EXAMPLES.slice(0, 3), ...suggestions.slice(0, 2), ...EDIT_EXAMPLES.slice(1, 2)].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void submitPlan(s, "fix")}
              className="max-w-full truncate rounded-full border border-border/70 bg-background/60 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* input */}
      <div className="space-y-2 border-t border-border/60 p-4">
        {error && phase.k !== "plan" && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}

        {/* workflow switch — FIX the current website vs CREATE from my materials */}
        <div className="flex items-center gap-1 rounded-lg border border-border/70 bg-background/60 p-0.5" role="tablist" aria-label="Code Giftz workflow">
          <button
            type="button"
            role="tab"
            aria-selected={workflow === "fix"}
            onClick={() => setWorkflow("fix")}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors",
              workflow === "fix" ? "bg-gold-soft/60 text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Wrench className="size-3.5" aria-hidden /> Fix existing website
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={workflow === "create"}
            onClick={() => setWorkflow("create")}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors",
              workflow === "create" ? "bg-gold-soft/60 text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Sparkles className="size-3.5" aria-hidden /> Create my own website
          </button>
        </div>

        {/* materials — the create workflow's content basis */}
        {workflow === "create" && (
          <div className="rounded-lg border border-border/70 bg-background/40 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-[11px] font-medium">
                <Paperclip className="size-3.5 text-primary" aria-hidden /> Source materials
                <span className="font-normal text-muted-foreground">({materials.length}/12)</span>
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={() => materialInputRef.current?.click()}
                disabled={materialsBusy || materials.length >= 12}
              >
                {materialsBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <FilePlus2 className="size-3.5" aria-hidden />}
                Add files
              </Button>
              <input
                ref={materialInputRef}
                type="file"
                multiple
                accept={MATERIAL_ACCEPT}
                className="hidden"
                onChange={(e) => void addMaterialFiles(e.target.files)}
                aria-label="Upload source materials"
              />
            </div>
            {materials.length > 0 ? (
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto overscroll-contain" style={{ scrollbarWidth: "thin" }}>
                {materials.map((m) => (
                  <li key={m.id} className="flex items-start gap-1.5 rounded-md border border-border/50 px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-medium" title={m.label}>
                        {m.label}
                      </p>
                      <p className="text-[10px] leading-snug text-muted-foreground">
                        {m.extractStatus === "READY"
                          ? m.meta.truncated
                            ? `Text extracted (${MATERIAL_CHAR_LABEL(m.chars)}+, truncated)`
                            : `Text extracted (${MATERIAL_CHAR_LABEL(m.chars)})`
                          : m.extractStatus === "FAILED"
                            ? "Could not be read"
                            : m.kind === "IMAGE"
                              ? m.meta.description
                                ? "Image catalogued + described"
                                : "Image catalogued"
                              : m.kind === "VIDEO" || m.kind === "AUDIO"
                                ? "Stored — content not analyzed"
                                : "Stored — nothing extractable"}
                        {m.meta.description && m.extractStatus !== "READY" ? ` — ${m.meta.description.slice(0, 90)}` : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void removeMaterial(m.id)}
                      className="mt-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Remove ${m.label} from source materials`}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
                PDFs, resumes, text documents, images (usable as logo/cover), videos and more. Everything stays
                private to your account. Videos and audio are stored but not transcribed — say so in your
                description if they matter.
              </p>
            )}
          </div>
        )}

        <Textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          maxLength={1000}
          placeholder={
            workflow === "create"
              ? "Describe the website you want — layout, colors, typography, sections, style… (e.g. “A minimal dark one-page site: big hero with my name, my projects below, then experience and contact”)"
              : "e.g. Fix the overlapping text in the hero, keep the rest of my website unchanged…"
          }
          className="min-h-20"
          aria-label={workflow === "create" ? "Describe the website you want Code Giftz to create" : "Design request for Code Giftz"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) {
              e.preventDefault();
              void submitPlan(request, workflow);
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          {workflow === "fix" ? (
            <>
              <Button size="sm" className="flex-1" onClick={() => void submitPlan(request, "fix")} disabled={busy}>
                {phase.k === "planning" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
                Plan changes
              </Button>
              <Button size="sm" variant="outline" onClick={() => void submitAudit(request)} disabled={busy} title="Evidence-based audit — findings only, nothing changes">
                <ScanSearch className="size-4" aria-hidden /> Audit
              </Button>
            </>
          ) : (
            <Button size="sm" className="flex-1" onClick={() => void submitPlan(request, "create")} disabled={busy}>
              {phase.k === "planning" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
              Plan my website
            </Button>
          )}
          {(phase.k === "planning" || phase.k === "auditing") && (
            <Button size="sm" variant="ghost" onClick={stopPlanning}>
              <Square className="size-3.5" aria-hidden /> Stop
            </Button>
          )}
          {!busy && lastRequestRef.current && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                lastRequestRef.current!.mode === "audit"
                  ? void submitAudit(lastRequestRef.current!.text)
                  : void submitPlan(lastRequestRef.current!.text, lastRequestRef.current!.mode === "create" ? "create" : "fix")
              }
              title="Retry the last request"
            >
              <RotateCcw className="size-3.5" aria-hidden /> Retry
            </Button>
          )}
        </div>
        {lastProposal && (
          <Button size="sm" variant="ghost" className="w-full" onClick={() => onProposal(null)} disabled={busy}>
            Clear proposal preview
          </Button>
        )}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {workflow === "create"
            ? "BEAN Intelligence composes your site from your materials and vision — one reviewable plan, validated against the site schema, previewed on the canvas before you accept. Refine afterwards by switching back to Fix."
            : "Runs on the BEAN Intelligence gateway (server-side), quota shared with RIISHE chat. Plans are validated against the real site before you see them; execution is step-by-step, verifiable and reversible on the canvas."}
        </p>
      </div>
    </div>
  );
}
