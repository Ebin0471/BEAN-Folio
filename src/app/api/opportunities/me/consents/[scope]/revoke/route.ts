import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { serializeConsent } from "@/lib/ox/dto";
import { OX_CONSENT_SCOPES, type OXConsentScope } from "@/lib/ox/validation";
import { revokeConsent } from "@/lib/ox/consent";

export const dynamic = "force-dynamic";

/**
 * POST /api/opportunities/me/consents/[scope]/revoke — revoke ONE consent
 * purpose (O2_EXECUTION_PLAN §4; O0 §6.4). Atomic: the consent row flips to
 * REVOKED (+revokedAt) and a DISCOVERY revocation additionally forces the
 * profile to HIDDEN in the SAME transaction; audit events are written
 * inside that transaction and the `ox.visibility` cache event is invalidated
 * after commit (all inside revokeConsent). History is preserved — the
 * lifecycle row is updated in place, never deleted.
 *
 * `scope` is the only client-controlled part and is validated against the
 * vocabulary. Revoking when nothing revocable is a truthful 409 whose code
 * states WHY (NO_ROW | REVOKED | EXPIRED) — success is never fabricated.
 */

type RouteParams = { params: Promise<{ scope: string }> };

export const POST = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();

  const limited = await rateLimitShared(`ox:consent-revoke:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  const { scope } = await params;
  if (!(OX_CONSENT_SCOPES as readonly string[]).includes(scope)) {
    return err("Unknown consent purpose", 400, "INVALID_SCOPE");
  }

  const result = await revokeConsent({
    userId: user.id,
    scope: scope as OXConsentScope,
    actorUserId: user.id,
  });

  if (!result.revoked) {
    return err("No current consent to revoke for this purpose", 409, result.reason);
  }
  if (!result.row) return ERR.server(); // unreachable: revoked ⇒ row exists

  return ok({ revoked: true, hidProfile: result.hidProfile, consent: serializeConsent(result.row) });
});
