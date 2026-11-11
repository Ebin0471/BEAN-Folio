import { NextRequest } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok, parseBody, rateLimit } from "@/lib/api-helpers";
import { aiGate } from "@/lib/ai";
import { GiftzTaskError, createEngineeringTask, listTasks, sweepStaleGiftzTasks } from "@/lib/giftz/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  repoId: z.string().min(10).max(64),
  request: z.string().trim().min(8).max(2000),
});

/** GET /api/giftz/tasks — task history (also sweeps stale executions first). */
export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const swept = await sweepStaleGiftzTasks();
  const tasks = await listTasks(user.id);
  return ok({ tasks, swept });
});

/**
 * POST /api/giftz/tasks — create an engineering task on an authorized repo.
 * Runs inspection + structured planning (schema-validated, one bounded
 * repair) and lands in AWAITING_APPROVAL. Duplicate prevention: creating
 * while a task is active re-attaches to it (`duplicate: true`).
 */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`giftz-task:${user.id}`, 10, 60 * 60 * 1000)) return ERR.rateLimited();
  const gate = await aiGate(user);
  if (gate) return gate;

  const parsed = await parseBody(req, createSchema);
  if (parsed.response) return parsed.response;

  try {
    const out = await createEngineeringTask({ userId: user.id, repoId: parsed.data.repoId, request: parsed.data.request });
    return ok(out, out.duplicate ? 200 : 202);
  } catch (error) {
    if (error instanceof GiftzTaskError) return err(error.message, error.status);
    return ERR.server();
  }
});
