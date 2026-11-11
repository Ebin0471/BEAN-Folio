import { NextRequest } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok, parseBody, rateLimit } from "@/lib/api-helpers";
import { aiGate } from "@/lib/ai";
import { HandoffError, createEngineeringHandoff, listHandoffs } from "@/lib/intelligence/handoff";
import { ArtifactError } from "@/lib/intelligence/artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  mediaId: z.string().min(10).max(64),
  repoId: z.string().min(10).max(64),
  request: z.string().trim().min(8).max(2000),
  sourceTaskId: z.string().min(10).max(64).nullish(),
  sourceLabel: z.string().trim().max(120).optional(),
});

/** GET /api/intelligence/handoffs — handoff history (owner only). */
export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  return ok({ handoffs: await listHandoffs(user.id) });
});

/**
 * POST /api/intelligence/handoffs — Workflow 2 (LAXII → CODE GIFTZ): propose
 * an engineering integration of an existing LAXII asset into an authorized
 * repository. Parked at AWAITING_APPROVAL; nothing runs before approval.
 */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`handoff:${user.id}`, 10, 60 * 60 * 1000)) return ERR.rateLimited();
  const gate = await aiGate(user);
  if (gate) return gate;

  const parsed = await parseBody(req, createSchema);
  if (parsed.response) return parsed.response;

  try {
    const out = await createEngineeringHandoff({
      userId: user.id,
      mediaId: parsed.data.mediaId,
      repoId: parsed.data.repoId,
      request: parsed.data.request,
      sourceTaskId: parsed.data.sourceTaskId ?? null,
      sourceLabel: parsed.data.sourceLabel,
    });
    return ok(out, out.duplicate ? 200 : 202);
  } catch (error) {
    if (error instanceof HandoffError || error instanceof ArtifactError) return err(error.message, error.status);
    return ERR.server();
  }
});
