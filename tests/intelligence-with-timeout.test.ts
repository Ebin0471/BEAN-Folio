/**
 * Gateway deadline helper — timer-hygiene regression (GZ-SCALE M2/A6).
 *
 * The gateway previously built `Promise.race([sdkCall, setTimeout(...)])`
 * inline and NEVER cleared the losing timer: every AI call held a pending
 * timer for the full timeout window (60s default / 120s deep), so a burst of
 * calls kept hundreds of live timers on the event loop — delaying graceful
 * shutdown and rejecting already-settled promises.
 *
 * withTimeout() must clear its timer on BOTH settle paths.
 *
 * Run: bun test tests/intelligence-with-timeout.test.ts
 */

import { describe, expect, test, spyOn, afterEach } from "bun:test";

import { withTimeout } from "@/lib/intelligence/with-timeout";

const clearSpy = spyOn(globalThis, "clearTimeout");

afterEach(() => {
  clearSpy.mockClear();
});

describe("withTimeout timer hygiene", () => {
  test("clears the deadline timer when the wrapped promise wins", async () => {
    const out = await withTimeout(Promise.resolve("ok"), 5_000);
    expect(out).toBe("ok");
    expect(clearSpy).toHaveBeenCalled();
  });

  test("rejects at the deadline when the wrapped promise never settles", async () => {
    const never = new Promise<string>(() => undefined);
    const error = await withTimeout(never, 25).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("timeout");
  });

  test("a loser rejection AFTER the timeout wins does not crash the process", async () => {
    // The SDK call losing the race rejects later — withTimeout must swallow
    // that late rejection (the caller already moved on) instead of surfacing
    // an unhandled rejection.
    const lateLoser = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late loser")), 40));
    const result = await withTimeout(lateLoser, 10).then(
      () => "resolved",
      (e: unknown) => `rejected: ${(e as Error).message}`
    );
    expect(result).toBe("rejected: timeout");
    await Bun.sleep(80); // late rejection fires here — swallowed by withTimeout
  });
});
