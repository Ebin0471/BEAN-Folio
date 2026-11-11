import { NextRequest } from "next/server";

import { handler, err, ERR, rateLimit, getClientKey } from "@/lib/api-helpers";
import { aiGate, recordAiUsage } from "@/lib/ai";
import { getSessionUser } from "@/lib/auth";
import { retryStudioTurnStep } from "@/lib/site-studio/turn";

export const dynamic = "force-dynamic";
// The route only QUEUES the retry — the runner continues in the background
// and the studio polls /api/me/site/studio/turns/[taskId] (same 202 contract
// as starting a turn).
export const maxDuration = 60;

type Ctx = { params: Promise<{ taskId: string }> };

/**
 * POST /api/me/site/studio/turns/[taskId]/retry — retry ONLY the failed
 * step(s) of a failed turn.
 *
 * When one step of a multi-step execution fails, the completed steps are
 * preserved (their merged working config is the message's previewable
 * proposal). This endpoint re-runs JUST the failed/skipped steps of the SAME
 * execution job through the unchanged pipeline (same runner, same provider,
 * same schema validation, same preservation constraints) and — on success —
 * updates the SAME assistant message: the partial proposal is replaced by
 * the complete one and the turn lands DONE.
 *
 * Safety unchanged: the AI quota gate runs BEFORE any job mutation, single-
 * flight is enforced by the job store, and no validation is skipped. A job
 * that left memory (expiry/restart) returns an honest 410 — the full-turn
 * "Retry request" path remains available.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`studio-retry:${getClientKey(req)}`, 10, 60_000)) return ERR.rateLimited();

  const { taskId } = await params;
  const r = await retryStudioTurnStep({ userId: user.id, taskId }, { gate: () => aiGate(user) });
  if (!r.ok) {
    return err(r.error ?? "The retry could not be started.", r.status);
  }

  await recordAiUsage(user.id, "design-retry");
  return Response.json({ taskId, jobId: r.jobId, status: "running" }, { status: 202 });
});
