/*
 * BEAN Folio — k6 scenario: PUBLISH TOGGLE (writes, ≤1% of declared traffic)
 * ---------------------------------------------------------------------------
 * Per iteration on a DEDICATED fixture account:
 *   POST /api/me/site/publish    (snapshot draft → published slot)
 *   POST /api/me/site/unpublish  (restore; leaves state as we found it)
 *
 * ⚠ GATED + ACCOUNT-BOUND ⚠
 *  1. ABORTS unless PUBLISH_ENABLED=true — a publish mutates public state.
 *  2. Runs ONLY against the dedicated QA fixture account
 *     (default: pub-e2e-1027@beanfolio.test / qa-fixture-password, from
 *     scripts/restore-qa-fixtures.ts). NEVER a real user account.
 *  3. The publish limiter is 20/min/user (rateLimitShared) — this scenario
 *     keeps ≤ 10/min by sleeping ~8 s between cycles, and backs off 30 s on 429.
 *  4. Preconditions: the fixture account needs a SAVED draft; without one the
 *     endpoint answers 400 "Save your website draft before publishing." The
 *     scenario detects that, reports it as a precondition failure and STOPS
 *     instead of hammering.
 *
 * Service objective (TARGET, not guarantee): publish/unpublish p95 < 1,000 ms.
 *
 * Run (staging/CI where k6 exists):
 *   PUBLISH_ENABLED=true k6 run -e BASE_URL=https://staging.example.com \
 *     scripts/loadtest/k6/publish.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const ENABLED = __ENV.PUBLISH_ENABLED === "true";
const EMAIL = __ENV.PUBLISH_ACCOUNT_EMAIL || "pub-e2e-1027@beanfolio.test";
const PASSWORD = __ENV.PUBLISH_ACCOUNT_PASSWORD || "qa-fixture-password";
const CYCLE_S = Math.max(Number(__ENV.PUBLISH_CYCLE_S || 8), 4); // keep ≤ ~10 publish/min (limiter: 20/min)

const publishLatency = new Trend("bean_publish_ms", true);
const unpublishLatency = new Trend("bean_unpublish_ms", true);
const hardErrors = new Rate("bean_publish_hard_errors");
const tooMany = new Counter("bean_publish_429");
const preconditionFailed = new Counter("bean_publish_precondition_failed");

let stopped = false;

export const options = {
  discardResponseBodies: true,
  scenarios: {
    publish: {
      executor: "constant-vus",
      vus: 1, // single dedicated account — more VUs would fight the 20/min limiter
      duration: __ENV.DURATION || "2m",
      gracefulStop: "10s",
    },
  },
  thresholds: {
    "http_req_duration{name:POST /api/me/site/publish}": ["p(95)<1000"],
    "http_req_duration{name:POST /api/me/site/unpublish}": ["p(95)<1000"],
    bean_publish_hard_errors: ["rate<0.001"],
  },
  tags: { scenario: "publish" },
};

function mustLogin() {
  const login = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "POST /api/auth/login" } }
  );
  if (login.status !== 200) {
    throw new Error(`publish: fixture login failed (${login.status}) — check PUBLISH_ACCOUNT_EMAIL/PASSWORD`);
  }
  const c = login.cookies.bean_session && login.cookies.bean_session[0];
  return c ? `bean_session=${c.value}` : null;
}

export function setup() {
  if (!ENABLED) {
    throw new Error(
      "publish scenario is DISABLED: it performs real writes. Re-run with -e PUBLISH_ENABLED=true " +
        "to acknowledge it targets the dedicated fixture account only."
    );
  }
  const health = http.get(`${BASE_URL}/api/health`, { tags: { name: "GET /api/health" } });
  check(health, { "health 200": (r) => r.status === 200 });
  return { cookie: mustLogin() };
}

export default function (data) {
  if (stopped) {
    sleep(CYCLE_S);
    return;
  }

  const publish = http.post(`${BASE_URL}/api/me/site/publish`, null, {
    headers: { Cookie: data.cookie },
    tags: { name: "POST /api/me/site/publish" },
  });
  publishLatency.add(publish.timings.duration);

  if (publish.status === 429) {
    tooMany.add(1);
    sleep(30); // limiter cooldown — do not fight it
    return;
  }
  if (publish.status === 400) {
    // No saved draft (or no username) — a precondition problem, not load data.
    preconditionFailed.add(1);
    stopped = true;
    console.warn(
      `publish: precondition failed (400) — fixture account needs a saved draft. Stopping scenario.`
    );
    return;
  }
  hardErrors.add(publish.status === 0 || publish.status >= 500);
  check(publish, { "publish 200": (x) => x.status === 200 });

  const unpublish = http.post(`${BASE_URL}/api/me/site/unpublish`, null, {
    headers: { Cookie: data.cookie },
    tags: { name: "POST /api/me/site/unpublish" },
  });
  unpublishLatency.add(unpublish.timings.duration);
  hardErrors.add(unpublish.status === 0 || unpublish.status >= 500);
  check(unpublish, { "unpublish 200": (x) => x.status === 200 });

  sleep(CYCLE_S * (0.9 + Math.random() * 0.2));
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    [__ENV.SUMMARY_JSON || "/tmp/k6-publish-summary.json"]: JSON.stringify(
      {
        scenario: "publish",
        gated_by: "PUBLISH_ENABLED",
        account: EMAIL,
        cycle_s: CYCLE_S,
        metrics: {
          publish_p95_ms: (data.metrics["http_req_duration{name:POST /api/me/site/publish}"] || {}).values?.["p(95)"],
          unpublish_p95_ms: (data.metrics["http_req_duration{name:POST /api/me/site/unpublish}"] || {}).values?.["p(95)"],
          hard_error_rate: (data.metrics.bean_publish_hard_errors || {}).values?.rate,
          http_429: (data.metrics.bean_publish_429 || {}).values?.count,
          precondition_failures: (data.metrics.bean_publish_precondition_failed || {}).values?.count,
        },
      },
      null,
      2
    ),
  };
}
