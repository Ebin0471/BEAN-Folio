/// <reference types="bun-types" />
/**
 * Startup environment validation tests (see src/lib/startup-validation.ts).
 *
 * Contract under test:
 *
 *  1. Happy path: a valid SQLite environment validates with `ok: true` and
 *     never leaks environment VALUES into check details.
 *  2. Fail-fast: missing DATABASE_URL, empty DATABASE_URL, wrong-provider
 *     DATABASE_URL and control-character-injected variables all throw
 *     `StartupValidationError` with an actionable, value-free message.
 *  3. Safety: no check detail (success or failure) ever contains the
 *     DATABASE_URL value itself — not even on the success path.
 *  4. Idempotence: the first call caches; `/api/ready`-style consumers read
 *     the same snapshot without re-execution; `resetStartupValidationCache`
 *     isolates tests.
 *
 * Run: bun test tests/startup-validation.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  getStartupValidationSnapshot,
  resetStartupValidationCache,
  StartupValidationError,
  validateStartupEnvironment,
} from "@/lib/startup-validation";

const SECRET_URL = "file:./db/custom.db";

function envWith(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { DATABASE_URL: SECRET_URL, NODE_ENV: "test", ...overrides };
}

beforeEach(() => {
  resetStartupValidationCache();
});

describe("startup validation — happy path", () => {
  test("valid SQLite environment passes and reports the datasource shape without leaking values", () => {
    const result = validateStartupEnvironment({ env: envWith({}), cache: false });

    expect(result.ok).toBe(true);
    const dbCheck = result.checks.find((c) => c.name === "database_url");
    expect(dbCheck?.status).toBe("ok");
    expect(dbCheck?.detail).toContain("SQLite");
    // Value-free logging contract: the secret URL must never appear in details.
    expect(dbCheck?.detail).not.toContain(SECRET_URL);
    for (const check of result.checks) {
      expect(check.detail).not.toContain(SECRET_URL);
    }
  });

  test("unset NODE_ENV is a warning, not a failure", () => {
    const result = validateStartupEnvironment({
      env: { DATABASE_URL: SECRET_URL },
      cache: false,
    });

    expect(result.ok).toBe(true);
    expect(result.env).toBe("unknown");
    const nodeCheck = result.checks.find((c) => c.name === "node_env");
    expect(nodeCheck?.status).toBe("warn");
  });

  test("postgresql datasource shape is accepted", () => {
    const result = validateStartupEnvironment({
      env: { DATABASE_URL: "postgres://user:pass@db.internal:5432/bean" },
      cache: false,
    });

    expect(result.ok).toBe(true);
    const dbCheck = result.checks.find((c) => c.name === "database_url");
    expect(dbCheck?.detail).toContain("PostgreSQL");
    // The postgres URL embeds credentials — must never be echoed.
    expect(dbCheck?.detail).not.toContain("user:pass");
  });
});

describe("startup validation — fail-fast", () => {
  test("missing DATABASE_URL throws with actionable detail", () => {
    expect(() => validateStartupEnvironment({ env: {}, cache: false })).toThrow(StartupValidationError);

    try {
      validateStartupEnvironment({ env: {}, cache: false });
    } catch (e) {
      expect(e).toBeInstanceOf(StartupValidationError);
      const err = e as StartupValidationError;
      expect(err.result.ok).toBe(false);
      expect(err.message).toContain("DATABASE_URL");
      expect(err.message).toContain("file:./db/custom.db"); // the remediation hint, not a secret
    }
  });

  test("empty DATABASE_URL throws", () => {
    expect(() => validateStartupEnvironment({ env: { DATABASE_URL: "   " }, cache: false })).toThrow(
      StartupValidationError
    );
  });

  test("wrong-provider DATABASE_URL throws (schema only supports sqlite/postgres)", () => {
    expect(() => validateStartupEnvironment({ env: { DATABASE_URL: "mysql://localhost/bean" }, cache: false })).toThrow(
      StartupValidationError
    );
  });

  test("control characters in DATABASE_URL throw (environment-injection hardening)", () => {
    expect(() =>
      validateStartupEnvironment({ env: { DATABASE_URL: `file:./db/ok.db\nEVIL=1` }, cache: false })
    ).toThrow(StartupValidationError);
  });

  test("control characters in ANY variable fail the sweep, named but never valued", () => {
    try {
      validateStartupEnvironment({
        env: envWith({ SUSPICIOUS_TOKEN: "abc\u0000def" }),
        cache: false,
      });
      throw new Error("expected validation to fail");
    } catch (e) {
      expect(e).toBeInstanceOf(StartupValidationError);
      const err = e as StartupValidationError;
      const sweep = err.result.checks.find((c) => c.name === "env_injection_sweep");
      expect(sweep?.status).toBe("fail");
      expect(sweep?.detail).toContain("SUSPICIOUS_TOKEN");
      expect(sweep?.detail).not.toContain("abc");
    }
  });
});

describe("startup validation — idempotence & snapshot", () => {
  test("cached run is returned as-is and does not re-execute", () => {
    const first = validateStartupEnvironment({ env: envWith({}) }); // cache: true (default)
    const snapshotBefore = getStartupValidationSnapshot();
    const second = validateStartupEnvironment({ env: envWith({ NODE_ENV: "production" }) }); // ignored

    expect(second).toBe(first);
    expect(getStartupValidationSnapshot()).toBe(snapshotBefore);
    expect(second.env).toBe("test"); // first run's env, not the re-run's
  });

  test("resetStartupValidationCache clears the snapshot between runs", () => {
    validateStartupEnvironment({ env: envWith({}) });
    expect(getStartupValidationSnapshot()).not.toBeNull();
    resetStartupValidationCache();
    expect(getStartupValidationSnapshot()).toBeNull();
  });

  test("failed runs are also cached so probes see the same truth", () => {
    try {
      validateStartupEnvironment({ env: {} }); // caches failure
    } catch {
      // expected
    }
    const snapshot = getStartupValidationSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.ok).toBe(false);
    expect(snapshot?.checks.some((c) => c.status === "fail")).toBe(true);
  });
});
