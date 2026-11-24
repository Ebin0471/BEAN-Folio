# BEAN Folio — Load Testing & Capacity (Ops Runbook)

> **Status: targets declared, results pending.** Every number below that is a
> *target* is a planning objective — NOT a guarantee and NOT a measured fact.
> Measured results live in `scripts/loadtest/results/` and are summarized in
> [RESULTS](#results) (currently placeholders).

## 1. Scope and assets

| Asset | Path | Runs on |
|---|---|---|
| Declared workload model (tiers, mix, RPS table) | `scripts/loadtest/workloads.md` | — (read first) |
| k6 scenarios (browse / search / auth / generation / publish) | `scripts/loadtest/k6/*.js` | staging / CI hosts with k6 ≥ 0.50 (k6 is NOT a project dependency) |
| Local bun runner (stdlib only, sequential phases) | `scripts/loadtest/run-local.ts` | sandbox / dev box |
| Toolkit README (commands, knobs, fixtures) | `scripts/loadtest/README.md` | — |
| Result artifacts | `scripts/loadtest/results/<timestamp>.{md,json}` | — |

## 2. Service objectives — **TARGETS, not guarantees**

Measured client-side (completed requests), at the origin (no CDN in the current
sandbox; staging numbers must state whether CDN was in front).

| # | Objective | Target | Applies to |
|---|---|---|---|
| S1 | Public reads p95 | < 500 ms | `/api/discover`, `/api/search/*`, `/api/profiles/<username>`, `/api/professions`, `/api/media/<id>/raw` |
| S2 | Public SPA shell p95 | < 800 ms | `GET /u/<username>` (HTML) |
| S3 | Writes p95 | < 1,000 ms | `POST /api/auth/login`, `POST /api/me/site/publish`, `POST /api/me/site/unpublish` |
| S4 | Studio message 202-accept p95 | < 1,000 ms | `POST /api/me/site/studio/sessions/[id]/messages` — **queue admission only, never generation completion** |
| S5 | Hard-error rate (network + HTTP ≥ 500) | < 0.1% sustained, any 5-min window | all endpoints |
| S6 | 429 handling | 429s are **expected** under documented limiters; must be surfaced in results, never silently counted as success | login (10/min/client), publish (20/min/user), AI quota (30/day/user) |
| S7 | Queue health under load | queue depth returns to baseline ≤ 60 s after load ends; oldest-queued age bounded | `/api/health` counters |

**Measurement definitions**

- **p50/p95/p99** — percentile of client-observed latency for completed requests within a phase.
- **Hard error** — transport failure (timeout, connection reset) or HTTP status ≥ 500.
- **Client 4xx (non-429)** — precondition problems (e.g. missing fixture draft); reported, excluded from S5 but always investigated.
- **429** — rate-limit/quota response; counted separately per endpoint.
- **RPS** — completed requests ÷ phase wall-clock seconds.
- **VU** — virtual user; an independent loop of actions with think time.
- **Phase** — one stage of a ramp (fixed VU count + duration) executed sequentially.

## 3. Declared workloads (summary)

Full model and derivation in `scripts/loadtest/workloads.md`. The key identity:
**100k concurrent users ≠ 100k RPS** — active users generate 1–3 requests per
10 s (0.1–0.3 req/s), and ~70% of edge traffic is absorbed by CDN/browser/app
cache, so the origin plans for ~30% of edge load.

### Arrival-rate table

| Tier | Concurrent active users | Edge RPS (light–peak) | Origin RPS (planning, ×0.3) |
|---|---|---|---|
| T0 | 100 | 10 – 30 | 3 – 9 |
| T1 | 1,000 | 100 – 300 | 30 – 90 |
| T2 | 10,000 | 1,000 – 3,000 | 300 – 900 |
| T3 | 25,000 | 2,500 – 7,500 | 750 – 2,250 |
| T4 | 50,000 | 5,000 – 15,000 | 1,500 – 4,500 |
| T5 (target) | 100,000 | 10,000 – 30,000 | 3,000 – 9,000 |

### Traffic mix (declared)

80% public browse · 10% search · 5% auth (login + session validation) ·
4% authenticated reads · 1% writes/generation. Auth footnote: raw login POSTs
are a fraction of the auth bucket (users log in once per session); the bucket
is dominated by `GET /api/auth/me`-style session validation.

## 4. How to run

### 4.1 Sandbox (this machine — measured: 2 vCPU, 3.9 GiB RAM)

```bash
bun scripts/loadtest/run-local.ts --dry-run          # reachability + fixture creds, no load
bun scripts/loadtest/run-local.ts                    # read-only: browse, search, reads
bun scripts/loadtest/run-local.ts --scenarios=auth   # ~8 logins/min (single limiter bucket)
bun scripts/loadtest/run-local.ts --scenarios=publish # WRITES — dedicated fixture account only
```

- Sequential phases with ramp `warm-up → 10 → 50 → 100 → 200 VUs` (clipped to `MAX_VU`, default 200).
- Output: `scripts/loadtest/results/<timestamp>.md` + `.json`.
- **Do not run load while the shared dev server is being used for verification work.**

### 4.2 Staging (k6 ≥ 0.50 on the load-gen host)

```bash
k6 run -e BASE_URL=https://staging.example.com -e TARGET_RPS=200 scripts/loadtest/k6/browse.js
k6 run -e BASE_URL=https://staging.example.com -e SEARCH_RPS=50  scripts/loadtest/k6/search.js
k6 run -e BASE_URL=https://staging.example.com                   scripts/loadtest/k6/auth.js

# ⛔ gated scenarios — read the warnings in each file first
GEN_ENABLED=true     k6 run -e BASE_URL=https://staging.example.com scripts/loadtest/k6/generation.js
PUBLISH_ENABLED=true k6 run -e BASE_URL=https://staging.example.com scripts/loadtest/k6/publish.js
```

### 4.3 Preconditions & guardrails

1. `/api/health` and `/api/ready` must be green before and after every run.
2. Only fixture accounts (`scripts/seed.ts`, `scripts/restore-qa-fixtures.ts`)
   — never real user data. Publish/generation use their dedicated accounts only.
3. `k6/generation.js` aborts unless `GEN_ENABLED=true`; it burns the fixture
   account's daily AI quota (30/day/user) and measures admission latency only.
4. One load-gen IP = one login-limiter bucket (10/min): scale login load with
   IP diversity, not VU count on a single box.
5. Record: start/end UTC, `git rev-parse HEAD`, base URL, whether CDN was in
   front, machine specs of load gen AND server, full result file path.

## 5. Escalation / interpretation guide

| Symptom | First checks |
|---|---|
| p95 breaches at low RPS, CPU idle | DB (missing indexes, N+1), cache misses, event-loop blockers |
| p95 grows linearly with VUs, server CPU pegged | capacity bound — horizontal scale / cache, re-run T2 |
| 5xx spikes under load | DB pool exhaustion, memory, queue backpressure (`/api/health`) |
| 429 storm on login/publish | expected at high VU counts on one IP — re-plan with IP diversity |
| Generation 429 streak | daily AI quota exhausted for the fixture account — designed stop |
| Publish 400 | fixture account has no saved draft — precondition, not load failure |

## 6. RESULTS

> **Nothing has been measured yet.** The placeholders below are the required
> reporting skeleton — fill them from `scripts/loadtest/results/*.md` after each
> campaign and update this section. Targets remain TARGETS until then.

### 6.1 Sandbox (run-local.ts) — measured in sandbox: see results/

| Date | Commit | Scenarios | MAX_VU | Peak RPS | Public p95 | Writes p95 | Hard-err | 429 | Result file |
|---|---|---|---|---|---|---|---|---|---|
| _pending_ | _pending_ | — | — | — | — | — | — | — | `scripts/loadtest/results/…md` |

- [ ] Dry-run validation against dev server: **not yet recorded** (`--dry-run` output).
- [ ] Read-only ramp (browse/search/reads) to 200 VUs: **not yet performed — see results/**.
- [ ] Auth scenario (≈8 logins/min): **not yet performed — see results/**.
- [ ] Publish toggle (dedicated fixture): **not yet performed — see results/**.

### 6.2 Staging (k6) — measured on staging: see results/

| Date | Commit | Scenario | Profile (RPS/VUs) | p50 | p95 | p99 | Hard-err | 429 | SLO verdict | File |
|---|---|---|---|---|---|---|---|---|---|---|
| _pending_ | _pending_ | browse | — | — | — | — | — | — | — | — |
| _pending_ | _pending_ | search | — | — | — | — | — | — | — | — |
| _pending_ | _pending_ | auth | — | — | — | — | — | — | — | — |
| _pending_ | _pending_ | generation (202-accept) | — | — | — | — | — | — | — | — |
| _pending_ | _pending_ | publish toggle | — | — | — | — | — | — | — | — |

- [ ] T1 (1k users) origin validation: **not yet performed — see results/**.
- [ ] T2 (10k users) origin validation: **not yet performed — see results/**.
- [ ] T3–T5 validation (multi-box + CDN): **not yet performed — see results/**.
- [ ] CDN offload share at edge (target ~70%): **not measured — no CDN in sandbox**.

### 6.4 GZ-SCALE measured campaign (2026-11-23, commit {SHA}, production standalone server)

Environment: 2 vCPU / 3.9 GiB sandbox, app + k6 on the SAME box (indicative,
not capacity sign-off). Server = `node .next/standalone/server.js` (the
Dockerfile's runtime), SQLite (`custom.db`), 8 seeded demo users + 13
published projects, queue worker on. Traffic generator: k6 v0.54.0.
Per-IP rate limits were LEFT AT PRODUCTION VALUES (429s are a measured,
intended response — never disabled for a test).

**Open-model workload mix (browse.js — 40% discover / 20% profile / 15% media
/ 10% shell / 10% professions / 5% ops):**

| Run | Target RPS | Achieved (admitted+429) | p50 | p95 | Hard-err (5xx+net) | 429 share | Evidence |
|---|---|---|---|---|---|---|---|
| R1 | 20 | 8.0 RPS | 3 ms | 5.4 ms | **0.00 %** (0/794) | 30 % | `gz-scale-browse-r1-vu100.json` |
| R2 | 100 | 40 RPS | 1.3 ms | 2.9 ms | **0.00 %** (0/3975) | 69 % | `gz-scale-browse-r2-rps100.json` |
| R3 | 200 | 80 RPS | 1.2 ms | 2.4 ms | **0.00 %** (0/4390) | 77 % | `gz-scale-browse-r3-rps200.json` |
| Soak ≈4.3 min | 60 | ~32 RPS | 1.2 ms | 2.7 ms | **0.00 %** (0/4724) | 59 % | `gz-scale-soak-60rps.json` |

**Closed-model concurrency probe (vu-probe.js — every VU is a simultaneous
connection doing feed → taxonomy → SPA shell → health with 1 s think time):**

| Simultaneous VUs | Total reqs | Req rate | p50 | p95 | max | Hard-err | Server RSS after | Evidence |
|---|---|---|---|---|---|---|---|---|
| 100 | 16,988 | 280/s | 56 ms | 359 ms | 1.7 s | 0 | 721 MB | `gz-scale-vu-probe-100.json` |
| 500 | 33,420 | 528/s | 419 ms | 2.14 s | 7.8 s | 0 | 807 MB | `gz-scale-vu-probe-500.json` |
| 1,000 | 35,590 | 547/s | 756 ms | 4.6 s | 7.9 s | 0 | 994 MB | `gz-scale-vu-probe-1000.json` |
| Spike 0→800 (45 s) | 19,149+ | — | 700 ms | 3.95 s | 6.4 s | 0 | healthy 8 ms post-spike | `gz-scale-spike-vu800.json` |

**Auth flow (auth.js — health → login → /api/auth/me):** login p95 = 90.7 ms
(scrypt KDF is the deliberate dominant cost), 100 % checks pass
(`gz-scale-auth.json`).

**Honest verdict for this box (2 vCPU, SQLite, no CDN):**

1. The service **survived 1,000 simultaneous connections and an 800-VU
   connection spike with ZERO 5xx, zero error-log lines, and bounded memory
   (< 1 GB RSS, no leak signature across ~107 k requests)**. Degradation under
   saturation is graceful queueing (p95 grows, nothing collapses), plus
   intended per-IP 429 throttling.
2. This is NOT a 100 k-concurrent-user claim. On this hardware the measured
   safe operating envelope is roughly **≤ 100–200 concurrent users at
   interactive latency** (p95 ≤ 400 ms closed-model), with the origin
   admitting ~30–80 effective RPS of the open-model mix under production rate
   limits. Beyond that, latency growth is connection queueing on 2 cores +
   SQLite single-writer contention.
3. Every listed M-audit/M22 gate stays green while rate limiting is ACTIVE:
   the 429 shares above are the limiter doing its job from a single IP; a
   distributed generator (see §6.3) with per-source IPs is required before
   rate limits stop dominating the mix.

### 6.3 Known limitations of current measurements

- The sandbox dev box (2 vCPU / 3.9 GiB) hosts **both** the app and the load
  generator — absolute latency numbers from it are indicative only, useful for
  regressions and correctness of scenarios, not for capacity sign-off.
- No CDN, no multi-instance deployment, no separate DB host in the sandbox;
  T3+ tiers can only be validated on staging/production-like topology.
- AI generation is never measured end-to-end here (quota + cost): the declared
  metric is the **202-accept** latency only.
