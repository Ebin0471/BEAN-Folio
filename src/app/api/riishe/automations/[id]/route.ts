import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import {
  cancelAutomation,
  pauseAutomation,
  resumeAutomation,
  snoozeAutomation,
  toAutomationDTO,
  AutomationError,
} from "@/lib/riishe/engine";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "snooze"]),
  days: z.number().int().min(1).max(30).optional(),
});

/**
 * PATCH /api/riishe/automations/[id] — pause / resume / cancel / snooze one of
 * the owner's automations. Ownership is enforced inside every transition.
 */
export const PATCH = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await ctx.params;
  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;
  try {
    let automation;
    switch (r.data.action) {
      case "pause":
        automation = await pauseAutomation(user.id, id);
        break;
      case "resume":
        automation = await resumeAutomation(user.id, id);
        break;
      case "cancel":
        automation = await cancelAutomation(user.id, id);
        break;
      case "snooze":
        automation = await snoozeAutomation(user.id, id, r.data.days ?? 1);
        break;
      default:
        return ERR.server();
    }
    return ok({ automation: toAutomationDTO(automation) });
  } catch (e) {
    if (e instanceof AutomationError) {
      return err(e.message, e.reason === "not-found" ? 404 : e.reason === "invalid-transition" ? 409 : 400);
    }
    throw e;
  }
});

/** DELETE /api/riishe/automations/[id] — cancel (revoke) the automation. */
export const DELETE = handler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await ctx.params;
  try {
    await cancelAutomation(user.id, id);
    return ok({ cancelled: true });
  } catch (e) {
    if (e instanceof AutomationError && e.reason === "not-found") return ERR.notFound();
    throw e;
  }
});
