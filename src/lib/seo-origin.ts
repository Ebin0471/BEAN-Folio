import type { NextRequest } from "next/server";
import { isInternalHostname, resolveShareOrigin } from "./site-url";

/**
 * Server-side origin resolution for crawler/metadata surfaces
 * (robots.txt, sitemap.xml, the root layout's metadataBase).
 *
 * Preference order mirrors lib/site-url resolveShareOrigin():
 *   1. NEXT_PUBLIC_APP_URL — validated (parses, HTTPS, public host)
 *   2. VERCEL_URL — validated HTTPS deployment host
 *   3. the current request headers — final fallback so metadata always
 *      resolves, even in environments with no configured origin (sandbox,
 *      preview, local dev).
 *
 * resolveShareOrigin() itself deliberately FAILS CLOSED (no request-header
 * fallback) for user-facing share links: the host the app happens to render
 * on is never presented to users as a permanent URL. Crawler-facing files
 * have no interactive fallback, so the request-header fallback exists only
 * here, AFTER the verified-config attempts — never duplicated anywhere else.
 */

/** Origin derived from a request's forwarded host/proto headers. */
function requestOrigin(proto: string | null, host: string | null | undefined): string {
  return `${proto ?? "http"}://${host ?? "localhost:3000"}`;
}

/**
 * Origin for server-emitted crawler files (robots.txt Sitemap line,
 * sitemap.xml <loc>). Configured production origin when verified, otherwise
 * the host actually serving the request (a crawler must never get a broken
 * file, and these paths always exist on whatever host serves them).
 */
export function resolveCrawlerOrigin(req: NextRequest): string {
  const configured = resolveShareOrigin();
  if (configured.ok) return configured.origin;
  return requestOrigin(
    req.headers.get("x-forwarded-proto"),
    req.headers.get("x-forwarded-host") ?? req.headers.get("host")
  );
}

/**
 * NEXT_PUBLIC_APP_URL when it is a valid HTTPS public origin (same validation
 * rules as resolveShareOrigin: parses, HTTPS, non-internal hostname), else
 * null. Used for the root layout's metadataBase; callers fall back to their
 * request-header derivation when this returns null.
 */
export function configuredHttpsOrigin(): string | null {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) return null;
  try {
    // Scheme-less values are treated as HTTPS, matching lib/site-url.
    const parsed = new URL(/^https?:\/\//i.test(appUrl) ? appUrl : `https://${appUrl}`);
    if (parsed.protocol !== "https:" || isInternalHostname(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
