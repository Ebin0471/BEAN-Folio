import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR, parseBody, rateLimit } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const reportSchema = z.object({
  targetType: z.enum(["PROJECT", "PROFILE"]),
  targetId: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(80),
  details: z.string().trim().max(1000).optional(),
});

export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  if (!rateLimit(`report:${user.id}`, 10, 3_600_000)) return ERR.rateLimited();

  const r = await parseBody(req, reportSchema);
  if (r.response) return r.response;
  const { targetType, targetId, reason, details } = r.data;

  // Target must exist (soft-deleted profiles are treated as gone).
  if (targetType === "PROJECT") {
    const project = await db.project.findUnique({ where: { id: targetId } });
    if (!project) return ERR.notFound();
  } else {
    const profile = await db.user.findUnique({ where: { id: targetId } });
    if (!profile || profile.deletedAt) return ERR.notFound();
  }

  await db.report.create({
    data: {
      reporterId: user.id,
      targetType,
      targetId,
      reason,
      details: details ?? null,
    },
  });

  await db.auditEvent.create({
    data: {
      actorUserId: user.id,
      action: "report.create",
      targetType,
      targetId,
      meta: JSON.stringify({ reason }),
    },
  });

  return ok({ ok: true });
});
