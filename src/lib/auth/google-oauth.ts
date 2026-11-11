import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";

/**
 * Google OAuth 2.0 — Authorization Code flow with OpenID Connect, PKCE (S256),
 * server-side state and nonce. Direct integration with the EXISTING custom
 * cookie session architecture (no Supabase/Firebase — see docs/google-auth.md).
 *
 * Security contract (all enforced server-side; nothing browser-supplied is
 * ever trusted for identity):
 *  - state/nonce/PKCE-verifier are generated here and stored SERVER-SIDE in
 *    the OAuthFlow table (hashes at rest), single-use, 10-minute TTL. The
 *    browser only relays `state` through the redirect — DB-backed validation
 *    holds across horizontally scaled instances without a shared secret.
 *  - The ID token's RS256 signature is verified against Google's published
 *    JWKS; issuer, audience, expiry and nonce are validated; only
 *    Google-verified emails are accepted.
 *  - The authorization code is exchanged server-side together with the PKCE
 *    verifier; the client secret never leaves the server and the frontend
 *    never sees any Google token.
 */

// ---------------------------------------------------------------- configuration

/** Endpoint/config surface — overridable in tests (mock token/JWKS servers). */
export const googleEndpoints = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
  /** Accepted `iss` values per Google's OIDC docs. */
  issuers: ["https://accounts.google.com", "accounts.google.com"] as string[],
  /** Clock leeway for exp/iat validation (seconds of tolerated drift). */
  leewaySec: 60,
  /** Flow + pending-link lifetime. */
  flowTtlMs: 10 * 60 * 1000,
};

/**
 * Configured = BOTH credentials present and non-blank. Values are trimmed so
 * a stray space in a Vercel env var (a classic silent OAuth failure) is not
 * treated as a valid client. There is deliberately NO partial state: an ID
 * without a secret (or vice versa) reports as unconfigured and is flagged by
 * the startup validation check instead.
 */
function envValue(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function googleOAuthConfigured(): boolean {
  return Boolean(envValue("GOOGLE_CLIENT_ID") && envValue("GOOGLE_CLIENT_SECRET"));
}

/** Names of the required Google OAuth variables that are missing/blank. */
export function googleConfigMissing(): string[] {
  const missing: string[] = [];
  if (!envValue("GOOGLE_CLIENT_ID")) missing.push("GOOGLE_CLIENT_ID");
  if (!envValue("GOOGLE_CLIENT_SECRET")) missing.push("GOOGLE_CLIENT_SECRET");
  return missing;
}

/** The configured OAuth client id (for ID-token audience validation). */
export function googleClientId(): string | null {
  return envValue("GOOGLE_CLIENT_ID");
}

function requireConfig(): { clientId: string; clientSecret: string } {
  const clientId = envValue("GOOGLE_CLIENT_ID");
  const clientSecret = envValue("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing)");
  }
  return { clientId, clientSecret };
}

/**
 * The request's public origin — forwarded headers first (behind Vercel/Caddy
 * the internal request URL can be http on a private host), then the URL Next
 * parsed from the request.
 */
export function resolveOrigin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return proto && host ? `${proto}://${host}` : req.nextUrl.origin;
}

/**
 * The exact redirect_uri sent to Google — it MUST byte-match one of the
 * Authorized redirect URIs in Google Cloud Console. `GOOGLE_REDIRECT_URI` wins
 * when set (the documented production configuration); otherwise it is derived
 * from the incoming request origin so local development works with zero env
 * setup (http://localhost:3000/api/auth/google/callback).
 */
export function resolveRedirectUri(req: NextRequest): string {
  const explicit = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return `${resolveOrigin(req).replace(/\/+$/, "")}/api/auth/google/callback`;
}

// ---------------------------------------------------------------- redirects back to the SPA

/**
 * All OAuth outcomes land back on the hash-routed auth screen with
 * search-param signals BEFORE the hash (the hash router strips query params
 * inside the fragment). AuthView reads `window.location.search` on mount,
 * shows the mapped message, then strips the params from the address bar.
 */
export function authPageRedirect(req: NextRequest, params: Record<string, string>, hash = "/auth"): NextResponse {
  // Same origin resolution as the OAuth redirect_uri — behind a reverse proxy
  // the bounce-back must land on the PUBLIC origin (right scheme + host).
  const url = new URL("/", resolveOrigin(req));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.hash = hash;
  return NextResponse.redirect(url, 303);
}

// ---------------------------------------------------------------- flow records (server-side state)

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CreatedFlow {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * Create a single-use authorization flow. Expired rows are pruned on every
 * creation (cheap housekeeping; the maintenance sweep also covers stragglers).
 */
export async function createFlow(): Promise<CreatedFlow> {
  await db.oAuthFlow.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined);
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  await db.oAuthFlow.create({
    data: {
      stateHash: sha256Hex(state),
      nonceHash: sha256Hex(nonce),
      codeVerifier,
      expiresAt: new Date(Date.now() + googleEndpoints.flowTtlMs),
    },
  });
  const codeChallenge = pkceChallenge(codeVerifier);
  return { state, nonce, codeVerifier, codeChallenge };
}

export interface ConsumedFlow {
  nonceHash: string;
  codeVerifier: string;
}

/**
 * Single-use consumption: look the flow up by the callback's `state`, verify
 * it is unexpired, and DELETE it immediately — a replayed callback can never
 * validate twice (CSRF / callback-abuse protection).
 */
export async function consumeFlow(state: string): Promise<ConsumedFlow | null> {
  if (!state || state.length > 512) return null;
  const stateHash = sha256Hex(state);
  const flow = await db.oAuthFlow.findUnique({ where: { stateHash } });
  if (!flow) return null;
  await db.oAuthFlow.delete({ where: { id: flow.id } }).catch(() => undefined);
  if (flow.expiresAt.getTime() < Date.now()) return null;
  return { nonceHash: flow.nonceHash, codeVerifier: flow.codeVerifier };
}

// ---------------------------------------------------------------- authorize URL

export function buildGoogleAuthUrl(params: {
  redirectUri: string;
  clientId: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(googleEndpoints.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  // Identity only — never request extra scopes.
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Online only: BEAN Folio never calls Google APIs on the user's behalf, so
  // no refresh token is requested or stored.
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/** S256 PKCE challenge from the stored verifier. */
export function pkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

// ---------------------------------------------------------------- code exchange

/** Thrown when the token endpoint fails — mapped to the honest "provider" error. */
export class GoogleTokenExchangeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GoogleTokenExchangeError";
    this.status = status;
  }
}

export interface TokenResponse {
  idToken: string;
}

/**
 * Exchange the authorization code for tokens (server-to-server, PKCE verifier
 * attached). Only the ID token is consumed — access/refresh tokens are not
 * used, requested for storage, or surfaced anywhere.
 */
export async function exchangeAuthorizationCode(params: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  const { clientId, clientSecret } = requireConfig();
  let res: Response;
  try {
    res = await fetch(googleEndpoints.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: params.redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: params.codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new GoogleTokenExchangeError(
      e instanceof Error ? `token endpoint unreachable: ${e.message}` : "token endpoint unreachable",
      0
    );
  }
  if (!res.ok) {
    let reason = "token exchange rejected";
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) reason = body.error; // e.g. "invalid_grant" — logged, never surfaced raw to users
    } catch {
      /* non-JSON failure body */
    }
    throw new GoogleTokenExchangeError(reason, res.status);
  }
  const data = (await res.json().catch(() => null)) as { id_token?: string } | null;
  const idToken = data?.id_token;
  if (!idToken || typeof idToken !== "string") {
    throw new GoogleTokenExchangeError("token response contained no id_token", res.status);
  }
  return { idToken };
}

// ---------------------------------------------------------------- ID token verification

export type OidcRejection =
  | "malformed"
  | "signature"
  | "issuer"
  | "audience"
  | "expired_token"
  | "nonce"
  | "unverified_email"
  | "provider";

/** Thrown when the ID token fails any OIDC validation step. */
export class GoogleIdTokenError extends Error {
  readonly reason: OidcRejection;
  constructor(reason: OidcRejection, message: string) {
    super(message);
    this.name = "GoogleIdTokenError";
    this.reason = reason;
  }
}

interface ParsedHeader {
  alg?: string;
  kid?: string;
}
interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
}

// -- JWKS cache (module-level; force-refreshed on an unknown kid once) --
interface JwksCacheEntry {
  keys: Map<string, JsonWebKey & { kid?: string; alg?: string; use?: string }>;
  fetchedAt: number;
}
let jwksCache: JwksCacheEntry | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

export function resetJwksCache(): void {
  jwksCache = null;
}

async function fetchJwks(force: boolean): Promise<JwksCacheEntry> {
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache;
  const res = await fetch(googleEndpoints.jwksUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new GoogleIdTokenError("provider", `JWKS endpoint returned ${res.status}`);
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, JsonWebKey & { kid?: string }>();
  for (const k of body.keys ?? []) if (k.kid) keys.set(k.kid, k);
  if (keys.size === 0) throw new GoogleIdTokenError("provider", "JWKS contained no keys");
  jwksCache = { keys, fetchedAt: Date.now() };
  return jwksCache;
}

function b64urlJson<T>(segment: string, what: string): T {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
  } catch {
    throw new GoogleIdTokenError("malformed", `${what} segment is not valid base64url JSON`);
  }
}

export interface VerifiedGoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

/**
 * Verify a Google ID token end-to-end: RS256 signature against the published
 * JWKS, issuer, audience, expiry, nonce (hash-compared against the stored
 * flow) and Google-verified email. Returns the minimal verified identity.
 */
export async function verifyGoogleIdToken(params: {
  idToken: string;
  clientId: string;
  nonceHash: string;
}): Promise<VerifiedGoogleIdentity> {
  const parts = params.idToken.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new GoogleIdTokenError("malformed", "ID token does not have three segments");
  }
  const header = b64urlJson<ParsedHeader>(parts[0], "header");
  if (header.alg !== "RS256") {
    throw new GoogleIdTokenError("malformed", `unexpected alg ${header.alg ?? "(none)"}`);
  }
  if (!header.kid) throw new GoogleIdTokenError("malformed", "ID token header has no kid");

  const claims = b64urlJson<IdTokenClaims>(parts[1], "payload");
  const signature = Buffer.from(parts[2], "base64url");

  // -- signature (refresh JWKS once when the kid is unknown — key rotation) --
  let jwks = await fetchJwks(false);
  let jwk = jwks.keys.get(header.kid);
  if (!jwk) {
    jwks = await fetchJwks(true);
    jwk = jwks.keys.get(header.kid);
  }
  if (!jwk) throw new GoogleIdTokenError("signature", `unknown key id ${header.kid}`);
  const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
  const okSig = cryptoVerify("RSA-SHA256", signed, key, signature);
  if (!okSig) throw new GoogleIdTokenError("signature", "ID token signature is invalid");

  // -- issuer --
  if (!claims.iss || !googleEndpoints.issuers.includes(claims.iss)) {
    throw new GoogleIdTokenError("issuer", `unexpected issuer ${claims.iss ?? "(none)"}`);
  }

  // -- audience (this exact client; azp must agree when present) --
  const audOk = Array.isArray(claims.aud)
    ? claims.aud.length === 1 && claims.aud[0] === params.clientId
    : claims.aud === params.clientId;
  if (!audOk) throw new GoogleIdTokenError("audience", "audience does not match this application");
  if (claims.azp && claims.azp !== params.clientId) {
    throw new GoogleIdTokenError("audience", "authorized party does not match this application");
  }

  // -- expiry / issued-at (bounded future drift) --
  const nowSec = Date.now() / 1000;
  if (typeof claims.exp !== "number") throw new GoogleIdTokenError("malformed", "exp claim missing");
  if (claims.exp + googleEndpoints.leewaySec < nowSec) {
    throw new GoogleIdTokenError("expired_token", "ID token has expired");
  }
  if (typeof claims.iat === "number" && claims.iat - googleEndpoints.leewaySec > nowSec) {
    throw new GoogleIdTokenError("malformed", "iat claim is in the future");
  }

  // -- nonce (hash-compared against the single-use flow row) --
  if (!claims.nonce || sha256Hex(claims.nonce) !== params.nonceHash) {
    throw new GoogleIdTokenError("nonce", "nonce does not match the authorization request");
  }

  // -- verified email --
  if (typeof claims.email !== "string" || !claims.email) {
    throw new GoogleIdTokenError("unverified_email", "ID token contains no email claim");
  }
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  if (!emailVerified) {
    throw new GoogleIdTokenError("unverified_email", "Google has not verified this email address");
  }
  if (!claims.sub) throw new GoogleIdTokenError("malformed", "sub claim missing");

  return {
    sub: claims.sub,
    email: claims.email.trim().toLowerCase(),
    name: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 80) : null,
    picture: typeof claims.picture === "string" && claims.picture.startsWith("https://") ? claims.picture : null,
  };
}

// ---------------------------------------------------------------- pending account linking

export const GOOGLE_LINK_COOKIE = "bean_google_link";

function linkCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.SESSION_SECURE_COOKIES
      ? process.env.SESSION_SECURE_COOKIES === "true"
      : process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/**
 * A fully verified Google identity whose email belongs to an EXISTING
 * password-only account may NOT silently take that account over. Instead a
 * short-lived single-use grant is stored server-side and an opaque httpOnly
 * cookie points at it; the next successful PASSWORD login with the matching
 * account consumes it and links the identity. Ownership is proven once with
 * the password; the password itself is never read, exposed or changed.
 */
export async function createPendingLink(identity: VerifiedGoogleIdentity): Promise<void> {
  await db.googleLink.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined);
  const token = randomBytes(32).toString("base64url");
  await db.googleLink.create({
    data: {
      tokenHash: sha256Hex(token),
      googleId: identity.sub,
      email: identity.email,
      name: identity.name,
      expiresAt: new Date(Date.now() + googleEndpoints.flowTtlMs),
    },
  });
  const store = await cookies();
  store.set(GOOGLE_LINK_COOKIE, token, linkCookieOptions(googleEndpoints.flowTtlMs / 1000));
}

/** Read-and-delete the pending link pointed at by the cookie (single-use). */
export async function consumePendingLink(): Promise<{ googleId: string; email: string } | null> {
  const store = await cookies();
  const token = store.get(GOOGLE_LINK_COOKIE)?.value;
  if (!token) return null;
  // Clear the cookie first — the grant is single-use no matter what happens next.
  store.set(GOOGLE_LINK_COOKIE, "", linkCookieOptions(0));
  const row = await db.googleLink.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!row) return null;
  await db.googleLink.delete({ where: { id: row.id } }).catch(() => undefined);
  if (row.expiresAt.getTime() < Date.now()) return null;
  return { googleId: row.googleId, email: row.email };
}

/**
 * Password hash for Google-created accounts: a real scrypt hash of a secret
 * nobody possesses (fresh 256-bit random, never stored or logged). Password
 * login therefore can never succeed for these accounts until the user sets a
 * real password through a flow that verifies their identity; nothing about the
 * account is weakened.
 */
export async function oauthOnlyPasswordHash(): Promise<string> {
  return hashPassword(randomBytes(32).toString("hex"));
}
