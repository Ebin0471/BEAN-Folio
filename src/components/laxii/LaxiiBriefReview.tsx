"use client";

/**
 * LAXII Phase 3 UI — structured Riishe brief review + quality findings.
 *
 * BriefReviewCard: renders the STRUCTURED brief (every section the pipeline
 * actually uses — request, audience, portfolio, identity, direction, subject,
 * background, composition, palette, exact typography, canvas, safe area,
 * preserve/avoid, export) with the actions the spec requires: approve &
 * generate, targeted revision (bounded), dismiss/cancel.
 *
 * QualityFindingsPanel: renders the pipeline's honest evaluation — measured
 * findings only, never invented scores — plus the refinement trail and the
 * approve/reject decision the export gate enforces.
 */

import { useMemo, useState } from "react";
import {
  Check,
  ClipboardList,
  Loader2,
  Palette,
  Ruler,
  ShieldCheck,
  TriangleAlert,
  Type,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import {
  laxiiApi,
  type LaxiiBriefResponse,
  type LaxiiDesignBrief,
  type LaxiiMessage,
  type LaxiiQualityReport,
} from "@/lib/laxii-client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon} {title}
      </p>
      <div className="mt-1 text-xs leading-relaxed text-foreground/90">{children}</div>
    </div>
  );
}

function BriefFields({ brief }: { brief: LaxiiDesignBrief }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Section icon={<ClipboardList className="size-3" aria-hidden />} title="Your request (exact)">
          {brief.request}
        </Section>
      </div>
      {brief.profession || brief.targetAudience ? (
        <Section icon={<ShieldCheck className="size-3" aria-hidden />} title="Audience">
          {[brief.profession && `Profession: ${brief.profession}`, brief.targetAudience].filter(Boolean).join(" · ")}
        </Section>
      ) : null}
      {brief.portfolio.used && brief.portfolio.summary.length > 0 ? (
        <Section icon={<ShieldCheck className="size-3" aria-hidden />} title="Portfolio context (your own data)">
          <ul className="space-y-0.5">
            {brief.portfolio.summary.map((s, i) => (
              <li key={i}>· {s}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      {brief.subject.description ? (
        <Section icon={<ClipboardList className="size-3" aria-hidden />} title="Subject & focal point">
          {brief.subject.description}
          {brief.subject.focalPoint ? <span className="block text-muted-foreground">{brief.subject.focalPoint}</span> : null}
        </Section>
      ) : null}
      {brief.background ? (
        <Section icon={<Palette className="size-3" aria-hidden />} title="Background & environment">
          {brief.background}
        </Section>
      ) : null}
      {brief.direction ? (
        <Section icon={<ClipboardList className="size-3" aria-hidden />} title="Design direction">
          {brief.direction}
        </Section>
      ) : null}
      <Section icon={<Ruler className="size-3" aria-hidden />} title="Canvas & safe area">
        Exactly {brief.canvas.width}×{brief.canvas.height} px · safe zone {brief.safeArea.width}×{brief.safeArea.height} px centered ·
        export {brief.export.format.toUpperCase()} at exact dimensions
      </Section>
      {brief.composition.hierarchy || brief.composition.notes.length > 0 ? (
        <Section icon={<ClipboardList className="size-3" aria-hidden />} title="Composition & hierarchy">
          {brief.composition.hierarchy}
          {brief.composition.notes.length > 0 ? <span className="block text-muted-foreground">{brief.composition.notes.join(" · ")}</span> : null}
        </Section>
      ) : null}
      {brief.palette.length > 0 ? (
        <Section icon={<Palette className="size-3" aria-hidden />} title="Palette">
          <span className="flex flex-wrap gap-1.5">
            {brief.palette.map((c) => (
              <span key={c} className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5">
                <span className="size-3 rounded-sm border border-white/20" style={{ backgroundColor: c }} aria-hidden />
                <code className="text-[10px]">{c}</code>
              </span>
            ))}
          </span>
        </Section>
      ) : null}
      {brief.typography.items.length > 0 ? (
        <div className="sm:col-span-2">
          <Section icon={<Type className="size-3" aria-hidden />} title="Exact text (rendered deterministically — spelling guaranteed by the engine, not the model)">
            <ul className="space-y-1">
              {brief.typography.items.map((t, i) => (
                <li key={i} className="rounded-lg border border-primary/25 bg-primary/[0.06] px-2 py-1">
                  <span className="mr-1.5 rounded bg-primary/15 px-1 py-0.5 text-[10px] uppercase text-primary">{t.role}</span>
                  <span className="font-medium">“{t.text}”</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      ) : null}
      {brief.visualIdentity.notes.length > 0 ? (
        <Section icon={<Palette className="size-3" aria-hidden />} title="Existing visual identity">
          {brief.visualIdentity.notes.join(" · ")}
        </Section>
      ) : null}
      {brief.avoid.length > 0 ? (
        <Section icon={<X className="size-3" aria-hidden />} title="Avoid">
          {brief.avoid.join(" · ")}
        </Section>
      ) : null}
      {brief.revisions.length > 0 ? (
        <div className="sm:col-span-2">
          <Section icon={<ClipboardList className="size-3" aria-hidden />} title={`Targeted revisions (${brief.revisions.length}/3)`}>
            <ul className="space-y-0.5">
              {brief.revisions.map((r, i) => (
                <li key={i}>
                  · [{r.area}] {r.instruction}
                </li>
              ))}
            </ul>
          </Section>
        </div>
      ) : null}
    </div>
  );
}

export function BriefReviewCard({
  briefTask,
  busy,
  onGenerate,
  onUpdated,
  onDismiss,
}: {
  briefTask: LaxiiBriefResponse;
  busy: boolean;
  onGenerate: () => void;
  onUpdated: (next: LaxiiBriefResponse | null) => void;
  onDismiss: () => void;
}) {
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseArea, setReviseArea] = useState("overall");
  const [reviseText, setReviseText] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const atRevisionLimit = briefTask.brief.revisions.length >= 3;
  const alreadyGenerating = briefTask.task.status === "RUNNING";
  const alreadyGenerated = Boolean(briefTask.generation.messageId);

  async function submitRevision() {
    if (reviseText.trim().length < 3) {
      toast.error("Describe the change you want (at least a few words).");
      return;
    }
    setActionBusy(true);
    try {
      const next = await laxiiApi.briefAction({
        action: "revise",
        taskId: briefTask.task.id,
        area: reviseArea,
        instruction: reviseText.trim(),
      });
      onUpdated(next as LaxiiBriefResponse);
      setReviseText("");
      setReviseOpen(false);
      toast.success("Revision recorded on the brief.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the revision.");
    } finally {
      setActionBusy(false);
    }
  }

  async function cancelBrief() {
    setActionBusy(true);
    try {
      await laxiiApi.briefAction({ action: "cancel", taskId: briefTask.task.id });
      onUpdated(null);
      toast.info("Brief dismissed.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not dismiss the brief.");
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-primary/30 bg-primary/[0.05] p-4" data-testid="laxii-brief-card">
      <div className="flex flex-wrap items-center gap-2">
        <ClipboardList className="size-4 text-primary" aria-hidden />
        <p className="text-sm font-semibold">Design brief from RIISHE</p>
        <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-primary">
          structured handoff
        </span>
        {briefTask.task.error ? (
          <span className="rounded-md bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">{briefTask.task.error}</span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Nothing is generated automatically — review every field below, then create. Your request always outranks the
        inferred portfolio guidance.
      </p>

      <div className="mt-3">
        <BriefFields brief={briefTask.brief} />
      </div>

      {reviseOpen ? (
        <div className="mt-3 space-y-2 rounded-xl border border-white/10 bg-background/60 p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={reviseArea} onValueChange={setReviseArea}>
              <SelectTrigger aria-label="Revision area" className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="overall">Overall</SelectItem>
                <SelectItem value="subject">Subject</SelectItem>
                <SelectItem value="background">Background</SelectItem>
                <SelectItem value="composition">Composition</SelectItem>
                <SelectItem value="palette">Palette</SelectItem>
                <SelectItem value="typography">Typography (text)</SelectItem>
                <SelectItem value="text-placement">Text placement</SelectItem>
                <SelectItem value="safe-area">Safe area</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={reviseText}
              onChange={(e) => setReviseText(e.target.value)}
              placeholder="e.g. make the background cooler and calmer"
              maxLength={600}
              aria-label="Revision instruction"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={submitRevision} disabled={actionBusy}>
              {actionBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null} Record revision
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setReviseOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={onGenerate} disabled={busy || alreadyGenerating} data-testid="laxii-brief-generate">
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
          {alreadyGenerating ? "Generating…" : "Approve brief & generate"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-white/15 bg-white/[0.04]"
          onClick={() => setReviseOpen((v) => !v)}
          disabled={atRevisionLimit || actionBusy}
        >
          Request changes
        </Button>
        {!alreadyGenerating ? (
          <Button size="sm" variant="ghost" onClick={cancelBrief} disabled={actionBusy}>
            Dismiss brief
          </Button>
        ) : null}
      </div>
      {atRevisionLimit ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Revision limit reached (3) — generate with what you have, or start a new brief with RIISHE.
        </p>
      ) : null}
      {alreadyGenerated ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          This brief produced a result — generating again creates a new attempt in the same thread.
        </p>
      ) : null}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  pass: "text-emerald-400",
  warn: "text-amber-400",
  fail: "text-destructive",
};

const STATUS_ICON: Record<string, React.ReactNode> = {
  pass: <Check className="size-3" aria-hidden />,
  warn: <TriangleAlert className="size-3" aria-hidden />,
  fail: <X className="size-3" aria-hidden />,
};

const OVERALL_LABEL: Record<string, string> = {
  pass: "All checks passed",
  warn: "Passed with findings to review",
  fail: "Some checks failed — review before approving",
};

export function QualityFindingsPanel({
  message,
  briefTask,
  onDecision,
  decisionBusy,
}: {
  message: LaxiiMessage;
  briefTask: LaxiiBriefResponse | null;
  onDecision: (decision: "approved" | "rejected") => void;
  decisionBusy: boolean;
}) {
  const report = message.meta?.qualityReport;
  const attempts = message.meta?.pipelineAttempts ?? [];
  const briefTaskId = message.meta?.briefTaskId;
  const approved = briefTask?.generation.approved ?? false;
  const rejected = briefTask?.generation.rejected ?? false;
  const [showAll, setShowAll] = useState(false);

  const grouped = useMemo(() => {
    if (!report) return [];
    const order = { fail: 0, warn: 1, pass: 2 } as const;
    return [...report.findings].sort((a, b) => order[a.status] - order[b.status]);
  }, [report]);

  if (!report && attempts.length === 0 && !briefTaskId) return null;

  const visible = showAll ? grouped : grouped.filter((f) => f.status !== "pass");

  return (
    <div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3" data-testid="laxii-quality-panel">
      {report ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="size-4 text-primary" aria-hidden />
            <p className="text-xs font-semibold">Quality evaluation — {OVERALL_LABEL[report.overall]}</p>
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {report.evaluator === "deterministic+ai-review" ? "measured + advisory AI review" : "measured checks only"}
            </span>
          </div>
          <ul className="space-y-1" data-testid="laxii-quality-findings">
            {visible.map((f) => (
              <li key={f.id} className="flex items-start gap-1.5 text-[11px] leading-relaxed">
                <span className={cn("mt-0.5 shrink-0", STATUS_STYLES[f.status])}>{STATUS_ICON[f.status]}</span>
                <span>
                  {f.check}
                  {f.measured ? <span className="text-muted-foreground"> — {f.measured}</span> : null}
                  {f.note ? <span className="block text-muted-foreground">{f.note}</span> : null}
                </span>
              </li>
            ))}
            {visible.length === 0 ? <li className="text-[11px] text-muted-foreground">Every measured check passed.</li> : null}
          </ul>
          {grouped.length !== visible.length ? (
            <button
              type="button"
              className="text-[11px] text-primary underline-offset-2 hover:underline"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? "Show only findings" : `Show all ${grouped.length} checks`}
            </button>
          ) : null}
          {report.aiReview ? (
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              AI review note: {report.aiReview.note}
            </p>
          ) : null}
        </>
      ) : null}

      {attempts.length > 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="laxii-refinement-trail">
          Refinement trail: {attempts.length} attempt{attempts.length === 1 ? "" : "s"}
          {attempts.map((a) => ` · #${a.index + 1} ${a.overall}`).join("")}
          {attempts.some((a) => a.refinements.length > 0) ? " — refined only the flagged areas" : ""}
        </p>
      ) : null}

      {briefTaskId ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-2">
          {approved ? (
            <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-400" data-testid="laxii-approved">
              <Check className="size-3.5" aria-hidden /> Approved — export unlocked
            </p>
          ) : rejected ? (
            <p className="text-xs text-muted-foreground">Result rejected — revise the brief above and generate again.</p>
          ) : (
            <>
              <Button
                size="sm"
                className="h-7 gap-1.5 text-[11px]"
                onClick={() => onDecision("approved")}
                disabled={decisionBusy}
                data-testid="laxii-approve-result"
              >
                {decisionBusy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Check className="size-3" aria-hidden />}
                Approve result
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 border-white/15 bg-white/[0.04] text-[11px]"
                onClick={() => onDecision("rejected")}
                disabled={decisionBusy}
                data-testid="laxii-reject-result"
              >
                <X className="size-3" aria-hidden /> Reject
              </Button>
              <span className="text-[10px] text-muted-foreground">Export stays locked until you approve.</span>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Compact live pipeline progress for RUNNING brief jobs. */
export function BriefPipelineProgress({ meta }: { meta: LaxiiMessage["meta"] }) {
  if (!meta?.stageLabel) return null;
  return (
    <div className="space-y-1" data-testid="laxii-pipeline-progress">
      <p className="text-xs font-medium text-primary">{meta.stageLabel}</p>
      {typeof meta.stageAttempt === "number" && typeof meta.stageMaxAttempts === "number" ? (
        <p className="text-[10px] text-muted-foreground">
          Attempt {meta.stageAttempt} of {meta.stageMaxAttempts}
          {meta.stageDetail ? ` — ${meta.stageDetail}` : ""}
        </p>
      ) : null}
    </div>
  );
}
