/**
 * LAXII — bounded retry with backoff for TRANSIENT provider failures only.
 *
 * Honest-failure rule: a retry may never turn a real failure into a fake
 * success — only `rate_limit` and transient `provider` (network/5xx) errors
 * are retried, at most twice, with exponential backoff. Auth errors, safety
 * blocks, capability refusals, invalid outputs and timeouts fail fast (a
 * timeout retry would double an already multi-minute render).
 */

import { LaxiiProviderError } from "./types";

const RETRIABLE: ReadonlySet<string> = new Set(["rate_limit", "provider"]);
const BACKOFF_MS = [1_500, 4_000];

export async function withProviderRetries<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; label?: string } = {}
): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 2);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const retriable = e instanceof LaxiiProviderError && RETRIABLE.has(e.reason);
      if (!retriable || attempt === retries) throw e;
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      console.warn(
        `[laxii] transient ${e.reason} on ${opts.label ?? "provider call"} (attempt ${attempt + 1}) — retrying in ${wait}ms`
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}
