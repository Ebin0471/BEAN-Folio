import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { cancelJob } from "@/lib/laxii/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/laxii/jobs/:id — cancel one of MY queued/running jobs
 * (owner-only). Succeeded jobs are never cancelled; their results belong
 * to the user as regular MediaAssets.
 */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;
  const job = await cancelJob(user.id, id);
  if (!job) return ERR.notFound();
  return ok({ job: { id: job.id, status: job.status } });
});
