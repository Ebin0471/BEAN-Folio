import { ok, handler } from "@/lib/api-helpers";
import { queueStats } from "@/lib/queue/stats";
import { cacheHealthSnapshot } from "@/lib/cache";

/**
 * Liveness + value-free operational counters.
 *
 * Policy: the response may carry AGGREGATE queue counters (depth, ages) and
 * AGGREGATE cache counters (backend, size, hit/miss) so ops can see
 * scheduling/caching pressure at a glance — never error text, never user
 * data, never internal failure details. `queueStats` degrades to nulls when
 * the database is unreachable, so this endpoint stays a liveness probe even
 * during a DB outage.
 */
export const GET = handler(async () => {
  const queue = await queueStats();
  const cache = cacheHealthSnapshot();
  const res = ok({ ok: true, service: "bean-folio", time: new Date().toISOString(), queue, cache });
  // Probes are always fresh — never cached by any intermediary (M22 Phase 2).
  res.headers.set("Cache-Control", "no-store");
  return res;
});
