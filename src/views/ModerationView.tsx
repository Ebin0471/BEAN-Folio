"use client";

/**
 * Moderation review queue — ADMIN only.
 *
 * The server is the authority: every data call below hits /api/admin/* which
 * re-checks the ADMIN role server-side. This view renders NotFound for
 * non-admin sessions so the existence of the queue is not advertised.
 */

import { useCallback, useEffect, useState } from "react";
import { Flag, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { EmptyState } from "@/components/bean/EmptyState";
import { Spinner } from "@/components/bean/Spinner";
import { api, formatDate } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

interface ReportTarget {
  exists: boolean;
  id: string;
  title?: string;
  status?: string;
  visibility?: string;
  ownerUsername?: string;
  ownerName?: string;
  username?: string | null;
  name?: string;
  deleted?: boolean;
}

interface ReportItem {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  details: string | null;
  status: string;
  createdAt: string;
  reporter: { id: string; name: string; username: string | null; isDemo: boolean; deleted: boolean };
  target: ReportTarget;
}

interface AuditRow {
  id: string;
  action: string;
  actorUserId: string | null;
  meta: string;
  createdAt: string;
}

interface ProjectTargetSnap {
  id: string;
  title: string;
  summary: string | null;
  status: string;
  visibility: string;
  category: string | null;
  createdAt: string;
  updatedAt: string;
  owner: { id: string; username: string | null; name: string };
}

interface ProfileTargetSnap {
  id: string;
  username: string | null;
  name: string;
  headline: string | null;
  bio: string | null;
  profileVisibility: string;
  isDemo: boolean;
  deletedAt: string | null;
}

interface ReportDetail {
  report: ReportItem;
  reporter: { id: string; name: string; username: string | null; isDemo: boolean; deleted: boolean; joinedAt: string };
  target: { kind: "PROJECT"; project: ProjectTargetSnap } | { kind: "PROFILE"; profile: ProfileTargetSnap } | null;
  auditTrail: AuditRow[];
}

const STATUS_FILTERS = ["OPEN", "REVIEWED", "RESOLVED", "ALL"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function statusBadge(status: string) {
  const map: Record<string, string> = {
    OPEN: "bg-destructive/10 text-destructive border-destructive/30",
    REVIEWED: "bg-amber-500/10 text-amber-600 border-amber-500/30",
    RESOLVED: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30",
  };
  return (
    <Badge variant="outline" className={cn("text-[10px] uppercase tracking-wide", map[status])}>
      {status}
    </Badge>
  );
}

export default function ModerationView() {
  const { user, loading: sessionLoading, error: sessionError, refresh } = useSession();

  const [filter, setFilter] = useState<StatusFilter>("OPEN");
  const [reports, setReports] = useState<ReportItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [note, setNote] = useState("");
  const [patchBusy, setPatchBusy] = useState(false);

  // Non-admin sessions get the standard "not found" screen — never a hint
  // that a moderation area exists. The server enforces the same policy.
  const isAdmin = user?.role === "ADMIN";

  const loadReports = useCallback(async (status: StatusFilter) => {
    setListError(null);
    try {
      const res = await api<{ items: ReportItem[]; total: number }>(
        `/api/admin/reports?status=${encodeURIComponent(status)}&limit=100`
      );
      setReports(res.items);
      setTotal(res.total);
    } catch (err) {
      setReports([]);
      setListError(err instanceof Error ? err.message : "Could not load the review queue.");
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    setReports(null);
    void loadReports(filter);
  }, [filter, isAdmin, loadReports]);

  function openDetail(id: string) {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    setNote("");
    api<ReportDetail>(`/api/admin/reports/${id}`)
      .then((d) => setDetail(d))
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load the report.");
        setDetailOpen(false);
      })
      .finally(() => setDetailLoading(false));
  }

  async function recordOutcome(status: "REVIEWED" | "RESOLVED") {
    if (!detail) return;
    setPatchBusy(true);
    try {
      await api(`/api/admin/reports/${detail.report.id}`, {
        method: "PATCH",
        json: { status, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      toast.success(status === "RESOLVED" ? "Report resolved" : "Marked as reviewed");
      setDetailOpen(false);
      await loadReports(filter);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record the outcome.");
    } finally {
      setPatchBusy(false);
    }
  }

  // ------------------------------------------------------------ guards

  if (sessionLoading) {
    return (
      <div className="grid min-h-[50vh] place-items-center">
        <Spinner label="Checking your session…" />
      </div>
    );
  }
  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <EmptyState
          icon={Flag}
          title="Page not found"
          description="That address doesn't match anything on BEAN Folio."
          action={<Button onClick={() => navigate("/")}>Back to Discover</Button>}
        />
      </div>
    );
  }
  if (sessionError) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <EmptyState
          icon={Flag}
          title="We couldn't verify your session"
          description="A connection problem interrupted the session check. Retry before continuing."
          action={
            <Button variant="outline" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20">
        <EmptyState
          icon={Flag}
          title="Page not found"
          description="That address doesn't match anything on BEAN Folio."
          action={<Button onClick={() => navigate("/")}>Back to Discover</Button>}
        />
      </div>
    );
  }

  // ------------------------------------------------------------ render

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary">Trust &amp; Safety</p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Moderation review
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Reports filed by the community. Outcomes are recorded to the audit trail.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-2 text-sm text-muted-foreground">
          <ShieldCheck className="size-4 text-primary" aria-hidden />
          Admin queue · {total} {filter === "ALL" ? "total" : filter.toLowerCase()}
        </div>
      </header>

      <Tabs value={filter} onValueChange={(v) => setFilter(v as StatusFilter)} className="mb-4">
        <TabsList>
          {STATUS_FILTERS.map((s) => (
            <TabsTrigger key={s} value={s}>
              {s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {reports === null ? (
        <div className="grid min-h-[30vh] place-items-center">
          <Spinner label="Loading reports…" />
        </div>
      ) : listError ? (
        <EmptyState
          icon={Flag}
          title="Could not load reports"
          description={listError}
          action={
            <Button variant="outline" onClick={() => void loadReports(filter)}>
              Try again
            </Button>
          }
        />
      ) : reports.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={filter === "OPEN" ? "No open reports" : "Nothing here"}
          description={
            filter === "OPEN"
              ? "The review queue is clear. New community reports will appear here."
              : "No reports match this filter right now."
          }
        />
      ) : (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card" aria-label="Moderation reports">
          {reports.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => openDetail(r.id)}
                className="flex w-full flex-col gap-2 px-4 py-4 text-left transition-colors hover:bg-accent/50 sm:flex-row sm:items-center sm:gap-4"
                aria-label={`Review report on ${r.targetType === "PROJECT" ? r.target.title ?? "a project" : r.target.name ?? "a profile"}`}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {statusBadge(r.status)}
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {r.targetType === "PROJECT" ? "Project" : "Profile"}
                    </span>
                    <span className="text-sm font-medium text-foreground">
                      {r.targetType === "PROJECT"
                        ? r.target.title ?? "(deleted project)"
                        : r.target.deleted
                          ? "(deactivated profile)"
                          : r.target.name ?? "(unknown profile)"}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    Reason: {r.reason}
                    {r.details ? ` — ${r.details}` : ""}
                  </p>
                  <p className="text-[11px] text-muted-foreground/80">
                    by {r.reporter.name}
                    {r.reporter.username ? ` (@${r.reporter.username})` : ""}
                    {r.reporter.isDemo ? " · demo fixture" : ""}
                    {r.reporter.deleted ? " · account deleted" : ""} · {formatDate(r.createdAt)}
                  </p>
                </div>
                <span className="shrink-0 text-xs font-medium text-primary">Review →</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ------------------------------------------------- review dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">Report review</DialogTitle>
            <DialogDescription>
              Inspect the report, check the reported {detail?.target?.kind === "PROFILE" ? "profile" : "project"}, then
              record an outcome. All decisions are audit-logged.
            </DialogDescription>
          </DialogHeader>

          {detailLoading || !detail ? (
            <div className="grid min-h-40 place-items-center">
              <Spinner label="Loading report…" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-border/60 bg-background/40 p-4 text-sm">
                <div className="mb-2 flex items-center gap-2">
                  {statusBadge(detail.report.status)}
                  <span className="text-xs text-muted-foreground">Filed {formatDate(detail.report.createdAt)}</span>
                </div>
                <p className="font-medium text-foreground">Reason: {detail.report.reason}</p>
                {detail.report.details && (
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{detail.report.details}</p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  Reporter: {detail.reporter.name}
                  {detail.reporter.username ? ` (@${detail.reporter.username})` : ""}
                  {detail.reporter.deleted ? " · account deleted" : ""}
                  {detail.reporter.isDemo ? " · demo fixture" : ""}
                </p>
              </div>

              <div className="rounded-lg border border-border/60 bg-background/40 p-4 text-sm">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Reported {detail.target?.kind === "PROFILE" ? "profile" : "project"}
                </p>
                {detail.target?.kind === "PROJECT" && detail.target.project && (
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">{detail.target.project.title}</p>
                    <p className="text-xs text-muted-foreground">
                      by {detail.target.project.owner.name}
                      {detail.target.project.owner.username ? ` (@${detail.target.project.owner.username})` : ""} ·{" "}
                      {detail.target.project.status} · {detail.target.project.visibility}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-1"
                      onClick={() => navigate(`/p/${detail.report.targetId}`)}
                    >
                      Open project page
                    </Button>
                  </div>
                )}
                {(() => {
                  if (detail.target?.kind !== "PROFILE" || !detail.target.profile) return null;
                  const tp = detail.target.profile;
                  return (
                    <div className="space-y-1">
                      <p className="font-medium text-foreground">{tp.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {tp.username ? `@${tp.username}` : "no username"} · {tp.profileVisibility}
                        {tp.deletedAt ? " · deactivated" : ""}
                      </p>
                      {tp.username ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-1"
                          onClick={() => navigate(`/u/${tp.username}`)}
                        >
                          Open public profile
                        </Button>
                      ) : null}
                    </div>
                  );
                })()}
                {!detail.target && (
                  <p className="text-xs text-muted-foreground">
                    The reported content no longer exists (deleted by its owner).
                  </p>
                )}
              </div>

              {detail.report.status !== "RESOLVED" && (
                <div className="space-y-2">
                  <Label htmlFor="mod-note">Moderation note (internal, optional)</Label>
                  <Textarea
                    id="mod-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="What did you check and what did you decide?"
                    maxLength={2000}
                    rows={3}
                  />
                  <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                    <Button variant="outline" disabled={patchBusy} onClick={() => void recordOutcome("REVIEWED")}>
                      {patchBusy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                      Mark reviewed
                    </Button>
                    <Button disabled={patchBusy} onClick={() => void recordOutcome("RESOLVED")}>
                      {patchBusy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                      Resolve report
                    </Button>
                  </div>
                </div>
              )}
              {detail.report.status === "RESOLVED" && (
                <p className="rounded-md border border-border/60 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
                  This report is resolved and locked. The outcome cannot be changed.
                </p>
              )}

              {detail.auditTrail.length > 0 && (
                <div className="rounded-lg border border-border/60 bg-background/40 p-4">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Audit trail
                  </p>
                  <ul className="max-h-40 space-y-1.5 overflow-y-auto pr-1 text-xs text-muted-foreground" aria-label="Moderation audit trail">
                    {detail.auditTrail.map((a) => (
                      <li key={a.id} className="flex items-start justify-between gap-3">
                        <span className="font-mono text-[11px]">{a.action}</span>
                        <span className="shrink-0">{formatDate(a.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
