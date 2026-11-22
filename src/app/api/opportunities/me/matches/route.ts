import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, rateLimitShared } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { getCurrentConsent } from "@/lib/ox/consent";
import { serializeMatchForCandidate, type StoredTalentMatchRow } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * M-O4 — candidate transparency (approved decision D12): the candidate sees
 * their OWN stored matches, each with the verified employer's PUBLIC identity
 * (displayName + slug — no private org data), the opportunity title/status
 * and the truthful current discovery state. Identity comes ONLY from the
 * session; no other candidate's data exists on this surface by construction.
 *
 * Truthful `discoveryState` per row (rule: status labels communicate the real
 * state — D7/D9):
 *   DISCOVERY_ACTIVE     — consent current AND profile ACTIVE
 *   DISCOVERY_PAUSED     — consent current, profile PAUSED
 *   DISCOVERY_HIDDEN     — consent current, profile HIDDEN
 *   DISCOVERY_INVITE_ONLY— consent current, profile INVITE_ONLY (v1: behaves
 *                          as HIDDEN for employers — D8)
 *   DISCOVERY_REVOKED    — latest DISCOVERY lifecycle REVOKED
 *   DISCOVERY_EXPIRED    — latest grant lapsed
 *   NO_DISCOVERY         — no consent record / no profile
 */

type RouteParams = { params: Promise<{ me: string }> };

export const GET = handler(async (_req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const limited = await rateLimitShared(`ox:me-matches:${user.id}`, 60, 3600_000);
  if (limited) return limited;

  const rows = await db.talentMatch.findMany({
    where: { candidateUserId: user.id },
    orderBy: [{ generatedAt: "desc" }, { opportunityId: "asc" }],
    include: {
      opportunity: {
        select: { id: true, title: true, status: true, organization: { select: { id: true, displayName: true, slug: true } } },
      },
    },
  });

  // Resolve the candidate's CURRENT truthful discovery state (one read).
  const profile = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
  const consent = await getCurrentConsent(user.id, "DISCOVERY");
  let discoveryState: Parameters<typeof serializeMatchForCandidate>[3];
  if (!consent.hasCurrentConsent) {
    discoveryState = consent.reason === "REVOKED" ? "DISCOVERY_REVOKED" : consent.reason === "EXPIRED" ? "DISCOVERY_EXPIRED" : "NO_DISCOVERY";
  } else if (!profile) {
    discoveryState = "NO_DISCOVERY";
  } else {
    switch (profile.visibilityStatus) {
      case "ACTIVE":
        discoveryState = "DISCOVERY_ACTIVE";
        break;
      case "PAUSED":
        discoveryState = "DISCOVERY_PAUSED";
        break;
      case "INVITE_ONLY":
        discoveryState = "DISCOVERY_INVITE_ONLY";
        break;
      default:
        discoveryState = "DISCOVERY_HIDDEN";
    }
  }

  const matches = (rows as (StoredTalentMatchRow & {
    opportunity: { id: string; title: string; status: string; organization: { id: string; displayName: string; slug: string } };
  })[]).map((row) =>
    serializeMatchForCandidate(
      row,
      { id: row.opportunity.id, title: row.opportunity.title, status: row.opportunity.status },
      row.opportunity.organization,
      discoveryState,
      true // the candidate always sees their own factor explanation
    )
  );

  return ok({ discoveryState, matches });
});
