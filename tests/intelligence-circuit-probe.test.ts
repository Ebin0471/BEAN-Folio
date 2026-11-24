/**
 * Circuit breaker — half-open probe failure regression (GZ-SCALE M2/A1).
 *
 * Reproduces the production deadlock: after a failed half-open probe,
 * `probeInFlight` was never released (recordProviderFailure only cleared it
 * when it OPENED the circuit, which requires openedAt === null — impossible
 * in half-open). One failed probe therefore bricked the provider forever on
 * that instance: allowProvider() returned false indefinitely, no request
 * could ever be admitted to produce the success that would close the
 * circuit, and the registry's single text provider made ALL text/vision AI
 * fail until process restart.
 *
 * Documented contract (circuit.ts header): "success closes the circuit,
 * failure re-opens it" — this suite pins the failure half.
 *
 * Run: bun test tests/intelligence-circuit-probe.test.ts
 */

import { describe, expect, test, afterEach } from "bun:test";

import {
  CIRCUIT_COOLDOWN_MS,
  CIRCUIT_FAILURE_THRESHOLD,
  allowProvider,
  providerHealthSnapshot,
  recordProviderFailure,
  recordProviderSuccess,
  resetCircuit,
} from "@/lib/intelligence/circuit";

/** Internal state hook — the only way to simulate cooldown elapse without
 *  waiting 30s of real time (same state the module itself keeps on globalThis). */
function rewindOpenAt(providerId: string): void {
  const map = (globalThis as unknown as {
    __beanCircuitBreakers?: Map<string, { openedAt: number | null; probeInFlight: boolean }>;
  }).__beanCircuitBreakers;
  const state = map?.get(providerId);
  if (!state) throw new Error(`no breaker state for ${providerId}`);
  state.openedAt = Date.now() - CIRCUIT_COOLDOWN_MS - 1;
}

const used: string[] = [];
function uniqueProvider(prefix: string): string {
  const id = `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  used.push(id);
  return id;
}

afterEach(() => {
  for (const id of used) resetCircuit(id);
});

describe("half-open probe failure", () => {
  test("a failed probe RE-OPENS the circuit instead of deadlocking it", () => {
    const id = uniqueProvider("probe");
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      recordProviderFailure(id, "timeout", true);
    }
    expect(allowProvider(id)).toBe(false); // OPEN
    rewindOpenAt(id); // cooldown elapsed → HALF-OPEN

    // Exactly one probe admitted.
    expect(allowProvider(id)).toBe(true);
    expect(allowProvider(id)).toBe(false); // probe slot occupied

    // The probe FAILS transiently.
    recordProviderFailure(id, "upstream timeout", true);

    // Circuit is re-opened (fresh cooldown) — not permanently wedged.
    const health = providerHealthSnapshot()[id];
    expect(health.status).toBe("open");
    expect(allowProvider(id)).toBe(false);
  });

  test("after the re-open cooldown a NEW probe is admitted (the old slot is released)", () => {
    const id = uniqueProvider("probe");
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      recordProviderFailure(id, "timeout", true);
    }
    rewindOpenAt(id);
    expect(allowProvider(id)).toBe(true); // probe 1
    recordProviderFailure(id, "upstream timeout", true); // probe 1 fails

    // THE REGRESSION: before the fix, probeInFlight stayed true forever and
    // this admission — after another elapsed cooldown — never happened.
    rewindOpenAt(id);
    expect(allowProvider(id)).toBe(true); // probe 2 admitted

    // A successful probe closes the circuit for real.
    recordProviderSuccess(id);
    expect(allowProvider(id)).toBe(true);
    expect(providerHealthSnapshot()[id].status).toBe("closed");
  });

  test("failed probes still count toward the failure threshold on a CLOSED circuit", () => {
    const id = uniqueProvider("probe");
    // Closed circuit: threshold consecutive transient failures must open it
    // (unchanged behavior — the fix only touched the half-open path).
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      recordProviderFailure(id, "timeout", true);
    }
    expect(providerHealthSnapshot()[id].status).toBe("open");
    expect(allowProvider(id)).toBe(false);
  });
});
