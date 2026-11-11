/**
 * Code Giftz — execution job store (server-only, in-memory).
 *
 * Execution jobs are the agent's multi-step pipeline state: the approved plan,
 * the working config, per-step status and the verification report. Jobs live
 * in this process's memory (the same isolation boundary as the rate limiter),
 * are keyed by id AND owned by the creating user — every accessor takes the
 * userId and refuses cross-user access, so isolation is structural, not a
 * policy check buried in a route.
 *
 * One active job per user (single-flight) — the provider quota and the editor
 * canvas both assume a single authoritative pipeline per session.
 */
import type { SiteConfig } from "@/lib/site-config";
import type { DesignPlan, PlanStep } from "@/lib/ai-design/plan";
import type { VerificationReport } from "@/lib/ai-design/verify";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "done" | "repaired" | "failed" | "skipped";

export interface JobStep extends PlanStep {
  status: StepStatus;
  changes: string[];
  error?: string;
}

export interface DesignJob {
  id: string;
  userId: string;
  status: JobStatus;
  plan: DesignPlan;
  baseConfig: SiteConfig;
  working: SiteConfig;
  steps: JobStep[];
  changes: string[];
  verification: VerificationReport | null;
  error: string | null;
  cancelRequested: boolean;
  /** Source-material media ids for site.compose steps (owner-scoped reload). */
  materialIds: string[];
  createdAt: number;
  updatedAt: number;
}

const TTL_MS = 30 * 60 * 1000; // finished jobs are forgettable after 30 minutes
const MAX_JOBS_PER_USER = 4;

const globalForJobs = globalThis as unknown as { __beanDesignJobs?: Map<string, DesignJob> };
const store: Map<string, DesignJob> = (globalForJobs.__beanDesignJobs ??= new Map());

function prune() {
  const now = Date.now();
  for (const [id, job] of store) {
    const finished = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
    if (finished && now - job.updatedAt > TTL_MS) store.delete(id);
  }
}

export class JobConflictError extends Error {
  constructor(public jobId: string) {
    super("Another GIFTZ execution is already running for this account.");
  }
}

export function createJob(params: { userId: string; plan: DesignPlan; baseConfig: SiteConfig; materialIds?: string[] }): DesignJob {
  prune();
  for (const job of store.values()) {
    if (job.userId === params.userId && (job.status === "running" || job.status === "queued")) {
      throw new JobConflictError(job.id);
    }
  }
  // keep only the newest MAX_JOBS_PER_USER finished jobs per user
  const finished = [...store.values()].filter((j) => j.userId === params.userId && j.status !== "running" && j.status !== "queued");
  finished.sort((a, b) => b.createdAt - a.createdAt);
  for (const old of finished.slice(MAX_JOBS_PER_USER - 1)) store.delete(old.id);

  const id = `dgj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const job: DesignJob = {
    id,
    userId: params.userId,
    status: "queued",
    plan: params.plan,
    baseConfig: params.baseConfig,
    working: params.baseConfig,
    steps: params.plan.steps.map((s: PlanStep) => ({ ...s, status: "pending", changes: [] })),
    changes: [],
    verification: null,
    error: null,
    cancelRequested: false,
    materialIds: params.materialIds ?? [],
    createdAt: now,
    updatedAt: now,
  };
  store.set(id, job);
  return job;
}

/** Ownership-enforced accessor — a job is visible ONLY to its creator. */
export function getJob(userId: string, jobId: string): DesignJob | null {
  const job = store.get(jobId);
  if (!job || job.userId !== userId) return null;
  return job;
}

/** The user's most recent job (client reconnect after a page refresh). */
export function latestJob(userId: string): DesignJob | null {
  let best: DesignJob | null = null;
  for (const job of store.values()) {
    if (job.userId !== userId) continue;
    if (!best || job.createdAt > best.createdAt) best = job;
  }
  return best;
}

/**
 * The user's most recent FAILED job — the retry-the-failed-step path for
 * turns persisted before per-message job linkage existed (their metaJson
 * carries no jobId). Ownership is structural (userId-scoped), and the caller
 * still checks job.status === "failed" before offering a retry.
 */
export function latestFailedJob(userId: string): DesignJob | null {
  let best: DesignJob | null = null;
  for (const job of store.values()) {
    if (job.userId !== userId || job.status !== "failed") continue;
    if (!best || job.createdAt > best.createdAt) best = job;
  }
  return best;
}

/** Reset failed/skipped steps so the pipeline can continue from the failure. */
export function prepareRetry(job: DesignJob): boolean {
  if (job.status === "running" || job.status === "queued") return false;
  if (job.status === "completed") return false;
  job.cancelRequested = false;
  job.error = null;
  job.status = "queued";
  for (const step of job.steps) {
    if (step.status === "failed" || step.status === "skipped") {
      step.status = "pending";
      step.error = undefined;
    }
  }
  job.updatedAt = Date.now();
  return true;
}

export function requestCancel(userId: string, jobId: string): boolean {
  const job = getJob(userId, jobId);
  if (!job) return false;
  if (job.status === "queued" || job.status === "running") {
    job.cancelRequested = true;
    job.updatedAt = Date.now();
    return true;
  }
  return false;
}

export function touch(job: DesignJob) {
  job.updatedAt = Date.now();
}

/** Client-safe projection of a job (config only included when finished). */
export function jobSnapshot(job: DesignJob, includeConfig: boolean) {
  return {
    id: job.id,
    status: job.status,
    reply: job.plan.reply,
    notes: job.plan.notes ?? null,
    constraints: job.plan.constraints,
    // Included with the config (finished jobs only): the exact draft the plan
    // was approved against, so a reconnecting client can feed the builder's
    // stale-proposal guard instead of assuming the live draft.
    ...(includeConfig ? { baseConfig: job.baseConfig } : {}),
    steps: job.steps.map((s) => ({
      id: s.id,
      title: s.title,
      tool: s.tool,
      kind: s.kind,
      targets: s.targets,
      summary: s.summary,
      risk: s.risk,
      status: s.status,
      changes: s.changes,
      error: s.error ?? null,
    })),
    changes: job.changes,
    verification: job.verification,
    error: job.error,
    cancelRequested: job.cancelRequested,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(includeConfig ? { config: job.working } : {}),
  };
}
