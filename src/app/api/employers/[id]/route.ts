import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole, getOrg } from "@/lib/ox/authz";
import { updateOrgSchema } from "@/lib/ox/validation";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { serializeOrg } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/employers/[id] — update an organization profile.
 *
 * Authorization: ACTIVE OWNER or ADMIN of THAT organization (O0 §5 matrix,
 * "Organization settings / members"). Every other caller — anonymous,
 * non-member, INVITED, VIEWER — gets the same 404: the org's existence is
 * never advertised to non-managers (tenant isolation, 404-deny).
 *
 * The client-supplied id is treated as an untrusted lookup key, never as an
 * authorization claim; the slug is immutable (it is the org's address —
 * renames would break external references; O0 §4).
 */

type RouteParams = { params: Promise<{ id: string }> };

export const PATCH = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();

  const { id } = await params;

  const limited = await rateLimitShared(`ox:org-update:${user.id}`, 30, 60_000);
  if (limited) return limited;

  const r = await parseBody(req, updateOrgSchema);
  if (r.response !== undefined) return r.response;
  const input = r.data;

  const membership = await requireOrgRole(id, user.id, ["OWNER", "ADMIN"]);
  if (!membership) return ERR.notFound();
  const org = await getOrg(id);
  if (!org) return ERR.notFound();

  const updated = await db.employerOrganization.update({
    where: { id: org.id },
    data: {
      ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.website !== undefined ? { website: input.website || null } : {}),
      ...(input.industry !== undefined ? { industry: input.industry || null } : {}),
      ...(input.companySize !== undefined ? { companySize: input.companySize } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.headquarters !== undefined ? { headquarters: input.headquarters || null } : {}),
    },
  });

  await auditOX(user.id, OX_AUDIT_ACTIONS.orgUpdated, OX_TARGET.organization, org.id, {
    fields: Object.keys(input),
    actorRole: membership.role,
  });

  return ok({ organization: serializeOrg(updated) });
});
