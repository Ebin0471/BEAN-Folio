import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { aiGate, recordAiUsage } from "@/lib/ai";
import { getJob, jobSnapshot, latestJob, prepareRetry, requestCancel, persistJob, enqueueDesignJobDrive } from "@/lib/ai-design/jobs";
import { driveJob, designStepProvider } from "@/lib/ai-design/driver";

export const dynamic = "force-dynamic";

const FINISHED = new Set(["completed", "failed", "cancelled"]);

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
  const job = id ? await getJob(user.id, id) : await latestJob(user.id);
  if (!job) return err("No GIFTZ execution found for your account.", 404);

  return ok({ job: jobSnapshot(job, FINISHED.has(job.status)) });
});

const jobActionSchema = z.object({
  jobId: z.string().min(1).max(80),
  action: z.enum(["cancel", "retry"]),
});

/**
 * POST /api/ai/design/job — control an owned job.
 *  - cancel: durable, cross-instance cancellation — the flag is stamped on
 *    the job row (status-guarded) and honored by the executor at the next
 *    step boundary, on whichever instance runs it.
 *  - retry: reset failed/skipped steps and continue the SAME job from where
 *    it stopped — completed steps are never re-run. The retry budget and
 *    exponential backoff gate are enforced durably (MAX_RETRIES,
 *    nextAttemptAt).
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const r = await parseBody(req, jobActionSchema);
  if (r.response) return r.response;
  const { jobId, action } = r.data;

  if (action === "cancel") {
    if (!(await requestCancel(user.id, jobId))) {
      return err("That execution cannot be cancelled (unknown job, or it already finished).", 409);
    }
    const job = await getJob(user.id, jobId);
    return ok({ jobId, status: job?.status ?? "running", cancelRequested: true });
  }

  // retry — model calls cost the same as a fresh execution, so the retry
  // passes the same consent + burst + daily-quota gate as every other AI route.
  const job = await getJob(user.id, jobId);
  if (!job) return err("That execution no longer exists (expired). Ask GIFTZ to plan again.", 404);
  const preRetryStatuses = job.steps.map((s) => [s.id, s.status] as const);
  const retry = await prepareRetry(job);
  if (!retry.ok) {
    return err(retry.reason ?? "That execution cannot be retried right now.", retry.code ?? 409);
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
    job.error = null;
    job.updatedAt = Date.now();
    await persistJob(job);
    return blocked;
  }
  // Durable execution backbone + immediate same-process kick — the claim
  // lease arbitrates, so the poll path resumes anything that stalls.
  await enqueueDesignJobDrive(job.id, user.id);
  void driveJob(user, job.id, designStepProvider).catch(() => {});
  await recordAiUsage(user.id, "design-retry");
  return ok({ jobId: job.id, status: job.status });
});
