/**
 * Code Giftz — the execution driver (server-only).
 *
 * Durable, honest execution for a runtime that cannot guarantee background
 * work: a job is driven in BOUNDED chunks, each chunk running under a DB lease
 * claimed atomically (duplicate execution impossible). Whoever can execute
 * drives progress:
 *
 *  - the client's poll (GET /api/ai/design/job) calls driveJob — the request
 *    itself runs the next chunk (serverless-compatible: bounded work per
 *    request, progress persisted per step);
 *  - create/retry routes add a best-effort background kick so long-running
 *    node servers start immediately; on serverless the kick may be frozen
 *    after the response — the poll takes over, nothing is lost.
 *
 * If nobody polls, the job PAUSES mid-way with every completed step persisted
 * — it resumes on the next poll, reconnect or retry. That is the honest
 * contract; nothing pretends to run in the background when it cannot.
 *
 * Context reconstruction (retry safety): the execution grounding (portfolio
 * block + source materials) was persisted with the job at creation. Before a
 * chunk runs, `resolveStepContext` re-validates that the material ids are
 * still owned by the user — if not (deleted materials, foreign ids), it
 * rebuilds the context fresh from owner-scoped queries instead of trusting
 * stale or unauthorized context.
 */
import { db } from "@/lib/db";
import type { User } from "@prisma/client";

import { claimJob, getJob, persistJob, releaseLease, applyFailure, appendEvent, type DesignJob } from "@/lib/ai-design/jobs";
import { runDesignJob, type StepProvider, type StepContext } from "@/lib/ai-design/execute";
import { fetchPortfolioBlock } from "@/lib/ai-design/context";
import { loadMaterialsForRequest, materialsBlock } from "@/lib/ai-design/ingest";

/** Wall-clock budget for ONE poll-driven chunk (stays under request deadlines). */
export const TICK_BUDGET_MS = 40_000;
/** Budget for the best-effort background kick after create/retry. */
export const KICK_BUDGET_MS = 55_000;
/** Absolute cap for one driveJob invocation (kick mode). */
const MAX_TOTAL_MS = 4 * 60_000;

/**
 * True when every material id is still an owned media asset of this user.
 * Zero ids counts as owned (there is nothing to revalidate).
 */
async function materialsStillOwned(userId: string, materialIds: string[]): Promise<boolean> {
  if (materialIds.length === 0) return true;
  const count = await db.mediaAsset.count({ where: { id: { in: materialIds }, ownerId: userId } });
  return count === materialIds.length;
}

/**
 * Resolve the execution grounding for a job — persisted context when still
 * valid (material ownership re-checked), rebuilt fresh from owner-scoped
 * queries otherwise. The resolved context is persisted back so retries stay
 * consistent with what actually runs.
 */
export async function resolveStepContext(user: User, job: DesignJob): Promise<StepContext> {
  const persisted = job.context;
  if (persisted && (await materialsStillOwned(user.id, job.materialIds))) {
    return { ...persisted, allowedMediaIds: job.materialIds };
  }
  const ctx: StepContext = { portfolioText: await fetchPortfolioBlock(user) };
  if (job.materialIds.length > 0) {
    const materials = await loadMaterialsForRequest(user.id, job.materialIds);
    if (materials.length > 0) {
      ctx.materialsText = materialsBlock(materials);
    } else {
      appendEvent(job, "warn", "Source materials could not be reloaded (deleted or foreign ids) — continuing without them.");
    }
  }
  job.context = ctx;
  await persistJob(job);
  return ctx;
}

export interface DriveResult {
  /** Terminal outcome, "yielded" (budget), or "unclaimable" (finished/leased). */
  status: "completed" | "failed" | "cancelled" | "yielded" | "unclaimable";
}

/**
 * Drive a job forward in bounded chunks under the atomic lease. Safe to call
 * concurrently (only one caller wins each claim) and repeatedly (idempotent —
 * completed steps are never re-run).
 */
export async function driveJob(
  user: User,
  jobId: string,
  provider: StepProvider,
  opts: { chunkBudgetMs?: number; totalBudgetMs?: number } = {}
): Promise<DriveResult> {
  const chunkBudget = opts.chunkBudgetMs ?? TICK_BUDGET_MS;
  const totalDeadline = Date.now() + (opts.totalBudgetMs ?? MAX_TOTAL_MS);

  for (;;) {
    const job = await claimJob(user.id, jobId);
    if (!job) return { status: "unclaimable" }; // finished, unknown, or leased elsewhere

    let outcome;
    try {
      const ctx = await resolveStepContext(user, job);
      outcome = await runDesignJob(job, provider, ctx, {
        budgetMs: chunkBudget,
        persist: persistJob,
        recheckCancel: async () => {
          const fresh = await getJob(user.id, jobId);
          return fresh?.cancelRequested ?? false;
        },
      });
    } catch (e) {
      // Context loading or persistence failed — leave an honest failed state
      // with completed steps kept, never a phantom "queued" orphan.
      console.error("[design-driver] job crashed:", e instanceof Error ? e.message : e);
      applyFailure(job, "The execution stopped unexpectedly. You can retry the remaining steps.", { backoff: false });
      appendEvent(job, "error", "Driver crashed while loading context or persisting progress.");
      await persistJob(job).catch(() => {});
      return { status: "failed" };
    } finally {
      await releaseLease(job).catch(() => {});
    }

    if (outcome.status !== "yielded") return { status: outcome.status };
    if (Date.now() > totalDeadline) return { status: "yielded" };
  }
}
