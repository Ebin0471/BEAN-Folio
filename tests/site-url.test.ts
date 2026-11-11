/// <reference types="bun-types" />
/**
 * Canonical public-URL policy tests (see src/lib/site-url.ts).
 *
 * Proves the five required properties:
 *
 *  1. Internal workspace / sandbox / preview / private-network origins are
 *     NEVER returned as production share links (and request headers are never
 *     consulted at all).
 *  2. A valid configured production origin produces the correct canonical URL.
 *  3. Copy Link, Share and Open Live Website resolve to the SAME URL when a
 *     canonical URL exists (shareActionUrls is the single mapping).
 *  4. Missing / invalid production configuration produces an honest,
 *     actionable message — and never a fabricated link.
 *  5. The public route forms are stable, slug-preserving and SEPARATED:
 *     /u/<slug> is the BEAN Folio public PROFILE; /site/<slug> is the
 *     standalone published WEBSITE. One never renders the other.
 *
 * Run: bun test tests/site-url.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  configuredSiteOrigin,
  isInternalHostname,
  publicProfileAbsoluteUrl,
  publicProfileHashUrl,
  publicProfilePath,
  publicSiteAbsoluteUrl,
  publicSiteHashUrl,
  publicSitePath,
  resolveShareOrigin,
  shareActionUrls,
} from "../src/lib/site-url";

const ENV_KEYS = ["NEXT_PUBLIC_APP_URL", "VERCEL_URL"] as const;

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("internal-host detection (isInternalHostname)", () => {
  test("workspace session hosts (ws-*) are internal", () => {
    expect(isInternalHostname("ws-69624fe1.cn-hongkong-vpc.example.internal")).toBe(true);
    expect(isInternalHostname("ws-abc123")).toBe(true); // single-label service
    expect(isInternalHostname("ws-deadbeef.gateway")).toBe(true);
  });

  test("region-VPC / preview-chat / sandbox / workspace / iframe hosts are internal", () => {
    expect(isInternalHostname("app.cn-hongkong-vpc.example.internal")).toBe(true);
    expect(isInternalHostname("vpc-abc123.internal")).toBe(true);
    expect(isInternalHostname("eu-west-vpc.example.com")).toBe(true);
    expect(isInternalHostname("preview-chat.example.internal")).toBe(true);
    expect(isInternalHostname("preview.example.internal")).toBe(true);
    expect(isInternalHostname("sandbox-7.example.internal")).toBe(true);
    expect(isInternalHostname("workspace.example.internal")).toBe(true);
    expect(isInternalHostname("iframe.example.internal")).toBe(true);
    expect(isInternalHostname("foo.internal")).toBe(true);
    expect(isInternalHostname("box.local")).toBe(true);
    expect(isInternalHostname("myhost.lan")).toBe(true);
  });

  test("loopback, private, CGNAT and link-local networks are internal", () => {
    expect(isInternalHostname("localhost")).toBe(true);
    expect(isInternalHostname("sub.localhost")).toBe(true);
    expect(isInternalHostname("127.0.0.1")).toBe(true);
    expect(isInternalHostname("10.1.2.3")).toBe(true);
    expect(isInternalHostname("172.16.0.9")).toBe(true);
    expect(isInternalHostname("172.31.255.1")).toBe(true);
    expect(isInternalHostname("192.168.1.1")).toBe(true);
    expect(isInternalHostname("169.254.10.10")).toBe(true);
    expect(isInternalHostname("100.64.0.1")).toBe(true);
    expect(isInternalHostname("::1")).toBe(true);
    expect(isInternalHostname("::ffff:192.168.0.1")).toBe(true);
    expect(isInternalHostname("fd12:3456:789a::1")).toBe(true);
    expect(isInternalHostname("fe80::1")).toBe(true);
    expect(isInternalHostname("0.0.0.0")).toBe(true);
  });

  test("real public production domains are NOT internal", () => {
    expect(isInternalHostname("beanfolio.com")).toBe(false);
    expect(isInternalHostname("www.beanfolio.com")).toBe(false);
    expect(isInternalHostname("my-portfolio.vercel.app")).toBe(false);
    expect(isInternalHostname("previewly.com")).toBe(false); // boundary-safe matching
    expect(isInternalHostname("workspaces.app")).toBe(false);
    expect(isInternalHostname("beanfolio.co.uk")).toBe(false);
    expect(isInternalHostname("8.8.8.8")).toBe(false);
    expect(isInternalHostname("2606:4700:4700::1111")).toBe(false);
  });

  test("malformed / empty hostnames fail closed", () => {
    expect(isInternalHostname("")).toBe(true);
    expect(isInternalHostname("   ")).toBe(true);
    expect(isInternalHostname("999.999.999.999")).toBe(true);
  });
});

describe("(1) internal/preview origins are never returned as share links", () => {
  test("no configuration → canonicalUrl is null; the request/window host is never consulted", () => {
    const r = resolveShareOrigin();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("not-configured");
      // actionable: names the exact env var to set
      expect(r.message).toContain("NEXT_PUBLIC_APP_URL");
    }
    // Even if a request carried an internal workspace host header, the result
    // is identical — headers are simply not an input to this decision.
    expect(configuredSiteOrigin()).toBeNull();
    expect(publicSiteAbsoluteUrl("ada", null)).toBeNull();
    expect(publicSiteAbsoluteUrl("ada", undefined)).toBeNull();
  });

  test("a configured workspace/preview origin is rejected (invalid-config)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://ws-69624fe1.cn-hongkong-vpc.example.internal";
    const r = resolveShareOrigin();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid-config");
      expect(r.message).toContain("ws-69624fe1.cn-hongkong-vpc.example.internal");
      expect(r.message).toContain("https://your-domain.com");
    }
    // …and therefore NO share URL is ever derived from it:
    expect(publicSiteAbsoluteUrl("ada", r.ok ? r.origin : null)).toBeNull();
  });

  test("non-HTTPS configured origins are rejected", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://beanfolio.com";
    const r = resolveShareOrigin();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-config");
  });

  test("no share URL can ever be derived for an internal host", () => {
    // The absolute-URL builder only emits https + the configured origin; there
    // is no header/window code path left anywhere in the module.
    expect(publicSiteAbsoluteUrl("ada", "https://ws-abc.cn-hongkong-vpc.example.internal")).toBe(
      "https://ws-abc.cn-hongkong-vpc.example.internal/site/ada"
    ); // builder itself is policy-neutral…
    // …but resolveShareOrigin() never yields such an origin:
    process.env.NEXT_PUBLIC_APP_URL = "https://ws-abc.cn-hongkong-vpc.example.internal";
    const r = resolveShareOrigin();
    expect(r.ok).toBe(false);
    expect(publicSiteAbsoluteUrl("ada", r.ok ? r.origin : null)).toBeNull();
  });
});

describe("(2) a valid production origin generates the correct canonical URL", () => {
  test("NEXT_PUBLIC_APP_URL without scheme is normalized to HTTPS origin", () => {
    process.env.NEXT_PUBLIC_APP_URL = "beanfolio.com";
    const r = resolveShareOrigin();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.origin).toBe("https://beanfolio.com");
  });

  test("explicit HTTPS origin is kept (trailing slash stripped)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://www.beanfolio.com/";
    const r = resolveShareOrigin();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.origin).toBe("https://www.beanfolio.com");
  });

  test("canonical URL keeps the /site/<username> route form (standalone website)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://beanfolio.com";
    const r = resolveShareOrigin();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(publicSiteAbsoluteUrl("ada-lovelace", r.origin)).toBe("https://beanfolio.com/site/ada-lovelace");
    }
  });

  test("VERCEL_URL (platform deployment configuration) is accepted and validated", () => {
    process.env.VERCEL_URL = "bean-folio.vercel.app";
    const r = resolveShareOrigin();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.origin).toBe("https://bean-folio.vercel.app");
  });

  test("NEXT_PUBLIC_APP_URL takes priority over VERCEL_URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://beanfolio.com";
    process.env.VERCEL_URL = "bean-folio-abc123.vercel.app";
    const r = resolveShareOrigin();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.origin).toBe("https://beanfolio.com");
  });
});

describe("(3) Copy Link / Share / Open Live Website use the same URL", () => {
  test("with a canonical URL all three actions resolve to exactly it", () => {
    const canonical = "https://beanfolio.com/site/ada";
    const t = shareActionUrls(canonical, "#/site/ada");
    expect(t.shareUrl).toBe(canonical); // Copy Link + Share
    expect(t.openUrl).toBe(canonical); // Open Live Website
    expect(t.isPermanent).toBe(true);
    expect(t.shareUrl).toBe(t.openUrl);
  });

  test("without a canonical URL the share actions disable and open-live stays relative", () => {
    const t = shareActionUrls(null, "#/site/ada");
    expect(t.shareUrl).toBeNull(); // Copy/Share disabled — never copy an internal URL
    expect(t.openUrl).toBe("#/site/ada"); // relative hash route of the current deployment
    expect(t.isPermanent).toBe(false);
    expect(t.openUrl).not.toMatch(/^https?:\/\//); // never an absolute (internal) URL
  });
});

describe("(4) missing production configuration produces an honest, actionable error", () => {
  test("not-configured message names the env var and the consequence", () => {
    const r = resolveShareOrigin();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("NEXT_PUBLIC_APP_URL");
      expect(r.message).toMatch(/production domain|redeploy/i);
      expect(r.message.length).toBeGreaterThan(40);
    }
  });

  test("invalid-config message names the offending value and the fix", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://internal-preview:3000";
    const r = resolveShareOrigin();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("http://internal-preview:3000");
      expect(r.message).toContain("HTTPS");
    }
  });
});

describe("(5) the public route forms are stable, slug-preserving and separated", () => {
  test("WEBSITE addresses use /site/<username> everywhere", () => {
    expect(publicSitePath("Ada")).toBe("/site/ada"); // normalized lowercase
    expect(publicSiteHashUrl("ada")).toBe("#/site/ada");
    expect(publicSiteAbsoluteUrl("ada", "https://beanfolio.com")).toBe("https://beanfolio.com/site/ada");
  });

  test("PROFILE addresses use /u/<username> everywhere", () => {
    expect(publicProfilePath("Ada")).toBe("/u/ada"); // normalized lowercase
    expect(publicProfileHashUrl("ada")).toBe("#/u/ada");
    expect(publicProfileAbsoluteUrl("ada", "https://beanfolio.com")).toBe("https://beanfolio.com/u/ada");
  });

  test("the two route forms never collide (separated experiences)", () => {
    // /u/<username> is the BEAN Folio public profile; /site/<username> is the
    // standalone website. The same username must yield DIFFERENT paths, and
    // neither form may be derived from the other's helper.
    expect(publicProfilePath("ada")).not.toBe(publicSitePath("ada"));
    expect(publicProfilePath("ada")!.startsWith("/u/")).toBe(true);
    expect(publicSitePath("ada")!.startsWith("/site/")).toBe(true);
    expect(publicProfileHashUrl("ada")!.startsWith("#/u/")).toBe(true);
    expect(publicSiteHashUrl("ada")!.startsWith("#/site/")).toBe(true);
  });

  test("special but valid usernames survive percent-encoding unchanged", () => {
    const path = publicSitePath("ada.studio");
    expect(path).toBe("/site/ada.studio");
    // decode(encode) round-trips
    expect(decodeURIComponent(path!.split("/")[2])).toBe("ada.studio");
    const profilePath = publicProfilePath("ada.studio");
    expect(profilePath).toBe("/u/ada.studio");
    expect(decodeURIComponent(profilePath!.split("/")[2])).toBe("ada.studio");
  });

  test("missing username yields null everywhere (never a broken link)", () => {
    expect(publicSitePath(null)).toBeNull();
    expect(publicSitePath("  ")).toBeNull();
    expect(publicSiteHashUrl(undefined)).toBeNull();
    expect(publicSiteAbsoluteUrl(null, "https://beanfolio.com")).toBeNull();
    expect(publicProfilePath(null)).toBeNull();
    expect(publicProfileHashUrl(undefined)).toBeNull();
    expect(publicProfileAbsoluteUrl("  ", "https://beanfolio.com")).toBeNull();
  });
});
