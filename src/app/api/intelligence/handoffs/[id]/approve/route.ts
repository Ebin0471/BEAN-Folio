import { NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok, rateLimit } from "@/lib/api-helpers";
import { HandoffError, approveEngineeringHandoff } from "@/lib/intelligence/handoff";
import { ArtifactError } from "@/lib/intelligence/artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/intelligence/handoffs/[id]/approve — registers the verified
 * artifact and creates the downstream CODE GIFTZ engineering task (which has
 * its OWN plan-approval gate before any repository change).
 */
export const POST = handler(async (_req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`handoff-approve:${user.id}`, 10, 60 * 60 * 1000)) return ERR.rateLimited();
  const { id } = await params;
  try {
    const out = await approveEngineeringHandoff({ userId: user.id, handoffId: id });
    return ok({ approved: true, downstreamTaskId: out.downstreamTaskId }, 202);
  } catch (error) {
    if (error instanceof HandoffError || error instanceof ArtifactError) return err(error.message, error.status);
    return ERR.server();
  }
});
