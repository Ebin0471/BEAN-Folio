# BEAN Folio — Load Testing Toolkit

Local + staging load-testing assets. **k6 is intentionally NOT a project
dependency** — the `k6/` scenarios run on hosts that have k6 (staging/CI);
inside the sandbox use the dependency-free bun runner instead.

```
scripts/loadtest/
├── workloads.md      declared workload model (tiers, mix, RPS table) — read this first
├── k6/
│   ├── browse.js     public read mix        (80% of declared traffic)
│   ├── search.js     search projects/profiles (10%)
│   ├── auth.js       login + session check  (5%)  ⚠ 10 logins/min/IP limiter
│   ├── generation.js AI studio messages     (1%)  ⚠⛔ GEN_ENABLED=true gate — burns AI quota (30/day/user)
│   └── publish.js    publish/unpublish      (1%)  ⚠⛔ PUBLISH_ENABLED=true gate — writes, dedicated fixture account
├── run-local.ts      bun stdlib load runner for the sandbox (sequential phases, MAX_VU≤200)
├── README.md         this file
└── results/          JSON + markdown summaries from run-local.ts (gitignore-able artifacts)
```

Related: `docs/ops/LOAD_TESTING.md` (service objectives + RESULTS placeholders).

---

## 1. Which runner do I use?

| Where | Tool | Command |
|---|---|---|
| Sandbox / dev box (2 vCPU, no k6) | `run-local.ts` (bun stdlib) | `bun scripts/loadtest/run-local.ts` |
| Staging / CI (k6 ≥ 0.50 installed) | k6 scenarios | `k6 run -e BASE_URL=... scripts/loadtest/k6/browse.js` |

## 2. Sandbox: `run-local.ts` (bun, zero new deps)

```bash
# 0) validate reachability + fixture credentials first (no load, no writes)
bun scripts/loadtest/run-local.ts --dry-run

# 1) default: read-only scenarios (browse, search, reads), sequential ramp 10→50→100→200 VUs
bun scripts/loadtest/run-local.ts

# 2) narrower/shorter run
bun scripts/loadtest/run-local.ts --scenarios=browse,search --max-vu=100 --duration-s=20

# 3) auth scenario (≈8 logins/min — the login limiter is 10/min per client key
#    and ALL VUs on one box share that single bucket; do not raise VUs)
bun scripts/loadtest/run-local.ts --scenarios=auth

# 4) publish toggle — WRITES, dedicated QA fixture account only
bun scripts/loadtest/run-local.ts --scenarios=publish
```

Flags/env: `--help` lists everything (`SCENARIOS`, `MAX_VU`, `DURATION_S`,
`WARMUP_S`, `BASE_URL`, thresholds, `RUN_TIMEOUT_S` watchdog). Results land in
`scripts/loadtest/results/<timestamp>.md` + `.json` with per-phase RPS,
p50/p95/p99, error rate, 429 counts, status histogram and endpoint breakdown.

Sandbox reality (measured here): **2 vCPU / 3.9 GiB RAM** — the runner therefore
caps VUs at 200 by default, runs scenarios **sequentially**, and warns if you
push `MAX_VU` higher (you start measuring the load generator, not the app).
Never run load while other verification work is using the shared dev server.

## 3. Staging: k6 scenarios

```bash
# public browse mix — ramp 10%→25%→50%→100% of TARGET_RPS
k6 run -e BASE_URL=https://staging.example.com -e TARGET_RPS=200 scripts/loadtest/k6/browse.js

# search
k6 run -e BASE_URL=https://staging.example.com -e SEARCH_RPS=50 scripts/loadtest/k6/search.js

# auth (fixed 2 VUs, ≈8 logins/min per box — spread boxes for higher rates)
k6 run -e BASE_URL=https://staging.example.com scripts/loadtest/k6/auth.js

# AI studio — ⛔ DOUBLE GATE: GEN_ENABLED must be "true" or the scenario aborts
# before sending anything. Measures the 202-accept (queue admission) latency,
# treats 429 (30/day quota) as the designed path, and stops after a sustained
# quota-429 streak.
GEN_ENABLED=true k6 run -e BASE_URL=https://staging.example.com scripts/loadtest/k6/generation.js

# publish toggle — ⛔ writes on the dedicated fixture account only
PUBLISH_ENABLED=true k6 run -e BASE_URL=https://staging.example.com scripts/loadtest/k6/publish.js
```

Scenario knobs (all optional): `TARGET_RPS`, `SEARCH_RPS`, `MAX_VU`,
`WARMUP_S`, `STEP_S`, `AUTH_VUS`, `AUTH_THINK_S`, `GEN_SPACING_S`,
`PUBLISH_CYCLE_S`, `DURATION`, `SUMMARY_JSON` (path for the JSON summary).

## 4. Fixture credentials (all fixture data — never real users)

Source: `scripts/seed.ts` (demo personas) and `scripts/restore-qa-fixtures.ts`
(QA accounts, shared password `qa-fixture-password`).

| Purpose | Email | Password |
|---|---|---|
| Primary demo / auth + reads scenarios | `demo@beanfolio.app` | `demo1234` |
| Reads round-robin personas | `darius@beanfolio.app` / `ines@beanfolio.app` / `kofi@beanfolio.app` / `lena@beanfolio.app` / `theo@beanfolio.app` / `priya@beanfolio.app` / `marco@beanfolio.app` | `darius-demo` / `ines-demo1` / `kofi-demo1` / `lena-demo1` / `theo-demo1` / `priya-demo` / `marco-demo` |
| **Publish scenario (dedicated)** | `pub-e2e-1027@beanfolio.test` | `qa-fixture-password` |
| **Generation scenario (dedicated)** | `nova.testwright@example.com` | `qa-fixture-password` |
| Generic QA pool | `trace-tester@beanfolio.test`, `navfree@beanfolio.test`, `admin@beanfolio.test`, `journey@beanfolio.test`, `bean-e2e@beanfolio.app`, … | `qa-fixture-password` |

Notes: the publish fixture account needs a **saved draft** or the endpoint
answers 400 — the runners detect this and stop (precondition, not load data).
The generation account's 30/day AI quota **will** be consumed by that scenario.

## 5. What to measure (service objectives — TARGETS, not guarantees)

| Metric | Target | Where |
|---|---|---|
| Public reads p95 (`/api/discover`, search, profile JSON, media, `/u` shell) | < 500 ms | browse, search scenarios |
| `/u` shell p95 | < 800 ms | browse |
| Writes p95 (login, publish/unpublish) | < 1,000 ms | auth, publish |
| Studio message **202-accept** p95 | < 1,000 ms | generation |
| Hard-error rate (5xx + network) | < 0.1% sustained | all |
| 429s | expected under documented limiters; tracked separately, never silently "successful" | all |
| Queue depth / oldest-queued age while under load (from `/api/health`) | no unbounded growth | observe during runs |

Definitions: p95 = 95th percentile of completed-request latency at the client;
hard error = network failure or HTTP ≥ 500; RPS = completed requests / wall
second of the phase. Full definitions in `docs/ops/LOAD_TESTING.md`.

## 6. Safety rules (non-negotiable)

1. `--dry-run` (or a manual `/api/health` check) **before any load**.
2. Never point publish/generation at real user accounts — dedicated fixtures only.
3. Never run load against the shared dev server while others are verifying.
4. `POST /api/me/site/publish` and studio messages are the only write paths in
   this toolkit; everything else is read-only.
5. One load-gen box = one login rate-limit bucket (10/min). Higher login rates
   require IP diversity (k6 cloud / multiple egress IPs), never limiter abuse.
