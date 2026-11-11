# BEAN Folio — Declared Workload Model

> These are **declared workloads** (planning targets for capacity tests), not measured facts.
> Measured numbers live in `scripts/loadtest/results/` and `docs/ops/LOAD_TESTING.md`.

## 1. The core accounting: users ≠ RPS

**100,000 concurrent users ≠ 100,000 RPS.** A user is *active* (issues requests)
only a fraction of wall-clock time. The SPA requests data on interaction, not in a
tight loop. The planning assumptions are:

| Assumption | Value |
|---|---|
| Requests per **active** user | 1–3 per 10 s → **0.1–0.3 req/s** at the edge |
| Absorbed by CDN / browser cache / app cache (media, avatars, published-site shells, static chunks) | ~70% |
| Reaching the origin (Next.js app + DB) | ~30% of edge traffic |

Derived edge load at N concurrent active users: `RPS_edge ≈ N × 0.1 … N × 0.3`.
Origin load (what our servers actually handle): `RPS_origin ≈ 0.3 × RPS_edge`.

## 2. Tier table (arrival rates per tier)

| Tier | Concurrent active users | Edge RPS (light–peak) | Origin RPS (planning, ×0.3) | Where it is validated |
|---|---|---|---|---|
| T0 | 100 | 10 – 30 | 3 – 9 | sandbox `run-local.ts --dry-run` + smoke |
| T1 | 1,000 | 100 – 300 | 30 – 90 | staging k6 baseline |
| T2 | 10,000 | 1,000 – 3,000 | 300 – 900 | staging k6 scale test |
| T3 | 25,000 | 2,500 – 7,500 | 750 – 2,250 | staging k6 (optional soak) |
| T4 | 50,000 | 5,000 – 15,000 | 1,500 – 4,500 | staging k6 (multi-box) |
| T5 | 100,000 | 10,000 – 30,000 | 3,000 – 9,000 | **target** — multi-box + CDN in front |

At T5 the origin target of ~9k RPS peak assumes the CDN carries the ~70% cacheable
share. If origin p95 breaches before that, the answer is cache/CDN work, not more app
servers — that is exactly what these scenarios are built to reveal.

## 3. Declared traffic mix

| Scenario | Share | k6 file | Local runner scenario |
|---|---|---|---|
| Public browse (discover, profile JSON, `/u` shell, professions, media raw, health) | **80%** | `k6/browse.js` | `browse` |
| Search (projects + profiles) | **10%** | `k6/search.js` | `search` |
| Auth (login + session bootstrap / `/api/auth/me`) | **5%** | `k6/auth.js` | `auth` |
| Authenticated reads (`/api/me/site`, `/api/projects`, insights) | **4%** | `k6/auth.js` (+cookies) | `reads` |
| Writes / generation (publish toggle, studio AI turns) | **1%** | `k6/publish.js`, `k6/generation.js` | `publish` |

Per-scenario edge RPS at the target tier (T5, edge 10k–30k):

| Scenario | Light (10k edge) | Peak (30k edge) |
|---|---|---|
| browse | 8,000 | 24,000 |
| search | 1,000 | 3,000 |
| auth | 500 | 1,500 |
| authed reads | 400 | 1,200 |
| writes/generation | 100 | 300 |

**Auth share footnote.** Real users log in once per session (~15–30 min), so raw
`POST /api/auth/login` at T5 is ≈ 60–110/s (0.2–0.4% of traffic). The declared 5%
"auth" bucket is dominated by session *validation* (`GET /api/auth/me` with cookie)
and session-bootstrap reads, not login POSTs. This matters operationally: the login
endpoint is rate-limited to **10 attempts/min per client key**, so login load tests
must either spread source IPs (k6 cloud / multiple load generators) or stay ≤ 8
logins/min per box (the default in both runners).

## 4. Per-scenario VU/RPS definitions (k6)

All k6 scenarios are ramp-first: **warm-up → 10% → 25% → 50% → 100%** of the
scenario target, each stage configurable via env. Arrival-rate executors are used for
public traffic (open model — arrivals don't back up); fixed-VU executors for
account-bound scenarios (closed model — sessions are a real constraint).

| File | Executor | Default target (env knob) | Stage profile | Hard cap |
|---|---|---|---|---|
| `k6/browse.js` | `ramping-arrival-rate` | 200 RPS (`TARGET_RPS`) | 10%→25%→50%→100% (`STEP_S=60`) | `MAX_VU=200` |
| `k6/search.js` | `constant-arrival-rate` | 50 RPS (`SEARCH_RPS`) | constant, after 30 s warm | `MAX_VU=200` |
| `k6/auth.js` | `constant-vus` (2) | 2 VU × (login+me+15 s) ≈ 8 logins/min | constant | fixed 2 VU (limiter: 10/min/IP) |
| `k6/generation.js` | `constant-arrival-rate` | 1 msg / 15 s ≈ 0.07 RPS (`GEN_RPS`) | 1–2 VU, tiny prompts | ≤ 1 msg/s per VU; `GEN_ENABLED=true` gate |
| `k6/publish.js` | `constant-vus` (1) | 1 publish+unpublish cycle / 12 s (≤10/min, limiter is 20/min) | constant | 1 VU; `PUBLISH_ENABLED=true` gate |

### Local runner (sandbox) phase plan

`scripts/loadtest/run-local.ts` runs scenarios **sequentially** (2 vCPU / 3.9 GiB box)
with the same ramp shape scaled by `MAX_VU` (default **200**, warn above 200):

```
warm-up (20 s, ~5% VUs) → 10 VU (30 s) → 50 VU (30 s) → 100 VU (30 s) → 200 VU (30 s)
```

Stages are clipped to `MAX_VU` and per-scenario scale factors
(browse 1.0, search 0.25, reads 0.1, auth fixed 2, publish fixed 1).

## 5. What each scenario protects (service objectives — TARGETS, not guarantees)

| Objective | Target |
|---|---|
| Public reads p95 (discover, search, profile JSON, media, shell) | < 500 ms at origin |
| Writes p95 (login, publish/unpublish) | < 1,000 ms |
| Studio message **202-accept** p95 (queue admission, not generation) | < 1,000 ms |
| Hard error rate (5xx + network) | < 0.1% sustained |
| 429 rate-limit responses | expected under documented limiters; tracked separately, never silently counted as success |
| AI quota (studio messages) | 30/day/user — generation scenario must respect it and treat 429 as the designed quota path |

Full objective definitions and the results placeholder live in
`docs/ops/LOAD_TESTING.md`.
