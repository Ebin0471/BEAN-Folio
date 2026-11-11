/**
 * CODE GIFTZ durable engineering task store (Phase 4 spec §2, §6, §7, §8).
 *
 * Persistence: every lifecycle transition is written to the `AgentTask` table
 * (agent CODE_GIFTZ, kind ENGINEERING_TASK) — state, lifecycle timeline
 * (stepsJson), plan/edits/diffs/command-runs/report (resultJson), approval
 * status (AWAITING_APPROVAL), ownership (userId) and repository link (repoId).
 * A restart loses nothing; in-flight executions are honestly failed by the
 * stale sweep (they cannot be resumed mid-step) and are retryable.
 *
 * Idempotency / duplicate prevention: at most ONE active task per repository
 * per user — creation while a task is active re-attaches (409 with taskId).
 *
 * Cancellation: cooperative between steps PLUS hard child-process kill
 * (commands.ts killTaskChildren). Retry is bounded by attempts.
 */

import type { AgentTask } from "@prisma/client";
import fs from "node:fs";

import { db } from "@/lib/db";
import { recordAiUsage } from "@/lib/ai";

import { generateWorkspaceDiff, parseUnifiedDiff, revertFiles } from "./diff";
import { inspectRepository } from "./inspect";
import { parsePlanWithRepair } from "./plan";
import { createGatewayGiftzProvider } from "./provider";
import { isSecretPath } from "./redact";
import { killTaskChildren, runCommand, validateCommand } from "./commands";
import { readArtifactBytes } from "@/lib/intelligence/artifacts";
import {
  ACTIVE_STATUSES,
  isTerminalStatus,
  type CommandRun,
  type EngineeringPlan,
  type FileEditRecord,
  type GiftzStepProvider,
  type LifecycleStep,
  type TaskReport,
  type TaskResult,
} from "./types";
import {
  deleteWorkspaceFile,
  readWorkspaceFile,
  runGit,
  WorkspaceError,
  workspaceDir,
  writeWorkspaceFile,
  writeWorkspaceFileBytes,
} from "./workspace";

export const MAX_ATTEMPTS = 3;
export const MAX_REPAIRS = 1;

// ---------------------------------------------------------------------------
// In-flight runner registry (this process only) + cancel flags
// ---------------------------------------------------------------------------

const g = globalThis as unknown as {
  __giftzInFlight?: Set<string>;
  __giftzCancelRequested?: Set<string>;
};
g.__giftzInFlight ??= new Set<string>();
g.__giftzCancelRequested ??= new Set<string>();

function inFlight(): Set<string> {
  return g.__giftzInFlight!;
}
function cancelFlags(): Set<string> {
  return g.__giftzCancelRequested!;
}

export function isTaskInFlight(taskId: string): boolean {
  return inFlight().has(taskId);
}

export function isCancelRequested(taskId: string): boolean {
  return cancelFlags().has(taskId);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GiftzTaskError extends Error {
  readonly status: number;
  readonly taskId?: string;
  constructor(message: string, status = 400, taskId?: string) {
    super(message);
    this.name = "GiftzTaskError";
    this.status = status;
    this.taskId = taskId;
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function parseSteps(raw: string | null): LifecycleStep[] {
  try {
    const arr = JSON.parse(raw ?? "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function parseResult(raw: string | null): TaskResult | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TaskResult;
  } catch {
    return null;
  }
}

async function transition(
  taskId: string,
  status: string,
  patch: { steps?: LifecycleStep[]; result?: TaskResult; error?: string } = {},
): Promise<void> {
  await db.agentTask.update({
    where: { id: taskId },
    data: {
      status,
      ...(patch.steps ? { stepsJson: JSON.stringify(patch.steps) } : {}),
      ...(patch.result ? { resultJson: JSON.stringify(patch.result) } : {}),
      ...(patch.error !== undefined && patch.error !== null ? { error: patch.error.slice(0, 300) } : {}),
    },
  });
}

function upsertStep(steps: LifecycleStep[], step: string, status: LifecycleStep["status"], note?: string): LifecycleStep[] {
  const next = steps.filter((s) => s.step !== step);
  next.push({ step, status, note, at: new Date().toISOString() });
  return next;
}

// ---------------------------------------------------------------------------
// Task creation: QUEUED → ANALYZING → PLANNING → AWAITING_APPROVAL
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  userId: string;
  repoId: string;
  request: string;
  provider?: GiftzStepProvider;
  /** Phase 5: parent handoff/creative task (task-relationship history). */
  parentTaskId?: string;
  /** Phase 5: approved artifact whose bytes are substituted into the declared asset files at execution. */
  linkedArtifact?: { artifactId: string; assetTargets: string[] };
}

export interface CreateTaskOutput {
  taskId: string;
  status: string;
  duplicate?: boolean;
}

export async function createEngineeringTask(input: CreateTaskInput): Promise<CreateTaskOutput> {
  const { userId, repoId, request } = input;
  if (typeof request !== "string" || request.trim().length < 8 || request.trim().length > 2000) {
    throw new GiftzTaskError("Describe the engineering task in 8–2000 characters");
  }

  const repo = await db.giftzRepository.findFirst({ where: { id: repoId, ownerId: userId } });
  if (!repo) throw new GiftzTaskError("Repository not found", 404);
  if (repo.status !== "READY") throw new GiftzTaskError("Repository is archived", 409);

  // Duplicate prevention: re-attach to the active task for this repo.
  const active = await db.agentTask.findFirst({
    where: { userId, repoId, kind: "ENGINEERING_TASK", agent: "CODE_GIFTZ", status: { in: [...ACTIVE_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
  if (active) {
    return { taskId: active.id, status: active.status, duplicate: true };
  }

  const task = await db.agentTask.create({
    data: {
      userId,
      agent: "CODE_GIFTZ",
      kind: "ENGINEERING_TASK",
      title: request.trim().slice(0, 80),
      status: "QUEUED",
      repoId,
      parentTaskId: input.parentTaskId ?? null,
      stepsJson: JSON.stringify([{ step: "inspect", status: "pending" }]),
      resultJson: JSON.stringify({
        request: request.trim(),
        plan: null,
        inspection: null,
        edits: [],
        diffs: [],
        runs: [],
        report: null,
        attempts: 0,
        ...(input.linkedArtifact ? { linkedArtifact: input.linkedArtifact } : {}),
      } satisfies TaskResult),
    },
  });

  // Fire-and-forget the analysis+planning phase; every transition is durable.
  void runPlanningPhase(task.id, userId, repoId, request.trim(), input.provider ?? createGatewayGiftzProvider(userId))
    .catch(async (error) => {
      const steps = parseSteps((await db.agentTask.findUnique({ where: { id: task.id }, select: { stepsJson: true } }))?.stepsJson ?? "[]");
      await transition(task.id, "FAILED", {
        steps: upsertStep(steps, "plan", "failed", error instanceof Error ? error.message : "planning failed"),
        error: error instanceof Error ? error.message : "planning failed",
      }).catch(() => undefined);
    })
    .finally(() => inFlight().delete(task.id));

  return { taskId: task.id, status: "QUEUED" };
}

async function runPlanningPhase(taskId: string, userId: string, repoId: string, request: string, provider: GiftzStepProvider): Promise<void> {
  inFlight().add(taskId);
  cancelFlags().delete(taskId);

  let steps = await loadSteps(taskId);
  const result = loadResultSync(await loadResultRaw(taskId)) ?? emptyResult(request);

  // ANALYZING — deterministic repository inspection.
  await transition(taskId, "ANALYZING", { steps: upsertStep(steps, "inspect", "running") });
  if (isCancelRequested(taskId)) return finishCancelled(taskId, steps, result);
  const digest = inspectRepository(repoId);
  result.inspection = digest;
  steps = upsertStep(steps, "inspect", "done", `${digest.fileCount} files`);
  await transition(taskId, "ANALYZING", { steps, result });

  // PLANNING — schema-validated with one bounded structured repair.
  await transition(taskId, "PLANNING", { steps: upsertStep(steps, "plan", "running") });
  if (isCancelRequested(taskId)) return finishCancelled(taskId, steps, result);

  const planRaw = await provider.plan({ request, digest });
  const outcome = await parsePlanWithRepair(planRaw, { digest, requiredCreates: result.linkedArtifact?.assetTargets }, async (issues, previousRaw) => {
    return provider.plan({ request, digest, repairIssues: issues, previousPlan: safeJson(previousRaw) });
  });

  if (!outcome.ok || !outcome.plan) {
    steps = upsertStep(steps, "plan", "failed", "plan failed validation");
    await transition(taskId, "FAILED", {
      steps,
      result: {
        ...result,
        planIssues: outcome.issues,
        planRepaired: outcome.repaired,
        planRepairIssues: outcome.firstIssues ?? [],
      },
      error: `The plan did not pass validation: ${outcome.issues[0] ?? "unknown issue"}`,
    });
    return;
  }

  result.plan = outcome.plan;
  // Repair telemetry: what the validator rejected first, and whether the one
  // bounded repair fixed it. planIssues stays EMPTY on success — real issues
  // are only ever recorded for failures.
  result.planIssues = [];
  result.planRepaired = outcome.repaired;
  result.planRepairIssues = outcome.repaired ? outcome.firstIssues ?? [] : [];
  steps = upsertStep(steps, "plan", "done", outcome.repaired ? "validated after one repair" : "validated");
  await transition(taskId, "AWAITING_APPROVAL", { steps, result });
  void recordAiUsage(userId, "giftz-plan");
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function finishCancelled(taskId: string, steps: LifecycleStep[], result: TaskResult): Promise<void> {
  cancelFlags().delete(taskId);
  await transition(taskId, "CANCELLED", { steps: upsertStep(steps, "plan", "skipped", "cancelled"), result }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Approval + execution: AWAITING_APPROVAL → EXECUTING → VALIDATING/TESTING → COMPLETED|FAILED
// ---------------------------------------------------------------------------

export async function approveAndExecuteTask(input: { userId: string; taskId: string; provider?: GiftzStepProvider }): Promise<void> {
  const task = await loadTaskOrThrow(input.userId, input.taskId);
  if (task.status !== "AWAITING_APPROVAL") {
    throw new GiftzTaskError(`Task is ${task.status}; only AWAITING_APPROVAL tasks can be approved`, 409, task.id);
  }
  await launchExecution(task, input.userId, input.provider ?? createGatewayGiftzProvider(input.userId));
}

/** Shared launcher for approve AND retry: validates state, stamps EXECUTING, fires the runner. */
async function launchExecution(task: AgentTask, userId: string, provider: GiftzStepProvider): Promise<void> {
  const result = parseResult(task.resultJson);
  if (!result?.plan) throw new GiftzTaskError("Task has no validated plan to execute", 409, task.id);
  if (!task.repoId || !workspaceDirExists(task.repoId)) {
    throw new GiftzTaskError("The workspace for this task no longer exists", 409, task.id);
  }
  if ((result.attempts ?? 0) >= MAX_ATTEMPTS) {
    throw new GiftzTaskError(`Execution attempts exhausted (${MAX_ATTEMPTS})`, 409, task.id);
  }

  const steps = parseSteps(task.stepsJson);
  await transition(task.id, "EXECUTING", {
    steps: upsertStep(steps, "execute", "running"),
    result: { ...result, attempts: (result.attempts ?? 0) + 1 },
  });

  void runExecutionPhase(task.id, userId, task.repoId, result.request, provider)
    .catch(async (error) => {
      const cur = parseSteps((await db.agentTask.findUnique({ where: { id: task.id }, select: { stepsJson: true } }))?.stepsJson ?? "[]");
      await transition(task.id, "FAILED", {
        steps: upsertStep(cur, "execute", "failed", error instanceof Error ? error.message : "execution crashed"),
        error: error instanceof Error ? error.message : "execution crashed",
      }).catch(() => undefined);
    })
    .finally(() => inFlight().delete(task.id));
}

function workspaceDirExists(repoId: string): boolean {
  try {
    return fs.statSync(workspaceDir(repoId), { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

async function runExecutionPhase(taskId: string, userId: string, repoId: string, request: string, provider: GiftzStepProvider): Promise<void> {
  inFlight().add(taskId);
  const task = await db.agentTask.findUnique({ where: { id: taskId } });
  if (!task) return;
  const result = parseResult(task.resultJson) ?? emptyResult(request);
  const plan = result.plan;
  if (!plan) return;
  let steps = parseSteps(task.stepsJson);
  result.edits = [];
  result.runs = [];
  result.diffs = [];
  // The inspection digest is persisted from planning; re-derive if missing.
  if (!result.inspection) result.inspection = inspectRepository(repoId);
  const assetTargets = new Set(result.linkedArtifact?.assetTargets ?? []);

  // 1) File steps — validated, plan-scoped writes only.
  for (const step of plan.steps) {
    if (isCancelRequested(taskId)) return finishCancelled(taskId, steps, result);
    if (step.kind === "inspect") continue;
    if (step.kind === "run_command") continue;

    const record: FileEditRecord = { path: step.path ?? "", change: changeOf(step.kind), bytes: 0, ok: false };
    try {
      if (!step.path || isSecretPath(step.path)) {
        throw new WorkspaceError(step.path ? "Refusing to touch a secret file" : "Step has no target path");
      }
      if (step.kind === "delete_file") {
        deleteWorkspaceFile(repoId, step.path);
        record.ok = true;
      } else if (step.kind === "create_file" && assetTargets.has(step.path)) {
        // Phase 5: the asset's binary content comes from the APPROVED artifact
        // (verified server-side) — the model never produces binary content.
        // Pass this task as the expected destination: a retry of the SAME task
        // may re-read its consumed artifact; any other consumer is refused.
        const { bytes } = await readArtifactBytes(userId, result.linkedArtifact!.artifactId, taskId);
        record.bytes = writeWorkspaceFileBytes(repoId, step.path, bytes);
        record.ok = true;
        record.note = "content from approved artifact";
      } else {
        const current = fileOrNull(repoId, step.path);
        const edit = await provider.fileEdit({ step, plan, currentContent: current, digest: result.inspection! });
        if (edit.path !== step.path) throw new WorkspaceError(`Model returned path "${edit.path}" instead of "${step.path}"`);
        if (edit.change !== changeOf(step.kind)) throw new WorkspaceError(`Model returned change "${edit.change}" instead of "${changeOf(step.kind)}"`);
        if (typeof edit.content !== "string") throw new WorkspaceError("Model returned no file content");
        record.bytes = writeWorkspaceFile(repoId, step.path, edit.content);
        record.ok = true;
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : "edit failed";
    }
    result.edits.push(record);
    steps = upsertStep(steps, "execute", record.ok ? "done" : "failed", `${result.edits.filter((e) => e.ok).length}/${result.edits.length} file steps applied`);
    await transition(taskId, "EXECUTING", { steps, result });
    if (!record.ok) {
      // A failed edit aborts the run honestly; applied files stay for review/revert.
      steps = upsertStep(steps, "test", "skipped", "not performed — a file step failed");
      await transition(taskId, "FAILED", {
        steps,
        result: { ...result, report: buildReport(result, "failed") },
        error: `File step "${step.id}" failed: ${record.error}`,
      });
      void recordAiUsage(userId, "giftz-execute");
      return;
    }
  }

  // 2) Validation + testing — allowlisted commands only, classified honestly.
  const packageScripts = await workspaceScripts(repoId);
  const commands = plan.validation.commands;
  const testRuns: CommandRun[] = [];
  let sawFailure = false;
  for (const command of commands) {
    if (isCancelRequested(taskId)) return finishCancelled(taskId, steps, result);
    let validated;
    try {
      validated = validateCommand({ label: command.label, argv: command.argv }, packageScripts);
    } catch (error) {
      sawFailure = true;
      result.runs.push({
        id: crypto.randomUUID(), label: command.label, argv: command.argv, cwd: ".",
        exitCode: null, signal: null, durationMs: 0, status: "error",
        stdoutTail: "", stderrTail: error instanceof Error ? error.message : "command rejected",
        stdoutTruncated: false, stderrTruncated: false, redactionCount: 0, at: new Date().toISOString(),
      });
      continue;
    }
    const isTest = validated.argv.some((p) => /test/i.test(p));
    await transition(taskId, isTest ? "TESTING" : "VALIDATING", {
      steps: upsertStep(steps, isTest ? "test" : "validate", "running"),
      result,
    });
    const run = await runCommand(taskId, repoId, validated);
    result.runs.push(run);
    if (isTest) testRuns.push(run);
    if (run.status !== "passed") sawFailure = true;
    steps = upsertStep(steps, isTest ? "test" : "validate", run.status === "passed" ? "done" : "failed", `${run.label} → ${run.status}`);
    await transition(taskId, isTest ? "TESTING" : "VALIDATING", { steps, result });
  }

  // 3) Diff + report — the change is reviewable whatever the outcome.
  const { raw, ok, error } = diffForWorkspace(repoId);
  result.diffs = ok ? parseUnifiedDiff(raw) : [];
  steps = upsertStep(steps, "diff", ok ? "done" : "failed", ok ? undefined : error);
  const validationStatus: TaskReport["validationStatus"] = result.runs.length === 0 ? "not_performed" : sawFailure ? "failed" : "verified";
  result.report = buildReport(result, validationStatus);

  if (validationStatus === "verified") {
    steps = upsertStep(steps, "report", "done", "verified");
    await transition(taskId, "COMPLETED", { steps, result, error: "" });
  } else {
    steps = upsertStep(steps, "report", "failed", validationStatus === "not_performed" ? "no validation command ran" : "validation failed");
    await transition(taskId, "FAILED", { steps, result, error: validationStatus === "not_performed" ? "No validation command could run" : "Validation commands failed — see the run log" });
  }
  void recordAiUsage(userId, "giftz-execute");
}

function changeOf(kind: "create_file" | "modify_file" | "delete_file" | "run_command" | "inspect"): "create" | "modify" | "delete" {
  return kind === "create_file" ? "create" : kind === "delete_file" ? "delete" : "modify";
}

function fileOrNull(repoId: string, relPath: string): string | null {
  try {
    return readWorkspaceFile(repoId, relPath).content;
  } catch {
    return null;
  }
}

async function workspaceScripts(repoId: string): Promise<string[]> {
  try {
    const { content } = readWorkspaceFile(repoId, "package.json");
    const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
    return Object.keys(parsed.scripts ?? {});
  } catch {
    return [];
  }
}

function diffForWorkspace(repoId: string): { raw: string; ok: boolean; error?: string } {
  try {
    return generateWorkspaceDiff(repoId, workspaceDir(repoId));
  } catch {
    return { raw: "", ok: false, error: "workspace missing" };
  }
}

function buildReport(result: TaskResult, validationStatus: TaskReport["validationStatus"]): TaskReport {
  const passed = result.runs.filter((r) => r.status === "passed").length;
  const failed = result.runs.filter((r) => r.status !== "passed").length;
  const applied = result.edits.length > 0 && result.edits.every((e) => e.ok);
  const summary =
    validationStatus === "verified"
      ? `Applied ${result.edits.length} file change(s); ${passed} validation command(s) passed. The change is verified and reviewable in the diff.`
      : validationStatus === "failed"
        ? `Applied ${result.edits.length} file change(s); ${failed} validation command(s) FAILED. Code was applied but is NOT verified — review the run log and diff.`
        : `Applied ${result.edits.length} file change(s); validation was not performed. The change is NOT verified.`;
  return {
    generated: true,
    applied,
    commandsRun: result.runs.length,
    commandsPassed: passed,
    commandsFailed: failed,
    validationStatus,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Reject / cancel / retry / revert
// ---------------------------------------------------------------------------

export async function rejectTask(userId: string, taskId: string, reason?: string): Promise<void> {
  const task = await loadTaskOrThrow(userId, taskId);
  if (task.status !== "AWAITING_APPROVAL") {
    throw new GiftzTaskError(`Task is ${task.status}; only plans awaiting approval can be rejected`, 409, task.id);
  }
  const steps = upsertStep(parseSteps(task.stepsJson), "approve", "failed", "rejected by the user");
  await transition(task.id, "CANCELLED", { steps, error: reason?.slice(0, 300) ?? "Rejected by the user" });
}

export async function cancelTask(userId: string, taskId: string): Promise<void> {
  const task = await loadTaskOrThrow(userId, taskId);
  if (isTerminalStatus(task.status)) {
    throw new GiftzTaskError(`Task is already ${task.status}`, 409, task.id);
  }
  cancelFlags().add(task.id);
  killTaskChildren(task.id);
  inFlight().delete(task.id); // the runner will observe the flag; a dead runner cannot object
  const steps = upsertStep(parseSteps(task.stepsJson), "report", "skipped", "cancelled by the user");
  await transition(task.id, "CANCELLED", { steps, error: "Cancelled by the user" });
}

export async function retryTask(userId: string, taskId: string, provider?: GiftzStepProvider): Promise<void> {
  const task = await loadTaskOrThrow(userId, taskId);
  if (task.status !== "FAILED") throw new GiftzTaskError(`Task is ${task.status}; only FAILED tasks can be retried`, 409, task.id);
  const result = parseResult(task.resultJson);
  if (!result?.plan) throw new GiftzTaskError("Nothing to retry — the task never reached a validated plan", 409, task.id);
  if ((result.attempts ?? 0) >= MAX_ATTEMPTS) {
    throw new GiftzTaskError(`Execution attempts exhausted (${MAX_ATTEMPTS})`, 409, task.id);
  }
  // The plan was already approved once — retry goes straight to execution.
  await launchExecution(task, userId, provider ?? createGatewayGiftzProvider(userId));
}

export async function revertTask(userId: string, taskId: string): Promise<{ restored: string[] }> {
  const task = await loadTaskOrThrow(userId, taskId);
  if (!task.repoId) throw new GiftzTaskError("Task has no workspace", 409, task.id);
  const result = parseResult(task.resultJson);
  const paths = (result?.edits ?? []).filter((e) => e.ok).map((e) => e.path);
  if (paths.length === 0) throw new GiftzTaskError("Nothing applied to revert", 409, task.id);
  const reverted = revertFiles(workspaceDir(task.repoId), paths);
  if (!reverted.ok) throw new GiftzTaskError(reverted.error ?? "Revert failed", 500, task.id);
  const result2 = parseResult(task.resultJson) ?? emptyResult(task.title);
  result2.revert = { ok: true, restoredFiles: reverted.restored };
  await db.agentTask.update({ where: { id: task.id }, data: { resultJson: JSON.stringify(result2) } });
  return { restored: reverted.restored };
}

// ---------------------------------------------------------------------------
// Loading / listing / sweeps
// ---------------------------------------------------------------------------

export async function loadTaskOrThrow(userId: string, taskId: string): Promise<AgentTask> {
  const task = await db.agentTask.findFirst({ where: { id: taskId, userId } });
  if (!task || task.kind !== "ENGINEERING_TASK" || task.agent !== "CODE_GIFTZ") {
    throw new GiftzTaskError("Engineering task not found", 404);
  }
  return task;
}

export interface TaskListItem {
  id: string;
  status: string;
  title: string;
  repoId: string | null;
  repoName: string | null;
  createdAt: Date;
  updatedAt: Date;
  error: string | null;
  validationStatus: TaskReport["validationStatus"] | null;
}

export async function listTasks(userId: string, limit = 30): Promise<TaskListItem[]> {
  await sweepStaleGiftzTasks();
  const rows = await db.agentTask.findMany({
    where: { userId, kind: "ENGINEERING_TASK", agent: "CODE_GIFTZ" },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  const repoIds = [...new Set(rows.map((r) => r.repoId).filter((v): v is string => Boolean(v)))];
  const repos = repoIds.length
    ? await db.giftzRepository.findMany({ where: { id: { in: repoIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(repos.map((r) => [r.id, r.name]));
  return rows.map((r) => {
    const result = parseResult(r.resultJson);
    return {
      id: r.id,
      status: r.status,
      title: r.title,
      repoId: r.repoId,
      repoName: r.repoId ? nameById.get(r.repoId) ?? null : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      error: r.error,
      validationStatus: result?.report?.validationStatus ?? null,
    };
  });
}

export interface TaskDetail {
  id: string;
  status: string;
  title: string;
  request: string;
  repoId: string;
  steps: LifecycleStep[];
  result: TaskResult;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  inFlight: boolean;
  cancelRequested: boolean;
}

export async function loadTaskDetail(userId: string, taskId: string): Promise<TaskDetail> {
  const task = await loadTaskOrThrow(userId, taskId);
  if (!task.repoId) throw new GiftzTaskError("Task has no workspace", 404);
  const result = parseResult(task.resultJson) ?? emptyResult(task.title);
  return {
    id: task.id,
    status: task.status,
    title: task.title,
    request: result.request ?? task.title,
    repoId: task.repoId,
    steps: parseSteps(task.stepsJson),
    result,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    inFlight: isTaskInFlight(task.id),
    cancelRequested: isCancelRequested(task.id),
  };
}

/**
 * Restart recovery: tasks stuck in an active status with no live runner are
 * honestly failed (execution state cannot be resumed mid-step). Safe to call
 * repeatedly — terminal tasks and tasks with a live in-process runner pass.
 *
 * Kind-aware (audit B-3 — one sweep owns both durable task kinds):
 *  - ENGINEERING_TASK (60 min staleness): the legacy engineering pipeline;
 *    failure wording, step bookkeeping and in-flight guard are unchanged.
 *  - SITE_STUDIO_TURN (30 min staleness): website-studio conversational
 *    turns. A turn that stops progressing (server restart, crash, hung AI
 *    call) is failed with a user-safe error and its linked
 *    SiteStudioMessage flips PENDING/RUNNING → FAILED, so the chat never
 *    hangs on a spinner. Live turns keep AgentTask.updatedAt fresh at every
 *    stage transition (setStage writes stepsJson), so only genuinely dead
 *    turns cross the threshold.
 *
 * Status sets differ by kind on purpose: engineering runners live in
 * ACTIVE_STATUSES (QUEUED/ANALYZING/PLANNING/EXECUTING/VALIDATING/TESTING),
 * while studio turns sit in RUNNING/PENDING (the canonical AgentTask active
 * states — note RUNNING is NOT part of ACTIVE_STATUSES).
 */
export type GiftzSweepKind = "ENGINEERING_TASK" | "SITE_STUDIO_TURN";

const SWEEP_STALE_MS: Record<GiftzSweepKind, number> = {
  ENGINEERING_TASK: 60 * 60 * 1000,
  SITE_STUDIO_TURN: 30 * 60 * 1000,
};

export async function sweepStaleGiftzTasks(
  kinds: readonly GiftzSweepKind[] = ["ENGINEERING_TASK", "SITE_STUDIO_TURN"],
): Promise<number> {
  let swept = 0;
  for (const kind of kinds) {
    const statuses =
      kind === "SITE_STUDIO_TURN" ? ["RUNNING", "PENDING"] : [...ACTIVE_STATUSES];
    const staleBefore = new Date(Date.now() - SWEEP_STALE_MS[kind]);
    const rows = await db.agentTask.findMany({
      where: { kind, agent: "CODE_GIFTZ", status: { in: statuses }, updatedAt: { lt: staleBefore } },
      select: { id: true, stepsJson: true, resultJson: true, title: true, error: true },
      take: 50,
    });
    for (const row of rows) {
      if (isTaskInFlight(row.id)) continue; // genuinely running in this process
      if (kind === "SITE_STUDIO_TURN") {
        // Studio turns: honest FAILED on the durable task + the linked chat
        // message, with a user-safe retryable error. Meta is left untouched
        // (updateMany cannot clobber stage info it does not know about).
        await db.agentTask
          .update({
            where: { id: row.id },
            data: { status: "FAILED", error: "Generation interrupted — please retry" },
          })
          .catch(() => undefined);
        await db.siteStudioMessage
          .updateMany({
            where: { taskId: row.id, status: { in: ["PENDING", "RUNNING"] } },
            data: { status: "FAILED", error: "Generation interrupted — please retry" },
          })
          .catch(() => undefined);
        swept += 1;
        continue;
      }
      // Engineering tasks: existing behavior preserved verbatim.
      const steps = parseSteps(row.stepsJson);
      const result = parseResult(row.resultJson) ?? emptyResult(row.title);
      await transition(row.id, "FAILED", {
        steps: upsertStep(steps, "report", "failed", "interrupted — the server restarted or the runner died"),
        result,
        error: "The task was interrupted before completion (server restart or crash). You can retry it.",
      }).catch(() => undefined);
      cancelFlags().delete(row.id);
      swept += 1;
    }
  }
  return swept;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function emptyResult(request: string): TaskResult {
  return { request, plan: null, inspection: null, edits: [], diffs: [], runs: [], report: null, attempts: 0 };
}

async function loadSteps(taskId: string): Promise<LifecycleStep[]> {
  const row = await db.agentTask.findUnique({ where: { id: taskId }, select: { stepsJson: true } });
  return parseSteps(row?.stepsJson ?? "[]");
}

async function loadResultRaw(taskId: string): Promise<string | null> {
  const row = await db.agentTask.findUnique({ where: { id: taskId }, select: { resultJson: true } });
  return row?.resultJson ?? null;
}

function loadResultSync(raw: string | null): TaskResult | null {
  return parseResult(raw);
}
