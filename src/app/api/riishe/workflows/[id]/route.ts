import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import {
  loadOwned,
  setWorkflowStatus,
  toWorkflowDTO,
  WorkflowError,
} from "@/lib/riishe/workflow-engine";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  action: z.enum(["pause", "resume", "cancel"]),
});

function statusFor(e: WorkflowError): number {
  switch (e.reason) {
    case "not-found":
      return 404;
    case "terminal":
    case "invalid-transition":
    case "conflict":
      return 409;
    case "limits":
      return 429;
    default:
      return 400;
  }
}

/**
 * GET /api/riishe/workflows/[id] — one owned workflow with full step state.
 * A foreign id resolves to 404 (existence is never revealed).
 */
export const GET = handler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await ctx.params;
  try {
    const w = await loadOwned(user.id, id);
    return ok({ workflow: toWorkflowDTO(w) });
  } catch (e) {
    if (e instanceof WorkflowError && e.reason === "not-found") return ERR.notFound();
    throw e;
  }
});

/**
 * PATCH /api/riishe/workflows/[id] — pause / resume / cancel. Cancellation
 * also cancels the queued jobs of not-yet-started steps.
 */
export const PATCH = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await ctx.params;
  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;
  try {
    const w = await setWorkflowStatus(user.id, id, r.data.action);
    return ok({ workflow: toWorkflowDTO(w) });
  } catch (e) {
    if (e instanceof WorkflowError) return err(e.message, statusFor(e));
    throw e;
  }
});
