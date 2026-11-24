import { NextRequest, NextResponse } from "next/server";
import { resolveTenantHost } from "@/lib/tenant-host";

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
 * `/post/<id>` (creator social-feed post deep links, SEO-indexable when the
 * post is public) follows the identical path-form mechanism.
 *
 * The client (lib/hash-router) treats the boot route as the initial route and
 * canonicalizes legacy `/?#/u/<slug>` deep links to the path form, so both
 * address styles keep opening the same website.
 *
 * TENANT HOSTS (multi-tenant publishing, `username.beanfolio.app` target with
 * `username.localhost` as the documented local-dev shape): a request whose
 * Host resolves as a TENANT (src/lib/tenant-host.ts — single valid username
 * label under the configured root, never a reserved/platform name) serves the
 * SAME SPA document rewritten onto the EXISTING path routes — tenant root →
 * `/site/<username>`, tenant `/g/<siteId>` → `/site/<username>/g/<siteId>` —
 * with the boot route in the same `x-bean-boot-route` header (any incoming
 * client-supplied value is OVERWRITTEN first; the header is server-set only).
 * The visible browser URL is preserved (rewrite, not redirect).
 *
 * Host safety rules (enforced here and re-verified at the server boundary):
 * - Only the `Host` header is consulted — `X-Forwarded-Host` is NEVER used
 *   for tenant decisions (forged forwarded-host values cannot select a
 *   tenant; a configured trusted reverse proxy would be a separate,
 *   explicitly-enabled step).
 * - `/api/*`, `/_next/*`, static assets and every non-tenant host are never
 *   rewritten — an API request can never become a website document, and the
 *   main platform (root domain, www, reserved subdomains, arbitrary foreign
 *   hosts) behaves exactly as before this file grew host awareness.
 * - The proxy NEVER touches the database (no Prisma in the edge bundle):
 *   tenant EXISTENCE (active account, published site, privacy) is resolved
 *   by the API/data layer the boot route already flows into — an unknown or
 *   inactive username simply renders the same honest not-found experience
 *   any unknown `/site/<u>` path gets today.
 *
 * Custom domains (future capability — NOT implemented): a verified custom
 * domain would map to its owner's portfolio here (GiftzDomain registry
 * exists), after ownership verification, DNS and TLS exist. Today tenant
 * routing covers ONLY `<username>.<configured root>`; nothing in this file
 * claims public subdomains are live — `BEANFOLIO_ROOT_DOMAIN` is empty by
 * default and production stays single-origin until the owner configures it.
 */

const PUBLIC_PATH_SLUG_RE =
  /^(?:\/u\/[^/]+|\/p\/[^/]+|\/site\/[^/]+(?:\/projects\/[^/]+|\/work\/[^/]+|\/g\/[^/]+|\/[^/]+)?|\/post\/[^/]+)$/;

/**
 * Boot route for a public path-form URL. The route IS the requested pathname
 * (segments preserved exactly as requested — percent-encoded where the client
 * sent them encoded; the client decodes per segment). Covers `/u/<username>`,
 * `/p/<id>`, `/site/<username>`, the standalone website's own project detail
 * pages `/site/<username>/projects/<id>`, the GIFTZ generated sites
 * `/site/<username>/g/<siteId>`, and the M0.5-reconnected portfolio shapes
 * `/site/<username>/work/<projectId>` and `/site/<username>/<pageSlug>` —
 * all bounded single-extra-segment shapes (enumerable, never an open
 * wildcard; deeper or malformed shapes stay rejected).
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

/**
 * M1 — boot route for a TENANT-host request. Maps the tenant URL space onto
 * the existing public path routes so every downstream view, view-switch,
 * standalone-chrome rule and data endpoint behaves EXACTLY as its path-form
 * equivalent does today:
 * - `https://<u>.<root>/`          → `/site/<u>`            (the tenant's site)
 * - `https://<u>.<root>/g/<id>`    → `/site/<u>/g/<id>`    (a GIFTZ site)
 * - `https://<u>.<root>/site/...`  → passthrough (already path form)
 * Anything else on a tenant host (`/api/...`, assets, unknown paths) returns
 * null — those requests fall through untouched and behave normally (the SPA
 * document only ever renders at tenant root and `/g/<siteId>`).
 */
export function tenantBootRouteFromRequest(pathname: string, username: string): string | null {
  if (!username) return null;
  if (pathname === "/" || pathname === "") return `/site/${username}`;
  const gMatch = /^\/g\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  if (gMatch) return `/site/${username}/g/${gMatch[1]}`;
  if (pathname === `/site/${username}` || pathname.startsWith(`/site/${username}/`)) {
    return bootRouteFromPathname(pathname);
  }
  return null;
}

export function proxy(req: NextRequest): NextResponse {
  // ---- 1. existing path-form handling (platform URL space, unchanged) ----
  const bootRoute = bootRouteFromPathname(req.nextUrl.pathname);

  // ---- 2. tenant-host routing (M1) ----
  // Host-only decision (never X-Forwarded-Host). Reserved/root/malformed/
  // foreign hosts resolve as platform and skip this branch entirely.
  const tenant = resolveTenantHost(req.headers.get("host"));
  if (tenant.kind === "tenant") {
    const tenantRoute = tenantBootRouteFromRequest(req.nextUrl.pathname, tenant.username);
    if (tenantRoute) {
      const headers = new Headers(req.headers);
      // Server-set only: overwrite any client-supplied boot-route value.
      headers.set("x-bean-boot-route", tenantRoute);
      headers.set("x-bean-tenant-host", "1");
      const target = new URL(`/${req.nextUrl.search}`, req.nextUrl.origin);
      const res = NextResponse.rewrite(target, { request: { headers } });
      // Tenant documents are per-visitor (privacy ladder resolved at the
      // data layer) — never shared-cache an SPA document keyed only by path:
      // tenant hosts collapse thousands of tenants onto `/`.
      res.headers.set("Cache-Control", "private, no-store");
      res.headers.set("X-Bean-Edge-Cache", "tenant-site-shell");
      return res;
    }
    // Tenant host + path the SPA doesn't own (e.g. /favicon.ico, assets):
    // fall through untouched.
    return NextResponse.next();
  }

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
        : bootRoute.startsWith("/post/")
          ? "public-post-shell"
          : "public-project-shell"
  );
  return res;
}

export const config = {
  // Only the public route families — never /api, /_next or static assets.
  // M1: the exact root and `/g/:path*` shapes are added so TENANT-host
  // requests (tenant root + `/g/<siteId>`) enter the proxy; on the platform
  // origin those paths resolve as platform and fall through untouched, and
  // the root matcher does not affect /api or /_next (they never match).
  matcher: ["/u/:path*", "/p/:path*", "/site/:path*", "/post/:path*", "/", "/g/:path*"],
};

// (P3 edge-cache headers for /u/* and /p/* are set in proxy() above —
// next.config headers() cannot override the dynamic document's own
// Cache-Control.)
