/**
 * BEAN Folio — multi-tenant hostname resolution (pure, shared).
 *
 * The tenant address model is `username.beanfolio.app` (the platform root
 * domain, configured via `BEANFOLIO_ROOT_DOMAIN`) with `username.localhost`
 * as the documented LOCAL-DEVELOPMENT shape. This module is the SINGLE
 * authority for deciding whether a request Host belongs to a tenant:
 *
 * - It is pure (no db, no request object) so the edge proxy, the server
 *   boundary and the client router can share EXACTLY the same rules.
 * - It fails CLOSED: anything nested, malformed, reserved, punycode-encoded
 *   or outside the configured root is a platform host (or invalid) — never a
 *   tenant. Authorization NEVER derives from a hostname alone: every serving
 *   decision re-resolves the actual username against the database at the
 *   server boundary (the client-side use is navigation only).
 * - The client NEVER receives tenant identity from this module as a trust
 *   decision — API endpoints authenticate/authorize independently.
 *
 * Local development: when `BEANFOLIO_ROOT_DOMAIN` is unset outside
 * production, the root is `localhost` (single-label hosts like `localhost`
 * itself and `127.0.0.1` stay platform). In production the root MUST be
 * configured explicitly; without it, tenancy is disabled and every tenant
 * URL helper reports "not configured" instead of fabricating an origin.
 */

/**
 * The username grammar, defined HERE (not imported from api-helpers) because
 * this module must stay Edge-runtime-safe — api-helpers transitively imports
 * the Prisma client via the rate-limit backend, which must never enter the
 * proxy bundle. `tests/tenant-host-routing.test.ts` PINS the two definitions
 * to identical behavior so no second username grammar can drift into
 * existence (spec §9: "Do not create a second username registry").
 */
export const TENANT_USERNAME_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;

/**
 * Spec §9 register — system/platform names that must never resolve as a
 * tenant subdomain (and never be claimable as a NEW username, so wildcard
 * routing can never be hijacked later). Categories: infra (www, api, mail,
 * smtp, cdn, assets, static, media, files, ns1/ns2, mx), platform identity
 * (app, auth, admin, dashboard, console, developer), docs/comms (docs, blog,
 * support, help, status, security, billing), environments (dev, staging,
 * preview, test, demo), reserved/meta (root, system), plus every platform
 * UI route root (so `explore.beanfolio.app` can never shadow the SPA) and
 * the existing email/provider integration names.
 */
export const RESERVED_TENANT_SUBDOMAINS: ReadonlySet<string> = new Set([
  // — spec §9 minimum system names —
  "www",
  "app",
  "api",
  "admin",
  "auth",
  "mail",
  "smtp",
  "cdn",
  "assets",
  "static",
  "media",
  "files",
  "support",
  "help",
  "status",
  "docs",
  "blog",
  "security",
  "billing",
  "dashboard",
  "console",
  "developer",
  "dev",
  "staging",
  "preview",
  "test",
  "demo",
  "root",
  "system",
  // — platform UI route roots (never shadow the SPA's own segments) —
  "u",
  "p",
  "site",
  "post",
  "explore",
  "embed",
  "privacy",
  "terms",
  "onboarding",
  "folio",
  "studio",
  "search",
  "hashtags",
  "moderation",
  "settings",
  "collections",
  "insights",
  "intelligence",
  "connect",
  "messages",
  "giftz",
  "laxii",
  "opportunities",
  "verify-email",
  "robots",
  "sitemap",
  "favicon",
  // — email / DNS infrastructure names (wildcard future-proofing) —
  "ns1",
  "ns2",
  "mx",
  "imap",
  "pop",
  "webmail",
  "autoconfig",
  "autodiscover",
  "mx1",
  "newsletter",
  "email",
]);

export function isReservedTenantLabel(label: string): boolean {
  return RESERVED_TENANT_SUBDOMAINS.has(label);
}

/**
 * Normalize a Host header value: trim, lowercase, strip an optional port,
 * reject IPv6-literal and punycode (IDNA) forms (spec §9: "Normalize IDNA
 * input consistently OR REJECT unsupported forms" — BEAN rejects, so a
 * host can never bypass the reserved register through an encoded alias).
 * Returns null for anything malformed/ambiguous.
 */
export function normalizeTenantHost(rawHost: string | null | undefined): string | null {
  if (!rawHost) return null;
  let host = rawHost.trim().toLowerCase();
  if (host.length === 0 || host.length > 253) return null;
  // IPv6 literal ([::1]:3000) — never a tenant shape.
  if (host.startsWith("[")) return null;
  // Strip ONE trailing port (the whole :port suffix — IPv6 already rejected).
  const colon = host.lastIndexOf(":");
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    host = host.slice(0, colon);
  }
  if (host.length === 0 || host.includes(":")) return null;
  // Punycode/IDNA — rejected consistently (never resolved through aliases).
  if (host.includes("xn--")) return null;
  // Hostnames are dot-separated labels of [a-z0-9-]; no empty labels, no
  // leading/trailing dot, no underscores (invalid in DNS host context).
  const labels = host.split(".");
  if (labels.length < 1 || labels.some((l) => l.length === 0)) return null;
  if (!labels.every((l) => /^[a-z0-9-]+$/.test(l))) return null;
  if (labels.some((l) => l.startsWith("-") || l.endsWith("-"))) return null;
  return host;
}

export type TenantResolution =
  | { kind: "tenant"; username: string }
  | { kind: "platform"; reason: "root-host" | "reserved" | "no-root" | "shape" | "loopback" }
  | { kind: "invalid"; reason: "malformed" | "punycode" };

/** The configured tenant root domain, or the local-dev default. */
export function tenantRootDomain(): { root: string; source: "configured" | "local-dev" } | null {
  const configured = process.env.BEANFOLIO_ROOT_DOMAIN?.trim().toLowerCase();
  if (configured) {
    // A configured root must itself be a clean DNS name (no scheme, no port).
    const normalized = normalizeTenantHost(configured);
    return normalized && normalized === configured ? { root: normalized, source: "configured" } : null;
  }
  // Local development default: `username.localhost` is the documented dev
  // tenant shape. Production never falls back — without an explicit root the
  // platform stays single-origin (canonicalUrl stays null + explained).
  if (process.env.NODE_ENV !== "production") return { root: "localhost", source: "local-dev" };
  return null;
}

/**
 * Resolve a normalized request host against the tenant root.
 * - `<label>.<root>` with a USERNAME-shaped, non-reserved single label → tenant.
 * - The root itself, `www.<root>`, reserved labels, deeper nesting, foreign
 *   hosts and loopback-only forms → platform (fail closed).
 */
export function resolveTenantHost(rawHost: string | null | undefined): TenantResolution {
  // Punycode/IDNA is detected on the raw value first (spec §9: reject
  // unsupported IDNA forms) so the reason is precise rather than a generic
  // normalization failure.
  const lowered = typeof rawHost === "string" ? rawHost.trim().toLowerCase() : "";
  if (lowered.includes("xn--")) return { kind: "invalid", reason: "punycode" };
  const host = normalizeTenantHost(rawHost);
  if (!host) return { kind: "invalid", reason: "malformed" };

  const rootInfo = tenantRootDomain();
  if (!rootInfo) return { kind: "platform", reason: "no-root" };
  const { root } = rootInfo;

  if (host === root || host === `www.${root}`) return { kind: "platform", reason: "root-host" };
  // Loopback/single-label hosts (localhost itself, 127.0.0.1 style) are the
  // platform in local dev — a tenant needs the <label>.<root> shape.
  if (!host.endsWith(`.${root}`)) return { kind: "platform", reason: "shape" };
  if (host === root) return { kind: "platform", reason: "root-host" };

  const label = host.slice(0, host.length - root.length - 1);
  // Exactly ONE label under the root — no nested subdomains (spec §9).
  if (label.includes(".")) return { kind: "platform", reason: "shape" };
  if (isReservedTenantLabel(label)) return { kind: "platform", reason: "reserved" };
  // The label must satisfy the username grammar (same register, no second
  // username namespace — spec §9 "Do not create a second username registry";
  // the grammar constant is pinned to the canonical USERNAME_RE by test).
  if (!TENANT_USERNAME_RE.test(label)) return { kind: "platform", reason: "shape" };
  return { kind: "tenant", username: label };
}

/**
 * Can this username be CLAIMED as a new account username? Reserved tenant
 * labels are blocked for NEW claims only — existing users keep their
 * usernames (no reclassification, no backfill).
 */
export function isUsernameReservedForClaim(username: string): boolean {
  const normalized = username.trim().toLowerCase();
  return isReservedTenantLabel(normalized);
}
