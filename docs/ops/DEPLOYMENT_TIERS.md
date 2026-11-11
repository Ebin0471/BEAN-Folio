# BEAN Folio — Deployment Tiers (A / B / C)

**Summary:** Three concrete deployment tiers with explicit assumptions (traffic, storage,
bandwidth, region), component choices, and monthly **cost ESTIMATES**. Every cost figure here is
a **range based on public list-price ballparks at the time of writing — NOT a quote. Verify
current provider pricing before budgeting**; providers change SKUs, free tiers and egress prices
frequently, and usage-based components (egress, AI) scale with your traffic, not with this doc.

The app itself is tier-agnostic by construction: a stateless Next.js standalone server + Prisma
+ swappable storage/queue/rate-limit backends selected by environment variables (§5).

---

## Tier A — Development / low-cost launch

**Target:** sandbox, demos, a first production launch with real but modest traffic.
**Expected ceiling: ~100–500 concurrent users** (assumption: ~10% of concurrent users are
actively issuing requests → roughly **5–50 RPS** average, brief spikes ×3).

**Explicit assumptions**

| Dimension | Assumption |
|---|---|
| Traffic | ≤ 50 RPS avg, ≤ 150 RPS spike; ~1–5k registered users |
| Media storage | ≤ 50 GB |
| Bandwidth | ≤ 1 TB/month |
| Region | one region (e.g. US East or EU Central), single AZ |
| DB size | ≤ 5 GB |
| AI spend | bounded in-app: `INTELLIGENCE_DAILY_COST_LIMIT_USD` per-user daily cap + 30/day legacy quota |

**Components**

| Concern | Choice |
|---|---|
| App | 1× small instance (1–2 vCPU VM / Fly.io / Railway) running `NODE_ENV=production bun .next/standalone/server.js`, **or** serverless (Vercel) via the `vercel-build` script |
| Database | SQLite (`db/custom.db`, fine for a single node + nightly backups) **or** the smallest managed PostgreSQL (free/cheapest tier) via `prisma/schema.postgres.prisma` |
| Worker | in-process (`QUEUE_ENABLED` default `true`) — queue + sweeps ride along with the web process |
| Media | local disk (self-host) or a single private S3-compatible bucket; media streams through `/api/media/:id/raw` (bucket stays private) |
| Cache / rate limit | none — in-process cache + `RATE_LIMIT_BACKEND=memory` (correct at 1 instance) |
| TLS/edge | provider's TLS (Vercel) or Caddy/nginx in front of the standalone server |
| Backups | `bun scripts/backup-db.ts` on cron (keeps 14) + provider PITR when on managed PG; S3 versioning when on a bucket |

**Known ceilings (what breaks first):** SQLite single-writer under write bursts; the 4.5 MB
serverless upload cap on Vercel; in-flight AI generation shares the web process; a restart
interrupts long turns (they self-recover via queue heartbeat + studio sweep — visible, not lost).

**Monthly cost ESTIMATE (ranges, list-price ballparks — verify current pricing):**
**≈ $0–60/month.** Serverless hobby tier $0 → pro ~$20; smallest managed Postgres $0 (free
tier) → ~$25; one small VM (if self-hosting) ~$5–12; single bucket + trivial egress $0–5.
Realistic launch bill: **$0–30/month**; the range tops out with a paid DB tier + small VM.

---

## Tier B — Growth

**Target:** product-market fit, multiple deployments per week, first real abuse pressure.
**Expected ceiling: ~5k–20k concurrent users** (assumption: **~500–2,000 RPS** average,
spikes ×2–3; cache hit ratio ≥ 70% on public portfolio reads).

**Explicit assumptions**

| Dimension | Assumption |
|---|---|
| Traffic | 500–2,000 RPS avg |
| Media storage | 100–500 GB |
| Bandwidth | 5–20 TB/month |
| Region | one primary region, app tier 2+ AZs; DB single-writer + automated failover optional |
| DB size | 20–100 GB |
| Team | 2–5 engineers on call |

**Components**

| Concern | Choice |
|---|---|
| App | **2+ instances behind a load balancer** (managed LB or Caddy/NGINX node), zero-downtime deploys via instance rotation; previous build artifact kept for rollback |
| Database | managed PostgreSQL **with connection pooling** (pgBouncer / Neon pooler / RDS Proxy / Supabase pooled port) — each app instance opens its own Prisma pool |
| Shared rate limiting | `RATE_LIMIT_BACKEND=postgres` (works today, no new infra) — **or** a managed Redis-compatible store (Upstash / ElastiCache / Cloudflare Workers KV-class). The app's limiter interface (`src/lib/rate-limit-backend.ts`) has memory + postgres backends; **a Redis adapter is the expected swap point** |
| Cache layer | today the app-level TTL cache (`src/lib/cache.ts`) is **in-process per instance** — publish/unpublish invalidates only the handling instance. At 2+ instances, run the same interface against Redis (swap point named in code) so invalidation is fleet-wide |
| Workers | **dedicated queue workers**: `QUEUE_ENABLED=false` on web instances + N× `bun scripts/queue-drain.ts` processes (scale while `/api/health` → `oldestQueuedAgeMs` stays high) |
| Media | S3-compatible bucket + **CDN** in front of public reads; lifecycle rules (expire incomplete uploads, transition old media to infrequent access); private bucket, app-proxied serving unchanged |
| Observability | log aggregation (structured JSON lines already emitted) + external uptime alerts on `/api/health` (1 min) and `/api/ready` (5 min) + alert rules from `docs/ops/RUNBOOK.md` §5 |
| Backups | managed PG PITR + daily `pg_dump` off-host; drill per `docs/ops/MIGRATIONS.md` §5 |

**Known ceilings:** single-writer Postgres write throughput (view-ledger upserts + queue claims);
offset pagination cost on big discovery lists (keyset swap, §5); whole-object media buffering
(≤64 MB) without presigned uploads; CDN cannot cache the CSR-only public pages beyond the shell.

**Monthly cost ESTIMATE (ranges, list-price ballparks — verify current pricing):**
**≈ $150–800/month.** Indicative split: LB $15–30 · 2–3 app VMs $40–160 · 1–2 worker VMs
$10–40 · managed PG (pooled, ~50 GB) $30–200 · Redis-compatible store $10–60 · S3/R2 + CDN
egress $25–150 · logging/uptime $0–80. Usage-based lines (egress, AI) dominate the upper half
of the range.

---

## Tier C — 100k concurrent target

**Target:** sustained ~100,000 simultaneous users (assumption: **~5,000–20,000 RPS** at the app
tier after CDN offload, spikes ×2; ≥ 85% public-read cache hit ratio; ~2–10 TB media;
**50–200+ TB/month bandwidth**; global audience → global edge + one primary write region).

> **Explicit honesty sentence:** a free tier cannot guarantee 100k simultaneous users. At this
> tier you are buying multi-AZ redundancy, tested failure domains, and an on-call rotation —
> infrastructure alone does not make the SLO true; the drills in §"DR" below do.

**Components**

| Concern | Choice |
|---|---|
| App | **autoscaling fleet across N+ zones/AZs** (K8s/ECS/Nomad or serverless containers), HPA on RPS+latency, surge ≥ 1 extra replica per zone (N+1), rolling deploys with readiness gates on `/api/ready` |
| Database | **HA PostgreSQL: primary + ≥1 replica (multi-AZ), pooling (pgBouncer/RDS Proxy), PITR, read replicas for discovery/insights reads**; alerts on replication lag; connection budget per instance pinned |
| Cache | **distributed cache cluster** (Redis-compatible, clustered/replicated, multi-AZ): shared rate limiting (`RATE_LIMIT_BACKEND` → Redis adapter), fleet-wide app cache invalidation, and (recommended) session-adjacent hot data |
| Queue | **worker fleet** (`queue-drain.ts` ×N across AZs, sized off `oldestQueuedAgeMs`), **DLQ alerting** (`byStatus.DEAD` growth alarm + replay runbook `docs/ops/RUNBOOK-QUEUE.md` §7), per-user concurrency tuned per fleet |
| Edge | **global CDN + WAF + DDoS protection** (e.g. Cloudflare/Fastly/CloudFront+Shield): TLS, bot filtering, rate-limit-at-edge for unauthenticated floods |
| Media | object storage + **edge image optimization/resize** (CDN transform or a resize worker), lifecycle policies, versioning, cross-region replication for durability |
| Observability | full stack: **metrics + traces + logs with SLO alerting** (OTel/Sentry/Prometheus/Loki/Grafana or equivalent) — request IDs (`handler()`), queue depth/oldest, 5xx rate, p95/p99, DB connections, storage errors, AI failure/cost bursts per `docs/ops/RUNBOOK.md` §5 |
| DR | **multi-AZ (minimum), tested disaster recovery: declared RTO/RPO targets, e.g. RTO ≤ 1h, RPO ≤ 5 min, validated by a quarterly restore drill** (`docs/ops/MIGRATIONS.md` §5) + region-failover runbook; backups off-region |
| Security | secrets manager + rotation; CSP pass (Tier C follow-up in `docs/SECURITY_NOTES.md` §4); WAF-managed rules; audit-event retention review |

**What gets engineered at this tier (code swaps, not config):** keyset pagination on discovery
(B-12), streaming/`Range` media serving (B-13), SSR/ISR for public portfolios (B-15 — crawlers
and TTFB), presigned direct uploads (B-13/§5), possibly sharded/queued view-ledger writes.

**Monthly cost ESTIMATE (ranges, list-price ballparks — verify current pricing):**
**≈ $5,000–30,000+/month** at 100k concurrent sustained. Indicative split: app fleet
$1,000–8,000 · HA Postgres (multi-AZ + replicas + PITR storage) $1,000–5,000 · cache cluster
$200–1,000 · queue fleet $200–1,000 · CDN + WAF + DDoS $300–3,000+ · storage + egress at
50–200 TB $500–5,000 · observability $300–3,000 · DR/standby $1,000–5,000. Egress and
observability are the classic bill surprises — set budget alerts on both from day one.

---

## 5. Portability — moving between tiers

**Config-only moves (env vars / flags — no code changes):**

| Lever | A | B | C | Effect |
|---|---|---|---|---|
| `DATABASE_URL` | `file:./db/custom.db` | managed PG (pooled) | HA PG (pooled, replicas) | engine + scale swap; schemas stay in lockstep (`scripts/check-schema-parity.ts`) |
| `RATE_LIMIT_BACKEND` | `memory` (default) | `postgres` (today) or Redis adapter | Redis adapter | shared enforcement across instances; falls back to memory per-call on backend failure |
| `QUEUE_ENABLED` | `true` (in-process) | `false` on web | `false` on web | worker ownership split |
| `QUEUE_CONCURRENCY` / `QUEUE_POLL_MS` / `QUEUE_USER_CONCURRENCY` | defaults | tuned | tuned per fleet | throughput vs fair-share |
| `MEDIA_STORAGE_DRIVER` + `S3_*` | `local` or single bucket | bucket + CDN | bucket + CDN + edge transforms + replication | durability + delivery |
| `NEXT_PUBLIC_APP_URL` | any HTTPS origin | production origin | production origin | canonical share URLs (build-time inlined — redeploy after changes) |
| `NODE_ENV` / `SESSION_SECURE_COOKIES` | dev/prod | `production` | `production` | secure cookies + HSTS |

**Expected code swaps (named swap points — small, localized, no redesign):**

1. **Redis cache adapter** — `src/lib/cache.ts` (app cache) and `src/lib/rate-limit-backend.ts`
   (limiter) already isolate the backend; add a Redis-compatible implementation of the same
   interface when scaling past one instance or when postgres-bucket churn gets hot.
2. **Presigned direct uploads** — replaces the server-proxied multipart path above ~4.5 MB;
   design in `docs/media-pipeline.md` §5; needed at Tier B for video-heavy users, mandatory
   at Tier C.
3. **Keyset pagination at scale** — offset pagination (B-12) is fine on bounded pools at Tier A/B;
   swap discovery/search/admin lists to keyset before the tables pass ~10⁵–10⁶ rows.
4. **SSR/ISR for public portfolios** — CSR-only public pages (B-15) cap CDN benefit and SEO;
   the Tier C evolution documented in `docs/architecture.md` §5 (no UI redesign required).
5. **Streaming media serving** — replace whole-object buffering (B-13) for 64 MB video at Tier C.

## 6. Related docs

`docs/ops/RUNBOOK.md` (deploy/scaling/incidents) · `docs/ops/MIGRATIONS.md` (additive policy +
backup/restore drills) · `docs/ops/RUNBOOK-QUEUE.md` (queue ops) ·
`docs/architecture-review/BOTTLENECK_REPORT.md` (the B-1…B-18 items referenced above) ·
`docs/deployment.md` (first deploy + Vercel cutover runbook)
