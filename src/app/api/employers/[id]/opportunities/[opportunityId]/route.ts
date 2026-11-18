import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole } from "@/lib/ox/authz";
import {
  updateOpportunitySchema,
  validateOpportunitySkillPayload,
  validateMergedOpportunityState,
  salaryPaiseToStorage,
  salaryPaiseFromStorage,
  OX_OPPORTUNITY_WRITE_ROLES,
  OX_ORG_ROLES,
  type UpdateOpportunityInput,
} from "@/lib/ox/validation";
import { resolveOpportunitySkillIds } from "@/lib/ox/opportunity-skills";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { serializeOpportunity } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * GET    /api/employers/[id]/opportunities/[opportunityId] — one opportunity
 *        of THIS organization (any ACTIVE member role may read).
 * PATCH  /api/employers/[id]/opportunities/[opportunityId] — partial content
 *        edit. State rules (approved lifecycle):
 *          DRAFT          → stays DRAFT
 *          PENDING_REVIEW → stays PENDING_REVIEW
 *          PUBLISHED      → atomically returns to PENDING_REVIEW
 *          PAUSED         → atomically returns to PENDING_REVIEW
 *          FILLED/CLOSED  → 409 (terminal rows are immutable)
 *        The PUBLISHED/PAUSED → PENDING_REVIEW return happens in the SAME
 *        transaction as the content write — there is no window where edited
 *        content stays publicly live without re-approval. The status guard
 *        is an updateMany conditioned on the read status, so a concurrent
 *        lifecycle transition turns the edit into a 409 with zero writes.
 * DELETE /api/employers/[id]/opportunities/[opportunityId] — audited,
 *        DRAFT-only (approved decision). Non-draft rows are a 409; the
 *        delete and its precondition run in one transaction and the audit
 *        event carries a snapshot of the deleted row.
 */

type RouteParams = { params: Promise<{ id: string; opportunityId: string }> };

const SKILL_INCLUDE = {
  skills: { include: { skill: { select: { id: true, slug: true, label: true } } } },
} as const;

async function loadOrgOpportunity(organizationId: string, opportunityId: string) {
  const row = await db.opportunity.findUnique({
    where: { id: opportunityId },
    include: SKILL_INCLUDE,
  });
  if (!row || row.organizationId !== organizationId) return null;
  return row;
}

export const GET = handler(async (_req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id, opportunityId } = await params;

  const membership = await requireOrgRole(id, user.id, OX_ORG_ROLES);
  if (!membership) return ERR.notFound();

  const row = await loadOrgOpportunity(id, opportunityId);
  if (!row) return ERR.notFound();

  return ok({ opportunity: serializeOpportunity(row, row.skills) });
});

export const PATCH = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { id, opportunityId } = await params;

  const limited = await rateLimitShared(`ox:opportunity-write:${user.id}`, 60, 60_000);
  if (limited) return limited;

  const r = await parseBody(req, updateOpportunitySchema);
  if (r.response !== undefined) return r.response;
  const input: UpdateOpportunityInput = r.data;

  const membership = await requireOrgRole(id, user.id, OX_OPPORTUNITY_WRITE_ROLES);
  if (!membership) return ERR.notFound();

  const row = await loadOrgOpportunity(id, opportunityId);
  if (!row) return ERR.notFound();

  if (row.status === "FILLED" || row.status === "CLOSED") {
    return err("A filled or closed opportunity can no longer be edited", 409, "OPPORTUNITY_TERMINAL_IMMUTABLE");
  }

  // Skill payload: wholesale replacement semantics, checked BEFORE the write.
  const wantsSkillReplace = input.skills !== undefined;
  const skillViolation = wantsSkillReplace ? validateOpportunitySkillPayload(input.skills ?? []) : null;
  if (skillViolation) return err(skillViolation, 400, skillViolation);
  const resolved = wantsSkillReplace
    ? await resolveOpportunitySkillIds(input.skills ?? [])
    : { ok: true as const, resolved: [] };
  if (!resolved.ok) return err("Unknown skill reference — the existing skill taxonomy is reused, never extended", 400, resolved.error);

  if (input.professionId !== undefined && input.professionId !== null) {
    const professionExists = await db.profession.findUnique({ where: { id: input.professionId }, select: { id: true } });
    if (!professionExists) return err("Unknown profession reference", 400, "OPPORTUNITY_PROFESSION_NOT_FOUND");
  }

  // Post-merge salary integrity (payload merged over the stored row, before
  // any write) — same semantics as the candidate profile (O2/O2.1).
  const mergedScalars = {
    salaryMinPaise: input.salaryMinPaise === undefined ? salaryPaiseFromStorage(row.salaryMinPaise) : input.salaryMinPaise,
    salaryMaxPaise: input.salaryMaxPaise === undefined ? salaryPaiseFromStorage(row.salaryMaxPaise) : input.salaryMaxPaise,
    salaryCurrency: input.salaryCurrency === undefined ? row.salaryCurrency : input.salaryCurrency,
    compensationPeriod: input.compensationPeriod === undefined ? row.compensationPeriod : input.compensationPeriod,
  };
  const salaryViolation = validateMergedOpportunityState(mergedScalars);
  if (salaryViolation) return err(salaryViolation, 400, salaryViolation);

  // Approved lifecycle: any content edit of a PUBLISHED/PAUSED row returns
  // it to PENDING_REVIEW (re-approval required); DRAFT and PENDING_REVIEW
  // keep their state; terminal rows were refused above.
  const returnsToReview = row.status === "PUBLISHED" || row.status === "PAUSED";
  const nextStatus = returnsToReview ? "PENDING_REVIEW" : row.status;

  const updated = await db.$transaction(async (tx) => {
    // Conditional update: the guard pins the status we read, so a concurrent
    // lifecycle transition turns this edit into a 409 with zero writes.
    const guard = await tx.opportunity.updateMany({
      where: { id: row.id, organizationId: id, status: row.status },
      data: {
        title: input.title,
        description: input.description,
        professionId: input.professionId,
        location:
          input.location === undefined
            ? undefined
            : input.location === "" || input.location === null
              ? null
              : input.location,
        employmentType: input.employmentType,
        workMode: input.workMode,
        positions: input.positions,
        salaryMinPaise:
          input.salaryMinPaise === undefined
            ? undefined
            : input.salaryMinPaise === null
              ? null
              : salaryPaiseToStorage(input.salaryMinPaise),
        salaryMaxPaise:
          input.salaryMaxPaise === undefined
            ? undefined
            : input.salaryMaxPaise === null
              ? null
              : salaryPaiseToStorage(input.salaryMaxPaise),
        salaryCurrency: input.salaryCurrency,
        compensationPeriod: input.compensationPeriod,
        status: nextStatus,
        submittedAt: returnsToReview ? new Date() : undefined,
      },
    });
    if (guard.count !== 1) {
      return null; // concurrent transition — zero writes happened
    }
    if (wantsSkillReplace) {
      await tx.opportunitySkill.deleteMany({ where: { opportunityId: row.id } });
      if (resolved.resolved.length > 0) {
        await tx.opportunitySkill.createMany({
          data: resolved.resolved.map((s) => ({ opportunityId: row.id, skillId: s.skillId, kind: s.kind })),
        });
      }
    }
    return tx.opportunity.findUniqueOrThrow({ where: { id: row.id }, include: SKILL_INCLUDE });
  });

  if (!updated) {
    return err("The opportunity changed state concurrently — review the current status and retry", 409, "OPPORTUNITY_STATE_CHANGED");
  }

  await auditOX(user.id, OX_AUDIT_ACTIONS.opportunityUpdated, OX_TARGET.opportunity, row.id, {
    organizationId: id,
    from: row.status,
    to: nextStatus,
    fields: Object.keys(input).filter((k) => input[k as keyof UpdateOpportunityInput] !== undefined),
    actorRole: membership.role,
  });

  return ok({ opportunity: serializeOpportunity(updated, updated.skills) });
});

export const DELETE = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { id, opportunityId } = await params;

  const limited = await rateLimitShared(`ox:opportunity-write:${user.id}`, 60, 60_000);
  if (limited) return limited;

  const membership = await requireOrgRole(id, user.id, OX_OPPORTUNITY_WRITE_ROLES);
  if (!membership) return ERR.notFound();

  const result = await db.$transaction(async (tx) => {
    const row = await tx.opportunity.findUnique({
      where: { id: opportunityId },
      include: SKILL_INCLUDE,
    });
    if (!row || row.organizationId !== id) return { kind: "notfound" as const };
    if (row.status !== "DRAFT") return { kind: "notdraft" as const, row };
    await tx.opportunity.delete({ where: { id: row.id } });
    return { kind: "deleted" as const, row };
  });

  if (result.kind === "notfound") return ERR.notFound();
  if (result.kind === "notdraft") {
    return err("Only a DRAFT opportunity can be deleted", 409, "OPPORTUNITY_DELETE_NOT_DRAFT");
  }

  // Audited deletion (approved decision): the audit event carries a snapshot
  // of the deleted row, so the deletion history survives the row itself.
  await auditOX(user.id, OX_AUDIT_ACTIONS.opportunityDeleted, OX_TARGET.opportunity, result.row.id, {
    organizationId: id,
    status: "DRAFT",
    title: result.row.title,
    skillCount: result.row.skills.length,
    actorRole: membership.role,
  });

  return ok({ deleted: true, id: result.row.id });
});
