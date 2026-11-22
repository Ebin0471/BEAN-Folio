import { NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { getOrg, orgIsVerified, requireOrgRole } from "@/lib/ox/authz";
import {
  opportunitySalaryIsComplete,
  salaryPaiseFromStorage,
  OX_OPPORTUNITY_WRITE_ROLES,
} from "@/lib/ox/validation";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { serializeOpportunity } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * POST /api/employers/[id]/opportunities/[opportunityId]/submit —
 * DRAFT → PENDING_REVIEW.
 *
 * A submit NEVER publishes directly (approved lifecycle): publication is the
 * admin-only APPROVE decision. Checks before the write:
 *   - ACTIVE OWNER/ADMIN/RECRUITER membership of THIS org (404-deny others)
 *   - the organization is VERIFIED (403 otherwise) and not SUSPENDED
 *   - the row is still DRAFT (409 with zero writes otherwise)
 *   - the salary range is complete (min+max+ISO currency+period) — the
 *     approved "salary required before publish" rule; re-checked again at
 *     admin approval, so an incomplete row can never reach PUBLISHED.
 *
 * The transition itself is an updateMany conditioned on status=DRAFT, so a
 * concurrent lifecycle change is a 409 with zero writes.
 */

type RouteParams = { params: Promise<{ id: string; opportunityId: string }> };

const SKILL_INCLUDE = {
  skills: { include: { skill: { select: { id: true, slug: true, label: true } } } },
} as const;

const emptyBodySchema = z.object({}).strict();

export const POST = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { id, opportunityId } = await params;

  const limited = await rateLimitShared(`ox:opportunity-submit:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  const r = await parseBody(req, emptyBodySchema);
  if (r.response !== undefined) return r.response;

  const membership = await requireOrgRole(id, user.id, OX_OPPORTUNITY_WRITE_ROLES);
  if (!membership) return ERR.notFound();

  const org = await getOrg(id);
  if (!org) return ERR.notFound();
  if (org.verificationStatus === "SUSPENDED") {
    return err("A suspended organization cannot submit opportunities for review", 403, "ORG_SUSPENDED");
  }
  if (!orgIsVerified(org)) {
    return err("Only a VERIFIED organization can submit opportunities for review", 403, "ORG_NOT_VERIFIED");
  }

  const row = await db.opportunity.findUnique({
    where: { id: opportunityId },
    include: SKILL_INCLUDE,
  });
  if (!row || row.organizationId !== id) return ERR.notFound();
  if (row.status !== "DRAFT") {
    return err("Only a DRAFT opportunity can be submitted for review", 409, "OPPORTUNITY_NOT_DRAFT");
  }

  const salaryComplete = opportunitySalaryIsComplete({
    salaryMinPaise: salaryPaiseFromStorage(row.salaryMinPaise),
    salaryMaxPaise: salaryPaiseFromStorage(row.salaryMaxPaise),
    salaryCurrency: row.salaryCurrency,
    compensationPeriod: row.compensationPeriod,
  });
  if (!salaryComplete) {
    return err(
      "A complete salary range (minimum, maximum, currency and period) is required before review",
      400,
      "OPPORTUNITY_SALARY_INCOMPLETE"
    );
  }

  const guard = await db.opportunity.updateMany({
    where: { id: row.id, organizationId: id, status: "DRAFT" },
    data: { status: "PENDING_REVIEW", submittedAt: new Date(), rejectionReason: null },
  });
  if (guard.count !== 1) {
    return err("The opportunity changed state concurrently — review the current status and retry", 409, "OPPORTUNITY_STATE_CHANGED");
  }

  const updated = await db.opportunity.findUniqueOrThrow({ where: { id: row.id }, include: SKILL_INCLUDE });

  await auditOX(user.id, OX_AUDIT_ACTIONS.opportunitySubmitted, OX_TARGET.opportunity, row.id, {
    organizationId: id,
    from: "DRAFT",
    to: "PENDING_REVIEW",
    actorRole: membership.role,
  });

  return ok({ opportunity: serializeOpportunity(updated, updated.skills) });
});
