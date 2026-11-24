import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, parseBody, rateLimitShared, getClientKey, handler } from "@/lib/api-helpers";
import { setWorkspaceCookie, clearWorkspaceCookie } from "@/lib/workspace";

/**
 * POST /api/me/workspace/switch
 *   { organizationId: string | null }
 *
 * organizationId = null → personal workspace (cookie cleared).
 * Otherwise: the server verifies an ACTIVE membership for the signed-in
 * user FIRST (the client-supplied id is never trusted); only then is the
 * pointer cookie written. Suspended/removed/invited-only memberships and
 * foreign organization ids fail closed (404-deny semantics consistent with
 * the OX routes — no existence disclosure).
 */
export const POST = handler(async (req: NextRequest) => {
  const limited = await rateLimitShared("workspace-switch:" + getClientKey(req), 30, 60_000);
  if (limited) return limited;

  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const r = await parseBody(req, z.object({ organizationId: z.string().min(1).max(64).nullable() }));
  if (r.response !== undefined) return r.response;

  if (r.data.organizationId === null) {
    await clearWorkspaceCookie();
    return ok({ workspace: { type: "PERSONAL", organizationId: null, organization: null, membershipRole: null } });
  }

  const membership = await db.employerMembership.findFirst({
    where: {
      organizationId: r.data.organizationId,
      userId: user.id,
      status: "ACTIVE",
    },
    include: {
      organization: { select: { id: true, displayName: true, slug: true, verificationStatus: true } },
    },
  });
  if (!membership) return ERR.notFound();

  await setWorkspaceCookie(membership.organization.id);
  await db.auditEvent
    .create({
      data: {
        actorUserId: user.id,
        action: "workspace.switched",
        targetType: "ORGANIZATION",
        targetId: membership.organization.id,
        meta: JSON.stringify({ role: membership.role }),
      },
    })
    .catch(() => undefined);

  return ok({
    workspace: {
      type: "ORGANIZATION",
      organizationId: membership.organization.id,
      organization: membership.organization,
      membershipRole: membership.role,
    },
  });
});
