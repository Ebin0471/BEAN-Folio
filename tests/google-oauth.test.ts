/// <reference types="bun-types" />
import { describe, expect, test, afterAll, beforeAll, mock } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "crypto";
import type { KeyObject } from "crypto";
import { NextRequest } from "next/server";

/**
 * Google OAuth — security matrix + account-linking regression tests.
 *
 * The REAL route handlers run unchanged; only Google's token/JWKS endpoints
 * are replaced with local mock servers and ID tokens are signed with locally
 * generated RSA keys, so signature / issuer / audience / expiry / nonce /
 * verified-email validation is exercised against real cryptography.
 *
 * Run: bun test tests/google-oauth.test.ts
 */

// ---- stateful cookie jar (same harness as tests/auth-routes.test.ts) ----
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

import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth";
import { googleEndpoints, resetJwksCache, GOOGLE_LINK_COOKIE } from "@/lib/auth/google-oauth";
import { GET as authorizeRoute } from "@/app/api/auth/google/route";
import { GET as callbackRoute } from "@/app/api/auth/google/callback/route";
import { GET as statusRoute } from "@/app/api/auth/google/status/route";
import { POST as registerRoute } from "@/app/api/auth/register/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { GET as meRoute } from "@/app/api/auth/me/route";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

// ---------------------------------------------------------------- harness helpers

function uniqueIp(): string {
  return `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`;
}

function req(path: string, method = "GET", body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": uniqueIp(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function resBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function locationOf(res: Response): URL {
  const loc = res.headers.get("location");
  expect(loc).toBeTruthy();
  return new URL(loc!);
}

function clearJar(): void {
  jar.delete("bean_session");
  jar.delete(GOOGLE_LINK_COOKIE);
}

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

// ---------------------------------------------------------------- RSA keys + JWT helper

const { publicKey: pub1, privateKey: key1 } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: key2 } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key-1";

function jwksFor(key: KeyObject): Record<string, unknown> {
  const jwk = key.export({ format: "jwk" }) as Record<string, unknown>;
  return { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] };
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function signIdToken(claims: Record<string, unknown>, opts?: { key?: KeyObject; kid?: string }): string {
  const key = opts?.key ?? key1;
  const kid = opts?.kid ?? KID;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = b64url(JSON.stringify(claims));
  const signature = cryptoSign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}

// ---------------------------------------------------------------- mock Google endpoints

let tokenResponseFn: (form: URLSearchParams) => { status: number; body: Record<string, unknown> };
let lastTokenForm: URLSearchParams | null = null;
let jwksResponse: Record<string, unknown> = jwksFor(pub1);

const tokenServer = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const form = new URLSearchParams(await req.text());
    lastTokenForm = form;
    const r = tokenResponseFn(form);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  },
});
const jwksServer = Bun.serve({
  port: 0,
  fetch: () => new Response(JSON.stringify(jwksResponse), { headers: { "content-type": "application/json" } }),
});

const REAL_TOKEN_URL = googleEndpoints.tokenUrl;
const REAL_JWKS_URL = googleEndpoints.jwksUrl;
const REAL_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const REAL_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

beforeAll(() => {
  googleEndpoints.tokenUrl = `http://localhost:${tokenServer.port}/token`;
  googleEndpoints.jwksUrl = `http://localhost:${jwksServer.port}/certs`;
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  delete process.env.GOOGLE_REDIRECT_URI; // derive from request origin (localhost)
  tokenResponseFn = () => ({ status: 500, body: { error: "no response configured" } });
});

afterAll(() => {
  googleEndpoints.tokenUrl = REAL_TOKEN_URL;
  googleEndpoints.jwksUrl = REAL_JWKS_URL;
  if (REAL_CLIENT_ID === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = REAL_CLIENT_ID;
  if (REAL_CLIENT_SECRET === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = REAL_CLIENT_SECRET;
  tokenServer.stop(true);
  jwksServer.stop(true);
});

/** Run a full authorize step; returns the state + nonce from the redirect. */
async function authorize(): Promise<{ state: string; nonce: string }> {
  const res = await authorizeRoute(req("/api/auth/google"));
  expect(res.status).toBe(303);
  const loc = locationOf(res);
  expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  return {
    state: loc.searchParams.get("state")!,
    nonce: loc.searchParams.get("nonce")!,
  };
}

/** Standard valid claims for the mock flow. */
function validClaims(over: Record<string, unknown>): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: "test-client-id",
    exp: now + 3600,
    iat: now,
    ...over,
  };
}

const EMAILS = {
  googleNew: `google-new-${Date.now()}-x@beanfolio.test`,
  googleReturn: `google-return-${Date.now()}-x@beanfolio.test`,
  passwordLink: `password-link-${Date.now()}-x@beanfolio.test`,
  otherUser: `other-user-${Date.now()}-x@beanfolio.test`,
  subA: `taken-${Date.now()}-x@beanfolio.test`,
  // Tombstone email uses the CURRENT production format (me/deletion route:
  // `deleted+<id>@deleted.beanfolio`) so the row satisfies the auth.test.ts
  // cross-suite invariant (/^deleted\+/) — the old `deleted-…` shape is from
  // a retired code version and would poison the shared dev DB.
  deleted: `deleted+${Date.now()}@deleted.beanfolio`,
};
// Per-run unique google subject — the User.googleId unique index must never
// collide with rows left by a previous test run.
const GOOGLE_SUB = `sub-${crypto.randomUUID()}`;

// ---------------------------------------------------------------- authorize endpoint

describe("GET /api/auth/google (authorize)", () => {
  test("without credentials it redirects honestly to the auth screen (no fake flow)", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    try {
      const res = await authorizeRoute(req("/api/auth/google"));
      expect(res.status).toBe(303);
      const loc = locationOf(res);
      expect(loc.hash).toBe("#/auth");
      expect(loc.searchParams.get("googleError")).toBe("disabled");
    } finally {
      process.env.GOOGLE_CLIENT_ID = "test-client-id";
      process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    }
  });

  test("with credentials it redirects to Google with PKCE and stores the flow server-side", async () => {
    const { state, nonce } = await authorize();

    // Flow exists server-side (hashes at rest) and expires in ~10 minutes.
    const flow = await db.oAuthFlow.findUnique({ where: { stateHash: sha256Hex(state) } });
    expect(flow).not.toBeNull();
    expect(flow!.nonceHash).toBe(sha256Hex(nonce));
    expect(flow!.codeVerifier.length).toBeGreaterThan(30);
    expect(flow!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 11 * 60 * 1000);
    expect(flow!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 8 * 60 * 1000);
  });

  test("status endpoint reports enabled + the exact derived redirect URI", async () => {
    const res = await statusRoute(req("/api/auth/google/status"));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.enabled).toBe(true);
    expect(body.redirectUri).toBe("http://localhost:3000/api/auth/google/callback");
  });
});

// ---------------------------------------------------------------- callback: rejection matrix

describe("GET /api/auth/google/callback — rejections (fail closed)", () => {
  test("OAuth cancellation (error=access_denied) lands back with an honest message", async () => {
    const res = await callbackRoute(req("/api/auth/google/callback?error=access_denied&state=whatever"));
    expect(res.status).toBe(303);
    const loc = locationOf(res);
    expect(loc.searchParams.get("googleError")).toBe("cancelled");
    expect(loc.hash).toBe("#/auth");
  });

  test("forged / unknown state is refused (CSRF protection)", async () => {
    const res = await callbackRoute(
      req(`/api/auth/google/callback?code=abc&state=${"forged".repeat(10)}`)
    );
    const loc = locationOf(res);
    expect(loc.searchParams.get("googleError")).toBe("state");
  });

  test("missing code or state is refused", async () => {
    const res = await callbackRoute(req("/api/auth/google/callback?code=abc"));
    expect(locationOf(res).searchParams.get("googleError")).toBe("state");
  });

  test("replayed callback (same state twice) is refused — single-use flows", async () => {
    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: `replay-sub-${Date.now()}`, email: `replay-${Date.now()}@x.test`, email_verified: true, nonce })) },
    });
    const first = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(first.status).toBe(303);
    const second = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(locationOf(second).searchParams.get("googleError")).toBe("state");
  });

  test("provider outage (token endpoint 500) maps to the honest provider error", async () => {
    const { state } = await authorize();
    tokenResponseFn = () => ({ status: 500, body: { error: "backend_error" } });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=outage&state=${encodeURIComponent(state)}`));
    expect(locationOf(res).searchParams.get("googleError")).toBe("provider");
  });

  test("unverified email is rejected — no account is created", async () => {
    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: "unverified-sub", email: "unverified@x.test", email_verified: false, nonce })) },
    });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(locationOf(res).searchParams.get("googleError")).toBe("unverified");
    expect(await db.user.count({ where: { email: "unverified@x.test" } })).toBe(0);
  });

  test("nonce mismatch is rejected (token injection / code replay)", async () => {
    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: "nonce-sub", email: "nonce@x.test", email_verified: true, nonce: nonce + "tampered" })) },
    });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(locationOf(res).searchParams.get("googleError")).toBe("invalid");
    expect(await db.user.count({ where: { email: "nonce@x.test" } })).toBe(0);
  });

  test("invalid signature (wrong key, known kid) is rejected", async () => {
    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: "sig-sub", email: "sig@x.test", email_verified: true, nonce }), { key: key2 }) },
    });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(locationOf(res).searchParams.get("googleError")).toBe("invalid");
    expect(await db.user.count({ where: { email: "sig@x.test" } })).toBe(0);
  });

  test("expired ID token is rejected", async () => {
    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: "exp-sub", email: "exp@x.test", email_verified: true, nonce, exp: Math.floor(Date.now() / 1000) - 3600 })) },
    });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(locationOf(res).searchParams.get("googleError")).toBe("expired");
  });

  test("wrong issuer is rejected", async () => {
    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: "iss-sub", email: "iss@x.test", email_verified: true, nonce, iss: "https://evil.example" })) },
    });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(locationOf(res).searchParams.get("googleError")).toBe("invalid");
  });

  test("wrong audience is rejected", async () => {
    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: "aud-sub", email: "aud@x.test", email_verified: true, nonce, aud: "another-client" })) },
    });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(locationOf(res).searchParams.get("googleError")).toBe("invalid");
  });
});

// ---------------------------------------------------------------- happy paths: registration + login

describe("callback — new Google account registration", () => {
  test("creates the account, issues the SAME bean session, and continues to onboarding", async () => {
    clearJar();
    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: GOOGLE_SUB, email: EMAILS.googleNew, email_verified: true, nonce, name: "Nova Google" })) },
    });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(res.status).toBe(303);
    expect(locationOf(res).hash).toBe("#/onboarding");

    // Account row: identity stored, unusable-but-real password hash, no duplicates.
    const user = await db.user.findUnique({ where: { email: EMAILS.googleNew } });
    expect(user?.googleId).toBe(GOOGLE_SUB);
    expect(user?.name).toBe("Nova Google");
    expect(user!.passwordHash.split(":")).toHaveLength(2); // real scrypt format
    expect(await verifyPassword("any-guessable-password", user!.passwordHash)).toBe(false);

    // Same session system: cookie set, /api/auth/me resolves through it.
    expect(jar.has("bean_session")).toBe(true);
    const me = await meRoute(req("/api/auth/me"));
    expect(me.status).toBe(200);
    const meBody = await resBody(me);
    expect((meBody.user as Record<string, unknown>).email).toBe(EMAILS.googleNew);

    const audit = await db.auditEvent.findFirst({ where: { actorUserId: user!.id, action: "auth.register.google" } });
    expect(audit).not.toBeNull();
  });

  test("second sign-in with the same Google identity logs into the SAME account (no duplicate)", async () => {
    clearJar();
    const before = await db.user.count({ where: { email: EMAILS.googleNew } });
    expect(before).toBe(1);

    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: GOOGLE_SUB, email: EMAILS.googleNew, email_verified: true, nonce })) },
    });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(res.status).toBe(303);

    expect(await db.user.count({ where: { email: EMAILS.googleNew } })).toBe(1);
    expect(jar.has("bean_session")).toBe(true);
    const loginAudit = await db.auditEvent.findFirst({ where: { action: "auth.login.google" } });
    expect(loginAudit).not.toBeNull();
  });
});

// ---------------------------------------------------------------- account linking (never silent, never overwrites)

describe("account linking — password account + verified Google email", () => {
  test("does NOT silently link: issues a single-use grant and asks for one password login", async () => {
    clearJar();
    // Existing password account with a project (portfolio preservation check).
    const reg = await registerRoute(req("/api/auth/register", "POST", { email: EMAILS.passwordLink, password: "link-password-1", name: "Link Me", identity: "CAREER_PROFESSIONAL" }));
    expect(reg.status).toBe(200);
    const owner = await db.user.findUnique({ where: { email: EMAILS.passwordLink } });
    await db.project.create({ data: { ownerId: owner!.id, title: "Pre-link portfolio piece", visibility: "PRIVATE", status: "DRAFT" } });
    clearJar(); // drop the registration session — visitor signs out first

    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: `link-sub-${Date.now()}`, email: EMAILS.passwordLink, email_verified: true, nonce })) },
    });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    const loc = locationOf(res);
    expect(loc.searchParams.get("googleLink")).toBe("1");
    expect(loc.hash).toBe("#/auth");

    // No takeover: no session was issued for the account owner.
    expect(jar.has("bean_session")).toBe(false);
    const afterCallback = await db.user.findUnique({ where: { email: EMAILS.passwordLink } });
    expect(afterCallback?.googleId).toBeNull();

    // Grant exists, single-use cookie pointer set.
    expect(jar.has(GOOGLE_LINK_COOKIE)).toBe(true);
    expect(await db.googleLink.count({ where: { email: EMAILS.passwordLink } })).toBe(1);
  });

  test("the next successful password login links the identity; password still works; portfolio preserved", async () => {
    // NOTE: continues the EXACT browser state from the previous test — the
    // single-use link cookie is the fixture here and must not be cleared.
    const res = await loginRoute(req("/api/auth/login", "POST", { email: EMAILS.passwordLink, password: "link-password-1" }));
    expect(res.status).toBe(200);

    const user = await db.user.findUnique({ where: { email: EMAILS.passwordLink } });
    expect(user?.googleId).toBeTruthy();
    // Password unchanged — the old secret still verifies.
    expect(await verifyPassword("link-password-1", user!.passwordHash)).toBe(true);
    expect(await db.googleLink.count({ where: { email: EMAILS.passwordLink } })).toBe(0); // consumed
    expect(jar.has(GOOGLE_LINK_COOKIE)).toBe(false); // cookie cleared
    // Portfolio untouched.
    const projects = await db.project.count({ where: { owner: { email: EMAILS.passwordLink } } });
    expect(projects).toBe(1);
    const audit = await db.auditEvent.findFirst({ where: { actorUserId: user!.id, action: "auth.google.linked" } });
    expect(audit).not.toBeNull();
  });

  test("a grant consumed while logging into a DIFFERENT account links nothing", async () => {
    clearJar();
    // Fresh pair of accounts, fully self-contained. grantEmail is an EXISTING
    // password account — a Google identity for it must produce a LINK grant,
    // not a new account.
    const grantEmail = `grant-src-${Date.now()}@beanfolio.test`;
    const otherEmail = `grant-other-${Date.now()}@beanfolio.test`;
    await registerRoute(req("/api/auth/register", "POST", { email: grantEmail, password: "grant-password-1", name: "Grant Src", identity: "CAREER_PROFESSIONAL" }));
    clearJar();
    await registerRoute(req("/api/auth/register", "POST", { email: otherEmail, password: "other-password-1", name: "Other", identity: "CAREER_PROFESSIONAL" }));
    clearJar();

    // Grant scoped to grantEmail.
    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: `grant-src-sub-${Date.now()}`, email: grantEmail, email_verified: true, nonce })) },
    });
    await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(await db.googleLink.count({ where: { email: grantEmail } })).toBe(1);
    clearJar(); // drop ONLY the callback artifacts, keep nothing session-like

    // Re-issue the grant + cookie, then log in as the OTHER user.
    const { state: s2, nonce: n2 } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: `grant-src-sub2-${Date.now()}`, email: grantEmail, email_verified: true, nonce: n2 })) },
    });
    await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(s2)}`));
    expect(jar.has(GOOGLE_LINK_COOKIE)).toBe(true);
    const grantsBefore = await db.googleLink.count({ where: { email: grantEmail } });

    const res = await loginRoute(req("/api/auth/login", "POST", { email: otherEmail, password: "other-password-1" }));
    expect(res.status).toBe(200);
    const other = await db.user.findUnique({ where: { email: otherEmail } });
    expect(other?.googleId).toBeNull(); // email-scoped grant never links a different account
    // The grant pointed at by the cookie was consumed (single-use) even though
    // it linked nothing — only the earlier orphaned row remains.
    expect(await db.googleLink.count({ where: { email: grantEmail } })).toBe(grantsBefore - 1);
  });

  test("authenticated confirmation links immediately for the signed-in owner", async () => {
    clearJar();
    await registerRoute(req("/api/auth/register", "POST", { email: EMAILS.googleReturn, password: "confirm-password-1", name: "Confirm", identity: "CAREER_PROFESSIONAL" }));
    const owner = await db.user.findUnique({ where: { email: EMAILS.googleReturn } });
    clearJar();
    // Sign in properly so a real session exists.
    await loginRoute(req("/api/auth/login", "POST", { email: EMAILS.googleReturn, password: "confirm-password-1" }));
    expect(jar.has("bean_session")).toBe(true);

    const { state, nonce } = await authorize();
    const sub = `confirm-sub-${Date.now()}`;
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub, email: EMAILS.googleReturn, email_verified: true, nonce })) },
    });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(res.status).toBe(303);
    expect(locationOf(res).hash).toBe("#/");

    const updated = await db.user.findUnique({ where: { id: owner!.id } });
    expect(updated?.googleId).toBe(sub);
  });

  test("authenticated mismatch (Google email belongs to ANOTHER account) links nothing", async () => {
    clearJar();
    // A separate password account that the Google identity will claim.
    const victimEmail = `mismatch-victim-${Date.now()}@beanfolio.test`;
    await registerRoute(req("/api/auth/register", "POST", { email: victimEmail, password: "victim-password-1", name: "Victim", identity: "CAREER_PROFESSIONAL" }));
    // Sign in as the googleReturn user; Google identity carries the victim's email.
    await loginRoute(req("/api/auth/login", "POST", { email: EMAILS.googleReturn, password: "confirm-password-1" }));

    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: `mismatch-sub-${Date.now()}`, email: victimEmail, email_verified: true, nonce })) },
    });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(locationOf(res).searchParams.get("googleError")).toBe("mismatch");
    const victim = await db.user.findUnique({ where: { email: victimEmail } });
    expect(victim?.googleId).toBeNull();
  });

  test("a second, different Google identity for an already-linked email is refused (conflict)", async () => {
    clearJar();
    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: `conflict-sub-${Date.now()}`, email: EMAILS.passwordLink, email_verified: true, nonce })) },
    });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(locationOf(res).searchParams.get("googleError")).toBe("conflict");
  });

  test("a deleted account is refused on both identity paths", async () => {
    clearJar();
    const email = EMAILS.deleted;
    const user = await db.user.create({
      data: { email, passwordHash: "x:y", name: "Deleted", googleId: `deleted-sub-${Date.now()}`, deletedAt: new Date() },
    });
    const { state, nonce } = await authorize();
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: user.googleId!, email, email_verified: true, nonce })) },
    });
    const res = await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(locationOf(res).searchParams.get("googleError")).toBe("deleted");
    expect(jar.has("bean_session")).toBe(false);
  });
});

// ---------------------------------------------------------------- PKCE + existing flows regression

describe("PKCE and existing authentication regression", () => {
  test("the code exchange sends the STORED verifier with grant_type=authorization_code", async () => {
    clearJar();
    const { state, nonce } = await authorize();
    const flow = await db.oAuthFlow.findUnique({ where: { stateHash: sha256Hex(state) } });
    tokenResponseFn = () => ({
      status: 200,
      body: { id_token: signIdToken(validClaims({ sub: `pkce-sub-${Date.now()}`, email: `pkce-${Date.now()}@x.test`, email_verified: true, nonce })) },
    });
    await callbackRoute(req(`/api/auth/google/callback?code=good&state=${encodeURIComponent(state)}`));

    expect(lastTokenForm).not.toBeNull();
    expect(lastTokenForm!.get("grant_type")).toBe("authorization_code");
    expect(lastTokenForm!.get("code_verifier")).toBe(flow!.codeVerifier);
    expect(lastTokenForm!.get("client_id")).toBe("test-client-id");
    expect(lastTokenForm!.get("client_secret")).toBe("test-client-secret"); // server-side only
    expect(lastTokenForm!.get("redirect_uri")).toBe("http://localhost:3000/api/auth/google/callback");
  });

  test("existing email + password signup still works alongside the Google path", async () => {
    clearJar();
    const email = `regression-${Date.now()}@beanfolio.test`;
    const res = await registerRoute(req("/api/auth/register", "POST", { email, password: "regression-1", name: "Regression", identity: "CAREER_PROFESSIONAL" }));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(typeof body.recoveryKey).toBe("string");
    expect(jar.has("bean_session")).toBe(true);
  });

  test("resetJwksCache clears the module cache (key rotation safety)", () => {
    expect(() => resetJwksCache()).not.toThrow();
  });
});
