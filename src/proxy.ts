import { NextRequest, NextResponse } from "next/server";

/**
 * Public URL path handling for the hash-routed SPA (Next.js 16 `proxy`
 * convention — the renamed, non-deprecated form of middleware).
 *
 * BEAN Folio renders every page from the single `/` document (hash routes like
 * `/#/site/ada`). Creators share their published website as the fully-qualified
 * canonical URL `https://<domain>/site/<username>` (built by lib/site-url), and
 * this proxy makes that PATH form work on direct requests, browser refreshes
 * and pasted links by serving the SAME SPA document at the path — with the
 * intended route carried in the `x-bean-boot-route` request header. The same
 * applies to `/u/<username>` (the BEAN Folio public profile), `/p/<id>`
 * (project deep links) and `/site/<username>/projects/<id>` (the standalone
 * website's own project detail pages) — each path form opens exactly its own
 * experience, never another one's.
 *
 * Why a REWRITE (serve the document here) rather than the previous 308
 * redirect to `/?#/u/<slug>`: the client router's server snapshot was always
 * "/" (a URL fragment never reaches the server), so every fresh load of the
 * path form first rendered the Discover route — the BEAN Folio feed — and
 * only swapped to the creator's website after hydration. On slow connections
 * that wrong page painted for seconds, and the Discover data fetch fired on
 * every published-site visit. Serving the document AT the path with the boot
 * route in a header lets the server render the correct route's shell
 * immediately (profile skeleton, platform chrome suppressed), the client
 * hydrates straight into it, and the address bar keeps the exact URL the
 * creator shares. No redirect is involved, so no redirect caching, no extra
 * round trip, and no origin-dependent Location header can exist.
 *
 * The client (lib/hash-router) treats the boot route as the initial route and
 * canonicalizes legacy `/?#/u/<slug>` deep links to the path form, so both
 * address styles keep opening the same website.
 *
 * Custom domains (future capability — NOT implemented): a verified custom
 * domain would map to its owner's portfolio here, by rewriting the request
 * for that Host to the owner's `/u/<username>` route after ownership
 * verification, DNS and TLS exist. Today every website lives on the deployed
 * BEAN Folio domain; nothing in this file claims otherwise.
 */

const PUBLIC_PATH_SLUG_RE = /^(?:\/u\/[^/]+|\/p\/[^/]+|\/site\/[^/]+(?:\/projects\/[^/]+)?)$/;

/**
 * Boot route for a public path-form URL. The route IS the requested pathname
 * (segments preserved exactly as requested — percent-encoded where the client
 * sent them encoded; the client decodes per segment). Covers `/u/<username>`,
 * `/p/<id>`, `/site/<username>` and the standalone website's own project
 * detail pages `/site/<username>/projects/<id>`.
 */
export function bootRouteFromPathname(pathname: string): string | null {
  return PUBLIC_PATH_SLUG_RE.test(pathname) ? pathname : null;
}

/**
 * P3 — edge-cache policy for the public-shell document (see next.config for
 * the rationale). Applied HERE (not via next.config headers) because a
 * force-dynamic document sets its own `no-store` Cache-Control at render
 * time — proxy response headers are merged onto the final response AFTER the
 * route's, so this is the only layer that can downgrade it to the intended
 * CDN policy. The document is platform shell + server metadata derived from
 * the PUBLIC payload only, so shared-edge caching for a bounded window is
 * safe; the underlying DATA endpoint stays `private, no-store`.
 */
const EDGE_CACHE_HEADER = "public, max-age=0, s-maxage=30, stale-while-revalidate=120";

export function proxy(req: NextRequest): NextResponse {
  const bootRoute = bootRouteFromPathname(req.nextUrl.pathname);
  if (!bootRoute) return NextResponse.next();

  // Serve the SPA document at the requested path. The slug stays exactly as
  // requested (percent-encoded in the pathname; the client decodes it). The
  // query string is preserved on the rewritten document URL.
  const headers = new Headers(req.headers);
  headers.set("x-bean-boot-route", bootRoute);
  const target = new URL(`/${req.nextUrl.search}`, req.nextUrl.origin);
  const res = NextResponse.rewrite(target, { request: { headers } });
  res.headers.set("Cache-Control", EDGE_CACHE_HEADER);
  res.headers.set(
    "X-Bean-Edge-Cache",
    bootRoute.startsWith("/u/")
      ? "public-profile-shell"
      : bootRoute.startsWith("/site/")
        ? "public-site-shell"
        : "public-project-shell"
  );
  return res;
}

export const config = {
  // Only the public route families — never /api, /_next or static assets.
  matcher: ["/u/:path*", "/p/:path*", "/site/:path*"],
};

// (P3 edge-cache headers for /u/* and /p/* are set in proxy() above —
// next.config headers() cannot override the dynamic document's own
// Cache-Control.)
