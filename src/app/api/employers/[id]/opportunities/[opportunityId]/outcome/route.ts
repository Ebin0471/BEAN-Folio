import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole } from "@/lib/ox/authz";
import { opportunityOutcomeSchema, OX_OPPORTUNITY_WRITE_ROLES, type OpportunityOutcomeInput } from "@/lib/ox/validation";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { serializeOpportunity } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * POST /api/employers/[id]/opportunities/[opportunityId]/outcome —
 * PUBLISHED | PAUSED → FILLED | CLOSED (one endpoint, explicit outcome —
 * approved decision).
 *
 * FILLED and CLOSED are TERMINAL: no further content edit, no reopen, no
 * second outcome (409 with zero writes on every attempt). The transition is
 * an updateMany conditioned on the read status, so concurrent lifecycle
 * changes are 409s, never torn states. `closedAt` records the moment the
 * row left active circulation.
 */

type RouteParams = { params: Promise<{ id: string; opportunityId: string }> };

const SKILL_INCLUDE = {
  skills: { include: { skill: { select: { id: true, slug: true, label: true } } } },
} as const;

export const POST = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { id, opportunityId } = await params;

  const limited = await rateLimitShared(`ox:opportunity-write:${user.id}`, 60, 60_000);
  if (limited) return limited;

  const r = await parseBody(req, opportunityOutcomeSchema);
  if (r.response !== undefined) return r.response;
  const input: OpportunityOutcomeInput = r.data;

  const membership = await requireOrgRole(id, user.id, OX_OPPORTUNITY_WRITE_ROLES);
  if (!membership) return ERR.notFound();

  const row = await db.opportunity.findUnique({
    where: { id: opportunityId },
    include: SKILL_INCLUDE,
  });
  if (!row || row.organizationId !== id) return ERR.notFound();
  if (row.status !== "PUBLISHED" && row.status !== "PAUSED") {
    return err("Only a PUBLISHED or PAUSED opportunity can be marked filled or closed", 409, "OPPORTUNITY_NOT_ACTIVE");
  }

  const targetStatus = input.outcome;
  const guard = await db.opportunity.updateMany({
    where: { id: row.id, organizationId: id, status: row.status },
    data: { status: targetStatus, closedAt: new Date() },
  });
  if (guard.count !== 1) {
    return err("The opportunity changed state concurrently — review the current status and retry", 409, "OPPORTUNITY_STATE_CHANGED");
  }

  const updated = await db.opportunity.findUniqueOrThrow({ where: { id: row.id }, include: SKILL_INCLUDE });

  await auditOX(
    user.id,
    targetStatus === "FILLED" ? OX_AUDIT_ACTIONS.opportunityFilled : OX_AUDIT_ACTIONS.opportunityClosed,
    OX_TARGET.opportunity,
    row.id,
    {
      organizationId: id,
      from: row.status,
      to: targetStatus,
      actorRole: membership.role,
    }
  );

  return ok({ opportunity: serializeOpportunity(updated, updated.skills) });
});
