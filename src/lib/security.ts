import { createHash } from "node:crypto";

/**
 * Shared security helpers (Phase 6 hardening).
 *
 * Currently hosts the recovery limiter pieces that had to move OUT of
 * /api/auth/recover/request so they can be unit-tested without HTTP
 * (tests/security-hardening.test.ts) — api-helpers.ts is intentionally not
 * extended here (different owner this cycle).
 */

// ---------- Recovery limiter (poisoning-resistant per-email bucket) ----------

/**
 * Abuse model (see docs/SECURITY_NOTES.md §Recovery):
 *
 * The OLD limiter keyed a 5/h bucket on the client-supplied plaintext email
 * and charged EVERY request — so anyone who knew a victim's email could burn
 * the bucket and lock the victim out of recovery for an hour ("limiter
 * poisoning").
 *
 * The fix has two halves:
 *  1. Bucket keys are SHA-256 hex digests of the normalized address — the
 *     in-memory bucket table never contains a plaintext email (memory-dump /
 *     bucket enumeration hardening).
 *  2. The bucket counts FAILED verifications ONLY. A request that verifies
 *     correctly never touches the bucket — it cannot be pre-blocked, no
 *     matter how much attacker noise preceded it. The holder of the correct
 *     key is therefore always able to recover; brute force is still bounded
 *     (each wrong guess consumes one of 5 failure slots per hour) and the
 *     per-IP bucket in the route still caps request throughput per client.
 */

export const RECOVERY_FAILURE_LIMIT = 5;
export const RECOVERY_FAILURE_WINDOW_MS = 60 * 60_000; // 1 hour

/** SHA-256 hex of the normalized (trimmed, lowercased) email. Deterministic, non-reversible, never contains the plaintext. */
export function hashedEmailBucketKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

const failureBuckets = new Map<string, { count: number; resetAt: number }>();

function pruneBuckets(now: number) {
  for (const [k, v] of failureBuckets) if (v.resetAt < now) failureBuckets.delete(k);
}

/**
 * True when another FAILED verification may still be counted for this key.
 * Pure check — charges nothing. Called only AFTER a verification has failed.
 */
export function recoveryFailureSlotAvailable(
  key: string,
  limit: number = RECOVERY_FAILURE_LIMIT,
  windowMs: number = RECOVERY_FAILURE_WINDOW_MS
): boolean {
  const now = Date.now();
  const bucket = failureBuckets.get(key);
  if (!bucket || bucket.resetAt < now) return true;
  return bucket.count < limit;
}

/** Charge one failed verification against the key's hourly window. */
export function recoveryRecordFailure(
  key: string,
  limit: number = RECOVERY_FAILURE_LIMIT,
  windowMs: number = RECOVERY_FAILURE_WINDOW_MS
): void {
  const now = Date.now();
  const bucket = failureBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    if (failureBuckets.size > 5000) pruneBuckets(now);
    failureBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
}
