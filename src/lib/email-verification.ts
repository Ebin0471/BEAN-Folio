import { createHash, randomBytes } from "crypto";
import { db } from "@/lib/db";
import { auditEmailDelivery, resolveEmailAdapter } from "@/lib/email/delivery";

/**
 * BEAN Folio — email verification lifecycle (M31).
 *
 * Contract:
 * - Tokens are 32-byte CSPRNG hex secrets; ONLY their SHA-256 is stored
 *   (same pattern as PasswordResetToken). The plaintext exists exactly once —
 *   in the delivery payload — and is never logged.
 * - Tokens expire (default 24h), are single-use (atomic conditional consume)
 *   and safely invalidated after use.
 * - Issue/resend is rate-limited at the service layer (per-user cooldown +
 *   daily cap) AND at the route layer (per-client IP). Unknown emails are
 *   indistinguishable from known ones at the route boundary (no account
 *   enumeration).
 * - Delivery goes through the configurable adapter. With no provider
 *   configured (`EMAIL_DELIVERY_ADAPTER=none`, the default) the platform
 *   NEVER pretends an email was sent — the response carries
 *   `delivery: { sent: false, reason }` and the UI explains the dev-only
 *   verification path.
 * - Development test path: `EMAIL_DEV_TEST_MODE=1` AND non-production
 *   returns the token in the API response so QA can complete verification
 *   without a provider. Startup validation refuses this mode in production.
 */

export const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const EMAIL_RESEND_COOLDOWN_MS = 60 * 1000; // 60s between sends
export const EMAIL_RESEND_DAILY_CAP = 5; // per user per UTC day

export function hashEmailToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Dev-only token visibility — refuses outside non-production runtime. */
export function devTestModeEnabled(): boolean {
  return (
    process.env.EMAIL_DEV_TEST_MODE === "1" &&
    process.env.NODE_ENV !== "production"
  );
}

export type IssueEmailVerificationResult =
  | {
      issued: true;
      token: string;
      expiresAt: Date;
      delivery: { sent: boolean; adapter: string; reason?: string };
      /** Only set when EMAIL_DEV_TEST_MODE=1 outside production. */
      devToken?: string;
    }
  | { issued: false; reason: "cooldown" | "daily-cap" | "already-verified" };

/**
 * Create + deliver a fresh verification token for a user (resend path and
 * registration path share this). Older unconsumed tokens for the user stay
 * valid until their own expiry — consuming any one verifies the address —
 * but each send rewrites the cooldown window.
 */
export async function issueEmailVerification(user: {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: Date | null;
}): Promise<IssueEmailVerificationResult> {
  if (user.emailVerifiedAt) return { issued: false, reason: "already-verified" };

  const now = new Date();
  const last = await db.emailVerificationToken.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (last && now.getTime() - last.createdAt.getTime() < EMAIL_RESEND_COOLDOWN_MS) {
    return { issued: false, reason: "cooldown" };
  }
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const sentToday = await db.emailVerificationToken.count({
    where: { userId: user.id, createdAt: { gte: dayStart } },
  });
  if (sentToday >= EMAIL_RESEND_DAILY_CAP) {
    return { issued: false, reason: "daily-cap" };
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + EMAIL_TOKEN_TTL_MS);
  await db.emailVerificationToken.create({
    data: { userId: user.id, tokenHash: hashEmailToken(token), expiresAt },
  });

  const adapter = resolveEmailAdapter();
  const delivery = await adapter.send({
    to: user.email,
    subject: "Verify your BEAN Folio email",
    bodyText: `Hello ${user.name},\n\nConfirm your email address to finish setting up your BEAN Folio account:\n\n/api/auth/verify-email/confirm?token=${token}\n\nThis link expires in 24 hours and can be used once.\n\nIf you did not create an account, you can ignore this message.`,
    meta: { userId: user.id },
  });
  await auditEmailDelivery(user.id, "auth.email.verification.issued", {
    adapter: delivery.adapter,
    delivered: "delivered" in delivery ? delivery.delivered : false,
    reason: "reason" in delivery ? delivery.reason : undefined,
  });

  return {
    issued: true,
    token,
    expiresAt,
    delivery: {
      sent: "delivered" in delivery ? delivery.delivered : false,
      adapter: delivery.adapter,
      reason: "reason" in delivery ? delivery.reason : undefined,
    },
    ...(devTestModeEnabled() ? { devToken: token } : {}),
  };
}

export type ConfirmEmailVerificationResult =
  | { confirmed: true; userId: string }
  | { confirmed: false; reason: "not-found" | "expired" | "consumed" };

/**
 * Consume a verification token (single-use, race-safe) and mark the user's
 * email verified. Invalid/expired/consumed tokens are indistinguishable in
 * the error detail returned to the client — the granular reason is for
 * server-side tests and audit only.
 */
export async function confirmEmailVerification(
  rawToken: string
): Promise<ConfirmEmailVerificationResult> {
  const tokenHash = hashEmailToken(rawToken);
  const row = await db.emailVerificationToken.findUnique({ where: { tokenHash } });
  if (!row) return { confirmed: false, reason: "not-found" };
  if (row.consumedAt) return { confirmed: false, reason: "consumed" };
  if (row.expiresAt.getTime() <= Date.now()) return { confirmed: false, reason: "expired" };

  // Race-safe single-use consume: only the FIRST concurrent claim wins.
  const claimed = await db.emailVerificationToken.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (claimed.count !== 1) return { confirmed: false, reason: "consumed" };

  const user = await db.user.update({
    where: { id: row.userId },
    data: { emailVerifiedAt: new Date() },
    select: { id: true, email: true },
  });

  await db.auditEvent
    .create({
      data: {
        actorUserId: user.id,
        action: "auth.email.verified",
        targetType: "USER",
        targetId: user.id,
      },
    })
    .catch(() => undefined);

  return { confirmed: true, userId: user.id };
}

/** Expired, unconsumed tokens are garbage — safe retention sweep. */
export async function sweepExpiredEmailTokens(): Promise<number> {
  const removed = await db.emailVerificationToken.deleteMany({
    where: { expiresAt: { lt: new Date() }, consumedAt: { not: null } },
  });
  return removed.count;
}
