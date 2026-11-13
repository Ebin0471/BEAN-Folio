import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { toWorkflowDTO } from "@/lib/riishe/workflow-engine";

export const dynamic = "force-dynamic";

/**
 * GET /api/riishe/workflows — the owner's automation workflows, newest first,
 * with full step execution state. Strictly owner-scoped: the where clause
 * filters by userId, so nobody else's workflows are ever readable.
 */
export const GET = handler(async (_req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const rows = await db.riisheWorkflow.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { steps: { orderBy: { seq: "asc" } } },
  });

  return ok({ workflows: rows.map((w) => toWorkflowDTO(w)) });
});
