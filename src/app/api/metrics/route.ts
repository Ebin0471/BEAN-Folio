/**
 * GET /api/metrics — Prometheus text exposition (aggregate counters ONLY).
 *
 * Reliability/scale program (GZ-SCALE Phase 5): gives Prometheus / any
 * scraper one endpoint for queue depth, cache pressure, AI circuit health,
 * process memory and uptime — everything needed to alert on saturation
 * before users feel it. Same value-free policy as /api/health: aggregate
 * counts and statuses, never error text, never user data.
 *
 * Access: set METRICS_TOKEN to require `Authorization: Bearer <token>`
 * (recommended in production — Prometheus scrape configs accept a bearer
 * token via `authorization.credentials`). Unset keeps the endpoint open for
 * local development / compose stacks behind a network edge that does not
 * route it publicly.
 */

import { NextResponse } from "next/server";

import { queueStats } from "@/lib/queue/stats";
import { cacheHealthSnapshot } from "@/lib/cache";
import { getRateLimitBackend } from "@/lib/rate-limit-backend";
import { providerHealthSnapshot } from "@/lib/intelligence/circuit";
import { getStartupValidationSnapshot } from "@/lib/startup-validation";

export const dynamic = "force-dynamic";

type Sample = { name: string; value: number; labels?: Record<string, string>; help?: string };

function prometheus(samples: Sample[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const s of samples) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      lines.push(`# HELP ${s.name} ${s.help ?? s.name.replace(/_/g, " ")}`);
      lines.push(`# TYPE ${s.name} gauge`);
    }
    const label =
      s.labels && Object.keys(s.labels).length > 0
        ? `{${Object.entries(s.labels)
            .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
            .join(",")}}`
        : "";
    lines.push(`${s.name}${label} ${s.value}`);
  }
  lines.push("");
  return lines.join("\n");
}

function authorized(req: Request): boolean {
  const token = (process.env.METRICS_TOKEN ?? "").trim();
  if (!token) return true;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${token}`;
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const samples: Sample[] = [];

  // Process (no DB dependency — always emitted).
  const mem = process.memoryUsage();
  samples.push(
    { name: "bean_process_uptime_seconds", value: Math.round(process.uptime()), help: "Process uptime in seconds" },
    { name: "bean_process_resident_memory_bytes", value: mem.rss, help: "Resident set size in bytes" },
    { name: "bean_process_heap_used_bytes", value: mem.heapUsed, help: "V8 heap used in bytes" }
  );

  // Startup validation state (value-free; null = validation not yet run here).
  const startup = getStartupValidationSnapshot();
  if (startup) {
    samples.push({
      name: "bean_startup_valid",
      value: startup.ok ? 1 : 0,
      help: "1 when the cached startup environment validation is healthy",
    });
  }

  // Queue depth by lifecycle state (null-safe: DB outage degrades to nothing
  // instead of failing the scrape — the process metrics above still flow).
  try {
    const queue = await queueStats();
    if (queue) {
      for (const [state, count] of Object.entries(queue.byStatus)) {
        samples.push({
          name: "bean_queue_jobs",
          value: count,
          labels: { state },
          help: "Background jobs by lifecycle state",
        });
      }
      if (queue.oldestQueuedAgeMs !== null) {
        samples.push({
          name: "bean_queue_oldest_queued_age_seconds",
          value: Math.round(queue.oldestQueuedAgeMs / 1000),
          help: "Age of the oldest QUEUED job (scheduling pressure)",
        });
      }
      if (queue.lastTickAgoMs !== null) {
        samples.push({
          name: "bean_queue_worker_last_tick_age_seconds",
          value: Math.round(queue.lastTickAgoMs / 1000),
          help: "Age of this process worker's last poll",
        });
      }
    }
  } catch {
    // Degrade honestly: emit nothing for the queue family on a snapshot failure.
  }

  // Cache pressure.
  const cache = cacheHealthSnapshot();
  samples.push(
    { name: "bean_cache_entries", value: cache.size, labels: { backend: String(cache.backend) }, help: "In-process cache entries" },
    { name: "bean_cache_hits_total", value: cache.hits, labels: { backend: String(cache.backend) }, help: "Cache hits since boot" },
    { name: "bean_cache_misses_total", value: cache.misses, labels: { backend: String(cache.backend) }, help: "Cache misses since boot" }
  );

  // Rate-limit backend identity (memory = per-instance — the scaling tell).
  samples.push({
    name: "bean_rate_limit_backend_info",
    value: 1,
    labels: { backend: getRateLimitBackend().name },
    help: "Active rate-limit backend (memory is per-instance; postgres is fleet-shared)",
  });

  // AI provider circuit health (ids + status only — no secrets).
  const circuits = providerHealthSnapshot();
  const STATUS_CODE: Record<string, number> = { closed: 0, "half-open": 1, open: 2 };
  for (const [provider, health] of Object.entries(circuits)) {
    samples.push({
      name: "bean_ai_circuit_status",
      value: STATUS_CODE[health.status] ?? -1,
      labels: { provider },
      help: "Circuit status: 0 closed, 1 half-open, 2 open",
    });
    samples.push({
      name: "bean_ai_circuit_failures",
      value: health.consecutiveFailures,
      labels: { provider },
      help: "Consecutive transient failures counted by the breaker",
    });
  }

  return new NextResponse(prometheus(samples), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
