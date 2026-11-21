import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { POST as createInquiryHandler } from "@/app/api/inquiries/route";
import {
  approveStep,
  declineStep,
  executeApprovedStep,
  retryStep,
  WorkflowError,
} from "@/lib/riishe/workflow-engine";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  action: z.enum(["approve", "decline", "retry"]),
  /**
   * DESTRUCTIVE steps need a separate confirm interaction: the first approve
   * attempt without confirm gets "confirm-required" and the UI shows exactly
   * what will happen; the actual approval sends confirm=true.
   */
  confirm: z.boolean().optional().default(false),
});

function statusFor(e: WorkflowError): number {
  switch (e.reason) {
    case "not-found":
      return 404;
    case "terminal":
    case "conflict":
    case "inactive":
    case "approval-required":
      return 409;
    case "confirm-required":
      return 428; // precondition required — the UI shows the confirm dialog
    case "daily-cap":
      return 429; // daily automation action cap — honest quota semantics
    default:
      return 400;
  }
}

/**
 * PATCH /api/riishe/steps/[id] — owner-only step controls.
 *  approve: HIGH/DESTRUCTIVE steps run HERE, inside the authenticated request,
 *           through the real inquiry route handler when applicable (the queue
 *           never executes them). Succeeded steps are never executed twice.
 *  decline: cancels the step and skips its dependents.
 *  retry:   re-arms a failed step (HIGH/DESTRUCTIVE go back to approval).
 */
export const PATCH = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await ctx.params;
  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;

  try {
    if (r.data.action === "approve") {
      await approveStep(user.id, id, r.data.confirm);
      const result = await executeApprovedStep(user.id, id, createInquiryHandler);
      return ok({ executed: !result.already, result: result.result });
    }
    if (r.data.action === "decline") {
      await declineStep(user.id, id);
      return ok({ declined: true });
    }
    await retryStep(user.id, id);
    return ok({ retried: true });
  } catch (e) {
    if (e instanceof WorkflowError) return err(e.message, statusFor(e));
    throw e;
  }
});
