/**
 * BEAN Folio — startup environment validation (fail-fast).
 *
 * Runs once at server startup via `src/instrumentation.ts` and is re-read
 * (cached snapshot, never re-executed) by the readiness probe at
 * `/api/ready`. Its contract:
 *
 *  1. Fail-fast: if a required setting is missing or malformed the process
 *     must NOT boot into a half-working state. `validateStartupEnvironment`
 *     throws `StartupValidationError` and instrumentation exits(1).
 *  2. Safety: log output must never contain secret VALUES — only key names
 *     and presence. Values with newlines/control characters are rejected
 *     outright (environment-injection hardening).
 *  3. No heavy imports: this module is intentionally dependency-free
 *     (node builtins only) so it cannot create import cycles with
 *     `@/lib/db`, auth, or any route code. Real database reachability is
 *     verified separately by the `/api/ready` probe, which owns the
 *     Prisma client.
 *  4. Idempotent: the first call caches the result; later callers (the
 *     probe, tests) read the snapshot without re-running checks.
 */

export type StartupCheckStatus = "ok" | "warn" | "fail";

export interface StartupCheckResult {
  name: string;
  status: StartupCheckStatus;
  /** Human-readable detail. MUST NOT include secret values. */
  detail: string;
}

export interface StartupValidationResult {
  ok: boolean;
  checks: StartupCheckResult[];
  env: "production" | "development" | "test" | "unknown";
  durationMs: number;
}

export class StartupValidationError extends Error {
  readonly result: StartupValidationResult;

  constructor(message: string, result: StartupValidationResult) {
    super(message);
    this.name = "StartupValidationError";
    this.result = result;
  }
}

export type StartupValidationOptions = {
  /**
   * Environment map to validate. Defaults to `process.env`. Injectable so
   * tests can exercise failure paths without mutating the real process.
   */
  env?: Record<string, string | undefined>;
  /** Bypass (and skip writing) the module-level result cache. */
  cache?: boolean;
};

let cached: StartupValidationResult | null = null;

/** Cached result of the first validation run (null before it runs). */
export function getStartupValidationSnapshot(): StartupValidationResult | null {
  return cached;
}

/** Drop the cached snapshot. Only tests should need this. */
export function resetStartupValidationCache(): void {
  cached = null;
}

/** Values containing control characters would break logs/shell re-use. */
function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function resolveNodeEnv(env: Record<string, string | undefined>): StartupValidationResult["env"] {
  const raw = env.NODE_ENV;
  if (raw === "production" || raw === "development" || raw === "test") return raw;
  // Unset is legitimate (Next sets NODE_ENV itself in both dev and the
  // standalone server), so "unknown" is a soft state, not a failure.
  return "unknown";
}

/**
 * Validate the startup environment. Throws `StartupValidationError` when a
 * required check fails (fail-fast). Returns the full structured result on
 * success (including soft warnings).
 */
export function validateStartupEnvironment(options: StartupValidationOptions = {}): StartupValidationResult {
  const useCache = options.cache !== false;
  if (useCache && cached) return cached;

  const started = Date.now();
  const env = options.env ?? process.env;
  const checks: StartupCheckResult[] = [];
  const secrets = new Set<string>();

  // ---- Check 1: NODE_ENV sanity (soft) ----
  const nodeEnv = resolveNodeEnv(env);
  checks.push({
    name: "node_env",
    status: nodeEnv === "unknown" ? "warn" : "ok",
    detail:
      nodeEnv === "unknown"
        ? "NODE_ENV is not set; Next.js will infer it from the command (dev server / standalone build)"
        : `NODE_ENV=${nodeEnv}`,
  });

  // ---- Check 2: DATABASE_URL presence + shape (required) ----
  const dbUrl = env.DATABASE_URL;
  if (dbUrl === undefined || dbUrl.trim() === "") {
    checks.push({
      name: "database_url",
      status: "fail",
      detail: "DATABASE_URL is required (e.g. file:./db/custom.db). Set it in .env before starting the server.",
    });
  } else if (hasControlChars(dbUrl)) {
    checks.push({
      name: "database_url",
      status: "fail",
      detail: "DATABASE_URL contains control characters — refusing to start (possible environment tampering).",
    });
  } else {
    secrets.add("DATABASE_URL");
    const isFile = dbUrl.trim().startsWith("file:");
    const isPostgres = dbUrl.trim().startsWith("postgres");
    if (isFile || isPostgres) {
      checks.push({
        name: "database_url",
        status: "ok",
        // Never echo the URL: it may embed credentials for postgres.
        detail: isFile ? "SQLite datasource configured" : "PostgreSQL datasource configured",
      });
    } else {
      checks.push({
        name: "database_url",
        status: "fail",
        detail:
          "DATABASE_URL must start with 'file:' (SQLite) or 'postgres' — the Prisma schema only supports those providers.",
      });
    }
  }

  // ---- Check 3: any env value carrying control characters (safety sweep) ----
  // Broad but cheap: catches the "one poisoned variable" class of incidents
  // at boot instead of at first use. Names only, never values.
  const poisoned = Object.keys(env).filter((k) => {
    const v = env[k];
    return typeof v === "string" && v.length > 0 && hasControlChars(v);
  });
  checks.push({
    name: "env_injection_sweep",
    status: poisoned.length > 0 ? "fail" : "ok",
    detail:
      poisoned.length > 0
        ? `Environment variables with control characters: ${poisoned.sort().join(", ")}`
        : "No environment variable contains control characters",
  });

  // ---- Check 4: Google OAuth configuration (soft — the feature is optional) ----
  // Partial configuration is the dangerous case: someone added the client id
  // to the platform's env vars but forgot the secret (or a value is
  // blank/whitespace). The app degrades to "disabled" silently, so say it
  // out loud at boot. Names only — never values.
  const googleId = env.GOOGLE_CLIENT_ID?.trim() || undefined;
  const googleSecret = env.GOOGLE_CLIENT_SECRET?.trim() || undefined;
  if (googleId && googleSecret) {
    checks.push({ name: "google_oauth", status: "ok", detail: "Google OAuth credentials configured" });
  } else if (!googleId && !googleSecret) {
    checks.push({
      name: "google_oauth",
      status: "warn",
      detail:
        "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set — Continue with Google stays disabled (email + password sign-in is unaffected)",
    });
  } else {
    checks.push({
      name: "google_oauth",
      status: "warn",
      detail: `Google OAuth is HALF-configured: ${googleId ? "GOOGLE_CLIENT_ID" : "GOOGLE_CLIENT_SECRET"} is set but ${
        googleId ? "GOOGLE_CLIENT_SECRET" : "GOOGLE_CLIENT_ID"
      } is missing/blank — Google sign-in is disabled until BOTH are set`,
    });
  }

  // ---- Check 5: production hardening advisories (soft) ----
  if (nodeEnv === "production") {
    if (!env.NEXT_TELEMETRY_DISABLED) {
      checks.push({
        name: "telemetry_optout",
        status: "warn",
        detail: "NEXT_TELEMETRY_DISABLED is not set; Next.js telemetry may phone home in production",
      });
    } else {
      checks.push({ name: "telemetry_optout", status: "ok", detail: "Next.js telemetry disabled" });
    }
  }

  // ---- Check 6: S3 media storage configuration (partial = fatal in production) ----
  // The storage driver auto-detects: all four S3_* vars → S3, otherwise local
  // disk (src/lib/storage.ts). A PARTIAL configuration therefore silently
  // serves/writes media to local disk — harmless in dev, DATA LOSS on
  // stateless production hosts (ephemeral filesystem). Fail fast in
  // production; warn elsewhere. MEDIA_STORAGE_DRIVER=local is an explicit
  // opt-out and skips the check.
  const s3Required = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
  const s3Set = s3Required.filter((k) => (env[k] ?? "").trim() !== "");
  const driverForced = (env.MEDIA_STORAGE_DRIVER ?? "").trim().toLowerCase();
  if (driverForced === "local") {
    checks.push({ name: "storage_s3_config", status: "ok", detail: "MEDIA_STORAGE_DRIVER=local — local disk media storage is explicit" });
  } else if (s3Set.length === 0) {
    checks.push({
      name: "storage_s3_config",
      status: "warn",
      detail: "No S3 media storage configured — uploads persist to local disk (fine for single-node hosts; stateless hosts need the S3_* set)",
    });
  } else if (s3Set.length === s3Required.length) {
    checks.push({ name: "storage_s3_config", status: "ok", detail: "S3 media storage fully configured" });
  } else {
    const missing = s3Required.filter((k) => !s3Set.includes(k));
    checks.push({
      name: "storage_s3_config",
      status: nodeEnv === "production" ? "fail" : "warn",
      detail: `PARTIAL S3 configuration — set but incomplete: ${s3Set.join(", ")}; missing: ${missing.join(
        ", "
      )}. The app would silently fall back to local disk${
        nodeEnv === "production" ? " — refusing to start in production; complete the S3_* set or set MEDIA_STORAGE_DRIVER=local" : ""
      }`,
    });
  }

  // ---- Check 7: session cookie policy (production escape hatch) ----
  // Production cookies are Secure by default (src/lib/auth.ts). An explicit
  // SESSION_SECURE_COOKIES=false in production is only honored with the
  // BEAN_ALLOW_INSECURE_COOKIES=true escape hatch (e.g. plain-HTTP LAN
  // deployments) — otherwise it fails fast instead of silently issuing
  // non-secure session cookies.
  const secureCookies = (env.SESSION_SECURE_COOKIES ?? "").trim().toLowerCase();
  if (secureCookies === "") {
    checks.push({ name: "session_cookie_policy", status: "ok", detail: "SESSION_SECURE_COOKIES unset — Secure-by-default per environment" });
  } else if (secureCookies !== "true" && secureCookies !== "false") {
    checks.push({
      name: "session_cookie_policy",
      status: "fail",
      detail: `SESSION_SECURE_COOKIES must be "true" or "false" (got an unknown value — names only are logged)`,
    });
  } else if (secureCookies === "false" && nodeEnv === "production") {
    if ((env.BEAN_ALLOW_INSECURE_COOKIES ?? "").trim().toLowerCase() === "true") {
      checks.push({
        name: "session_cookie_policy",
        status: "warn",
        detail: "SESSION_SECURE_COOKIES=false in production WITH BEAN_ALLOW_INSECURE_COOKIES=true — session cookies are NOT Secure (plain-HTTP escape hatch)",
      });
    } else {
      checks.push({
        name: "session_cookie_policy",
        status: "fail",
        detail:
          "SESSION_SECURE_COOKIES=false in production without the BEAN_ALLOW_INSECURE_COOKIES=true escape hatch — refusing to issue non-Secure session cookies in production",
      });
    }
  } else {
    checks.push({ name: "session_cookie_policy", status: "ok", detail: `SESSION_SECURE_COOKIES=${secureCookies}` });
  }

  // ---- Check 8: known-variable value validation ----
  // These backends are selected by string match at runtime; a typo would
  // silently fall back to the default. Known values only — names logged,
  // never values.
  const knownValues: Record<string, readonly string[]> = {
    RATE_LIMIT_BACKEND: ["memory", "postgres"],
    CACHE_BACKEND: ["memory", "postgres"],
    MEDIA_STORAGE_DRIVER: ["local", "s3"],
    QUEUE_ENABLED: ["true", "false"],
    LOG_LEVEL: ["debug", "info", "warn", "error"],
  };
  const unknownEnvVars = Object.entries(knownValues)
    .filter(([k]) => (env[k] ?? "").trim() !== "")
    .filter(([k, allowed]) => !allowed.includes((env[k] ?? "").trim().toLowerCase()))
    .map(([k]) => k);
  checks.push({
    name: "known_variable_values",
    status: unknownEnvVars.length > 0 ? "fail" : "ok",
    detail:
      unknownEnvVars.length > 0
        ? `Unknown values for known variables (allowed sets: RATE_LIMIT_BACKEND/CACHE_BACKEND=memory|postgres, MEDIA_STORAGE_DRIVER=local|s3, QUEUE_ENABLED=true|false, LOG_LEVEL=debug|info|warn|error): ${unknownEnvVars.join(", ")}`
        : "All known environment variables carry recognized values",
  });

  // ---- Check 9: email delivery configuration (M31, production guard) ----
  // EMAIL_DELIVERY_ADAPTER=none is the honest default (nothing is sent, and
  // nothing pretends it was). `console` is a dev/test-only adapter. The
  // EMAIL_DEV_TEST_MODE=1 path (tokens returned in API responses for QA)
  // must NEVER be active in production — fail fast if it is.
  const emailAdapter = (env.EMAIL_DELIVERY_ADAPTER ?? "none").trim().toLowerCase();
  if (!["none", "console"].includes(emailAdapter)) {
    checks.push({
      name: "email_delivery",
      status: nodeEnv === "production" ? "fail" : "warn",
      detail: `EMAIL_DELIVERY_ADAPTER="${emailAdapter}" is not implemented (allowed: none | console) — verification email delivery would fall back to the honest no-op adapter`,
    });
  } else if (emailAdapter === "console" && nodeEnv === "production") {
    checks.push({
      name: "email_delivery",
      status: "fail",
      detail: "EMAIL_DELIVERY_ADAPTER=console is a development/test-only adapter and is refused in production",
    });
  } else {
    checks.push({
      name: "email_delivery",
      status: "ok",
      detail:
        emailAdapter === "none"
          ? "EMAIL_DELIVERY_ADAPTER=none — no provider configured; verification delivery honestly reports non-delivery (no provider is pretended)"
          : "EMAIL_DELIVERY_ADAPTER=console — development/test logging adapter active",
    });
  }
  const devTestMode = (env.EMAIL_DEV_TEST_MODE ?? "").trim().toLowerCase();
  if (devTestMode === "1" && nodeEnv === "production") {
    checks.push({
      name: "email_dev_test_mode",
      status: "fail",
      detail:
        "EMAIL_DEV_TEST_MODE=1 in production is forbidden — the dev-only verification token path must never be enabled in production",
    });
  } else if (devTestMode === "1") {
    checks.push({
      name: "email_dev_test_mode",
      status: "warn",
      detail: "EMAIL_DEV_TEST_MODE=1 outside production — verification tokens are exposed to API responses for QA only",
    });
  }

  const failed = checks.filter((c) => c.status === "fail");
  const result: StartupValidationResult = {
    ok: failed.length === 0,
    checks,
    env: nodeEnv,
    durationMs: Date.now() - started,
  };

  if (useCache) cached = result;

  if (!result.ok) {
    // Structured, value-free failure log before the throw (fail-fast).
    console.error(
      JSON.stringify({
        event: "startup.env_validation_failed",
        ok: false,
        failed: failed.map((f) => f.name),
        checks: checks.map((c) => ({ name: c.name, status: c.status })),
        durationMs: result.durationMs,
      })
    );
    throw new StartupValidationError(
      `Startup environment validation failed: ${failed.map((f) => `${f.name} — ${f.detail}`).join("; ")}`,
      result
    );
  }

  console.log(
    JSON.stringify({
      event: "startup.env_validated",
      ok: true,
      env: result.env,
      warnings: checks.filter((c) => c.status === "warn").map((c) => c.name),
      durationMs: result.durationMs,
    })
  );

  return result;
}
