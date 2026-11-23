/**
 * BEAN Intelligence gateway — bounded await helper.
 *
 * Wraps a promise in a deadline race that ALWAYS clears its timer when the
 * race settles. The previous inline `Promise.race([sdk, setTimeout(...)])`
 * pattern left the losing timer alive for the full timeout window on every
 * call — a burst of AI calls kept hundreds of pending timers on the event
 * loop, delaying graceful shutdown by up to the timeout and rejecting
 * already-settled promises.
 *
 * Note: the loser of the race is not aborted (the provider SDK calls here do
 * not expose an AbortSignal surface); clearing the timer only removes the
 * event-loop hold. Provider-side cost containment is handled by the circuit
 * breaker + retry policy.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raced = Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    }),
  ]);
  // finally (not then/catch duplication): clears the timer on BOTH the
  // success and the timeout path. If the underlying promise later rejects
  // after the timeout already won, that rejection is swallowed here — the
  // caller has already moved on and the SDK request was never awaited.
  return raced.finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}
