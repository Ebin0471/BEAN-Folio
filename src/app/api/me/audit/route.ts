import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/me/audit — the user's own audit trail (meta intentionally excluded). */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const rows = await db.auditEvent.findMany({
    where: { actorUserId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { action: true, targetType: true, targetId: true, createdAt: true },
  });

  return ok({
    events: rows.map((e) => ({
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      createdAt: e.createdAt.toISOString(),
    })),
  });
});
