# BEAN Folio — Docker Setup (dev + production)

Portable container setup. Identical commands work on **Linux**, **macOS**
(Docker Desktop / OrbStack), and **Windows** (PowerShell in Docker Desktop /
WSL2 — Linux containers, not Windows containers). Requires Docker Engine with
Compose v2 (`docker compose version` ≥ v2.20).

Repository files:

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build → non-root standalone runtime, health-checked, SIGTERM-graceful |
| `docker-compose.yml` | Production stack: Caddy (auto-HTTPS) → app → PostgreSQL 16; resource ceilings; bounded log rotation; persistent volumes |
| `docker-compose.dev.yml` | Development stack: hot-reload Next dev server, isolated DB/media volumes |
| `.env.compose.example` | Production env template (placeholders only) |
| `.dockerignore` | Source-only build context — no node_modules/.env/runtime data enters any image layer |

---

## 1. Development (`docker compose -f docker-compose.dev.yml`)

Isolated by construction: the dev database, media and GIFTZ workspaces live in
named volumes — nothing writes into your checkout except Next's own caches.

```bash
# start (Linux/macOS)
docker compose -f docker-compose.dev.yml up --build

# Windows PowerShell — identical
docker compose -f docker-compose.dev.yml up --build
```

- App: http://localhost:3000 (hot reload on save)
- Logs: `docker compose -f docker-compose.dev.yml logs -f app`
- Stop: `docker compose -f docker-compose.dev.yml down`
- Stop + wipe dev data: `docker compose -f docker-compose.dev.yml down -v`

What it does on boot: `bun install --frozen-lockfile` → `prisma db push`
(SQLite at `file:/data/dev.db`) → `next dev -H 0.0.0.0`.

## 2. Production (`docker compose -f docker-compose.yml`)

```bash
cp .env.compose.example .env.compose       # then EDIT it — real secrets, outside git
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose ps
curl -fsS https://<your-domain>/api/health # liveness (no-store)
curl -fsS https://<your-domain>/api/ready  # readiness (DB probe)
```

Topology: **proxy (Caddy, ACME TLS)** → **app (standalone Next, port 3000
internal-only)** → **db (PostgreSQL 16, no exposed ports)**.

Hardening already baked in (verify, don't trust):

- `db` has NO published ports — reachable only on the internal compose network.
- No secrets baked into images: everything runtime comes from `.env.compose`;
  `NEXT_PUBLIC_APP_URL` is the sole build arg (public by definition).
- Resource ceilings: app 2 GB / 2 CPUs, db 1 GB / 1.5 CPUs, proxy 256 MB;
  PIDs capped; json-file logs rotated (3 × 10 MB).
- `CODE_GIFTZ_WORKSPACE_ROOT=/app/data/giftz-workspaces` on the `app_data`
  volume: GIFTZ editing workspaces + LAXII temp survive container restarts.
- Startup refuses to come up half-configured: `src/lib/startup-validation.ts`
  fail-fast validates DB scheme, S3 all-or-nothing, cookie policy, backend
  enums — a broken env exits non-zero instead of serving a broken app.

Shutdown / upgrade:

```bash
docker compose --env-file .env.compose down          # graceful SIGTERM → queue drain (≤27 s)
git pull && docker compose --env-file .env.compose up -d --build   # upgrade in place
```

Schema migration on upgrade (additive-only policy — never destructive):

```bash
docker compose --env-file .env.compose exec app bunx prisma db push --schema prisma/schema.postgres.prisma
```

## 3. Multi-platform images (amd64 + arm64)

Dependencies are pure-JS + Prisma engines (both arches published upstream), so
buildx multi-platform works:

```bash
docker buildx create --use
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/bean-folio:TAG --push .
```

(Not verified in the sandbox — no Docker daemon here. CI builds amd64 images
on every push; arm64 needs the buildx command above on a buildx host.)

## 4. Backup / restore / operations

- Backups & restore: [`BACKUP_AND_RESTORE.md`](./BACKUP_AND_RESTORE.md)
- Production runbook: [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md)
- Operations & incident diagnosis: [`OPERATIONS_RUNBOOK.md`](./OPERATIONS_RUNBOOK.md)
- Metrics & alerts: `GET /api/metrics` (Prometheus; set `METRICS_TOKEN`).

## 5. Fresh-machine quick start (any OS)

```bash
git clone https://github.com/Ebin0471/BEAN-Folio.git && cd BEAN-Folio
docker compose -f docker-compose.dev.yml up --build     # dev on :3000
# — or production —
cp .env.compose.example .env.compose && $EDITOR .env.compose
docker compose --env-file .env.compose up -d --build
```
