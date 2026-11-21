# BEAN Folio — Phase 5 Deployment Provider Selection (RECOMMENDATION ONLY)

**Status:** PREPARED (2026-11-22) · **Baseline:** `1c5f785` (published `main`)
· **Nature:** source-verified provider compatibility assessment + deployment
blueprint. **This document authorizes nothing.** No DigitalOcean resource exists
because of it, no plan was started, no billing was initiated, and every
production gate in `PHASE5_POSTGRES_DEPLOYMENT_PREREQUISITES.md` (A → B → C)
remains exactly as registered. Provisioning, migration (Gate A) and deployment
(Gate B) each still require a separate explicit owner authorization.

**Recommended provider / region (recommendation, not provisioning):**

| Concern | Service | Region slug |
|---|---|---|
| Web app (Next.js standalone) | DigitalOcean **App Platform** (Dockerfile build) | `blr` (Bangalore) |
| Database (PostgreSQL) | DigitalOcean **Managed PostgreSQL** | `blr1` (Bangalore) |
| Media (S3-compatible object storage) | DigitalOcean **Spaces** (private bucket) | `blr1` (Bangalore) |
| Uptime poll (G-1 closure) | DigitalOcean **Uptime** (1 free check/month) | global |

All three regional claims are verified against DigitalOcean's official
availability matrix (PostgreSQL BLR1: Available; Spaces Standard Storage
BLR1: Available) and the App Platform availability page ("BLR: Available" for
dynamic apps, page generated 21 Nov 2026).

---

## 1. Compatibility verdict

**COMPATIBLE — no verified incompatibility between the shipped application and
the documented provider capabilities.** The application can run in the
documented single-instance topology **without any product change**: the
existing Dockerfile, build script, standalone server, Prisma PostgreSQL mirror,
durable queue, S3 storage driver and startup validation were written for
exactly this class of host and are already committed and reviewed.

Every claim below was checked against the provider's current official
documentation (fetched 2026-11-22; `last_updated` dates noted) and against the
shipped source at `1c5f785`. Unconfirmed items are listed separately in §13.

### 1.1 Evidence matrix

| # | Requirement | Source of truth (app) | Source of truth (provider) | Verdict |
|---|---|---|---|---|
| C1 | Region | — | App Platform availability page: dynamic apps **BLR: Available** (generated 2026-11-21); availability matrix: PostgreSQL **BLR1: Available**, Spaces Standard Storage **BLR1: Available** | CONFIRMED |
| C2 | Custom-Docker deployment | `Dockerfile` (multi-stage, node:22-slim, AMD64, non-root, `<2 GiB`) | Dockerfile Build Reference (2025-06-17): `dockerfile_path` in app spec; build/run env vars passed as `--build-arg` / `-e` | CONFIRMED |
| C3 | Build capacity | `next build` of this repo runs in minutes on 2 vCPU locally | Limits page (2026-11-17): 8 CPU cores, 15 GiB memory, 24 GiB disk per build; 1-hour build timeout | CONFIRMED (ample) |
| C4 | Runtime | standalone server `node server.js`, `HOSTNAME=0.0.0.0`, `PORT=3000` | Services how-to: bind to `0.0.0.0` required; default HTTP port 8080, `http_port` configurable in app spec | CONFIRMED |
| C5 | Bun runtime | Bun used **only inside the builder stage** of our own image (`bun install`, `bunx --bun next build`); the runner executes plain `node` | Dockerfile builds run our image as-is — no provider-side Bun support needed | CONFIRMED (Bun-on-App-Platform question is moot by design) |
| C6 | Health/readiness | `GET /api/health` (liveness + counters), `GET /api/ready` (startup validation + DB) | App spec reference: `health_check` (HTTP `http_path` or TCP) + `liveness_health_check` (restart on failure) | CONFIRMED — map both endpoints |
| C7 | Rollback | additive-only schema ⇒ previous build runs against newer schema (`MIGRATIONS.md` §3) | Features page (2026-04-24): "Rollback apps to one of the ten most recent successful deployments" | CONFIRMED |
| C8 | TLS / HTTPS | security headers incl. HSTS in production (`next.config.ts`); Secure cookies via `NODE_ENV=production` (`src/lib/auth.ts` — no proxy-header dependence) | Limits page: HTTP→HTTPS upgrade automatic; HSTS **not** set by platform (app must set it — ours does); `.ondigitalocean.app` is on the HSTS preload list | CONFIRMED |
| C9 | Env vars & secrets | required envs validated fail-fast at startup (`src/lib/startup-validation.ts`) | App spec: env vars with `type: SECRET`, scopes `RUN_TIME` / `BUILD_TIME` / `RUN_AND_BUILD_TIME`; Dockerfile build args honored | CONFIRMED |
| C10 | Database SSL | Prisma needs `sslmode=require` in `DATABASE_URL` (GO_LIVE §2); connection budget via URL params | PostgreSQL secure how-to (2026-11): **TLS mandatory on all connections**; provider URI ships with `sslmode=require`; `verify-full` available (Standard: downloaded CA cert; Advanced: system trust store) | CONFIRMED |
| C11 | Connection pooling | `connection_limit` budget documented in `prisma/schema.postgres.prisma` header | PostgreSQL connection pools (PgBouncer, transaction/session/statement); **25 connections per 1 GiB RAM**, 3 reserved for maintenance | CONFIRMED |
| C12 | Backups | repo tooling `pg_dump` drills (`MIGRATIONS.md` §5) | PostgreSQL features (2026-11-18): daily full backups + WAL ⇒ **PITR within the previous 7 days**; DB traffic does not count against bandwidth allowance | CONFIRMED |
| C13 | S3 API surface | `src/lib/storage.ts` uses **only** PutObject, GetObject (incl. `Range`), HeadObject, DeleteObject, presigned PUT (`@aws-sdk/client-s3` + s3-request-presigner). No ListObjects, no ACLs, no multipart | Spaces runs Ceph/RadosGW, "compatible with a large subset of the S3 API"; presigned URLs documented; both `region.digitaloceanspaces.com/<bucket>` (path-style, our default) and `<bucket>.<region>.digitaloceanspaces.com` (virtual-hosted) are documented URL forms | CONFIRMED |
| C14 | Browser direct uploads | `src/lib/client.ts` `uploadFile()` does XHR **PUT with `Content-Type`** straight to the bucket when the S3 driver is active → cross-origin preflight required | Spaces CORS how-to (2026-11-18): control-panel CORS with `PUT` method + `Content-Type` allowed header is a first-class feature; XML config via `s3cmd setcors` | CONFIRMED — **bucket CORS configuration is a required deployment step** (see §8) |
| C15 | Queue, single instance | `QUEUE_ENABLED=true` in-process worker; durable DB queue with atomic claims, heartbeats, `recoverStuck()` | App Platform service = one container; no persistent storage (Limits: local FS ephemeral + 4 GiB cap) — queue state lives in PostgreSQL, so restarts are safe | CONFIRMED |
| C16 | Background-worker split (future) | `QUEUE_ENABLED=false` + `bun scripts/queue-drain.ts` | App Platform **worker components** exist (non-routable, `run_command` override) | CONFIRMED as a scaling path (needs bun in the runner image — §12) |
| C17 | No WebSocket dependency | grep: product has **zero** WebSocket usage; AI chat uses SSE (`text/event-stream`) over plain HTTP | HTTP/1.1 relay to container (HTTP/2 downgraded at relay) — SSE unaffected | CONFIRMED |
| C18 | Upload size limits | presigned direct upload bypasses the app body when S3 configured (default on Spaces); classic multipart used only as fallback | Limits: file uploads to apps time out after 600 s — only affects the fallback path (≤64 MB cap is below realistic 600 s thresholds for beta) | CONFIRMED |
| C19 | Startup fail-fast | `startup-validation.ts`: production **fails** on partial S3 config; warns when S3 entirely unset | — | CONFIRMED (and §8 documents the required envs so the warn branch never applies) |
| C20 | Observability | `/api/health`, structured JSON logs, `ERROR_WEBHOOK_URL` seam | per-minute app metrics (Insights), log forwarding (2,048-byte line cap), DO Uptime ($1/check/mo, 1 free credit/month) | CONFIRMED |

### 1.2 Provider-documented constraints that shaped this blueprint (no product change required)

1. **No persistent storage / no volumes** (Limits page) ⇒ the local-disk media
   driver is unusable on App Platform ⇒ **Spaces is mandatory**; this matches
   the app's design (S3 driver + startup validation + presigned flow).
2. **600 s app-upload timeout** ⇒ presigned direct uploads are the primary
   transport (already the case whenever the S3 driver is active).
3. **HSTS is the app's job** — already implemented (`next.config.ts`, production only).
4. **CPDoS known issue for Next.js on App Platform** — the platform recommends
   explicit cache-control on non-cacheable responses. The app already sends
   explicit `Cache-Control` (`no-store` on dynamic documents via
   `src/proxy.ts`; `private, no-store` on data endpoints). Deploy-time
   verification item (§13 U-6).
5. **gVisor container sandbox** (Limits page: some syscalls unsupported) — the
   standard runtime for App Platform containers; Prisma/Next/sharp/pdf-parse
   have no documented incompatibility with it, but this sandbox cannot verify
   it ⇒ deploy-time smoke list (§13 U-1), not a blocker.
6. **Image guidance:** recommended < 1 GiB, problematic > 2 GiB — the runner
   stage (node:22-slim + standalone output + Prisma client) is far below that.
7. **Transfer visibility gap:** "You cannot view accrued transfer allowance or
   cumulative usage for App Platform" — cost control must lean on billing
   alerts (§10, owner decision D-8).

---

## 2. Recommended architecture (beta — Tier A single instance)

```text
                      Internet (HTTPS, auto-TLS, .ondigitalocean.app or custom domain)
                                        │
                     ┌──────────────────▼──────────────────┐
                     │  App Platform app (region: blr)     │
                     │  service "web"                      │
                     │  apps-s-2vcpu-4gb × 1 container     │
                     │  Dockerfile build → node server.js  │
                     │  QUEUE_ENABLED=true (in-process)    │
                     │  /api/health (liveness)             │
                     │  /api/ready (readiness)             │
                     └───────┬──────────────┬──────────────┘
                             │ TLS (sslmode=require)       │ SigV4 S3 API
              ┌──────────────▼─────────────┐   ┌───────────▼────────────────┐
              │ Managed PostgreSQL (blr1)  │   │ Spaces bucket (blr1)       │
              │ Standard, 1 GiB / 1 vCPU   │   │ PRIVATE; CORS for PUT      │
              │ 10 GiB base SSD            │   │ + Content-Type             │
              │ PITR 7 days                │   │ media served via app only  │
              └────────────────────────────┘   └────────────────────────────┘
```

- One app, one service component, one container. The in-process queue worker,
  daily maintenance sweeps and all recurring chains ride along
  (`instrumentation.ts`), exactly as in the verified Tier-A topology.
- Media never leaves the authorization ladder: browser ⇒ presigned PUT ⇒
  bucket (ingress, uncounted); reads go bucket ⇒ app ⇒ browser through
  `GET /api/media/:id/raw`.
- Rate limit + cache stay on the in-process `memory` backends — correct at
  exactly one instance (`HP-3`); the `postgres` backends are the documented
  >1-instance flip (§12 scaling path).
- **Migration chain unchanged:** O2.1 → O3 → O4 → O5 → O6 → O7, applied once
  by hand under Gate A **before** any deployment reaches users (Gate B). The
  registered artifacts and SHA-256 pins in
  `PHASE5_POSTGRES_DEPLOYMENT_PREREQUISITES.md` §A.1 are the authority; this
  document changes nothing about them.

## 3. Exact build and startup commands

Everything below is already committed; nothing new is introduced.

**Container build (executed by App Platform from `Dockerfile`):**

```dockerfile
# stage 1 (builder): bun install --frozen-lockfile
#   → bunx prisma generate --schema prisma/schema.postgres.prisma
#   → bunx --bun next build            (NEXT_PUBLIC_APP_URL passed as build arg)
#   → cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/
# stage 2 (runner): node:22-slim, USER node, ENV PORT=3000 HOSTNAME=0.0.0.0
#   → CMD ["node", "server.js"], STOPSIGNAL SIGTERM (graceful queue drain ≤27 s)
```

**App spec deltas (the only provider-side configuration this architecture needs):**

```yaml
name: bean-folio
region: blr
services:
  - name: web
    dockerfile_path: Dockerfile      # Dockerfile build, not buildpack
    http_port: 3000                  # container PORT (Dockerfile ENV PORT=3000)
    instance_size_slug: apps-s-2vcpu-4gb
    instance_count: 1                # beta: exactly one (memory rate-limit correctness)
    health_check:
      http_path: /api/ready          # readiness gate (startup validation + DB)
      period_seconds: 10
      failure_threshold: 3
    liveness_health_check:
      http_path: /api/health         # restart signal
      period_seconds: 30
      failure_threshold: 3
    envs:                            # names/values per §9 — values never committed
      - { key: DATABASE_URL,          scope: RUN_TIME,   type: SECRET }
      - { key: NEXT_PUBLIC_APP_URL,   scope: BUILD_TIME }
      - { key: S3_ENDPOINT,           scope: RUN_TIME }
      - { key: S3_BUCKET,             scope: RUN_TIME }
      - { key: S3_ACCESS_KEY_ID,      scope: RUN_TIME,   type: SECRET }
      - { key: S3_SECRET_ACCESS_KEY,  scope: RUN_TIME,   type: SECRET }
      - { key: S3_REGION,             scope: RUN_TIME }
```

(Run-time env such as `QUEUE_ENABLED=true` may also be set; unset vars keep
their in-code defaults, which are already the correct beta values.)

**Startup command (container):** `node server.js` — no override needed.
**Startup behavior:** `src/instrumentation.ts` validates the environment
fail-fast (exit 1 on any `fail` check), boots the queue worker + recurring
sweeps, and wires SIGTERM to the ≤27 s graceful queue drain.

## 4. Database connectivity and SSL

1. Create the Managed PostgreSQL cluster in `blr1`, PostgreSQL **16** (verified
   available on Standard Edition; EOL May 2028 — comfortably beyond launch).
2. Copy the connection URI from the provider dashboard — **never hand-typed**
   (standing P1000 rule, `docs/deployment.md` §0.4). It ships with
   `sslmode=require` (TLS is mandatory provider-side).
3. Append the documented connection budget as URL parameters, e.g.
   `&connection_limit=10&pool_timeout=10` — the 1 GiB cluster exposes
   **25 client connections** (3 reserved for maintenance); a single-instance
   app at `connection_limit=10` fits with headroom. Do **not** route through a
   PgBouncer transaction-mode pool at beta scale (Prisma interactive
   transactions + direct single-instance budget make the direct connection the
   simpler, verified shape; pools become relevant at >1 instance).
4. `pg_dump --format=custom` drills and `check-postgres-schema-readiness.ts`
   run from the operator machine against the same URI (`MIGRATIONS.md` §5).
5. **Trusted sources:** the cluster's firewall can add the app as a trusted
   source (`type: app`) — but only **after the app exists** (provider
   limit: App Platform network info can't be provided to trusted sources
   before the first build). Deploy once with trusted sources off, then enable
   and re-add the app. Owner decision D-7 (timing).
6. Optional hardening (owner decision D-6): `sslmode=verify-full`. Standard
   Edition requires the downloaded CA certificate inside the container; on a
   volume-less host the certificate must be injected via an env var and
   materialized at startup — deliberately **not** designed in this blueprint;
   `sslmode=require` (encrypted, server-auth-optional) is the beta posture.

## 5. Prisma PostgreSQL generation

Unchanged from the committed, reviewed path:

- Docker build: `bunx prisma generate --schema prisma/schema.postgres.prisma`
  (inside the builder stage — the generated **PostgreSQL** client is what the
  container ships).
- Vercel/reference path: `vercel-build` script (identical generation).
- Schema parity gate remains mandatory for any future schema change
  (`scripts/check-schema-parity.ts`, 100/100 at `1c5f785`).
- DDL is **never** applied by the build or the app: the full chain
  (O2.1 → O7, SHA-256-pinned, with the O2.1 destructive-adjacent approval
  bundle) is applied once by hand under Gate A only.

## 6. Queue topology

- **Beta (recommended):** `QUEUE_ENABLED=true`, single service container —
  the in-process worker (`QUEUE_CONCURRENCY=4`, `QUEUE_USER_CONCURRENCY=2`,
  poll 2 s) plus the five recurring sweeps. State is in PostgreSQL
  (`BackgroundJob`), so container replacement loses nothing:
  in-flight jobs lose their heartbeat and `recoverStuck()` requeues them on
  the next boot — the documented, tested behavior.
- **Scaling path (post-beta, owner-gated):** flip `QUEUE_ENABLED=false` on the
  web service and add an App Platform **worker component** running
  `bun scripts/queue-drain.ts`. Constraint: the runner image must contain bun
  (today's runner stage does not) — a Dockerfile change gated through the
  owner (§12 / R-P9). Claims are atomic, so N workers are safe.
- Rate limiting / caching across instances: flip
  `RATE_LIMIT_BACKEND=postgres` + `CACHE_BACKEND=postgres` (same
  `DATABASE_URL`, no new service) when — and only when — instance_count > 1.

## 7. Upload and storage configuration

1. Create the Space in `blr1`, keep it **private** (no CDN needed — media is
   served exclusively through the app's authorization ladder).
2. Create Spaces access keys (team-level, scoped to the bucket's key set).
3. **Bucket CORS (required, provider-documented):** in the bucket's Settings →
   CORS Configurations, add a rule: Origin = the exact app origin
   (`https://<app>.ondigitalocean.app` and/or the custom domain), Allowed
   Methods = `PUT` (add `GET`/`HEAD` only if a future product change needs
   them), Allowed Headers = `Content-Type`. Without this rule the browser's
   preflighted direct PUT fails and every upload falls back to the classic
   multipart path (bounded by the 600 s edge timeout). This is a deployment
   step, not a product change; it is the one Spaces-specific configuration the
   application cannot do for itself.
4. Env vars: `S3_ENDPOINT=https://blr1.digitaloceanspaces.com`,
   `S3_BUCKET=<bucket>`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (all four
   required together — startup fail-fasts on partial config in production),
   plus **`S3_REGION=us-east-1`** — the value DigitalOcean's own AWS-SDK
   reference prescribes for Spaces clients ("the SDK uses the region for
   validation only; the endpoint determines the datacenter"). The app's
   in-code default (`auto`) is a Cloudflare-R2 convention whose behavior
   against Spaces is unverified, so the explicit value is required (U-5).
5. `S3_FORCE_PATH_STYLE` stays unset (default `true`) — path-style
   `blr1.digitaloceanspaces.com/<bucket>` is a documented Spaces URL form.
6. Lifecycle (optional, provider-documented, matches the app's daily sweep):
   expire incomplete multipart uploads — the app never initiates multipart
   uploads, so this rule is hygiene only. S3 versioning on the bucket is
   available if the owner wants object-level rollback (D-9, optional).
7. Bandwidth shape (verified): browser PUTs are **inbound to Spaces** (free);
   media reads flow Spaces → app (Spaces outbound; 1,024 GiB/mo included) →
   browser (App Platform outbound; 250 GiB/mo included on the beta plan).

## 8. Health checks, deployment and rollback behavior

- **Readiness:** `GET /api/ready` — runs startup validation + DB
  reachability; wire as the deployment's `health_check.http_path`.
- **Liveness:** `GET /api/health` — process liveness + queue/cache counters;
  wire as `liveness_health_check.http_path` (restart on failure).
- **Deploy:** push-to-deploy on `main` (or manual "Deploy"); each deploy
  builds from the repo (immutable artifact). Configuration edits also re-pull
  source (provider-documented) — harmless here because `main` is always the
  publish-verified SHA.
- **Rollback:** one-click rollback to any of the ten most recent successful
  deployments. Schema is additive-only, so app N-1 runs against schema N —
  the exact rollback model `GO_LIVE_CHECKLIST.md` §4 already pins.
- **Shutdown:** SIGTERM → queue drain (≤27 s hard cap) — within App
  Platform's container-stop behavior; in-flight jobs self-recover via
  heartbeat if they cannot finish.

## 9. Required environment variables (names + purpose only — values never recorded here)

| Variable | Scope | Purpose / constraint |
|---|---|---|
| `DATABASE_URL` | RUN_TIME (SECRET) | PostgreSQL URI copied from the provider dashboard, `sslmode=require` + `connection_limit` budget; never hand-typed |
| `NEXT_PUBLIC_APP_URL` | BUILD_TIME | exact HTTPS origin, inlined at build time; changing it later requires a redeploy |
| `S3_ENDPOINT` | RUN_TIME | `https://blr1.digitaloceanspaces.com` (format) |
| `S3_BUCKET` | RUN_TIME | private Space name |
| `S3_ACCESS_KEY_ID` | RUN_TIME (SECRET) | Spaces access key |
| `S3_SECRET_ACCESS_KEY` | RUN_TIME (SECRET) | Spaces secret key |
| `S3_REGION` | RUN_TIME | `us-east-1` per DigitalOcean's AWS-SDK reference (endpoint selects the datacenter) |
| `QUEUE_ENABLED` | RUN_TIME | `true` for the beta single-instance topology |
| `RATE_LIMIT_BACKEND` | RUN_TIME | leave unset (`memory`) at 1 instance; `postgres` when >1 |
| `CACHE_BACKEND` | RUN_TIME | leave unset (`memory`) at 1 instance; `postgres` when >1 |
| `SESSION_SECURE_COOKIES` | RUN_TIME | leave unset (production ⇒ Secure automatically); explicit `true` is a harmless hardening |
| `LOG_LEVEL`, `ERROR_WEBHOOK_URL` | RUN_TIME | optional; structured logs + error webhook seam |
| `INTELLIGENCE_DAILY_COST_LIMIT_USD` | RUN_TIME | optional guardrail (default 5) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | RUN_TIME (SECRET for secrets) | optional; leave unset = feature honestly disabled |

Never set: `SUPABASE_*` (dead placeholders), `MEDIA_STORAGE_DRIVER=local`
(forbidden on App Platform — ephemeral FS), `BEAN_ALLOW_INSECURE_COOKIES=true`
in production.

## 10. Cost model

**Sources:** App Platform pricing page (`last_updated: 2026-11-05`), PostgreSQL
pricing page (`2026-09-30`), Spaces pricing page (`2026-11-17`), Uptime pricing
page (`2026-10-26`), plus the live pricing calculator
(digitalocean.com/pricing/managed-databases, fetched 2026-11-22).
**CONFIRMED = provider-documented list price at fetch time; ESTIMATE =
calculator-adjacent or usage-dependent and must be re-verified at provisioning.**

### 10.1 Beta configuration (mandate baseline)

| Item | Spec | Monthly | Class |
|---|---|---|---|
| App Platform service | `apps-s-2vcpu-4gb` (2 shared vCPU / 4 GiB) × 1 | **$50.00** | CONFIRMED (docs pricing table) |
| Managed PostgreSQL | Standard 1 GiB / 1 vCPU, base 10 GiB SSD | **$15.00** docs · **$15.15** ($0.02254/hr) live calculator | CONFIRMED (both figures provider-sourced) |
| Spaces Standard | 250 GiB storage + 1,024 GiB outbound included | **$5.00** | CONFIRMED |
| Uptime check | 1 check (e.g. `/api/health`) | **$0** (1 free check/month credited) | CONFIRMED |
| Domain | starter `*.ondigitalocean.app` | **$0** | CONFIRMED (custom domain optional; see launch config) |
| **Beta total** | | **≈ $70.00/mo** (list) / **$70.15** (calculator) | |

Usage overages (beta-scale ≈ zero, but bounded): app outbound beyond 250 GiB
$0.02/GiB; Spaces storage beyond 250 GiB $0.02/GiB/mo; Spaces outbound beyond
1,024 GiB $0.01/GiB; PostgreSQL storage beyond base $0.215/GiB/mo. All CONFIRMED.

Scale-down lever (fallback only): `apps-s-1vcpu-2gb` at $25.00/mo would bring
the total to ≈ $45/mo — but the measured performance envelope (p95-clean ≈ 50
VU) was recorded on 2 vCPU, so 1 vCPU is untested; not the recommendation.

### 10.2 Public-launch alternative (HA posture)

| Item | Spec | Monthly | Class |
|---|---|---|---|
| App Platform | same size × **2 containers** (HA requires ≥2 per provider) | **$100.00** (2 × $50) | CONFIRMED arithmetic |
| PostgreSQL HA — Advanced Edition | $130 primary (8 GiB/2 vCPU) + $130 standby, same rate | **$260.00** | CONFIRMED (docs: "begin at $130.00 … standby nodes bill at the same rate") |
| PostgreSQL HA — grandfathered Standard | primary $30.45 + standby $30.45 (2 GiB nodes) | **$60.90** | CONDITIONAL — see R-P2 |
| Spaces | base subscription | **$5.00** | CONFIRMED |
| Uptime | 2–3 checks | **$1–3** | CONFIRMED |
| Domain | `.com` via a registrar | **≈ $1–2/mo** | ESTIMATE (registrar-dependent) |
| **Launch total (Advanced HA)** | | **≈ $367–371/mo** + usage | |
| **Launch total (grandfathered Standard HA)** | | **≈ $167–172/mo** + usage | |

**R-P2 (material, time-sensitive):** per the provider's release note
("PostgreSQL and MySQL Plan Changes Beginning 15 October 2026"), from
**15 October 2026** for accounts that have never created a PostgreSQL/MySQL
cluster and from **30 November 2026 for all accounts**, **new Standard Edition
clusters do not support standby or read-only nodes** (and are capped at 4 GiB
RAM). High availability for a *new* cluster therefore requires Advanced
Edition (≈ $260/mo). A Standard cluster created **before** the restriction
reaches the account is grandfathered and may add standby/read-only nodes
later at the old rates. The owner must decide (D-3) whether to (a) rely on
Advanced Edition at launch, (b) create the Standard cluster before the
deadline and add a standby at launch time, or (c) launch without a standby
(single-node automatic-failover posture only — provider-confirmed that even
single-node Standard clusters "feature automatic failover", but HA-with-
standby is the stronger guarantee). Advanced Edition's newly announced
"Basic - Shared CPU" plans (8–64 GiB) may land between these figures —
pricing for that SKU is not yet documented (U-4).

### 10.3 Cost-control levers

- Per-second billing with 1-minute minimum; fixed `instance_count` on shared
  plans (no autoscaling surprise billing on the beta plan).
- Transfer allowances pooled team-wide; **usage dashboards do not show App
  Platform accrued transfer** (provider-documented gap) ⇒ set billing alerts
  (D-8) and treat a sustained rise in `/api/health` traffic counters as the
  usage signal.
- DB and Spaces-to-app traffic do not count against the App Platform
  allowance (DB confirmed; Spaces→app counts against the Spaces allowance,
  not the app's).

## 11. Backup and restore strategy (provider layer; repo procedures unchanged)

| Layer | Mechanism | Verified evidence |
|---|---|---|
| PostgreSQL | Provider daily full backup + WAL ⇒ PITR to any second within the previous 7 days; manual restore from backups documented | PostgreSQL features page (2026-11-18); restore how-to exists |
| PostgreSQL (repo layer) | `pg_dump --format=custom` before every migration step + restore drills (`MIGRATIONS.md` §5) + `check-postgres-schema-readiness.ts` / `verify-postgres-migration.ts` | Phase 3 drill record; Gate A.3 evidence requirements unchanged |
| Media | Spaces (Ceph — redundant, fault-tolerant); optional S3 versioning; optional off-provider copies via repo's backup-media ledger | Spaces features page; repo `backup-media.ts` unchanged |
| Provider-level PITR caveat | The provider's restore-to-timestamp flow must be **exercised once** before being relied on (`MIGRATIONS.md` §5 already mandates this for managed-PITR) | Standing repo rule |
| Beta duty (unchanged) | One `backup-all` + restore drill on the deployed environment before the first cohort (RC checklist §6 operator items) | `PHASE5_RELEASE_CANDIDATE_CHECKLIST.md` |

Database dumps (runtime data) must **never** be pushed into a Spaces bucket
that bean-sync can see — the publish-time runtime-data scan stays binding;
dump storage location is an owner decision (D-10) if off-provider copies are
wanted (e.g. a second private Space or external storage).

## 12. Scaling path

1. **Vertical (beta → small growth):** resize the service instance
   (`apps-s-1vcpu-2gb` → `apps-s-2vcpu-4gb` → dedicated plans); config-only.
2. **Horizontal (growth):** `instance_count: 2+` ⇒ provider HA becomes
   available (≥2 containers); **must simultaneously** flip
   `RATE_LIMIT_BACKEND=postgres` + `CACHE_BACKEND=postgres` (HP-3) and move to
   pooled DB connections (PgBouncer pool URI or a raised `connection_limit`
   budget under the 25-connections/GiB rule).
3. **Queue split (throughput):** `QUEUE_ENABLED=false` on web + a worker
   component (`bun scripts/queue-drain.ts`) — requires bun in the runner
   image (one reviewed Dockerfile change, owner-gated) or a compiled worker
   entry; claims are atomic so N workers are safe.
4. **Media growth:** Spaces CDN edge (optional, free) is deliberately **not**
   enabled while media stays app-proxied for authorization; if the product
   later adds public/CDN-served assets, that is a product change with its own
   review.
5. **DB growth:** Standard nodes resize to 4 GiB (restriction ceiling for new
   clusters); beyond that, fork/migrate to Advanced Edition (provider-documented
   resize path; Advanced also unlocks read-only standby pools and physical backups).

## 13. Known risks, unconfirmed requirements and unresolved questions

**Unconfirmed (deploy-time verification list — none blocks the verdict):**

- **U-1 gVisor sandbox:** Prisma query engine, `sharp`, `pdf-parse` under the
  App Platform container runtime. No documented incompatibility; must be
  smoked in the first deployed preview (resume upload/parse, image ops,
  register/login, one upload, one generation).
- **U-2 Image build time/memory on the provider builder:** repo builds in
  minutes locally; the builder allocates 8 CPU/15 GiB (limit 1 h) — expected
  fine, verify first build duration.
- **U-3 Spaces↔App Platform transfer classification:** the free intra-region
  rule is documented for Spaces→**Droplets** in BLR1; Spaces→App-Platform
  traffic is presumed to count against the Spaces 1,024 GiB allowance
  (harmless at beta scale) — verify on the first invoice.
- **U-4 Advanced Edition "Basic - Shared CPU" plan pricing** (new SKU,
  announced available 15 Oct 2026): not documented at fetch time; obtain from
  the console before choosing the HA path (D-3).
- **U-5 SigV4 signing-region behavior:** the app defaults `S3_REGION` to
  `auto` (an R2 convention) when unset; DigitalOcean documents `us-east-1`
  for Spaces AWS-SDK clients — the blueprint pins `S3_REGION=us-east-1`; the
  first presign/PUT smoke confirms it.
- **U-6 CPDoS posture:** confirm `Cache-Control` on deployed public responses
  (`/`, `/u/*` documents: `no-store`; data endpoints: `private, no-store`)
  matches the provider's Next.js guidance.
- **U-7 600 s edge-upload timeout vs classic fallback path:** confirm the
  presigned transport is the active one in the deployed preview (classic
  path must remain a rare fallback only).

**Known risks (recorded; none beta-blocking):**

- **R-P1** Runtime sandbox (U-1) — mitigation: deployed-preview smoke list
  before any cohort sees the app.
- **R-P2** PostgreSQL Standard HA restrictions for new clusters (30 Nov 2026
  deadline; §10.2) — mitigation: owner decision D-3 made before launch
  provisioning.
- **R-P3** Spaces CORS misconfiguration would silently degrade uploads to the
  classic fallback (bounded by the 600 s edge timeout) — mitigation: CORS
  step in the deploy runbook + U-7 smoke.
- **R-P4** No accrued-transfer visibility for App Platform — mitigation:
  billing alerts + `/api/health` counters (D-8).
- **R-P5** Single-container beta = single point of failure (provider
  automatic restarts via liveness checks; no standby) — accepted beta posture,
  consistent with the RC checklist.
- **R-P6** HSTS/headers are the app's responsibility on this platform —
  already implemented; re-verify in the deployed preview (GO_LIVE B.1-5).
- **R-P7** `NEXT_PUBLIC_APP_URL` is build-time-inlined — any origin change
  requires redeploy (documented; starter domain for beta makes this a
  non-issue until a custom domain is chosen).
- **R-P8** Worker split requires a runner-image change (bun) — future,
  owner-gated; not needed in the single-instance beta topology.

## 14. Exact owner decisions still required

| # | Decision | Why it cannot be defaulted |
|---|---|---|
| D-1 | Approve DigitalOcean App Platform + Managed PostgreSQL + Spaces in BLR/BLR1 as THE provider; authorize creating the beta resources (billing starts) | Provisioning/billing is explicitly outside this task's authorization |
| D-2 | Confirm the beta plan: `apps-s-2vcpu-4gb` ($50/mo) vs the untested cheaper `apps-s-1vcpu-2gb` ($25/mo) | Measured envelope is 2-vCPU; 1-vCPU is untested |
| D-3 | PostgreSQL HA strategy for launch: Advanced Edition (~$260/mo) vs grandfathered Standard+standby (create cluster before the 30 Nov 2026 restriction deadline; ~$61/mo) vs launch without standby | Time-sensitive plan-change (R-P2) with a 4× cost spread |
| D-4 | Beta origin: starter `*.ondigitalocean.app` (recommended, $0) vs custom domain (purchase + DNS) | `NEXT_PUBLIC_APP_URL` is build-time; DNS is an owner-controlled change |
| D-5 | `NEXT_PUBLIC_APP_URL` value (the exact origin) | Required before the first build; permanent share-URL source |
| D-6 | TLS verification posture for the DB: `sslmode=require` (beta, recommended) vs `verify-full` (requires CA-cert injection mechanism on a volume-less host) | Security hardening vs added deployment complexity |
| D-7 | Trusted-sources enablement timing (after first deploy) and scope (app + operator IPs) | Provider limit forces an ordering; firewall posture is owner-owned |
| D-8 | Billing alert thresholds (team-level) given the transfer-visibility gap | Cost control must be configured by the owner |
| D-9 | Spaces S3 versioning on/off (object-level rollback vs simplicity) | Optional durability feature with lifecycle implications |
| D-10 | Off-provider dump storage location for repo-layer backups (second Space vs external) | Runtime-data placement is owner-owned; bean-sync scan stays binding |
| D-11 | Confirm Gates A (migration) and B (deployment) remain unexecuted until separately authorized — this document does not schedule them | Standing boundary statement |

---

## 15. Boundary statement (binding)

This document is an assessment and a blueprint. As of its writing: **no
DigitalOcean account resource has been created, no plan or billable resource
was started, no domain was registered or changed, no secret was requested or
exposed, no production database was connected to, no DDL was applied, no
migration was run, nothing was deployed, and no DNS record changed.** The
registered migration chain (O2.1 → O7), the gate structure (A → B → C) and the
product architecture are untouched. Deployment begins only when the owner
opens Gate A and Gate B, each with its own explicit authorization, using the
procedures already pinned in `PHASE5_POSTGRES_DEPLOYMENT_PREREQUISITES.md` and
`GO_LIVE_CHECKLIST.md`.
