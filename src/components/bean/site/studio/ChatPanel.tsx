"use client";

/**
 * ChatPanel — the studio's conversational coding zone (left column).
 *
 * Talks to the site-studio backend:
 *   GET/POST  /api/me/site/studio/sessions            — thread list / create
 *   GET/PATCH/DELETE /api/me/site/studio/sessions/[id] — thread + messages / rename / delete
 *   POST      /api/me/site/studio/sessions/[id]/messages — start one turn (202 + taskId)
 *   GET       /api/me/site/studio/turns/[taskId]       — poll the running turn
 *
 * One user message = one turn = the REAL plan→execute pipeline. Every
 * assistant message lands in exactly one honest state: PENDING (queued),
 * RUNNING (stage from meta), DONE (plain reply OR proposal with a changed-file
 * inventory) or FAILED (user-safe error — never a fake success).
 *
 * A proposal is an ISOLATED working copy: "Preview changes" hands the config
 * to the parent so the center iframe renders it without touching the draft
 * or the published site. Nothing is saved until the user explicitly saves.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  FilePlus2,
  FileMinus2,
  FilePen,
  FolderGit2,
  Gauge,
  History,
  Loader2,
  MessageSquarePlus,
  Palette,
  Pencil,
  PenLine,
  RotateCcw,
  Send,
  Settings2,
  ShieldAlert,
  TriangleAlert,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { GiftzPrefs } from "./prefs";
import { api } from "@/lib/client";
import { normalizeConfig, type SiteConfig } from "@/lib/site-config";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------ types

export interface StudioChangedFile {
  path: string;
  action: "modified" | "added" | "removed";
  summary: string;
}

/** Shape stored on the ASSISTANT message (proposalJson) — see lib/site-studio/turn.ts. */
export interface StudioProposal {
  config: SiteConfig;
  changedFiles: StudioChangedFile[];
  summary: string;
  verification: unknown;
  jobId: string;
  planNotes: string;
  baseConfigHash: string;
  /**
   * Additive, OPTIONAL design-quality report (pipeline "reviewing" stage).
   * Absent on every pre-quality proposal — nothing may render without it.
   */
  quality?: StudioQuality | null;
}

/** Palette half of the creative-direction block (hex color strings). */
export interface StudioDirectionPalette {
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  accent: string;
  accent2: string;
  gradient?: string | null;
}

/** One per-section visual direction entry ("Hero — full-bleed cover"). */
export interface StudioDirectionSectionPlanEntry {
  section: string;
  direction: string;
}

/**
 * Additive, OPTIONAL creative-direction block (pipeline "directing" stage,
 * stored on the assistant message metaJson). Absent on every pre-direction
 * message — nothing may render without it.
 */
export interface StudioDirection {
  designLanguage: string;
  designLanguageLabel: string;
  concept: string;
  palette: StudioDirectionPalette;
  typography: { heading: string; body: string; accent: string; note: string };
  motionLanguage: string;
  layoutStrategy: string;
  heroComposition: string;
  responsiveStrategy: string;
  sectionPlan: StudioDirectionSectionPlanEntry[];
}

/** One scored quality dimension ("Layout balance 92"). */
export interface StudioQualityDimension {
  id: string;
  label: string;
  score: number;
}

/** One quality finding with a user-facing repair suggestion. */
export interface StudioQualityFinding {
  severity: "high" | "medium" | "low";
  area: string;
  finding: string;
  suggestion: string;
}

/** Additive, OPTIONAL design-quality report (see StudioProposal.quality). */
export interface StudioQuality {
  overall: number;
  verdict: "strong" | "acceptable" | "needs-repair";
  summary: string;
  dimensions: StudioQualityDimension[];
  findings: StudioQualityFinding[];
  reviewedBy: string;
}

export type StudioMessageStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED";

export interface StudioChatMessage {
  id: string;
  role: "USER" | "ASSISTANT";
  text: string;
  status: StudioMessageStatus;
  error: string | null;
  taskId: string | null;
  createdAt: string;
  proposal: StudioProposal | null;
  meta: {
    stage?: string;
    replyOnly?: boolean;
    mode?: string;
    /** Partial-preservation / retry bookkeeping (execute-partial turns). */
    jobId?: string;
    completedSteps?: number;
    totalSteps?: number;
    retried?: boolean;
    /** Additive, OPTIONAL creative-direction block (see StudioDirection). */
    direction?: StudioDirection | null;
  } | null;
}

export interface StudioSessionSummary {
  id: string;
  title: string;
  /** Conversation target — the product boundary (portfolio vs GIFTZ). */
  targetKind?: string;
  targetSiteId?: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** Which product a studio conversation belongs to (and may modify). */
export interface ChatSessionTarget {
  kind: "portfolio" | "giftz";
  /** GiftzSite id for giftz sessions; null = "generate a brand-new site". */
  siteId?: string | null;
}

export interface ChatPanelProps {
  /** The builder's current draft state — sent with every turn. */
  currentConfig: SiteConfig;
  /** Studio context for plan grounding. */
  context: { device: string; pageName: string | null; sectionType?: string | null; sectionTitle?: string | null };
  /** Render a finished proposal's config in the isolated center preview. */
  onPreviewProposal: (proposal: StudioProposal, messageId: string, opts?: { auto?: boolean }) => void;
  /** Message id currently rendered in the proposal preview (drives the card state). */
  activeProposalMessageId?: string | null;
  disabled?: boolean;
  /**
   * CODE GIFTZ preview preference: render a finished proposal in the Preview
   * workspace automatically when its turn completes (the user can still
   * preview/re-request changes from the card). Default false — callers that
   * read the persisted CODE GIFTZ prefs pass the real value.
   */
  autoPreviewProposals?: boolean;
  /** CODE GIFTZ workspace settings (independent of Customization settings).
   * The full GiftzPrefs shape — chat, preview, validation and draft-safety
   * preferences all live here and nowhere else. */
  giftzSettings?: GiftzPrefs;
  onGiftzSettingsChange?: (next: GiftzPrefs) => void;
  /**
   * The product target every NEW conversation is bound to. When absent the
   * server default ("portfolio") applies — matching the historic behavior.
   * GIFTZ sessions pass { kind: "giftz", siteId } so their turns plan
   * against the GiftzSite's own saved config and never the portfolio draft.
   */
  sessionTarget?: ChatSessionTarget;
  /** Only list conversations bound to this product (omitted = all). */
  sessionsTargetFilter?: "portfolio" | "giftz";
}

/**
 * Composer limit — long, detailed website-generation prompts are a first-class
 * use case (pasted briefs, structured specs, Markdown outlines). Kept in
 * lockstep with the API schema (messages route: text.max(50_000)) and the
 * turn persistence (site-studio/turn.ts) — the SAME limit everywhere, so a
 * prompt accepted by the composer is never truncated downstream.
 */
const COMPOSER_MAX = 50_000;
/** Warn (amber counter) once the composer is within this many chars of the cap. */
const COMPOSER_WARN_WINDOW = 1_000;
const POLL_MS = 1500;

const STAGE_LABELS: Record<string, string> = {
  queued: "Queued — waiting for the engine…",
  planning: "Planning changes…",
  directing: "Reading the brief — building a creative direction…",
  executing: "Applying changes…",
  "executing-retry": "Retrying the failed step — completed steps stay untouched…",
  reviewing: "Reviewing design quality…",
  polishing: "Polishing — repairing quality findings…",
};

function stageOf(m: StudioChatMessage): string | null {
  const stage = m.meta?.stage;
  if (!stage) return null;
  return STAGE_LABELS[stage] ?? null;
}

/** Defensive read of the job verification report (typed unknown over the wire). */
function readVerification(v: unknown): { passed: number; warned: number; failed: number } | null {
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const passed = num(rec.passed);
  const warned = num(rec.warned);
  const failed = num(rec.failed);
  if (passed === null && warned === null && failed === null) return null;
  return { passed: passed ?? 0, warned: warned ?? 0, failed: failed ?? 0 };
}

/** Non-empty trimmed string, else "" — falsy, so absent fields render nothing. */
function strField(v: unknown): string {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : "";
}

/** Valid #RGB/#RRGGBB(/AA) hex color, else "" — never trust wire hexes. */
function hexColor(v: unknown): string {
  return typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : "";
}

/** Finite number clamped to the 0–100 report range, else null. */
function score100(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : null;
}

function recordOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function severityOf(v: unknown): StudioQualityFinding["severity"] | null {
  return v === "high" || v === "medium" || v === "low" ? v : null;
}

/**
 * Defensive read of the OPTIONAL creative-direction block on the assistant
 * message meta (additive "directing"-stage output — old messages have none).
 * Every field is validated independently and coerced to "" / [] when absent
 * or malformed; returns null when nothing meaningful is present, so
 * pre-direction messages render EXACTLY as before (no empty sections).
 */
function readDirection(meta: StudioChatMessage["meta"]): StudioDirection | null {
  const rec = recordOf(meta?.direction);
  if (!rec) return null;

  const designLanguage = strField(rec.designLanguage);
  const designLanguageLabel = strField(rec.designLanguageLabel);
  const concept = strField(rec.concept);
  const motionLanguage = strField(rec.motionLanguage);
  const layoutStrategy = strField(rec.layoutStrategy);
  const heroComposition = strField(rec.heroComposition);
  const responsiveStrategy = strField(rec.responsiveStrategy);

  const pal = recordOf(rec.palette);
  const palette: StudioDirectionPalette = {
    background: hexColor(pal?.background),
    surface: hexColor(pal?.surface),
    foreground: hexColor(pal?.foreground),
    muted: hexColor(pal?.muted),
    accent: hexColor(pal?.accent),
    accent2: hexColor(pal?.accent2),
    gradient: strField(pal?.gradient) || null,
  };

  const typo = recordOf(rec.typography);
  const typography = {
    heading: strField(typo?.heading),
    body: strField(typo?.body),
    accent: strField(typo?.accent),
    note: strField(typo?.note),
  };

  const sectionPlan = (Array.isArray(rec.sectionPlan) ? rec.sectionPlan : []).flatMap((entry) => {
    const e = recordOf(entry);
    const section = e ? strField(e.section) : "";
    const direction = e ? strField(e.direction) : "";
    return section && direction ? [{ section, direction }] : [];
  });

  const hasContent = Boolean(
    designLanguage || designLanguageLabel || concept || motionLanguage || layoutStrategy ||
      heroComposition || responsiveStrategy ||
      palette.background || palette.surface || palette.foreground || palette.muted ||
      palette.accent || palette.accent2 ||
      typography.heading || typography.body || sectionPlan.length > 0
  );
  if (!hasContent) return null;

  return {
    designLanguage,
    designLanguageLabel,
    concept,
    palette,
    typography,
    motionLanguage,
    layoutStrategy,
    heroComposition,
    responsiveStrategy,
    sectionPlan,
  };
}

const QUALITY_VERDICTS: readonly StudioQuality["verdict"][] = ["strong", "acceptable", "needs-repair"];

/**
 * Defensive read of the OPTIONAL design-quality report on the proposal
 * (additive "reviewing"-stage output — old proposals have none). Requires a
 * valid overall score AND verdict, so a malformed report can never render a
 * misleading "0/100" on a message that predates quality reporting.
 */
function readQuality(proposal: StudioProposal | null): StudioQuality | null {
  const rec = recordOf(proposal?.quality);
  if (!rec) return null;

  const overall = score100(rec.overall);
  const verdict = QUALITY_VERDICTS.find((v) => v === rec.verdict) ?? null;
  if (overall === null || !verdict) return null;

  const dimensions = (Array.isArray(rec.dimensions) ? rec.dimensions : []).flatMap((entry) => {
    const e = recordOf(entry);
    const label = e ? strField(e.label) : "";
    const score = e ? score100(e.score) : null;
    if (!e || !label || score === null) return [];
    return [{ id: strField(e.id) || label, label, score }];
  });

  const findings = (Array.isArray(rec.findings) ? rec.findings : []).flatMap((entry) => {
    const e = recordOf(entry);
    if (!e) return [];
    const severity = severityOf(e.severity);
    const finding = strField(e.finding);
    if (!severity || !finding) return [];
    return [{ severity, area: strField(e.area), finding, suggestion: strField(e.suggestion) }];
  });

  return {
    overall,
    verdict,
    summary: strField(rec.summary),
    dimensions,
    findings,
    reviewedBy: strField(rec.reviewedBy),
  };
}

/** Verdict chip styling — reuses the card's file-action badge palette. */
const VERDICT_BADGE: Record<StudioQuality["verdict"], string> = {
  strong: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  acceptable: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "needs-repair": "border-destructive/40 bg-destructive/10 text-destructive",
};

const VERDICT_LABEL: Record<StudioQuality["verdict"], string> = {
  strong: "strong",
  acceptable: "acceptable",
  "needs-repair": "needs repair",
};

/** Severity dot color for quality findings. */
const SEVERITY_DOT: Record<StudioQualityFinding["severity"], string> = {
  high: "bg-destructive",
  medium: "bg-amber-500",
  low: "bg-muted-foreground/50",
};

/** The six palette slots as deduped swatch hexes (gradient is not a swatch). */
function paletteSwatches(p: StudioDirectionPalette): string[] {
  return [...new Set([p.background, p.surface, p.foreground, p.muted, p.accent, p.accent2].filter(Boolean))];
}

function timeLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function fileActionBadge(action: StudioChangedFile["action"]) {
  if (action === "added") return { label: "added", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
  if (action === "removed") return { label: "removed", className: "border-destructive/40 bg-destructive/10 text-destructive" };
  return { label: "modified", className: "border-primary/40 bg-gold-soft text-primary" };
}

// ------------------------------------------------------------------ proposal card

/**
 * Quiet disclosure row for the card's additive addenda (creative direction,
 * design quality). Collapsed by default; a card WITHOUT these addenda renders
 * exactly as before — the row exists only when its data exists.
 */
function CardDisclosure({
  label, icon, meta, children,
}: {
  label: string;
  icon?: ReactNode;
  /** Right-aligned summary shown even while collapsed. */
  meta?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 rounded-md border border-border/50 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
      >
        {icon}
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="ml-auto flex min-w-0 items-center gap-1.5">{meta ?? null}</span>
        <ChevronDown
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open ? "rotate-180" : "")}
          aria-hidden
        />
      </button>
      {open && <div className="border-t border-border/50 px-2.5 py-2">{children}</div>}
    </div>
  );
}

function ProposalCard({
  proposal, active, onPreview, onRevise, showFileInventory = true, direction = null, quality = null,
}: {
  proposal: StudioProposal;
  active: boolean;
  onPreview: () => void;
  /** Prefills the composer with a revision request for this proposal. */
  onRevise?: () => void;
  /** CODE GIFTZ validation preference: render the per-file changed-file
   * inventory (off = a one-line count instead — the data is identical). */
  showFileInventory?: boolean;
  /** Additive creative-direction block (absent on pre-direction messages). */
  direction?: StudioDirection | null;
  /** Additive design-quality report (absent on pre-quality proposals). */
  quality?: StudioQuality | null;
}) {
  const verification = readVerification(proposal.verification);
  const swatches = direction ? paletteSwatches(direction.palette) : [];
  return (
    <div className="mt-2 rounded-lg border border-border/70 bg-background/60 p-2.5" role="region" aria-label="Proposed changes">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <FolderGit2 className="size-3.5" aria-hidden /> Changed files
      </p>
      {proposal.changedFiles.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">No virtual files changed.</p>
      ) : showFileInventory ? (
        <ul className="mt-1.5 max-h-44 space-y-1.5 overflow-y-auto pr-0.5" style={{ scrollbarWidth: "thin" }}>
          {proposal.changedFiles.map((f, i) => {
            const badge = fileActionBadge(f.action);
            return (
              <li key={`${f.path}-${i}`} className="rounded-md border border-border/50 bg-muted/30 px-2 py-1.5">
                <p className="flex items-center gap-1.5">
                  {f.action === "added" ? (
                    <FilePlus2 className="size-3 shrink-0 text-emerald-500" aria-hidden />
                  ) : f.action === "removed" ? (
                    <FileMinus2 className="size-3 shrink-0 text-destructive" aria-hidden />
                  ) : (
                    <FilePen className="size-3 shrink-0 text-primary" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{f.path}</span>
                  <Badge variant="outline" className={cn("shrink-0 px-1 py-0 text-[9px] uppercase", badge.className)}>
                    {badge.label}
                  </Badge>
                </p>
                <p className="mt-0.5 pl-[18px] text-[11px] leading-snug text-muted-foreground">{f.summary}</p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground" title="Turn on “Show changed-file inventory” in GIFTZ settings for the per-file list">
          {proposal.changedFiles.length} virtual {proposal.changedFiles.length === 1 ? "file" : "files"} changed — inventory hidden by your validation setting.
        </p>
      )}

      {proposal.summary && <p className="mt-2 text-xs leading-relaxed">{proposal.summary}</p>}

      {verification && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" aria-label="Verification results">
          <span className="text-emerald-600 dark:text-emerald-400">{verification.passed} passed</span>
          {verification.warned > 0 && <span className="text-amber-600 dark:text-amber-400">{verification.warned} warned</span>}
          {verification.failed > 0 && <span className="text-destructive">{verification.failed} failed</span>}
          <span className="text-muted-foreground">· engine verification</span>
        </p>
      )}

      {direction && (
        <CardDisclosure
          label="Creative direction"
          icon={<Palette className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
          meta={
            direction.designLanguageLabel ? (
              <span className="min-w-0 truncate text-[10px] normal-case tracking-normal">{direction.designLanguageLabel}</span>
            ) : null
          }
        >
          <div className="space-y-2">
            {direction.concept && <p className="text-[11px] leading-relaxed text-muted-foreground">{direction.concept}</p>}
            {swatches.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {swatches.map((hex) => (
                  <span
                    key={hex}
                    title={hex}
                    aria-label={hex}
                    className="size-3.5 shrink-0 rounded border border-border/60"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </div>
            )}
            <div className="space-y-1 text-[11px] leading-snug text-muted-foreground">
              {(direction.typography.heading || direction.typography.body) && (
                <p>
                  <span className="font-medium text-foreground/80">Typography:</span>{" "}
                  {[direction.typography.heading, direction.typography.body].filter(Boolean).join(" × ")}
                </p>
              )}
              {direction.motionLanguage && (
                <p>
                  <span className="font-medium text-foreground/80">Motion:</span> {direction.motionLanguage}
                </p>
              )}
              {direction.layoutStrategy && (
                <p>
                  <span className="font-medium text-foreground/80">Layout:</span> {direction.layoutStrategy}
                </p>
              )}
              {direction.responsiveStrategy && (
                <p>
                  <span className="font-medium text-foreground/80">Responsive:</span> {direction.responsiveStrategy}
                </p>
              )}
            </div>
            {direction.sectionPlan.length > 0 && (
              <ul className="space-y-0.5 text-[11px] leading-snug text-muted-foreground" aria-label="Per-section visual direction">
                {direction.sectionPlan.map((s, i) => (
                  <li key={`${s.section}-${i}`}>
                    <span className="font-medium text-foreground/80">{s.section}</span> — {s.direction}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardDisclosure>
      )}

      {quality && (
        <CardDisclosure
          label="Design quality"
          icon={<Gauge className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
          meta={
            <>
              <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{quality.overall}/100</span>
              <Badge
                variant="outline"
                className={cn("shrink-0 px-1 py-0 text-[9px] uppercase", VERDICT_BADGE[quality.verdict])}
              >
                {VERDICT_LABEL[quality.verdict]}
              </Badge>
            </>
          }
        >
          <div className="space-y-2">
            {quality.summary && <p className="text-[11px] leading-relaxed text-muted-foreground">{quality.summary}</p>}
            {quality.dimensions.length > 0 && (
              <ul className="flex flex-wrap gap-1" aria-label="Quality dimensions">
                {quality.dimensions.map((d, i) => (
                  <li key={`${d.id}-${i}`}>
                    <Badge variant="outline" className="px-1 py-0 text-[9px] font-normal text-muted-foreground">
                      {d.label} <span className="ml-0.5 tabular-nums font-medium text-foreground/80">{d.score}</span>
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            {quality.findings.slice(0, 6).map((f, i) => (
              <div key={`${f.finding}-${i}`} className="flex gap-1.5">
                <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", SEVERITY_DOT[f.severity])} />
                <p className="min-w-0 text-[11px] leading-snug">
                  {f.finding}
                  {f.suggestion && <span className="text-muted-foreground"> — {f.suggestion}</span>}
                </p>
              </div>
            ))}
            {quality.reviewedBy === "deterministic-only" && (
              <p className="text-[10px] text-muted-foreground">engine checks only</p>
            )}
          </div>
        </CardDisclosure>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {active ? (
          <span className="flex shrink-0 items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400" role="status">
            <TriangleAlert className="size-3.5" aria-hidden /> Previewing — not saved
          </span>
        ) : (
          <Button size="sm" className="h-8 shrink-0" onClick={onPreview}>
            <Check className="size-3.5" aria-hidden /> Preview changes
          </Button>
        )}
        {!active && onRevise ? (
          <Button size="sm" variant="ghost" className="h-8 shrink-0" onClick={onRevise} title="Ask GIFTZ to revise this proposal">
            <PenLine className="size-3.5" aria-hidden /> Request changes
          </Button>
        ) : null}
        <p className="min-w-0 flex-1 basis-32 text-[10px] leading-snug text-muted-foreground">Renders in isolation — your draft and published site stay untouched until you save.</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ main panel

export function ChatPanel({
  currentConfig,
  context,
  onPreviewProposal,
  activeProposalMessageId = null,
  disabled = false,
  autoPreviewProposals = false,
  giftzSettings,
  onGiftzSettingsChange,
  sessionTarget,
  sessionsTargetFilter,
}: ChatPanelProps) {
  const [sessions, setSessions] = useState<StudioSessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSessionTitle, setActiveSessionTitle] = useState<string>("");
  const [messages, setMessages] = useState<StudioChatMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<"edit" | "create">("edit");

  const [pollTaskId, setPollTaskId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const configRef = useRef(currentConfig);
  const contextRef = useRef(context);
  // Ref mirror of the session target — createSession reads the LATEST value
  // (a site binding can change mid-session) without re-subscribing callbacks.
  const sessionTargetRef = useRef<ChatSessionTarget | undefined>(sessionTarget);
  useEffect(() => {
    sessionTargetRef.current = sessionTarget;
  }, [sessionTarget]);
  useEffect(() => {
    configRef.current = currentConfig;
  }, [currentConfig]);
  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  const busy = sending || pollTaskId !== null || messages.some((m) => m.status === "PENDING" || m.status === "RUNNING");

  // ---- sessions: load on mount -------------------------------------------
  const refreshSessions = useCallback(async () => {
    try {
      const r = await api<{ sessions: StudioSessionSummary[] }>(
        `/api/me/site/studio/sessions${sessionsTargetFilter ? `?target=${sessionsTargetFilter}` : ""}`
      );
      setSessions(r.sessions);
      setSessionsLoaded(true);
      return r.sessions;
    } catch {
      setSessionsLoaded(true);
      return [];
    }
  }, [sessionsTargetFilter]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // ---- thread: load a session --------------------------------------------
  const openSession = useCallback(async (id: string) => {
    setActiveSessionId(id);
    setThreadLoading(true);
    setConfirmDelete(false);
    try {
      const r = await api<{ session: { id: string; title: string }; messages: StudioChatMessage[] }>(
        `/api/me/site/studio/sessions/${encodeURIComponent(id)}`
      );
      setActiveSessionTitle(r.session.title);
      const normalized = r.messages.map((m) => ({
        ...m,
        role: m.role === "USER" ? "USER" as const : "ASSISTANT" as const,
        proposal: (m.proposal ?? null) as StudioProposal | null,
      }));
      setMessages(normalized);
      // Resume polling if the thread contains a still-running turn.
      const running = normalized.filter((m) => m.status === "PENDING" || m.status === "RUNNING").at(-1);
      setPollTaskId(running?.taskId ?? null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open this conversation");
    } finally {
      setThreadLoading(false);
    }
  }, []);

  // Reopen the most recent conversation once the session list arrives, so
  // history continues seamlessly across reloads and studio-mode switches (an
  // in-flight turn resumes polling inside openSession). Run-once guard: only
  // while no thread is open.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (!sessionsLoaded || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    if (sessions.length > 0 && !activeSessionId) void openSession(sessions[0].id);
  }, [sessionsLoaded, sessions, activeSessionId, openSession]);

  // ---- create a session ----------------------------------------------------
  const createSession = useCallback(
    async (title?: string): Promise<StudioSessionSummary | null> => {
      try {
        const r = await api<{ session: StudioSessionSummary }>("/api/me/site/studio/sessions", {
          method: "POST",
          json: {
            ...(title ? { title } : {}),
            ...(sessionTargetRef.current
              ? { target: { kind: sessionTargetRef.current.kind, ...(sessionTargetRef.current.siteId ? { siteId: sessionTargetRef.current.siteId } : {}) } }
              : {}),
          },
        });
        setSessions((prev) => [r.session, ...prev]);
        setActiveSessionId(r.session.id);
        setActiveSessionTitle(r.session.title);
        setMessages([]);
        setPollTaskId(null);
        return r.session;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not start a new session");
        return null;
      }
    },
    []
  );

  // ---- poll the running turn ----------------------------------------------
  // autoPreviewRef: the preference at the moment a turn COMPLETES decides
  // whether the proposal auto-renders in the Preview workspace (kept in a ref
  // so the poll effect does not re-subscribe on every settings change).
  const autoPreviewRef = useRef(autoPreviewProposals);
  useEffect(() => {
    autoPreviewRef.current = autoPreviewProposals;
  }, [autoPreviewProposals]);

  useEffect(() => {
    if (!pollTaskId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (stopped) return;
      try {
        const r = await api<{ task: { id: string; status: string }; message: Omit<StudioChatMessage, "taskId"> }>(
          `/api/me/site/studio/turns/${encodeURIComponent(pollTaskId)}`
        );
        if (stopped) return;
        const msg = r.message;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msg.id
              ? {
                  ...m,
                  text: msg.text,
                  status: msg.status,
                  error: msg.error,
                  proposal: (msg.proposal ?? null) as StudioProposal | null,
                  meta: (msg.meta ?? null) as StudioChatMessage["meta"],
                }
              : m
          )
        );
        if (msg.status === "DONE" || msg.status === "FAILED") {
          setPollTaskId(null);
          // After code generation the Preview workspace shows the ACTUAL
          // generated website (never the saved portfolio) — auto-rendered
          // when the CODE GIFTZ preview setting allows it. On mobile the
          // user stays in Chat; the proposal card offers a one-tap Preview.
          const proposal = (msg.proposal ?? null) as StudioProposal | null;
          if (msg.status === "DONE" && proposal && autoPreviewRef.current) {
            onPreviewProposal(proposal, msg.id, { auto: true });
          }
          void refreshSessions();
          return;
        }
      } catch {
        /* transient network error — keep polling */
      }
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    };

    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollTaskId, refreshSessions, onPreviewProposal]);

  // ---- auto-scroll ---------------------------------------------------------
  // The conversation scrolls INDEPENDENTLY inside its own flex item; the
  // composer is a non-shrinking sibling, so no amount of history can push it
  // out of view. New messages / status changes / send all snap to latest.
  const lastMessage = messages.at(-1);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length, lastMessage?.status, lastMessage?.text]);

  // Immediate scroll on send (before the server confirms the row).
  const scrollConversationToEnd = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // ---- send ----------------------------------------------------------------
  /**
   * Send one studio turn. `overrideText` (the Retry path) re-runs a request
   * without retyping it — the composer state is untouched in that case.
   *
   * Prompt-preservation contract:
   *   1. the session is ensured FIRST (createSession resets the message
   *      list — the optimistic bubble may only be added once a session
   *      exists, otherwise the FIRST prompt of a new conversation was wiped
   *      before the server row ever arrived);
   *   2. the optimistic user bubble renders the prompt immediately;
   *   3. the composer clears ONLY after the submission is accepted (202);
   *   4. a failed submission keeps the prompt in the composer — the request
   *      is never silently discarded.
   */
  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? composer).trim();
    if (!text || busy || disabled) return;
    setSending(true);
    let sessionId = activeSessionId;
    if (!sessionId) {
      try {
        const created = await createSession(text.slice(0, 60));
        if (!created) throw new Error("Could not start a conversation session");
        sessionId = created.id;
      } catch (e) {
        setSending(false);
        toast.error(e instanceof Error ? e.message : "Could not start a conversation session");
        return;
      }
    }
    // The optimistic user bubble is replaced by the server-confirmed row.
    const optimisticId = `local-${Date.now().toString(36)}`;
    setMessages((prev) => [
      ...prev,
      { id: optimisticId, role: "USER", text, status: "DONE", error: null, taskId: null, createdAt: new Date().toISOString(), proposal: null, meta: null },
    ]);
    // Snap the conversation to the just-sent message (auto-scroll covers the
    // reply later; this covers the send itself).
    requestAnimationFrame(() => scrollConversationToEnd());
    try {
      const r = await api<{ userMessageId: string; assistantMessageId: string; taskId: string }>(
        `/api/me/site/studio/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: "POST",
          json: {
            text,
            currentConfig: configRef.current,
            mode,
            context: {
              device: contextRef.current.device?.slice(0, 20),
              ...(contextRef.current.pageName ? { pageName: contextRef.current.pageName.slice(0, 60) } : {}),
              ...(contextRef.current.sectionType ? { sectionType: contextRef.current.sectionType.slice(0, 30) } : {}),
              ...(contextRef.current.sectionTitle ? { sectionTitle: contextRef.current.sectionTitle.slice(0, 120) } : {}),
            },
          },
        }
      );
      // The submission is accepted — only now may the composer clear; the
      // sent prompt stays visible in the conversation as the user bubble.
      setComposer("");
      setMessages((prev) => {
        const withoutOptimistic = prev.map((m) => (m.id === optimisticId ? { ...m, id: r.userMessageId } : m));
        return [
          ...withoutOptimistic,
          {
            id: r.assistantMessageId,
            role: "ASSISTANT",
            text: "",
            status: "PENDING",
            error: null,
            taskId: r.taskId,
            createdAt: new Date().toISOString(),
            proposal: null,
            meta: { stage: "queued", mode },
          },
        ];
      });
      setPollTaskId(r.taskId);
      void refreshSessions();
    } catch (e) {
      // Submission failed — the turn never started. KEEP the prompt: drop the
      // optimistic bubble and leave the composer text untouched so the same
      // request can be retried without retyping it.
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      const message = e instanceof Error ? e.message : "Could not send the message.";
      if (/already running/i.test(message)) {
        toast.warning("A turn is already running", { description: "Wait for it to finish, then send your next request." });
      } else {
        toast.error(message);
      }
    } finally {
      setSending(false);
    }
  }, [composer, busy, disabled, activeSessionId, createSession, mode, refreshSessions, scrollConversationToEnd]);

  // ---- retry a FAILED turn --------------------------------------------------
  // Re-runs the ORIGINAL persisted prompt via retryOfMessageId: no retype,
  // no duplicated user bubble — the existing user message stays, only a new
  // assistant turn is appended.
  const retryTurn = useCallback(
    async (userMessageId: string, retryMode: "edit" | "create") => {
      if (busy || disabled || !activeSessionId) return;
      setSending(true);
      const placeholderId = `local-retry-${Date.now().toString(36)}`;
      setMessages((prev) => [
        ...prev,
        {
          id: placeholderId,
          role: "ASSISTANT",
          text: "",
          status: "PENDING",
          error: null,
          taskId: null,
          createdAt: new Date().toISOString(),
          proposal: null,
          meta: { stage: "queued", mode: retryMode },
        },
      ]);
      requestAnimationFrame(() => scrollConversationToEnd());
      try {
        const r = await api<{ userMessageId: string; assistantMessageId: string; taskId: string }>(
          `/api/me/site/studio/sessions/${encodeURIComponent(activeSessionId)}/messages`,
          {
            method: "POST",
            json: {
              currentConfig: configRef.current,
              mode: retryMode,
              retryOfMessageId: userMessageId,
              context: {
                device: contextRef.current.device?.slice(0, 20),
                ...(contextRef.current.pageName ? { pageName: contextRef.current.pageName.slice(0, 60) } : {}),
                ...(contextRef.current.sectionType ? { sectionType: contextRef.current.sectionType.slice(0, 30) } : {}),
                ...(contextRef.current.sectionTitle ? { sectionTitle: contextRef.current.sectionTitle.slice(0, 120) } : {}),
              },
            },
          }
        );
        setMessages((prev) =>
          prev.map((m) => (m.id === placeholderId ? { ...m, id: r.assistantMessageId, taskId: r.taskId } : m))
        );
        setPollTaskId(r.taskId);
        void refreshSessions();
      } catch (e) {
        setMessages((prev) => prev.filter((m) => m.id !== placeholderId));
        toast.error(e instanceof Error ? e.message : "Could not retry the request.");
      } finally {
        setSending(false);
      }
    },
    [busy, disabled, activeSessionId, refreshSessions, scrollConversationToEnd]
  );

  // ---- retry ONLY the failed step(s) of a partially-failed turn -----------
  // The completed steps stay untouched (they ARE the preserved proposal);
  // the same execution job continues from the failure. The turn polls the
  // SAME taskId — on success the partial proposal is replaced by the
  // complete one and the message lands DONE.
  const retryFailedStep = useCallback(
    async (taskId: string) => {
      if (busy || disabled) return;
      setSending(true);
      try {
        await api<{ taskId: string; jobId: string; status: string }>(
          `/api/me/site/studio/turns/${encodeURIComponent(taskId)}/retry`,
          { method: "POST", json: {} }
        );
        setMessages((prev) =>
          prev.map((m) =>
            m.id && m.taskId === taskId && m.status === "FAILED"
              ? { ...m, status: "RUNNING", error: null, meta: { ...m.meta, stage: "executing-retry" } }
              : m
          )
        );
        setPollTaskId(taskId);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not retry the failed step.");
      } finally {
        setSending(false);
      }
    },
    [busy, disabled]
  );

  // ---- rename / delete -----------------------------------------------------
  async function saveRename() {
    const title = renameValue.trim();
    if (!activeSessionId || !title) {
      setRenaming(false);
      return;
    }
    try {
      await api(`/api/me/site/studio/sessions/${encodeURIComponent(activeSessionId)}`, { method: "PATCH", json: { title } });
      setActiveSessionTitle(title);
      setSessions((prev) => prev.map((s) => (s.id === activeSessionId ? { ...s, title } : s)));
      setRenaming(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not rename the session");
    }
  }

  async function deleteSession() {
    if (!activeSessionId) return;
    try {
      const res = await fetch(`/api/me/site/studio/sessions/${encodeURIComponent(activeSessionId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Could not delete the session (${res.status})`);
      }
      toast.success("Session deleted");
      const remaining = sessions.filter((s) => s.id !== activeSessionId);
      setSessions(remaining);
      setActiveSessionId(null);
      setActiveSessionTitle("");
      setMessages([]);
      setPollTaskId(null);
      setConfirmDelete(false);
      if (remaining[0]) void openSession(remaining[0].id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the session");
    }
  }

  const emptyThread = !threadLoading && messages.length === 0;
  const composerChars = composer.length;
  // CODE GIFTZ chat preference — Enter-to-send (off = Ctrl/Cmd+Enter sends).
  const enterToSend = giftzSettings?.enterToSend ?? true;
  // CODE GIFTZ validation preference — full changed-file inventory on cards.
  const showFileInventory = giftzSettings?.showFileInventory ?? true;

  const activeSession = useMemo(() => sessions.find((s) => s.id === activeSessionId) ?? null, [sessions, activeSessionId]);

  // Per-assistant-message retry context: the id of the USER message that
  // asked for it. A FAILED turn can re-run that persisted prompt verbatim
  // (no retype, no duplicate bubble). Local (optimistic) user rows are not
  // retryable — the server has not accepted them yet.
  const retryOrigins = useMemo(() => {
    const map = new Map<string, { userMessageId: string | null; mode: "edit" | "create" }>();
    let lastUser: { id: string; mode: "edit" | "create" } | null = null;
    for (const m of messages) {
      if (m.role === "USER") {
        lastUser = m.id.startsWith("local-") ? null : { id: m.id, mode: m.meta?.mode === "create" ? "create" : "edit" };
      } else {
        map.set(m.id, {
          userMessageId: lastUser?.id ?? null,
          mode: m.meta?.mode === "create" ? "create" : lastUser?.mode ?? "edit",
        });
      }
    }
    return map;
  }, [messages]);

  return (
    // Hard flex contract: the header and composer are non-shrinking rows and
    // the conversation is the ONLY scrollable region — long history can never
    // push the composer/Send button out of the viewport.
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* session header — one compact row: title truncates, icons never wrap
          or clip, height stays consistent at every panel width */}
      <div className="flex shrink-0 flex-nowrap items-center gap-1.5 overflow-hidden border-b border-border/60 px-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 min-w-0 flex-1 justify-start gap-1.5 px-2" aria-label="Switch conversation session">
              <History className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate text-xs font-medium">{activeSessionTitle || "Sessions"}</span>
              {activeSession && <span className="shrink-0 text-[10px] text-muted-foreground">· {activeSession.messageCount}</span>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Conversations</DropdownMenuLabel>
            {sessionsLoaded && sessions.length === 0 && (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">No sessions yet — send a message to start one.</p>
            )}
            {sessions.map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => void openSession(s.id)} className="gap-2">
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{s.messageCount} msg</span>
              </DropdownMenuItem>
            ))}
            {sessions.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void createSession()}>
                  <MessageSquarePlus className="size-4" aria-hidden /> New session
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="New session" title="New session" onClick={() => void createSession()}>
          <MessageSquarePlus className="size-4" aria-hidden />
        </Button>

        {activeSessionId && !renaming && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label="Rename session"
            title="Rename session"
            onClick={() => {
              setRenameValue(activeSessionTitle);
              setRenaming(true);
            }}
          >
            <Pencil className="size-3.5" aria-hidden />
          </Button>
        )}
        {activeSessionId && renaming && (
          <>
            <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="Save session name" onClick={() => void saveRename()}>
              <Check className="size-3.5" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="Cancel rename" onClick={() => setRenaming(false)}>
              <X className="size-3.5" aria-hidden />
            </Button>
          </>
        )}
        {activeSessionId && !renaming && (
          confirmDelete ? (
            <>
              <Button variant="ghost" size="icon" className="size-8 shrink-0 text-destructive" aria-label="Confirm delete session" onClick={() => void deleteSession()}>
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
              <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="Keep session" onClick={() => setConfirmDelete(false)}>
                <X className="size-3.5" aria-hidden />
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:text-destructive" aria-label="Delete session" title="Delete session" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          )
        )}

        {/* CODE GIFTZ workspace settings — fully independent from Customization settings */}
        {giftzSettings && onGiftzSettingsChange && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="GIFTZ workspace settings" title="GIFTZ workspace settings">
                <Settings2 className="size-4" aria-hidden />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="max-h-[70vh] w-80 space-y-3 overflow-y-auto p-3" style={{ scrollbarWidth: "thin" }}>
              <div>
                <p className="text-xs font-semibold">GIFTZ settings</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Only this workspace — Customization keeps its own separate settings, saved under its own key.
                </p>
              </div>

              {/* ---- Chat settings ---- */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Chat</p>
                <label
                  htmlFor="giftz-enter-to-send"
                  className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-border/60 px-2.5 py-2"
                >
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">Enter sends the message</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                      On: Enter sends, Shift+Enter breaks the line. Off: Enter breaks the line and Ctrl/Cmd+Enter sends.
                    </span>
                  </span>
                  <Switch
                    id="giftz-enter-to-send"
                    checked={giftzSettings.enterToSend}
                    onCheckedChange={(v) => onGiftzSettingsChange({ ...giftzSettings, enterToSend: v })}
                  />
                </label>
              </div>

              {/* ---- Preview settings ---- */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Preview</p>
                <label
                  htmlFor="giftz-autopreview"
                  className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-border/60 px-2.5 py-2"
                >
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">Auto-preview generated websites</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                      When a turn finishes, render the generated website in the Preview workspace automatically. Saving stays manual — always.
                    </span>
                  </span>
                  <Switch
                    id="giftz-autopreview"
                    checked={giftzSettings.autoPreview}
                    onCheckedChange={(v) => onGiftzSettingsChange({ ...giftzSettings, autoPreview: v })}
                  />
                </label>
                <p className="px-1 text-[10px] leading-snug text-muted-foreground">
                  Preview device (desktop / tablet / mobile) is remembered per mode from the header switcher.
                </p>
              </div>

              {/* ---- Validation preferences ---- */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Validation</p>
                <label
                  htmlFor="giftz-file-inventory"
                  className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-border/60 px-2.5 py-2"
                >
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">Show changed-file inventory</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                      List every virtual file a proposal touched, with per-file summaries. Off shows a one-line count instead — verification results are always shown.
                    </span>
                  </span>
                  <Switch
                    id="giftz-file-inventory"
                    checked={giftzSettings.showFileInventory}
                    onCheckedChange={(v) => onGiftzSettingsChange({ ...giftzSettings, showFileInventory: v })}
                  />
                </label>
              </div>

              {/* ---- Draft & version settings ---- */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Draft &amp; versions</p>
                <label
                  htmlFor="giftz-confirm-save"
                  className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-border/60 px-2.5 py-2"
                >
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">Confirm before saving a generated website</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                      Saving a generated website replaces the current draft — with this on, Save Draft asks first. The previous version is always snapshotted and restorable.
                    </span>
                  </span>
                  <Switch
                    id="giftz-confirm-save"
                    checked={giftzSettings.confirmProposalSave}
                    onCheckedChange={(v) => onGiftzSettingsChange({ ...giftzSettings, confirmProposalSave: v })}
                  />
                </label>
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>

      {/* inline rename field */}
      {renaming && (
        <div className="border-b border-border/60 px-3 py-2">
          <Label htmlFor="studio-session-rename" className="sr-only">Session name</Label>
          <Input
            id="studio-session-rename"
            value={renameValue}
            maxLength={80}
            className="h-8 text-xs"
            placeholder="Session name"
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            onChange={(e) => setRenameValue(e.target.value)}
            autoFocus
          />
        </div>
      )}

      {/* thread — the ONLY scroll region of the chat panel */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3"
        style={{ scrollbarWidth: "thin" }}
        aria-label="Conversation"
        aria-live="polite"
      >
        {threadLoading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading conversation…
          </div>
        )}

        {emptyThread && (
          <div className="rounded-lg border border-border/60 bg-card/60 p-4 text-center">
            <p className="text-sm font-medium">Build your website by chatting</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Describe the change — “make the hero centered with a champagne accent”, “add a services page”, “switch to a
              dark editorial look”. Every request runs the real plan → execute pipeline and produces a changed-file
              proposal you preview in isolation before saving.
            </p>
          </div>
        )}

        {messages.map((m) =>
          m.role === "USER" ? (
            <div key={m.id} className="flex justify-end">
              <div
                className="max-w-[85%] rounded-2xl rounded-br-sm border border-primary/25 bg-gold-soft/60 px-3 py-2 text-sm leading-relaxed"
                role="figure"
                aria-label="Your message"
              >
                <p className="whitespace-pre-wrap break-words">{m.text}</p>
                <p className="mt-1 text-right text-[10px] text-muted-foreground">{timeLabel(m.createdAt)}</p>
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex flex-col items-start">
              <div
                className={cn(
                  "max-w-[92%] rounded-2xl rounded-bl-sm border px-3 py-2 text-sm leading-relaxed",
                  m.status === "FAILED" ? "border-destructive/40 bg-destructive/10" : "border-border/70 bg-card/80"
                )}
                role="figure"
                aria-label="GIFTZ reply"
              >
                {(m.status === "PENDING" || m.status === "RUNNING") && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                    <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
                    {m.status === "PENDING" ? STAGE_LABELS.queued : (stageOf(m) ?? "Working…")}
                  </p>
                )}

                {m.status === "FAILED" && (
                  <div role="alert">
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
                      <ShieldAlert className="size-3.5" aria-hidden /> This turn failed
                    </p>
                    {m.text && <p className="mt-1 whitespace-pre-wrap break-words text-xs">{m.text}</p>}
                    {m.error && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-destructive/90">{m.error}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                        {m.proposal
                          ? `Completed steps preserved — preview below${m.taskId ? ", or retry just the failed step" : ""}.`
                          : "Your website is unchanged."}
                      </p>
                      {(() => {
                        const origin = retryOrigins.get(m.id);
                        return origin?.userMessageId ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 shrink-0 text-[11px]"
                            disabled={busy || disabled}
                            onClick={() => void retryTurn(origin.userMessageId!, origin.mode)}
                            title="Run the exact same request again — your original prompt is preserved (no duplicate messages)"
                          >
                            <RotateCcw className="size-3" aria-hidden /> Retry request
                          </Button>
                        ) : null;
                      })()}
                      {/* Execution-stage failures have an execution job whose
                          failed step(s) can be re-run without touching the
                          completed ones. The server validates eligibility
                          honestly (an expired job answers with a clear error
                          instead of a dead button). */}
                      {m.taskId &&
                        (m.meta?.stage === "execute" ||
                          m.meta?.stage === "execute-partial" ||
                          m.meta?.stage === "retry-crashed" ||
                          (m.meta?.stage === undefined && m.proposal)) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 shrink-0 border-primary/40 text-[11px] text-primary hover:bg-gold-soft"
                            disabled={busy || disabled}
                            onClick={() => void retryFailedStep(m.taskId!)}
                            title="Re-run only the failed step(s) of the same execution — completed steps are not re-run"
                          >
                            <RotateCcw className="size-3" aria-hidden /> Retry failed step
                          </Button>
                        )}
                    </div>
                  </div>
                )}

                {m.status === "DONE" && (
                  <>
                    {m.text ? <p className="whitespace-pre-wrap break-words">{m.text}</p> : <p className="text-xs text-muted-foreground">Done.</p>}
                    <p className="mt-1 text-[10px] text-muted-foreground">{timeLabel(m.createdAt)}</p>
                  </>
                )}

                {m.status === "DONE" && m.proposal && (
                  <ProposalCard
                    proposal={m.proposal}
                    active={activeProposalMessageId === m.id}
                    showFileInventory={showFileInventory}
                    direction={readDirection(m.meta)}
                    quality={readQuality(m.proposal)}
                    onPreview={() => onPreviewProposal(m.proposal!, m.id)}
                    onRevise={() => {
                      setComposer(`Revise this change — "${(m.proposal!.summary || "the last proposal").slice(0, 120)}": `);
                      requestAnimationFrame(() => composerRef.current?.focus());
                    }}
                  />
                )}

                {m.status === "FAILED" && m.proposal && (
                  <ProposalCard
                    proposal={m.proposal}
                    active={activeProposalMessageId === m.id}
                    showFileInventory={showFileInventory}
                    direction={readDirection(m.meta)}
                    quality={readQuality(m.proposal)}
                    onPreview={() => onPreviewProposal(m.proposal!, m.id)}
                    onRevise={() => {
                      setComposer(`Revise this change — "${(m.proposal!.summary || "the last proposal").slice(0, 120)}": `);
                      requestAnimationFrame(() => composerRef.current?.focus());
                    }}
                  />
                )}
              </div>
            </div>
          )
        )}
      </div>

      {/* composer — fixed at the bottom of the chat panel; never pushed out */}
      <div className="shrink-0 border-t border-border/60 p-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="flex rounded-md border border-border/60 p-0.5" role="tablist" aria-label="Turn mode">
            {(
              [
                { id: "edit", label: "Edit site" },
                { id: "create", label: "From profile" },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={mode === t.id}
                onClick={() => setMode(t.id)}
                className={cn(
                  "rounded px-2 py-1 text-[11px] transition-colors",
                  mode === t.id ? "bg-gold-soft font-medium text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span
            className={cn(
              "shrink-0 tabular-nums text-[10px]",
              composerChars > COMPOSER_MAX - COMPOSER_WARN_WINDOW ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
            )}
          >
            {composerChars}/{COMPOSER_MAX}
          </span>
        </div>
        <Textarea
          ref={composerRef}
          value={composer}
          onChange={(e) => setComposer(e.target.value.slice(0, COMPOSER_MAX))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const shouldSend = enterToSend ? !e.shiftKey : e.ctrlKey || e.metaKey;
              if (shouldSend) {
                e.preventDefault();
                void send();
              }
            }
          }}
          placeholder={busy ? "Working on your last request…" : "Describe the change — files, sections, colors, motion…"}
          // Comfortable minimum height; grows with the prompt (field-sizing)
          // up to a generous cap for long briefs, then the textarea scrolls
          // internally — the composer can never overflow the panel or cover
          // the conversation, and a 50k-char paste stays editable without
          // lag (plain textarea, no per-keystroke formatting work).
          className="max-h-64 min-h-20 resize-none overflow-y-auto text-sm leading-relaxed"
          aria-label="Message GIFTZ"
          disabled={disabled || busy}
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <p
            className="min-w-0 flex-1 truncate text-[10px] leading-snug text-muted-foreground"
            title={`Changes preview in isolation until you save · ${enterToSend ? "Enter sends, Shift+Enter breaks the line" : "Ctrl/Cmd+Enter sends, Enter breaks the line"}`}
          >
            Changes preview in isolation until you save · {enterToSend ? "Enter sends, Shift+Enter breaks the line" : "Ctrl/Cmd+Enter sends, Enter breaks the line"}
          </p>
          <Button size="sm" className="h-8 shrink-0" onClick={() => void send()} disabled={disabled || busy || composer.trim().length < 2}>
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
            <span className="sr-only">{busy ? "Turn in progress" : "Send message"}</span>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
