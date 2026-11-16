import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole } from "@/lib/ox/authz";
import { inviteMemberSchema } from "@/lib/ox/validation";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { serializeMember } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * GET  /api/employers/[id]/members — list the organization's members.
 * POST /api/employers/[id]/members — invite a member by username.
 *
 * GET authorization: ACTIVE OWNER/ADMIN manage the team table (O0 §5 matrix).
 * Every other caller gets 404 (tenant isolation). The response exposes only
 * the member display triple (id/name/username/avatar) plus membership state —
 * never contact fields (O0 §6.6 serializer allowlist).
 *
 * POST authorization: ACTIVE OWNER/ADMIN. Rules (O1 §3):
 *   - the target must be an existing, non-deleted, non-demo BEAN Folio account
 *     (identified by its public username);
 *   - a (org, user) pair can only ever have ONE membership row (DB unique
 *     constraint): inviting an ACTIVE/SUSPENDED/INVITED member is a 409;
 *   - inviting a REMOVED member REACTIVATES that same row (status → INVITED),
 *     it never creates a second row;
 *   - ownership is never granted through an invite (assignable roles only) —
 *     ownership moves exclusively through the audited transfer flow;
 *   - every invite writes an audit event.
 */

type RouteParams = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;

  const membership = await requireOrgRole(id, user.id, ["OWNER", "ADMIN"]);
  if (!membership) return ERR.notFound();

  const members = await db.employerMembership.findMany({
    where: { organizationId: id, status: { not: "REMOVED" } },
    include: { user: { select: { id: true, name: true, username: true, avatarMediaId: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
  });

  return ok({
    members: members.map((m) => serializeMember(m, m.user)),
  });
});

export const POST = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { id } = await params;

  const limited = await rateLimitShared(`ox:member-invite:${id}`, 30, 3600_000);
  if (limited) return limited;

  const r = await parseBody(req, inviteMemberSchema);
  if (r.response !== undefined) return r.response;

  const membership = await requireOrgRole(id, user.id, ["OWNER", "ADMIN"]);
  if (!membership) return ERR.notFound();

  const target = await db.user.findUnique({ where: { username: r.data.username } });
  if (!target || target.deletedAt || target.isDemo) {
    // 404-deny: do not reveal whether the username exists.
    return ERR.notFound();
  }

  const existing = await db.employerMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: target.id } },
  });

  if (existing && existing.status !== "REMOVED") {
    return err("This person is already a member of this organization", 409);
  }

  const row = existing
    ? await db.employerMembership.update({
        where: { id: existing.id },
        data: { role: r.data.role, status: "INVITED", invitedByUserId: user.id, joinedAt: null },
        include: { user: { select: { id: true, name: true, username: true, avatarMediaId: true } } },
      })
    : await db.employerMembership.create({
        data: {
          organizationId: id,
          userId: target.id,
          role: r.data.role,
          status: "INVITED",
          invitedByUserId: user.id,
        },
        include: { user: { select: { id: true, name: true, username: true, avatarMediaId: true } } },
      });

  await auditOX(user.id, OX_AUDIT_ACTIONS.memberInvited, OX_TARGET.membership, row.id, {
    organizationId: id,
    targetUserId: target.id,
    targetUsername: target.username,
    role: r.data.role,
    reactivated: Boolean(existing),
    actorRole: membership.role,
  });

  return ok({ membership: serializeMember(row, row.user) }, 201);
});
