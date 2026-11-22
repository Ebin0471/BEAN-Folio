import { NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { getOrg, orgIsVerified, requireOrgRole } from "@/lib/ox/authz";
import { OX_OPPORTUNITY_WRITE_ROLES } from "@/lib/ox/validation";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { serializeOpportunity } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * POST /api/employers/[id]/opportunities/[opportunityId]/reopen —
 * PAUSED → PUBLISHED.
 *
 * Reopening follows the approved lifecycle: a PAUSED row still carries its
 * admin-approved content UNTOUCHED (any content edit while PAUSED atomically
 * returned it to PENDING_REVIEW, so an editable-then-reopen shortcut is
 * structurally impossible). No new admin decision is therefore needed — but
 * the organization authorization is re-checked live: a since-SUSPENDED org
 * cannot put a listing back into circulation (403), and a since-UNVERIFIED
 * org cannot either (403). Only a PAUSED row reopens (409 with zero writes
 * otherwise).
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

  const org = await getOrg(id);
  if (!org) return ERR.notFound();
  if (org.verificationStatus === "SUSPENDED") {
    return err("A suspended organization cannot re-publish opportunities", 403, "ORG_SUSPENDED");
  }
  if (!orgIsVerified(org)) {
    return err("Only a VERIFIED organization can re-publish opportunities", 403, "ORG_NOT_VERIFIED");
  }

  const row = await db.opportunity.findUnique({
    where: { id: opportunityId },
    include: SKILL_INCLUDE,
  });
  if (!row || row.organizationId !== id) return ERR.notFound();
  if (row.status !== "PAUSED") {
    return err("Only a PAUSED opportunity can be reopened", 409, "OPPORTUNITY_NOT_PAUSED");
  }

  const guard = await db.opportunity.updateMany({
    where: { id: row.id, organizationId: id, status: "PAUSED" },
    data: { status: "PUBLISHED" },
  });
  if (guard.count !== 1) {
    return err("The opportunity changed state concurrently — review the current status and retry", 409, "OPPORTUNITY_STATE_CHANGED");
  }

  const updated = await db.opportunity.findUniqueOrThrow({ where: { id: row.id }, include: SKILL_INCLUDE });

  await auditOX(user.id, OX_AUDIT_ACTIONS.opportunityReopened, OX_TARGET.opportunity, row.id, {
    organizationId: id,
    from: "PAUSED",
    to: "PUBLISHED",
    actorRole: membership.role,
  });

  return ok({ opportunity: serializeOpportunity(updated, updated.skills) });
});
