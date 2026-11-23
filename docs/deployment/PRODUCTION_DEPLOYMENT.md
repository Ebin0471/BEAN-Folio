# BEAN Folio — Production Deployment

The canonical, verified deployment path is the production Compose stack.
This page is the deployment entry point; deep-dive documents are linked.

## Deployment paths (in order of preference)

1. **Docker Compose (self-hosted, Tier A/B)** — [`DOCKER_SETUP.md`](./DOCKER_SETUP.md)
   Caddy auto-HTTPS → app → PostgreSQL 16. Resource ceilings, log rotation,
   persistent volumes, healthchecks, graceful SIGTERM drain included.
2. **systemd + node (no Docker)** — `deploy/bean-folio.service` ships a
   hardened unit; see [`DEPLOYMENT_OPTIONS.md`](./DEPLOYMENT_OPTIONS.md).
3. **Vercel** — `bun run vercel-build` (Postgres schema mirror; additive-only
   SQL migrations in this directory).

## Required environment (values never committed)

Full annotated template: `.env.example` (app) and `.env.compose.example`
(compose). Minimum set:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | `postgresql://…?connection_limit=10&pool_timeout=10` in compose; startup validation refuses other schemes in production |
| `NEXT_PUBLIC_APP_URL` | Public origin, baked into the client bundle at build time |
| `RATE_LIMIT_BACKEND` / `CACHE_BACKEND` | `postgres` for multi-instance (compose sets both). Value `db` seen in older docs is INVALID — startup validation allows only `memory\|postgres` |
| `MEDIA_STORAGE_DRIVER` | `local` (volume) or `s3` — S3 is all-or-nothing: partial config refuses to start |
| `METRICS_TOKEN` | Bearer for `GET /api/metrics` (recommended in production) |
| `ERROR_WEBHOOK_URL` | Optional 500-alarm webhook |

## Pre-flight (every deployment)

```bash
bunx prisma validate --schema prisma/schema.postgres.prisma
bun run scripts/check-schema-parity.ts        # 100/100 model parity gate
bun run scripts/check-postgres-schema-readiness.ts   # exit 0 required
```

## Release procedure

```bash
git pull
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose exec app bunx prisma db push --schema prisma/schema.postgres.prisma
curl -fsS https://<domain>/api/ready && curl -fsS https://<domain>/api/health
```

Rollback = redeploy the previous image tag (build/tag images in CI before
pushing tags); the database is additive-migration-only, so old images remain
compatible. Schema policy and the additive SQL history live in
[`production-deployment.md`](./production-deployment.md) §2.

## Health contract

- `GET /api/health` — liveness, aggregate queue/cache counters, `no-store`;
  stays green during a DB outage.
- `GET /api/ready` — DB `SELECT 1` with 2 s race; 503 + `no-store` when not ready.
- `GET /api/metrics` — Prometheus exposition (`METRICS_TOKEN`).
