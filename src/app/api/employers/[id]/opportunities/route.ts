import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole } from "@/lib/ox/authz";
import {
  createOpportunitySchema,
  OX_OPPORTUNITY_STATUSES,
  OX_ORG_ROLES,
  type CreateOpportunityInput,
} from "@/lib/ox/validation";
import { createOpportunityRecord } from "@/lib/ox/opportunity-create";
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

  // M36.2: the guarded creation core (payload rules → ACTIVE OWNER/ADMIN/
  // RECRUITER membership → taxonomy-only skill resolution → profession
  // existence → transactional DRAFT create + audit) now lives in ONE shared
  // service reused by the RIISHE ox.opportunity.draft tool — same rules, same
  // audit, same status codes. The HTTP contract below is byte-equivalent.
  const result = await createOpportunityRecord(user.id, id, input);
  if (!result.ok) {
    if (result.stage === "membership") return ERR.notFound();
    if (result.stage === "skill-resolve") {
      return err("Unknown skill reference — the existing skill taxonomy is reused, never extended", 400, result.code);
    }
    if (result.stage === "profession") {
      return err("Unknown profession reference", 400, "OPPORTUNITY_PROFESSION_NOT_FOUND");
    }
    return err(result.code, 400, result.code);
  }

  return ok({ opportunity: serializeOpportunity(result.created, result.created.skills) }, 201);
});
