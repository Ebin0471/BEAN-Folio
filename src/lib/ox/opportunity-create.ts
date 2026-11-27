import { db } from "@/lib/db";
import { requireOrgRole } from "@/lib/ox/authz";
import {
  validateOpportunitySkillPayload,
  salaryPaiseToStorage,
  OX_OPPORTUNITY_WRITE_ROLES,
  type CreateOpportunityInput,
} from "@/lib/ox/validation";
import { resolveOpportunitySkillIds } from "@/lib/ox/opportunity-skills";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";

/**
 * Opportunity Exchange (M36.2) — the ONE guarded server-side creation service
 * for employer opportunities, extracted from the authoritative POST route
 * (`POST /api/employers/[id]/opportunities`) so the existing HTTP contract and
 * the RIISHE `ox.opportunity.draft` tool reuse the EXACT same creation rules
 * (no second version of the boundary):
 *
 *   skill payload rules → ACTIVE OWNER/ADMIN/RECRUITER membership
 *   (requireOrgRole; null = existence-hiding deny) → taxonomy-only skill
 *   resolution (never an upsert) → profession existence → transactional
 *   DRAFT create + skill rows + read-back → `ox.opportunity.created` audit.
 *
 * Behavior is byte-equivalent to the pre-extraction POST route; the route
 * keeps the session/same-origin/rate-limit/HTTP-status mapping, this service
 * carries the authorization + validation + write + audit core.
 *
 * DRAFT-only by construction: `status: "DRAFT"` is hardcoded below — no
 * caller (route or tool) can influence the lifecycle state. Submission and
 * publication remain separate, explicitly authorized human/admin steps.
 */

/** The created row with its skill rows (the exact read-back shape the route serializes). */
export type CreatedOpportunityWithSkills = Awaited<ReturnType<typeof createOpportunityTransaction>>;

async function createOpportunityTransaction(
  actorUserId: string,
  organizationId: string,
  input: CreateOpportunityInput,
  resolved: { skillId: string; kind: string }[]
) {
  const SKILL_INCLUDE = {
    skills: { include: { skill: { select: { id: true, slug: true, label: true } } } },
  } as const;
  return db.$transaction(async (tx) => {
    const row = await tx.opportunity.create({
      data: {
        organizationId,
        createdByUserId: actorUserId,
        title: input.title,
        description: input.description,
        status: "DRAFT", // DRAFT-only invariant — never caller-controlled
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
    if (resolved.length > 0) {
      await tx.opportunitySkill.createMany({
        data: resolved.map((s) => ({ opportunityId: row.id, skillId: s.skillId, kind: s.kind })),
      });
    }
    return tx.opportunity.findUniqueOrThrow({
      where: { id: row.id },
      include: SKILL_INCLUDE,
    });
  });
}

export type CreateOpportunityServiceResult =
  | { ok: true; created: Awaited<ReturnType<typeof createOpportunityTransaction>>; actorRole: string }
  // 404 existence-hiding deny (no membership, not ACTIVE, or no write role)
  | { ok: false; stage: "membership" }
  // 400 payload rule violations (message = the stable violation code)
  | { ok: false; stage: "skill-payload"; code: string }
  // 400 unknown skill reference (taxonomy reused, never extended)
  | { ok: false; stage: "skill-resolve"; code: string }
  // 400 unknown profession reference
  | { ok: false; stage: "profession" };

/**
 * Create exactly ONE private Opportunity DRAFT for `organizationId` on behalf
 * of `actorUserId`. Re-verifies the authorization on every call — the
 * organizationId must come from the authenticated context (route param or
 * workspace hint), NEVER from client/model-supplied ids alone.
 */
export async function createOpportunityRecord(
  actorUserId: string,
  organizationId: string,
  input: CreateOpportunityInput
): Promise<CreateOpportunityServiceResult> {
  // Pre-write payload rules (zero database writes on violation).
  const skillViolation = input.skills ? validateOpportunitySkillPayload(input.skills) : null;
  if (skillViolation) return { ok: false, stage: "skill-payload", code: skillViolation };

  // Authorization: identity is the authenticated actor; the membership lookup
  // is bound to (organizationId, userId); non-ACTIVE or read-only roles never
  // pass (VIEWER / HIRING_MANAGER stay read-only — approved decisions).
  const membership = await requireOrgRole(organizationId, actorUserId, OX_OPPORTUNITY_WRITE_ROLES);
  if (!membership) return { ok: false, stage: "membership" };

  const resolved = await resolveOpportunitySkillIds(input.skills ?? []);
  if (!resolved.ok) return { ok: false, stage: "skill-resolve", code: resolved.error };

  if (input.professionId !== undefined) {
    const professionExists = await db.profession.findUnique({ where: { id: input.professionId }, select: { id: true } });
    if (!professionExists) return { ok: false, stage: "profession" };
  }

  const created = await createOpportunityTransaction(actorUserId, organizationId, input, resolved.resolved);

  // The ONE OX audit writer — same action, target and meta shape as the
  // route has always recorded (append-only, never throws).
  await auditOX(actorUserId, OX_AUDIT_ACTIONS.opportunityCreated, OX_TARGET.opportunity, created.id, {
    organizationId,
    status: "DRAFT",
    actorRole: membership.role,
    skillCount: created.skills.length,
  });

  return { ok: true, created, actorRole: membership.role };
}
