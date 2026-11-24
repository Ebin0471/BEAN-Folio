import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  confirmEmailVerification,
  inspectEmailVerification,
  buildVerificationRedirectPath,
} from "@/lib/email-verification";
import { ok, err, parseBody, getClientKey, rateLimitShared, handler } from "@/lib/api-helpers";

/**
 * POST /api/auth/verify-email/confirm — consume a single-use verification
 * token ({ token } in JSON). Works without a session: the token itself is
 * the proof of mailbox control. Tokens are hashed at rest, expire after 24h
 * and are consumed ATOMICALLY together with the `emailVerifiedAt` update
 * (M31.10) — replay returns the same generic failure.
 *
 * M31.10 — GET with ?token= is COMPLETELY NON-MUTATING. Automated link
 * scanners and prefetchers (Outlook SafeLinks, Slack/Teams unfurlers,
 * antivirus link checkers) must never be able to consume a single-use token
 * ahead of the real user. GET performs a read-only state inspection and
 * redirects into the `#/verify-email` app page carrying the token; ONLY the
 * explicit user confirmation on that page — a POST from this route —
 * consumes the token and verifies the address.
 */
function appRedirect(req: NextRequest, search: URLSearchParams): NextResponse {
  // M31.10: the redirect target is generated from the trusted configured
  // application origin (resolveShareOrigin). Without a configured origin the
  // target falls back to the REQUEST'S OWN origin — a same-host URL (Next.js
  // requires absolute redirect targets); no foreign or client-suggested host
  // is ever constructed.
  const url = buildVerificationRedirectPath(search, req.nextUrl.origin);
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store" } });
}

export const GET = handler(async (req: NextRequest) => {
  const limited = await rateLimitShared("verify-email-confirm:" + getClientKey(req), 10, 60_000);
  if (limited) return limited;

  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!token) return appRedirect(req, new URLSearchParams({ veStatus: "invalid" }));

  // READ-ONLY — no consumption, no writes. The token is carried into the app
  // page; the page's explicit confirm button POSTs it for the real verdict.
  const state = await inspectEmailVerification(token);
  const search =
    state === "ready"
      ? new URLSearchParams({ token })
      : new URLSearchParams({ veStatus: state === "not-found" ? "invalid" : state });
  return appRedirect(req, search);
});

export const POST = handler(async (req: NextRequest) => {
  const limited = await rateLimitShared("verify-email-confirm:" + getClientKey(req), 10, 60_000);
  if (limited) return limited;

  const r = await parseBody(req, z.object({ token: z.string().min(16).max(256) }));
  if (r.response !== undefined) return r.response;

  const result = await confirmEmailVerification(r.data.token);
  if (!result.confirmed) {
    // Generic failure for not-found / expired / consumed / replayed tokens —
    // the precise reason stays server-side (audit/tests) to avoid an oracle.
    return err("This verification link is invalid or has expired", 400);
  }
  return ok({ verified: true });
});
