/**
 * Owner-dispatch mock record builder — the SAFE way to mock a module that
 * other test files in the same bun process also import.
 *
 * WHY THIS EXISTS: bun's mock.module() freezes the factory result's property
 * VALUES into the module record at registration time; a value re-read (and
 * an afterAll re-registration) cannot reliably undo that freeze. A naive
 * wholesale mock therefore leaks its fakes to every file that loads later,
 * and restoring in afterAll does not help.
 *
 * THE FIX: freeze values that are themselves dispatchers.
 *  - Plain functions are wrapped in an ordinary wrapper function that checks
 *    an owner-supplied `armed()` predicate AT CALL TIME: armed → the owner's
 *    fake; disarmed → the real implementation. (No Proxy — proxying every
 *    function export trips a Bun runtime crash.)
 *  - Class exports (used with `instanceof` and `new`) get a Proxy over a
 *    fresh arrow-function target, so the prototype read itself dispatches
 *    and non-configurable own properties of the real class never constrain
 *    the traps.
 *  - Everything else (constants, non-function values, exports the fake does
 *    not provide) freezes to the REAL value.
 *
 * The owner file flips its flag in its own beforeAll/afterAll. Non-owner
 * files — regardless of load order — always execute the real implementation.
 */
export function ownerDispatchRecord(
  armed: () => boolean,
  real: object,
  fake: Record<string, unknown>
): Record<string, unknown> {
  const realRecord = real as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = new Set<string>(Object.keys(fake));
  for (const k of keys) {
    const r = realRecord[k];
    const f = fake[k];
    if (typeof f === "function") {
      const realFn = r as ((...a: unknown[]) => unknown) | undefined;
      const fakeFn = f as (...a: unknown[]) => unknown;
      const isClass = typeof fakeFn.prototype?.constructor === "function" && fakeFn.prototype === (fakeFn.prototype?.constructor?.prototype ?? null);
      if (isClass) {
        // Class export: `new` + `instanceof` must dispatch. Proxy over a
        // fresh arrow target (no non-configurable own properties — a real
        // class target would forbid returning a different `prototype`).
        const target = ((..._args: unknown[]) => undefined) as object;
        out[k] = new Proxy(target, {
          construct: (_t, args) =>
            armed()
              ? Reflect.construct(fakeFn as never, args)
              : Reflect.construct((realFn ?? fakeFn) as never, args),
          get: (_t, prop) => {
            if (armed()) {
              const fv = (f as unknown as Record<string | symbol, unknown>)[prop];
              if (fv !== undefined) return fv;
            }
            return (r as Record<string | symbol, unknown>)[prop];
          },
          apply: (_t, thisArg, args) =>
            armed() && realFn
              ? fakeFn.apply(thisArg, args)
              : realFn
                ? realFn.apply(thisArg, args)
                : fakeFn.apply(thisArg, args),
        });
      } else {
        // Plain function: an ordinary wrapper dispatches at call time.
        out[k] = function (this: unknown, ...args: unknown[]) {
          if (armed() && typeof f === "function") return fakeFn.apply(this, args);
          if (typeof realFn === "function") return realFn.apply(this, args);
          return fakeFn.apply(this, args);
        };
      }
    } else {
      // Constants / non-function values / exports the fake does not provide:
      // frozen at registration → the real value (fake-only keys → fake value).
      out[k] = r !== undefined ? r : f;
    }
  }
  return out;
}
