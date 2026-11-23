import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { resolveWorkspace } from "@/lib/workspace";

/**
 * GET /api/me/workspace — the active workspace + all organization
 * memberships (for the workspace switcher UI).
 *
 * POST /api/me/workspace/switch — switch the active workspace. The
 * organizationId is untrusted client input: the server verifies the ACTIVE
 * membership BEFORE the cookie is written; the resolution path re-verifies
 * on every subsequent request.
 */

function serializeWorkspace(w: Awaited<ReturnType<typeof resolveWorkspace>>) {
  return w.type === "PERSONAL"
    ? { type: "PERSONAL" as const, organizationId: null, organization: null, membershipRole: null }
    : {
        type: "ORGANIZATION" as const,
        organizationId: w.organization.id,
        organization: w.organization,
        membershipRole: w.membershipRole,
      };
}

export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const [workspace, memberships] = await Promise.all([
    resolveWorkspace(user.id),
    db.employerMembership.findMany({
      where: { userId: user.id, status: { in: ["ACTIVE", "INVITED"] } },
      orderBy: { joinedAt: "asc" },
      select: {
        role: true,
        status: true,
        organization: { select: { id: true, displayName: true, slug: true, verificationStatus: true } },
      },
    }),
  ]);

  return ok({
    workspace: serializeWorkspace(workspace),
    memberships: memberships.map((m) => ({
      organizationId: m.organization.id,
      displayName: m.organization.displayName,
      slug: m.organization.slug,
      role: m.role,
      status: m.status,
      verificationStatus: m.organization.verificationStatus,
    })),
  });
});
