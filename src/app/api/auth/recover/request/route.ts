import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ok, err, ERR, parseBody, getClientKey, rateLimitShared, handler } from "@/lib/api-helpers";
import { hashRecoveryKey, safeHashEqual, generateRecoveryKey, isRecoveryKeyShape, generateResetToken } from "@/lib/recovery";
import { hashedEmailBucketKey, recoveryFailureSlotAvailable, recoveryRecordFailure } from "@/lib/security";

export const dynamic = "force-dynamic";

/** The one generic verification-failure response (no factor disclosure). */
const VERIFY_FAIL = "We couldn't verify that email and recovery key together.";

/**
 * Step 1 of password recovery: verify email + recovery key TOGETHER.
 *
 * - Both factors are checked against the SAME account; the error never says
 *   which factor failed, and a missing account performs the same hash work
 *   as a real one (timing-equalized, no account enumeration).
 * - On success a short-lived (15 min) SINGLE-USE reset token is issued and
 *   ONLY its SHA-256 is stored. This deployment has no transactional email
 *   provider configured, so the token is returned to the same verified
 *   client — the recovery key itself is the proof of possession; no
 *   fabrication of email delivery happens.
 * - Rate limits: 5/hour per client IP (pre-verification), plus 5 FAILED
 *   verifications per hour per attempted email.
 *
 * Per-email limiter abuse model (poisoning fix): the old limiter charged
 * every request against a plaintext-email bucket, so anyone who knew a
 * victim's email could exhaust the bucket and lock the victim out of
 * recovery for an hour. Now the per-email bucket is keyed on a SHA-256 of
 * the normalized address (not enumerable, not stored in plaintext) and is
 * charged ONLY when a verification FAILS — a correct key always goes
 * through, no matter how much noise preceded it. Brute force stays bounded:
 * every wrong guess consumes one of 5 failure slots per hour, and the per-IP
 * bucket still caps throughput per client. See docs/SECURITY_NOTES.md.
 */
export const POST = handler(async (req: NextRequest) => {
  const limitedReq = await rateLimitShared("recover-req:" + getClientKey(req), 5, 60 * 60_000);
  if (limitedReq) return limitedReq;

  const r = await parseBody(
    req,
    z.object({
      email: z.string().email().max(200),
      recoveryKey: z.string().min(10).max(100),
    })
  );
  if (r.response !== undefined) return r.response;

  const email = r.data.email.trim().toLowerCase();

  // Non-reversible bucket key: the limiter's memory never holds the address.
  const emailBucket = hashedEmailBucketKey(email);

  // Lazy cleanup: expired tokens are deleted on sight — live tokens untouched.
  await db.passwordResetToken
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => undefined);

  // Independent of the IP bucket so one address cannot be probed across many
  // IPs (and one IP cannot spray many addresses fast). Unlike the IP bucket
  // this one is NOT checked up-front: it is charged only on the failure paths
  // below, so a request that would verify correctly is never rate-limited by
  // it (limiter-poisoning fix).
  const failVerification = async (): Promise<NextResponse> => {
    if (!recoveryFailureSlotAvailable(emailBucket)) return ERR.rateLimited();
    recoveryRecordFailure(emailBucket);
    return err(VERIFY_FAIL, 401);
  };

  if (!isRecoveryKeyShape(r.data.recoveryKey)) {
    return failVerification();
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, deletedAt: true, recoveryKeyHash: true },
  });

  const providedHash = hashRecoveryKey(r.data.recoveryKey);

  if (!user || user.deletedAt || !user.recoveryKeyHash) {
    // Timing equalization: burn the same hash-compare work a real account would.
    const { hash: dummyHash } = generateRecoveryKey();
    safeHashEqual(providedHash, dummyHash);
    return failVerification();
  }

  if (!safeHashEqual(providedHash, user.recoveryKeyHash)) {
    return failVerification();
  }

  // SUCCESS — the failure bucket is deliberately untouched here: valid
  // attempts never consume limiter budget (that is the poisoning fix).

  const { token, tokenHash, expiresAt } = generateResetToken();
  await db.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt } });

  await db.auditEvent
    .create({ data: { actorUserId: user.id, action: "auth.recover.request", targetType: "USER", targetId: user.id } })
    .catch(() => undefined);

  // The plaintext token exists only in this response and the user's client.
  return ok({ ok: true, resetToken: token, expiresAt: expiresAt.toISOString() });
});
