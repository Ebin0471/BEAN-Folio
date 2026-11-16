import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole, countActiveOwners } from "@/lib/ox/authz";
import { updateMemberSchema } from "@/lib/ox/validation";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { serializeMember } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/employers/[id]/members/[memberId] — manage a membership.
 *
 * Two authorized paths, both tenant-bound to [id] (O1 §3):
 *
 * 1. MANAGER path — caller is an ACTIVE OWNER/ADMIN of THIS org:
 *      role changes  : any assignable role; role=OWNER is ALWAYS refused
 *                      (ownership moves only through the audited transfer
 *                      flow, never through a PATCH);
 *      status changes: INVITED→REMOVED (revoke invite), ACTIVE→SUSPENDED,
 *                      ACTIVE→REMOVED, SUSPENDED→ACTIVE, SUSPENDED→REMOVED;
 *      last-owner invariant: the final ACTIVE OWNER cannot be demoted or
 *                      removed (checked INSIDE the mutation transaction);
 *      an ADMIN cannot act on an OWNER row (OWNER-only);
 *      a REMOVED row is invisible → 404.
 *
 * 2. SELF-SERVICE path — caller acts on their OWN membership row and only
 *    while it is INVITED: status ACTIVE (accept) or REMOVED (decline).
 *    A pending member cannot change roles and cannot manage others.
 *
 * Unauthorized/foreign access → 404 (existence hiding, O0 §5). Every state
 * change writes an audit event.
 */

type RouteParams = { params: Promise<{ id: string; memberId: string }> };

const MEMBER_SELECT = { id: true, name: true, username: true, avatarMediaId: true } as const;

export const PATCH = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { id, memberId } = await params;

  const limited = await rateLimitShared(`ox:member-update:${user.id}`, 60, 60_000);
  if (limited) return limited;

  const r = await parseBody(req, updateMemberSchema);
  if (r.response !== undefined) return r.response;

  const actorMembership = await requireOrgRole(id, user.id, ["OWNER", "ADMIN"]);

  const target = await db.employerMembership.findFirst({
    where: { id: memberId, organizationId: id, status: { not: "REMOVED" } },
    include: { user: { select: MEMBER_SELECT } },
  });
  if (!target) return ERR.notFound();

  const isSelf = target.userId === user.id;

  if (!actorMembership) {
    // Not a manager. The ONLY allowed action is accepting/declining one's own
    // pending invitation.
    if (!isSelf) return ERR.notFound(); // 404-deny: foreign members don't exist here
    if (target.status !== "INVITED") return ERR.forbidden();
    if (r.data.role !== undefined) return ERR.forbidden();
    if (r.data.status !== "ACTIVE" && r.data.status !== "REMOVED") return ERR.forbidden();

    const updated = await db.employerMembership.update({
      where: { id: target.id },
      data: {
        status: r.data.status,
        ...(r.data.status === "ACTIVE" ? { joinedAt: new Date() } : {}),
      },
      include: { user: { select: MEMBER_SELECT } },
    });
    await auditOX(
      user.id,
      r.data.status === "ACTIVE" ? OX_AUDIT_ACTIONS.memberAccepted : OX_AUDIT_ACTIONS.memberDeclined,
      OX_TARGET.membership,
      target.id,
      { organizationId: id, from: target.status, to: r.data.status, selfService: true }
    );
    return ok({ membership: serializeMember(updated, updated.user) });
  }

  // ---- manager path ----
  if (target.role === "OWNER" && actorMembership.role !== "OWNER") {
    return err("Only the owner can modify another owner's membership", 403);
  }

  const lastOwnerBlock = await db.$transaction(async (tx) => {
    const wouldLoseOwner =
      (r.data.role !== undefined && target.role === "OWNER") ||
      (r.data.status !== undefined && target.role === "OWNER" && r.data.status !== "ACTIVE");
    if (!wouldLoseOwner) return false;
    const owners = await countActiveOwners(id, tx);
    return owners <= 1;
  });
  if (lastOwnerBlock) {
    return err(
      "The final active owner cannot be demoted or removed — transfer ownership first",
      409
    );
  }

  // Validate the requested transition.
  if (r.data.status !== undefined && r.data.status !== target.status) {
    const allowed: Record<string, string[]> = {
      INVITED: ["REMOVED"],
      ACTIVE: ["SUSPENDED", "REMOVED"],
      SUSPENDED: ["ACTIVE", "REMOVED"],
    };
    if (!(allowed[target.status] ?? []).includes(r.data.status)) {
      return err(`Cannot change a ${target.status.toLowerCase()} member to ${r.data.status.toLowerCase()}`, 400);
    }
  }

  const updated = await db.employerMembership.update({
    where: { id: target.id },
    data: {
      ...(r.data.role !== undefined ? { role: r.data.role } : {}),
      ...(r.data.status !== undefined ? { status: r.data.status } : {}),
    },
    include: { user: { select: MEMBER_SELECT } },
  });

  await auditOX(user.id, OX_AUDIT_ACTIONS.memberUpdated, OX_TARGET.membership, target.id, {
    organizationId: id,
    from: { role: target.role, status: target.status },
    to: { role: updated.role, status: updated.status },
    actorRole: actorMembership.role,
  });

  return ok({ membership: serializeMember(updated, updated.user) });
});
