import type { BackgroundJob } from "@prisma/client";

import { runAutomationJob } from "./engine";

/**
 * BackgroundJob handler for RIISHE automations. Registered by
 * src/lib/queue/handlers.ts (registerBuiltInHandlers) so instrumentation boot
 * and standalone workers both pick it up.
 *
 * The payload is { automationId, userId } — runAutomationJob enforces
 * ownership (per-user isolation) and ACTIVE status before doing anything.
 * Throwing here feeds the queue's own retry/backoff/dead-letter machinery.
 */
export async function runRiisheAutomationHandler(job: BackgroundJob): Promise<unknown> {
  let payload: { automationId?: string; userId?: string };
  try {
    payload = JSON.parse(job.payload) as { automationId?: string; userId?: string };
  } catch {
    throw new Error("riishe.automation payload is not valid JSON");
  }
  if (!payload.automationId || !payload.userId) {
    throw new Error("riishe.automation payload missing automationId/userId");
  }
  return runAutomationJob({ automationId: payload.automationId, userId: payload.userId });
}
