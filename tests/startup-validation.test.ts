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

describe("startup validation — S3 storage configuration", () => {
  test("no S3 vars and no driver override: soft warning (local disk is legitimate for single-node hosts)", () => {
    const result = validateStartupEnvironment({ env: envWith({}), cache: false });
    const check = result.checks.find((c) => c.name === "storage_s3_config");
    expect(check?.status).toBe("warn");
    expect(result.ok).toBe(true);
  });

  test("explicit MEDIA_STORAGE_DRIVER=local is honored as an opt-out", () => {
    const result = validateStartupEnvironment({ env: envWith({ MEDIA_STORAGE_DRIVER: "local", S3_ENDPOINT: "https://s3.example" }), cache: false });
    const check = result.checks.find((c) => c.name === "storage_s3_config");
    expect(check?.status).toBe("ok");
    expect(result.ok).toBe(true);
  });

  test("partial S3 configuration in PRODUCTION fails fast (silent local fallback = data loss)", () => {
    const partial = { S3_ENDPOINT: "https://s3.example", S3_BUCKET: "bean-media" }; // missing the two key vars
    expect(() => validateStartupEnvironment({ env: envWith({ NODE_ENV: "production", ...partial }), cache: false })).toThrow(StartupValidationError);
    try {
      validateStartupEnvironment({ env: envWith({ NODE_ENV: "production", ...partial }), cache: false });
    } catch (e) {
      const err = e as StartupValidationError;
      const check = err.result.checks.find((c) => c.name === "storage_s3_config");
      expect(check?.status).toBe("fail");
      expect(check?.detail).toContain("missing");
      // Names may be logged; VALUES never are.
      expect(check?.detail).not.toContain("https://s3.example");
      expect(check?.detail).toContain("S3_ENDPOINT");
    }
  });

  test("partial S3 configuration outside production is only a warning", () => {
    const result = validateStartupEnvironment({ env: envWith({ S3_ENDPOINT: "https://s3.example" }), cache: false });
    const check = result.checks.find((c) => c.name === "storage_s3_config");
    expect(check?.status).toBe("warn");
    expect(result.ok).toBe(true);
  });

  test("complete S3 configuration passes", () => {
    const result = validateStartupEnvironment({
      env: envWith({ S3_ENDPOINT: "https://s3.example", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" }),
      cache: false,
    });
    const check = result.checks.find((c) => c.name === "storage_s3_config");
    expect(check?.status).toBe("ok");
  });
});

describe("startup validation — session cookie policy", () => {
  test("unset: Secure-by-default (ok)", () => {
    const result = validateStartupEnvironment({ env: envWith({}), cache: false });
    expect(result.checks.find((c) => c.name === "session_cookie_policy")?.status).toBe("ok");
  });

  test("SESSION_SECURE_COOKIES=false in production without the escape hatch FAILS", () => {
    expect(() =>
      validateStartupEnvironment({ env: envWith({ NODE_ENV: "production", SESSION_SECURE_COOKIES: "false" }), cache: false })
    ).toThrow(StartupValidationError);
  });

  test("SESSION_SECURE_COOKIES=false in production WITH BEAN_ALLOW_INSECURE_COOKIES=true is a warning, not a failure", () => {
    const result = validateStartupEnvironment({
      env: envWith({ NODE_ENV: "production", SESSION_SECURE_COOKIES: "false", BEAN_ALLOW_INSECURE_COOKIES: "true" }),
      cache: false,
    });
    const check = result.checks.find((c) => c.name === "session_cookie_policy");
    expect(check?.status).toBe("warn");
    expect(result.ok).toBe(true);
  });

  test("SESSION_SECURE_COOKIES=false outside production is honored (dev convenience)", () => {
    const result = validateStartupEnvironment({ env: envWith({ SESSION_SECURE_COOKIES: "false" }), cache: false });
    expect(result.checks.find((c) => c.name === "session_cookie_policy")?.status).toBe("ok");
  });

  test("unknown SESSION_SECURE_COOKIES value fails (boolean flag, not free text)", () => {
    expect(() => validateStartupEnvironment({ env: envWith({ SESSION_SECURE_COOKIES: "yes-please" }), cache: false })).toThrow(StartupValidationError);
  });
});

describe("startup validation — known-variable values", () => {
  test("recognized values pass", () => {
    const result = validateStartupEnvironment({
      env: envWith({ RATE_LIMIT_BACKEND: "postgres", CACHE_BACKEND: "memory", MEDIA_STORAGE_DRIVER: "s3", QUEUE_ENABLED: "false", LOG_LEVEL: "warn" }),
      cache: false,
    });
    expect(result.checks.find((c) => c.name === "known_variable_values")?.status).toBe("ok");
    expect(result.ok).toBe(true);
  });

  test("unknown backend value fails fast (typo would otherwise silently fall back)", () => {
    expect(() => validateStartupEnvironment({ env: envWith({ RATE_LIMIT_BACKEND: "redis" }), cache: false })).toThrow(StartupValidationError);
    try {
      validateStartupEnvironment({ env: envWith({ RATE_LIMIT_BACKEND: "redis" }), cache: false });
    } catch (e) {
      const err = e as StartupValidationError;
      const check = err.result.checks.find((c) => c.name === "known_variable_values");
      expect(check?.status).toBe("fail");
      expect(check?.detail).toContain("RATE_LIMIT_BACKEND");
    }
  });

  test("unset variables keep their runtime defaults and pass", () => {
    const result = validateStartupEnvironment({ env: envWith({}), cache: false });
    expect(result.checks.find((c) => c.name === "known_variable_values")?.status).toBe("ok");
  });
});
