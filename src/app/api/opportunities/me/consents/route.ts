import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { serializeConsent } from "@/lib/ox/dto";
import { grantConsentSchema, OX_CONSENT_SCOPES } from "@/lib/ox/validation";
import { getCurrentConsent, getConsentHistory, grantConsent } from "@/lib/ox/consent";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/opportunities/me/consents — purpose-scoped consent ledger
 * (O2_EXECUTION_PLAN §4; O0 §6.1).
 *
 * GET: the candidate's own full ledger (newest first) plus a per-scope
 * current-consent summary. Purposes are independent rows — the response
 * never aggregates them into one boolean. The summary states WHY consent is
 * absent (NO_ROW | REVOKED | EXPIRED) so the UI can be truthful.
 *
 * POST: explicit grant of ONE purpose. `consentVersion` and `source` are
 * stamped SERVER-SIDE (never read from the client — the strict schema
 * rejects any extra fields). The ledger is append-lifecycle: granting while
 * a current grant already exists returns the existing row unchanged
 * (200 + alreadyCurrent) instead of duplicating rows; a grant after
 * revocation/expiry creates a NEW row so no prior state is overwritten.
 * Granting a purpose NEVER changes profile visibility — activation is the
 * separate consent-gated POST /visibility step (O0 §6.3).
 */

export const GET = handler(async (_req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const history = await getConsentHistory(user.id);
  const current: Record<string, { hasCurrentConsent: boolean; reason: string }> = {};
  for (const scope of OX_CONSENT_SCOPES) {
    const resolution = await getCurrentConsent(user.id, scope);
    current[scope] = { hasCurrentConsent: resolution.hasCurrentConsent, reason: resolution.reason };
  }

  return ok({ current, history: history.map(serializeConsent) });
});

export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();

  const limited = await rateLimitShared(`ox:consent-grant:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  const r = await parseBody(req, grantConsentSchema);
  if (r.response !== undefined) return r.response;

  // Server-owned provenance: source and version are NEVER client input.
  const result = await grantConsent({
    userId: user.id,
    scope: r.data.scope,
    actorUserId: user.id,
  });

  return ok(
    { consent: serializeConsent(result.row), alreadyCurrent: !result.created },
    result.created ? 201 : 200
  );
});
