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
 *  - completion is derived from actual step outcomes — never fabricated;
 *  - M35.8: every execution claim is an ATOMIC conditional database
 *    transition (no check-then-update pair, no in-memory mutex — multiple
 *    workers may run in different processes). Only one worker can claim an
 *    eligible step; only one simultaneous approval request can claim an
 *    approval-class step; the loser never executes the tool. Terminal writes
 *    are ownership-guarded on the claim token (post-claim `attempts`), so a
 *    stale worker recovered by the sweep cannot overwrite the live attempt.
 *    Pause/cancel/status changes are conditionally guarded both ways: a
 *    control pass never clobbers a live claim, and a claim re-verifies the
 *    workflow status after claiming so a paused/cancelled workflow is never
 *    bypassed.
 */

import type { BackgroundJob, RiisheWorkflowStep } from "@prisma/client";

import { db } from "@/lib/db";
import { notify } from "@/lib/notify";
import { enqueue, cancelQueued } from "@/lib/queue";
import { auditEvent } from "@/lib/riishe/audit";
import { getTool, toolApprovalRequired, REF_FIELDS, REF_RESULT_KEYS, type RiisheToolDef, type ToolContext } from "@/lib/riishe/tools";
import { verifyMatchRefAuthorization } from "@/lib/ox/match-reference";
import {
  dailyActionCapStatus,
  initialStatusForStep,
  mayExecuteStep,
} from "@/lib/riishe/automation-policy";

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
  /** M31: validated specialist id from the planner (registry-checked). */
  specialist?: string | null;
};

/** Workflow + steps serialized for the UI/cards. */
export function toWorkflowDTO(w: {
  id: string;
  title: string;
  goal: string;
  status: string;
  planJson: string;
  specialistId?: string | null;
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
  let plan: { summary?: string; planner?: string; specialist?: string } = {};
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
    specialistId: w.specialistId ?? plan.specialist ?? null,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
    steps: w.steps.map((s) => ({
      id: s.id,
      seq: s.seq,
      ref: s.ref,
      tool: s.kind,
      title: s.title,
      risk: s.risk,
      // Registry-derived automation policy (B2): level + honest undo story.
      level: getTool(s.kind)?.level ?? null,
      undo: getTool(s.kind)?.undo ?? null,
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
/** M31: the workspace a workflow was created in (re-verified per execution). */
export interface WorkflowWorkspaceHint {
  type: "PERSONAL" | "ORGANIZATION";
  organizationId?: string | null;
  membershipRole?: string | null;
}

/** Parse the persisted workspace hint from a planJson (defensive). */
export function workspaceHintFromPlanJson(planJson: string): WorkflowWorkspaceHint | null {
  try {
    const parsed = JSON.parse(planJson) as { workspace?: WorkflowWorkspaceHint };
    if (parsed.workspace && (parsed.workspace.type === "PERSONAL" || parsed.workspace.type === "ORGANIZATION")) {
      return parsed.workspace;
    }
  } catch {
    // fall through
  }
  return null;
}

export async function createWorkflowFromPlan(
  userId: string,
  goal: string,
  plan: PlannerPlan,
  opts?: {
    conversationId?: string | null;
    planner?: "llm" | "deterministic";
    autoStart?: boolean;
    specialistId?: string | null;
    workspace?: WorkflowWorkspaceHint | null;
  }
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
  // M35.7: typed artefact references are validated against the plan's EXPLICIT
  // dependency graph at plan time — a ref param may only name a step the step
  // has declared in its own dependsOn (an earlier step by the rule above).
  // Forward references, self references, references to undeclared steps and
  // references to unknown ids are rejected before anything is persisted.
  for (const s of plan.steps) {
    const declared = new Set(s.dependsOn ?? []);
    for (const [k, v] of Object.entries(s.params ?? {})) {
      if (!REF_FIELDS.has(k) || typeof v !== "string") continue;
      if (v === s.id) {
        throw new WorkflowError(`step ${s.id} references itself via ${k} — artefact refs name an earlier producer step`, "invalid");
      }
      if (!planIds.has(v) || !declared.has(v)) {
        throw new WorkflowError(
          `step ${s.id} references "${k}: ${v}", which is not an explicit earlier dependency of that step — declare it in its dependsOn`,
          "invalid"
        );
      }
    }
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
        // M31 (additive): specialist ownership + creation-time workspace hint.
        // The hint is NEVER an authorization — org-scoped handlers re-verify
        // membership/role on every execution via src/lib/ox/authz.
        ...(opts?.specialistId ? { specialist: opts.specialistId } : {}),
        ...(opts?.workspace ? { workspace: opts.workspace } : {}),
      }),
      specialistId: opts?.specialistId ?? null,
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
    // B2: the REGISTRY decides approval policy (level 2/3 or HIGH/DESTRUCTIVE
    // risk) — never the model output, never the risk map alone. The owner's
    // automation preferences then decide whether an approval-class step can
    // start pre-authorized, and whether a Level-1 step auto-runs at all.
    // Scheduled or dependency-blocked steps stay PENDING; the unlock/sweep
    // paths apply the same policy when their time comes.
    const status: StepStatus =
      scheduledFor || !depsDone
        ? "PENDING"
        : ((await initialStatusForStep(userId, tool)) as StepStatus);
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
        requiresApproval: toolApprovalRequired(tool),
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

/**
 * Resolve planner-id refs (draftRef/postRef, M35 typed artefact refs) via the
 * referenced step's result — the mapping lives in REF_RESULT_KEYS.
 *
 * M35.7 validation, applied to EVERY ref param before it resolves:
 *  1. the referenced step must EXIST (planner id of a step in this workflow);
 *  2. it must be an EXPLICIT earlier dependency of the consuming step
 *     (declared in that step's persisted dependsOn) — refs against
 *     undeclared steps, forward references and self references are refused;
 *  3. the source step must have COMPLETED SUCCESSFULLY — artefacts resolve
 *     only from SUCCEEDED steps (a pending/running/failed/cancelled/skipped
 *     producer never yields its artefact);
 *  4. only then is the artefact read from the source step's result — a
 *     successful producer that carried no such artefact fails honestly
 *     (dependency-missing).
 * M36.3 addition (architecture §9, mandatory): a `matchRef` param is a
 * POINTER, never authorization — after the generic extraction succeeds, the
 * referenced TalentMatch row's CURRENT authorization state is re-verified
 * through src/lib/ox/match-reference.ts (row exists → tenant org → ACTIVE
 * OWNER/ADMIN/RECRUITER membership of the workflow owner → VERIFIED,
 * non-SUSPENDED organization → fresh candidate discovery boundary including
 * a fresh DISCOVERY-consent read). Revocation, blocks, role loss,
 * organization suspension or lost opportunity access between producer and
 * consumer FAIL the resolution — the stored id never grants visibility.
 * Existing ref behavior is unchanged (all other keys resolve exactly as
 * before).
 * Exported for the M35.7 safety suite (all error classes pinned against the
 * REAL engine + database).
 */
export async function resolveStepParams(
  workflowId: string,
  step: { id: string; paramsJson: string; kind: string; dependsOnJson: string }
): Promise<Record<string, unknown>> {
  const params = safeJson(step.paramsJson) ?? {};
  const tool = getTool(step.kind);
  if (!tool) return params;
  const needsResolution = Object.keys(params).some((k) => REF_FIELDS.has(k));
  if (!needsResolution) return params;
  const all = await db.riisheWorkflowStep.findMany({ where: { workflowId } });
  const byRef = new Map(all.map((s) => [s.ref, s]));
  const depRowIds = safeIds(step.dependsOnJson);
  const resolved: Record<string, unknown> = { ...params };
  for (const [k, v] of Object.entries(params)) {
    if (!REF_FIELDS.has(k) || typeof v !== "string") continue;
    const refStep = byRef.get(v);
    if (!refStep) throw new WorkflowError(`step reference "${v}" not found`, "invalid");
    if (refStep.id === step.id) {
      throw new WorkflowError(`step reference "${v}" would reference itself`, "invalid");
    }
    if (!depRowIds.includes(refStep.id)) {
      throw new WorkflowError(
        `referenced step "${v}" is not an explicit earlier dependency of this step — declare it in dependsOn`,
        "dependency-undeclared"
      );
    }
    if (refStep.status !== "SUCCEEDED") {
      throw new WorkflowError(
        `referenced step "${v}" has not completed successfully (status: ${refStep.status}) — artefacts resolve only from successful steps`,
        "dependency-failed"
      );
    }
    const result = safeJson(refStep.resultJson);
    const resultKey = REF_RESULT_KEYS[k] ?? "";
    const value = resultKey ? (result?.[resultKey] as string | undefined) : undefined;
    if (!value) {
      throw new WorkflowError(
        `referenced step "${v}" produced no ${resultKey || k} (status: ${refStep.status})`,
        "dependency-missing"
      );
    }
    // M36.3: matchRef resolution re-verifies CURRENT authorization — the
    // stored match id is only a pointer, never permission.
    if (k === "matchRef") {
      const workflow = await db.riisheWorkflow.findUnique({
        where: { id: workflowId },
        select: { userId: true },
      });
      if (!workflow) throw new WorkflowError("workflow not found for matchRef authorization re-verification", "not-found");
      const verification = await verifyMatchRefAuthorization(workflow.userId, value);
      if (!verification.ok) {
        throw new WorkflowError(
          `the referenced match "${value}" is no longer authorized (reason: ${verification.reason}) — a stored match id is a pointer, never permission`,
          "authorization-revoked"
        );
      }
    }
    resolved[k] = value;
  }
  return resolved;
}

async function executeTool(
  step: {
    id: string;
    kind: string;
    paramsJson: string;
    dependsOnJson: string;
    timeoutMs: number;
    workflowId: string;
  },
  userId: string,
  createInquiry?: ToolContext["createInquiry"],
  workspace?: WorkflowWorkspaceHint | null
): Promise<{ params: Record<string, unknown>; result: Record<string, unknown> }> {
  const tool = getTool(step.kind);
  if (!tool) throw new Error(`tool ${step.kind} is no longer registered`);
  const params = await resolveStepParams(step.workflowId, step);
  const ctx: ToolContext = {
    userId,
    workflowId: step.workflowId,
    stepId: step.id,
    createInquiry,
    // M31: creation-time workspace hint (planning context only — org tools
    // re-verify membership/role server-side before touching anything).
    ...(workspace
      ? {
          workspace: {
            type: workspace.type,
            organizationId: workspace.organizationId ?? null,
            membershipRole: workspace.membershipRole ?? null,
          },
        }
      : {}),
  };
  const result = await Promise.race([
    tool.execute(ctx, params as never),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`tool timed out after ${step.timeoutMs}ms`)), step.timeoutMs)
    ),
  ]);
  return { params, result: result ?? {} };
}

/**
 * B2 verify phase: when the tool declares a verify hook, RE-READ its
 * persistent output from the backend. A failed verification throws (the step
 * retries, then fails honestly) — success is never reported before the
 * persistent result is confirmed. On success the verification evidence is
 * recorded in the step's resultJson.
 */
async function verifyToolOutput(
  tool: RiisheToolDef<never>,
  ctx: Pick<ToolContext, "userId" | "workflowId" | "stepId">,
  params: Record<string, unknown>,
  result: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!tool.verify) return result;
  const verification = await tool.verify({ userId: ctx.userId, workflowId: ctx.workflowId, stepId: ctx.stepId }, params as never, result);
  if (!verification.ok) {
    throw new Error(`verification failed: ${verification.detail}`);
  }
  return { ...result, verification: { ok: true, detail: verification.detail, at: new Date().toISOString() } };
}

/** Exported for the B2 permission-matrix suite (verification-failure pins). */
export { verifyToolOutput };

// ---------------------------------------------------------------- claiming
//
// M35.8 — atomic execution & concurrency control. Every execution claim is a
// single conditional database transition (`updateMany` with the expected
// pre-status in the WHERE guard), never a check-then-update pair: only the
// writer whose UPDATE matches the guard flips the row to RUNNING, exactly
// like the durable queue's own status-guarded claim (src/lib/queue/index.ts).
// SQLite serializes writers, so the guard is atomic; the same pattern is the
// portable equivalent under PostgreSQL row-level MVCC. No in-memory mutex —
// workers may run in different processes. The post-claim `attempts` value is
// the ownership token: terminal writes are guarded on
// `status = "RUNNING" AND attempts = token`, so a stale worker (recovered by
// the sweep and re-claimed by a live attempt) can never overwrite the live
// attempt's outcome — at most one SUCCEEDED/FAILED transition per execution.

/** Statuses a QUEUE-delivered step may be claimed from (READY only). */
export const QUEUE_CLAIM_STATUSES = ["READY"] as const;
/**
 * Statuses an APPROVAL-TIME execution may claim from — the owner-initiated
 * path keeps its existing accepted set (PENDING/AWAITING_APPROVAL/READY plus
 * FAILED for approve-after-failure); terminal and RUNNING states are refused.
 */
export const APPROVAL_CLAIM_STATUSES = ["PENDING", "AWAITING_APPROVAL", "READY", "FAILED"] as const;

export type StepExecutionClaim =
  | { ok: true; step: RiisheWorkflowStep }
  | { ok: false };

/**
 * Atomically claim ONE workflow step for execution. Returns the FRESH row
 * (its `attempts` is the ownership token for the guarded terminal writes) or
 * `{ ok: false }` when a racing worker/control action won — the loser MUST
 * NOT execute the tool. `startedAt` is decided by the caller exactly like the
 * pre-M35.8 writes did (queue path preserves the first start across retries;
 * the approval path starts fresh).
 */
export async function claimStepExecution(
  stepId: string,
  userId: string,
  allowedStatuses: readonly string[],
  startedAt: Date
): Promise<StepExecutionClaim> {
  const won = await db.riisheWorkflowStep.updateMany({
    where: { id: stepId, userId, status: { in: [...allowedStatuses] } },
    data: { status: "RUNNING", startedAt, finishedAt: null, attempts: { increment: 1 } },
  });
  if (won.count !== 1) return { ok: false };
  const step = await db.riisheWorkflowStep.findUnique({ where: { id: stepId } });
  // The claim just landed on this exact row; a non-RUNNING read would mean a
  // concurrent control action already moved it — treat the claim as lost.
  if (!step || step.status !== "RUNNING") return { ok: false };
  return { ok: true, step };
}

/**
 * Guarded terminal write for a claimed execution: lands only while the
 * caller still OWNS the attempt (`status = RUNNING AND attempts = token`).
 * False means ownership was lost (the sweep recovered the stale RUNNING row
 * and another attempt claimed it) — the stale worker must not record its
 * outcome, audit success/failure or cascade dependents.
 */
export async function finishClaimedStep(
  stepId: string,
  userId: string,
  claimAttempts: number,
  data: { status: "SUCCEEDED" | "FAILED" | "READY" | "PENDING" | "CANCELLED"; resultJson?: string; error?: string | null; finishedAt?: Date | null }
): Promise<boolean> {
  const res = await db.riisheWorkflowStep.updateMany({
    where: { id: stepId, userId, status: "RUNNING", attempts: claimAttempts },
    data,
  });
  return res.count === 1;
}

/**
 * Post-claim control re-verification (pause/cancel bypass guard): if the
 * owning workflow is no longer ACTIVE the claim is released honestly —
 * PENDING under PAUSED (pause re-schedules on resume), CANCELLED with the
 * owner-cancellation reason under CANCELLED — and the caller must not
 * execute the tool. Returns true when a release happened.
 */
export async function releaseClaimIfWorkflowInactive(
  stepId: string,
  userId: string,
  workflowId: string,
  claimAttempts: number
): Promise<boolean> {
  const wf = await db.riisheWorkflow.findUnique({ where: { id: workflowId }, select: { status: true } });
  if (!wf || wf.status === "ACTIVE") return false;
  if (wf.status === "PAUSED") {
    await db.riisheWorkflowStep.updateMany({
      where: { id: stepId, userId, status: "RUNNING", attempts: claimAttempts },
      data: { status: "PENDING", finishedAt: null },
    });
    return true;
  }
  // CANCELLED — mirror what the cancel pass does to unclaimed steps.
  // (COMPLETED/FAILED are unreachable while an open step is claimed; release
  // to PENDING defensively — the workflow derivation leaves those closed.)
  const cancelled = wf.status === "CANCELLED";
  await db.riisheWorkflowStep.updateMany({
    where: { id: stepId, userId, status: "RUNNING", attempts: claimAttempts },
    data: {
      status: cancelled ? "CANCELLED" : "PENDING",
      ...(cancelled ? { error: "workflow cancelled by the owner", finishedAt: new Date() } : { finishedAt: null }),
    },
  });
  return true;
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
  if (step.status === "RUNNING") {
    // M35.7: another (in-flight) attempt owns this step — a duplicate or
    // early-redelivered job must NEVER execute the tool a second time
    // concurrently. The running attempt finishes the step; if its worker
    // died, the sweep recovers the stale RUNNING row and re-queues it.
    return;
  }
  if (workflow.status !== "ACTIVE") {
    // Paused/cancelled workflows stop scheduling; the job is released.
    return;
  }
  // B2 execution gate (defense in depth): the LIVE registry + the stored flag
  // decide — a Level-2 tool always requires approval even when the generic
  // risk map would have permitted execution, and the owner's current
  // pre-authorization preferences are honored (never a stale stored state).
  const tool = getTool(step.kind);
  if (!(await mayExecuteStep(payload.userId, step, tool))) {
    // M35.8: conditional — only a still-READY step moves to AWAITING_APPROVAL;
    // a row another worker just claimed (RUNNING) is left untouched.
    await db.riisheWorkflowStep.updateMany({
      where: { id: step.id, userId: payload.userId, status: "READY" },
      data: { status: "AWAITING_APPROVAL" },
    });
    return;
  }
  // B2 daily action cap: real executions are counted per owner per UTC day.
  // A step blocked by the cap FAILS honestly (retryable after 00:00 UTC);
  // dependents skip — nothing executes silently past the cap.
  const cap = await dailyActionCapStatus(payload.userId);
  if (!cap.allowed) {
    const capMessage = `Daily automation action cap reached (${cap.executedToday}/${cap.cap}). Retry after 00:00 UTC or raise your cap in RIISHE automation settings.`;
    // M35.8: conditional — the FAILED verdict only lands while the step is
    // still unclaimed (READY); a racing worker's live claim is never clobbered.
    const capLanded = await db.riisheWorkflowStep.updateMany({
      where: { id: step.id, userId: payload.userId, status: "READY" },
      data: { status: "FAILED", error: capMessage, finishedAt: new Date() },
    });
    if (capLanded.count === 1) {
      await auditEvent(payload.userId, "riishe.automation.daily_cap_reached", "RiisheWorkflowStep", step.id, {
        tool: step.kind,
        executedToday: cap.executedToday,
        cap: cap.cap,
      });
      await notify({
        userId: payload.userId,
        actorId: null,
        type: "SYSTEM",
        payload: { text: `RIISHE workflow "${workflow.title}" step "${step.title}" did not run: ${capMessage}` },
        dedupKey: `riishe.wfstep-cap:${step.id}`,
      }).catch(() => undefined);
      await skipDependents(step.workflowId, step.id, payload.userId);
      await afterStepTerminal(step.workflowId, payload.userId);
    }
    return;
  }

  // M35.8 — ATOMIC execution claim: one conditional transition decides the
  // winner. A duplicate delivery, a racing worker or a control action that
  // moved the row between the reads above all lose here and never execute
  // the tool. No in-memory mutex — safe across processes/instances.
  const claim = await claimStepExecution(step.id, payload.userId, QUEUE_CLAIM_STATUSES, step.startedAt ?? new Date());
  if (!claim.ok) return; // lost the race — the live attempt owns the step
  const claimToken = claim.step.attempts;

  // M35.8 — post-claim control re-verification: a pause/cancel that landed
  // between the pre-claim read and the claim must not be bypassed by this
  // worker. The claim is released honestly and nothing executes.
  if (await releaseClaimIfWorkflowInactive(step.id, payload.userId, step.workflowId, claimToken)) {
    return;
  }

  try {
    const { params, result } = await executeTool(claim.step, payload.userId, undefined, workspaceHintFromPlanJson(workflow.planJson));
    // B2 verify phase: re-read the persistent output before success is recorded.
    const verifiedResult = tool
      ? await verifyToolOutput(tool, { userId: payload.userId, workflowId: step.workflowId, stepId: step.id }, params, result)
      : result;
    // M35.8: the success write is ownership-guarded — a stale worker whose
    // claim was recovered and re-claimed cannot record a second outcome.
    const succeeded = await finishClaimedStep(step.id, payload.userId, claimToken, {
      status: "SUCCEEDED",
      resultJson: JSON.stringify(verifiedResult),
      error: null,
      finishedAt: new Date(),
    });
    if (!succeeded) return; // ownership lost — the live attempt owns the outcome
    await auditEvent(payload.userId, "riishe.workflow.step_succeeded", "RiisheWorkflowStep", step.id, {
      tool: step.kind,
    });
    if (tool) {
      // B2 uniform audit trail: every meaningful tool execution is audited
      // with the registry-declared action, regardless of handler-internal audits.
      await auditEvent(payload.userId, tool.auditAction, "RiisheWorkflowStep", step.id, {
        via: "workflow",
        workflowId: step.workflowId,
      });
    }
    await afterStepTerminal(step.workflowId, payload.userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // M35.8: attempts/maxAttempts come from the claim snapshot (the token is
    // the exact post-increment attempt count of THIS execution).
    if (claimToken >= claim.step.maxAttempts) {
      const failed = await finishClaimedStep(step.id, payload.userId, claimToken, {
        status: "FAILED",
        error: message.slice(0, 500),
        finishedAt: new Date(),
      });
      if (!failed) throw err; // ownership lost — the live attempt owns the outcome
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
    // M35.8: the retry write is ownership-guarded — if the sweep already
    // recovered this stale RUNNING row, it stays exactly as recovered.
    await finishClaimedStep(step.id, payload.userId, claimToken, {
      status: "READY",
      error: message.slice(0, 500),
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
  // B2: live approval gate + daily cap at approval-time execution too.
  const tool = getTool(step.kind);
  if (!(await mayExecuteStep(userId, step, tool))) {
    throw new WorkflowError("This step still needs your explicit approval", "approval-required");
  }
  const cap = await dailyActionCapStatus(userId);
  if (!cap.allowed) {
    throw new WorkflowError(
      `Daily automation action cap reached (${cap.executedToday}/${cap.cap}). Try again after 00:00 UTC.`,
      "daily-cap"
    );
  }
  // M35.8 — ATOMIC approval-time claim: only ONE simultaneous approval
  // request can transition the step to RUNNING; the loser never executes the
  // tool and gets exactly the error a sequential caller would have seen.
  const claim = await claimStepExecution(step.id, userId, APPROVAL_CLAIM_STATUSES, new Date());
  if (!claim.ok) {
    const winner = await db.riisheWorkflowStep.findUnique({ where: { id: step.id } });
    if (winner?.status === "SUCCEEDED") {
      return { already: true, result: safeJson(winner.resultJson) }; // the concurrent request finished it
    }
    if (winner?.status === "RUNNING") {
      throw new WorkflowError("This step is already running", "conflict");
    }
    throw new WorkflowError("This step can no longer run", "terminal");
  }
  const claimToken = claim.step.attempts;
  // M35.8 — post-claim control re-verification: a pause/cancel that landed
  // between the read and the claim is not bypassed; the claim is released.
  if (await releaseClaimIfWorkflowInactive(step.id, userId, step.workflowId, claimToken)) {
    throw new WorkflowError("The workflow is not active", "inactive");
  }
  try {
    const { params, result } = await executeTool(claim.step, userId, createInquiry, workspaceHintFromPlanJson(workflow.planJson));
    const verifiedResult = tool
      ? await verifyToolOutput(tool, { userId, workflowId: step.workflowId, stepId: step.id }, params, result)
      : result;
    // M35.8: ownership-guarded success write — a recovered stale attempt can
    // never record its outcome over the live attempt's.
    const succeeded = await finishClaimedStep(step.id, userId, claimToken, {
      status: "SUCCEEDED",
      resultJson: JSON.stringify(verifiedResult),
      error: null,
      finishedAt: new Date(),
    });
    if (!succeeded) {
      throw new WorkflowError("This step's execution was taken over by another attempt", "conflict");
    }
    await auditEvent(userId, "riishe.workflow.step_succeeded", "RiisheWorkflowStep", step.id, {
      tool: step.kind,
      via: "approval",
    });
    if (tool) {
      await auditEvent(userId, tool.auditAction, "RiisheWorkflowStep", step.id, {
        via: "approval",
        workflowId: step.workflowId,
      });
    }
    await afterStepTerminal(step.workflowId, userId);
    return { already: false, result: verifiedResult };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // M35.8: the FAILED write is ownership-guarded — without the claim it
    // lands nowhere and the live attempt keeps owning the outcome.
    const failed = await finishClaimedStep(step.id, userId, claimToken, {
      status: "FAILED",
      error: message.slice(0, 500),
      finishedAt: new Date(),
    });
    if (failed) {
      await auditEvent(userId, "riishe.workflow.step_failed", "RiisheWorkflowStep", step.id, {
        tool: step.kind,
        error: message.slice(0, 200),
      });
      await skipDependents(step.workflowId, step.id, userId);
      await afterStepTerminal(step.workflowId, userId);
    }
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
      // B2: registry + owner preferences decide the unlocked status.
      const next: StepStatus = await initialStatusForStep(userId, tool);
      // M35.8: conditional — a step a control action concurrently moved out
      // of PENDING (skipped/cancelled) is never resurrected by the unlock.
      await db.riisheWorkflowStep.updateMany({
        where: { id: step.id, status: "PENDING" },
        data: { status: next },
      });
      unlocked = true;
    } else if (depStates.some((st) => st === "FAILED" || st === "SKIPPED" || st === "CANCELLED")) {
      await db.riisheWorkflowStep.updateMany({
        where: { id: step.id, status: "PENDING" },
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
        // M35.8: conditional — only non-terminal, unclaimed dependents are
        // skipped (a live claim or a terminal row is never clobbered).
        const landed = await db.riisheWorkflowStep.updateMany({
          where: { id: step.id, status: { in: ["PENDING", "AWAITING_APPROVAL", "READY", "FAILED"] } },
          data: { status: "SKIPPED", error: "a dependency did not complete", finishedAt: new Date() },
        });
        if (landed.count === 1) {
          bad.add(step.id);
          changed = true;
        }
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
    // M35.8: the derived transition is guarded on the observed status — a
    // pause/cancel that landed while this derivation was running is never
    // overwritten by a stale completion.
    const landed = await db.riisheWorkflow.updateMany({
      where: { id: workflowId, status: workflow.status },
      data: { status: next },
    });
    if (landed.count !== 1) return workflow.status;
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
  // M35.7: an approval for a step that already reached a terminal state is a
  // REPLAY — refused instead of silently rewritten (execution never re-runs:
  // SUCCEEDED steps are final, CANCELLED/SKIPPED ones can no longer start).
  if (["SUCCEEDED", "CANCELLED", "SKIPPED"].includes(step.status)) {
    throw new WorkflowError("This step can no longer be approved", "terminal");
  }
  const tool = getTool(step.kind);
  if (tool && tool.risk === "DESTRUCTIVE" && !confirm) {
    throw new WorkflowError("Destructive actions need the explicit confirm interaction", "confirm-required");
  }
  // M35.8: the approval transition itself is ATOMIC — the conditional write
  // also refuses a replay that RACES a concurrent terminal transition (the
  // pre-read above can no longer be bypassed by an interleaving).
  const landed = await db.riisheWorkflowStep.updateMany({
    where: { id: stepId, userId, status: { notIn: ["SUCCEEDED", "CANCELLED", "SKIPPED"] } },
    data: { approvedAt: new Date() },
  });
  if (landed.count !== 1) {
    throw new WorkflowError("This step can no longer be approved", "terminal");
  }
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
  // M35.8: the decline transition is conditional — a step that was claimed
  // (RUNNING) or reached a terminal state between the read and the write is
  // never clobbered by the decline.
  const landed = await db.riisheWorkflowStep.updateMany({
    where: { id: stepId, userId, status: { in: ["AWAITING_APPROVAL", "PENDING", "READY", "FAILED"] } },
    data: { status: "CANCELLED", error: "declined by the owner", finishedAt: new Date() },
  });
  if (landed.count !== 1) {
    throw new WorkflowError("This step can no longer be declined", "terminal");
  }
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
  // B2: registry-derived approval (level 2/3 or HIGH/DESTRUCTIVE) re-enters
  // approval on retry; approval resets so confirmation is always fresh.
  const needsApproval = tool ? toolApprovalRequired(tool) : step.requiresApproval;
  // M35.8: the re-arm is conditional on FAILED — a step that concurrently
  // moved out of FAILED (skipped by a cascade, declined, claimed) is never
  // resurrected by a racing retry.
  const landed = await db.riisheWorkflowStep.updateMany({
    where: { id: stepId, userId, status: "FAILED" },
    data: {
      status: needsApproval ? "AWAITING_APPROVAL" : "READY",
      error: null,
      attempts: 0,
      approvedAt: null,
      finishedAt: null,
    },
  });
  if (landed.count !== 1) {
    throw new WorkflowError("Only failed steps can be retried", "invalid");
  }
  // A retry is explicit owner intent to finish the work: re-activate a
  // workflow that completion/failure derivation had closed (a CANCELLED
  // workflow stays cancelled — that was an explicit decision). M35.8: the
  // re-activation is guarded on the closed states.
  const workflow = await db.riisheWorkflow.findFirst({ where: { id: step.workflowId, userId } });
  if (workflow && (workflow.status === "COMPLETED" || workflow.status === "FAILED")) {
    await db.riisheWorkflow.updateMany({
      where: { id: workflow.id, status: { in: ["COMPLETED", "FAILED"] } },
      data: { status: "ACTIVE" },
    });
  }
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
        // M35.8: conditional — a READY step that a worker claimed (RUNNING)
        // between this pause's snapshot and this write keeps its live claim;
        // the worker's own post-claim re-verification releases it honestly.
        await db.riisheWorkflowStep.updateMany({
          where: { id: step.id, status: "READY" },
          data: { status: "PENDING" },
        });
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
        if (ok && deps.length > 0) {
          const tool = getTool(step.kind);
          // M35.8: conditional on PENDING — a step moved concurrently
          // (cancelled/skipped) is never resurrected by the resume.
          await db.riisheWorkflowStep.updateMany({
            where: { id: step.id, status: "PENDING" },
            data: { status: await initialStatusForStep(userId, tool) },
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
        // M35.8: conditional — a step a worker just claimed (RUNNING) is not
        // flipped by the cancel pass; the worker's post-claim re-verification
        // releases it with this exact same cancellation reason instead.
        const cancelled = await db.riisheWorkflowStep.updateMany({
          where: { id: step.id, status: { in: ["PENDING", "READY", "AWAITING_APPROVAL"] } },
          data: { status: "CANCELLED", error: "workflow cancelled by the owner", finishedAt: new Date() },
        });
        if (cancelled.count === 1 && step.backgroundJobId) {
          await cancelQueued(step.backgroundJobId, userId).catch(() => undefined);
        }
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
    // M35.8: the recovery write re-checks the SAME staleness predicate in its
    // WHERE guard — a step that completed (or was re-claimed) between the
    // read above and this write is never flipped back to READY (which would
    // resurrect a finished execution). Exactly one recovery per stale row.
    const landed = await db.riisheWorkflowStep.updateMany({
      where: { id: step.id, status: "RUNNING", updatedAt: { lt: staleBefore } },
      data: { status: "READY", error: "recovered after a worker restart" },
    });
    recovered += landed.count;
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
        // M35.8: conditional on PENDING — the skip never clobbers a row that
        // a racing unlock/cancel/claim already moved.
        await db.riisheWorkflowStep.updateMany({
          where: { id: step.id, status: "PENDING" },
          data: { status: "SKIPPED", error: "a dependency did not complete", finishedAt: new Date() },
        });
        continue;
      }
      if (!states.every((st) => st === "SUCCEEDED")) continue;
    }
    const tool = getTool(step.kind);
    // B2: registry + owner preferences decide how due steps start.
    const next: StepStatus = await initialStatusForStep(step.userId, tool);
    // M35.8: conditional on PENDING — a due step that raced a cancel/skip
    // between the read and this write is never resurrected to READY.
    const landed = await db.riisheWorkflowStep.updateMany({
      where: { id: step.id, status: "PENDING" },
      data: { status: next },
    });
    scheduled += landed.count;
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
