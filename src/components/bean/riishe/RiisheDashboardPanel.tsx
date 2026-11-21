"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  RefreshCw,
  ShieldCheck,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/client";
import type { RiisheWorkflowDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * RiisheDashboardPanel — the automation monitoring surface inside the
 * EXISTING RIISHE interface (the chat remains the primary interface; this
 * panel is reachable from the chat header). It reads REAL persistent records
 * only: active automations, live workflows with per-step state, pending
 * approvals, scheduled jobs, completed/failed history. Controls (retry /
 * decline) call the same owner-scoped APIs the chat cards use.
 */

interface DashboardDTO {
  automations: {
    id: string;
    kind: string;
    status: string;
    nextRunAt: string | null;
    lastRunSummary?: string | null;
  }[];
  workflows: RiisheWorkflowDTO[];
  scheduled: { id: string; kind: string; status: string; runAt: string; attempts: number; maxAttempts: number }[];
  history: { id: string; status: string; result: Record<string, unknown> | null; error: string | null; createdAt: string }[];
  approvals: {
    pendingSteps: { workflowId: string; workflowTitle: string; stepId: string; seq: number; title: string; tool: string; risk: string }[];
    enquiryDrafts: number;
  };
  failures: { workflowId: string; workflowTitle: string; stepId: string; title: string; tool: string; error: string | null; attempts: number; maxAttempts: number }[];
  automationPolicy?: {
    preferences: {
      autoRunLevel1: boolean;
      confirmEachLevel2: boolean;
      allowedLevel2Categories: string[];
      dailyActionCap: number;
    };
    cap: { cap: number; executedToday: number; allowed: boolean; defaultCap: number };
    catalog: {
      name: string;
      title: string;
      risk: string;
      level: number;
      category: string;
      approvalRequired: boolean;
      undo: { supported: boolean; how: string | null } | null;
    }[];
  };
  counts: {
    activeAutomations: number;
    pausedAutomations: number;
    activeWorkflows: number;
    pendingApprovals: number;
    scheduledJobs: number;
    failedSteps: number;
  };
}

export function RiisheDashboardPanel({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<DashboardDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setFailure(null);
    try {
      const res = await api<DashboardDTO>("/api/riishe/dashboard");
      setData(res);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : "The dashboard is unavailable right now.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex h-full flex-col gap-4" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <Skeleton className="min-h-[240px] flex-1 rounded-xl" />
      </div>
    );
  }

  if (failure || !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <AlertTriangle className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{failure ?? "The dashboard is unavailable right now."}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="size-3.5" aria-hidden /> Try again
        </Button>
        <Button variant="ghost" size="sm" onClick={onBack}>Back to chat</Button>
      </div>
    );
  }

  const c = data.counts;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 pb-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to chat">
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">Automation dashboard</h2>
          <p className="text-xs text-muted-foreground">
            Live status from real execution records — chat stays the primary interface.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load(true)}>
          <RefreshCw className="size-3.5" aria-hidden /> Refresh
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
        {/* counts */}
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Count label="Active automations" value={c.activeAutomations} />
          <Count label="Paused automations" value={c.pausedAutomations} />
          <Count label="Live workflows" value={c.activeWorkflows} />
          <Count label="Pending approvals" value={c.pendingApprovals} accent={c.pendingApprovals > 0} />
          <Count label="Scheduled jobs" value={c.scheduledJobs} />
          <Count label="Failed steps" value={c.failedSteps} accent={c.failedSteps > 0} danger />
        </div>

        {/* automation policy (B2): live permission levels + daily action cap */}
        {data.automationPolicy ? (
          <Section
            icon={<ShieldCheck className="size-4 text-primary" aria-hidden />}
            title="Automation policy"
            hint={`Level 1 runs automatically · Level 2 waits for your confirmation · Level 3 needs typed confirmation. Today: ${data.automationPolicy.cap.executedToday}/${data.automationPolicy.cap.cap} actions used.`}
          >
            <ul className="space-y-1.5">
              {data.automationPolicy.catalog.map((t) => (
                <li key={t.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-sm">
                  <span className="font-medium text-foreground">{t.title}</span>
                  <span className="text-xs text-muted-foreground">{t.name}</span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px]",
                      t.level === 1
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : t.level === 2
                          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                          : "bg-red-500/15 text-red-600 dark:text-red-400"
                    )}
                  >
                    L{t.level}{t.approvalRequired ? " · confirm" : " · auto"}
                  </span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] text-secondary-foreground">{t.category}</span>
                  {t.undo ? (
                    <span className={cn("text-[10px]", t.undo.supported ? "text-muted-foreground" : "text-red-600/80 dark:text-red-400/80")}>
                      {t.undo.supported ? "reversible" : "irreversible"}
                    </span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">read-only</span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* pending approvals */}
        <Section
          icon={<ClipboardCheck className="size-4 text-primary" aria-hidden />}
          title="Pending approvals"
          hint="High-risk steps wait here until you approve them explicitly."
        >
          {data.approvals.pendingSteps.length === 0 && data.approvals.enquiryDrafts === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing waiting for you.</p>
          ) : (
            <ul className="space-y-2">
              {data.approvals.pendingSteps.map((s) => (
                <ApprovalRow key={s.stepId} step={s} onChanged={() => void load(true)} />
              ))}
              {data.approvals.enquiryDrafts > 0 ? (
                <li className="rounded-lg border border-border/60 bg-background/70 p-3 text-sm text-foreground">
                  {data.approvals.enquiryDrafts} enquiry draft{data.approvals.enquiryDrafts === 1 ? "" : "s"} awaiting review
                </li>
              ) : null}
            </ul>
          )}
        </Section>

        {/* workflows */}
        <Section
          icon={<WorkflowIcon className="size-4 text-primary" aria-hidden />}
          title="Active workflows"
          hint="Step-level execution state — every row is a real record."
        >
          {data.workflows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No workflows running. Ask RIISHE to plan one.</p>
          ) : (
            <ul className="space-y-3">
              {data.workflows.map((w) => (
                <WorkflowRow key={w.id} workflow={w} />
              ))}
            </ul>
          )}
        </Section>

        {/* automations */}
        <Section
          icon={<CalendarClock className="size-4 text-primary" aria-hidden />}
          title="Scheduled automations"
          hint="Follow-up reminders, weekly summaries and radar refreshes."
        >
          {data.automations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No automations scheduled.</p>
          ) : (
            <ul className="space-y-2">
              {data.automations.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background/70 p-3 text-sm">
                  <span className="font-medium text-foreground">{a.kind.replace(/_/g, " ").toLowerCase()}</span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px]",
                      a.status === "ACTIVE" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-secondary text-secondary-foreground"
                    )}
                  >
                    {a.status.toLowerCase()}
                  </span>
                  {a.nextRunAt ? (
                    <span className="text-xs text-muted-foreground">next: {new Date(a.nextRunAt).toLocaleString()}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* scheduled jobs */}
        <Section
          icon={<CalendarClock className="size-4 text-muted-foreground" aria-hidden />}
          title="Queue (scheduled jobs)"
          hint="The durable jobs that will run for you, with retry state."
        >
          {data.scheduled.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing in the queue right now.</p>
          ) : (
            <ul className="space-y-2">
              {data.scheduled.map((j) => (
                <li key={j.id} className="rounded-lg border border-border/60 bg-background/70 p-3 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{j.kind}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    runs {new Date(j.runAt).toLocaleString()} · attempt {j.attempts}/{j.maxAttempts} · {j.status.toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* failures */}
        {data.failures.length > 0 ? (
          <Section
            icon={<AlertTriangle className="size-4 text-red-500" aria-hidden />}
            title="Failed steps"
            hint="Honest failures with the real error — retry or decline them in chat."
          >
            <ul className="space-y-2">
              {data.failures.map((f) => (
                <li key={f.stepId} className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm">
                  <p className="text-foreground">
                    {f.title} <span className="text-xs text-muted-foreground">({f.tool})</span>
                  </p>
                  <p className="mt-0.5 text-xs text-red-500">{f.error ?? "failed"}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {f.workflowTitle} · attempt {f.attempts}/{f.maxAttempts}
                  </p>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* history */}
        <Section
          icon={<CheckCircle2 className="size-4 text-muted-foreground" aria-hidden />}
          title="Recent execution history"
          hint="What the engine actually did, including failures."
        >
          {data.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {data.history.map((h) => (
                <li key={h.id} className="rounded-lg border border-border/60 bg-background/70 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px]",
                        h.status === "SUCCEEDED" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-red-500/15 text-red-600 dark:text-red-400"
                      )}
                    >
                      {h.status.toLowerCase()}
                    </span>
                    <span className="text-xs text-muted-foreground">{new Date(h.createdAt).toLocaleString()}</span>
                  </div>
                  {h.error ? <p className="mt-1 text-xs text-red-500">{h.error}</p> : null}
                  {h.result ? (
                    <p className="mt-1 line-clamp-2 font-mono text-[11px] text-muted-foreground">{JSON.stringify(h.result).slice(0, 200)}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function Count({ label, value, accent, danger }: { label: string; value: number; accent?: boolean; danger?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        danger && value > 0 ? "border-red-500/40 bg-red-500/5" : accent && value > 0 ? "border-primary/40 bg-primary/5" : "border-border/60 bg-background/70"
      )}
    >
      <p className={cn("text-2xl font-semibold", danger && value > 0 ? "text-red-500" : accent && value > 0 ? "text-primary" : "text-foreground")}>
        {value}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/60 bg-card/50 p-4">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function WorkflowRow({ workflow }: { workflow: RiisheWorkflowDTO }) {
  const done = workflow.steps.filter((s) => s.status === "SUCCEEDED").length;
  return (
    <li className="rounded-lg border border-border/60 bg-background/70 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{workflow.title}</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px]",
            workflow.status === "ACTIVE" ? "bg-primary/15 text-primary" : "bg-secondary text-secondary-foreground"
          )}
        >
          {workflow.status.toLowerCase()}
        </span>
        <span className="text-xs text-muted-foreground">
          {done}/{workflow.steps.length} steps
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {workflow.steps
          .map((s) => `${s.seq + 1}:${s.status === "SUCCEEDED" ? "ok" : s.status === "FAILED" ? "failed" : s.status === "RUNNING" ? "run" : s.status === "AWAITING_APPROVAL" ? "review" : "wait"}`)
          .join("  ")}
      </p>
    </li>
  );
}

/** Pending-approval row with the SAME explicit approve/decline contract as chat. */
function ApprovalRow({
  step,
  onChanged,
}: {
  step: { workflowId: string; workflowTitle: string; stepId: string; seq: number; title: string; tool: string; risk: string };
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function act(action: "approve" | "decline", confirm = false) {
    setBusy(true);
    try {
      await api(`/api/riishe/steps/${step.stepId}`, { method: "PATCH", json: { action, confirm } });
      toast.success(action === "approve" ? "Step executed" : "Step declined");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The step could not be updated");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border border-border/60 bg-background/70 p-3">
      <p className="text-sm text-foreground">
        {step.title} <span className="text-xs text-muted-foreground">({step.tool}, risk {step.risk})</span>
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">Workflow: {step.workflowTitle}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {step.risk === "DESTRUCTIVE" ? (
          confirming ? (
            <>
              <span className="text-xs text-red-500">This will permanently delete the referenced post.</span>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => void act("approve", true)}>
                Confirm and delete
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Keep the post
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
                Review before approving
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("decline")}>
                Decline
              </Button>
            </>
          )
        ) : (
          <>
            <Button size="sm" disabled={busy} onClick={() => void act("approve")}>
              Approve
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("decline")}>
              Decline
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
