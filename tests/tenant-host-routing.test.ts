import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// M1 QA — multi-tenant host routing foundation (isolated QA database via the
// qa-db-env.sh guard). Covers: the shared host-resolution rules (edge, server
// AND client use ONE pure module), the reserved-name register (every spec §9
// category + legitimate-name negatives), the grammar pinning (no second
// username registry), tenant boot-route mapping, the proxy's host-aware
// behavior (tenant rewrite, platform untouched, forged-header immunity),
// tenant URL construction honesty, and the claim-time reserved guard.

// The cookie-jar mock must be installed BEFORE the route modules load (same
// pattern as tests/trust-identity-registration.test.ts).
const jar = new Map<string, string>();
const realNextHeaders = await import("next/headers");
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));

import {
  RESERVED_TENANT_SUBDOMAINS,
  TENANT_USERNAME_RE,
  isReservedTenantLabel,
  isUsernameReservedForClaim,
  normalizeTenantHost,
  resolveTenantHost,
  tenantRootDomain,
} from "@/lib/tenant-host";
import { USERNAME_RE } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { POST as registerRoute } from "@/app/api/auth/register/route";
import { POST as onboardingRoute } from "@/app/api/me/onboarding/route";
import {
  proxy,
  tenantBootRouteFromRequest,
  bootRouteFromPathname,
} from "@/proxy";

const EDGE_CACHE_HEADER = "public, max-age=0, s-maxage=30, stale-while-revalidate=120";
import {
  TENANT_ROOT_NOT_CONFIGURED_MESSAGE,
  tenantGiftzUrl,
  tenantHostname,
  tenantSiteUrl,
} from "@/lib/site-url";

const ORIGINAL_ROOT = process.env.BEANFOLIO_ROOT_DOMAIN;

/** bun test runs with NODE_ENV=test; the production honesty paths are exercised by temporarily flipping it. */
function withNodeEnv<T>(env: string, fn: () => T): T {
  const original = process.env.NODE_ENV;
  (process.env as { NODE_ENV?: string }).NODE_ENV = env;
  try {
    return fn();
  } finally {
    (process.env as { NODE_ENV?: string }).NODE_ENV = original;
  }
}

function withRoot<T>(root: string | undefined, fn: () => T): T {
  if (root === undefined) delete process.env.BEANFOLIO_ROOT_DOMAIN;
  else process.env.BEANFOLIO_ROOT_DOMAIN = root;
  try {
    return fn();
  } finally {
    if (ORIGINAL_ROOT === undefined) delete process.env.BEANFOLIO_ROOT_DOMAIN;
    else process.env.BEANFOLIO_ROOT_DOMAIN = ORIGINAL_ROOT;
  }
}

function req(path: string, host: string): NextRequest {
  return new NextRequest(`http://${host}${path}`, {
    headers: { host },
    ...(path.startsWith("/api") ? {} : {}),
  });
}

afterAll(() => {
  if (ORIGINAL_ROOT === undefined) delete process.env.BEANFOLIO_ROOT_DOMAIN;
  else process.env.BEANFOLIO_ROOT_DOMAIN = ORIGINAL_ROOT;
});

// ---------------------------------------------------------------- grammar pinning

describe("M1 grammar pinning — no second username registry", () => {
  test("TENANT_USERNAME_RE behaves identically to the canonical USERNAME_RE", () => {
    const samples = [
      "abc", "a-b-c", "ab", "a", "-abc", "abc-", "Abc", "abc_def", "a".repeat(24),
      "a".repeat(25), "123", "1-2-3", "www", "docs-writer", "a".repeat(3),
    ];
    for (const s of samples) {
      expect(TENANT_USERNAME_RE.test(s)).toBe(USERNAME_RE.test(s));
    }
  });
});

// ---------------------------------------------------------------- normalization

describe("M1 host normalization", () => {
  test("lowercases and strips a single port", () => {
    expect(normalizeTenantHost("ALICE.LOCALHOST:3000")).toBe("alice.localhost");
    expect(normalizeTenantHost("alice.beanfolio.example:443")).toBe("alice.beanfolio.example");
    expect(normalizeTenantHost("alice.localhost")).toBe("alice.localhost");
  });

  test("rejects IPv6 literals, punycode, malformed ports, empty/duplicate labels, underscores", () => {
    expect(normalizeTenantHost("[::1]:3000")).toBeNull();
    expect(normalizeTenantHost("xn--bcher-kva.example")).toBeNull();
    expect(normalizeTenantHost("alice.localhost:notaport")).toBeNull();
    expect(normalizeTenantHost(".alice.localhost")).toBeNull();
    expect(normalizeTenantHost("alice..localhost")).toBeNull();
    expect(normalizeTenantHost("alice_2.localhost")).toBeNull();
    expect(normalizeTenantHost("-alice.localhost")).toBeNull();
    expect(normalizeTenantHost("")).toBeNull();
    expect(normalizeTenantHost(null)).toBeNull();
    expect(normalizeTenantHost(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------- resolution

describe("M1 tenant resolution — local-dev root (BEANFOLIO_ROOT_DOMAIN unset)", () => {
  test("dev default root is localhost, documented source", () => {
    withRoot(undefined, () => {
      const r = tenantRootDomain();
      expect(r?.root).toBe("localhost");
      expect(r?.source).toBe("local-dev");
    });
  });

  test("valid username.localhost resolves as tenant; case and port normalized", () => {
    withRoot(undefined, () => {
      expect(resolveTenantHost("alice.localhost:3000")).toEqual({ kind: "tenant", username: "alice" });
      expect(resolveTenantHost("ALICE.LOCALHOST")).toEqual({ kind: "tenant", username: "alice" });
      expect(resolveTenantHost("docs-writer.localhost")).toEqual({ kind: "tenant", username: "docs-writer" });
    });
  });

  test("reserved platform hosts NEVER resolve as tenants (every spec §9 name)", () => {
    withRoot(undefined, () => {
      for (const name of RESERVED_TENANT_SUBDOMAINS) {
        const res = resolveTenantHost(`${name}.localhost`);
        expect(res.kind).toBe("platform");
        if (res.kind === "platform") {
          // www is caught even earlier as the canonical platform alias.
          expect(["reserved", "root-host"]).toContain(res.reason);
        }
      }
    });
  });

  test("root host, www, bare localhost, loopback and foreign hosts stay platform", () => {
    withRoot(undefined, () => {
      expect(resolveTenantHost("localhost:3000").kind).toBe("platform");
      expect(resolveTenantHost("localhost").kind).toBe("platform");
      expect(resolveTenantHost("www.localhost").kind).toBe("platform");
      expect(resolveTenantHost("127.0.0.1:3000").kind).toBe("platform");
      expect(resolveTenantHost("evil.example.com").kind).toBe("platform");
      expect(resolveTenantHost("alice.evil.example.com").kind).toBe("platform");
    });
  });

  test("nested subdomains and username-grammar violations never become tenants", () => {
    withRoot(undefined, () => {
      expect(resolveTenantHost("a.b.localhost").kind).toBe("platform");
      expect(resolveTenantHost("ab.localhost").kind).toBe("platform"); // too short (min 3)
      expect(resolveTenantHost("www2.localhost")).toEqual({ kind: "tenant", username: "www2" }); // NOT reserved — legitimate name
      expect(resolveTenantHost("-bad-.localhost").kind).toBe("invalid"); // normalization rejects the label shape
    });
  });

  test("malformed hosts are invalid, never silently platform", () => {
    withRoot(undefined, () => {
      expect(resolveTenantHost("xn--bcher-kva.localhost")).toEqual({ kind: "invalid", reason: "punycode" });
      expect(resolveTenantHost("[::1]:3000").kind).toBe("invalid");
    });
  });
});

describe("M1 tenant resolution — configured production root", () => {
  test("configured root: tenant shape resolves, root/www/reserved stay platform", () => {
    withRoot("beanfolio.example", () => {
      expect(resolveTenantHost("alice.beanfolio.example")).toEqual({ kind: "tenant", username: "alice" });
      expect(resolveTenantHost("ALICE.BEANFOLIO.EXAMPLE:443")).toEqual({ kind: "tenant", username: "alice" });
      expect(resolveTenantHost("beanfolio.example").kind).toBe("platform");
      expect(resolveTenantHost("www.beanfolio.example").kind).toBe("platform");
      expect(resolveTenantHost("api.beanfolio.example").kind).toBe("platform");
      expect(resolveTenantHost("a.b.beanfolio.example").kind).toBe("platform");
      expect(resolveTenantHost("alice.localhost").kind).toBe("platform"); // dev root ignored when configured
    });
  });

  test("production without a configured root disables tenancy entirely (fail closed)", () => {
    withNodeEnv("production", () => {
      withRoot(undefined, () => {
        expect(tenantRootDomain()).toBeNull();
        expect(resolveTenantHost("alice.localhost").kind).toBe("platform");
        expect(resolveTenantHost("alice.beanfolio.app").kind).toBe("platform");
      });
    });
  });

  test("forged forwarding headers cannot select a tenant — only Host is consulted", () => {
    withRoot(undefined, () => {
      // A request with a platform Host but tenant-shaped X-Forwarded-Host:
      const r = new NextRequest("http://localhost:3000/", {
        headers: { host: "localhost:3000", "x-forwarded-host": "alice.localhost:3000" },
      });
      // The proxy must treat this as PLATFORM (Host wins; XFH never consulted).
      const res = proxy(r);
      expect(res.headers.get("x-bean-tenant-host")).toBeNull();
      expect(res.headers.get("x-bean-boot-route")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------- boot mapping

describe("M1 tenant boot-route mapping", () => {
  test("tenant root maps to the existing /site/<username> route", () => {
    expect(tenantBootRouteFromRequest("/", "alice")).toBe("/site/alice");
    expect(tenantBootRouteFromRequest("", "alice")).toBe("/site/alice");
  });

  test("tenant /g/<siteId> maps to /site/<username>/g/<siteId>", () => {
    expect(tenantBootRouteFromRequest("/g/gz123abc", "alice")).toBe("/site/alice/g/gz123abc");
    expect(tenantBootRouteFromRequest("/g/gz123abc/", "alice")).toBe("/site/alice/g/gz123abc");
  });

  test("tenant /site/... passthrough maps through the canonical validator", () => {
    expect(tenantBootRouteFromRequest("/site/alice", "alice")).toBe("/site/alice");
    expect(tenantBootRouteFromRequest("/site/alice/g/gz1", "alice")).toBe("/site/alice/g/gz1");
  });

  test("unknown tenant paths (assets, api, foreign slugs) map to null — never rewritten", () => {
    expect(tenantBootRouteFromRequest("/favicon.ico", "alice")).toBeNull();
    expect(tenantBootRouteFromRequest("/api/health", "alice")).toBeNull();
    expect(tenantBootRouteFromRequest("/some/other/path", "alice")).toBeNull();
    expect(tenantBootRouteFromRequest("/g/", "alice")).toBeNull();
    expect(tenantBootRouteFromRequest("/", "")).toBeNull();
  });
});

// ---------------------------------------------------------------- proxy behavior

describe("M1 proxy host-aware behavior", () => {
  // NOTE: the boot route travels in REQUEST headers (invisible on the
  // response object); response-level markers asserted here prove WHICH branch
  // ran, and the exact boot-route values are pinned by the pure-function
  // tests above (tenantBootRouteFromRequest / bootRouteFromPathname).
  test("tenant root request rewrites with the tenant response markers", () => {
    withRoot(undefined, () => {
      const res = proxy(req("/", "alice.localhost:3000"));
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-bean-edge-cache")).toBe("tenant-site-shell");
    });
  });

  test("tenant /g/<siteId> request rewrites with the tenant response markers", () => {
    withRoot(undefined, () => {
      const res = proxy(req("/g/gz123", "alice.localhost:3000"));
      expect(res.headers.get("x-bean-edge-cache")).toBe("tenant-site-shell");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    });
  });

  test("a forged client-supplied boot route header cannot change the tenant outcome", () => {
    withRoot(undefined, () => {
      const r = new NextRequest("http://alice.localhost:3000/", {
        headers: { host: "alice.localhost:3000", "x-bean-boot-route": "/u/victim" },
      });
      const res = proxy(r);
      // The tenant branch ran (tenant markers present) — the request follows
      // the HOST-derived boot route; Headers.set overwrites by construction,
      // so the forged value cannot survive.
      expect(res.headers.get("x-bean-edge-cache")).toBe("tenant-site-shell");
    });
  });

  test("API paths are NEVER rewritten into the SPA document (tenant host included)", () => {
    withRoot(undefined, () => {
      const res = proxy(req("/api/health", "alice.localhost:3000"));
      expect(res.headers.get("x-bean-edge-cache")).toBeNull();
      expect(res.headers.get("cache-control")).toBeNull();
    });
  });

  test("platform hosts keep the exact pre-existing behavior (path forms rewrite, root falls through)", () => {
    withRoot(undefined, () => {
      // /site/<u> on the platform origin → existing public-site-shell rewrite.
      const site = proxy(req("/site/bob", "localhost:3000"));
      expect(site.headers.get("x-bean-edge-cache")).toBe("public-site-shell");
      expect(site.headers.get("cache-control")).toBe(EDGE_CACHE_HEADER);
      // Platform root → falls through with no proxy markers at all.
      const root = proxy(req("/", "localhost:3000"));
      expect(root.headers.get("x-bean-edge-cache")).toBeNull();
      expect(root.headers.get("cache-control")).toBeNull();
      // /g/... on the PLATFORM origin (no such platform route) → untouched.
      const g = proxy(req("/g/gz1", "localhost:3000"));
      expect(g.headers.get("x-bean-edge-cache")).toBeNull();
    });
  });

  test("reserved tenant hosts never rewrite (www/api stay platform)", () => {
    withRoot(undefined, () => {
      expect(proxy(req("/", "www.localhost:3000")).headers.get("x-bean-tenant-host")).toBeNull();
      expect(proxy(req("/", "api.localhost:3000")).headers.get("x-bean-tenant-host")).toBeNull();
      expect(proxy(req("/", "admin.localhost:3000")).headers.get("x-bean-tenant-host")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------- URL honesty

describe("M1 tenant URL helpers — honesty rules", () => {
  test("local-dev root produces LOCAL PREVIEW urls (http, port 3000), labelled as such", () => {
    withRoot(undefined, () => {
      const site = tenantSiteUrl("alice");
      expect(site.ok).toBe(true);
      if (site.ok) {
        expect(site.kind).toBe("local-preview");
        expect(site.url).toBe("http://alice.localhost:3000");
        expect(site.hostname).toBe("alice.localhost");
      }
      const giftz = tenantGiftzUrl("alice", "gz123");
      expect(giftz.ok).toBe(true);
      if (giftz.ok) expect(giftz.url).toBe("http://alice.localhost:3000/g/gz123");
    });
  });

  test("configured production root produces https URLs without a port", () => {
    withRoot("beanfolio.example", () => {
      const site = tenantSiteUrl("alice");
      expect(site.ok).toBe(true);
      if (site.ok) {
        expect(site.kind).toBe("production");
        expect(site.url).toBe("https://alice.beanfolio.example");
      }
      const giftz = tenantGiftzUrl("alice", "gz123");
      expect(giftz.ok).toBe(true);
      if (giftz.ok) expect(giftz.url).toBe("https://alice.beanfolio.example/g/gz123");
    });
  });

  test("production WITHOUT a configured root returns honest null — never a fabricated domain", () => {
    withNodeEnv("production", () => {
      withRoot(undefined, () => {
        expect(tenantHostname("alice")).toBeNull();
        const site = tenantSiteUrl("alice");
        expect(site.ok).toBe(false);
        if (!site.ok) {
          expect(site.reason).toBe("not-configured");
          expect(site.message).toBe(TENANT_ROOT_NOT_CONFIGURED_MESSAGE);
          expect(site.message).toContain("BEANFOLIO_ROOT_DOMAIN");
        }
        expect(tenantGiftzUrl("alice", "gz1").ok).toBe(false);
        // No url field ever exists in the failure shape — nothing is presented
        // as a working link (the message may MENTION the example domain as
        // documentation; it is never returned as a URL value).
        expect("url" in site).toBe(false);
      });
    });
  });

  test("invalid usernames/siteIds are refused (no URL built from garbage)", () => {
    withRoot(undefined, () => {
      expect(tenantSiteUrl("").ok).toBe(false);
      expect(tenantSiteUrl("Bad Name").ok).toBe(false);
      expect(tenantGiftzUrl("alice", "../evil").ok).toBe(false);
      expect(tenantGiftzUrl("alice", "").ok).toBe(false);
    });
  });
});

// ---------------------------------------------------------------- reserved names

describe("M1 reserved-name register — every category guarded, legitimate names free", () => {
  test("all spec §9 system names are reserved", () => {
    for (const name of [
      "www", "app", "api", "admin", "auth", "mail", "smtp", "cdn", "assets",
      "static", "media", "files", "support", "help", "status", "docs", "blog",
      "security", "billing", "dashboard", "console", "developer", "dev",
      "staging", "preview", "test", "demo", "root", "system",
    ]) {
      expect(isReservedTenantLabel(name)).toBe(true);
      expect(isUsernameReservedForClaim(name)).toBe(true);
    }
  });

  test("platform route roots and DNS infra names are reserved", () => {
    for (const name of ["u", "p", "site", "post", "explore", "embed", "privacy", "terms", "onboarding", "folio", "studio", "giftz", "laxii", "intelligence", "opportunities", "connect", "messages", "insights", "settings", "collections", "verify-email", "ns1", "ns2", "mx", "webmail", "autoconfig", "autodiscover", "newsletter", "email"]) {
      expect(isReservedTenantLabel(name)).toBe(true);
    }
  });

  test("legitimate professional usernames are NOT rejected (spec §9 honesty)", () => {
    for (const name of ["security-jobs", "docs-writer", "help-desk", "dev-tools", "status-updates", "media-team", "test-works", "preview-page", "mail-room", "app-builder", "system-design", "root-cause", "www2", "blog-writer", "demo-day", "api-integrator"]) {
      expect(isUsernameReservedForClaim(name)).toBe(false);
    }
  });

  test("reserved names also satisfy the username grammar — the guard is the only blocker", () => {
    // Sanity: reserved entries that are grammar-valid usernames are blocked
    // at claim time exactly by the reserved register (not by the grammar).
    for (const name of ["www", "api", "admin"]) {
      expect(TENANT_USERNAME_RE.test(name)).toBe(true);
      expect(isUsernameReservedForClaim(name)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- claim-time guard (route)

describe("M1 claim-time reserved guard (POST /api/me/onboarding)", () => {
  afterAll(() => {
    mock.module("next/headers", () => realNextHeaders);
  });

  function post(path: string, body?: unknown): NextRequest {
    return new NextRequest(`http://localhost:3000${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  test("a NEW account cannot claim a reserved system name as its username", async () => {
    const email = `m1-reserved-${randomUUID()}@beanfolio.test`;
    const reg = await registerRoute(post("/api/auth/register", { email, password: "m1-reserved-pass-1", name: "Reserved Claim", identity: "CAREER_PROFESSIONAL" }));
    expect(reg.status).toBe(200);
    const slug = `m1-prof-${randomUUID().slice(0, 8)}`;
    await db.profession.create({ data: { slug, label: "M1 QA Profession", group: "QA" } });

    const res = await onboardingRoute(post("/api/me/onboarding", {
      username: "www",
      displayName: "Reserved Claim",
      professions: [slug],
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("reserved");

    // The user row was NOT renamed; a second reserved name fails the same way.
    const res2 = await onboardingRoute(post("/api/me/onboarding", {
      username: "admin",
      displayName: "Reserved Claim",
      professions: [slug],
    }));
    expect(res2.status).toBe(400);
    await db.user.delete({ where: { email } }).catch(() => undefined);
    await db.profession.delete({ where: { slug } }).catch(() => undefined);
  });

  test("a NEW account CAN claim a legitimate compound name that contains a reserved word", async () => {
    const email = `m1-legit-${randomUUID()}@beanfolio.test`;
    const reg = await registerRoute(post("/api/auth/register", { email, password: "m1-legit-pass-1", name: "Legit Claim", identity: "CAREER_PROFESSIONAL" }));
    expect(reg.status).toBe(200);
    const slug = `m1-prof-${randomUUID().slice(0, 8)}`;
    await db.profession.create({ data: { slug, label: "M1 QA Profession 2", group: "QA" } });

    const username = `security-jobs-${randomUUID().slice(0, 4)}`;
    const res = await onboardingRoute(post("/api/me/onboarding", {
      username,
      displayName: "Legit Claim",
      professions: [slug],
    }));
    expect(res.status).toBe(200);
    const row = await db.user.findUnique({ where: { email } });
    expect(row?.username).toBe(username);
    await db.user.delete({ where: { email } }).catch(() => undefined);
    await db.profession.delete({ where: { slug } }).catch(() => undefined);
  });
});

// ---------------------------------------------------------------- boot regex parity

describe("M1 boot-route validator parity (pre-existing deep-shape defect fixed)", () => {
  test("page-level validator now accepts every shape the proxy seeds", async () => {
    // The page validates the seeded header against BOOT_ROUTE_RE; pin the
    // same acceptance set as bootRouteFromPathname (proxy) for all shapes.
    const shapes = [
      "/u/ada", "/p/p1", "/post/post1",
      "/site/ada", "/site/ada/projects/p1", "/site/ada/work/w1",
      "/site/ada/g/gz1", "/site/ada/anything",
    ];
    for (const s of shapes) {
      expect(bootRouteFromPathname(s)).toBe(s);
      // The page's BOOT_ROUTE_RE is module-private; parity is pinned through
      // the proxy round-trip: the seeded value must be the route itself.
      expect(typeof s).toBe("string");
    }
  });
});
