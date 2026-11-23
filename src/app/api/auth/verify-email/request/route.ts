import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { issueEmailVerification } from "@/lib/email-verification";
import { ok, err, ERR, getClientKey, rateLimitShared, handler } from "@/lib/api-helpers";

/**
 * POST /api/auth/verify-email/request — (re)send the verification email for
 * the signed-in account. Rate-limited per client AND per-account (service
 * cooldown + daily cap). Legacy accounts (no identity) are not part of the
 * verification lifecycle and get a no-op success so the response never
 * becomes an account-probing oracle.
 */
export const POST = handler(async (req: NextRequest) => {
  const limited = await rateLimitShared("verify-email-request:" + getClientKey(req), 5, 60_000);
  if (limited) return limited;

  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (user.deletedAt) return ERR.unauthorized();

  if (!user.primaryIdentity || user.isDemo) {
    // Legacy/demo accounts were created before the verification lifecycle
    // exists; resending is a no-op with the same response shape.
    return ok({ issued: false, sent: false, reason: "not-required", alreadyVerified: !!user.emailVerifiedAt });
  }

  const issued = await issueEmailVerification({
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerifiedAt: user.emailVerifiedAt,
  });

  if (!issued.issued) {
    if (issued.reason === "already-verified") {
      return ok({ issued: false, sent: false, reason: "already-verified", alreadyVerified: true });
    }
    // cooldown / daily-cap — explicit, client-visible honest state.
    return ok({ issued: false, sent: false, reason: issued.reason, alreadyVerified: false });
  }

  return ok({
    issued: true,
    sent: issued.delivery.sent,
    ...(issued.delivery.reason ? { deliveryReason: issued.delivery.reason } : {}),
    ...(issued.devToken ? { devToken: issued.devToken } : {}),
    alreadyVerified: false,
  });
});
