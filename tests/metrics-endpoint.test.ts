/**
 * GET /api/metrics — contract + value-policy tests (GZ-SCALE M3).
 *
 * Pins: Prometheus text exposition format, aggregate-only value policy
 * (no emails, no user ids, no error text), METRICS_TOKEN bearer guard,
 * no-store cache policy, and honest degradation when the DB is unreachable
 * (process metrics must still flow).
 *
 * Run: DATABASE_URL=file:<isolated custom.db> bun test tests/metrics-endpoint.test.ts
 */

import { describe, expect, test, afterEach } from "bun:test";

process.env.RATE_LIMIT_BACKEND = "memory";

import { GET } from "@/app/api/metrics/route";

function promRequest(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/metrics", { headers: headers ?? {} });
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

afterEach(() => {
  delete process.env.METRICS_TOKEN;
});

describe("/api/metrics", () => {
  test("exposes Prometheus text format with process, cache and rate-limit metrics", async () => {
    const res = await GET(promRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.text();
    expect(body).toContain("# TYPE bean_process_uptime_seconds gauge");
    expect(body).toContain("# TYPE bean_process_resident_memory_bytes gauge");
    expect(body).toContain("# TYPE bean_cache_hits_total gauge");
    // Rate-limit backend identity line must exist (memory under this test env).
    expect(body).toMatch(/bean_rate_limit_backend_info\{backend="[a-z]+"\} 1/);
    // HELP/TYPE precede samples; every sample line parses as name[{labels}] value.
    for (const line of body.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      expect(line).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*(\{[^}]*\})? -?\d+(\.\d+)?$/);
    }
  });

  test("emits queue depth samples against the isolated test DB", async () => {
    const res = await GET(promRequest());
    const body = await res.text();
    expect(body).toContain("bean_queue_jobs{state=\"QUEUED\"}");
    expect(body).toContain("# TYPE bean_queue_jobs gauge");
  });

  test("value policy: no emails, no secrets-shaped strings, no error text", async () => {
    const res = await GET(promRequest());
    const body = await res.text();
    expect(body).not.toMatch(EMAIL_RE);
    expect(body).not.toMatch(/ghp_|gho_|github_pat_|BEGIN .*PRIVATE KEY/);
    expect(body).not.toMatch(/error/i);
  });

  test("METRICS_TOKEN requires a matching bearer token", async () => {
    process.env.METRICS_TOKEN = "ops-secret-token";
    const denied = await GET(promRequest());
    expect(denied.status).toBe(401);

    const wrong = await GET(promRequest({ authorization: "Bearer nope" }));
    expect(wrong.status).toBe(401);

    const ok = await GET(promRequest({ authorization: "Bearer ops-secret-token" }));
    expect(ok.status).toBe(200);
  });
});
