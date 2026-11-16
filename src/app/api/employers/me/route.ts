import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { serializeOrg, serializeMember } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * GET /api/employers/me — the current user's employer organizations.
 *
 * Returns every membership that is not REMOVED (ACTIVE, INVITED, SUSPENDED)
 * with its organization, so the workspace can show pending invitations and
 * suspended states honestly. The caller's own role/status per org is part of
 * the payload — the UI NEVER decides authorization, it only mirrors what the
 * server already enforced (O0 §5).
 *
 * Contract: no/invalid session → 401. Success → 200 { memberships: [...] }.
 */

export const GET = handler(async (_req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const memberships = await db.employerMembership.findMany({
    where: { userId: user.id, status: { not: "REMOVED" } },
    include: {
      organization: true,
      user: { select: { id: true, name: true, username: true, avatarMediaId: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return ok({
    memberships: memberships.map((m) => ({
      ...serializeMember(m, m.user),
      organization: serializeOrg(m.organization),
    })),
  });
});
