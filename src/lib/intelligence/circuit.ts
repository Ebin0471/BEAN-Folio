/**
 * BEAN Intelligence gateway — provider health: circuit breaker + retry policy.
 *
 * Circuit breaker (per provider id, per server instance):
 *  - CLOSED  (healthy): requests flow. Consecutive failures are counted.
 *  - OPEN    (threshold reached): requests are refused instantly with an
 *    honest "provider temporarily unavailable" error — never silently
 *    re-routed to a different task contract.
 *  - HALF-OPEN (cooldown elapsed): ONE probe request may pass; success closes
 *    the circuit, failure re-opens it.
 *
 * The breaker counts only TRANSIENT failures (timeouts, network errors,
 * provider outages, rate limits). Safety rejections, auth failures, capability
 * refusals and invalid outputs are content/configuration problems — they must
 * never trip the circuit.
 *
 * State lives on globalThis so Next.js dev-mode module reloads keep counts.
 */

import { logGatewayEvent } from "./observability";

export const CIRCUIT_FAILURE_THRESHOLD = 4;
export const CIRCUIT_COOLDOWN_MS = 30_000;

export type CircuitStatus = "closed" | "open" | "half-open";

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
  probeInFlight: boolean;
  lastError?: string;
}

const globalForCircuit = globalThis as unknown as {
  __beanCircuitBreakers?: Map<string, BreakerState>;
};

function breakers(): Map<string, BreakerState> {
  if (!globalForCircuit.__beanCircuitBreakers) {
    globalForCircuit.__beanCircuitBreakers = new Map();
  }
  return globalForCircuit.__beanCircuitBreakers;
}

function stateFor(providerId: string): BreakerState {
  const map = breakers();
  let state = map.get(providerId);
  if (!state) {
    state = { consecutiveFailures: 0, openedAt: null, probeInFlight: false };
    map.set(providerId, state);
  }
  return state;
}

/** Reasons that must NEVER count toward the circuit (content/config problems). */
const NON_TRANSIENT_REASONS = new Set(["safety", "auth", "invalid_output", "capability", "content_filter"]);

/**
 * Classify an unknown error for the retry policy + circuit breaker.
 * Transient = worth retrying (timeout / network / provider outage / 429).
 * Everything else (safe rejections, auth, invalid output, unknown shape that
 * carries an explicit non-transient reason) is final.
 */
export function isTransientProviderError(e: unknown): boolean {
  if (e instanceof Error) {
    const reason = (e as Error & { reason?: string }).reason;
    if (reason && NON_TRANSIENT_REASONS.has(reason)) return false;
    if (reason === "timeout" || reason === "provider" || reason === "rate_limit") return true;
    const msg = e.message.toLowerCase();
    if (msg.includes("timeout") || msg.includes("timed out")) return true;
    if (msg.includes("fetch failed") || msg.includes("network") || msg.includes("econnrefused")) return true;
    if (msg.includes("rate limit")) return true;
    if (msg.includes("unavailable") || msg.includes("empty response")) return true;
    // Non-transient classification for explicit marker errors thrown by tests.
    if (msg.startsWith("permanent:")) return false;
    return false;
  }
  return false;
}

/** True when a request to this provider may pass right now (closed or half-open probe slot). */
export function allowProvider(providerId: string): boolean {
  const s = stateFor(providerId);
  if (s.openedAt === null) return true; // CLOSED
  const elapsed = Date.now() - s.openedAt;
  if (elapsed < CIRCUIT_COOLDOWN_MS) return false; // OPEN
  // HALF-OPEN: allow exactly one probe at a time.
  if (s.probeInFlight) return false;
  s.probeInFlight = true;
  logGatewayEvent({
    event: "gateway.circuit",
    provider: providerId,
    outcome: "success",
    error: "half-open probe admitted",
  });
  return true;
}

export function recordProviderSuccess(providerId: string): void {
  const s = stateFor(providerId);
  const wasOpen = s.openedAt !== null;
  s.consecutiveFailures = 0;
  s.openedAt = null;
  s.probeInFlight = false;
  s.lastError = undefined;
  if (wasOpen) {
    logGatewayEvent({ event: "gateway.circuit", provider: providerId, outcome: "success", error: "circuit closed after successful probe" });
  }
}

export function recordProviderFailure(providerId: string, message: string, transient: boolean): void {
  if (!transient) return; // content/config failures never trip the breaker
  const s = stateFor(providerId);
  s.consecutiveFailures += 1;
  s.lastError = message.slice(0, 200);
  if (s.openedAt === null && s.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    s.openedAt = Date.now();
    s.probeInFlight = false;
    logGatewayEvent({ event: "gateway.circuit", provider: providerId, outcome: "failure", error: `circuit opened after ${s.consecutiveFailures} consecutive failures: ${s.lastError}` });
  }
}

/** Operator-facing health snapshot (ids + status only — no secrets). */
export function providerHealthSnapshot(): Record<string, { status: CircuitStatus; consecutiveFailures: number; lastError?: string }> {
  const out: Record<string, { status: CircuitStatus; consecutiveFailures: number; lastError?: string }> = {};
  for (const [id, s] of breakers()) {
    let status: CircuitStatus = "closed";
    if (s.openedAt !== null) {
      status = Date.now() - s.openedAt < CIRCUIT_COOLDOWN_MS ? "open" : "half-open";
    }
    out[id] = {
      status,
      consecutiveFailures: s.consecutiveFailures,
      ...(s.lastError ? { lastError: s.lastError } : {}),
    };
  }
  return out;
}

/** Test-only: reset one provider's circuit. */
export function resetCircuit(providerId: string): void {
  breakers().delete(providerId);
}

export interface RetryOptions {
  label: string;
  providerId: string;
  /** Total attempts (1 = no retry). Default 2 (one retry), max 3. */
  attempts?: number;
  /** Backoff between attempts in ms. Default [1500, 4000] (matches LAXII retry policy). */
  backoffMs?: number[];
}

/**
 * Run `fn` with the gateway retry policy: only transient failures are retried,
 * each attempt is reported to the circuit breaker, and backoff is bounded.
 * The final thrown error is the last attempt's error.
 */
export async function withIntelligenceRetries<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = Math.min(Math.max(opts.attempts ?? 2, 1), 3);
  const backoff = opts.backoffMs ?? [1500, 4000];
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fn();
      recordProviderSuccess(opts.providerId);
      return result;
    } catch (e) {
      lastError = e;
      const transient = isTransientProviderError(e);
      recordProviderFailure(opts.providerId, e instanceof Error ? e.message : String(e), transient);
      if (!transient || attempt >= attempts) throw e;
      logGatewayEvent({
        event: "gateway.retry",
        provider: opts.providerId,
        outcome: "failure",
        attempt,
        error: `${opts.label}: ${e instanceof Error ? e.message : String(e)}`,
      });
      await new Promise((resolve) => setTimeout(resolve, backoff[Math.min(attempt - 1, backoff.length - 1)]));
    }
  }
  throw lastError;
}
