/*
 * BEAN Folio — CLOSED-MODEL concurrency probe (GZ-SCALE Phase 6).
 *
 * The workload mix scripts (browse.js etc.) use arrival-rate executors where
 * concurrency is emergent — the right model for throughput targets, but it
 * does not answer "what happens under N simultaneous connections". This probe
 * pins VUs directly (constant-vus) so each run IS the declared concurrency:
 *
 *   k6 run -e BASE_URL=http://localhost:3100 -e VUS=100  -e DURATION=60s \
 *          scripts/loadtest/k6/vu-probe.js
 *   k6 run -e BASE_URL=http://localhost:3100 -e VUS=500  -e DURATION=60s \
 *          scripts/loadtest/k6/vu-probe.js
 *   k6 run -e BASE_URL=http://localhost:3100 -e VUS=1000 -e DURATION=60s \
 *          scripts/loadtest/k6/vu-probe.js
 *
 * Every VU loops a realistic public read (discover feed → creator profile →
 * SPA shell → professions taxonomy) with 1s think time — an aggressive but
 * honest concurrent-visitor model. Rate-limit 429s are EXPECTED at high VU
 * counts from one generator IP and are tracked separately from hard errors
 * (5xx + network). No thresholds are declared here — evidence collection,
 * not gate enforcement; the run report records the numbers.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const VUS = Number(__ENV.VUS || 100);
const DURATION = __ENV.DURATION || "60s";

const readMs = new Trend("bean_probe_read_ms", true);
const hardErrors = new Rate("bean_probe_hard_errors"); // 5xx + network only
const throttled = new Counter("bean_probe_429");

export const options = {
  discardResponseBodies: true,
  scenarios: {
    probe: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
      gracefulStop: "5s",
    },
  },
};

export default function () {
  // 1) public feed (rate-limited on purpose — production contract)
  const feed = http.get(`${BASE_URL}/api/discover?take=10`, { tags: { name: "GET /api/discover" } });
  record(feed);
  // 2) professions taxonomy (cached hot path)
  record(http.get(`${BASE_URL}/api/professions`, { tags: { name: "GET /api/professions" } }));
  // 3) SPA shell (SSR page)
  record(http.get(`${BASE_URL}/`, { tags: { name: "GET / (shell)" } }));
  // 4) ops surface
  record(http.get(`${BASE_URL}/api/health`, { tags: { name: "GET /api/health" } }));
  sleep(1);
}

function record(res) {
  readMs.add(res.timings.duration);
  if (res.status === 429) {
    throttled.add(1);
    return;
  }
  const okStatus = res.status >= 200 && res.status < 400;
  check(res, { "status ok": () => okStatus });
  if (!okStatus || res.status >= 500 || res.error) hardErrors.add(1);
}
