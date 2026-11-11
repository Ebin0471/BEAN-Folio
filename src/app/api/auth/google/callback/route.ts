import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { createSession, getSessionUser, setSessionCookie } from "@/lib/auth";
import { handler, getClientKey, rateLimitShared } from "@/lib/api-helpers";
import {
  authPageRedirect,
  consumeFlow,
  createPendingLink,
  exchangeAuthorizationCode,
  GoogleIdTokenError,
  GoogleTokenExchangeError,
  googleClientId,
  googleOAuthConfigured,
  oauthOnlyPasswordHash,
  resolveRedirectUri,
  verifyGoogleIdToken,
  type VerifiedGoogleIdentity,
} from "@/lib/auth/google-oauth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/google/callback — the OAuth redirect target registered in
 * Google Cloud Console.
 *
 * Pipeline (every step fails CLOSED to a redirect back to the auth screen —
 * identity is NEVER taken from browser-supplied data):
 *   1. OAuth-level error (user pressed cancel) → `cancelled`.
 *   2. Single-use state consumption (DB-backed; replay/expiry → `state`).
 *   3. Server-side authorization-code exchange (PKCE verifier attached).
 *   4. ID-token verification: RS256 signature (Google JWKS), issuer,
 *      audience, expiry, nonce, Google-verified email.
 *   5. Account resolution:
 *        - googleId match → login (existing session service, same cookie);
 *        - verified email matches a password-only account → short-lived
 *          single-use LINK grant; the next successful password login links
 *          the identity (never silently, never touching the password);
 *        - authenticated user with the same verified email → link immediately;
 *        - otherwise → create the account (random unusable password hash) and
 *          continue into the existing onboarding workflow.
 */

async function audit(userId: string, action: string, meta?: string): Promise<void> {
  await db.auditEvent
    .create({ data: { actorUserId: userId, action, targetType: "USER", targetId: userId, ...(meta ? { meta } : {}) } })
    .catch(() => undefined);
}

export const GET = handler(async (req: NextRequest) => {
  const limitedCb = await rateLimitShared("gauthcb:" + getClientKey(req), 30, 60_000);
  if (limitedCb) {
    return authPageRedirect(req, { googleError: "provider" });
  }

  // 1 — Google-reported errors (cancellation, consent refusal, …).
  const oauthError = req.nextUrl.searchParams.get("error");
  if (oauthError) {
    return authPageRedirect(req, {
      googleError: oauthError === "access_denied" ? "cancelled" : "provider",
    });
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return authPageRedirect(req, { googleError: "state" });

  if (!googleOAuthConfigured()) return authPageRedirect(req, { googleError: "disabled" });
  const clientId = googleClientId();
  if (!clientId) return authPageRedirect(req, { googleError: "disabled" });

  // 2 — single-use state consumption (CSRF + replay + expiry protection).
  const flow = await consumeFlow(state);
  if (!flow) return authPageRedirect(req, { googleError: "state" });

  // 3 — authorization-code exchange (server-to-server, PKCE verifier).
  let idToken: string;
  try {
    const tokens = await exchangeAuthorizationCode({
      code,
      redirectUri: resolveRedirectUri(req),
      codeVerifier: flow.codeVerifier,
    });
    idToken = tokens.idToken;
  } catch (e) {
    console.error(
      "[auth/google] code exchange failed:",
      e instanceof GoogleTokenExchangeError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : e
    );
    return authPageRedirect(req, { googleError: "provider" });
  }

  // 4 — ID-token verification (signature/issuer/audience/expiry/nonce/email).
  let identity: VerifiedGoogleIdentity;
  try {
    identity = await verifyGoogleIdToken({ idToken, clientId, nonceHash: flow.nonceHash });
  } catch (e) {
    if (e instanceof GoogleIdTokenError) {
      console.error("[auth/google] ID token rejected:", e.reason, "—", e.message);
      const mapped =
        e.reason === "provider"
          ? "provider"
          : e.reason === "unverified_email"
            ? "unverified"
            : e.reason === "expired_token"
              ? "expired"
              : "invalid";
      return authPageRedirect(req, { googleError: mapped });
    }
    console.error("[auth/google] ID token verification crashed:", e instanceof Error ? e.message : e);
    return authPageRedirect(req, { googleError: "provider" });
  }

  // 5 — account resolution.

  // 5a — returning Google user.
  const byGoogleId = await db.user.findUnique({ where: { googleId: identity.sub } });
  if (byGoogleId) {
    if (byGoogleId.deletedAt) return authPageRedirect(req, { googleError: "deleted" });
    const token = await createSession(byGoogleId.id);
    await setSessionCookie(token, req);
    await audit(byGoogleId.id, "auth.login.google", JSON.stringify({ provider: "google" }));
    return authPageRedirect(req, {}, byGoogleId.onboarded ? "/" : "/onboarding");
  }

  const byEmail = await db.user.findUnique({ where: { email: identity.email } });
  if (byEmail?.deletedAt) return authPageRedirect(req, { googleError: "deleted" });

  // 5b — brand-new Google user → create the account, continue to onboarding.
  if (!byEmail) {
    const passwordHash = await oauthOnlyPasswordHash();
    const user = await db.user.create({
      data: {
        email: identity.email,
        passwordHash,
        name: identity.name ?? identity.email.split("@")[0],
        googleId: identity.sub,
      },
    });
    const token = await createSession(user.id);
    await setSessionCookie(token, req);
    await audit(user.id, "auth.register.google", JSON.stringify({ provider: "google" }));
    return authPageRedirect(req, {}, "/onboarding");
  }

  // 5c — the email already belongs to a BEAN Folio account.
  if (byEmail.googleId && byEmail.googleId !== identity.sub) {
    // A different Google identity is already linked to this email.
    return authPageRedirect(req, { googleError: "conflict" });
  }

  const sessionUser = await getSessionUser();
  if (sessionUser) {
    // Authenticated confirmation: only the owner of this exact account may
    // link it, and only to themselves.
    if (sessionUser.id !== byEmail.id) {
      return authPageRedirect(req, { googleError: "mismatch" });
    }
    if (!byEmail.googleId) {
      await db.user.update({ where: { id: byEmail.id }, data: { googleId: identity.sub } });
      await audit(byEmail.id, "auth.google.linked", JSON.stringify({ provider: "google" }));
    }
    return authPageRedirect(req, {}, "/");
  }

  // 5d — anonymous visitor whose Google email matches a password-only
  // account: NO silent takeover. Store a single-use grant; the next
  // successful password login links the identity. The password is untouched.
  await createPendingLink(identity);
  await audit(byEmail.id, "auth.google.link.pending", JSON.stringify({ provider: "google" }));
  return authPageRedirect(req, { googleLink: "1" });
});
