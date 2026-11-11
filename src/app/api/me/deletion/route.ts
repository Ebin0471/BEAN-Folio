import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser, revokeAllUserSessions, verifyPassword } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody, rateLimit } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const deletionSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  /** Re-authentication: the account's CURRENT password (generic 403 on mismatch). */
  currentPassword: z.string().min(1).max(200),
});

/**
 * POST /api/me/deletion — record a deletion request and immediately soft-delete
 * the account: anonymize identity, clear profile content, revoke every session.
 * The client signs the user out afterwards.
 *
 * Destructive-action hardening (Phase 6): requires the current password
 * (verified with the same scrypt helper as login), is rate-limited to 5
 * attempts/hour per account, and the confirmed deletion is written to the
 * append-only AuditEvent trail ("account.deleted", the pre-existing action
 * name for this flow).
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  // 5 attempts / hour per account — bounds online password guessing on this
  // destructive endpoint without interfering with a legit single confirmation.
  if (!rateLimit(`me-deletion:${user.id}`, 5, 3_600_000)) return ERR.rateLimited();

  const r = await parseBody(req, deletionSchema);
  if (r.response) return r.response;

  // Password re-authentication — the session alone must not be enough to
  // destroy an account (stolen-cookie / unattended-session mitigation).
  // The message is deliberately generic: no hint whether the account even
  // has a password, no user enumeration, no internal detail.
  const passwordOk = user.passwordHash
    ? await verifyPassword(r.data.currentPassword, user.passwordHash)
    : false;
  if (!passwordOk) return err("Invalid password", 403);

  const request = await db.deletionRequest.create({
    data: { userId: user.id, reason: r.data.reason ?? null },
  });

  await db.user.update({
    where: { id: user.id },
    data: {
      deletedAt: new Date(),
      email: `deleted+${user.id}@deleted.beanfolio`,
      name: "Deleted user",
      username: null,
      headline: null,
      bio: null,
      avatarMediaId: null,
      coverMediaId: null,
    },
  });

  await db.deletionRequest.update({
    where: { id: request.id },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  await revokeAllUserSessions(user.id);

  await db.auditEvent.create({
    data: {
      actorUserId: user.id,
      action: "account.deleted",
      targetType: "User",
      targetId: user.id,
    },
  });

  return ok({ ok: true });
});
