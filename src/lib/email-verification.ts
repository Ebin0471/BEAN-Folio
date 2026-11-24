import { createHash, randomBytes } from "crypto";
import { db } from "@/lib/db";
import { auditEmailDelivery, resolveEmailAdapter } from "@/lib/email/delivery";
import { resolveShareOrigin } from "@/lib/site-url";

/**
 * BEAN Folio — email verification lifecycle (M31).
 *
 * Contract:
 * - Tokens are 32-byte CSPRNG hex secrets; ONLY their SHA-256 is stored
 *   (same pattern as PasswordResetToken). The plaintext exists exactly once —
 *   in the delivery payload — and is never logged.
 * - Tokens expire (default 24h), are single-use and safely invalidated after
 *   use. M31.10: token consumption and the `emailVerifiedAt` update happen in
 *   ONE database transaction — a failure between the two writes can never
 *   leave a consumed token with an unverified user.
 * - M31.10: the delivered verification link is an ABSOLUTE URL built ONLY
 *   from the trusted configured application origin (resolveShareOrigin —
 *   verified deployment configuration). Request headers and the window host
 *   are never consulted, so neither a mail scanner nor a forged Host header
 *   can influence where the verification link points. Without a configured
 *   origin the link degrades to a path-only fallback and the delivery audit
 *   records it honestly — the platform never fabricates an origin.
 * - M31.10: GET on the confirm route is COMPLETELY NON-MUTATING (read-only
 *   state inspection + redirect into the app). Only an explicit user
 *   confirmation through POST consumes the token — automated link scanners
 *   and prefetchers (SafeLinks, unfurlers) can no longer burn single-use
 *   tokens ahead of the real user.
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
      /** M31.10: provenance of the delivered link (never the token itself). */
      verificationLink: { absolute: boolean; originConfigured: boolean };
    }
  | { issued: false; reason: "cooldown" | "daily-cap" | "already-verified" };

/**
 * M31.10 — the verification link, generated ONLY from the trusted configured
 * application origin. The link targets the `#/verify-email` PAGE (pre-hash
 * query carries the token, same pattern as the Google OAuth error redirect):
 * the page performs the explicit POST confirmation; GETs of the page and of
 * the confirm route are non-mutating. Without a configured origin the link is
 * a path-only fallback and `originConfigured: false` is recorded — a
 * request-derived origin is never fabricated.
 */
export type VerificationLink = {
  url: string;
  absolute: boolean;
  originConfigured: boolean;
};

export function buildVerificationLink(rawToken: string): VerificationLink {
  const search = new URLSearchParams({ token: rawToken });
  const page = `/?${search.toString()}#/verify-email`;
  const share = resolveShareOrigin();
  if (share.ok) {
    return { url: `${share.origin}${page}`, absolute: true, originConfigured: true };
  }
  return { url: page, absolute: false, originConfigured: false };
}

/**
 * M31.10 — redirect target for the confirm route's GET (compat path for old
 * email links): the SAME non-mutating verify page, carrying the token so the
 * user can confirm explicitly. Never consumes anything.
 *
 * Origin policy: the trusted configured application origin wins. Without a
 * configured origin the target falls back to the REQUEST'S OWN origin (a
 * same-host URL — Next.js requires absolute redirect targets; no foreign or
 * client-suggested host is ever constructed). The delivered EMAIL link
 * (buildVerificationLink) keeps the stricter rule: trusted origin only.
 */
export function buildVerificationRedirectPath(
  search: URLSearchParams,
  fallbackOrigin?: string
): string {
  const page = `/?${search.toString()}#/verify-email`;
  const share = resolveShareOrigin();
  if (share.ok) return `${share.origin}${page}`;
  return `${(fallbackOrigin ?? "").replace(/\/$/, "")}${page}`;
}

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

  // M31.10: the link is an ABSOLUTE URL from the trusted configured origin
  // when one is configured; otherwise a path-only fallback with an honest
  // audit marker. Never a request-derived host.
  const link = buildVerificationLink(token);

  const adapter = resolveEmailAdapter();
  const delivery = await adapter.send({
    to: user.email,
    subject: "Verify your BEAN Folio email",
    bodyText: `Hello ${user.name},\n\nConfirm your email address to finish setting up your BEAN Folio account:\n\n${link.url}\n\nOpen the link and choose "Confirm email address" to verify. This link expires in 24 hours and can be used once.\n\nIf you did not create an account, you can ignore this message.`,
    meta: { userId: user.id },
  });
  await auditEmailDelivery(user.id, "auth.email.verification.issued", {
    adapter: delivery.adapter,
    delivered: "delivered" in delivery ? delivery.delivered : false,
    reason: "reason" in delivery ? delivery.reason : undefined,
    linkAbsolute: link.absolute,
    originConfigured: link.originConfigured,
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
    verificationLink: { absolute: link.absolute, originConfigured: link.originConfigured },
    ...(devTestModeEnabled() ? { devToken: token } : {}),
  };
}

export type ConfirmEmailVerificationResult =
  | { confirmed: true; userId: string }
  | { confirmed: false; reason: "not-found" | "expired" | "consumed" };

/**
 * M31.10 — READ-ONLY token state inspection for the non-mutating GET path.
 * Consumes nothing, writes nothing; the granular state lets the compat GET
 * redirect tell the user what to expect before the explicit POST confirms.
 */
export type InspectedEmailTokenState = "ready" | "not-found" | "expired" | "consumed";

export async function inspectEmailVerification(
  rawToken: string
): Promise<InspectedEmailTokenState> {
  const row = await db.emailVerificationToken.findUnique({
    where: { tokenHash: hashEmailToken(rawToken) },
    select: { consumedAt: true, expiresAt: true },
  });
  if (!row) return "not-found";
  if (row.consumedAt) return "consumed";
  if (row.expiresAt.getTime() <= Date.now()) return "expired";
  return "ready";
}

/**
 * Consume a verification token (single-use, race-safe) and mark the user's
 * email verified.
 *
 * M31.10: the consume and the `emailVerifiedAt` update run in ONE
 * transaction — they commit together or not at all. A crash, a lost claim or
 * a user-row failure can never strand a consumed token with an unverified
 * user (previously the two writes were separate, so a failure between them
 * permanently burned the token without verifying anyone).
 *
 * Invalid/expired/consumed tokens are indistinguishable in the error detail
 * returned to the client — the granular reason is for server-side tests and
 * audit only. Audit events are best-effort and run OUTSIDE the transaction:
 * they must never roll back the verified state, and a failed audit must
 * never fail a verification.
 */
export async function confirmEmailVerification(
  rawToken: string
): Promise<ConfirmEmailVerificationResult> {
  const tokenHash = hashEmailToken(rawToken);
  const result = await db.$transaction(
    async (tx): Promise<ConfirmEmailVerificationResult> => {
      const row = await tx.emailVerificationToken.findUnique({ where: { tokenHash } });
      if (!row) return { confirmed: false, reason: "not-found" };
      if (row.consumedAt) return { confirmed: false, reason: "consumed" };
      if (row.expiresAt.getTime() <= Date.now()) return { confirmed: false, reason: "expired" };

      // Race-safe single-use consume: only the FIRST concurrent claim wins.
      // Explicit bounded transaction settings (below): SQLite serializes
      // writers, and concurrent confirmations must fail fast (never hang a
      // caller) — the conditional claim (`consumedAt: null`) still decides
      // the single winner.
      const claimed = await tx.emailVerificationToken.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (claimed.count !== 1) return { confirmed: false, reason: "consumed" };

      // Same transaction: the user is marked verified together with the
      // consume. If this write fails, the whole transaction rolls back and
      // the token stays unconsumed (still usable by a retry).
      const user = await tx.user.update({
        where: { id: row.userId },
        data: { emailVerifiedAt: new Date() },
        select: { id: true, email: true },
      });

      return { confirmed: true, userId: user.id };
    },
    { maxWait: 2_000, timeout: 10_000 }
  );

  if (!result.confirmed) return result;

  await db.auditEvent
    .create({
      data: {
        actorUserId: result.userId,
        action: "auth.email.verified",
        targetType: "USER",
        targetId: result.userId,
      },
    })
    .catch(() => undefined);

  return result;
}

/** Expired, unconsumed tokens are garbage — safe retention sweep. */
export async function sweepExpiredEmailTokens(): Promise<number> {
  const removed = await db.emailVerificationToken.deleteMany({
    where: { expiresAt: { lt: new Date() }, consumedAt: { not: null } },
  });
  return removed.count;
}
