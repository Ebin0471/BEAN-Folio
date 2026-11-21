import { NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole } from "@/lib/ox/authz";
import { OX_OPPORTUNITY_WRITE_ROLES } from "@/lib/ox/validation";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { serializeOpportunity } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * POST /api/employers/[id]/opportunities/[opportunityId]/pause —
 * PUBLISHED → PAUSED.
 *
 * Pausing hides the listing from future publication surfaces without
 * destroying its approved content. Only a PUBLISHED row can pause (409 with
 * zero writes otherwise); the transition is an updateMany conditioned on
 * status=PUBLISHED, so a concurrent transition (e.g. an admin reviewing a
 * concurrently re-submitted edit) is a 409, never a torn state.
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

  const limited = await rateLimitShared(`ox:opportunity-write:${user.id}`, 60, 60_000);
  if (limited) return limited;

  const r = await parseBody(req, emptyBodySchema);
  if (r.response !== undefined) return r.response;

  const membership = await requireOrgRole(id, user.id, OX_OPPORTUNITY_WRITE_ROLES);
  if (!membership) return ERR.notFound();

  const row = await db.opportunity.findUnique({
    where: { id: opportunityId },
    include: SKILL_INCLUDE,
  });
  if (!row || row.organizationId !== id) return ERR.notFound();
  if (row.status !== "PUBLISHED") {
    return err("Only a PUBLISHED opportunity can be paused", 409, "OPPORTUNITY_NOT_PUBLISHED");
  }

  const guard = await db.opportunity.updateMany({
    where: { id: row.id, organizationId: id, status: "PUBLISHED" },
    data: { status: "PAUSED" },
  });
  if (guard.count !== 1) {
    return err("The opportunity changed state concurrently — review the current status and retry", 409, "OPPORTUNITY_STATE_CHANGED");
  }

  const updated = await db.opportunity.findUniqueOrThrow({ where: { id: row.id }, include: SKILL_INCLUDE });

  await auditOX(user.id, OX_AUDIT_ACTIONS.opportunityPaused, OX_TARGET.opportunity, row.id, {
    organizationId: id,
    from: "PUBLISHED",
    to: "PAUSED",
    actorRole: membership.role,
  });

  return ok({ opportunity: serializeOpportunity(updated, updated.skills) });
});
