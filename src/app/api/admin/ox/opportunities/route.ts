import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { OX_OPPORTUNITY_STATUSES } from "@/lib/ox/validation";
import { serializeOpportunity } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/ox/opportunities?status=PENDING_REVIEW|ALL|<status> —
 * admin review queue for employer opportunities.
 *
 * Authorization: ADMIN session required (`requireAdmin` — the same response
 * for anonymous and non-admin callers, 403, so the admin API's existence is
 * not advertised; O1 pattern). Default filter is PENDING_REVIEW (the working
 * queue); ALL lists every status; any single lifecycle status is accepted.
 * Rows carry their organization display triple and their skill chips with
 * taxonomy labels. take 50 (admin list convention).
 */
export const GET = handler(async (req: NextRequest) => {
  const admin = await requireAdmin();
  if (!admin) return ERR.forbidden();

  const statusFilter = req.nextUrl.searchParams.get("status") ?? "PENDING_REVIEW";
  const where =
    statusFilter === "ALL"
      ? {}
      : (OX_OPPORTUNITY_STATUSES as readonly string[]).includes(statusFilter)
        ? { status: statusFilter }
        : { status: "PENDING_REVIEW" };

  const rows = await db.opportunity.findMany({
    where,
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    take: 50,
    include: {
      skills: { include: { skill: { select: { id: true, slug: true, label: true } } } },
      organization: { select: { id: true, legalName: true, displayName: true, slug: true, verificationStatus: true } },
    },
  });

  return ok({
    opportunities: rows.map((row) => ({
      ...serializeOpportunity(row, row.skills),
      organization: row.organization,
    })),
  });
});
