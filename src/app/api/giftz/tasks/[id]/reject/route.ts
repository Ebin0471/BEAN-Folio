import { NextRequest } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok, parseBody } from "@/lib/api-helpers";
import { GiftzTaskError, rejectTask } from "@/lib/giftz/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const rejectSchema = z.object({ reason: z.string().trim().max(300).optional() });

/** POST /api/giftz/tasks/[id]/reject — refuse the plan; task becomes CANCELLED. */
export const POST = handler(async (req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;
  const parsed = await parseBody(req, rejectSchema);
  if (parsed.response) return parsed.response;

  try {
    await rejectTask(user.id, id, parsed.data.reason);
    return ok({ rejected: true, status: "CANCELLED" });
  } catch (error) {
    if (error instanceof GiftzTaskError) return err(error.message, error.status);
    return ERR.server();
  }
});
