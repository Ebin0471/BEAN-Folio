import { NextResponse, type NextRequest } from "next/server";
import { handler, getClientKey, rateLimitShared } from "@/lib/api-helpers";
import {
  authPageRedirect,
  buildGoogleAuthUrl,
  createFlow,
  googleClientId,
  googleOAuthConfigured,
  resolveRedirectUri,
} from "@/lib/auth/google-oauth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/google — start the Google OAuth (Authorization Code + PKCE,
 * OIDC) flow. The state/nonce/PKCE-verifier are generated and stored
 * SERVER-SIDE (OAuthFlow table, single-use, 10-minute TTL); only `state` and
 * the S256 challenge travel through the browser. Redirects (303) to Google's
 * authorization endpoint; every failure lands back on the auth screen with a
 * `googleError` search param — never a JSON error page.
 */
export const GET = handler(async (req: NextRequest) => {
  const limitedAuth = await rateLimitShared("gauth:" + getClientKey(req), 20, 60_000);
  if (limitedAuth) {
    return authPageRedirect(req, { googleError: "provider" });
  }

  if (!googleOAuthConfigured()) {
    // Honest, not silent: this deployment has no Google credentials.
    return authPageRedirect(req, { googleError: "disabled" });
  }

  const clientId = googleClientId();
  if (!clientId) return authPageRedirect(req, { googleError: "disabled" });

  const flow = await createFlow();
  const redirectUri = resolveRedirectUri(req);

  const authorizeUrl = buildGoogleAuthUrl({
    redirectUri,
    clientId,
    state: flow.state,
    nonce: flow.nonce,
    codeChallenge: flow.codeChallenge,
  });

  return NextResponse.redirect(authorizeUrl, 303);
});
