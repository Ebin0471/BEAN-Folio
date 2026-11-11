import { NextRequest } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok, parseBody, rateLimit } from "@/lib/api-helpers";
import { aiGate } from "@/lib/ai";
import { CreativeTaskError, createCreativeIntegrationTask } from "@/lib/giftz/creative";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const integrateSchema = z.object({ request: z.string().trim().min(8).max(2000) });

/**
 * POST /api/giftz/creative/[id]/integrate — the SECOND approval: turn the
 * completed asset into an engineering task (plan → plan approval → execution
 * with the artifact bytes substituted deterministically). Consuming the
 * artifact is single-shot, so a duplicate integration is refused.
 */
export const POST = handler(async (req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`giftz-integrate:${user.id}`, 10, 60 * 60 * 1000)) return ERR.rateLimited();
  const gate = await aiGate(user);
  if (gate) return gate;
  const { id } = await params;
  const parsed = await parseBody(req, integrateSchema);
  if (parsed.response) return parsed.response;

  try {
    const out = await createCreativeIntegrationTask({ userId: user.id, taskId: id, request: parsed.data.request });
    return ok(out, 202);
  } catch (error) {
    if (error instanceof CreativeTaskError) return err(error.message, error.status);
    return ERR.server();
  }
});
