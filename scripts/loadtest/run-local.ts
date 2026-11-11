#!/usr/bin/env bun
/**
 * BEAN Folio — dependency-free LOCAL load runner (Bun, node:http stdlib only).
 * ---------------------------------------------------------------------------
 * Purpose: a small, safe load generator for the sandbox/dev box where k6 is
 * NOT installed (k6 is deliberately not a project dependency — the k6
 * scenarios in ./k6/ are for staging/CI hosts that have it).
 *
 * Sandbox reality (measured on this machine): 2 vCPU, 3.9 GiB RAM — therefore:
 *   • scenarios run SEQUENTIALLY, never concurrently;
 *   • MAX_VU defaults to 200 (override warns; see workloads.md for tier math);
 *   • ramp shape is warm-up → 10 → 50 → 100 → 200 VUs (clipped to MAX_VU).
 *
 * Safety rails:
 *   • default scenarios are read-only (browse, search, reads);
 *   • `publish` only runs when explicitly selected AND only against the
 *     dedicated QA fixture account (scripts/restore-qa-fixtures.ts);
 *   • AI generation is NOT part of this runner at all (k6-only, GEN_ENABLED);
 *   • login limiter is 10/min per client key → logins are globally spaced ≥6.5 s;
 *   • per-request timeouts + global run timeout; sockets are always destroyed;
 *   • `--dry-run` validates reachability and credentials without writes.
 *
 * Usage:
 *   bun scripts/loadtest/run-local.ts --help
 *   bun scripts/loadtest/run-local.ts --dry-run
 *   bun scripts/loadtest/run-local.ts --scenarios=browse,search --max-vu=100
 *
 * Results: scripts/loadtest/results/<timestamp>.md + .json
 */

import http from "node:http";
import https from "node:https";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// CLI / configuration
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(SCRIPT_DIR, "results");

const USAGE = `
BEAN Folio local load runner (bun, stdlib only)

USAGE
  bun scripts/loadtest/run-local.ts [flags]

FLAGS
  --help                  Show this help and exit (no side effects).
  --dry-run               Validate endpoint reachability + credentials, then exit.
                          No load, no writes (publish is only credential-checked).
  --scenarios=LIST        Comma list from: browse,search,auth,reads,publish
                          Default: "browse,search,reads" (read-only set)
                          publish is a WRITE — opt-in only.
  --max-vu=N              VU cap across phases (default 200; sandbox is 2 vCPU —
                          going far above 200 will measure the load gen, not the app).
  --duration-s=N          Duration of each ramp phase in seconds (default 30).
  --warmup-s=N            Warm-up phase duration (default 20).
  --base-url=URL          Default http://localhost:3000 (dev server).
  --out-dir=DIR           Default ${RESULTS_DIR}

ENV (same meaning as flags)
  SCENARIOS, MAX_VU, DURATION_S, WARMUP_S, BASE_URL
  AUTH_EMAIL / AUTH_PASSWORD        account for the auth + reads scenarios
                                    (default: seeded demo account, scripts/seed.ts)
  PUBLISH_EMAIL / PUBLISH_PASSWORD  dedicated publish fixture account
                                    (default: pub-e2e-1027@beanfolio.test,
                                     password from scripts/restore-qa-fixtures.ts)
  THRESHOLD_P95_MS (500) / THRESHOLD_P95_WRITE_MS (1000) / THRESHOLD_ERROR_RATE (0.001)
  RUN_TIMEOUT_S (3600)              global watchdog — run aborts (gracefully) past it

EXAMPLES
  bun scripts/loadtest/run-local.ts --dry-run
  bun scripts/loadtest/run-local.ts
  bun scripts/loadtest/run-local.ts --scenarios=browse,search,reads --max-vu=50 --duration-s=20
  bun scripts/loadtest/run-local.ts --scenarios=auth          # ~8 logins/min, single bucket
  bun scripts/loadtest/run-local.ts --scenarios=publish       # dedicated fixture account only

NOTES
  • Targets, not guarantees: p95<500ms public reads, p95<1s writes, err<0.1%.
  • 429s are EXPECTED under documented limiters (login 10/min/IP,
    publish 20/min/user) and are tracked separately — never counted as success.
  • Never run the publish scenario against real user data.
`;

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    out[m[1]] = m[2] ?? "true";
  }
  return out;
}

const flags = parseFlags(process.argv.slice(2));

if (flags["help"]) {
  process.stdout.write(USAGE + "\n");
  process.exit(0);
}

const DRY_RUN = flags["dry-run"] === "true" || process.env.DRY_RUN === "1";
const BASE_URL = (flags["base-url"] ?? process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const MAX_VU = clampInt(flags["max-vu"] ?? process.env.MAX_VU ?? "200", 1, 10_000);
const DURATION_S = clampInt(flags["duration-s"] ?? process.env.DURATION_S ?? "30", 5, 3600);
const WARMUP_S = clampInt(flags["warmup-s"] ?? process.env.WARMUP_S ?? "20", 0, 3600);
const RUN_TIMEOUT_S = clampInt(process.env.RUN_TIMEOUT_S ?? "3600", 30, 86_400);
const THRESHOLD_P95_MS = Number(process.env.THRESHOLD_P95_MS ?? 500);
const THRESHOLD_P95_WRITE_MS = Number(process.env.THRESHOLD_P95_WRITE_MS ?? 1000);
const THRESHOLD_ERROR_RATE = Number(process.env.THRESHOLD_ERROR_RATE ?? 0.001);
const OUT_DIR = flags["out-dir"] ? path.resolve(flags["out-dir"]) : RESULTS_DIR;

const AUTH_EMAIL = process.env.AUTH_EMAIL ?? "demo@beanfolio.app";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD ?? "demo1234"; // scripts/seed.ts
const PUBLISH_EMAIL = process.env.PUBLISH_EMAIL ?? "pub-e2e-1027@beanfolio.test"; // scripts/restore-qa-fixtures.ts
const PUBLISH_PASSWORD = process.env.PUBLISH_PASSWORD ?? "qa-fixture-password";

/** Seeded fixture identities (scripts/seed.ts) — round-robin across reads VUs. */
const READS_ACCOUNTS: Array<[string, string]> = [
  [AUTH_EMAIL, AUTH_PASSWORD],
  ["darius@beanfolio.app", "darius-demo"],
  ["priya@beanfolio.app", "priya-demo"],
  ["kofi@beanfolio.app", "kofi-demo1"],
  ["lena@beanfolio.app", "lena-demo1"],
  ["theo@beanfolio.app", "theo-demo1"],
  ["ines@beanfolio.app", "ines-demo1"],
  ["marco@beanfolio.app", "marco-demo"],
];

const scenarioArg = (flags["scenarios"] ?? process.env.SCENARIOS ?? "browse,search,reads")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const VALID = ["browse", "search", "auth", "reads", "publish"] as const;
type ScenarioName = (typeof VALID)[number];
for (const s of scenarioArg) {
  if (!VALID.includes(s as ScenarioName)) {
    process.stderr.write(`Unknown scenario "${s}". Valid: ${VALID.join(", ")}\n`);
    process.stderr.write(USAGE + "\n");
    process.exit(1);
  }
}
const SCENARIOS = [...new Set(scenarioArg)] as ScenarioName[];

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

let logStart = Date.now();
function log(msg: string): void {
  const t = ((Date.now() - logStart) / 1000).toFixed(1).padStart(7);
  process.stdout.write(`[${t}s] ${msg}\n`);
}
function warn(msg: string): void {
  process.stdout.write(`  ! ${msg}\n`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function clampInt(v: string | number, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------------------------------------------------------------------------
// HTTP core — node:http with a keep-alive agent; every request is bounded by a
// timeout that destroys the socket, so the run can never leak connections.
// ---------------------------------------------------------------------------

const agentOptions: http.AgentOptions = {
  keepAlive: true,
  keepAliveMsecs: 10_000,
  maxSockets: Math.max(64, MAX_VU),
  maxFreeSockets: 64,
  scheduling: "lifo",
};
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent({ ...agentOptions } as https.AgentOptions);

interface ReqResult {
  status: number; // 0 = network/timeout failure
  ms: number;
  bytes: number;
  setCookies: string[];
  bodyHead: string;
  error?: string;
}

const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS ?? 10_000);

function request(opts: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<ReqResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(BASE_URL + opts.path);
    } catch {
      resolve({ status: 0, ms: 0, bytes: 0, setCookies: [], bodyHead: "", error: "bad url" });
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const timeoutMs = opts.timeoutMs ?? REQ_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? 2_000_000;
    const t0 = performance.now();

    let settled = false;
    const finish = (r: ReqResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const req = mod.request(
      url,
      {
        method: opts.method,
        agent: url.protocol === "https:" ? httpsAgent : httpAgent,
        headers: {
          "accept-encoding": "identity", // measure origin work, not gzip on the load gen
          connection: "keep-alive",
          ...(opts.body ? { "content-type": "application/json", "content-length": Buffer.byteLength(opts.body).toString() } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total <= maxBytes) chunks.push(c as Buffer);
          else res.destroy(); // cap memory: enough body to validate, no more
        });
        const done = () => {
          finish({
            status: res.statusCode ?? 0,
            ms: performance.now() - t0,
            bytes: total,
            setCookies: (res.headers["set-cookie"] as string[] | undefined) ?? [],
            bodyHead: Buffer.concat(chunks).toString("utf8", 0, 8_192),
          });
        };
        res.on("end", done);
        // 'close' fires for BOTH normal completion and aborted/destroyed
        // responses (e.g. the byte-cap destroy above). Without it a destroyed
        // stream that never emits 'end'/'error' would wedge this promise and
        // let the event loop drain — the settled guard makes it a safe no-op
        // when 'end' already fired.
        res.on("close", done);
        res.on("error", () =>
          finish({
            status: res.statusCode ?? 0,
            ms: performance.now() - t0,
            bytes: total,
            setCookies: [],
            bodyHead: "",
            error: "response stream error",
          })
        );
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", (e: Error) =>
      finish({ status: 0, ms: performance.now() - t0, bytes: 0, setCookies: [], bodyHead: "", error: e.message })
    );
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Sessions — login is rate-limited 10/min per client key, and every VU on this
// box shares ONE key. So: logins are serialized and globally spaced ≥ 6.5 s,
// sessions are cached per account for the whole run, and 429 retries back off.
// ---------------------------------------------------------------------------

const sessionCookie = new Map<string, string>(); // email -> "bean_session=..."
let lastLoginAt = 0;
const LOGIN_SPACING_MS = 6_500;

async function login(email: string, password: string, opts?: { fresh?: boolean }): Promise<{ status: number; cookie: string | null; ms: number }> {
  if (!opts?.fresh && sessionCookie.has(email)) {
    return { status: 200, cookie: sessionCookie.get(email)!, ms: 0 };
  }
  // Global spacing queue: wait until ≥ LOGIN_SPACING_MS since the last login.
  const wait = lastLoginAt + LOGIN_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastLoginAt = Date.now();

  const res = await request({
    method: "POST",
    path: "/api/auth/login",
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 200) {
    const sc = res.setCookies.find((c) => c.startsWith("bean_session="));
    if (sc) {
      const cookie = sc.split(";")[0];
      sessionCookie.set(email, cookie);
      return { status: 200, cookie, ms: res.ms };
    }
    return { status: 200, cookie: null, ms: res.ms };
  }
  return { status: res.status, cookie: null, ms: res.ms };
}

/** Ensure a cached session, retrying (spaced) on 429; give up after 3 attempts. */
async function ensureSession(email: string, password: string): Promise<string | null> {
  if (sessionCookie.has(email)) return sessionCookie.get(email)!;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await login(email, password, { fresh: true });
    if (r.cookie) return r.cookie;
    if (r.status === 429) {
      warn(`login 429 for ${email} — limiter spacing, retrying in 10s`);
      await sleep(10_000);
      continue;
    }
    warn(`login failed for ${email} (status ${r.status})`);
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface EndpointStat {
  count: number;
  errors: number; // network + 5xx
  client4xx: number;
  rateLimited: number;
  latencies: number[];
}

class PhaseMetrics {
  count = 0;
  errors = 0;
  client4xx = 0;
  rateLimited = 0;
  latencies: number[] = [];
  statusHist = new Map<number, number>();
  endpoints = new Map<string, EndpointStat>();

  record(endpoint: string, status: number, ms: number): void {
    this.count += 1;
    this.latencies.push(ms);
    this.statusHist.set(status, (this.statusHist.get(status) ?? 0) + 1);
    let st = this.endpoints.get(endpoint);
    if (!st) {
      st = { count: 0, errors: 0, client4xx: 0, rateLimited: 0, latencies: [] };
      this.endpoints.set(endpoint, st);
    }
    st.count += 1;
    st.latencies.push(ms);
    if (status === 0 || status >= 500) {
      this.errors += 1;
      st.errors += 1;
    } else if (status === 429) {
      this.rateLimited += 1;
      st.rateLimited += 1;
    } else if (status >= 400) {
      this.client4xx += 1;
      st.client4xx += 1;
    }
  }

  quantiles(): { p50: number; p95: number; p99: number } {
    const s = [...this.latencies].sort((a, b) => a - b);
    const q = (p: number) => (s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(p * s.length))]);
    return { p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), p99: Math.round(q(0.99)) };
  }
}

function quantileOf(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
}

// ---------------------------------------------------------------------------
// Scenario context
// ---------------------------------------------------------------------------

interface PhaseResult {
  label: string;
  vus: number;
  durationS: number;
  metrics: PhaseMetrics;
}

const globalStop = { value: false };

/** Shared state harvested once per run (real ids — nothing synthetic).
 *  NOTE: demo personas are isDemo:true and are NEVER publicly visible by
 *  design (lib/visibility.ts) — anonymous profile requests for them 404, so
 *  the public username list starts EMPTY and is filled from real public data
 *  (discover + creators). If it stays empty, profile/shell shares degrade to
 *  discover requests instead of generating deliberate 404 noise. */
const fixture = {
  usernames: [] as string[],
  mediaPaths: [] as string[],
};

async function harvestFixtures(): Promise<void> {
  const res = await request({ method: "GET", path: "/api/discover?limit=24", timeoutMs: 10_000 });
  if (res.status === 200) {
    try {
      const json = JSON.parse(res.bodyHead) as {
        items?: Array<{ coverUrl?: string; avatarUrl?: string; owner?: { username?: string } }>;
      };
      for (const it of json.items ?? []) {
        if (it.coverUrl) fixture.mediaPaths.push(it.coverUrl);
        if (it.avatarUrl) fixture.mediaPaths.push(it.avatarUrl);
        if (it.owner?.username) fixture.usernames.push(it.owner.username);
      }
    } catch {
      /* keep seeded fallbacks */
    }
  }
  const creators = await request({ method: "GET", path: "/api/discover/creators?limit=24", timeoutMs: 10_000 });
  if (creators.status === 200) {
    try {
      const json = JSON.parse(creators.bodyHead) as { items?: Array<{ username?: string }> };
      for (const it of json.items ?? []) if (it.username) fixture.usernames.push(it.username);
    } catch {
      /* usernames stay as harvested from discover */
    }
  }
  fixture.usernames = [...new Set(fixture.usernames)];
  fixture.mediaPaths = [...new Set(fixture.mediaPaths)];
  log(`fixtures: ${fixture.mediaPaths.length} media paths, ${fixture.usernames.length} public usernames`);
  if (fixture.usernames.length === 0) {
    warn("no PUBLIC profile fixtures visible anonymously (demo profiles are excluded by design) — " +
      "profile/shell share degrades to discover; run scripts/seed.ts to populate public data.");
  }
}

// --- scenario action helpers -------------------------------------------------

async function get(vu: VU, endpoint: string, p: string, timeoutMs?: number): Promise<ReqResult> {
  const res = await request({ method: "GET", path: p, timeoutMs });
  vu.metrics.record(endpoint, res.status, res.ms);
  return res;
}

// --- scenarios ---------------------------------------------------------------

interface VU {
  index: number;
  metrics: PhaseMetrics;
  cookie: string | null;
}

interface ScenarioDef {
  name: ScenarioName;
  /** Fraction of MAX_VU this scenario may use (fixed-VU scenarios ignore it). */
  vuScale: number;
  fixedStages?: number[];
  needsAuth?: boolean;
  /** Per-iteration think time bounds (seconds). */
  think: [number, number];
  describe: string;
  act: (vu: VU) => Promise<void>;
}

const SEARCH_TERMS = ["photography", "film", "culinary", "illustration", "motion", "brand", "dashboard", "product", "priya", "marco", "lena", "bean"];
const CATEGORIES = ["photography", "film-design", "culinary-arts", "visual-arts"];

const browse: ScenarioDef = {
  name: "browse",
  vuScale: 1.0,
  think: [0.05, 0.35],
  describe: "public read mix: discover 40% / profile 20% / media 15% / shell 10% / professions 10% / ops 5%",
  async act(vu) {
    const r = Math.random() * 100;
    if (r < 40) {
      const cursor = Math.floor(Math.random() * 4) * 12;
      await get(vu, "GET /api/discover", `/api/discover?limit=12&cursor=${cursor}`);
    } else if (r < 60) {
      if (fixture.usernames.length > 0) {
        const u = encodeURIComponent(pick(fixture.usernames));
        await get(vu, "GET /api/profiles/<username>", `/api/profiles/${u}`);
      } else {
        await get(vu, "GET /api/discover", "/api/discover?limit=12"); // no public profiles in DB — degrade
      }
    } else if (r < 75) {
      if (fixture.mediaPaths.length > 0) {
        await get(vu, "GET /api/media/<id>/raw", pick(fixture.mediaPaths), 15_000);
      } else {
        await get(vu, "GET /api/discover", "/api/discover?limit=6");
      }
    } else if (r < 85) {
      if (fixture.usernames.length > 0) {
        const u = encodeURIComponent(pick(fixture.usernames));
        await get(vu, "GET /u/<username>", `/u/${u}`, 15_000);
      } else {
        await get(vu, "GET /api/discover", "/api/discover?limit=6"); // no public profiles in DB — degrade
      }
    } else if (r < 95) {
      await get(vu, "GET /api/professions", "/api/professions");
    } else {
      await get(vu, "GET /api/health", Math.random() < 0.5 ? "/api/health" : "/api/ready");
    }
  },
};

const search: ScenarioDef = {
  name: "search",
  vuScale: 0.25,
  think: [0.05, 0.45],
  describe: "search: 70% /api/search/projects, 30% /api/search/profiles (seed-matched terms)",
  async act(vu) {
    const term = encodeURIComponent(pick(SEARCH_TERMS));
    if (Math.random() < 0.7) {
      let p = `/api/search/projects?q=${term}`;
      if (Math.random() < 0.3) p += `&category=${encodeURIComponent(pick(CATEGORIES))}`;
      if (Math.random() < 0.4) p += `&sort=${Math.random() < 0.5 ? "recent" : "saved"}`;
      await get(vu, "GET /api/search/projects", p);
    } else {
      await get(vu, "GET /api/search/profiles", `/api/search/profiles?q=${term}`);
    }
  },
};

const auth: ScenarioDef = {
  name: "auth",
  vuScale: 0,
  fixedStages: [1, 2, 2, 2],
  think: [15, 16.5], // 2 VUs × ~15s ⇒ ≈ 8 logins/min — under the 10/min/IP limiter
  describe: "fresh login + /api/auth/me per iteration (≈8 logins/min; 429 expected if oversubscribed)",
  async act(vu) {
    const r = await login(AUTH_EMAIL, AUTH_PASSWORD, { fresh: true });
    vu.metrics.record("POST /api/auth/login", r.status === 200 ? 200 : r.status, r.ms || 0);
    if (r.cookie) {
      const me = await request({ method: "GET", path: "/api/auth/me", headers: { cookie: r.cookie } });
      vu.metrics.record("GET /api/auth/me", me.status, me.ms);
    }
  },
};

const reads: ScenarioDef = {
  name: "reads",
  vuScale: 0.1,
  needsAuth: true,
  think: [1, 3],
  describe: "authenticated reads: /api/auth/me → /api/me/site → /api/projects → /api/me/insights/overview",
  async act(vu) {
    const headers: Record<string, string> = vu.cookie ? { cookie: vu.cookie } : {};
    const me = await request({ method: "GET", path: "/api/auth/me", headers });
    vu.metrics.record("GET /api/auth/me", me.status, me.ms);
    if (me.status === 401 && vu.cookie) {
      vu.cookie = null; // session died — re-acquire on the next iteration
    }
    await get(vu, "GET /api/me/site", "/api/me/site");
    await get(vu, "GET /api/projects", "/api/projects");
    await get(vu, "GET /api/me/insights/overview", "/api/me/insights/overview");
  },
};

const publishState = { preconditionFailed: false };

const publish: ScenarioDef = {
  name: "publish",
  vuScale: 0,
  fixedStages: [1, 1, 1, 1],
  needsAuth: true,
  think: [8, 8.8], // ≤ ~10 publish cycles/min (limiter: 20/min/user)
  describe: "publish↔unpublish toggle on the DEDICATED fixture account (writes — opt-in)",
  async act(vu) {
    if (publishState.preconditionFailed) {
      await sleep(2_000);
      return;
    }
    const headers: Record<string, string> = vu.cookie ? { cookie: vu.cookie } : {};
    const pub = await request({ method: "POST", path: "/api/me/site/publish", headers });
    vu.metrics.record("POST /api/me/site/publish", pub.status, pub.ms);
    if (pub.status === 429) {
      await sleep(30_000); // limiter cooldown — do not fight it
      return;
    }
    if (pub.status === 400) {
      publishState.preconditionFailed = true;
      warn("publish precondition failed (400): fixture account needs a SAVED draft — scenario stops. " + pub.bodyHead.slice(0, 160));
      return;
    }
    if (pub.status === 401) {
      vu.cookie = null;
      return;
    }
    const un = await request({ method: "POST", path: "/api/me/site/unpublish", headers });
    vu.metrics.record("POST /api/me/site/unpublish", un.status, un.ms);
    if (un.status === 429) await sleep(30_000);
  },
};

const SCENARIO_DEFS: Record<ScenarioName, ScenarioDef> = { browse, search, auth, reads, publish };

// ---------------------------------------------------------------------------
// Engine — sequential phases, each with its own VU pool and deadline
// ---------------------------------------------------------------------------

function stagesFor(sc: ScenarioDef): Array<{ vus: number; durationS: number }> {
  const base = sc.fixedStages ?? [10, 50, 100, 200];
  const scaleVus = base.map((v) => {
    const scaled = sc.fixedStages ? v : Math.max(1, Math.round(v * sc.vuScale));
    return Math.min(Math.max(1, scaled), MAX_VU);
  });
  const stages: Array<{ vus: number; durationS: number }> = [];
  // Warm-up at ~half the first stage's size.
  const warmVus = Math.max(1, Math.round(scaleVus[0] * 0.5));
  if (WARMUP_S > 0) stages.push({ vus: Math.min(warmVus, MAX_VU), durationS: WARMUP_S });
  for (const v of scaleVus) {
    const prev = stages[stages.length - 1];
    if (prev && prev.vus === v) prev.durationS += DURATION_S; // merge clipped duplicates
    else stages.push({ vus: v, durationS: DURATION_S });
  }
  return stages;
}

async function runPhase(sc: ScenarioDef, stage: { vus: number; durationS: number }, phaseNo: number, phaseTotal: number): Promise<PhaseResult> {
  log(`▶ ${sc.name} phase ${phaseNo}/${phaseTotal}: ${stage.vus} VUs × ${stage.durationS}s`);
  const metrics = new PhaseMetrics();
  const deadline = Date.now() + stage.durationS * 1000;

  // Per-VU auth bootstrap (login spacing is global, so VUs may start staggered).
  const accounts = READS_ACCOUNTS.slice(0, Math.min(READS_ACCOUNTS.length, Math.max(2, Math.ceil(stage.vus / 5))));
  const vus: VU[] = [];
  for (let i = 0; i < stage.vus; i++) {
    vus.push({ index: i, metrics, cookie: null });
  }
  if (sc.needsAuth) {
    if (sc.name === "publish") {
      const cookie = await ensureSession(PUBLISH_EMAIL, PUBLISH_PASSWORD);
      for (const vu of vus) vu.cookie = cookie;
      if (!cookie) warn("publish: no session — iterations will record 401s");
    } else {
      await Promise.all(
        vus.map(async (vu) => {
          const [email, password] = accounts[vu.index % accounts.length];
          vu.cookie = await ensureSession(email, password);
        })
      );
    }
  }

  const loops = vus.map(async (vu) => {
    while (Date.now() < deadline && !globalStop.value) {
      try {
        await sc.act(vu);
      } catch (e) {
        metrics.record(`${sc.name}:internal`, 0, 0);
        warn(`vu#${vu.index} act error: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (Date.now() >= deadline || globalStop.value) break;
      await sleep(rand(sc.think[0], sc.think[1]) * 1000);
    }
  });

  const started = performance.now();
  await Promise.all(loops);
  const wallS = (performance.now() - started) / 1000;

  const rps = metrics.count / Math.max(wallS, 0.001);
  const q = metrics.quantiles();
  const errRate = metrics.count > 0 ? metrics.errors / metrics.count : 0;
  log(
    `■ ${sc.name} phase ${phaseNo}/${phaseTotal}: ${metrics.count} reqs, ${rps.toFixed(1)} rps, ` +
      `p50=${q.p50}ms p95=${q.p95}ms p99=${q.p99}ms, err=${(errRate * 100).toFixed(2)}%, 429=${metrics.rateLimited}`
  );
  return { label: `${stage.vus} VUs`, vus: stage.vus, durationS: stage.durationS, metrics };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface PhaseReport {
  label: string;
  vus: number;
  durationS: number;
  requests: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  hardErrors: number;
  errorRate: number;
  client4xx: number;
  rateLimited429: number;
  verdict: "PASS" | "FAIL" | "n/a";
  statusHist: Record<string, number>;
  endpoints: Array<{ endpoint: string; count: number; p50: number; p95: number; hardErrors: number; client4xx: number; rateLimited: number }>;
}

function phaseReport(p: PhaseResult, writeSlo: boolean): PhaseReport {
  const wallS = p.durationS;
  const q = p.metrics.quantiles();
  const errorRate = p.metrics.count ? p.metrics.errors / p.metrics.count : 0;
  const p95Slo = writeSlo ? THRESHOLD_P95_WRITE_MS : THRESHOLD_P95_MS;
  const verdict: PhaseReport["verdict"] =
    p.metrics.count === 0 ? "n/a" : errorRate <= THRESHOLD_ERROR_RATE && q.p95 <= p95Slo ? "PASS" : "FAIL";
  return {
    label: p.label,
    vus: p.vus,
    durationS: p.durationS,
    requests: p.metrics.count,
    rps: Number((p.metrics.count / wallS).toFixed(1)),
    p50: q.p50,
    p95: q.p95,
    p99: q.p99,
    hardErrors: p.metrics.errors,
    errorRate: Number(errorRate.toFixed(5)),
    client4xx: p.metrics.client4xx,
    rateLimited429: p.metrics.rateLimited,
    verdict,
    statusHist: Object.fromEntries([...p.metrics.statusHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
    endpoints: [...p.metrics.endpoints.entries()].map(([endpoint, st]) => ({
      endpoint,
      count: st.count,
      p50: quantileOf(st.latencies, 0.5),
      p95: quantileOf(st.latencies, 0.95),
      hardErrors: st.errors,
      client4xx: st.client4xx,
      rateLimited: st.rateLimited,
    })),
  };
}

interface RunReport {
  meta: {
    tool: "run-local.ts (bun, stdlib)";
    startedAt: string;
    finishedAt: string;
    partial: boolean;
    dryRun: boolean;
    scenarios: string[];
  };
  environment: { platform: string; cpus: number; totalMemGiB: number; bun: string };
  config: Record<string, unknown>;
  credentialsUsed: { auth: string; publish: string };
  scenarios: Array<{ name: string; describe: string; phases: PhaseReport[] }>;
  totals: { requests: number; hardErrors: number; rateLimited429: number; client4xx: number };
  thresholdBreach: boolean;
  notes: string[];
}

function buildReport(startedAt: string, partial: boolean, scenarioRuns: Array<{ name: string; describe: string; phases: PhaseReport[] }>): RunReport {
  const totals = { requests: 0, hardErrors: 0, rateLimited429: 0, client4xx: 0 };
  let breach = false;
  for (const s of scenarioRuns) {
    for (const p of s.phases) {
      totals.requests += p.requests;
      totals.hardErrors += p.hardErrors;
      totals.rateLimited429 += p.rateLimited429;
      totals.client4xx += p.client4xx;
      if (p.verdict === "FAIL") breach = true;
    }
  }
  const notes: string[] = [];
  if (publishState.preconditionFailed) notes.push("publish scenario stopped early: fixture account has no saved draft (400).");
  if (totals.rateLimited429 > 0) notes.push(`${totals.rateLimited429} responses were 429 — expected under documented limiters (login 10/min/IP, publish 20/min/user); tracked, not counted as success or hard error.`);
  if (partial) notes.push("RUN WAS PARTIAL: global timeout or SIGINT — numbers below are incomplete.");
  if (MAX_VU > 200) notes.push(`MAX_VU=${MAX_VU} exceeds the sandbox default of 200 — on a 2 vCPU box you may be measuring the load generator.`);
  if (fixture.mediaPaths.length === 0) notes.push("No media paths harvested from /api/discover — browse mix redistributed that share to discover.");
  if (fixture.usernames.length === 0) notes.push("No public profile fixtures visible anonymously (demo profiles are excluded by design) — browse profile/shell shares were served as discover requests.");

  return {
    meta: {
      tool: "run-local.ts (bun, stdlib)",
      startedAt,
      finishedAt: new Date().toISOString(),
      partial,
      dryRun: DRY_RUN,
      scenarios: SCENARIOS,
    },
    environment: {
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpus: os.cpus().length,
      totalMemGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)),
      bun: typeof Bun !== "undefined" ? Bun.version ?? "unknown" : process.version,
    },
    config: {
      baseUrl: BASE_URL,
      maxVu: MAX_VU,
      durationPerPhaseS: DURATION_S,
      warmupS: WARMUP_S,
      runTimeoutS: RUN_TIMEOUT_S,
      slo: { publicP95Ms: THRESHOLD_P95_MS, writeP95Ms: THRESHOLD_P95_WRITE_MS, hardErrorRate: THRESHOLD_ERROR_RATE },
    },
    credentialsUsed: { auth: AUTH_EMAIL, publish: PUBLISH_EMAIL },
    scenarios: scenarioRuns,
    totals,
    thresholdBreach: breach,
    notes,
  };
}

function markdownReport(r: RunReport): string {
  const L: string[] = [];
  L.push(`# BEAN Folio — local load run (${r.meta.startedAt})`);
  L.push("");
  L.push(`> Targets, not guarantees. SLO definitions: docs/ops/LOAD_TESTING.md · declared workloads: scripts/loadtest/workloads.md`);
  L.push("");
  L.push(`- Base URL: \`${r.config.baseUrl}\`  ·  partial: **${r.meta.partial}**  ·  dry-run: **${r.meta.dryRun}**`);
  L.push(`- Environment: ${r.environment.platform} — **${r.environment.cpus} vCPU** / ${r.environment.totalMemGiB} GiB RAM (bun ${r.environment.bun})`);
  L.push(`- Scenarios: ${r.meta.scenarios.join(", ")}  ·  MAX_VU=${r.config.maxVu}  ·  ${r.config.durationPerPhaseS}s/phase + ${r.config.warmupS}s warm-up`);
  L.push(`- Credentials: auth \`${r.credentialsUsed.auth}\` · publish \`${r.credentialsUsed.publish}\` (fixture accounts only)`);
  L.push("");
  for (const s of r.scenarios) {
    L.push(`## ${s.name}`);
    L.push(`_${s.describe}_`);
    L.push("");
    L.push(`| Phase | Reqs | RPS | p50 | p95 | p99 | hardErr | err% | 429 | 4xx | Verdict |`);
    L.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const p of s.phases) {
      L.push(
        `| ${p.label} | ${p.requests} | ${p.rps} | ${p.p50}ms | ${p.p95}ms | ${p.p99}ms | ${p.hardErrors} | ` +
          `${(p.errorRate * 100).toFixed(2)}% | ${p.rateLimited429} | ${p.client4xx} | ${p.verdict} |`
      );
    }
    L.push("");
    const ep = s.phases.at(-1)?.endpoints ?? [];
    if (ep.length > 0) {
      L.push(`Endpoint breakdown (final phase):`);
      L.push("");
      L.push(`| Endpoint | Count | p50 | p95 | hardErr | 4xx | 429 |`);
      L.push(`|---|---|---|---|---|---|---|`);
      for (const e of ep) {
        L.push(`| ${e.endpoint} | ${e.count} | ${e.p50}ms | ${e.p95}ms | ${e.hardErrors} | ${e.client4xx} | ${e.rateLimited} |`);
      }
      L.push("");
    }
    const hist = s.phases.at(-1)?.statusHist;
    if (hist && Object.keys(hist).length > 0) {
      L.push(`Status histogram (final phase): ${Object.entries(hist).map(([k, v]) => `${k}×${v}`).join(", ")}`);
      L.push("");
    }
  }
  L.push(`## Totals`);
  L.push("");
  L.push(`- Requests: **${r.totals.requests}**  ·  hard errors: ${r.totals.hardErrors}  ·  429: ${r.totals.rateLimited429}  ·  other 4xx: ${r.totals.client4xx}`);
  L.push(`- Threshold breach: **${r.thresholdBreach ? "YES (see FAIL rows)" : "no"}**`);
  L.push("");
  if (r.notes.length > 0) {
    L.push(`## Notes`);
    L.push("");
    for (const n of r.notes) L.push(`- ${n}`);
    L.push("");
  }
  L.push(`## RESULTS — measured in sandbox`);
  L.push("");
  L.push(`- [ ] Full-scale staging run (k6): **not yet performed — see \`docs/ops/LOAD_TESTING.md#results\` placeholders.**`);
  L.push(`- [ ] CDN/edge-cache share at T2+: **not measured in sandbox** (no CDN in front of localhost).`);
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Dry-run — reachability + credential validation (sequential, no load)
// ---------------------------------------------------------------------------

interface Check {
  label: string;
  run: () => Promise<{ status: number; note?: string }>;
}

async function dryRun(): Promise<number> {
  log(`dry-run: validating ${BASE_URL} reachability (sequential, no load, no writes)`);
  await harvestFixtures();
  // Public profile probe: harvest first, PROBE_USERNAME overrides, skip if none.
  const probeUser = process.env.PROBE_USERNAME ?? fixture.usernames[0] ?? null;
  const checks: Check[] = [
    { label: "GET  /api/health", run: async () => ({ status: (await request({ method: "GET", path: "/api/health" })).status }) },
    { label: "GET  /api/ready", run: async () => ({ status: (await request({ method: "GET", path: "/api/ready" })).status }) },
    { label: "GET  /api/discover?limit=1", run: async () => ({ status: (await request({ method: "GET", path: "/api/discover?limit=1" })).status }) },
    { label: "GET  /api/discover/creators?limit=1", run: async () => ({ status: (await request({ method: "GET", path: "/api/discover/creators?limit=1" })).status }) },
    { label: "GET  /api/professions", run: async () => ({ status: (await request({ method: "GET", path: "/api/professions" })).status }) },
    { label: "GET  /api/search/projects?q=bean", run: async () => ({ status: (await request({ method: "GET", path: "/api/search/projects?q=bean" })).status }) },
    { label: "GET  /api/search/profiles?q=bean", run: async () => ({ status: (await request({ method: "GET", path: "/api/search/profiles?q=bean" })).status }) },
    probeUser
      ? { label: `GET  /api/profiles/${probeUser}`, run: async () => ({ status: (await request({ method: "GET", path: `/api/profiles/${encodeURIComponent(probeUser)}` })).status }) }
      : { label: "GET  /api/profiles/<username>", run: async () => ({ status: 0, note: "SKIP — no public profile fixture available (PROBE_USERNAME env to override)" }) },
    probeUser
      ? {
          label: `GET  /u/${probeUser} (SPA shell)`,
          run: async () => {
            const r = await request({ method: "GET", path: `/u/${encodeURIComponent(probeUser)}` });
            return { status: r.status, note: r.bodyHead.includes("<") ? "html ok" : "no html?" };
          },
        }
      : { label: "GET  /u/<username> (SPA shell)", run: async () => ({ status: 0, note: "SKIP — no public profile fixture available" }) },
    {
      label: `POST /api/auth/login (${AUTH_EMAIL}) [fixture]`,
      run: async () => {
        const r = await login(AUTH_EMAIL, AUTH_PASSWORD, { fresh: true });
        return { status: r.status, note: r.cookie ? "cookie ok" : "no bean_session cookie" };
      },
    },
    {
      label: `POST /api/auth/login (${PUBLISH_EMAIL}) [fixture, creds only]`,
      run: async () => {
        const r = await login(PUBLISH_EMAIL, PUBLISH_PASSWORD, { fresh: true });
        return { status: r.status, note: r.cookie ? "cookie ok" : "no cookie" };
      },
    },
    {
      label: "GET  /api/auth/me (authed)",
      run: async () => {
        const c = sessionCookie.get(AUTH_EMAIL);
        const r = await request({ method: "GET", path: "/api/auth/me", headers: c ? { cookie: c } : {} });
        return { status: r.status };
      },
    },
    {
      label: "GET  /api/me/site (authed)",
      run: async () => {
        const c = sessionCookie.get(AUTH_EMAIL);
        const r = await request({ method: "GET", path: "/api/me/site", headers: c ? { cookie: c } : {} });
        return { status: r.status };
      },
    },
    {
      label: "GET  /api/projects (authed)",
      run: async () => {
        const c = sessionCookie.get(AUTH_EMAIL);
        const r = await request({ method: "GET", path: "/api/projects", headers: c ? { cookie: c } : {} });
        return { status: r.status };
      },
    },
    {
      label: "GET  /api/me/insights/overview (authed)",
      run: async () => {
        const c = sessionCookie.get(AUTH_EMAIL);
        const r = await request({ method: "GET", path: "/api/me/insights/overview", headers: c ? { cookie: c } : {} });
        return { status: r.status };
      },
    },
  ];

  let hardFail = 0;
  let warn4xx = 0;
  for (const c of checks) {
    const t0 = performance.now();
    const r = await c.run();
    const ms = Math.round(performance.now() - t0);
    if (r.status === 0 && (r.note ?? "").startsWith("SKIP")) {
      log(`- ${c.label.padEnd(46)} SKIP  ${r.note ? `(${r.note})` : ""}`);
      continue;
    }
    const ok = r.status >= 200 && r.status < 400;
    const mark = ok ? "✓" : r.status >= 500 || r.status === 0 ? "✗" : "!";
    if (r.status >= 500 || r.status === 0) hardFail += 1;
    else if (!ok) warn4xx += 1;
    log(`${mark} ${c.label.padEnd(46)} ${String(r.status).padStart(3)}  ${ms}ms${r.note ? `  (${r.note})` : ""}`);
  }
  log(`dry-run done: ${checks.length} checks, ${hardFail} hard failures, ${warn4xx} client-4xx`);
  if (hardFail > 0) {
    warn("server unreachable/unhealthy — do NOT start load. Check dev.log and /api/ready.");
    return 3;
  }
  if (warn4xx > 0) warn("some checks returned 4xx (fixtures may be missing — run scripts/seed.ts / scripts/restore-qa-fixtures.ts).");
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  logStart = Date.now();

  if (DRY_RUN) {
    const code = await dryRun();
    return code;
  }

  log(`BEAN Folio local load runner`);
  log(`env: ${os.cpus().length} vCPU / ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB · base=${BASE_URL} · scenarios=${SCENARIOS.join(",")} · MAX_VU=${MAX_VU}`);
  if (os.cpus().length <= 2) {
    log(`sandbox is small (${os.cpus().length} vCPU): sequential phases, VU ramp clipped to MAX_VU=${MAX_VU}.`);
  }
  if (MAX_VU > 200) warn(`MAX_VU=${MAX_VU} > 200 — on this box you may be measuring the load generator, not the app.`);

  const health = await request({ method: "GET", path: "/api/health" });
  if (health.status !== 200) {
    warn(`/api/health returned ${health.status} — aborting before any load (run --dry-run for detail).`);
    return 3;
  }
  await harvestFixtures();

  // Global watchdog — a run may never outlive RUN_TIMEOUT_S; on expiry the
  // current phase drains and a partial summary is written.
  let partial = false;
  const watchdog = setInterval(() => {
    if ((Date.now() - logStart) / 1000 > RUN_TIMEOUT_S && !globalStop.value) {
      globalStop.value = true;
      partial = true;
      warn(`global timeout (${RUN_TIMEOUT_S}s) reached — draining, will write partial summary`);
    }
  }, 5_000);
  const onSignal = () => {
    if (!globalStop.value) {
      globalStop.value = true;
      partial = true;
      warn("signal received — draining current phase, will write partial summary");
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const scenarioRuns: Array<{ name: string; describe: string; phases: PhaseReport[] }> = [];
  try {
    for (const name of SCENARIOS) {
      const sc = SCENARIO_DEFS[name];
      const stages = stagesFor(sc);
      log(`=== scenario ${name} (${stages.length} phases): ${sc.describe}`);
      const results: PhaseResult[] = [];
      for (let i = 0; i < stages.length; i++) {
        if (globalStop.value) break;
        results.push(await runPhase(sc, stages[i], i + 1, stages.length));
      }
      scenarioRuns.push({
        name,
        describe: sc.describe,
        phases: results.map((p) => phaseReport(p, name === "auth" || name === "publish")),
      });
      if (globalStop.value) break;
    }
  } finally {
    clearInterval(watchdog);
    httpAgent.destroy();
    httpsAgent.destroy();
  }

  const report = buildReport(startedAt, partial, scenarioRuns);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(OUT_DIR, `${stamp}.json`);
  const mdPath = path.join(OUT_DIR, `${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, markdownReport(report));
  log(`summary: ${mdPath}`);
  log(`summary: ${jsonPath}`);
  if (report.thresholdBreach) warn("one or more phases breached targets — these are TARGETS, not guarantees; investigate p95/err rows above.");
  return report.thresholdBreach ? 2 : 0;
}

process.exitCode = 1;
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error("fatal:", e);
    process.exitCode = 1;
  });
