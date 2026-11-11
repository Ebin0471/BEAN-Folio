import { randomBytes } from "crypto";
import { INTERNAL_HOST_SUFFIXES, resolveShareOrigin } from "@/lib/site-url";

/**
 * Verified public-origin resolution for the CURRENT hosting environment.
 *
 * BEAN Folio's permanent share URL comes from deployment configuration
 * (NEXT_PUBLIC_APP_URL / VERCEL_URL — see lib/site-url). This module adds the
 * second, distinctly-labelled source: the address the CURRENT environment's
 * public edge actually routes to this application — e.g. a workspace host
 * like `https://<workspace-id>.space-z.ai` served through the platform's
 * public gateway.
 *
 * WHY ACTIVE PROOF (and never blind Host trust):
 * A request's Host header alone proves nothing — an attacker can send any
 * Host to a reachable endpoint, and a workspace's edge also answers for
 * hostnames that are recycled or not routed here (the platform replies
 * HTTP 410 for those). So a candidate host is ACCEPTED only after a live
 * round trip over PUBLIC DNS + TLS:
 *
 *   1. The server generates a one-time nonce.
 *   2. It fetches `https://<candidate>/api/origin-proof?nonce=<n>` — the
 *      candidate's own public DNS name, with certificate verification ON.
 *   3. The proof endpoint echoes the nonce. The response counts ONLY if the
 *      JSON carries the exact nonce AND the proof marker — i.e. the public
 *      internet name for that host lands an HTTPS request at THIS app.
 *
 * This proves the host is publicly routed to this deployment (DNS resolves
 * globally, TLS is valid, the platform edge forwards it here). It is
 * deliberately NOT a claim of permanence: workspace hosts live as long as
 * the workspace does — the UI must label them as the workspace's share
 * address, distinct from a permanent production domain.
 *
 * Failure is honest and quiet: no candidate (local request, no edge), a
 * host that fails proof, or a network error all resolve to
 * `ok: false` with an actionable message — callers keep Copy/Share
 * disabled and never present an unverified address as shareable.
 *
 * Caching: a verified host is re-proven at most once per ORIGIN_CACHE_TTL
 * (10 min); failures are remembered for NEGATIVE_TTL (60 s) so polled
 * endpoints (GET /api/me/site) do not hammer the edge. Verifications are
 * single-flight per host.
 */

const ORIGIN_CACHE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const PROOF_TIMEOUT_MS = 5000;
const PROOF_MARKER = "beanfolio-origin-proof";

export type CanonicalKind = "production" | "workspace";

export type WorkspaceShareOriginResult =
  | {
      ok: true;
      origin: string;
      /** Which configuration produced this origin — the UI labels each honestly. */
      kind: CanonicalKind;
      verifiedAt: string;
    }
  | {
      ok: false;
      reason: "not-configured" | "invalid-config" | "unverified-host";
      message: string;
    };

const UNVERIFIED_HOST_MESSAGE =
  "This environment's current address could not be verified as publicly reachable, so no share link was issued. The website snapshot is saved; open it via Open Live Website on the current deployment, or configure NEXT_PUBLIC_APP_URL with a production domain for a permanent link.";

// ------------------------------------------------------------- cache state

interface CacheEntry {
  origin: string;
  verifiedAt: number;
}

const positiveCache = new Map<string, CacheEntry>();
const negativeCache = new Map<string, number>();
const inFlight = new Map<string, Promise<boolean>>();

function cacheGet(host: string): CacheEntry | null {
  const hit = positiveCache.get(host);
  if (!hit) return null;
  if (Date.now() - hit.verifiedAt > ORIGIN_CACHE_TTL_MS) {
    positiveCache.delete(host);
    return null;
  }
  return hit;
}

function negativeGet(host: string): boolean {
  const until = negativeCache.get(host);
  if (!until) return false;
  if (Date.now() > until) {
    negativeCache.delete(host);
    return false;
  }
  return true;
}

// ---------------------------------------------------------- candidate host

/**
 * Minimal fail-closed shape check for a candidate edge host. Only names that
 * are POSITIVELY non-routable are rejected — IP literals, localhost-style
 * single labels, reserved internal suffixes and non-DNS shapes. Nothing else
 * is inferred from the NAME: this workspace's real public edge host is
 * `ws-<id>.cn-hongkong-vpc.fcapp.run` (an Alibaba FC trigger domain) — it
 * deliberately carries a `ws-` first label and a `-vpc` label while being
 * the address the creator's own browser successfully uses. Name-shape
 * heuristics (ws-/vpc/preview markers) therefore play no part here; the
 * ACTIVE origin-proof is the sole authority for routability.
 */
function unroutableHostName(host: string): boolean {
  if (!host || !host.includes(".")) return true; // empty / single-label service name
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true; // IPv4 literal
  if (host.includes(":")) return true; // IPv6 literal or malformed
  if (INTERNAL_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true;
  // Strict DNS-name shape — anything else must never reach a fetch URL.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return true;
  return false;
}

/**
 * Candidate public hosts for this request, most-trusted first:
 *   1. The edge-forwarded host (x-forwarded-host, then Host) — the host the
 *      infrastructure layer used to reach this deployment.
 *   2. The browser's Origin header host (fetch/XHR) — the ORIGIN the
 *      creator's browser actually runs the app on. On reverse-proxied
 *      platforms the edge can rewrite Host (e.g. to an internal trigger
 *      name) while the browser's Origin keeps the real public address —
 *      this workspace's preview does exactly that.
 *   3. The Referer host — same origin information for document navigations.
 *
 * Every candidate must pass unroutableHostName; duplicates are removed,
 * order preserved. Each candidate still has to pass the ACTIVE origin-proof
 * before it can become a share origin — headers only nominate, proof decides.
 */
export function candidatePublicHostsFromHeaders(headers: Headers): string[] {
  const candidates: string[] = [];

  const pushHost = (raw: string | null | undefined) => {
    if (!raw) return;
    let host = raw.split(",")[0].trim().toLowerCase();
    if (!host) return;
    if (host.startsWith("[")) {
      const end = host.indexOf("]");
      if (end === -1) return;
      host = host.slice(1, end);
    } else {
      const colon = host.lastIndexOf(":");
      if (colon !== -1) host = host.slice(0, colon);
    }
    host = host.replace(/\.$/, "");
    if (unroutableHostName(host)) return;
    if (!candidates.includes(host)) candidates.push(host);
  };

  pushHost(headers.get("x-forwarded-host"));
  pushHost(headers.get("host"));

  // Origin / Referer — parse tolerantly; garbage is simply ignored.
  for (const headerName of ["origin", "referer"] as const) {
    const value = headers.get(headerName);
    if (!value || value === "null") continue;
    try {
      pushHost(new URL(value).host);
    } catch {
      /* not a URL — ignore */
    }
  }

  return candidates.slice(0, 4);
}

// ----------------------------------------------------------- proof roundtrip

async function verifyHost(host: string): Promise<boolean> {
  const nonce = randomBytes(16).toString("hex");
  let res: Response;
  try {
    res = await fetch(`https://${host}/api/origin-proof?nonce=${nonce}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error", // a publicly-routed host answers directly; redirects are suspect
      signal: AbortSignal.timeout(PROOF_TIMEOUT_MS),
    });
  } catch {
    return false;
  }
  if (!res.ok) return false;
  try {
    const body = (await res.json()) as { nonce?: unknown; marker?: unknown };
    return body?.marker === PROOF_MARKER && body?.nonce === nonce;
  } catch {
    return false;
  }
}

/**
 * Resolve the share origin for the CURRENT request:
 *   1. Deployment configuration (NEXT_PUBLIC_APP_URL / VERCEL_URL) — kind
 *      "production", the permanent address. Takes precedence.
 *   2. The request's candidate hosts (edge host, browser Origin, Referer),
 *      in order: the first candidate that passes the active origin-proof
 *      becomes kind "workspace" — the environment's genuine public share
 *      address.
 *   3. Otherwise not-ok with the honest, actionable message.
 */
export async function resolveShareOriginForRequest(headers: Headers): Promise<WorkspaceShareOriginResult> {
  const configured = resolveShareOrigin();
  if (configured.ok) {
    return { ok: true, origin: configured.origin, kind: "production", verifiedAt: new Date(0).toISOString() };
  }
  // A config that exists but is invalid is reported as-is — the operator set
  // it deliberately and must see the error instead of a silently-different origin.
  if (configured.reason === "invalid-config") {
    return { ok: false, reason: "invalid-config", message: configured.message };
  }

  const candidates = candidatePublicHostsFromHeaders(headers);
  if (candidates.length === 0) {
    return { ok: false, reason: "not-configured", message: configured.message };
  }

  for (const host of candidates) {
    const cached = cacheGet(host);
    if (cached) {
      return {
        ok: true,
        origin: cached.origin,
        kind: "workspace",
        verifiedAt: new Date(cached.verifiedAt).toISOString(),
      };
    }
    if (negativeGet(host)) continue; // recently failed proof — try the next candidate

    let pending = inFlight.get(host);
    if (!pending) {
      pending = verifyHost(host);
      inFlight.set(host, pending);
    }
    let verified: boolean;
    try {
      verified = await pending;
    } finally {
      inFlight.delete(host);
    }

    if (verified) {
      const entry: CacheEntry = { origin: `https://${host}`, verifiedAt: Date.now() };
      positiveCache.set(host, entry);
      return {
        ok: true,
        origin: entry.origin,
        kind: "workspace",
        verifiedAt: new Date(entry.verifiedAt).toISOString(),
      };
    }
    negativeCache.set(host, Date.now() + NEGATIVE_TTL_MS);
  }

  return { ok: false, reason: "unverified-host", message: UNVERIFIED_HOST_MESSAGE };
}

/** Test hook — reset all memoized verification state. */
export function resetWorkspaceOriginCacheForTests(): void {
  positiveCache.clear();
  negativeCache.clear();
  inFlight.clear();
}
