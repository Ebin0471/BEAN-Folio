import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { aiComplete, aiGate, recordAiUsage, AI_DEEP_TIMEOUT_MS } from "@/lib/ai";
import { getJob, jobSnapshot, latestJob, prepareRetry, requestCancel } from "@/lib/ai-design/jobs";
import { runDesignJob, type StepProvider } from "@/lib/ai-design/execute";

export const dynamic = "force-dynamic";

const FINISHED = new Set(["completed", "failed", "cancelled"]);

/** The provider for model-tool steps: deep reasoning, extended deadline. */
const stepProvider: StepProvider = {
  complete: (system, messages, opts) =>
    aiComplete(system, messages, { ...opts, thinking: true, timeoutMs: AI_DEEP_TIMEOUT_MS }),
};

/**
 * GET /api/ai/design/job[?id=…] — poll a Code Giftz execution job.
 *
 * Ownership is structural: every accessor takes the session user's id and a
 * job is only ever visible to its creator. Without `id`, the user's most
 * recent job is returned (client reconnect after a refresh or tab switch).
 * The working config + the plan's base config are included only for finished
 * jobs — running configs are intermediate state nobody should act on.
 */
export const GET = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const id = req.nextUrl.searchParams.get("id");
  const job = id ? getJob(user.id, id) : latestJob(user.id);
  if (!job) return err("No GIFTZ execution found for your account.", 404);

  return ok({ job: jobSnapshot(job, FINISHED.has(job.status)) });
});

const jobActionSchema = z.object({
  jobId: z.string().min(1).max(80),
  action: z.enum(["cancel", "retry"]),
});

/**
 * POST /api/ai/design/job — control an owned job.
 *  - cancel: cooperative cancellation at the next step boundary (completed
 *    steps are kept and remain previewable).
 *  - retry: reset failed/skipped steps and continue the SAME job from where
 *    it stopped — completed steps are never re-run.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const r = await parseBody(req, jobActionSchema);
  if (r.response) return r.response;
  const { jobId, action } = r.data;

  if (action === "cancel") {
    if (!requestCancel(user.id, jobId)) {
      return err("That execution cannot be cancelled (unknown job, or it already finished).", 409);
    }
    const job = getJob(user.id, jobId);
    return ok({ jobId, status: job?.status ?? "running", cancelRequested: true });
  }

  // retry — model calls cost the same as a fresh execution, so the retry
  // passes the same consent + burst + daily-quota gate as every other AI route.
  const job = getJob(user.id, jobId);
  if (!job) return err("That execution no longer exists (expired). Ask GIFTZ to plan again.", 404);
  const preRetryStatuses = job.steps.map((s) => [s.id, s.status] as const);
  if (!prepareRetry(job)) {
    return err("That execution is already running or finished successfully.", 409);
  }
  const blocked = await aiGate(user);
  if (blocked) {
    // Roll the retry back — restore the exact pre-retry step statuses and the
    // failed job state so it stays retryable once the quota window resets.
    for (const [stepId, prev] of preRetryStatuses) {
      const step = job.steps.find((s) => s.id === stepId);
      if (step) step.status = prev;
    }
    job.status = "failed";
    job.updatedAt = Date.now();
    return blocked;
  }
  const provider: StepProvider = stepProvider;
  void runDesignJob(job, provider).catch(() => {
    job.status = "failed";
    job.error = "The execution stopped unexpectedly. You can retry the remaining steps.";
    for (const s of job.steps) if (s.status === "running" || s.status === "pending") s.status = "failed";
  });
  await recordAiUsage(user.id, "design-retry");
  return ok({ jobId: job.id, status: job.status });
});
