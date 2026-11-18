import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole } from "@/lib/ox/authz";
import {
  createOpportunitySchema,
  validateOpportunitySkillPayload,
  salaryPaiseToStorage,
  OX_OPPORTUNITY_STATUSES,
  OX_OPPORTUNITY_WRITE_ROLES,
  OX_ORG_ROLES,
  type CreateOpportunityInput,
} from "@/lib/ox/validation";
import { resolveOpportunitySkillIds } from "@/lib/ox/opportunity-skills";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { serializeOpportunity } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * GET  /api/employers/[id]/opportunities — list THIS organization's
 *       opportunities (any ACTIVE member role may read; VIEWER is explicitly
 *       read-only, so reading is permitted for every role).
 * POST /api/employers/[id]/opportunities — create one opportunity. Every
 *       creation lands in DRAFT (approved lifecycle): submission and
 *       publication are separate, explicitly authorized steps.
 *
 * Authorization: identity ONLY from the session; the membership lookup is
 * bound to (organizationId, userId); foreign organizations are a 404
 * (existence-hiding deny, O0 §5). Writers need an ACTIVE
 * OWNER/ADMIN/RECRUITER membership (approved decision; VIEWER and the
 * deferred HIRING_MANAGER assignment are read-only for opportunities).
 *
 * The skill taxonomy is reused, never extended (approved decision):
 * unknown skill slugs/labels are a 400 before any write. Skill caps
 * (REQUIRED ≤ 8 / PREFERRED ≤ 12 / total ≤ 20, minimum zero) are enforced
 * pre-write; duplicates inside one payload are a 400.
 */

type RouteParams = { params: Promise<{ id: string }> };

const SKILL_INCLUDE = {
  skills: { include: { skill: { select: { id: true, slug: true, label: true } } } },
} as const;

export const GET = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;

  const membership = await requireOrgRole(id, user.id, OX_ORG_ROLES);
  if (!membership) return ERR.notFound();

  const statusFilter = req.nextUrl.searchParams.get("status");
  if (statusFilter && !(OX_OPPORTUNITY_STATUSES as readonly string[]).includes(statusFilter)) {
    return err("Unknown status filter", 400, "OPPORTUNITY_UNKNOWN_STATUS_FILTER");
  }

  const rows = await db.opportunity.findMany({
    where: { organizationId: id, ...(statusFilter ? { status: statusFilter } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: SKILL_INCLUDE,
  });

  return ok({ opportunities: rows.map((row) => serializeOpportunity(row, row.skills)) });
});

export const POST = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { id } = await params;

  const limited = await rateLimitShared(`ox:opportunity-create:${id}`, 30, 3600_000);
  if (limited) return limited;

  const r = await parseBody(req, createOpportunitySchema);
  if (r.response !== undefined) return r.response;
  const input: CreateOpportunityInput = r.data;

  // Pre-write payload rules (standard 400, zero database writes).
  const skillViolation = input.skills ? validateOpportunitySkillPayload(input.skills) : null;
  if (skillViolation) return err(skillViolation, 400, skillViolation);

  const membership = await requireOrgRole(id, user.id, OX_OPPORTUNITY_WRITE_ROLES);
  if (!membership) return ERR.notFound();

  const resolved = await resolveOpportunitySkillIds(input.skills ?? []);
  if (!resolved.ok) return err("Unknown skill reference — the existing skill taxonomy is reused, never extended", 400, resolved.error);

  if (input.professionId !== undefined) {
    const professionExists = await db.profession.findUnique({ where: { id: input.professionId }, select: { id: true } });
    if (!professionExists) return err("Unknown profession reference", 400, "OPPORTUNITY_PROFESSION_NOT_FOUND");
  }

  const created = await db.$transaction(async (tx) => {
    const row = await tx.opportunity.create({
      data: {
        organizationId: id,
        createdByUserId: user.id,
        title: input.title,
        description: input.description,
        status: "DRAFT",
        professionId: input.professionId,
        location: input.location === undefined ? undefined : input.location === "" ? null : input.location,
        employmentType: input.employmentType,
        workMode: input.workMode,
        positions: input.positions,
        salaryMinPaise: input.salaryMinPaise === undefined ? undefined : salaryPaiseToStorage(input.salaryMinPaise),
        salaryMaxPaise: input.salaryMaxPaise === undefined ? undefined : salaryPaiseToStorage(input.salaryMaxPaise),
        salaryCurrency: input.salaryCurrency,
        compensationPeriod: input.compensationPeriod,
      },
    });
    if (resolved.resolved.length > 0) {
      await tx.opportunitySkill.createMany({
        data: resolved.resolved.map((s) => ({ opportunityId: row.id, skillId: s.skillId, kind: s.kind })),
      });
    }
    return tx.opportunity.findUniqueOrThrow({
      where: { id: row.id },
      include: SKILL_INCLUDE,
    });
  });

  await auditOX(user.id, OX_AUDIT_ACTIONS.opportunityCreated, OX_TARGET.opportunity, created.id, {
    organizationId: id,
    status: "DRAFT",
    actorRole: membership.role,
    skillCount: created.skills.length,
  });

  return ok({ opportunity: serializeOpportunity(created, created.skills) }, 201);
});
