import { NextRequest } from "next/server";
import { getSessionUser, verifyPassword } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole } from "@/lib/ox/authz";
import { transferOwnershipSchema } from "@/lib/ox/validation";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { serializeMember } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * POST /api/employers/[id]/transfer-ownership — controlled ownership transfer.
 *
 * O1 owner directive: "The final active owner cannot be demoted or removed
 * without a valid ownership transfer. Implement controlled ownership
 * transfer with re-authentication, authorization checks and an audit event."
 *
 * Requirements enforced here:
 *   - the caller IS the org's ACTIVE OWNER (404-deny for everyone else);
 *   - re-authentication: the caller's CURRENT PASSWORD is verified with the
 *     platform's timing-safe scrypt check on EVERY transfer;
 *   - the target is an ACTIVE, non-OWNER member of the SAME organization
 *     (the member row id must belong to [id] — client-supplied ids are
 *     untrusted lookup keys, never claims);
 *   - the swap (caller → ADMIN, target → OWNER) happens in ONE transaction;
 *     the org always has exactly one more-or-equal number of active owners
 *     after the move, so the last-owner invariant holds by construction;
 *   - an audit event `ox.ownership.transferred` records both sides.
 */

type RouteParams = { params: Promise<{ id: string }> };

const MEMBER_SELECT = { id: true, name: true, username: true, avatarMediaId: true, deletedAt: true } as const;

export const POST = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { id } = await params;

  const limited = await rateLimitShared(`ox:ownership-transfer:${user.id}`, 5, 3600_000);
  if (limited) return limited;

  const r = await parseBody(req, transferOwnershipSchema);
  if (r.response !== undefined) return r.response;

  const actorMembership = await requireOrgRole(id, user.id, ["OWNER"]);
  if (!actorMembership) return ERR.notFound();

  // Re-authentication (timing-safe scrypt verify against the stored hash).
  const passwordOk = await verifyPassword(r.data.currentPassword, user.passwordHash);
  if (!passwordOk) return err("Password confirmation failed — ownership not transferred", 403);

  const target = await db.employerMembership.findFirst({
    where: { id: r.data.toMemberId, organizationId: id, status: "ACTIVE" },
    include: { user: { select: MEMBER_SELECT } },
  });
  if (!target) return ERR.notFound();

  if (target.role === "OWNER") return err("This member already owns the organization", 400);
  if (target.userId === user.id) return err("You already own this organization", 400);
  if (target.user.deletedAt) return ERR.notFound();

  const result = await db.$transaction(async (tx) => {
    const newOwner = await tx.employerMembership.update({
      where: { id: target.id },
      data: { role: "OWNER" },
      include: { user: { select: MEMBER_SELECT } },
    });
    const previousOwner = await tx.employerMembership.update({
      where: { id: actorMembership.id },
      data: { role: "ADMIN" },
      include: { user: { select: MEMBER_SELECT } },
    });
    return { newOwner, previousOwner };
  });

  await auditOX(user.id, OX_AUDIT_ACTIONS.ownershipTransferred, OX_TARGET.organization, id, {
    fromUserId: user.id,
    toUserId: target.userId,
    fromMembershipId: actorMembership.id,
    toMembershipId: target.id,
    reAuthenticated: true,
  });

  return ok({
    membership: serializeMember(result.previousOwner, result.previousOwner.user),
    newOwner: serializeMember(result.newOwner, result.newOwner.user),
  });
});
