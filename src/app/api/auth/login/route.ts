import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { verifyPassword, createSession, setSessionCookie, getUserWithTaxonomy, buildPublicMe } from "@/lib/auth";
import { consumePendingLink } from "@/lib/auth/google-oauth";
import { ok, err, ERR, parseBody, getClientKey, rateLimitShared, handler } from "@/lib/api-helpers";

export const POST = handler(async (req: NextRequest) => {
  const limited = await rateLimitShared("login:" + getClientKey(req), 10, 60_000);
  if (limited) return limited;

  const r = await parseBody(
    req,
    z.object({
      email: z.string().email(),
      password: z.string().min(1).max(200),
    })
  );
  if (r.response !== undefined) return r.response;

  const email = r.data.email.trim().toLowerCase();

  const user = await db.user.findUnique({ where: { email } });
  if (!user || user.deletedAt) return err("Invalid email or password", 401);

  const valid = await verifyPassword(r.data.password, user.passwordHash);
  if (!valid) return err("Invalid email or password", 401);

  // Google account linking (docs/google-auth.md §linking): a Google identity
  // that was ALREADY fully verified server-side (signature/issuer/audience/
  // expiry/nonce/email_verified) and whose email matches this account, left a
  // short-lived single-use grant. Proving password ownership once here links
  // the identity. Never silently on the OAuth callback, never overwriting an
  // existing link, never touching the password itself.
  const pendingLink = await consumePendingLink();
  if (pendingLink && !user.googleId && pendingLink.email === user.email) {
    await db.user
      .update({ where: { id: user.id }, data: { googleId: pendingLink.googleId } })
      .catch(() => undefined);
    await db.auditEvent
      .create({
        data: {
          actorUserId: user.id,
          action: "auth.google.linked",
          targetType: "USER",
          targetId: user.id,
          meta: JSON.stringify({ provider: "google", via: "password-login" }),
        },
      })
      .catch(() => undefined);
  }

  await db.auditEvent
    .create({ data: { actorUserId: user.id, action: "auth.login", targetType: "USER", targetId: user.id } })
    .catch(() => undefined);

  // The profile read happens BEFORE any session is created: a failing read
  // must leave NO session row behind (no "failed login that is signed in")
  // and must be reported honestly as a server error, never as bad credentials.
  const full = await getUserWithTaxonomy(user.id);
  if (!full) return ERR.server();

  const token = await createSession(user.id);
  await setSessionCookie(token, req);
  return ok({ user: buildPublicMe(full) });
});
