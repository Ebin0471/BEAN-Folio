/*
 * BEAN Folio — k6 scenario: AUTH (login + session bootstrap, 5% of declared traffic)
 * ---------------------------------------------------------------------------
 * Per iteration:  POST /api/auth/login  →  GET /api/auth/me (with cookie)
 *
 * ⚠ RATE-LIMIT REALITY (src/app/api/auth/login/route.ts):
 *   login is limited to 10 attempts / minute / client key, keyed on the
 *   RIGHTMOST X-Forwarded-For entry — i.e. the load generator's IP behind the
 *   edge. One k6 box = ONE bucket. This scenario therefore runs a FIXED 2 VUs
 *   with a 15 s think time (≈ 8 logins/min, safely under the limiter) and
 *   treats 429 as an expected, separately-tracked outcome — NOT a hard error.
 *   To test higher login arrival rates, spread load generators over distinct
 *   egress IPs (k6 cloud, multiple boxes) or temporarily raise the limit in a
 *   dedicated staging deployment. NEVER point this at production user data.
 *
 * Credentials default to the seeded demo account (scripts/seed.ts):
 *   demo@beanfolio.app / demo1234  (fixture data only)
 *
 * Service objective (TARGET, not guarantee): login+me p95 < 1,000 ms
 * (login is a write: session row + audit event), hard errors < 1% (excluding 429).
 *
 * Run (staging/CI where k6 exists):
 *   k6 run -e BASE_URL=https://staging.example.com scripts/loadtest/k6/auth.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const EMAIL = __ENV.AUTH_EMAIL || "demo@beanfolio.app";
const PASSWORD = __ENV.AUTH_PASSWORD || "demo1234";
const THINK_S = Number(__ENV.AUTH_THINK_S || 15); // ≥15s × 2 VU keeps us ≤ ~8 logins/min
const VUS = Number(__ENV.AUTH_VUS || 2); // do NOT raise on a single box (10/min/IP limiter)

const loginLatency = new Trend("bean_auth_login_ms", true);
const meLatency = new Trend("bean_auth_me_ms", true);
const hardErrors = new Rate("bean_auth_hard_errors"); // network/5xx only (429 excluded)
const tooMany = new Counter("bean_auth_429"); // expected under the 10/min limiter
const badCreds = new Counter("bean_auth_401"); // fixture drift signal — should stay 0

export const options = {
  discardResponseBodies: false,
  scenarios: {
    auth: {
      executor: "constant-vus",
      vus: VUS,
      duration: __ENV.DURATION || "2m",
      gracefulStop: "15s",
    },
  },
  thresholds: {
    "http_req_duration{name:POST /api/auth/login}": ["p(95)<1000"],
    "http_req_duration{name:GET /api/auth/me}": ["p(95)<500"],
    bean_auth_hard_errors: ["rate<0.01"],
    bean_auth_401: ["count==0"], // wrong fixture credentials = test config bug
  },
  tags: { scenario: "auth" },
};

export function setup() {
  const health = http.get(`${BASE_URL}/api/health`, { tags: { name: "GET /api/health" } });
  check(health, { "health 200": (r) => r.status === 200 });
}

export default function () {
  const payload = JSON.stringify({ email: EMAIL, password: PASSWORD });
  const login = http.post(`${BASE_URL}/api/auth/login`, payload, {
    headers: { "Content-Type": "application/json" },
    tags: { name: "POST /api/auth/login" },
  });
  loginLatency.add(login.timings.duration);

  if (login.status === 429) {
    tooMany.add(1); // expected if the box exceeds its single-bucket allowance
  } else if (login.status === 401) {
    badCreds.add(1);
    hardErrors.add(true); // fixture credentials drifted — flag it
  } else {
    hardErrors.add(login.status === 0 || login.status >= 500);
  }
  check(login, { "login 200": (x) => x.status === 200 });

  const cookie = login.cookies && login.cookies.bean_session && login.cookies.bean_session[0]
    ? login.cookies.bean_session[0]
    : null;
  if (cookie) {
    const me = http.get(`${BASE_URL}/api/auth/me`, {
      cookies: { bean_session: cookie.value },
      tags: { name: "GET /api/auth/me" },
    });
    meLatency.add(me.timings.duration);
    hardErrors.add(me.status === 0 || me.status >= 500);
    check(me, { "me 200": (x) => x.status === 200 });
  }

  sleep(THINK_S * (0.9 + Math.random() * 0.2)); // jitter keeps logins off a fixed drumbeat
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    [__ENV.SUMMARY_JSON || "/tmp/k6-auth-summary.json"]: JSON.stringify(
      {
        scenario: "auth",
        vus: VUS,
        think_s: THINK_S,
        approx_logins_per_min: (60 / (THINK_S + 0.3)) * VUS,
        metrics: {
          login_p95_ms: (data.metrics["http_req_duration{name:POST /api/auth/login}"] || {}).values?.["p(95)"],
          me_p95_ms: (data.metrics["http_req_duration{name:GET /api/auth/me}"] || {}).values?.["p(95)"],
          hard_error_rate: (data.metrics.bean_auth_hard_errors || {}).values?.rate,
          http_429: (data.metrics.bean_auth_429 || {}).values?.count,
          http_401: (data.metrics.bean_auth_401 || {}).values?.count,
        },
      },
      null,
      2
    ),
  };
}
