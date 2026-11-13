/**
 * RIISHE workflow engine — durable multi-step execution for plans produced
 * by the automation planner.
 *
 * Contract (Part A §2):
 *  - every workflow and every step is a REAL persistent record with its own
 *    execution history (status, attempts, results, errors, timings);
 *  - steps run through the registered tool layer ONLY — a model response is
 *    never mistaken for a completed action;
 *  - dependencies gate readiness (sequential chains, parallel branches where
 *    safe — independent READY steps each get their own queue job);
 *  - scheduled steps wait for their time; approval-gated steps wait for the
 *    owner; retries use the durable queue with exponential backoff; dead
 *    letters surface as FAILED steps with the real error;
 *  - cancellation/pause/resume are immediate and stop scheduling;
 *  - a crashed/restarted worker recovers: the sweep re-queues stale RUNNING
 *    steps and schedules due ones;
 *  - completion is derived from actual step outcomes — never fabricated.
 */

import type { BackgroundJob } from "@prisma/client";

import { db } from "@/lib/db";
import { notify } from "@/lib/notify";
import { enqueue, cancelQueued } from "@/lib/queue";
import { auditEvent } from "@/lib/riishe/audit";
import { getTool, REF_FIELDS, type ToolContext } from "@/lib/riishe/tools";

export const WORKFLOW_JOB_KIND = "riishe.workflow";
export const WORKFLOW_SWEEP_KEY = "riishe.workflow.sweep";

export const WORKFLOW_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const STEP_STATUSES = [
  "PENDING",
  "AWAITING_APPROVAL",
  "READY",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const MAX_WORKFLOW_STEPS = 12;
export const MAX_ACTIVE_WORKFLOWS_PER_USER = 10;
const STALE_RUNNING_MS = 10 * 60_000;

export class WorkflowError extends Error {
  constructor(message: string, public reason: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

// ---------------------------------------------------------------- planning

export type PlannerStepPlan = {
  id: string;
  tool: string;
  title?: string;
  params: Record<string, unknown>;
  dependsOn?: string[];
  schedule?: { inDays?: number; at?: string };
};

export type PlannerPlan = {
  title: string;
  summary?: string;
  steps: PlannerStepPlan[];
};

/** Workflow + steps serialized for the UI/cards. */
export function toWorkflowDTO(w: {
  id: string;
  title: string;
  goal: string;
  status: string;
  planJson: string;
  createdAt: Date;
  updatedAt: Date;
  steps: {
    id: string;
    seq: number;
    ref: string | null;
    kind: string;
    title: string;
    risk: string;
    requiresApproval: boolean;
    status: string;
    resultJson: string;
    error: string | null;
    attempts: number;
    maxAttempts: number;
    scheduledFor: Date | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    dependsOnJson: string;
  }[];
}) {
  let plan: { summary?: string; planner?: string } = {};
  try {
    plan = JSON.parse(w.planJson) as typeof plan;
  } catch {
    plan = {};
  }
  return {
    id: w.id,
    title: w.title,
    goal: w.goal,
    status: w.status,
    summary: plan.summary ?? null,
    planner: plan.planner ?? null,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
    steps: w.steps.map((s) => ({
      id: s.id,
      seq: s.seq,
      ref: s.ref,
      tool: s.kind,
      title: s.title,
      risk: s.risk,
      requiresApproval: s.requiresApproval,
      status: s.status,
      error: s.error,
      attempts: s.attempts,
      maxAttempts: s.maxAttempts,
      scheduledFor: s.scheduledFor?.toISOString() ?? null,
      startedAt: s.startedAt?.toISOString() ?? null,
      finishedAt: s.finishedAt?.toISOString() ?? null,
      dependsOn: safeIds(s.dependsOnJson),
      result: safeJson(s.resultJson),
    })),
  };
}

function safeJson(v: string): Record<string, unknown> | null {
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return null;
  }
}
function safeIds(v: string): string[] {
  try {
    const arr = JSON.parse(v) as unknown;
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Validate + persist a plan. The registry is the source of truth for risk,
 * approval, timeout and retry policy; params must pass each tool's schema.
 * Dependencies must reference existing planner ids without cycles.
 */
export async function createWorkflowFromPlan(
  userId: string,
  goal: string,
  plan: PlannerPlan,
  opts?: { conversationId?: string | null; planner?: "llm" | "deterministic"; autoStart?: boolean }
) {
  if (!plan.title || typeof plan.title !== "string") throw new WorkflowError("plan needs a title", "invalid");
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new WorkflowError("plan needs at least one step", "invalid");
  }
  if (plan.steps.length > MAX_WORKFLOW_STEPS) {
    throw new WorkflowError(`plans are capped at ${MAX_WORKFLOW_STEPS} steps`, "limits");
  }
  const activeCount = await db.riisheWorkflow.count({ where: { userId, status: { in: ["ACTIVE", "PAUSED"] } } });
  if (activeCount >= MAX_ACTIVE_WORKFLOWS_PER_USER) {
    throw new WorkflowError(`Workflow limit reached (${MAX_ACTIVE_WORKFLOWS_PER_USER}). Pause or cancel one first.`, "limits");
  }

  // Registry-level validation (tool exists, params schema, ref integrity).
  const planIds = new Set(plan.steps.map((s) => s.id));
  for (const s of plan.steps) {
    const tool = getTool(s.tool);
    if (!tool) throw new WorkflowError(`unknown tool "${s.tool}"`, "invalid");
    const parsed = tool.inputSchema.safeParse(s.params ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new WorkflowError(
        `params for ${s.tool}: ${issue?.path.join(".") || "input"} ${issue?.message ?? "invalid"}`,
        "invalid"
      );
    }
    for (const dep of s.dependsOn ?? []) {
      if (!planIds.has(dep)) throw new WorkflowError(`step ${s.id} depends on unknown step ${dep}`, "invalid");
    }
  }
  // Cycle check (deps must form a DAG).
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new WorkflowError(`circular dependency at ${id}`, "invalid");
    visiting.add(id);
    const step = plan.steps.find((s) => s.id === id);
    for (const dep of step?.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    done.add(id);
  };
  for (const s of plan.steps) visit(s.id);
  // Dependencies must reference EARLIER steps (plan order = execution topo
  // order) so row ids are resolvable when each step row is created.
  const earlier = new Set<string>();
  for (const s of plan.steps) {
    for (const dep of s.dependsOn ?? []) {
      if (!earlier.has(dep)) {
        throw new WorkflowError(`step ${s.id} depends on ${dep}, which is not an earlier step`, "invalid");
      }
    }
    earlier.add(s.id);
  }

  const workflow = await db.riisheWorkflow.create({
    data: {
      userId,
      title: plan.title.slice(0, 120),
      goal: goal.slice(0, 2000),
      status: "ACTIVE",
      planJson: JSON.stringify({
        summary: (plan.summary ?? "").slice(0, 500),
        planner: opts?.planner ?? "llm",
      }),
      conversationId: opts?.conversationId ?? null,
    },
  });

  const idByRef = new Map<string, string>();
  let seq = 0;
  for (const s of plan.steps) {
    const tool = getTool(s.tool)!;
    const validated = tool.inputSchema.parse(s.params ?? {});
    const scheduledFor = scheduleFor(s.schedule);
    // Dependencies are persisted as ROW ids (planner ids translate through
    // idByRef; earlier-step validation above guarantees they all exist).
    const depRowIds = (s.dependsOn ?? []).map((d) => {
      const rowId = idByRef.get(d);
      if (!rowId) throw new WorkflowError(`step ${s.id} depends on ${d}, which is not an earlier step`, "invalid");
      return rowId;
    });
    const depsDone = depRowIds.length === 0;
    const status: StepStatus = tool.risk === "HIGH" || tool.risk === "DESTRUCTIVE"
      ? "AWAITING_APPROVAL"
      : scheduledFor || !depsDone
        ? "PENDING"
        : "READY";
    const row = await db.riisheWorkflowStep.create({
      data: {
        workflowId: workflow.id,
        userId,
        seq: seq++,
        ref: s.id,
        kind: s.tool,
        title: (s.title ?? tool.title).slice(0, 160),
        paramsJson: JSON.stringify(validated),
        dependsOnJson: JSON.stringify(depRowIds),
        risk: tool.risk,
        requiresApproval: tool.risk === "HIGH" || tool.risk === "DESTRUCTIVE",
        status,
        maxAttempts: tool.maxAttempts,
        timeoutMs: tool.timeoutMs,
        scheduledFor,
      },
    });
    if (s.id) idByRef.set(s.id, row.id);
  }

  await auditEvent(userId, "riishe.workflow.created", "RiisheWorkflow", workflow.id, {
    steps: plan.steps.length,
    planner: opts?.planner ?? "llm",
  });

  if (opts?.autoStart !== false) {
    await scheduleReadySteps(workflow.id, userId);
  }
  return loadOwnedWorkflow(userId, workflow.id);
}

function scheduleFor(schedule?: { inDays?: number; at?: string }): Date | null {
  if (!schedule) return null;
  if (typeof schedule.at === "string") {
    const at = new Date(schedule.at);
    if (!Number.isNaN(at.getTime()) && at.getTime() > Date.now()) return at;
  }
  if (typeof schedule.inDays === "number" && schedule.inDays > 0) {
    return new Date(Date.now() + schedule.inDays * 24 * 60 * 60_000);
  }
  return null;
}

// ---------------------------------------------------------------- execution

async function loadOwnedWorkflow(userId: string, workflowId: string) {
  const w = await db.riisheWorkflow.findFirst({
    where: { id: workflowId, userId },
    include: { steps: { orderBy: { seq: "asc" } } },
  });
  if (!w) throw new WorkflowError("Workflow not found", "not-found");
  return w;
}

/** Public read for routes: an owned workflow with its steps, else 404-class. */
export const loadOwned = loadOwnedWorkflow;

/** Queue jobs for every READY step (parallel-safe: one job per step). */
export async function scheduleReadySteps(workflowId: string, userId: string): Promise<number> {
  const steps = await db.riisheWorkflowStep.findMany({ where: { workflowId } });
  let scheduled = 0;
  for (const step of steps) {
    if (step.status !== "READY") continue;
    const job = await enqueue({
      kind: WORKFLOW_JOB_KIND,
      payload: { workflowId, stepId: step.id, userId },
      userId,
      runAt: new Date(),
      maxAttempts: step.maxAttempts,
      dedupeKey: `riishe.wfstep:${step.id}`,
    });
    if (step.backgroundJobId !== job.id) {
      await db.riisheWorkflowStep.update({ where: { id: step.id }, data: { backgroundJobId: job.id } });
    }
    scheduled++;
  }
  return scheduled;
}

/** Resolve planner-id refs (draftRef/postRef) via the referenced step's result. */
async function resolveStepParams(
  workflowId: string,
  step: { paramsJson: string; kind: string }
): Promise<Record<string, unknown>> {
  const params = safeJson(step.paramsJson) ?? {};
  const tool = getTool(step.kind);
  if (!tool) return params;
  const needsResolution = Object.keys(params).some((k) => REF_FIELDS.has(k));
  if (!needsResolution) return params;
  const all = await db.riisheWorkflowStep.findMany({ where: { workflowId } });
  const byRef = new Map(all.map((s) => [s.ref, s]));
  const resolved: Record<string, unknown> = { ...params };
  for (const [k, v] of Object.entries(params)) {
    if (!REF_FIELDS.has(k) || typeof v !== "string") continue;
    const refStep = byRef.get(v);
    if (!refStep) throw new WorkflowError(`step reference "${v}" not found`, "invalid");
    const result = safeJson(refStep.resultJson);
    const value =
      k === "draftRef"
        ? (result?.draftTaskId as string | undefined)
        : (result?.postId as string | undefined);
    if (!value) {
      throw new WorkflowError(
        `referenced step "${v}" produced no ${k === "draftRef" ? "draft" : "post"} (status: ${refStep.status})`,
        "dependency-missing"
      );
    }
    resolved[k] = value;
  }
  return resolved;
}

async function executeTool(step: {
  id: string;
  kind: string;
  paramsJson: string;
  timeoutMs: number;
  workflowId: string;
}, userId: string, createInquiry?: ToolContext["createInquiry"]) {
  const tool = getTool(step.kind);
  if (!tool) throw new Error(`tool ${step.kind} is no longer registered`);
  const params = await resolveStepParams(step.workflowId, step);
  const ctx: ToolContext = { userId, workflowId: step.workflowId, stepId: step.id, createInquiry };
  const result = await Promise.race([
    tool.execute(ctx, params as never),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`tool timed out after ${step.timeoutMs}ms`)), step.timeoutMs)
    ),
  ]);
  return result ?? {};
}

/** Queue entrypoint: run ONE workflow step (durable, retried by the queue). */
export async function runWorkflowStepJob(job: BackgroundJob): Promise<void> {
  const payload = safeJson(job.payload) as { workflowId?: string; stepId?: string; userId?: string } | null;
  if (!payload?.workflowId || !payload.stepId || !payload.userId) {
    throw new Error("riishe.workflow job payload malformed");
  }
  const step = await db.riisheWorkflowStep.findFirst({
    where: { id: payload.stepId, userId: payload.userId },
  });
  if (!step) throw new Error(`workflow step ${payload.stepId} not found for owner`);
  const workflow = await db.riisheWorkflow.findFirst({ where: { id: step.workflowId, userId: payload.userId } });
  if (!workflow) throw new Error(`workflow ${step.workflowId} not found for owner`);

  if (step.status === "SUCCEEDED" || step.status === "CANCELLED" || step.status === "SKIPPED") {
    return; // already terminal — duplicate delivery is a no-op
  }
  if (step.status === "FAILED") {
    return; // final failure recorded — the queue's own retry row is stale
  }
  if (workflow.status !== "ACTIVE") {
    // Paused/cancelled workflows stop scheduling; the job is released.
    return;
  }
  if (step.requiresApproval && step.approvedAt === null) {
    // Approval must come through the API; never execute unapproved HIGH tools.
    await db.riisheWorkflowStep.update({ where: { id: step.id }, data: { status: "AWAITING_APPROVAL" } });
    return;
  }

  await db.riisheWorkflowStep.update({
    where: { id: step.id },
    data: { status: "RUNNING", startedAt: step.startedAt ?? new Date(), attempts: { increment: 1 } },
  });

  try {
    const result = await executeTool(step, payload.userId);
    await db.riisheWorkflowStep.update({
      where: { id: step.id },
      data: {
        status: "SUCCEEDED",
        resultJson: JSON.stringify(result),
        error: null,
        finishedAt: new Date(),
      },
    });
    await auditEvent(payload.userId, "riishe.workflow.step_succeeded", "RiisheWorkflowStep", step.id, {
      tool: step.kind,
    });
    await afterStepTerminal(step.workflowId, payload.userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fresh = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    const attempts = fresh?.attempts ?? 1;
    if (attempts >= (fresh?.maxAttempts ?? 3)) {
      await db.riisheWorkflowStep.update({
        where: { id: step.id },
        data: { status: "FAILED", error: message.slice(0, 500), finishedAt: new Date() },
      });
      await auditEvent(payload.userId, "riishe.workflow.step_failed", "RiisheWorkflowStep", step.id, {
        tool: step.kind,
        error: message.slice(0, 200),
      });
      await notify({
        userId: payload.userId,
        actorId: null,
        type: "SYSTEM",
        payload: { text: `RIISHE workflow "${workflow.title}" step "${step.title}" failed: ${message.slice(0, 140)}` },
        dedupKey: `riishe.wfstep-failed:${step.id}`,
      }).catch(() => undefined);
      await skipDependents(step.workflowId, step.id, payload.userId);
      await afterStepTerminal(step.workflowId, payload.userId);
      throw err; // let the queue record the failure honestly (DEAD after retries)
    }
    // Re-throw → queue requeues with backoff; the next run retries the tool.
    await db.riisheWorkflowStep.update({
      where: { id: step.id },
      data: { status: "READY", error: message.slice(0, 500) },
    });
    throw err;
  }
}

/** High/destructive steps execute at approval time (session context present). */
export async function executeApprovedStep(
  userId: string,
  stepId: string,
  createInquiry?: ToolContext["createInquiry"]
) {
  const step = await db.riisheWorkflowStep.findFirst({ where: { id: stepId, userId } });
  if (!step) throw new WorkflowError("Step not found", "not-found");
  const workflow = await loadOwnedWorkflow(userId, step.workflowId);
  if (step.status === "SUCCEEDED") {
    return { already: true, result: safeJson(step.resultJson) }; // never run twice
  }
  if (step.status === "CANCELLED" || step.status === "SKIPPED") {
    throw new WorkflowError("This step can no longer run", "terminal");
  }
  if (step.status === "RUNNING") {
    throw new WorkflowError("This step is already running", "conflict");
  }
  if (workflow.status !== "ACTIVE") {
    throw new WorkflowError("The workflow is not active", "inactive");
  }
  await db.riisheWorkflowStep.update({
    where: { id: step.id },
    data: { status: "RUNNING", attempts: { increment: 1 }, startedAt: new Date() },
  });
  try {
    const result = await executeTool(step, userId, createInquiry);
    await db.riisheWorkflowStep.update({
      where: { id: step.id },
      data: { status: "SUCCEEDED", resultJson: JSON.stringify(result), error: null, finishedAt: new Date() },
    });
    await auditEvent(userId, "riishe.workflow.step_succeeded", "RiisheWorkflowStep", step.id, {
      tool: step.kind,
      via: "approval",
    });
    await afterStepTerminal(step.workflowId, userId);
    return { already: false, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.riisheWorkflowStep.update({
      where: { id: step.id },
      data: { status: "FAILED", error: message.slice(0, 500), finishedAt: new Date() },
    });
    await auditEvent(userId, "riishe.workflow.step_failed", "RiisheWorkflowStep", step.id, {
      tool: step.kind,
      error: message.slice(0, 200),
    });
    await skipDependents(step.workflowId, step.id, userId);
    await afterStepTerminal(step.workflowId, userId);
    throw err;
  }
}

/** When a step reaches a terminal state: unlock dependents + derive completion. */
async function afterStepTerminal(workflowId: string, userId: string) {
  const steps = await db.riisheWorkflowStep.findMany({ where: { workflowId } });
  const byId = new Map(steps.map((s) => [s.id, s]));
  let unlocked = false;
  for (const step of steps) {
    if (step.status !== "PENDING") continue;
    const deps = safeIds(step.dependsOnJson);
    const depStates = deps.map((d) => byId.get(d)?.status ?? "PENDING");
    if (depStates.length === 0) continue;
    if (depStates.every((st) => st === "SUCCEEDED")) {
      const tool = getTool(step.kind);
      const next: StepStatus =
        tool && (tool.risk === "HIGH" || tool.risk === "DESTRUCTIVE") ? "AWAITING_APPROVAL" : "READY";
      await db.riisheWorkflowStep.update({ where: { id: step.id }, data: { status: next } });
      unlocked = true;
    } else if (depStates.some((st) => st === "FAILED" || st === "SKIPPED" || st === "CANCELLED")) {
      await db.riisheWorkflowStep.update({
        where: { id: step.id },
        data: { status: "SKIPPED", error: "a dependency did not complete", finishedAt: new Date() },
      });
      unlocked = true;
    }
  }
  if (unlocked) {
    await scheduleReadySteps(workflowId, userId);
  }
  await deriveWorkflowStatus(workflowId, userId);
}

async function skipDependents(workflowId: string, failedStepId: string, userId: string) {
  const steps = await db.riisheWorkflowStep.findMany({ where: { workflowId } });
  const byId = new Map(steps.map((s) => [s.id, s]));
  const bad = new Set([failedStepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (bad.has(step.id) || step.status === "SUCCEEDED") continue;
      const deps = safeIds(step.dependsOnJson);
      if (deps.length > 0 && deps.some((d) => bad.has(d)) && step.status !== "SKIPPED") {
        await db.riisheWorkflowStep.update({
          where: { id: step.id },
          data: { status: "SKIPPED", error: "a dependency did not complete", finishedAt: new Date() },
        });
        bad.add(step.id);
        changed = true;
      }
    }
  }
  void byId;
  void userId;
}

/** Completion is derived from REAL step outcomes — never fabricated. */
export async function deriveWorkflowStatus(workflowId: string, userId: string): Promise<string> {
  const workflow = await db.riisheWorkflow.findFirst({ where: { id: workflowId, userId } });
  if (!workflow || workflow.status === "CANCELLED" || workflow.status === "PAUSED") {
    return workflow?.status ?? "MISSING";
  }
  const steps = await db.riisheWorkflowStep.findMany({ where: { workflowId } });
  const open = steps.filter((s) =>
    ["PENDING", "AWAITING_APPROVAL", "READY", "RUNNING"].includes(s.status)
  );
  if (open.length > 0) return workflow.status;
  const succeeded = steps.filter((s) => s.status === "SUCCEEDED").length;
  const next = succeeded > 0 ? "COMPLETED" : "FAILED";
  if (next !== workflow.status) {
    await db.riisheWorkflow.update({ where: { id: workflowId }, data: { status: next } });
    await notify({
      userId,
      actorId: null,
      type: "SYSTEM",
      payload: {
        text:
          next === "COMPLETED"
            ? `RIISHE workflow "${workflow.title}" completed — ${succeeded}/${steps.length} steps succeeded.`
            : `RIISHE workflow "${workflow.title}" finished without any successful step.`,
      },
      dedupKey: `riishe.wf:${workflowId}:done`,
    }).catch(() => undefined);
    await auditEvent(userId, `riishe.workflow.${next.toLowerCase()}`, "RiisheWorkflow", workflowId, {
      succeeded,
      total: steps.length,
    });
  }
  return next;
}

// ---------------------------------------------------------------- controls

export async function approveStep(userId: string, stepId: string, confirm: boolean) {
  const step = await db.riisheWorkflowStep.findFirst({ where: { id: stepId, userId } });
  if (!step) throw new WorkflowError("Step not found", "not-found");
  const tool = getTool(step.kind);
  if (tool && tool.risk === "DESTRUCTIVE" && !confirm) {
    throw new WorkflowError("Destructive actions need the explicit confirm interaction", "confirm-required");
  }
  await db.riisheWorkflowStep.update({
    where: { id: stepId },
    data: { approvedAt: new Date() },
  });
  await auditEvent(userId, "riishe.workflow.step_approved", "RiisheWorkflowStep", stepId, {
    tool: step.kind,
    risk: step.risk,
  });
}

export async function declineStep(userId: string, stepId: string) {
  const step = await db.riisheWorkflowStep.findFirst({ where: { id: stepId, userId } });
  if (!step) throw new WorkflowError("Step not found", "not-found");
  if (!["AWAITING_APPROVAL", "PENDING", "READY", "FAILED"].includes(step.status)) {
    throw new WorkflowError("This step can no longer be declined", "terminal");
  }
  await db.riisheWorkflowStep.update({
    where: { id: stepId },
    data: { status: "CANCELLED", error: "declined by the owner", finishedAt: new Date() },
  });
  if (step.backgroundJobId) {
    await cancelQueued(step.backgroundJobId, userId).catch(() => undefined);
  }
  await skipDependents(step.workflowId, step.id, userId);
  await afterStepTerminal(step.workflowId, userId);
  await auditEvent(userId, "riishe.workflow.step_declined", "RiisheWorkflowStep", stepId, { tool: step.kind });
}

export async function retryStep(userId: string, stepId: string) {
  const step = await db.riisheWorkflowStep.findFirst({ where: { id: stepId, userId } });
  if (!step) throw new WorkflowError("Step not found", "not-found");
  if (step.status !== "FAILED") throw new WorkflowError("Only failed steps can be retried", "invalid");
  const tool = getTool(step.kind);
  const needsApproval = tool && (tool.risk === "HIGH" || tool.risk === "DESTRUCTIVE");
  await db.riisheWorkflowStep.update({
    where: { id: stepId },
    data: {
      status: needsApproval ? "AWAITING_APPROVAL" : "READY",
      error: null,
      attempts: 0,
      approvedAt: null,
      finishedAt: null,
    },
  });
  await scheduleReadySteps(step.workflowId, userId);
  await auditEvent(userId, "riishe.workflow.step_retried", "RiisheWorkflowStep", stepId, { tool: step.kind });
}

export async function setWorkflowStatus(userId: string, workflowId: string, action: "pause" | "resume" | "cancel") {
  const workflow = await loadOwnedWorkflow(userId, workflowId);
  if (action === "pause") {
    if (workflow.status !== "ACTIVE") throw new WorkflowError("Only active workflows can be paused", "invalid");
    await db.riisheWorkflow.update({ where: { id: workflowId }, data: { status: "PAUSED" } });
    for (const step of workflow.steps) {
      if (step.status === "READY" && step.backgroundJobId) {
        await cancelQueued(step.backgroundJobId, userId).catch(() => undefined);
        await db.riisheWorkflowStep.update({ where: { id: step.id }, data: { status: "PENDING" } });
      }
    }
  } else if (action === "resume") {
    if (workflow.status !== "PAUSED") throw new WorkflowError("Only paused workflows can be resumed", "invalid");
    await db.riisheWorkflow.update({ where: { id: workflowId }, data: { status: "ACTIVE" } });
    const steps = await db.riisheWorkflowStep.findMany({ where: { workflowId } });
    const byId = new Map(steps.map((s) => [s.id, s]));
    for (const step of steps) {
      if (step.status === "PENDING" && !step.scheduledFor) {
        const deps = safeIds(step.dependsOnJson);
        const ok = deps.every((d) => byId.get(d)?.status === "SUCCEEDED");
        const tool = getTool(step.kind);
        if (ok && deps.length > 0) {
          await db.riisheWorkflowStep.update({
            where: { id: step.id },
            data: { status: tool && (tool.risk === "HIGH" || tool.risk === "DESTRUCTIVE") ? "AWAITING_APPROVAL" : "READY" },
          });
        }
      }
    }
    await scheduleReadySteps(workflowId, userId);
  } else {
    if (["COMPLETED", "CANCELLED"].includes(workflow.status)) {
      throw new WorkflowError("This workflow is already finished", "terminal");
    }
    for (const step of workflow.steps) {
      if (["PENDING", "READY", "AWAITING_APPROVAL"].includes(step.status)) {
        await db.riisheWorkflowStep.update({
          where: { id: step.id },
          data: { status: "CANCELLED", error: "workflow cancelled by the owner", finishedAt: new Date() },
        });
        if (step.backgroundJobId) await cancelQueued(step.backgroundJobId, userId).catch(() => undefined);
      }
    }
    await db.riisheWorkflow.update({ where: { id: workflowId }, data: { status: "CANCELLED" } });
    await auditEvent(userId, "riishe.workflow.cancelled", "RiisheWorkflow", workflowId, {});
  }
  return loadOwnedWorkflow(userId, workflowId);
}

// ---------------------------------------------------------------- sweep

/**
 * Durable recovery + scheduling pass (recurring queue job, every 5 min):
 *  - RUNNING steps with a stale heartbeat go back to READY (worker loss);
 *  - due scheduled steps become READY;
 *  - READY steps of ACTIVE workflows (re)enter the queue.
 */
export async function runWorkflowSweep(): Promise<{ recovered: number; scheduled: number }> {
  const staleBefore = new Date(Date.now() - STALE_RUNNING_MS);
  const stale = await db.riisheWorkflowStep.findMany({
    where: { status: "RUNNING", updatedAt: { lt: staleBefore } },
    take: 50,
  });
  let recovered = 0;
  for (const step of stale) {
    await db.riisheWorkflowStep.update({
      where: { id: step.id },
      data: { status: "READY", error: "recovered after a worker restart" },
    });
    recovered++;
  }

  const now = new Date();
  const due = await db.riisheWorkflowStep.findMany({
    where: { status: "PENDING", scheduledFor: { lte: now } },
    take: 100,
    include: { workflow: { select: { status: true, userId: true } } },
  });
  let scheduled = 0;
  for (const step of due) {
    if (step.workflow.status !== "ACTIVE") continue;
    const deps = safeIds(step.dependsOnJson);
    if (deps.length > 0) {
      const depRows = await db.riisheWorkflowStep.findMany({
        where: { id: { in: deps } },
        select: { id: true, status: true },
      });
      const states = depRows.map((d) => d.status);
      if (states.some((st) => ["FAILED", "SKIPPED", "CANCELLED"].includes(st))) {
        await db.riisheWorkflowStep.update({
          where: { id: step.id },
          data: { status: "SKIPPED", error: "a dependency did not complete", finishedAt: new Date() },
        });
        continue;
      }
      if (!states.every((st) => st === "SUCCEEDED")) continue;
    }
    const tool = getTool(step.kind);
    const next: StepStatus =
      tool && (tool.risk === "HIGH" || tool.risk === "DESTRUCTIVE") ? "AWAITING_APPROVAL" : "READY";
    await db.riisheWorkflowStep.update({ where: { id: step.id }, data: { status: next } });
    scheduled++;
  }

  const ready = await db.riisheWorkflowStep.findMany({
    where: { status: "READY", workflow: { status: "ACTIVE" } },
    take: 100,
    select: { id: true, workflowId: true, userId: true },
  });
  for (const step of ready) {
    await scheduleReadySteps(step.workflowId, step.userId);
    await db.riisheWorkflowStep.update({ where: { id: step.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
  }
  return { recovered, scheduled };
}

/** Re-derive completion for workflows whose last step just finished. */
export async function sweepWorkflowCompletions(): Promise<void> {
  const candidates = await db.riisheWorkflow.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, userId: true },
    take: 100,
  });
  for (const w of candidates) {
    await deriveWorkflowStatus(w.id, w.userId);
  }
}
