import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { getJob } from "@/lib/laxii/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/laxii/jobs/:id — poll one of MY jobs (owner-only; another user's
 * job id is indistinguishable from a nonexistent one).
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;
  const job = await getJob(user.id, id);
  if (!job) return ERR.notFound();
  return ok({
    job: {
      id: job.id,
      kind: job.kind,
      provider: job.provider,
      style: job.style,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      error: job.error,
      attempt: job.attempt,
      results: safeParse(job.resultsJson ?? "") ?? [],
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    },
  });
});

function safeParse(json: string): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
