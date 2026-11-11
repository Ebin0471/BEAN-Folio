import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/me/export/:jobId — owner only; includes the full payload JSON string. */
export const GET = handler(
  async (_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }): Promise<NextResponse> => {
    const user = await getSessionUser();
    if (!user) return ERR.unauthorized();

    const { jobId } = await params;

    const job = await db.exportJob.findUnique({ where: { id: jobId } });
    if (!job || job.userId !== user.id) return ERR.notFound();

    return ok({
      job: {
        id: job.id,
        status: job.status,
        payload: job.payload,
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt ? job.completedAt.toISOString() : null,
      },
    });
  }
);
