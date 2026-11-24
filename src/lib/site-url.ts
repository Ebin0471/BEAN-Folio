/**
 * Single source of truth for the two PUBLIC addresses a creator has:
 *
 *  1. The BEAN Folio public PROFILE — `publicProfilePath()` → `/u/<username>`.
 *     The platform's profile experience (identity, skills, published projects,
 *     collections). It exists for every onboarded account and never changes
 *     with website publishing.
 *
 *  2. The standalone published WEBSITE — `publicSitePath()` → `/site/<username>`.
 *     The custom website built in the website studio renders ONLY here
 *     (PublishedSiteView); it never replaces or redirects the profile page.
 *     The two addresses are independent and never render each other's
 *     experience.
 *
 * BEAN Folio is a hash-routed SPA: the whole app lives on `/` and routes are
 * fragments. The username is the stable, unique public slug (unique in the
 * database, claimed at onboarding, never changed by saving or publishing).
 * Addresses are written once here; republishing or editing a draft never
 * moves them.
 *
 * Address forms (S = website, P = profile):
 *  - publicSitePath()      → `/site/<username>`   (NO leading "#")
 *    Router path form for the WEBSITE. Use for router navigation (navigate()
 *    adds the "#"), internal links, SEO canonical paths and API responses
 *    that describe the route (the publish/unpublish/me-site endpoints return
 *    it as publicUrl).
 *  - publicSiteProjectPath() → `/site/<username>/projects/<projectId>`
 *    Router path form for the WEBSITE'S OWN project detail pages — the
 *    website-native alternative to the platform's `/p/<projectId>`. Same
 *    usage rules as publicSitePath.
 *  - publicSiteHashUrl()   → `#/site/<username>`
 *  - publicProfilePath()   → `/u/<username>`
 *  - publicProfileHashUrl() → `#/u/<username>`
 *    Hash form. Use only for literal href attributes, "open in new tab"
 *    targets and displaying the real address to humans.
 *  - publicSiteAbsoluteUrl(username, origin)
 *                          → `https://<origin>/site/<username>`
 *    Fully-qualified canonical URL of the WEBSITE — what a creator copies
 *    and shares. The origin MUST be passed explicitly and MUST come from
 *    resolveShareOrigin() (verified deployment configuration). There is
 *    deliberately NO window/request-header fallback anywhere in this module:
 *    the host the app happens to be rendered on (a workspace preview, a
 *    sandbox gateway, an iframe, an internal service) is NEVER turned into
 *    the permanent public portfolio URL.
 *
 * Permanent public URL policy (resolveShareOrigin):
 *   1. NEXT_PUBLIC_APP_URL — the verified production origin. Validated:
 *      must parse, must be HTTPS, and its hostname must not be an internal
 *      / private / preview address (isInternalHostname).
 *   2. VERCEL_URL — the platform-provided deployment host (deployment
 *      configuration, not a request header). Same hostname validation.
 *   3. Nothing configured → NOT ok. Callers receive a machine reason plus an
 *      actionable human message ("production deployment and domain
 *      configuration are required") and MUST NOT present the current host as
 *      a permanent link.
 *
 * Direct navigation to the PATH forms (`https://domain/site/<username>` and
 * `https://domain/u/<username>`) is handled server-side by src/proxy.ts
 * (Next.js 16's proxy convention), which serves the SPA document AT the path
 * with the route seeded for the client — so both address styles open their
 * intended experience, and the path form renders it from the first paint
 * (no Discover flash, no redirect).
 *
 * Every surface that names a live website URL — publish confirmation, the
 * builder's share actions, social/SEO metadata — MUST go through these
 * helpers so all of them agree.
 */

// --------------------------------------------------------------- slug / paths

/** The standalone published WEBSITE's route: `/site/<username>`. */
export function publicSitePath(username: string | null | undefined): string | null {
  const name = username?.trim().toLowerCase();
  return name ? `/site/${encodeURIComponent(name)}` : null;
}

export function publicSiteHashUrl(username: string | null | undefined): string | null {
  const path = publicSitePath(username);
  return path ? `#${path}` : null;
}

// ------------------------------------------------- website project detail

/**
 * The standalone WEBSITE's own project detail route:
 * `/site/<username>/projects/<projectId>`.
 *
 * The identifier is the project's stable database id (the Project model has no
 * human slug — the id IS the canonical, never-changing identifier). This route
 * keeps a visitor INSIDE the creator's standalone website: same design system,
 * no platform chrome, no redirect to the platform's `/p/<projectId>` page
 * (which remains the platform's own independent project address).
 */
export function publicSiteProjectPath(
  username: string | null | undefined,
  projectId: string | null | undefined
): string | null {
  const name = username?.trim().toLowerCase();
  const id = projectId?.trim();
  return name && id ? `/site/${encodeURIComponent(name)}/projects/${encodeURIComponent(id)}` : null;
}

/** Hash form of the website project route — for literal href attributes and in-app links. */
export function publicSiteProjectHashUrl(
  username: string | null | undefined,
  projectId: string | null | undefined
): string | null {
  const path = publicSiteProjectPath(username, projectId);
  return path ? `#${path}` : null;
}

// ------------------------------------------------- GIFTZ generated sites

/**
 * The GIFTZ generated site's public route: `/site/<username>/g/<siteId>`.
 *
 * GIFTZ builds websites INDEPENDENTLY from the portfolio Customization
 * system; each generated site (GiftzSite) publishes to its own address under
 * the creator's /site namespace. The identifier is the GiftzSite's stable
 * database id. Only PUBLISHED generated sites are reachable here; the
 * portfolio website at /site/<username> is unaffected.
 */
export function publicSiteGiftzPath(
  username: string | null | undefined,
  siteId: string | null | undefined
): string | null {
  const name = username?.trim().toLowerCase();
  const id = siteId?.trim();
  return name && id ? `/site/${encodeURIComponent(name)}/g/${encodeURIComponent(id)}` : null;
}

/** Hash form of the GIFTZ generated site route — for literal href attributes. */
export function publicSiteGiftzHashUrl(
  username: string | null | undefined,
  siteId: string | null | undefined
): string | null {
  const path = publicSiteGiftzPath(username, siteId);
  return path ? `#${path}` : null;
}

/**
 * Fully-qualified canonical URL of a website project page, e.g.
 * `https://beanfolio.com/site/ada/projects/<id>`. Same explicit-origin policy
 * as publicSiteAbsoluteUrl — no window/request fallback, null for unusable
 * inputs.
 */
export function publicSiteProjectAbsoluteUrl(
  username: string | null | undefined,
  projectId: string | null | undefined,
  origin: string | null | undefined
): string | null {
  const path = publicSiteProjectPath(username, projectId);
  if (!path || !origin) return null;
  return `${stripTrailingSlash(origin)}${path}`;
}

/** The BEAN Folio public PROFILE's route: `/u/<username>`. */
export function publicProfilePath(username: string | null | undefined): string | null {
  const name = username?.trim().toLowerCase();
  return name ? `/u/${encodeURIComponent(name)}` : null;
}

export function publicProfileHashUrl(username: string | null | undefined): string | null {
  const path = publicProfilePath(username);
  return path ? `#${path}` : null;
}

/**
 * Fully-qualified canonical URL of a BEAN Folio public PROFILE, e.g.
 * `https://beanfolio.com/u/ada`. Same explicit-origin policy as
 * publicSiteAbsoluteUrl — no window/request-header fallback, null for null
 * usernames or unusable origins.
 */
export function publicProfileAbsoluteUrl(
  username: string | null | undefined,
  origin: string | null | undefined
): string | null {
  const path = publicProfilePath(username);
  if (!path || !origin) return null;
  return `${stripTrailingSlash(origin)}${path}`;
}

// ------------------------------------------------------------- link branding

/**
 * Branded DISPLAY label for a creator's public portfolio link — e.g.
 * "BEAN Folio · ebin".
 *
 * Policy: the VISIBLE TEXT of a share link never carries the hosting
 * provider's brand. The link's actual destination is always the real, working
 * URL produced by publicSiteAbsoluteUrl() from verified configuration
 * (NEXT_PUBLIC_APP_URL / VERCEL_URL) or the active workspace origin-proof —
 * the hostname is never replaced, rewritten or redirected here, and nothing
 * in this module invents a domain. Only the anchor's text/label is branded;
 * the address the visitor lands on, the address Copy Link copies and the
 * address shown in the publish dialog remain the genuine working URL.
 */
export function portfolioLinkLabel(username: string | null | undefined): string {
  const name = username?.trim().toLowerCase();
  return name ? `BEAN Folio · ${name}` : "BEAN Folio";
}

// --------------------------------------------------- internal-host detection

/** Suffixes that are always non-public infrastructure domains. */
export const INTERNAL_HOST_SUFFIXES = [
  ".local",
  ".internal",
  ".localhost",
  ".localdomain",
  ".lan",
  ".home.arpa",
];

/** Private / loopback / link-local IPv4 ranges (fail closed on malformed input). */
function isInternalIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  return false;
}

/**
 * True when a hostname can never serve as a permanent public URL:
 * loopback (localhost, 127/8, ::1, 0.0.0.0), private networks (RFC1918,
 * CGNAT, link-local, IPv6 ULA fe80::/fc00::), IPv4-mapped IPv6, single-label
 * internal service names ("ws-abc123"), infrastructure suffixes (.local,
 * .internal, …) and workspace/sandbox/preview gateways — including the
 * `ws-<id>…` session-host convention and region VPC labels such as
 * `cn-hongkong-vpc`. Public production domains (e.g. "beanfolio.com") never
 * match. Deliberately conservative: it only rejects hosts it can positively
 * identify as non-public.
 *
 * Scope note: this governs the CONFIG path (NEXT_PUBLIC_APP_URL /
 * VERCEL_URL) — a permanent production domain. The CURRENT environment's
 * edge host (e.g. an `fcapp.run` workspace trigger) is decided by the active
 * origin-proof in lib/workspace-origin instead, because such hosts can
 * legitimately carry internal-looking labels while being publicly routed.
 */
export function isInternalHostname(hostname: string): boolean {
  let host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  const bracketed = host.replace(/^\[/, "").replace(/\]$/, "");

  // IPv6 literals
  if (bracketed.includes(":")) {
    if (bracketed === "::1" || bracketed === "::") return true; // loopback / unspecified
    if (/^fe[89ab][0-9a-f]{0,2}:/i.test(bracketed)) return true; // link-local fe80::/10
    if (/^f[cd][0-9a-f]{2}:/i.test(bracketed)) return true; // unique-local fc00::/7
    const mapped = bracketed.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped) return isInternalIPv4(mapped[1]); // IPv4-mapped
    return false; // global IPv6
  }

  // IPv4 literals
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return isInternalIPv4(host);

  // Single-label host = internal service name (never a real public domain).
  if (!host.includes(".")) return true;

  if (INTERNAL_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true;

  const labels = host.split(".");
  // Workspace session hosts use the "ws-<id>" first-label convention.
  if (labels[0].startsWith("ws-")) return true;
  // Region VPC labels, e.g. "cn-hongkong-vpc", "vpc-abc", "eu-west-vpc".
  if (labels.some((l) => l === "vpc" || l.startsWith("vpc-") || l.endsWith("-vpc"))) return true;
  // Workspace / sandbox / preview / internal gateways (boundary-matched so
  // ordinary words inside a label — "previewly.com" — are not flagged).
  const markerRe = /(^|[-_.])(workspace|sandbox|preview|preview-chat|iframe|internal)([-_.]|$)/;
  if (labels.some((l) => markerRe.test(l))) return true;

  return false;
}

// ------------------------------------------------------- configured origins

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Raw env-configured origin (NEXT_PUBLIC_APP_URL, then VERCEL_URL) — unvalidated. */
export function configuredSiteOrigin(): string | null {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) {
    return stripTrailingSlash(/^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`);
  }
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) {
    return `https://${stripTrailingSlash(vercel)}`;
  }
  return null;
}

export type ShareOriginResult =
  | { ok: true; origin: string }
  | { ok: false; reason: "not-configured" | "invalid-config"; message: string };

export const NO_PRODUCTION_ORIGIN_MESSAGE =
  "No production domain is configured yet. Set NEXT_PUBLIC_APP_URL (for example https://your-domain.com) in the deployment environment and redeploy — the permanent public share link, Copy Link and Share stay unavailable until then.";

/**
 * The ONLY source of a permanent public share origin: verified deployment
 * configuration. Untrusted request headers and the current window host are
 * never consulted. Returns a machine-readable reason and an actionable human
 * message when the configuration is missing or itself points at an internal
 * / non-HTTPS address — callers must surface that honestly instead of
 * treating whatever host they happen to run on as the public URL.
 */
export function resolveShareOrigin(): ShareOriginResult {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) {
    let parsed: URL;
    try {
      parsed = new URL(/^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`);
    } catch {
      return {
        ok: false,
        reason: "invalid-config",
        message: `NEXT_PUBLIC_APP_URL is not a valid URL ("${explicit}"). Set it to the production origin, for example https://your-domain.com.`,
      };
    }
    if (parsed.protocol !== "https:") {
      return {
        ok: false,
        reason: "invalid-config",
        message: `NEXT_PUBLIC_APP_URL must use HTTPS for the permanent public portfolio URL (got "${parsed.protocol}//${parsed.host}"). Configure the production domain, for example https://your-domain.com.`,
      };
    }
    if (isInternalHostname(parsed.hostname)) {
      return {
        ok: false,
        reason: "invalid-config",
        message: `NEXT_PUBLIC_APP_URL points at an internal, private or preview address ("${parsed.hostname}"), which can never be the permanent public portfolio URL. Configure the real production domain, for example https://your-domain.com.`,
      };
    }
    return { ok: true, origin: stripTrailingSlash(parsed.origin) };
  }

  // VERCEL_URL is platform deployment configuration (never a request header).
  // Preview deployments get per-deployment URLs; production deployments get
  // the stable project domain — either way it is real public web, and it is
  // still validated.
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) {
    try {
      const parsed = new URL(`https://${stripTrailingSlash(vercel)}`);
      if (!isInternalHostname(parsed.hostname)) return { ok: true, origin: parsed.origin };
    } catch {
      /* malformed config → fall through to not-configured */
    }
  }

  return { ok: false, reason: "not-configured", message: NO_PRODUCTION_ORIGIN_MESSAGE };
}

/**
 * Origin for absolute SEO metadata (og:url, link[canonical], JSON-LD ids).
 * Same policy as resolveShareOrigin — null when no verified production
 * origin exists, so metadata consumers OMIT absolute URLs rather than emit
 * the host they happen to render on (a workspace/preview address).
 */
export function seoOrigin(): string | null {
  const r = resolveShareOrigin();
  return r.ok ? r.origin : null;
}

// --------------------------------------------------------------- absolute URLs

/**
 * Fully-qualified canonical URL of a published website, e.g.
 * `https://beanfolio.com/site/ada`. `origin` is REQUIRED and must come from
 * resolveShareOrigin() — there is deliberately no window/request fallback.
 * Returns null for null/empty usernames or an unusable origin.
 */
export function publicSiteAbsoluteUrl(
  username: string | null | undefined,
  origin: string | null | undefined
): string | null {
  const path = publicSitePath(username);
  if (!path || !origin) return null;
  // path already carries its leading "/" — never double it.
  return `${stripTrailingSlash(origin)}${path}`;
}

// ------------------------------------------------- share action invariants

export interface ShareActionUrls {
  /**
   * The URL Copy Link copies and Share shares. Null when no permanent public
   * URL exists — callers disable those actions and explain why; they must
   * never fall back to the current host.
   */
  shareUrl: string | null;
  /**
   * The URL Open Live Website opens. The canonical URL when it exists;
   * otherwise the RELATIVE hash route of the current deployment (a navigation
   * convenience, clearly labelled — never presented as a permanent link).
   */
  openUrl: string | null;
  /** True when shareUrl/openUrl are the permanent configured-production URL. */
  isPermanent: boolean;
}

/**
 * The single mapping from "canonical URL state" to the three share actions
 * (Copy Link / Share / Open Live Website). Builder, dialog and tests all use
 * this so the actions can never disagree.
 */
export function shareActionUrls(
  canonicalUrl: string | null | undefined,
  liveHash: string | null | undefined
): ShareActionUrls {
  if (canonicalUrl) {
    return { shareUrl: canonicalUrl, openUrl: canonicalUrl, isPermanent: true };
  }
  return { shareUrl: null, openUrl: liveHash ?? null, isPermanent: false };
}

// ------------------------------------------------------------- M1: tenant URLs

/**
 * M1 — tenant URL helpers (the tenant address model is
 * `username.beanfolio.app`; `username.localhost` is the documented
 * LOCAL-DEVELOPMENT shape). All construction flows through here so no
 * component ever string-concatenates a tenant URL (spec Part C §10).
 *
 * Honesty rules (spec §10):
 * - Without a configured production root (`BEANFOLIO_ROOT_DOMAIN`), tenant
 *   URLs for REAL domains are `null` + an actionable explanation — never a
 *   fabricated `https://username.beanfolio.app`.
 * - The local-dev root (`localhost`) produces LOCAL PREVIEW URLs only —
 *   callers must label them as local previews, never as public links.
 * - A request-derived host is never consulted: the root comes from
 *   configuration (or the documented local-dev default) alone.
 */
export type TenantUrlResult =
  | { ok: true; url: string; kind: "production" | "local-preview"; hostname: string }
  | { ok: false; reason: "not-configured" | "invalid-username"; message: string };

export const TENANT_ROOT_NOT_CONFIGURED_MESSAGE =
  "No public root domain is configured yet — set BEANFOLIO_ROOT_DOMAIN (for example beanfolio.app) once the domain, wildcard DNS and wildcard HTTPS exist. Tenant addresses stay a local-development capability until then.";

function tenantRootForUrls(): { root: string; kind: "production" | "local-preview" } | null {
  const configured = process.env.BEANFOLIO_ROOT_DOMAIN?.trim().toLowerCase();
  if (configured) return { root: configured, kind: "production" };
  if (process.env.NODE_ENV !== "production") return { root: "localhost", kind: "local-preview" };
  return null;
}

/** The tenant hostname for a username (`<u>.<root>`), or null when unconfigured/invalid. */
export function tenantHostname(username: string | null | undefined): string | null {
  const root = tenantRootForUrls();
  if (!root) return null;
  const name = username?.trim().toLowerCase();
  if (!name) return null;
  return `${name}.${root.root}`;
}

/** Absolute tenant-site URL: `https://<u>.<root>` (production) or `http://<u>.localhost:3000` (local preview). */
export function tenantSiteUrl(username: string | null | undefined): TenantUrlResult {
  const root = tenantRootForUrls();
  const name = username?.trim().toLowerCase();
  if (!name || !/^[a-z0-9][a-z0-9-]{2,23}$/.test(name)) {
    return { ok: false, reason: "invalid-username", message: "A claimed username is required for a tenant address." };
  }
  if (!root) return { ok: false, reason: "not-configured", message: TENANT_ROOT_NOT_CONFIGURED_MESSAGE };
  const hostname = `${name}.${root.root}`;
  return root.kind === "local-preview"
    ? { ok: true, url: `http://${hostname}:3000`, kind: "local-preview", hostname }
    : { ok: true, url: `https://${hostname}`, kind: "production", hostname };
}

/** Absolute tenant GIFTZ-site URL: `https://<u>.<root>/g/<siteId>` (or the local-preview http form). */
export function tenantGiftzUrl(
  username: string | null | undefined,
  siteId: string | null | undefined
): TenantUrlResult {
  const site = tenantSiteUrl(username);
  if (!site.ok) return site;
  if (!siteId || !/^[A-Za-z0-9_-]+$/.test(siteId)) {
    return { ok: false, reason: "invalid-username", message: "A valid GIFTZ site id is required." };
  }
  return { ok: true, url: `${site.url}/g/${siteId}`, kind: site.kind, hostname: site.hostname };
}
