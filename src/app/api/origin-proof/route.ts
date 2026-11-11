import { NextRequest } from "next/server";

/**
 * GET /api/origin-proof?nonce=<hex> — the origin-verification echo endpoint.
 *
 * lib/workspace-origin proves that a candidate public host is genuinely
 * routed to THIS deployment by fetching this endpoint over the candidate's
 * own public DNS name + TLS and comparing the echoed nonce to a fresh
 * server-generated one. It is public (no session) and returns nothing but
 * the caller's own nonce plus a static marker — no data, no side effects.
 *
 * Cache headers: must never be cached, or a cached echo could vouch for a
 * different nonce. Requests that reach this handler through a hostname the
 * platform edge does not route here are answered by the edge itself
 * (410) — which is exactly the discrimination the proof relies on.
 */
export const dynamic = "force-dynamic";

export function GET(req: NextRequest): Response {
  const nonce = req.nextUrl.searchParams.get("nonce") ?? "";
  return Response.json(
    { nonce, marker: "beanfolio-origin-proof" },
    { headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } }
  );
}
