"use client";

import { useState } from "react";
import {
  BellOff,
  CalendarClock,
  Check,
  FileText,
  Radar,
  Send,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import type { RiisheActionCard } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * AutomationActionCard — the inline review card the EXISTING RIISHE chat
 * renderer shows for actionable operations (the same side-channel pattern as
 * the delegation card: the message thread itself stays untouched). Every card
 * is review-only by default; the ONLY action that reaches another person is
 * the enquiry Send button, which is an explicit confirmation per draft.
 */
export function AutomationActionCard({ action, onDismiss }: { action: RiisheActionCard; onDismiss: () => void }) {
  return (
    <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-primary/30 bg-gold-soft/40 p-4">
      {action.kind === "creator-results" && <CreatorResults action={action} />}
      {action.kind === "enquiry-draft" && <EnquiryDraft action={action} onDismiss={onDismiss} />}
      {action.kind === "followup-plan" && <FollowupPlan action={action} />}
      {action.kind === "automation-list" && <AutomationList action={action} />}
      {action.kind === "pending-enquiries" && <PendingEnquiries action={action} />}
      {action.kind === "opportunity-list" && <OpportunityList action={action} />}
      {action.kind === "weekly-report" && <WeeklyReport action={action} />}
      {action.kind === "relationship" && <Relationship action={action} />}
      {action.kind === "notes-list" && <NotesList action={action} />}
      {action.kind === "status" && <StatusCard action={action} />}
      {action.kind === "workflow" && <WorkflowCardView action={action} onDismiss={onDismiss} />}
      {action.kind === "shortlist" && <ShortlistCard action={action} />}
    </div>
  );
}

function CardHeader({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-sm font-semibold text-foreground">{title}</p>
      </div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- discovery

function CreatorResults({ action }: { action: Extract<RiisheActionCard, { kind: "creator-results" }> }) {
  const hasAny = action.matches.length > 0 || action.recommendations.length > 0;
  return (
    <div>
      <CardHeader
        icon={<Users className="size-4 text-primary" aria-hidden />}
        title={hasAny ? "Creators from your BEAN Folio data" : "No creators matched"}
        hint={`Criteria: ${action.criteria} · matches vs recommendations are labelled`}
      />
      {hasAny && (
        <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
          {[...action.matches, ...action.recommendations].map((m) => (
            <li key={`${m.kind}-${m.person.username}`} className="rounded-lg border border-border/60 bg-background/70 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="text-sm font-medium text-primary underline-offset-2 hover:underline"
                  onClick={() => navigate(m.profileUrl.replace(/^#/, ""))}
                >
                  {m.person.name} {m.person.username && `(@${m.person.username})`}
                </button>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                    m.kind === "match" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                  )}
                >
                  {m.kind}
                </span>
                {m.person.location && <span className="text-xs text-muted-foreground">{m.person.location}</span>}
              </div>
              {m.person.headline && <p className="mt-0.5 text-xs text-muted-foreground">{m.person.headline}</p>}
              <ul className="mt-1.5 space-y-0.5">
                {m.factors.map((f) => (
                  <li key={f} className="text-xs text-muted-foreground">
                    · {f}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------- enquiry draft

function EnquiryDraft(
  { action, onDismiss }: { action: Extract<RiisheActionCard, { kind: "enquiry-draft" }>; onDismiss: () => void }
) {
  const [state, setState] = useState<"review" | "sending" | "sent" | "error">("review");
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (action.duplicateWarning) return; // guarded — the card shows the warning
    setState("sending");
    setError(null);
    try {
      await api(`/api/riishe/enquiries/${action.taskId}/send`, { method: "POST" });
      setState("sent");
      toast.success("Enquiry sent.");
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "The enquiry couldn't be sent.");
    }
  };

  const dismiss = async () => {
    try {
      await api(`/api/riishe/enquiries/${action.taskId}/send`, { method: "DELETE" });
    } catch {
      /* dismissal failure keeps the draft — never silently lose it */
    }
    onDismiss();
  };

  if (state === "sent") {
    return (
      <div>
        <CardHeader icon={<Check className="size-4 text-primary" aria-hidden />} title="Enquiry sent" hint={`To @${action.recipient.username} — they'll see it in their enquiries.`} />
        <div className="mt-3 flex justify-end">
          <Button size="sm" variant="ghost" onClick={onDismiss}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <CardHeader
        icon={<FileText className="size-4 text-primary" aria-hidden />}
        title="Enquiry draft — review before sending"
        hint={`To @${action.recipient.username} (${action.recipient.name}) · type: ${action.type} · nothing was sent yet`}
      />
      {action.project && (
        <p className="mt-1 text-xs text-muted-foreground">About project: {action.project.title}</p>
      )}
      {action.duplicateWarning && (
        <p role="alert" className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-foreground">
          {action.duplicateWarning}
        </p>
      )}
      <div className="mt-3 space-y-2 rounded-lg border border-border/60 bg-background/70 p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Subject</p>
        <p className="text-sm text-foreground">{action.subject}</p>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Message</p>
        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{action.message}</p>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => void dismiss()}>
          <X className="size-3.5" aria-hidden /> Dismiss
        </Button>
        <Button size="sm" onClick={() => void send()} disabled={state === "sending" || Boolean(action.duplicateWarning)}>
          <Send className="size-3.5" aria-hidden /> {state === "sending" ? "Sending…" : "Send enquiry"}
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- follow-up plan

function FollowupPlan({ action }: { action: Extract<RiisheActionCard, { kind: "followup-plan" }> }) {
  const [dismissed, setDismissed] = useState(false);
  const control = async (act: "pause" | "cancel" | "snooze") => {
    try {
      await api(`/api/riishe/automations/${action.automationId}`, {
        method: "PATCH",
        json: act === "snooze" ? { action: "snooze", days: 1 } : { action: act },
      });
      if (act === "cancel") {
        setDismissed(true);
        toast.success("Reminder cancelled.");
      } else if (act === "pause") {
        toast.success("Reminder paused.");
      } else {
        toast.success("Reminder snoozed by 1 day.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The reminder couldn't be updated.");
    }
  };

  if (dismissed) {
    return <CardHeader icon={<BellOff className="size-4 text-muted-foreground" aria-hidden />} title="Reminder cancelled" />;
  }

  return (
    <div>
      <CardHeader
        icon={<CalendarClock className="size-4 text-primary" aria-hidden />}
        title="Follow-up reminder scheduled"
        hint={`For @${action.recipient.username} · ${new Date(action.runAt).toLocaleString()} · draft prepared, nothing sent automatically`}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        When it fires, RIISHE prepares the follow-up draft below for your review. It cancels itself automatically if
        the enquiry is answered first.
      </p>
      <div className="mt-3 space-y-2 rounded-lg border border-border/60 bg-background/70 p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Prepared draft subject</p>
        <p className="text-sm text-foreground">{action.draftSubject}</p>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => void control("cancel")}>
          <X className="size-3.5" aria-hidden /> Cancel reminder
        </Button>
        <Button size="sm" variant="outline" onClick={() => void control("pause")}>Pause</Button>
        <Button size="sm" variant="outline" onClick={() => void control("snooze")}>Snooze 1 day</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ automation list

function AutomationList({ action }: { action: Extract<RiisheActionCard, { kind: "automation-list" }> }) {
  const [items, setItems] = useState(action.automations);
  const control = async (id: string, act: "pause" | "resume" | "cancel") => {
    try {
      await api(`/api/riishe/automations/${id}`, { method: "PATCH", json: { action: act } });
      setItems((list) =>
        list.map((a) => (a.id === id ? { ...a, status: act === "cancel" ? "CANCELLED" : act === "pause" ? "PAUSED" : "ACTIVE" } : a))
      );
      toast.success(act === "cancel" ? "Cancelled." : act === "pause" ? "Paused." : "Resumed.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The automation couldn't be updated.");
    }
  };
  return (
    <div>
      <CardHeader
        icon={<CalendarClock className="size-4 text-primary" aria-hidden />}
        title={items.length > 0 ? "Your automations" : "No automations yet"}
        hint="Follow-up reminders only prepare drafts — auto-send is off unless you explicitly enable it"
      />
      {items.length > 0 && (
        <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
          {items.map((a) => (
            <li key={a.id} className="rounded-lg border border-border/60 bg-background/70 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">{a.kind.replace(/_/g, " ").toLowerCase()}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{a.status}</span>
                {a.runAt && <span className="text-xs text-muted-foreground">next: {new Date(a.runAt).toLocaleString()}</span>}
                {a.targetLabel && <span className="text-xs text-muted-foreground">· {a.targetLabel}</span>}
              </div>
              {a.lastRunSummary && <p className="mt-1 text-xs text-muted-foreground">Last run: {a.lastRunSummary}</p>}
              {(a.status === "ACTIVE" || a.status === "PAUSED") && (
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  {a.status === "ACTIVE" && (
                    <Button size="sm" variant="outline" onClick={() => void control(a.id, "pause")}>Pause</Button>
                  )}
                  {a.status === "PAUSED" && (
                    <Button size="sm" variant="outline" onClick={() => void control(a.id, "resume")}>Resume</Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void control(a.id, "cancel")}>
                    <X className="size-3.5" aria-hidden /> Cancel
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------- pending enquiries

function PendingEnquiries({ action }: { action: Extract<RiisheActionCard, { kind: "pending-enquiries" }> }) {
  return (
    <div>
      <CardHeader
        icon={<FileText className="size-4 text-primary" aria-hidden />}
        title={action.inquiries.length > 0 ? `Pending enquiries (${action.inquiries.length})` : "No pending enquiries"}
        hint="Enquiries you sent that are still awaiting a reply"
      />
      {action.inquiries.length > 0 && (
        <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
          {action.inquiries.map((i) => (
            <li key={i.id} className="rounded-lg border border-border/60 bg-background/70 p-3">
              <p className="text-sm font-medium text-foreground">{i.subject}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                To {i.counterparty.name} {i.counterparty.username && `(@${i.counterparty.username})`} · {new Date(i.createdAt).toLocaleDateString()}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------ opportunities

function OpportunityList({ action }: { action: Extract<RiisheActionCard, { kind: "opportunity-list" }> }) {
  return (
    <div>
      <CardHeader
        icon={<Radar className="size-4 text-primary" aria-hidden />}
        title={action.items.length > 0 ? "Opportunity Radar" : "No opportunities right now"}
        hint="Built from public platform signals only — every item includes its reason"
      />
      {action.items.length > 0 && (
        <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
          {action.items.map((o, idx) => (
            <li key={`${o.kind}-${idx}`} className="rounded-lg border border-border/60 bg-background/70 p-3">
              <button
                type="button"
                className="text-sm font-medium text-primary underline-offset-2 hover:underline"
                onClick={() => navigate(o.url.replace(/^#/, ""))}
              >
                {o.kind === "project" ? "Project" : "Creator"}: {o.title}
              </button>
              <p className="mt-0.5 text-xs text-muted-foreground">{o.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------ weekly report

function WeeklyReport({ action }: { action: Extract<RiisheActionCard, { kind: "weekly-report" }> }) {
  const r = action.report;
  const rows: Array<[string, number]> = [
    ["New follows you made", r.newFollowsMade],
    ["New followers", r.newFollowersGained],
    ["Enquiries sent", r.enquiriesSent],
    ["Enquiries received", r.enquiriesReceived],
    ["Enquiry responses", r.enquiryResponses],
    ["Outstanding follow-ups", r.outstandingFollowUps],
    ["Saved opportunities", r.savedOpportunities],
    ["Creators discovered", r.discoveredCreators],
  ];
  return (
    <div>
      <CardHeader
        icon={<Sparkles className="size-4 text-primary" aria-hidden />}
        title="Weekly creator growth report"
        hint={`Real counts since ${new Date(r.since).toLocaleDateString()}`}
      />
      <dl className="mt-3 grid grid-cols-2 gap-2">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border/60 bg-background/70 p-2.5">
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-3 space-y-1">
        {r.nextActions.map((a) => (
          <li key={a} className="text-xs text-muted-foreground">· {a}</li>
        ))}
      </ul>
    </div>
  );
}

// -------------------------------------------------------------- relationship

function Relationship({ action }: { action: Extract<RiisheActionCard, { kind: "relationship" }> }) {
  return (
    <div>
      <CardHeader
        icon={<Users className="size-4 text-primary" aria-hidden />}
        title={action.person ? `Relationship — ${action.person.name}${action.person.username ? ` (@${action.person.username})` : ""}` : "Relationship overview"}
        hint={[
          action.person ? (action.following ? "You follow them" : "Not following") : null,
          action.person ? (action.followsYou ? "They follow you" : null) : null,
        ].filter(Boolean).join(" · ") || "Your tracked people and private notes"}
      />
      {action.inquiries.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Enquiries</p>
          <ul className="mt-1 space-y-1">
            {action.inquiries.slice(0, 5).map((i) => (
              <li key={i.id} className="text-xs text-muted-foreground">
                · &ldquo;{i.subject}&rdquo; — {i.status.toLowerCase()}
              </li>
            ))}
          </ul>
        </div>
      )}
      {action.activeReminder && (
        <p className="mt-2 text-xs text-muted-foreground">
          Active follow-up reminder{action.activeReminder.runAt ? ` (next: ${new Date(action.activeReminder.runAt).toLocaleString()})` : ""}
        </p>
      )}
      {action.notes.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your private notes</p>
          <ul className="mt-1 space-y-1">
            {action.notes.slice(0, 5).map((n) => (
              <li key={n.id} className="text-xs text-muted-foreground">
                · {n.status && <span className="uppercase">{n.status} — </span>}{n.note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function NotesList({ action }: { action: Extract<RiisheActionCard, { kind: "notes-list" }> }) {
  return (
    <div>
      <CardHeader
        icon={<FileText className="size-4 text-primary" aria-hidden />}
        title={action.notes.length > 0 ? "Your private notes" : "No notes yet"}
        hint="Only you can see these"
      />
      {action.notes.length > 0 && (
        <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
          {action.notes.map((n) => (
            <li key={n.id} className="rounded-lg border border-border/60 bg-background/70 p-3">
              <p className="text-sm text-foreground">
                {n.status && <span className="mr-1 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{n.status}</span>}
                {n.note}
              </p>
              {n.person && <p className="mt-1 text-xs text-muted-foreground">About {n.person.name}{n.person.username && ` (@${n.person.username})`}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusCard({ action }: { action: Extract<RiisheActionCard, { kind: "status" }> }) {
  return (
    <div>
      <CardHeader icon={<Sparkles className="size-4 text-primary" aria-hidden />} title="Automation update" hint={action.message} />
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => navigate("connect")}>Open enquiries & notifications</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------- advanced agent: workflows

const RISK_STYLES: Record<string, string> = {
  LOW: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  MEDIUM: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  HIGH: "border-orange-500/50 text-orange-600 dark:text-orange-400",
  DESTRUCTIVE: "border-red-500/50 text-red-600 dark:text-red-400",
};

const STEP_STATUS_LABEL: Record<string, string> = {
  PENDING: "Queued",
  AWAITING_APPROVAL: "Needs your approval",
  READY: "Ready",
  RUNNING: "Running",
  SUCCEEDED: "Done",
  FAILED: "Failed",
  SKIPPED: "Skipped",
  CANCELLED: "Cancelled",
};

/**
 * WorkflowCard — the plan + live execution state of a multi-step workflow.
 * HIGH/DESTRUCTIVE steps show an explicit Approve control (Destructive ones
 * additionally require the separate confirm interaction). The chat stays the
 * primary interface; controls here call the same owner-scoped APIs.
 */
function WorkflowCardView({ action, onDismiss }: { action: Extract<RiisheActionCard, { kind: "workflow" }>; onDismiss: () => void }) {
  const [workflow, setWorkflow] = useState(action.workflow);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null); // stepId awaiting the separate confirm

  async function patchWorkflow(actionName: "pause" | "resume" | "cancel") {
    setBusy(actionName);
    try {
      const r = await api<{ workflow: typeof workflow }>(`/api/riishe/workflows/${workflow.id}`, {
        method: "PATCH",
        json: { action: actionName },
      });
      setWorkflow(r.workflow);
      toast.success(actionName === "cancel" ? "Workflow cancelled" : actionName === "pause" ? "Workflow paused" : "Workflow resumed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the workflow");
    } finally {
      setBusy(null);
    }
  }

  async function patchStep(stepId: string, actionName: "approve" | "decline" | "retry", confirm = false) {
    setBusy(stepId + actionName);
    try {
      const r = await api<{ executed?: boolean; declined?: boolean; retried?: boolean; result?: Record<string, unknown> }>(
        `/api/riishe/steps/${stepId}`,
        { method: "PATCH", json: { action: actionName, confirm } }
      );
      // Re-read the workflow to show REAL statuses (results come from the
      // server's execution records, never from optimistic guesses).
      const fresh = await api<{ workflow: typeof workflow }>(`/api/riishe/workflows/${workflow.id}`);
      setWorkflow(fresh.workflow);
      if (actionName === "approve" && r.executed) toast.success("Step executed");
      if (actionName === "decline") toast.success("Step declined");
      if (actionName === "retry") toast.success("Step re-armed");
      if (confirming) setConfirming(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The step could not be updated");
    } finally {
      setBusy(null);
    }
  }

  const steps = workflow.steps;
  const done = steps.filter((s) => s.status === "SUCCEEDED").length;

  return (
    <div>
      <CardHeader
        icon={<WorkflowIcon />}
        title={workflow.title}
        hint={workflow.summary ?? workflow.goal.slice(0, 140)}
      />
      <p className="mt-1 text-xs text-muted-foreground">
        {done}/{steps.length} steps done · status {workflow.status.toLowerCase()}
      </p>
      <ol className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1" aria-label="Workflow steps">
        {steps.map((s) => (
          <li key={s.id} className="rounded-lg border border-border/60 bg-background/70 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">#{s.seq + 1}</span>
              <span className="min-w-0 flex-1 text-sm text-foreground">{s.title}</span>
              <span className={cn("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide", RISK_STYLES[s.risk] ?? "")}>
                {s.risk}
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px]",
                  s.status === "SUCCEEDED" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
                  s.status === "FAILED" && "bg-red-500/15 text-red-600 dark:text-red-400",
                  s.status === "AWAITING_APPROVAL" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                  s.status === "RUNNING" && "bg-primary/15 text-primary",
                  !["SUCCEEDED", "FAILED", "AWAITING_APPROVAL", "RUNNING"].includes(s.status) && "bg-secondary text-secondary-foreground"
                )}
              >
                {STEP_STATUS_LABEL[s.status] ?? s.status}
              </span>
            </div>
            {s.scheduledFor ? (
              <p className="mt-1 text-xs text-muted-foreground">Scheduled for {new Date(s.scheduledFor).toLocaleString()}</p>
            ) : null}
            {s.error ? <p className="mt-1 text-xs text-red-500">{s.error}</p> : null}
            {s.status === "AWAITING_APPROVAL" ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {s.risk === "DESTRUCTIVE" ? (
                  // Separate confirm interaction: first reveal what will
                  // happen, only then can the owner actually approve.
                  confirming === s.id ? (
                    <>
                      <span className="text-xs text-red-500">
                        This will permanently delete the referenced post. This cannot be undone.
                      </span>
                      <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => void patchStep(s.id, "approve", true)}>
                        Confirm and delete
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirming(null)}>
                        Keep the post
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirming(s.id)}>
                      Review before approving
                    </Button>
                  )
                ) : (
                  <>
                    <Button size="sm" disabled={busy !== null} onClick={() => void patchStep(s.id, "approve")}>
                      Approve
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void patchStep(s.id, "decline")}>
                      Decline
                    </Button>
                  </>
                )}
              </div>
            ) : null}
            {s.status === "FAILED" ? (
              <div className="mt-2">
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void patchStep(s.id, "retry")}>
                  Retry step
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {workflow.status === "ACTIVE" ? (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void patchWorkflow("pause")}>
            Pause workflow
          </Button>
        ) : null}
        {workflow.status === "PAUSED" ? (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void patchWorkflow("resume")}>
            Resume workflow
          </Button>
        ) : null}
        {!["COMPLETED", "CANCELLED"].includes(workflow.status) ? (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void patchWorkflow("cancel")}>
            Cancel workflow
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
      </div>
    </div>
  );
}

function WorkflowIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 text-primary" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M9 6h6a3 3 0 0 1 3 3v6" />
      <path d="M15 18H9a3 3 0 0 1-3-3V9" />
    </svg>
  );
}

function ShortlistCard({ action }: { action: Extract<RiisheActionCard, { kind: "shortlist" }> }) {
  return (
    <div>
      <CardHeader
        icon={<Users className="size-4 text-primary" aria-hidden />}
        title={action.added.length > 0 ? "Creators shortlisted" : "Nothing shortlisted"}
        hint="Your shortlist is private — manage it in the automation dashboard."
      />
      {action.added.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Added: {action.added.map((u) => `@${u}`).join(", ")}</p>
      ) : null}
      {action.refused.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {action.refused.map((r) => (
            <li key={r.username} className="text-xs text-muted-foreground">
              @{r.username}: {r.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
