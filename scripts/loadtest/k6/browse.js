/*
 * BEAN Folio — k6 scenario: PUBLIC BROWSE MIX (80% of declared traffic)
 * ---------------------------------------------------------------------------
 * Mix (weights declared in ../workloads.md):
 *   40% GET /api/discover              (paginated public feed)
 *   20% GET /api/profiles/<username>   (public profile JSON + published site)
 *   15% GET /api/media/<id>/raw        (covers/avatars harvested from discover)
 *   10% GET /u/<username>              (SPA shell HTML)
 *   10% GET /api/professions           (taxonomy)
 *    5% GET /api/health | /api/ready   (ops surface, kept in the read mix)
 *
 * Service objective (TARGET, not guarantee): public reads p95 < 500 ms at the
 * origin; hard-error rate (5xx + network) < 0.1%.
 *
 * Run (staging/CI where k6 exists — k6 is intentionally NOT a project dep):
 *   k6 run -e BASE_URL=https://staging.example.com -e TARGET_RPS=200 \
 *          -e MAX_VU=200 scripts/loadtest/k6/browse.js
 *
 * Ramp: 10% → 25% → 50% → 100% of TARGET_RPS (k6 v0.50+ syntax).
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const TARGET_RPS = Number(__ENV.TARGET_RPS || 200);
const MAX_VU = Number(__ENV.MAX_VU || 200);
const WARMUP_S = Number(__ENV.WARMUP_S || 30);
const STEP_S = Number(__ENV.STEP_S || 60);
// BROWSE_USERNAME (optional): probe one specific PUBLIC account; default is to
// harvest public usernames from /api/discover + /api/discover/creators.

const readLatency = new Trend("bean_browse_read_ms", true);
const hardErrors = new Rate("bean_browse_hard_errors"); // 5xx + network failures
const tooMany = new Counter("bean_browse_429"); // rate-limit hits (tracked, not errors)

function stage(fraction) {
  return { target: Math.max(1, Math.round(TARGET_RPS * fraction)), duration: `${STEP_S}s` };
}

export const options = {
  discardResponseBodies: false,
  // Arrival-rate (open) model: real visitors do not queue behind slow responses.
  scenarios: {
    browse: {
      executor: "ramping-arrival-rate",
      startRate: Math.max(1, Math.round(TARGET_RPS * 0.05)),
      timeUnit: "1s",
      preAllocatedVUs: Math.max(20, Math.min(200, Math.ceil(TARGET_RPS / 4))),
      maxVUs: MAX_VU,
      stages: [
        { target: Math.max(1, Math.round(TARGET_RPS * 0.1)), duration: `${WARMUP_S}s` },
        stage(0.25),
        stage(0.5),
        stage(1.0),
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500"],
    "http_req_duration{name:GET /api/discover}": ["p(95)<500"],
    "http_req_duration{name:GET /api/profiles/<username>}": ["p(95)<500"],
    "http_req_duration{name:GET /api/media/<id>/raw}": ["p(95)<500"],
    "http_req_duration{name:GET /u/<username>}": ["p(95)<800"], // shell HTML is heavier than JSON
    bean_browse_hard_errors: ["rate<0.001"],
  },
  tags: { scenario: "browse" },
};

// Populated in setup() from real PUBLIC data (no synthetic ids).
// Demo personas are isDemo:true and 404 for anonymous visitors by design, so
// the username list starts EMPTY and degrades to discover when no public
// profile fixtures exist. Set BROWSE_USERNAME to force a specific account.
const state = { mediaPaths: [], usernames: [] };
if (__ENV.BROWSE_USERNAME) state.usernames.push(__ENV.BROWSE_USERNAME);

export function setup() {
  const health = http.get(`${BASE_URL}/api/health`, { tags: { name: "GET /api/health" } });
  check(health, { "health 200": (r) => r.status === 200 });

  const res = http.get(`${BASE_URL}/api/discover?limit=24`, { tags: { name: "GET /api/discover" } });
  if (res.status === 200) {
    try {
      const items = (res.json() || {}).items || [];
      for (const it of items) {
        if (it.coverUrl) state.mediaPaths.push(it.coverUrl);
        if (it.avatarUrl) state.mediaPaths.push(it.avatarUrl);
        if (it.owner && it.owner.username) state.usernames.push(it.owner.username);
      }
    } catch (_) {
      /* keep defaults — the mix degrades to discover */
    }
  }
  const creators = http.get(`${BASE_URL}/api/discover/creators?limit=24`, {
    tags: { name: "GET /api/discover/creators" },
  });
  if (creators.status === 200) {
    try {
      for (const it of (creators.json() || {}).items || []) {
        if (it.username) state.usernames.push(it.username);
      }
    } catch (_) {
      /* usernames stay as harvested from discover */
    }
  }
  if (state.mediaPaths.length === 0) state.mediaPaths.push(null); // weight falls back to discover
  state.usernames = state.usernames.filter((u, i, a) => a.indexOf(u) === i);
  if (state.usernames.length === 0) {
    console.warn("browse: no PUBLIC profile fixtures visible anonymously — profile/shell shares degrade to discover " +
      "(set BROWSE_USERNAME to probe a specific public account)");
  }
  return state;
}

function tagGet(path, name) {
  const res = http.get(`${BASE_URL}${path}`, { tags: { name } });
  readLatency.add(res.timings.duration);
  if (res.status === 429) tooMany.add(1);
  hardErrors.add(res.status === 0 || res.status >= 500);
  return res;
}

export default function (data) {
  const r = Math.random() * 100;

  if (r < 40) {
    const cursor = Math.floor(Math.random() * 4) * 12; // 0,12,24,36
    const res = tagGet(`/api/discover?limit=12&cursor=${cursor}`, "GET /api/discover");
    check(res, { "discover 200": (x) => x.status === 200 });
  } else if (r < 60) {
    if (data.usernames.length > 0) {
      const u = data.usernames[Math.floor(Math.random() * data.usernames.length)];
      const res = tagGet(`/api/profiles/${encodeURIComponent(u)}`, "GET /api/profiles/<username>");
      check(res, { "profile 200": (x) => x.status === 200 });
    } else {
      tagGet(`/api/discover?limit=12`, "GET /api/discover"); // no public profiles in DB — degrade
    }
  } else if (r < 75) {
    const p = data.mediaPaths[Math.floor(Math.random() * data.mediaPaths.length)];
    if (p) {
      const res = tagGet(p, "GET /api/media/<id>/raw");
      check(res, { "media 2xx": (x) => x.status >= 200 && x.status < 300 });
    } else {
      tagGet(`/api/discover?limit=6`, "GET /api/discover");
    }
  } else if (r < 85) {
    if (data.usernames.length > 0) {
      const u = data.usernames[Math.floor(Math.random() * data.usernames.length)];
      const res = tagGet(`/u/${encodeURIComponent(u)}`, "GET /u/<username>");
      check(res, { "shell 200 + html": (x) => x.status === 200 && x.body.indexOf("<") !== -1 });
    } else {
      tagGet(`/api/discover?limit=6`, "GET /api/discover"); // no public profiles in DB — degrade
    }
  } else if (r < 95) {
    const res = tagGet(`/api/professions`, "GET /api/professions");
    check(res, { "professions 200": (x) => x.status === 200 });
  } else {
    const res = tagGet(Math.random() < 0.5 ? `/api/health` : `/api/ready`, "GET /api/health");
    check(res, { "ops 200": (x) => x.status === 200 });
  }

  // Arrival-rate executor owns pacing; a short think time keeps VU behaviour human-ish.
  sleep(Math.random() * 0.3);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    [__ENV.SUMMARY_JSON || "/tmp/k6-browse-summary.json"]: JSON.stringify(
      { scenario: "browse", thresholds: options.thresholds, metrics: pickMetrics(data) },
      null,
      2
    ),
  };
}

function pickMetrics(d) {
  const out = {};
  for (const [k, v] of Object.entries(d.metrics || {})) {
    if (["http_req_duration", "http_reqs", "bean_browse_hard_errors", "bean_browse_429", "checks"].includes(k)) {
      out[k] = v.values ? { p95: v.values["p(95)"], avg: v.values.avg, rate: v.values.rate, count: v.values.count } : v;
    }
  }
  return out;
}
