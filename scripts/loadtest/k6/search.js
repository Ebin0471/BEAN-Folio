/*
 * BEAN Folio — k6 scenario: SEARCH (10% of declared traffic)
 * ---------------------------------------------------------------------------
 * 70% GET /api/search/projects?q=...[&category=...]   (public + published only)
 * 30% GET /api/search/profiles?q=...                  (public profiles)
 *
 * Query terms mirror what the seeded fixtures can actually match
 * (scripts/seed.ts professions/skills/titles) so results are non-empty and the
 * engine does real ranking work instead of returning empty sets.
 *
 * Service objective (TARGET, not guarantee): p95 < 500 ms, hard errors < 0.1%.
 *
 * Run (staging/CI where k6 exists):
 *   k6 run -e BASE_URL=https://staging.example.com -e SEARCH_RPS=50 \
 *          scripts/loadtest/k6/search.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const SEARCH_RPS = Number(__ENV.SEARCH_RPS || 50);
const MAX_VU = Number(__ENV.MAX_VU || 200);
const WARMUP_S = Number(__ENV.WARMUP_S || 30);

const searchLatency = new Trend("bean_search_ms", true);
const hardErrors = new Rate("bean_search_hard_errors");
const tooMany = new Counter("bean_search_429");

// Terms chosen to hit seed data: professions (photography, film, culinary...),
// skills (motion, brand, dashboard...), names/usernames (priya, marco, lena...).
const TERMS = [
  "photography",
  "film",
  "culinary",
  "illustration",
  "motion",
  "brand",
  "dashboard",
  "product",
  "priya",
  "marco",
  "lena",
  "bean",
];
const CATEGORIES = ["photography", "film-design", "culinary-arts", "visual-arts"];

export const options = {
  discardResponseBodies: true, // search checks status only — save load-gen memory
  scenarios: {
    search: {
      executor: "constant-arrival-rate",
      rate: SEARCH_RPS,
      timeUnit: "1s",
      preAllocatedVUs: Math.max(10, Math.min(200, Math.ceil(SEARCH_RPS / 2))),
      maxVUs: MAX_VU,
      startTime: "0s",
      gracefulStop: "15s",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500"],
    "http_req_duration{name:GET /api/search/projects}": ["p(95)<500"],
    "http_req_duration{name:GET /api/search/profiles}": ["p(95)<500"],
    bean_search_hard_errors: ["rate<0.001"],
  },
  tags: { scenario: "search" },
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function () {
  const term = encodeURIComponent(pick(TERMS));
  let res;
  if (Math.random() < 0.7) {
    let path = `/api/search/projects?q=${term}`;
    if (Math.random() < 0.3) path += `&category=${encodeURIComponent(pick(CATEGORIES))}`;
    if (Math.random() < 0.4) path += `&sort=${Math.random() < 0.5 ? "recent" : "saved"}`;
    res = http.get(`${BASE_URL}${path}`, { tags: { name: "GET /api/search/projects" } });
  } else {
    res = http.get(`${BASE_URL}/api/search/profiles?q=${term}`, {
      tags: { name: "GET /api/search/profiles" },
    });
  }

  searchLatency.add(res.timings.duration);
  if (res.status === 429) tooMany.add(1);
  hardErrors.add(res.status === 0 || res.status >= 500);
  check(res, { "search 200": (x) => x.status === 200 });

  sleep(Math.random() * 0.4);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    [__ENV.SUMMARY_JSON || "/tmp/k6-search-summary.json"]: JSON.stringify(
      {
        scenario: "search",
        rate: SEARCH_RPS,
        metrics: {
          p95_ms: (data.metrics.http_req_duration || {}).values?.["p(95)"],
          avg_ms: (data.metrics.http_req_duration || {}).values?.avg,
          reqs: (data.metrics.http_reqs || {}).values?.count,
          hard_error_rate: (data.metrics.bean_search_hard_errors || {}).values?.rate,
          http_429: (data.metrics.bean_search_429 || {}).values?.count,
        },
      },
      null,
      2
    ),
  };
}
