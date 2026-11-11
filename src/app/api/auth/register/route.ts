import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword, createSession, setSessionCookie, buildPublicMe } from "@/lib/auth";
import { generateRecoveryKey } from "@/lib/recovery";
import { ok, err, ERR, parseBody, getClientKey, rateLimitShared, handler } from "@/lib/api-helpers";

export const POST = handler(async (req: NextRequest) => {
  const limited = await rateLimitShared("register:" + getClientKey(req), 10, 60_000);
  if (limited) return limited;

  const r = await parseBody(
    req,
    z.object({
      email: z.string().email(),
      password: z.string().min(8).max(200),
      // trim() runs BEFORE the checks — a whitespace-only name is empty.
      name: z.string().trim().min(1).max(80),
    })
  );
  if (r.response !== undefined) return r.response;

  const email = r.data.email.trim().toLowerCase();
  const name = r.data.name.trim();
  const passwordHash = await hashPassword(r.data.password);

  // Every new account gets a recovery key generated from the platform CSPRNG.
  // The plaintext key is returned ONCE in this response (the UI requires an
  // explicit "I saved it" acknowledgement before onboarding continues); only
  // its SHA-256 is stored. It is never logged or emailed.
  const recovery = generateRecoveryKey();

  // The account row (with its recovery-key fields set INLINE — no second
  // write), and the first session are created in ONE transaction so a
  // failure can never leave a partial account behind (e.g. an out-of-date
  // production schema rejecting the recovery-key columns AFTER the user row
  // already committed). Audit events are best-effort and non-critical, so
  // they stay outside. The cookie below is set OUTSIDE the transaction on
  // purpose: cookie writing is an external, non-transactional side effect.
  let user;
  let token;
  try {
    const created = await db.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email,
          passwordHash,
          name,
          recoveryKeyHash: recovery.hash,
          recoveryKeySetAt: new Date(),
        },
      });
      const t = await createSession(u.id, tx);
      return { u, t };
    });
    user = created.u;
    token = created.t;
  } catch (e: unknown) {
    // Prisma unique-constraint violation
    if (typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2002") {
      return err("An account with this email already exists", 409);
    }
    throw e;
  }

  await db.auditEvent
    .create({ data: { actorUserId: user.id, action: "auth.register", targetType: "USER", targetId: user.id } })
    .catch(() => undefined);

  await db.auditEvent
    .create({ data: { actorUserId: user.id, action: "recovery-key.setup", targetType: "USER", targetId: user.id } })
    .catch(() => undefined);

  await setSessionCookie(token, req);

  // The success response is built from the just-committed row — there is NO
  // post-commit profile re-read. A transient read failure after the commit
  // must never turn a created account into a misleading 500, and the one-time
  // recovery key must never be swallowed by it. A brand-new account provably
  // has empty taxonomy; /api/auth/me resolves the full profile right after.
  return ok({
    user: buildPublicMe({ ...user, professions: [], skills: [] }),
    recoveryKey: recovery.key,
  });
});
