"use client";

/**
 * CODE GIFTZ — Engineering workspace (Phase 4).
 *
 * Repository explorer · task composer · plan review (approval gate) ·
 * live execution timeline · per-file diff viewer · terminal output ·
 * test results · completion report · task history.
 * Visual language: BEAN Folio obsidian + champagne gold, consistent with
 * the RIISHE and LAXII workspaces. No provider branding anywhere.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleX,
  Clock,
  FileCode2,
  FileDiff,
  FolderTree,
  GitBranch,
  History,
  ListChecks,
  Play,
  RefreshCw,
  ShieldAlert,
  Terminal,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/bean/EmptyState";
import { Spinner } from "@/components/bean/Spinner";
import { GiftzCapabilitySwitcher } from "@/components/bean/GiftzCapabilitySwitcher";
import { GiftzHandoffSection } from "@/components/bean/site/GiftzHandoffPanel";
import { ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";
import {
  giftzApi,
  type CommandRunDTO,
  type FileDiffDTO,
  type GiftzRepositoryDTO,
  type InspectionDigestDTO,
  type TaskDetailDTO,
  type TaskListItemDTO,
} from "@/lib/giftz-client";

// ------------------------------------------------------------------ constants

const LIFECYCLE: { key: string; label: string }[] = [
  { key: "inspect", label: "Inspect" },
  { key: "plan", label: "Plan" },
  { key: "approve", label: "Approve" },
  { key: "execute", label: "Execute" },
  { key: "validate", label: "Validate" },
  { key: "test", label: "Test" },
  { key: "diff", label: "Diff" },
  { key: "report", label: "Report" },
];

const ACTIVE_STATUSES = new Set(["QUEUED", "ANALYZING", "PLANNING", "EXECUTING", "VALIDATING", "TESTING"]);

function statusTone(status: string): string {
  if (status === "COMPLETED") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  if (status === "FAILED") return "border-red-500/40 bg-red-500/10 text-red-300";
  if (status === "CANCELLED") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  if (ACTIVE_STATUSES.has(status)) return "border-[#c8a24a]/50 bg-[#c8a24a]/10 text-[#e5c878]";
  return "border-white/15 bg-white/5 text-white/60";
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtMs(n: number): string {
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;
}

// ------------------------------------------------------------------ view

export default function GiftzView() {
  const [repos, setRepos] = useState<GiftzRepositoryDTO[] | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [digest, setDigest] = useState<InspectionDigestDTO | null>(null);
  const [digestLoading, setDigestLoading] = useState(false);
  const [tasks, setTasks] = useState<TaskListItemDTO[] | null>(null);
  const [task, setTask] = useState<TaskDetailDTO | null>(null);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshRepos = useCallback(async () => {
    try {
      setRepos(await giftzApi.listRepositories());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not load repositories");
    }
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      const data = await giftzApi.listTasks();
      setTasks(data.tasks);
      return data.tasks;
    } catch {
      return null;
    }
  }, []);

  const loadTask = useCallback(async (id: string) => {
    try {
      setTask(await giftzApi.getTask(id));
    } catch {
      /* task vanished — history refresh will show the truth */
    }
  }, []);

  useEffect(() => {
    void refreshRepos();
    void refreshTasks();
  }, [refreshRepos, refreshTasks]);

  // Live polling while a task is active.
  useEffect(() => {
    if (!task || !ACTIVE_STATUSES.has(task.status)) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      void giftzApi
        .getTask(task.id)
        .then(setTask)
        .then(() => void refreshTasks())
        .catch(() => undefined);
    }, 2000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [task, refreshTasks]);

  const selectRepo = useCallback(async (id: string) => {
    setSelectedRepoId(id);
    setDigest(null);
    setDigestLoading(true);
    try {
      const data = await giftzApi.getRepository(id);
      setDigest(data.digest);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Inspection failed");
    } finally {
      setDigestLoading(false);
    }
  }, []);

  const createRepo = useCallback(async () => {
    setBusy("create-repo");
    try {
      const repo = await giftzApi.createRepository();
      await refreshRepos();
      await selectRepo(repo.id);
      toast.success("Workspace created — ledger-kit starter repository");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not create workspace");
    } finally {
      setBusy(null);
    }
  }, [refreshRepos, selectRepo]);

  const deleteRepo = useCallback(
    async (id: string) => {
      setBusy(`delete-${id}`);
      try {
        await giftzApi.deleteRepository(id);
        if (selectedRepoId === id) {
          setSelectedRepoId(null);
          setDigest(null);
        }
        await refreshRepos();
        toast.success("Workspace removed");
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Could not remove workspace");
      } finally {
        setBusy(null);
      }
    },
    [refreshRepos, selectedRepoId],
  );

  const submitTask = useCallback(async () => {
    if (!selectedRepoId || request.trim().length < 8) return;
    setBusy("create-task");
    try {
      const out = await giftzApi.createTask(selectedRepoId, request.trim());
      if (out.duplicate) toast.info("Re-attached to the active task for this repository");
      setRequest("");
      await loadTask(out.taskId);
      await refreshTasks();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not create the task");
    } finally {
      setBusy(null);
    }
  }, [selectedRepoId, request, refreshTasks, loadTask]);

  const action = useCallback(
    async (kind: "approve" | "reject" | "cancel" | "retry" | "revert", taskId: string) => {
      setBusy(`${kind}-${taskId}`);
      try {
        if (kind === "approve") {
          await giftzApi.approveTask(taskId);
          toast.success("Approved — executing inside the isolated workspace");
        } else if (kind === "reject") {
          await giftzApi.rejectTask(taskId);
          toast.info("Plan rejected — nothing was executed");
        } else if (kind === "cancel") {
          await giftzApi.cancelTask(taskId);
          toast.info("Cancellation requested — running commands are killed");
        } else if (kind === "retry") {
          await giftzApi.retryTask(taskId);
          toast.info("Retrying execution");
        } else {
          const out = await giftzApi.revertTask(taskId);
          toast.success(`Reverted ${out.restoredFiles.length} file(s) to the baseline`);
        }
        await loadTask(taskId);
        await refreshTasks();
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Action failed");
      } finally {
        setBusy(null);
      }
    },
    [loadTask, refreshTasks],
  );

  const hasActive = useMemo(() => tasks?.some((t) => ACTIVE_STATUSES.has(t.status)) ?? false, [tasks]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      {/* Header — one agent, two capabilities (switcher is the bridge) */}
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl border border-[#c8a24a]/40 bg-[#c8a24a]/10">
            <Terminal className="size-5 text-[#e5c878]" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">Code Giftz</h1>
            <p className="text-sm text-white/55">
              Controlled engineering agent · BEAN Intelligence gateway · isolated workspaces, approval-gated execution
            </p>
          </div>
          <GiftzCapabilitySwitcher className="ml-auto" />
        </div>
      </header>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[320px_1fr]">
        {/* Left: repositories + history */}
        <div className="flex min-w-0 flex-col gap-6">
          <Card className="border-white/10 bg-[#0d0f14]">
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-white/85">
                  <FolderTree className="size-4 text-[#c8a24a]" aria-hidden /> Repositories
                </h2>
                <Button size="sm" variant="outline" onClick={() => void createRepo()} disabled={busy === "create-repo"} className="border-[#c8a24a]/40 text-[#e5c878] hover:bg-[#c8a24a]/10">
                  {busy === "create-repo" ? <Spinner className="size-3.5" /> : <Play className="size-3.5" aria-hidden />}
                  New workspace
                </Button>
              </div>
              {repos === null ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full bg-white/5" />
                  <Skeleton className="h-12 w-full bg-white/5" />
                </div>
              ) : repos.length === 0 ? (
                <p className="py-4 text-center text-xs text-white/45">No workspaces yet. Create one to begin — each is a real, runnable bun/TypeScript repository.</p>
              ) : (
                <ul className="space-y-2">
                  {repos.map((repo) => (
                    <li key={repo.id}>
                      <button
                        onClick={() => void selectRepo(repo.id)}
                        className={cn(
                          "w-full min-w-0 rounded-lg border px-3 py-2 text-left transition-colors",
                          selectedRepoId === repo.id ? "border-[#c8a24a]/50 bg-[#c8a24a]/10" : "border-white/10 bg-white/[0.03] hover:border-white/25",
                        )}
                      >
                        <span className="flex min-w-0 items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-sm font-medium text-white/90">{repo.name}</span>
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={`Delete ${repo.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void deleteRepo(repo.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.stopPropagation();
                                void deleteRepo(repo.id);
                              }
                            }}
                            className="text-white/30 hover:text-red-300"
                          >
                            {busy === `delete-${repo.id}` ? <Spinner className="size-3.5" /> : <Trash2 className="size-3.5" aria-hidden />}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-[11px] text-white/45">
                          {repo.fileCount} files · {fmtBytes(repo.sizeBytes)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Repository inspection */}
          {digestLoading || digest ? (
            <Card className="border-white/10 bg-[#0d0f14]">
              <CardContent className="p-4">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white/85">
                  <GitBranch className="size-4 text-[#c8a24a]" aria-hidden /> Inspection
                </h2>
                {digestLoading || !digest ? (
                  <Skeleton className="h-24 w-full bg-white/5" />
                ) : (
                  <RepoDigest digest={digest} />
                )}
              </CardContent>
            </Card>
          ) : null}

          {/* Task history */}
          <Card className="border-white/10 bg-[#0d0f14]">
            <CardContent className="p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white/85">
                <History className="size-4 text-[#c8a24a]" aria-hidden /> Task history
              </h2>
              {tasks === null ? (
                <Skeleton className="h-16 w-full bg-white/5" />
              ) : tasks.length === 0 ? (
                <p className="py-3 text-center text-xs text-white/45">No engineering tasks yet.</p>
              ) : (
                <ul className="max-h-72 space-y-2 overflow-y-auto pr-1 [scrollbar-width:thin]">
                  {tasks.map((t) => (
                    <li key={t.id}>
                      <button
                        onClick={() => void loadTask(t.id)}
                        className={cn(
                          "w-full min-w-0 rounded-lg border px-3 py-2 text-left transition-colors",
                          task?.id === t.id ? "border-[#c8a24a]/50 bg-[#c8a24a]/10" : "border-white/10 bg-white/[0.03] hover:border-white/25",
                        )}
                      >
                        <span className="flex min-w-0 items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-xs font-medium text-white/85">{t.title}</span>
                          <Badge variant="outline" className={cn("shrink-0 text-[10px]", statusTone(t.status))}>
                            {t.status}
                          </Badge>
                        </span>
                        <span className="mt-0.5 block text-[11px] text-white/40">
                          {t.repoName ?? "repository removed"} · {t.validationStatus ? t.validationStatus.replace("_", " ") : "pending"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: task workspace */}
        <div className="flex min-w-0 flex-col gap-6">
          {/* Phase 5: cross-capability handoffs (CODE GIFTZ ⇄ LAXII) */}
          <GiftzHandoffSection repos={repos} selectedRepoId={selectedRepoId} />

          {/* Composer */}
          <Card className="border-white/10 bg-[#0d0f14]">
            <CardContent className="p-4">
              <h2 className="mb-2 text-sm font-semibold text-white/85">New engineering task</h2>
              {hasActive ? (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  A task is already active on one of your repositories — it must finish (or be cancelled) before a new one starts.
                </p>
              ) : (
                <>
                  <Textarea
                    value={request}
                    onChange={(e) => setRequest(e.target.value)}
                    placeholder={
                      selectedRepoId
                        ? 'e.g. "sumAmounts returns the wrong total when a debit exists — fix it and make the tests pass"'
                        : "Create and select a repository first."
                    }
                    rows={3}
                    maxLength={2000}
                    disabled={!selectedRepoId}
                    className="border-white/10 bg-white/[0.04] text-sm text-white/90 placeholder:text-white/30"
                  />
                  <div className="mt-3 flex items-center justify-between">
                    <p className="text-[11px] text-white/40">
                      The agent inspects the repository, proposes a validated plan, and waits for your approval. Nothing runs without it.
                    </p>
                    <Button
                      onClick={() => void submitTask()}
                      disabled={!selectedRepoId || request.trim().length < 8 || busy === "create-task"}
                      className="bg-[#c8a24a] text-black hover:bg-[#d9b45e]"
                    >
                      {busy === "create-task" ? <Spinner className="size-4" /> : <ListChecks className="size-4" aria-hidden />}
                      Inspect &amp; plan
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {task === null ? (
            <EmptyState
              icon={Terminal}
              title="No task selected"
              description="Create a workspace, describe an engineering task, review the plan, then approve execution."
            />
          ) : (
            <>
              <TaskTimeline task={task} onCancel={() => void action("cancel", task.id)} busy={busy} />
              {task.status === "AWAITING_APPROVAL" && task.result.plan ? (
                <PlanReview task={task} onApprove={() => void action("approve", task.id)} onReject={() => void action("reject", task.id)} busy={busy} />
              ) : null}
              {task.status !== "AWAITING_APPROVAL" && task.result.plan ? <PlanSummary task={task} /> : null}
              {task.result.edits.length > 0 ? <EditsSummary task={task} /> : null}
              {task.result.diffs.length > 0 ? <DiffViewer diffs={task.result.diffs} /> : null}
              {task.result.runs.length > 0 ? <TerminalOutput runs={task.result.runs} /> : null}
              {task.result.report ? <ReportCard task={task} onRetry={() => void action("retry", task.id)} onRevert={() => void action("revert", task.id)} busy={busy} /> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ components

function RepoDigest({ digest }: { digest: InspectionDigestDTO }) {
  return (
    <div className="space-y-2 text-xs text-white/70">
      <p>
        <span className="text-white/45">Package:</span> {digest.packageName ?? "—"} · {digest.fileCount} files · {fmtBytes(digest.totalBytes)}
      </p>
      {digest.languages.length > 0 && (
        <p>
          <span className="text-white/45">Languages:</span> {digest.languages.map((l) => `${l.language} (${l.files})`).join(", ")}
        </p>
      )}
      {digest.frameworks.length > 0 && (
        <p>
          <span className="text-white/45">Frameworks:</span> {digest.frameworks.join(", ")}
        </p>
      )}
      {digest.scripts.length > 0 && (
        <p>
          <span className="text-white/45">Scripts:</span>{" "}
          {digest.scripts.map((s) => (
            <code key={s.name} className="mr-1 rounded bg-white/[0.06] px-1 py-0.5 text-[10px] text-[#e5c878]">
              bun run {s.name}
            </code>
          ))}
        </p>
      )}
      {digest.testFiles.length > 0 && (
        <p className="truncate">
          <span className="text-white/45">Tests:</span> {digest.testFiles.join(", ")}
        </p>
      )}
      <p>
        <span className="text-white/45">Git:</span> {digest.gitInitialized ? (digest.gitClean ? "clean baseline commit" : `${digest.gitPending} uncommitted change(s)`) : "not initialized"}
      </p>
      <p className="text-white/40">
        Not read by policy: {digest.skippedSecrets} secret-named · {digest.skippedBinary} binary · {digest.skippedIgnored} ignored files
      </p>
      <Collapsible>
        <CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-[#c8a24a] hover:underline">
          <ChevronRight className="size-3" aria-hidden /> File tree ({digest.tree.length}
          {digest.treeCapped ? "+, capped" : ""})
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-white/10 bg-black/30 p-2 font-mono text-[10px] text-white/60 [scrollbar-width:thin]">
            {digest.tree.map((e) => (
              <li key={e.path} className={cn(e.kind === "dir" && "text-[#e5c878]/70")}>
                {e.path}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function TaskTimeline({ task, onCancel, busy }: { task: TaskDetailDTO; onCancel: () => void; busy: string | null }) {
  const stepFor = (key: string) => task.steps.find((s) => s.step === key);
  const active = ACTIVE_STATUSES.has(task.status);
  return (
    <Card className="border-white/10 bg-[#0d0f14]">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn("text-[10px]", statusTone(task.status))}>
                {task.status}
              </Badge>
              {task.result.attempts > 0 && <span className="text-[11px] text-white/40">attempt {task.result.attempts}</span>}
            </div>
            <p className="mt-1.5 truncate text-sm text-white/80">{task.request}</p>
          </div>
          {active && (
            <Button size="sm" variant="outline" onClick={onCancel} disabled={busy === `cancel-${task.id}`} className="border-red-500/40 text-red-300 hover:bg-red-500/10">
              {busy === `cancel-${task.id}` ? <Spinner className="size-3.5" /> : <CircleX className="size-3.5" aria-hidden />}
              Cancel
            </Button>
          )}
        </div>
        <Separator className="my-3 bg-white/10" />
        <ol className="flex flex-wrap gap-1.5">
          {LIFECYCLE.map(({ key, label }) => {
            const step = stepFor(key);
            const status = step?.status ?? "pending";
            return (
              <li
                key={key}
                title={step?.note ?? undefined}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]",
                  status === "done" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
                  status === "running" && "border-[#c8a24a]/50 bg-[#c8a24a]/10 text-[#e5c878]",
                  status === "failed" && "border-red-500/40 bg-red-500/10 text-red-300",
                  status === "skipped" && "border-white/15 bg-white/5 text-white/40",
                  status === "pending" && "border-white/10 bg-transparent text-white/30",
                )}
              >
                {status === "done" && <CheckCircle2 className="size-3" aria-hidden />}
                {status === "running" && <Spinner className="size-3" />}
                {status === "failed" && <CircleX className="size-3" aria-hidden />}
                {label}
                {status === "skipped" && " (skipped)"}
              </li>
            );
          })}
        </ol>
        {task.error && <p className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{task.error}</p>}
        {task.result.planIssues && task.result.planIssues.length > 0 && (
          <div className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-amber-200/80">Plan validation findings</p>
            <ul className="mt-1 space-y-1">
              {task.result.planIssues.slice(0, 6).map((issue, i) => (
                <li key={i} className="text-[11px] leading-snug text-amber-100/80">{issue}</li>
              ))}
            </ul>
            {task.result.planRepaired && (
              <p className="mt-1.5 text-[11px] text-amber-200/60">
                Automatic repair was attempted once and the plan still failed validation — retry or rephrase the task.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PlanMeta({ task }: { task: TaskDetailDTO }) {
  const plan = task.result.plan!;
  return (
    <div className="space-y-3 text-sm text-white/75">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#c8a24a]">Objective</h3>
        <p className="mt-1 text-sm text-white/85">{plan.objective}</p>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#c8a24a]">Problem</h3>
        <p className="mt-1 whitespace-pre-wrap text-sm text-white/75">{plan.problemDescription}</p>
      </div>
      {plan.rootCauseHypothesis ? (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#c8a24a]">Root-cause hypothesis</h3>
          <p className="mt-1 text-sm text-white/75">{plan.rootCauseHypothesis}</p>
        </div>
      ) : null}
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#c8a24a]">Files expected to change</h3>
        <ul className="space-y-1">
          {plan.files.map((f) => (
            <li key={`${f.change}-${f.path}`} className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline" className={cn("text-[10px]", f.change === "create" ? "border-emerald-500/40 text-emerald-300" : f.change === "delete" ? "border-red-500/40 text-red-300" : "border-[#c8a24a]/40 text-[#e5c878]")}>
                {f.change}
              </Badge>
              <code className="font-mono text-white/85">{f.path}</code>
              <span className="text-white/45">{f.reason}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#c8a24a]">Steps</h3>
        <ol className="space-y-1.5">
          {plan.steps.map((s, i) => (
            <li key={s.id} className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs">
              <span className="flex flex-wrap items-center gap-2">
                <span className="flex size-4 items-center justify-center rounded-full bg-white/10 text-[9px] text-white/60">{i + 1}</span>
                <span className="font-medium text-white/85">{s.title}</span>
                <Badge variant="outline" className="text-[9px] text-white/50">
                  {s.kind}
                </Badge>
                {s.path && <code className="font-mono text-white/60">{s.path}</code>}
                {s.command && <code className="font-mono text-white/60">→ {s.command}</code>}
                {s.risk !== "low" && <Badge variant="outline" className={cn("text-[9px]", s.risk === "high" ? "border-red-500/40 text-red-300" : "border-amber-500/40 text-amber-300")}>{s.risk} risk</Badge>}
              </span>
              <p className="mt-1 text-white/55">{s.detail}</p>
            </li>
          ))}
        </ol>
      </div>
      {plan.risks.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#c8a24a]">Risks</h3>
          <ul className="space-y-1">
            {plan.risks.map((r, i) => (
              <li key={i} className="text-xs text-white/65">
                <span className={cn("mr-1.5 font-medium", r.level === "high" ? "text-red-300" : r.level === "medium" ? "text-amber-300" : "text-white/50")}>{r.level}:</span>
                {r.note}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#c8a24a]">Validation strategy</h3>
        <p className="text-sm text-white/75">{plan.validation.strategy}</p>
        <ul className="mt-1.5 space-y-1">
          {plan.validation.commands.map((c) => (
            <li key={c.label} className="flex items-center gap-2 text-xs">
              <Terminal className="size-3 text-[#c8a24a]" aria-hidden />
              <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-[#e5c878]">{c.argv.join(" ")}</code>
              <span className="text-white/45">{c.label}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#c8a24a]">Expected outcome</h3>
        <p className="mt-1 text-sm text-white/75">{plan.expectedOutcome}</p>
      </div>
      {plan.dependencies.length > 0 && (
        <p className="text-xs text-white/45">External dependencies needed: {plan.dependencies.join(", ")}</p>
      )}
    </div>
  );
}

function PlanReview({ task, onApprove, onReject, busy }: { task: TaskDetailDTO; onApprove: () => void; onReject: () => void; busy: string | null }) {
  return (
    <Card className="border-[#c8a24a]/30 bg-[#0d0f14]">
      <CardContent className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <ShieldAlert className="size-4 text-[#e5c878]" aria-hidden />
          <h2 className="text-sm font-semibold text-white/90">Plan awaiting your approval</h2>
          <Badge variant="outline" className="border-[#c8a24a]/40 text-[10px] text-[#e5c878]">
            schema-validated
          </Badge>
        </div>
        <PlanMeta task={task} />
        {task.result.planRepaired && (
          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
            <p>Note: the plan was repaired once by the validator before it passed.</p>
            {task.result.planRepairIssues && task.result.planRepairIssues.length > 0 && (
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-amber-200/70">
                {task.result.planRepairIssues.slice(0, 4).map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <Separator className="my-4 bg-white/10" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-white/45">
            Approving executes ONLY the steps above, inside the isolated workspace copy. Running commands are allowlisted, time-boxed and their output is redacted.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onReject} disabled={busy === `reject-${task.id}`} className="border-white/20 text-white/70 hover:bg-white/5">
              {busy === `reject-${task.id}` ? <Spinner className="size-4" /> : <X className="size-4" aria-hidden />}
              Reject
            </Button>
            <Button onClick={onApprove} disabled={busy === `approve-${task.id}`} className="bg-[#c8a24a] text-black hover:bg-[#d9b45e]">
              {busy === `approve-${task.id}` ? <Spinner className="size-4" /> : <Play className="size-4" aria-hidden />}
              Approve &amp; execute
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PlanSummary({ task }: { task: TaskDetailDTO }) {
  return (
    <Card className="border-white/10 bg-[#0d0f14]">
      <CardContent className="p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white/85">
          <ListChecks className="size-4 text-[#c8a24a]" aria-hidden /> Approved plan
        </h2>
        <PlanMeta task={task} />
      </CardContent>
    </Card>
  );
}

function EditsSummary({ task }: { task: TaskDetailDTO }) {
  return (
    <Card className="border-white/10 bg-[#0d0f14]">
      <CardContent className="p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white/85">
          <FileCode2 className="size-4 text-[#c8a24a]" aria-hidden /> Applied file changes
        </h2>
        <ul className="space-y-1 text-xs">
          {task.result.edits.map((e, i) => (
            <li key={`${e.path}-${i}`} className="flex flex-wrap items-center gap-2">
              {e.ok ? <CheckCircle2 className="size-3.5 text-emerald-400" aria-hidden /> : <CircleX className="size-3.5 text-red-400" aria-hidden />}
              <code className="font-mono text-white/85">{e.path}</code>
              <Badge variant="outline" className="text-[9px] text-white/50">{e.change}</Badge>
              {e.ok && <span className="text-white/40">{fmtBytes(e.bytes)}</span>}
              {e.error && <span className="text-red-300">{e.error}</span>}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function DiffViewer({ diffs }: { diffs: FileDiffDTO[] }) {
  return (
    <Card className="border-white/10 bg-[#0d0f14]">
      <CardContent className="p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white/85">
          <FileDiff className="size-4 text-[#c8a24a]" aria-hidden /> Diff review
          <span className="text-[11px] font-normal text-white/40">vs baseline commit</span>
        </h2>
        <div className="space-y-3">
          {diffs.map((d) => (
            <div key={d.path} className="overflow-hidden rounded-lg border border-white/10">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-white/[0.04] px-3 py-2">
                <code className="break-all font-mono text-xs text-white/90">{d.path}</code>
                <span className="flex items-center gap-2 text-[10px]">
                  <span className="text-emerald-300">+{d.additions}</span>
                  <span className="text-red-300">−{d.deletions}</span>
                  <Badge variant="outline" className="text-[9px] text-white/50">{d.change}</Badge>
                  {d.truncated && <span className="text-amber-300">truncated</span>}
                </span>
              </div>
              <div className="max-h-80 overflow-auto bg-black/40 p-2 font-mono text-[10.5px] leading-relaxed [scrollbar-width:thin]">
                {d.hunks.map((h, hi) => (
                  <div key={hi}>
                    <div className="text-white/35">{h.header}</div>
                    {h.lines.map((l, li) => (
                      <div
                        key={li}
                        className={cn(
                          "whitespace-pre-wrap break-all",
                          l.type === "add" && "bg-emerald-500/10 text-emerald-200",
                          l.type === "del" && "bg-red-500/10 text-red-200",
                          l.type === "meta" && "text-white/35 italic",
                          l.type === "ctx" && "text-white/55",
                        )}
                      >
                        {l.type === "add" ? "+" : l.type === "del" ? "−" : l.type === "meta" ? "·" : " "}
                        {l.text}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function runTone(status: CommandRunDTO["status"]): string {
  if (status === "passed") return "border-emerald-500/40 text-emerald-300";
  if (status === "failed") return "border-red-500/40 text-red-300";
  return "border-amber-500/40 text-amber-300";
}

function TerminalOutput({ runs }: { runs: CommandRunDTO[] }) {
  const testRuns = runs.filter((r) => r.argv.some((p) => /test/i.test(p)));
  const testSummary = testRuns.length > 0 ? parseCounts(testRuns[testRuns.length - 1]) : null;
  return (
    <Card className="border-white/10 bg-[#0d0f14]">
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white/85">
            <Terminal className="size-4 text-[#c8a24a]" aria-hidden /> Validation &amp; test runs
          </h2>
          {testSummary && (
            <span className="text-[11px] text-white/60">
              tests: <span className="text-emerald-300">{testSummary.passed} passed</span>
              {testSummary.failed > 0 && <span className="text-red-300"> · {testSummary.failed} failed</span>}
            </span>
          )}
        </div>
        <div className="space-y-3">
          {runs.map((run) => (
            <Collapsible key={run.id} className="rounded-lg border border-white/10">
              <CollapsibleTrigger className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left hover:bg-white/[0.03]">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="outline" className={cn("text-[10px]", runTone(run.status))}>
                    {run.status}
                  </Badge>
                  <code className="truncate font-mono text-xs text-white/85">{run.argv.join(" ")}</code>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-[10px] text-white/45">
                  <Clock className="size-3" aria-hidden /> {fmtMs(run.durationMs)}
                  {run.exitCode !== null && <span>exit {run.exitCode}</span>}
                  {run.redactionCount > 0 && <span className="text-amber-300/80">{run.redactionCount} redaction(s)</span>}
                  <ChevronDown className="size-3.5" aria-hidden />
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="max-h-72 space-y-2 overflow-auto border-t border-white/10 bg-black/40 p-3 font-mono text-[10.5px] leading-relaxed [scrollbar-width:thin]">
                  {run.stdoutTail && <pre className="whitespace-pre-wrap break-all text-white/70">{run.stdoutTail}</pre>}
                  {run.stderrTail && <pre className="whitespace-pre-wrap break-all text-red-200/80">{run.stderrTail}</pre>}
                  {(run.stdoutTruncated || run.stderrTruncated) && <p className="text-white/35 italic">Output truncated at the cap — see the full log on disk if needed.</p>}
                </div>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function parseCounts(run: CommandRunDTO): { passed: number; failed: number } | null {
  const text = `${run.stdoutTail}\n${run.stderrTail}`;
  const passMatch = /(\d+) pass/.exec(text);
  const failMatch = /(\d+) fail/.exec(text);
  if (!passMatch && !failMatch) return null;
  return { passed: passMatch ? Number(passMatch[1]) : 0, failed: failMatch ? Number(failMatch[1]) : 0 };
}

function ReportCard({ task, onRetry, onRevert, busy }: { task: TaskDetailDTO; onRetry: () => void; onRevert: () => void; busy: string | null }) {
  const report = task.result.report!;
  const canRevert = task.result.edits.some((e) => e.ok) && !task.result.revert;
  const tone =
    report.validationStatus === "verified"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
      : report.validationStatus === "failed"
        ? "border-red-500/40 bg-red-500/10 text-red-200"
        : "border-amber-500/40 bg-amber-500/10 text-amber-200";
  const verdict =
    report.validationStatus === "verified"
      ? "Verified — the applicable validation checks passed"
      : report.validationStatus === "failed"
        ? "NOT verified — validation commands failed"
        : "NOT verified — validation was not performed";
  return (
    <Card className="border-white/10 bg-[#0d0f14]">
      <CardContent className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-white/85">Completion report</h2>
        <div className={cn("rounded-lg border px-3 py-2 text-xs font-medium", tone)}>{verdict}</div>
        <p className="mt-2 text-sm text-white/75">{report.summary}</p>
        {task.result.revert && (
          <p className="mt-2 text-xs text-white/50">
            Reverted to baseline: {task.result.revert.restoredFiles.join(", ")}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {task.status === "FAILED" && (
            <Button size="sm" variant="outline" onClick={onRetry} disabled={busy === `retry-${task.id}`} className="border-[#c8a24a]/40 text-[#e5c878] hover:bg-[#c8a24a]/10">
              {busy === `retry-${task.id}` ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" aria-hidden />}
              Retry execution
            </Button>
          )}
          {canRevert && (
            <Button size="sm" variant="outline" onClick={onRevert} disabled={busy === `revert-${task.id}`} className="border-white/20 text-white/70 hover:bg-white/5">
              {busy === `revert-${task.id}` ? <Spinner className="size-3.5" /> : <Undo2 className="size-3.5" aria-hidden />}
              Revert applied files
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
