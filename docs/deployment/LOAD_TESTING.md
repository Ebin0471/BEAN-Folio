# BEAN Folio — Load Testing Guide

Tool: **k6 v0.50+** (deliberately not a project dependency). All scenarios
live in `scripts/loadtest/k6/`; a bun-native runner
(`scripts/loadtest/run-local.ts`, MAX_VU ≤ 200) exists for quick local ramps.

## Scenarios

| Script | Model | Traffic |
|---|---|---|
| `k6/browse.js` | open (arrival-rate ramp 10→100 % of TARGET_RPS) | 80 % public mix: discover/profiles/media/shell/professions/ops |
| `k6/search.js` | open | search-heavy mix |
| `k6/auth.js` | open | health → login → `/api/auth/me` (scrypt-cost realistic) |
| `k6/publish.js` | gated | project publish toggle (dedicated fixture only) |
| `k6/generation.js` | gated | AI 202-accept latency ONLY (no provider spend) |
| `k6/vu-probe.js` | **closed (constant-vus)** | pins simultaneous connections exactly (100/500/1000) |

## Running

```bash
# open-model mix (throughput evidence)
k6 run -e BASE_URL=http://localhost:3100 -e TARGET_RPS=100 -e MAX_VU=500 \
       scripts/loadtest/k6/browse.js

# closed-model concurrency ladder (the "N simultaneous users" question)
k6 run -e BASE_URL=http://localhost:3100 -e VUS=1000 -e DURATION=60s \
       scripts/loadtest/k6/vu-probe.js

# auth
k6 run -e BASE_URL=http://localhost:3100 -e AUTH_EMAIL=demo@beanfolio.app \
       -e AUTH_PASSWORD=demo1234 scripts/loadtest/k6/auth.js
```

Export summaries for the results ledger:
`--summary-export scripts/loadtest/results/<campaign>-<scenario>.json`.

## Rules (non-negotiable)

1. **Never disable or raise rate limits for a test** — 429 shares are part of
   the measurement (per-IP budgets are a production contract).
2. Synthetic accounts/fixtures only; never point k6 at real user data or a
   production system without explicit written authorization.
3. Progressive ladder only: 100 → 500 → 1,000 → … VUs; never jump to 100 k.
4. Record: RPS, admitted vs 429, p50/p95/p99, hard-error rate (5xx+network),
   CPU/RSS (`GET /api/metrics`), and recovery after the run
   (`/api/health` latency).
5. Gated scenarios (`publish`, `generation`) read their warnings first.

## Results ledger

Measured campaigns, evidence files and the honest envelope verdict:
[`../ops/LOAD_TESTING.md` §6](../ops/LOAD_TESTING.md). Current GZ-SCALE
campaign (2026-11-23): zero 5xx across ~107 k requests, 1,000-simultaneous-
connection survival, RSS < 1 GB; **not** a 100k claim — Tier C requires the
distributed generator plan in [`SCALING_ARCHITECTURE.md` §6](./SCALING_ARCHITECTURE.md).
