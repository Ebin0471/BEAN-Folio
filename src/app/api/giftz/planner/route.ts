import { NextRequest } from "next/server";
import { z } from "zod";

import { err, handler, ok, parseBodySized, rateLimit } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { planWebsiteArchitecture } from "@/lib/giftz/site-planner";

export const dynamic = "force-dynamic";

/**
 * GIFTZ universal website planner — brief → family classification + honest
 * capability-routed architecture plan (M33.2).
 *
 * Pure planning engine: no persistence, no side effects, no model call, no
 * executable output. Brief/pages/features are untrusted DATA — prompt
 * injection gains no privileges and backend-required requests are never
 * routed into config/file generation.
 */

const plannerInputSchema = z
  .object({
    brief: z.string().min(1).max(20_000),
    familyId: z.string().max(64).optional(),
    pages: z.array(z.string().max(64)).max(20).optional(),
    features: z.array(z.string().max(120)).max(20).optional(),
  })
  .strict();

/** POST /api/giftz/planner — classify + plan + route a website request. */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return err("Authentication required", 401);
  if (!rateLimit(`giftz-planner:${user.id}`, 30, 60_000)) {
    return err("Too many requests. Please slow down.", 429);
  }

  const parsed = await parseBodySized(req, plannerInputSchema, 64_000);
  if (parsed.response) return parsed.response;

  const result = planWebsiteArchitecture(parsed.data);
  if (!result.ok) {
    return err(
      `Invalid input — ${result.field}: ${result.reason} Valid options include: ${result.suggestions.join(", ")}.`,
      400,
      "planner-rejected",
    );
  }
  return ok({ plan: result.plan });
});
