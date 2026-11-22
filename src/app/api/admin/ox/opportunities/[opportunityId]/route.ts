import { NextRequest } from "next/server";
import { requireAdmin, auditModeration } from "@/lib/admin";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { notifyMany } from "@/lib/notify";
import {
  opportunityDecisionSchema,
  opportunitySalaryIsComplete,
  salaryPaiseFromStorage,
  OX_OPPORTUNITY_MAX_PREFERRED_SKILLS,
  OX_OPPORTUNITY_MAX_REQUIRED_SKILLS,
  OX_OPPORTUNITY_MAX_TOTAL_SKILLS,
  type OpportunityDecisionInput,
} from "@/lib/ox/validation";
import { serializeOpportunity } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * GET   /api/admin/ox/opportunities/[opportunityId] — admin review detail:
 *       the full row (with skill chips), the organization display triple,
 *       and the audit trail for this opportunity (verification detail
 *       pattern).
 * PATCH /api/admin/ox/opportunities/[opportunityId] — the ONLY route to
 *       PUBLISHED (approved lifecycle: admin-only approval).
 *         APPROVE — PENDING_REVIEW rows only. Re-checks before the write:
 *                   organization still VERIFIED (409 otherwise), complete
 *                   salary range (400 otherwise), skill caps intact (400
 *                   otherwise). The transition is an updateMany conditioned
 *                   on status=PENDING_REVIEW — a concurrent employer edit
 *                   (which returns the row to review with new content) or a
 *                   concurrent decision is a 409 with zero writes.
 *         REJECT  — PENDING_REVIEW rows only (reason REQUIRED). The row
 *                   atomically returns to DRAFT with the rejection reason
 *                   recorded, so the employer can revise and resubmit.
 *       Both decisions are audited (`auditModeration`) and notify the org's
 *       active OWNER/ADMIN/RECRUITER members (best-effort `notify()`, never
 *       a direct notification-table write).
 */

type RouteParams = { params: Promise<{ opportunityId: string }> };

const SKILL_INCLUDE = {
  skills: { include: { skill: { select: { id: true, slug: true, label: true } } } },
} as const;

export const GET = handler(async (_req: NextRequest, { params }: RouteParams) => {
  const admin = await requireAdmin();
  if (!admin) return ERR.forbidden();

  const { opportunityId: id } = await params;
  const row = await db.opportunity.findUnique({
    where: { id },
    include: {
      skills: SKILL_INCLUDE.skills,
      organization: { select: { id: true, legalName: true, displayName: true, slug: true, verificationStatus: true } },
    },
  });
  if (!row) return ERR.notFound();

  const auditTrail = await db.auditEvent.findMany({
    where: { targetType: "OPPORTUNITY", targetId: row.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, action: true, actorUserId: true, meta: true, createdAt: true },
  });

  return ok({
    opportunity: serializeOpportunity(row, row.skills),
    organization: row.organization,
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
  if (!sameOriginOk(req)) return ERR.forbidden();

  const { opportunityId: id } = await params;

  const limited = await rateLimitShared(`ox:opportunity-review:${admin.id}`, 60, 60_000);
  if (limited) return limited;

  const r = await parseBody(req, opportunityDecisionSchema);
  if (r.response !== undefined) return r.response;
  const input: OpportunityDecisionInput = r.data;

  const row = await db.opportunity.findUnique({
    where: { id },
    include: {
      skills: SKILL_INCLUDE.skills,
      organization: { select: { id: true, legalName: true, displayName: true, slug: true, verificationStatus: true } },
    },
  });
  if (!row) return ERR.notFound();

  if (row.status !== "PENDING_REVIEW") {
    return err("Only a PENDING_REVIEW opportunity can be decided", 409, "OPPORTUNITY_NOT_PENDING_REVIEW");
  }

  if (input.decision === "APPROVE") {
    if (row.organization.verificationStatus !== "VERIFIED") {
      return err("The organization is no longer VERIFIED — the opportunity cannot be published", 409, "ORG_NO_LONGER_VERIFIED");
    }

    // Approval re-checks (approved lifecycle): completeness and salary rules
    // are re-validated at decision time, not trusted from submit time.
    const salaryComplete = opportunitySalaryIsComplete({
      salaryMinPaise: salaryPaiseFromStorage(row.salaryMinPaise),
      salaryMaxPaise: salaryPaiseFromStorage(row.salaryMaxPaise),
      salaryCurrency: row.salaryCurrency,
      compensationPeriod: row.compensationPeriod,
    });
    if (!salaryComplete) {
      return err(
        "A complete salary range (minimum, maximum, currency and period) is required before publication",
        400,
        "OPPORTUNITY_SALARY_INCOMPLETE"
      );
    }

    const required = row.skills.filter((s) => s.kind === "REQUIRED").length;
    const preferred = row.skills.length - required;
    if (
      row.skills.length > OX_OPPORTUNITY_MAX_TOTAL_SKILLS ||
      required > OX_OPPORTUNITY_MAX_REQUIRED_SKILLS ||
      preferred > OX_OPPORTUNITY_MAX_PREFERRED_SKILLS
    ) {
      return err("Skill caps are violated on this row", 400, "OPPORTUNITY_SKILL_LIMITS_VIOLATED");
    }

    const guard = await db.opportunity.updateMany({
      where: { id: row.id, status: "PENDING_REVIEW" },
      data: {
        status: "PUBLISHED",
        publishedAt: new Date(),
        publishedByUserId: admin.id,
        rejectionReason: null,
      },
    });
    if (guard.count !== 1) {
      return err("The opportunity changed state concurrently — review the current status and retry", 409, "OPPORTUNITY_STATE_CHANGED");
    }
  } else {
    const guard = await db.opportunity.updateMany({
      where: { id: row.id, status: "PENDING_REVIEW" },
      data: {
        status: "DRAFT",
        rejectionReason: input.rejectionReason ?? null,
        submittedAt: null,
      },
    });
    if (guard.count !== 1) {
      return err("The opportunity changed state concurrently — review the current status and retry", 409, "OPPORTUNITY_STATE_CHANGED");
    }
  }

  const updated = await db.opportunity.findUniqueOrThrow({ where: { id: row.id }, include: SKILL_INCLUDE });

  await auditModeration(
    admin.id,
    input.decision === "APPROVE" ? "ox.opportunity.approved" : "ox.opportunity.rejected",
    "OPPORTUNITY",
    row.id,
    {
      organizationId: row.organizationId,
      from: "PENDING_REVIEW",
      to: input.decision === "APPROVE" ? "PUBLISHED" : "DRAFT",
      rejectionReason: input.rejectionReason ?? null,
    }
  );

  // Best-effort notification of the org's active working members (approved
  // decision: reuse notify(); never a direct notification-table write).
  const recipients = await db.employerMembership.findMany({
    where: { organizationId: row.organizationId, status: "ACTIVE", role: { in: ["OWNER", "ADMIN", "RECRUITER"] } },
    select: { userId: true },
  });
  await notifyMany(
    recipients.map((m) => ({
      userId: m.userId,
      actorId: admin.id,
      type: "SYSTEM" as const,
      payload: {
        kind: "ox-opportunity-decision",
        decision: input.decision,
        opportunityId: row.id,
        title: row.title,
        organizationId: row.organizationId,
        ...(input.rejectionReason ? { rejectionReason: input.rejectionReason } : {}),
      },
      targetId: row.id,
      dedupKey: `ox-opportunity-${input.decision.toLowerCase()}:${row.id}`,
    }))
  );

  return ok({ opportunity: serializeOpportunity(updated, updated.skills) });
});
