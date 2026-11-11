# Task 7 — Load-Testing Toolkit (work record)

Agent: loadtest-toolkit · Date: 2026-11-05 · Status: DONE

## Deliverables (all NEW, nothing else touched — verified via `git status`: only untracked additions)

- `scripts/loadtest/workloads.md` — declared workload model: users≠RPS derivation, tier table 100→100k, mix (80/10/5/4/1), per-scenario VU/RPS definitions, limiter footnotes.
- `scripts/loadtest/k6/browse.js` — public read mix (discover 40 / profile 20 / media 15 / shell 10 / professions 10 / ops 5), ramping-arrival-rate 10%→25%→50%→100%, thresholds p95<500 (shell<800), hard-err<0.1%. Harvests real public usernames/media from discover+creators; degrades to discover when DB has no public profiles (demo profiles are isDemo → 404 anonymously by design).
- `scripts/loadtest/k6/search.js` — constant-arrival-rate, 70/30 projects/profiles, seed-matched terms, p95<500.
- `scripts/loadtest/k6/auth.js` — fixed 2 VU × 15s think (≈8 logins/min, under the 10/min/client limiter — one load-gen box = one bucket), 429 tracked separately, 401 threshold count==0. login p95<1000.
- `scripts/loadtest/k6/generation.js` — ⛔ aborts unless GEN_ENABLED=true; ≤1 msg/s/VU ceiling (default 1/15s); tiny prompts; measures 202-accept only; 429 = designed quota path (30/day/user), graceful stop after 5-quota-429 streak.
- `scripts/loadtest/k6/publish.js` — ⛔ aborts unless PUBLISH_ENABLED=true; dedicated fixture account only; publish↔unpublish cycle ≥8s (limiter 20/min/user); stops on 400 (no saved draft = precondition).
- `scripts/loadtest/run-local.ts` — bun stdlib runner (node:http + keepAlive agents, no new deps). Sequential phases, warm-up→10→50→100→200 VUs clipped to MAX_VU (default 200; sandbox = 2 vCPU/3.9GiB — reported). Globally spaced logins (6.5s) + session cache; per-phase RPS/p50/p95/p99/err%/429/status-histogram/endpoint table; JSON+MD summaries to `scripts/loadtest/results/`; `--dry-run` (15 reachability+credential checks, no writes); `--help`; global watchdog RUN_TIMEOUT_S; SIGINT/SIGTERM drain; per-request timeouts, `close`-stream guard so no socket/promise can wedge.
- `scripts/loadtest/README.md` — runner selection, commands, knobs, fixture credentials table, safety rules.
- `docs/ops/LOAD_TESTING.md` — service objectives (TARGETS not guarantees) S1–S7, measurement definitions, how-to-run (sandbox + staging), escalation guide, RESULTS section with explicit "measured in sandbox: see results/" placeholders (nothing measured yet).

## Key facts discovered (useful to other agents)

- Demo credentials (scripts/seed.ts): **demo@beanfolio.app / demo1234**; personas: darius@beanfolio.app/darius-demo, ines@beanfolio.app/ines-demo1, kofi@beanfolio.app/kofi-demo1, lena@beanfolio.app/lena-demo1, theo@beanfolio.app/theo-demo1, priya@beanfolio.app/priya-demo, marco@beanfolio.app/marco-demo (usernames: maya-edits, darius-builds, ines-shoots, kofi-codes, lena-cooks, theo-draws, priya-designs, marco-tells).
- QA fixtures (scripts/restore-qa-fixtures.ts): shared password **qa-fixture-password** — trace-tester@beanfolio.test, navfree@beanfolio.test, admin@beanfolio.test, journey@beanfolio.test, nova.testwright@example.com (used by k6 generation), milo.testwright@example.com, qa-live-1026@example.com, qa-live2-1026@example.com, bean-e2e@beanfolio.app, pub-e2e-1027@beanfolio.test (dedicated publish account; both logins verified live via --dry-run, cookie `bean_session`).
- Login limiter: 10/min per client key, keyed on RIGHTMOST X-Forwarded-For → one load-gen box = one bucket. Publish limiter: 20/min/user. AI quota: 30/day/user (429).
- Current DB has NO publicly visible profiles/projects (demo owners excluded by `publicOwnerFilter`/`isProfilePubliclyVisible`; only non-demo user `ebin` exists, no published projects) → discover/creators return empty items; browse scenarios degrade gracefully; `PROBE_USERNAME` env can force a profile probe.

## Validation (no load executed — shared dev server respected)

- `bun build --no-bundle scripts/loadtest/run-local.ts --outfile /tmp/lt-check.js` → OK (34.0 KB chunk).
- `bunx tsc --noEmit` → exit 0, zero output.
- `node --check` on all 5 k6 files → OK (k6 itself not installed by design).
- `bun scripts/loadtest/run-local.ts --help` → usage, exit 0, no side effects.
- `bun scripts/loadtest/run-local.ts --dry-run` → 15/15 checks: 12 ✓, 2 SKIP (no public profile fixtures — expected), 0 hard failures, exit 0. Confirmed both fixture logins work.
