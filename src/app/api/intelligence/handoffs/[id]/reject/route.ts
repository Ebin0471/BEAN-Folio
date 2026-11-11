import { NextRequest } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok, parseBody } from "@/lib/api-helpers";
import { HandoffError, rejectHandoff } from "@/lib/intelligence/handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const rejectSchema = z.object({ reason: z.string().trim().max(300).optional() });

/** POST /api/intelligence/handoffs/[id]/reject — reject before approval. */
export const POST = handler(async (req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;
  const parsed = await parseBody(req, rejectSchema);
  try {
    await rejectHandoff(user.id, id, parsed.data?.reason);
    return ok({ rejected: true, status: "CANCELLED" });
  } catch (error) {
    if (error instanceof HandoffError) return err(error.message, error.status);
    return ERR.server();
  }
});
