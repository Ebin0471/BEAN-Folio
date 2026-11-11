import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdmin, auditModeration } from "@/lib/admin";
import { ok, err, ERR, parseBody, handler } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET  /api/admin/reports/[id] — full report detail for the review screen.
 * PATCH /api/admin/reports/[id] — record a moderation outcome.
 *
 * Authorization: ADMIN session required (403 otherwise — same response for
 * anonymous and non-admin callers).
 *
 * PATCH body: { status: "REVIEWED" | "RESOLVED", note?: string (<= 2000) }
 * Transitions: OPEN → REVIEWED | RESOLVED; REVIEWED → RESOLVED (or back to
 * REVIEWED is a no-op); RESOLVED is terminal — reopening is not allowed so a
 * tampered client cannot rewrite history. Every mutation writes an AuditEvent
 * (action "moderation.report.<status.toLowerCase()>") with the outcome, the
 * optional note, and the actor.
 */

const patchSchema = z.object({
  status: z.enum(["REVIEWED", "RESOLVED"]),
  note: z.string().trim().max(2000).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

async function loadReport(id: string) {
  return db.report.findUnique({
    where: { id },
    include: {
      reporter: {
        select: { id: true, name: true, username: true, email: true, isDemo: true, deletedAt: true, createdAt: true },
      },
    },
  });
}

async function targetSnapshot(targetType: string, targetId: string) {
  if (targetType === "PROJECT") {
    const p = await db.project.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        title: true,
        summary: true,
        status: true,
        visibility: true,
        category: true,
        createdAt: true,
        updatedAt: true,
        owner: { select: { id: true, username: true, name: true } },
      },
    });
    if (!p) return null;
    return { kind: "PROJECT" as const, project: p, profile: null };
  }
  if (targetType === "PROFILE") {
    const u = await db.user.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        username: true,
        name: true,
        headline: true,
        bio: true,
        profileVisibility: true,
        isDemo: true,
        deletedAt: true,
        createdAt: true,
        _count: { select: { projects: true } },
      },
    });
    if (!u) return null;
    return { kind: "PROFILE" as const, project: null, profile: u };
  }
  return null;
}

export const GET = handler(async (_req: NextRequest, { params }: RouteParams) => {
  const admin = await requireAdmin();
  if (!admin) return ERR.forbidden();

  const { id } = await params;
  const report = await loadReport(id);
  if (!report) return ERR.notFound();

  const target = await targetSnapshot(report.targetType, report.targetId);
  // The moderation decisions that touched this report — full history, newest first.
  const auditTrail = await db.auditEvent.findMany({
    where: { targetType: "REPORT", targetId: report.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, action: true, actorUserId: true, meta: true, createdAt: true },
  });

  return ok({
    report: {
      id: report.id,
      targetType: report.targetType,
      targetId: report.targetId,
      reason: report.reason,
      details: report.details,
      status: report.status,
      createdAt: report.createdAt.toISOString(),
    },
    reporter: {
      id: report.reporter.id,
      name: report.reporter.name,
      username: report.reporter.username,
      isDemo: report.reporter.isDemo,
      deleted: Boolean(report.reporter.deletedAt),
      joinedAt: report.reporter.createdAt.toISOString(),
      // NOTE: the reporter's email is intentionally NOT returned here —
      // moderation review never needs it and it is PII.
    },
    target,
    auditTrail: auditTrail.map((a) => ({
      id: a.id,
      action: a.action,
      actorUserId: a.actorUserId,
      meta: a.meta,
      createdAt: a.createdAt.toISOString(),
    })),
  });
});

export const PATCH = handler(async (req: NextRequest, { params }: RouteParams) => {
  const admin = await requireAdmin();
  if (!admin) return ERR.forbidden();

  const { id } = await params;
  const r = await parseBody(req, patchSchema);
  if (r.response !== undefined) return r.response;

  const report = await db.report.findUnique({ where: { id } });
  if (!report) return ERR.notFound();

  if (report.status === "RESOLVED") {
    return err("This report is already resolved and can no longer be changed", 409);
  }
  if (report.status === r.data.status) {
    // Idempotent no-op — but still auditable so the touch is visible.
    await auditModeration(admin.id, `moderation.report.${r.data.status.toLowerCase()}`, "REPORT", report.id, {
      from: report.status,
      to: r.data.status,
      note: r.data.note ?? null,
      idempotent: true,
    });
    return ok({ report: { id: report.id, status: report.status } });
  }

  const updated = await db.report.update({
    where: { id: report.id },
    data: { status: r.data.status },
  });

  await auditModeration(admin.id, `moderation.report.${r.data.status.toLowerCase()}`, "REPORT", report.id, {
    from: report.status,
    to: updated.status,
    note: r.data.note ?? null,
  });

  return ok({ report: { id: updated.id, status: updated.status } });
});
