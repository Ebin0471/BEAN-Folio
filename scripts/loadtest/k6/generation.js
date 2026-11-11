/*
 * BEAN Folio — k6 scenario: AI SITE-STUDIO GENERATION (≤1% of declared traffic)
 * ---------------------------------------------------------------------------
 * ⚠⚠ EXPENSIVE + QUOTA-LIMITED — TRIPLE-GATED ⚠⚠
 *
 *  1. The whole scenario ABORTS unless GEN_ENABLED=true is explicitly set.
 *     Every studio message consumes the account's daily AI quota
 *     (AI_DAILY_LIMIT = 30/day/user, src/lib/ai.ts) and a real LLM call.
 *  2. Arrival rate is ≤ 1 message/s PER VU (hard ceiling); the default is
 *     1 message / 15 s with 1 VU — one order of magnitude below the ceiling.
 *  3. Prompts are tiny (a few words) and mode is "edit" — we measure the
 *     QUEUE-ADMISSION path (the 202-style accept), never generation completion.
 *
 * What is measured: POST /api/me/site/studio/sessions/[id]/messages —
 *   - success = 200/202 "turn enqueued" accept latency (objective: p95 < 1 s)
 *   - 429     = DESIGNED quota/limiter path (30/day or burst limiter) — tracked,
 *               never a hard error; 5 consecutive quota 429s end the scenario
 *               gracefully (the account is done for the UTC day).
 *
 * Dedicated fixture account (scripts/restore-qa-fixtures.ts), override freely:
 *   GEN_ACCOUNT_EMAIL / GEN_ACCOUNT_PASSWORD
 *
 * Run (staging/CI where k6 exists — deliberately loud on purpose):
 *   GEN_ENABLED=true k6 run -e BASE_URL=https://staging.example.com \
 *     scripts/loadtest/k6/generation.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const GEN_ENABLED = __ENV.GEN_ENABLED === "true";
const EMAIL = __ENV.GEN_ACCOUNT_EMAIL || "nova.testwright@example.com";
const PASSWORD = __ENV.GEN_ACCOUNT_PASSWORD || "qa-fixture-password";
const PER_VU_CEILING_S = 1; // hard: never more than 1 message per second per VU
const SPACING_S = Math.max(Number(__ENV.GEN_SPACING_S || 15), PER_VU_CEILING_S);
const QUOTA_STOP_STREAK = 5;

const acceptLatency = new Trend("bean_gen_accept_ms", true); // 202-accept path only
const hardErrors = new Rate("bean_gen_hard_errors");
const tooMany = new Counter("bean_gen_429"); // quota/burst limiter — designed path
const quotaDone = new Counter("bean_gen_quota_exhausted");

// Tiny edit prompts — admission is what we measure, not the LLM output.
const TINY_PROMPTS = [
  "Make the hero heading say Beans.",
  "Set the accent color to olive.",
  "Add a short tagline under the hero.",
  "Rename the about section to Story.",
];

let quotaStreak = 0;

export const options = {
  discardResponseBodies: false,
  scenarios: {
    generation: {
      executor: "constant-arrival-rate",
      rate: 1,
      timeUnit: `${SPACING_S}s`, // ≤ 1 msg/s per VU by construction (default 1/15s)
      preAllocatedVUs: 1,
      maxVUs: 2,
      duration: __ENV.DURATION || "5m",
      gracefulStop: "10s",
    },
  },
  thresholds: {
    "http_req_duration{name:POST studio message}": ["p(95)<1000"],
    "http_req_duration{name:GET studio sessions}": ["p(95)<500"],
    bean_gen_hard_errors: ["rate<0.001"],
  },
  tags: { scenario: "generation" },
};

function mustLogin() {
  const login = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "POST /api/auth/login" } }
  );
  if (login.status !== 200) {
    throw new Error(`generation: fixture login failed (${login.status}) — check GEN_ACCOUNT_EMAIL/PASSWORD`);
  }
  const c = login.cookies.bean_session && login.cookies.bean_session[0];
  return c ? `bean_session=${c.value}` : null;
}

export function setup() {
  // GATE 1 — abort BEFORE any traffic when the flag is missing. This is the
  // tripwire that stops someone from "just trying the scenario" and silently
  // burning the fixture account's daily AI quota.
  if (!GEN_ENABLED) {
    throw new Error(
      "generation scenario is DISABLED: it consumes real LLM quota (30/day/user). " +
        "Re-run with -e GEN_ENABLED=true to acknowledge."
    );
  }
  const health = http.get(`${BASE_URL}/api/health`, { tags: { name: "GET /api/health" } });
  check(health, { "health 200": (r) => r.status === 200 });

  const cookie = mustLogin();

  // Reuse the account's newest studio session; create one only if none exist.
  let sessionId = null;
  const list = http.get(`${BASE_URL}/api/me/site/studio/sessions`, {
    headers: { Cookie: cookie },
    tags: { name: "GET studio sessions" },
  });
  if (list.status === 200) {
    const sessions = (list.json() || {}).sessions || [];
    if (sessions.length > 0) sessionId = sessions[0].id;
  }
  if (!sessionId) {
    const created = http.post(
      `${BASE_URL}/api/me/site/studio/sessions`,
      JSON.stringify({ title: "load-gen" }),
      { headers: { "Content-Type": "application/json", Cookie: cookie }, tags: { name: "POST studio session" } }
    );
    check(created, { "session created": (x) => x.status === 200 || x.status === 201 });
    sessionId = (created.json() || {}).session && created.json().session.id;
  }
  if (!sessionId) throw new Error("generation: could not obtain a studio session id");
  return { cookie, sessionId };
}

export default function (data) {
  if (quotaStreak >= QUOTA_STOP_STREAK) {
    quotaDone.add(1);
    sleep(30); // idle the VU; scenario keeps running but sends nothing more
    return;
  }

  const res = http.post(
    `${BASE_URL}/api/me/site/studio/sessions/${data.sessionId}/messages`,
    JSON.stringify({
      text: TINY_PROMPTS[Math.floor(Math.random() * TINY_PROMPTS.length)],
      currentConfig: {}, // minimal valid object — z.looseObject({}) admission check
      mode: "edit",
    }),
    {
      headers: { "Content-Type": "application/json", Cookie: data.cookie },
      tags: { name: "POST studio message" },
    }
  );
  acceptLatency.add(res.timings.duration);

  if (res.status === 429) {
    // DESIGNED path: daily quota (30/day) or shared burst limiter. Count it,
    // require a cooldown, and after a sustained streak stop burning attempts.
    tooMany.add(1);
    quotaStreak += 1;
    sleep(Math.min(60, SPACING_S * 2));
    return;
  }
  quotaStreak = 0;
  hardErrors.add(res.status === 0 || res.status >= 500);
  check(res, {
    "message accepted (2xx)": (x) => x.status >= 200 && x.status < 300,
  });

  sleep(0); // pacing is owned by the arrival-rate executor (rate=1 per SPACING_S)
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    [__ENV.SUMMARY_JSON || "/tmp/k6-generation-summary.json"]: JSON.stringify(
      {
        scenario: "generation",
        gated_by: "GEN_ENABLED",
        spacing_s: SPACING_S,
        note: "measures QUEUE-ADMISSION (202-accept) latency only — not generation completion",
        metrics: {
          accept_p95_ms: (data.metrics["http_req_duration{name:POST studio message}"] || {}).values?.["p(95)"],
          hard_error_rate: (data.metrics.bean_gen_hard_errors || {}).values?.rate,
          http_429: (data.metrics.bean_gen_429 || {}).values?.count,
          quota_exhausted_stops: (data.metrics.bean_gen_quota_exhausted || {}).values?.count,
        },
      },
      null,
      2
    ),
  };
}
