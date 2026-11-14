import { NextRequest, NextResponse } from "next/server";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ZodType } from "zod";
import { memoryBackend, hitRateLimit } from "@/lib/rate-limit-backend";
import { reportError } from "@/lib/monitoring";

/** Success response */
export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data as Record<string, unknown> | unknown[], { status });
}

/** Error response. Never include stack traces or internal details. */
export function err(message: string, status = 400, code?: string): NextResponse {
  return NextResponse.json(code ? { error: message, code } : { error: message }, { status });
}

export const ERR = {
  unauthorized: () => err("Authentication required", 401),
  forbidden: () => err("Not allowed", 403),
  notFound: () => err("Not found", 404),
  rateLimited: () => err("Too many requests. Please slow down.", 429),
  payloadTooLarge: () => err("Request body too large", 413, "payload_too_large"),
  server: () => err("Something went wrong", 500),
} as const;

// ---------- Request context (request IDs + structured logging) ----------

/**
 * Valid incoming x-request-id header: 8–64 chars of [A-Za-z0-9_-]. Anything
 * else is replaced with a fresh UUID so clients cannot pollute log fields.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

interface RequestContext {
  requestId: string;
  method: string;
  path: string;
}

const requestStorage = new AsyncLocalStorage<RequestContext>();

/**
 * The current request's ID (or null outside a request handled through
 * `handler()`). Use it to correlate log lines across helper modules without
 * threading a logger through every call.
 */
export function getRequestId(): string | null {
  return requestStorage.getStore()?.requestId ?? null;
}

/** Thrown by parseBodySized when the payload exceeds the byte budget; mapped to 413 by handler(). */
export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Validate a JSON body with zod, enforcing a byte budget. Returns either
 * `{ data }` or `{ response }` — always `if (r.response) return r.response;`
 * before using data. Throws PayloadTooLargeError (→ 413 via handler) when the
 * raw body exceeds `maxBytes`; the Content-Length header short-circuits before
 * the body is even read when it is already over budget.
 */
export async function parseBodySized<S extends ZodType>(
  req: NextRequest,
  schema: S,
  maxBytes = 256_000
): Promise<{ data: import("zod").output<S>; response?: undefined } | { data?: undefined; response: NextResponse }> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new PayloadTooLargeError(`Request body exceeds the ${maxBytes}-byte limit`);
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { response: err("Invalid JSON body", 400) };
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new PayloadTooLargeError(`Request body exceeds the ${maxBytes}-byte limit`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { response: err("Invalid JSON body", 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
    return { response: err(`Invalid input — ${where}${first?.message ?? "validation failed"}`, 400) };
  }
  return { data: parsed.data };
}

/**
 * Validate a JSON body with zod (1 MB byte budget). Signature preserved —
 * existing call sites keep working; oversized payloads now surface as a typed
 * 413 instead of being parsed unbounded.
 */
export async function parseBody<S extends ZodType>(
  req: NextRequest,
  schema: S
): Promise<{ data: import("zod").output<S>; response?: undefined } | { data?: undefined; response: NextResponse }> {
  return parseBodySized(req, schema, 1_000_000);
}

// ---------- Rate limiting (legacy sync, per-instance) ----------

export function getClientKey(req: NextRequest): string {
  // The LEFTMOST X-Forwarded-For entry is client-controlled — an attacker
  // rotates it per request to get a fresh rate-limit bucket. Key on the
  // RIGHTMOST entry instead: the last value appended by our own trusted
  // edge (Caddy), which the client cannot spoof without breaking their own
  // connection through the proxy.
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return "local";
}

/**
 * LEGACY per-instance limiter (kept synchronous so all existing call sites
 * keep working). Same fixed-window semantics as before, now backed by the
 * shared MemoryRateLimitBackend implementation in lib/rate-limit-backend.ts.
 *
 * For abuse-sensitive endpoints (auth, media upload, AI POSTs, studio
 * messages, generators) prefer `rateLimitShared()` — it consults the
 * configured backend (RATE_LIMIT_BACKEND) so limits hold across instances.
 * Returns true when allowed.
 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  return memoryBackend.hitSync(key, limit, windowMs).allowed;
}

/**
 * Shared-backend limiter for abuse-sensitive routes. Returns a ready-to-return
 * 429 response (with Retry-After) when blocked, or null when allowed:
 *   const limited = await rateLimitShared("login:" + getClientKey(req), 10, 60_000);
 *   if (limited) return limited;
 * Uses the backend selected by RATE_LIMIT_BACKEND (memory | postgres); a
 * backend outage degrades to the in-memory limiter without failing the request.
 */
export async function rateLimitShared(key: string, limit: number, windowMs: number): Promise<NextResponse | null> {
  const result = await hitRateLimit(key, limit, windowMs);
  if (result.allowed) return null;
  const res = ERR.rateLimited();
  res.headers.set("Retry-After", String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))));
  return res;
}

// ---------- Viewer identity for insights (dedup) ----------

const VIEWER_COOKIE = "bean_vk";

/**
 * Resolve a stable viewer key for view deduplication.
 * Callers pass the signed-in userId when available; otherwise an anonymous
 * cookie is read/created on the response.
 */
export function resolveViewerKey(req: NextRequest, res: NextResponse, userId?: string | null): string {
  if (userId) return `u:${userId}`;
  const existing = req.cookies.get(VIEWER_COOKIE)?.value;
  if (existing) return `a:${existing}`;
  const fresh = crypto.randomUUID();
  res.cookies.set(VIEWER_COOKIE, fresh, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return `a:${fresh}`;
}

/** Current UTC day as YYYY-MM-DD (used for view dedup + insight series). */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// ---------- Engine-aware case-insensitive matching ----------

/**
 * PostgreSQL's LIKE is case-sensitive while SQLite's is ASCII-case-insensitive.
 * Prisma's `mode: "insensitive"` (→ ILIKE) restores parity on PostgreSQL but is
 * REJECTED by the SQLite connector at runtime, so it is attached only when the
 * app actually runs against PostgreSQL. Keeps search behavior identical across
 * the engine swap (docs/database.md §6).
 */
export const IS_POSTGRES = (process.env.DATABASE_URL ?? "").startsWith("postgres");

export function containsCI(value: string): { contains: string; mode?: "insensitive" } {
  return IS_POSTGRES ? { contains: value, mode: "insensitive" } : { contains: value };
}

// ---------- Standard route-handler wrapper ----------

/**
 * Standard try/catch wrapper for route handlers. Every wrapped handler gets:
 *  - a request ID: honored from an `x-request-id` request header when it is
 *    well-formed, else a fresh UUID — attached as `x-request-id` to EVERY
 *    response (success and error) and available via getRequestId();
 *  - a single-line structured JSON error log (`event: "api.error"`) with
 *    request metadata and duration; a `stack` field is included only when
 *    NODE_ENV !== "production" (never in production logs);
 *  - PayloadTooLargeError mapped to a typed 413 response.
 */
export function handler<A extends unknown[]>(
  fn: (...args: A) => Promise<NextResponse>
): (...args: A) => Promise<NextResponse> {
  return async (...args: A) => {
    // Duck-typed instead of `instanceof NextRequest`: the request object Next
    // hands to route handlers can come from a different module graph than the
    // app's "next/server" import, which makes instanceof unreliable.
    const maybeReq = args[0] as NextRequest | undefined;
    const req =
      maybeReq && typeof maybeReq === "object" && typeof maybeReq.url === "string" && "headers" in maybeReq
        ? maybeReq
        : null;
    const start = Date.now();
    const incoming = req?.headers.get("x-request-id") ?? null;
    const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
    const method = req?.method ?? "-";
    const path = req ? new URL(req.url).pathname : "-";
    return requestStorage.run({ requestId, method, path }, async () => {
      try {
        const res = await fn(...args);
        res.headers.set("x-request-id", requestId);
        return res;
      } catch (e) {
        const tooLarge = e instanceof PayloadTooLargeError;
        const status = tooLarge ? 413 : 500;
        const error =
          e instanceof Error
            ? { name: e.name, message: e.message }
            : { name: "Error", message: String(e) };
        const durationMs = Date.now() - start;
        if (status === 500) {
          // Structured log + optional ERROR_WEBHOOK_URL alert (reportError
          // emits the single JSON line itself). Metadata only — never bodies.
          reportError("api.error", {
            requestId,
            method,
            path,
            status,
            durationMs,
            error,
            // Stacks stay dev-only (same policy as before the webhook wiring).
            ...(process.env.NODE_ENV !== "production" && e instanceof Error && e.stack ? { stack: e.stack } : {}),
          });
        } else {
          // Client errors (413) are not alarms — structured line only.
          console.error(
            JSON.stringify({ event: "api.error", requestId, method, path, status, durationMs, error })
          );
        }
        const res = tooLarge ? ERR.payloadTooLarge() : ERR.server();
        res.headers.set("x-request-id", requestId);
        return res;
      }
    });
  };
}

/**
 * Same-origin guard for state-changing endpoints (CSRF defense-in-depth on
 * top of SameSite cookies — M22 Phase 2). Browsers attach `Origin` to every
 * POST: a cross-host Origin is refused; a same-host Origin, a missing Origin
 * (non-browser API clients) and embed-marked partner requests pass. Compares
 * against the forwarded host so TLS-terminating proxies work unchanged.
 */
export function sameOriginOk(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser client — session/cookie policy governs
  if (req.headers.get("x-bean-embed") === "1") return true; // embedded partner client
  try {
    const expected = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
    return new URL(origin).host === expected;
  } catch {
    return false; // malformed Origin can never be trusted
  }
}

/** Simple username validation shared across endpoints. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;
