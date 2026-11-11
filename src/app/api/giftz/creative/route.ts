import { NextRequest } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok, parseBody, rateLimit } from "@/lib/api-helpers";
import { aiGate } from "@/lib/ai";
import { CreativeTaskError, createCreativeAssetTask, listCreativeTasks } from "@/lib/giftz/creative";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  repoId: z.string().min(10).max(64),
  request: z.string().trim().min(8).max(2000),
});

/** GET /api/giftz/creative — creative asset request history. */
export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const tasks = await listCreativeTasks(user.id);
  return ok({ tasks });
});

/**
 * POST /api/giftz/creative — Workflow 1 (CODE GIFTZ → LAXII): inspect the
 * authorized repository, propose a structured creative request, park it at
 * AWAITING_APPROVAL. Nothing is generated before the user approves.
 */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`giftz-creative:${user.id}`, 10, 60 * 60 * 1000)) return ERR.rateLimited();
  const gate = await aiGate(user);
  if (gate) return gate;

  const parsed = await parseBody(req, createSchema);
  if (parsed.response) return parsed.response;

  try {
    const out = await createCreativeAssetTask({ userId: user.id, repoId: parsed.data.repoId, request: parsed.data.request });
    return ok(out, out.duplicate ? 200 : 202);
  } catch (error) {
    if (error instanceof CreativeTaskError) return err(error.message, error.status);
    return ERR.server();
  }
});
