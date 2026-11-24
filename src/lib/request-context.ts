/**
 * BEAN Folio — request context (AsyncLocalStorage).
 *
 * Owns the per-request correlation context so ANY module can annotate its
 * output with the current request ID without threading a logger through
 * every call and without import cycles (this module imports nothing from
 * the app).
 *
 * Previously the ALS lived inside api-helpers; the logger could not consume
 * it (cycle), so request IDs appeared only on `api.error` lines and response
 * headers. Moving it here lets `logger.emit` attach `requestId` to every
 * structured line emitted while a request is in flight.
 */

import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  requestId: string;
  method: string;
  path: string;
}

const requestStorage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the given request context bound (handler() wrapper entry). */
export function runWithRequestContext<T>(context: RequestContext, fn: () => Promise<T>): Promise<T> {
  return requestStorage.run(context, fn);
}

/** Full context, or null outside a request handled through `handler()`. */
export function getRequestContext(): RequestContext | null {
  return requestStorage.getStore() ?? null;
}

/**
 * The current request's ID (or null outside a request). Use it to correlate
 * log lines across helper modules — background jobs and startup lines carry
 * no request ID by design.
 */
export function getRequestId(): string | null {
  return requestStorage.getStore()?.requestId ?? null;
}
