import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler } from "@/lib/api-helpers";
import { retryJob } from "@/lib/laxii/service";
import { LaxiiError } from "@/lib/laxii/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/laxii/jobs/:id/retry — re-run one of MY failed jobs
 * (owner-only, bounded retry budget with exponential backoff).
 */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;
  try {
    const job = await retryJob(user.id, id);
    if (!job) return ERR.notFound();
    return ok({ job: { id: job.id, status: job.status, attempt: job.attempt, error: job.error } });
  } catch (e) {
    if (e instanceof LaxiiError) return err(e.message, 400);
    throw e;
  }
});
