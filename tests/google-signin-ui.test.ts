/// <reference types="bun-types" />
import { describe, expect, test, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

/**
 * Google sign-in button visibility — regression tests.
 *
 * Bug: the auth screen hid the "Continue with Google" block ENTIRELY when
 * credentials were unconfigured ({googleEnabled && ...}), so the button was
 * missing from BOTH tabs. Fix: the block is always visible; the button is
 * disabled with an honest message until the server reports a valid
 * configuration, and only then initiates /api/auth/google.
 *
 * The REAL route handlers run unchanged; only env vars are manipulated.
 *
 * Run: bun test tests/google-signin-ui.test.ts
 */

import { GET as statusRoute } from "@/app/api/auth/google/status/route";
import { GET as authorizeRoute } from "@/app/api/auth/google/route";
import { validateStartupEnvironment } from "@/lib/startup-validation";

const ORIG = {
  id: process.env.GOOGLE_CLIENT_ID,
  secret: process.env.GOOGLE_CLIENT_SECRET,
  redirect: process.env.GOOGLE_REDIRECT_URI,
};

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
}

afterAll(() => {
  if (ORIG.id === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = ORIG.id;
  if (ORIG.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = ORIG.secret;
  if (ORIG.redirect === undefined) delete process.env.GOOGLE_REDIRECT_URI;
  else process.env.GOOGLE_REDIRECT_URI = ORIG.redirect;
});

// ---------------------------------------------------------------- status endpoint

describe("GET /api/auth/google/status — drives the auth-screen button state", () => {
  test("enabled:false when credentials are missing (the current deployment state)", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;
    const res = await statusRoute(req("/api/auth/google/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; redirectUri: string; missing: string[] };
    expect(body.enabled).toBe(false);
    // Names only — never values — so ops can see exactly what to add.
    expect(body.missing).toContain("GOOGLE_CLIENT_ID");
    expect(body.missing).toContain("GOOGLE_CLIENT_SECRET");
    // Derived from the request origin so local dev needs zero env setup.
    expect(body.redirectUri).toBe("http://localhost:3000/api/auth/google/callback");
  });

  test("whitespace-only values count as missing (classic Vercel paste failure)", async () => {
    process.env.GOOGLE_CLIENT_ID = "   ";
    process.env.GOOGLE_CLIENT_SECRET = "\t ";
    const res = await statusRoute(req("/api/auth/google/status"));
    const body = (await res.json()) as { enabled: boolean; missing: string[] };
    expect(body.enabled).toBe(false);
    expect(body.missing).toContain("GOOGLE_CLIENT_ID");
    expect(body.missing).toContain("GOOGLE_CLIENT_SECRET");
  });

  test("half-configured (secret only) is still disabled and says which name is missing", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = "only-the-secret";
    const res = await statusRoute(req("/api/auth/google/status"));
    const body = (await res.json()) as { enabled: boolean; missing: string[] };
    expect(body.enabled).toBe(false);
    expect(body.missing).toEqual(["GOOGLE_CLIENT_ID"]);
  });

  test("GOOGLE_REDIRECT_URI (the documented production value) wins when set", async () => {
    delete process.env.GOOGLE_CLIENT_ID; // enabled stays false — only the URI is reported
    process.env.GOOGLE_REDIRECT_URI = "https://bean-folio.vercel.app/api/auth/google/callback";
    const res = await statusRoute(req("/api/auth/google/status"));
    const body = (await res.json()) as { enabled: boolean; redirectUri: string };
    expect(body.enabled).toBe(false);
    expect(body.redirectUri).toBe("https://bean-folio.vercel.app/api/auth/google/callback");
  });

  test("behind a proxy (forwarded headers) the derived callback uses the PUBLIC origin", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;
    const proxied = new NextRequest("http://internal-host:3000/api/auth/google/status", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "bean-folio.vercel.app" },
    });
    const res = await statusRoute(proxied);
    const body = (await res.json()) as { enabled: boolean; redirectUri: string };
    // The exact value that must be registered in Google Cloud Console.
    expect(body.redirectUri).toBe("https://bean-folio.vercel.app/api/auth/google/callback");
  });

  test("enabled:true once client id + secret are configured", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    delete process.env.GOOGLE_REDIRECT_URI;
    const res = await statusRoute(req("/api/auth/google/status"));
    const body = (await res.json()) as { enabled: boolean; missing: string[] };
    expect(body.enabled).toBe(true);
    expect(body.missing).toEqual([]);
  });

  test("values with surrounding whitespace are trimmed before use", async () => {
    process.env.GOOGLE_CLIENT_ID = "  padded-client-id  ";
    process.env.GOOGLE_CLIENT_SECRET = " secret ";
    const res = await statusRoute(req("/api/auth/google/status"));
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------- authorize endpoint

describe("GET /api/auth/google — an unconfigured deployment can never start a flow", () => {
  test("without credentials it redirects honestly back to the auth screen", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const res = await authorizeRoute(req("/api/auth/google"));
    expect(res.status).toBe(303);
    const loc = res.headers.get("location");
    expect(loc).toBeTruthy();
    const url = new URL(loc!);
    expect(url.hash).toBe("#/auth");
    expect(url.searchParams.get("googleError")).toBe("disabled");
  });

  test("behind a proxy the bounce-back lands on the PUBLIC origin (right scheme + host)", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const proxied = new NextRequest("http://internal-host:3000/api/auth/google", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "bean-folio.vercel.app" },
    });
    const res = await authorizeRoute(proxied);
    expect(res.status).toBe(303);
    const url = new URL(res.headers.get("location")!);
    expect(url.origin).toBe("https://bean-folio.vercel.app");
    expect(url.searchParams.get("googleError")).toBe("disabled");
    expect(url.hash).toBe("#/auth");
  });
});

// ---------------------------------------------------------------- startup validation

describe("startup validation — google_oauth check (names only, never values)", () => {
  const base = { DATABASE_URL: "file:./db/custom.db", NODE_ENV: "test" };

  test("both credentials set → ok", () => {
    const result = validateStartupEnvironment({
      env: { ...base, GOOGLE_CLIENT_ID: "id-value", GOOGLE_CLIENT_SECRET: "secret-value" },
      cache: false,
    });
    const check = result.checks.find((c) => c.name === "google_oauth");
    expect(check?.status).toBe("ok");
    expect(result.ok).toBe(true);
    // Value-free contract.
    expect(check?.detail).not.toContain("id-value");
    expect(check?.detail).not.toContain("secret-value");
  });

  test("both missing → warn (feature stays disabled, boot still succeeds)", () => {
    const result = validateStartupEnvironment({ env: { ...base }, cache: false });
    const check = result.checks.find((c) => c.name === "google_oauth");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("GOOGLE_CLIENT_ID");
    expect(check?.detail).toContain("GOOGLE_CLIENT_SECRET");
    expect(result.ok).toBe(true);
  });

  test("half-configured (id without secret) → warn with the exact missing name", () => {
    const result = validateStartupEnvironment({
      env: { ...base, GOOGLE_CLIENT_ID: "id-value" },
      cache: false,
    });
    const check = result.checks.find((c) => c.name === "google_oauth");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("HALF-configured");
    expect(check?.detail).toContain("GOOGLE_CLIENT_SECRET");
    expect(check?.detail).not.toContain("id-value");
  });

  test("whitespace-only values are treated as missing by the startup check too", () => {
    const result = validateStartupEnvironment({
      env: { ...base, GOOGLE_CLIENT_ID: "   ", GOOGLE_CLIENT_SECRET: " " },
      cache: false,
    });
    const check = result.checks.find((c) => c.name === "google_oauth");
    expect(check?.status).toBe("warn");
  });
});

// ---------------------------------------------------------------- AuthView structure

describe("AuthView — the Google button is visible on BOTH tabs in every state", () => {
  const view = (): string => readFileSync("src/views/AuthView.tsx", "utf8");

  test("no longer hides the Google block behind the old boolean gate", () => {
    const src = view();
    expect(src.includes("googleEnabled &&")).toBe(false);
    expect(src.includes('useState<"checking" | "unconfigured" | "enabled">')).toBe(true);
  });

  test("button is disabled unless the server reports a valid configuration", () => {
    expect(view().includes('disabled={googleStatus !== "enabled" || googleBusy}')).toBe(true);
  });

  test("clicking can never start a flow unless the configuration is enabled", () => {
    expect(view().includes('if (googleBusy || googleStatus !== "enabled") return;')).toBe(true);
  });

  test("status-fetch failure degrades to the disabled state (never a broken flow)", () => {
    const src = view();
    // set in the success branch (false → unconfigured) AND in the catch branch
    expect(src.includes('setGoogleStatus(res.enabled ? "enabled" : "unconfigured")')).toBe(true);
    expect(src.includes('setGoogleStatus("unconfigured")')).toBe(true);
  });

  test("shows the honest not-configured message when unconfigured", () => {
    const src = view();
    expect(src.includes('googleStatus === "unconfigured" && (')).toBe(true);
    expect(src.includes("Google sign-in is not configured yet.")).toBe(true);
  });

  test("official Google G branding + required label + OR divider", () => {
    const src = view();
    for (const color of ["#4285F4", "#34A853", "#FBBC05", "#EA4335"]) {
      expect(src.includes(color)).toBe(true);
    }
    // The button label renders as its own JSX text node.
    expect(/^\s+Continue with Google\s*$/m.test(src)).toBe(true);
    expect(src.includes(">OR</span>")).toBe(true);
  });

  test("single shared Google block AFTER the tabs → rendered on BOTH tabs", () => {
    const src = view();
    const tabsEnd = src.indexOf("</Tabs>");
    const button = src.search(/^\s+Continue with Google\s*$/m);
    expect(tabsEnd).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(tabsEnd);
    // exactly one button instance (shared across tabs, not duplicated per tab)
    expect(src.match(/^\s+Continue with Google\s*$/gm)?.length).toBe(1);
  });

  test("enabled state still initiates the preserved top-level PKCE + OIDC redirect", () => {
    const src = view();
    expect(src.includes('window.location.href = "/api/auth/google"')).toBe(true);
    expect(src.includes('window.open("/api/auth/google", "_blank", "noopener")')).toBe(true);
  });
});
