import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { OX_AUDIT_ACTIONS } from "@/lib/ox/audit";

export const dynamic = "force-dynamic";

/**
 * M-O4 — candidate discovery-access audit trail (D12; O0 §6.7): every
 * employer preview of the candidate's discoverable information is recorded
 * with org + recruiter identity and is visible HERE to the candidate.
 * Identity comes ONLY from the session; the query is bound to the
 * candidate's own profile id, so no other candidate's audit rows are
 * reachable. The discovery state clarity (active/paused/hidden/revoked/
 * expired) is served by `GET /api/opportunities/me/profile` (O2) and
 * `GET /api/opportunities/me/matches` — no duplicated policy here.
 */

export const GET = handler(async (_req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const limited = await rateLimitShared(`ox:me-audit:${user.id}`, 60, 3600_000);
  if (limited) return limited;

  const profile = await db.candidateOpportunityProfile.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });
  if (!profile) return ok({ events: [] });

  const rows = await db.auditEvent.findMany({
    where: {
      action: OX_AUDIT_ACTIONS.candidateViewed,
      targetType: "CANDIDATE_OPPORTUNITY_PROFILE",
      targetId: profile.id,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const events = rows.map((r) => {
    let meta: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(r.meta);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
    } catch {
      meta = {};
    }
    return {
      at: r.createdAt.toISOString(),
      action: r.action,
      organizationId: typeof meta.organizationId === "string" ? meta.organizationId : null,
      opportunityId: typeof meta.opportunityId === "string" ? meta.opportunityId : null,
      purpose: typeof meta.purpose === "string" ? meta.purpose : "DISCOVERY",
      viewerUserId: typeof r.actorUserId === "string" ? r.actorUserId : null,
    };
  });

  return ok({ events });
});
