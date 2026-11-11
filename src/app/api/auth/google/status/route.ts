import type { NextRequest } from "next/server";
import { handler, ok } from "@/lib/api-helpers";
import { googleConfigMissing, googleOAuthConfigured, resolveRedirectUri } from "@/lib/auth/google-oauth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/google/status — whether this deployment has Google OAuth
 * credentials configured, plus the EXACT redirect_uri the server sends to
 * Google (the value that must be registered in Google Cloud Console) and the
 * NAMES of any missing variables (never their values). No secrets are
 * returned; the UI keeps "Continue with Google" disabled with an honest
 * message while `enabled` is false.
 */
export const GET = handler(async (req: NextRequest) => {
  return ok({
    enabled: googleOAuthConfigured(),
    redirectUri: resolveRedirectUri(req),
    missing: googleConfigMissing(),
  });
});
