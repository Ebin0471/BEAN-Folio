import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ok, err, ERR, parseBody, getClientKey, rateLimit, handler } from "@/lib/api-helpers";
import { getSessionUser, verifyPassword } from "@/lib/auth";
import { generateRecoveryKey } from "@/lib/recovery";

/**
 * Recovery-key management for the SIGNED-IN account owner.
 *
 * GET  → status only: { hasRecoveryKey, setAt }. No key material — the
 *        plaintext key was shown exactly once and only its hash is stored.
 * POST → setup (no key yet) or rotation (key exists). Both REQUIRE the
 *        current password (reauthentication). The new key is returned in
 *        plaintext exactly once; the previous key is invalidated forever.
 *        No key material is ever logged or audit- events carry no secrets.
 */
export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { recoveryKeyHash: true, recoveryKeySetAt: true },
  });
  if (!row) return ERR.server();
  return ok({ hasRecoveryKey: Boolean(row.recoveryKeyHash), setAt: row.recoveryKeySetAt?.toISOString() ?? null });
});

export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit("recovery-key:" + user.id, 10, 60 * 60_000)) return ERR.rateLimited();

  const r = await parseBody(req, z.object({ currentPassword: z.string().min(1).max(200) }));
  if (r.response !== undefined) return r.response;

  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true, recoveryKeyHash: true },
  });
  if (!row) return ERR.server();

  // Reauthentication: the caller must prove password possession. A wrong
  // password gets a plain 401 (the actor is already authenticated, so there
  // is nothing to enumerate).
  const valid = await verifyPassword(r.data.currentPassword, row.passwordHash);
  if (!valid) return err("That password is incorrect.", 401);

  const hadKey = Boolean(row.recoveryKeyHash);
  const { key, hash } = generateRecoveryKey();
  await db.user.update({
    where: { id: user.id },
    data: { recoveryKeyHash: hash, recoveryKeySetAt: new Date() },
  });

  await db.auditEvent
    .create({
      data: {
        actorUserId: user.id,
        action: hadKey ? "recovery-key.rotate" : "recovery-key.setup",
        targetType: "USER",
        targetId: user.id,
      },
    })
    .catch(() => undefined);

  // Plaintext key shown exactly once — never persisted server-side.
  return ok({ recoveryKey: key, rotated: hadKey });
});
