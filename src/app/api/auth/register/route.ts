import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword, createSession, setSessionCookie, buildPublicMe } from "@/lib/auth";
import { generateRecoveryKey } from "@/lib/recovery";
import { IDENTITY_SCHEMA } from "@/lib/identity";
import { issueEmailVerification } from "@/lib/email-verification";
import { ok, err, parseBody, getClientKey, rateLimitShared, handler } from "@/lib/api-helpers";

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
      // M31 (additive): the identity chosen in the registration UI. Optional
      // at the API boundary for backwards compatibility — absent = a
      // legacy-style registration keeps the previous behavior exactly.
      identity: IDENTITY_SCHEMA.optional(),
    })
  );
  if (r.response !== undefined) return r.response;

  const email = r.data.email.trim().toLowerCase();
  const name = r.data.name.trim();
  const passwordHash = await hashPassword(r.data.password);
  const identity = r.data.identity ?? null;

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
  //
  // M31 (additive): identity-aware registrations start with a PRIVATE
  // profile (the user can choose public during onboarding). Registrations
  // without an identity keep the historical default unchanged.
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
          ...(identity !== null
            ? { primaryIdentity: identity, profileVisibility: "PRIVATE" }
            : {}),
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
    .create({
      data: {
        actorUserId: user.id,
        action: "auth.register",
        targetType: "USER",
        targetId: user.id,
        meta: JSON.stringify(identity ? { identity } : {}),
      },
    })
    .catch(() => undefined);

  await db.auditEvent
    .create({ data: { actorUserId: user.id, action: "recovery-key.setup", targetType: "USER", targetId: user.id } })
    .catch(() => undefined);

  // M31 (additive): kick off the email verification lifecycle for
  // identity-aware accounts. Best-effort — a delivery/adapter failure must
  // never turn a created account into a failed registration; the user can
  // resend from the app at any time.
  let emailVerification: { issued: boolean; sent: boolean; reason?: string; devToken?: string } = {
    issued: false,
    sent: false,
  };
  if (identity) {
    try {
      const issued = await issueEmailVerification({
        id: user.id,
        email,
        name,
        emailVerifiedAt: null,
      });
      if (issued.issued) {
        emailVerification = {
          issued: true,
          sent: issued.delivery.sent,
          ...(issued.delivery.reason ? { reason: issued.delivery.reason } : {}),
          ...(issued.devToken ? { devToken: issued.devToken } : {}),
        };
      } else {
        emailVerification = { issued: false, sent: false, reason: issued.reason };
      }
    } catch {
      emailVerification = { issued: false, sent: false, reason: "delivery-failed" };
    }
  }

  await setSessionCookie(token, req);

  // The success response is built from the just-committed row — there is NO
  // post-commit profile re-read. A transient read failure after the commit
  // must never turn a created account into a misleading 500, and the one-time
  // recovery key must never be swallowed by it. A brand-new account provably
  // has empty taxonomy; /api/auth/me resolves the full profile right after.
  return ok({
    user: buildPublicMe({ ...user, professions: [], skills: [] }),
    recoveryKey: recovery.key,
    // M31 additive fields (absent for legacy-style registrations):
    ...(identity ? { identity, emailVerification } : {}),
  });
});
