import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ok, err, ERR, parseBody, getClientKey, rateLimitShared, handler } from "@/lib/api-helpers";
import { hashResetToken } from "@/lib/recovery";
import { hashPassword } from "@/lib/auth";

/**
 * Step 2 of password recovery: consume the single-use token and set a new
 * password.
 *
 * - The token is looked up by its SHA-256; it must be unconsumed and
 *   unexpired (expired rows are deleted lazily on sight).
 * - On success the token is consumed FIRST (single use, race-safe), the
 *   password is replaced, and EVERY existing session for the account is
 *   revoked — a holder of a stolen session cannot survive a recovery.
 * - The response never reveals whether a token existed for another user.
 */
export const POST = handler(async (req: NextRequest) => {
  const limitedReset = await rateLimitShared("recover-reset:" + getClientKey(req), 10, 60 * 60_000);
  if (limitedReset) return limitedReset;

  const r = await parseBody(
    req,
    z.object({
      resetToken: z.string().min(32).max(128),
      newPassword: z.string().min(8).max(200),
    })
  );
  if (r.response !== undefined) return r.response;

  // Lazy cleanup: expired tokens are deleted on sight — every reset attempt
  // sweeps the table; live (unexpired) tokens are never touched.
  await db.passwordResetToken
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => undefined);

  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(r.data.resetToken) },
    include: { user: { select: { id: true, deletedAt: true } } },
  });

  if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now() || row.user.deletedAt) {
    return err("This reset link is invalid or has expired. Start again with your recovery key.", 400);
  }

  const passwordHash = await hashPassword(r.data.newPassword);

  // Consume the token, replace the password, and revoke EVERY existing
  // session in ONE transaction — the token can never be burned without the
  // password actually changing (and vice versa). The conditional updateMany
  // keeps parallel double-submits race-safe: the losing transaction sees
  // count 0 and aborts (rolled back) before touching the user row.
  class ResetRaceLoss extends Error {}
  try {
    await db.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (consumed.count === 0) throw new ResetRaceLoss();
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: row.userId } });
    });
  } catch (e: unknown) {
    if (e instanceof ResetRaceLoss) {
      return err("This reset link was already used. Start again with your recovery key.", 400);
    }
    throw e;
  }

  await db.auditEvent
    .create({ data: { actorUserId: row.userId, action: "auth.recover.reset", targetType: "USER", targetId: row.userId } })
    .catch(() => undefined);

  return ok({ ok: true });
});
