import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { serializeCandidateProfileForOwner } from "@/lib/ox/dto";
import { changeVisibilitySchema } from "@/lib/ox/validation";
import { changeProfileVisibility } from "@/lib/ox/consent";

export const dynamic = "force-dynamic";

/**
 * POST /api/opportunities/me/visibility — change the authenticated
 * candidate's own visibility state (O2_EXECUTION_PLAN §4; O0 §6.3).
 *
 * ACTIVE requires a CURRENT DISCOVERY consent, re-checked server-side
 * inside the same transaction as the write — granting DISCOVERY alone never
 * activates anything, and a revoked/expired grant cannot activate. HIDDEN /
 * PAUSED / INVITE_ONLY need no consent. Every real transition audits
 * ox.visibility.changed and invalidates the `ox.visibility` cache event
 * after commit. Failure codes are truthful state statements (409
 * NO_PROFILE | NO_DISCOVERY_CONSENT), never fabricated success.
 */

export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();

  const limited = await rateLimitShared(`ox:visibility-change:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  const r = await parseBody(req, changeVisibilitySchema);
  if (r.response !== undefined) return r.response;

  const result = await changeProfileVisibility({
    userId: user.id,
    next: r.data.status,
    actorUserId: user.id,
  });

  if (!result.ok) {
    if (result.reason === "NO_PROFILE") {
      return err("Create your opportunity profile first", 409, "NO_PROFILE");
    }
    return err(
      "Activating discoverability requires a current DISCOVERY consent",
      409,
      "NO_DISCOVERY_CONSENT"
    );
  }

  return ok({ profile: serializeCandidateProfileForOwner(result.profile), changed: result.changed });
});
