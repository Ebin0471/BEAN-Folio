import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { confirmEmailVerification } from "@/lib/email-verification";
import { ok, err, parseBody, getClientKey, rateLimitShared, handler } from "@/lib/api-helpers";

/**
 * POST /api/auth/verify-email/confirm — consume a single-use verification
 * token ({ token } in JSON). Works without a session: the token itself is
 * the proof of mailbox control. Tokens are hashed at rest, expire after 24h
 * and are consumed atomically (replay returns the same generic failure).
 *
 * GET with ?token= is the same operation for direct email-link clicks — it
 * verifies and redirects into the app with an explicit status marker.
 */
async function confirm(rawToken: string) {
  const result = await confirmEmailVerification(rawToken);
  return result;
}

function appRedirect(status: "ok" | "invalid" | "expired"): NextResponse {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const url = `${base}/#/verify-email?status=${status}`;
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store" } });
}

export const GET = handler(async (req: NextRequest) => {
  const limited = await rateLimitShared("verify-email-confirm:" + getClientKey(req), 10, 60_000);
  if (limited) return limited;

  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!token) return appRedirect("invalid");
  const result = await confirm(token);
  if (result.confirmed) return appRedirect("ok");
  return appRedirect(result.reason === "expired" ? "expired" : "invalid");
});

export const POST = handler(async (req: NextRequest) => {
  const limited = await rateLimitShared("verify-email-confirm:" + getClientKey(req), 10, 60_000);
  if (limited) return limited;

  const r = await parseBody(req, z.object({ token: z.string().min(16).max(256) }));
  if (r.response !== undefined) return r.response;

  const result = await confirm(r.data.token);
  if (!result.confirmed) {
    // Generic failure for not-found / expired / consumed / replayed tokens —
    // the precise reason stays server-side (audit/tests) to avoid an oracle.
    return err("This verification link is invalid or has expired", 400);
  }
  return ok({ verified: true });
});
