import { ok, err, handler } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { getStartupValidationSnapshot } from "@/lib/startup-validation";

/**
 * Readiness probe — answers "is this instance actually able to serve?".
 *
 * Unlike `/api/health` (liveness: is the process up?), this endpoint checks:
 *  1. Startup validation ran and passed (cached snapshot from
 *     `src/instrumentation.ts`; if it failed the process already exited).
 *  2. The database answers a trivial query (real reachability, not just
 *     config presence).
 *
 * Returns 503 with `ready: false` when anything is not actually working —
 * it must never report ready while a dependency is down.
 */
export const GET = handler(async () => {
  const snapshot = getStartupValidationSnapshot();

  // Database reachability (bounded so the probe cannot hang).
  let database: "reachable" | "unreachable" = "unreachable";
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
    ]);
    database = "reachable";
  } catch {
    // Intentionally value-free: error details can embed connection strings.
  }

  const startupOk = snapshot ? snapshot.ok : true; // not yet run → don't fail readiness for it
  const ready = startupOk && database === "reachable";

  if (!ready) {
    return err(
      database === "unreachable" ? "Not ready — database is unreachable" : "Not ready — startup validation failed",
      503,
      "not_ready"
    );
  }

  return ok({
    ok: true,
    ready: true,
    service: "bean-folio",
    time: new Date().toISOString(),
    startup: snapshot
      ? { ok: true, env: snapshot.env, checks: snapshot.checks.length }
      : { ok: true, pending: true },
    database,
  });
});
