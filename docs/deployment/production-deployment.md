# BEAN Folio — production deployment configuration

Written for the ACTUAL application architecture (Next.js 16 App Router,
`output: "standalone"`, custom cookie sessions, local-or-S3 media storage,
PostgreSQL via Prisma). This document is the deployer's operating manual; the
schema artifacts it references live in `docs/deployment/` and the readiness
probe is `scripts/check-postgres-schema-readiness.ts`.

**Nothing in this document has been executed against a real production host.**
Deployment remains explicitly unauthorized until an owner performs it; every
command below is a documented procedure, not evidence of a deployment.

---

## 1. Topology

```
browser ──HTTPS──▶ reverse proxy (TLS termination, e.g. Caddy/nginx)
                        │  X-Forwarded-For <client>, Host <public host>
                        ▼
             node .next/standalone/server.js   (1 instance per node)
                        │
                        ├── PostgreSQL  (DATABASE_URL)
                        └── media: uploads/ volume  OR  S3-compatible bucket
```

- Single instance is the supported default (in-memory rate limiting).
- Multiple instances: set `RATE_LIMIT_BACKEND=db` so every instance counts
  against the same fixed-window buckets (`RateLimitBucket` table).

## 2. PostgreSQL

1. Provision PostgreSQL 14+; create the database and an application role.
2. Apply the schema:
   - fresh install: `psql "$DATABASE_URL" -f docs/deployment/initial-schema.sql`
     (full 40-table DDL, generated from the schema mirror — includes
     `RateLimitBucket`).
   - upgrading a Phase-5-era 36/39-table database:
     `docs/deployment/additive-schema.sql` (CREATE-only delta; no DROP/ALTER
     TYPE). Never apply it to a database that does not match the documented
     baseline.
3. Verify: `bun run scripts/check-postgres-schema-readiness.ts` must **exit 0**
   (expected inventory: 40 tables incl. `AgentTask`, `GiftzRepository`,
   `AgentArtifact`, `RateLimitBucket`, their indexes and FKs).
4. `DATABASE_URL="postgresql://user:pass@host:5432/beanfolio?sslmode=require"`.
   Never hand-type the URL — copy it from the provider dashboard (see
   `docs/deployment.md` §0.4 for the P1000 troubleshooting flow).
5. Schema policy: **additive only**. The project does not use
   `prisma migrate` on production; schema changes ship as reviewed SQL
   artifacts. There are no destructive migrations in this repository.

## 3. Persistent media storage

- **Self-hosted single instance**: local driver (default). The `uploads/`
  directory is user data — put it on a persistent volume
  (`MEDIA_LOCAL_ROOT=/var/lib/beanfolio` as the base dir containing
  `uploads/`) and include it in backups.
- **Stateless hosts / multi-instance**: S3 driver — set all four of
  `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
  (partial configuration is a startup ERROR, not a silent fallback). Use a
  PRIVATE bucket: all media is served through the authorization-checked
  `/api/media/[id]/raw` route, never by object URL. Enable bucket
  versioning/replication for backup.
- CODE GIFTZ workspaces (`data/giftz-workspaces/`) are disposable working
  copies: each is re-creatable from its git baseline + task records and holds
  no unique user data. Do NOT include them in media backups.

## 4. Session & cookie configuration

| Setting | Value |
|---|---|
| Cookie name | `bean_session` (HttpOnly, Path=/) |
| First-party mode | `SameSite=Lax`, `Secure` automatically in production |
| Embedded (preview) mode | `SameSite=None; Secure; Partitioned` (CHIPS) when the client sends `X-Bean-Embed: 1` from a framed context |
| TTL | 30 days, opaque 256-bit token, stored only as SHA-256 |
| Invalidation | logout (current), password reset (all), account deletion (all), recovery-key rotation (all) |

`SESSION_SECURE_COOKIES` overrides the automatic Secure decision:
`true` forces Secure behind TLS termination, `false` is a **hard startup
error** in production unless `BEAN_ALLOW_INSECURE_COOKIES=1` (deliberate
non-TLS LAN deployment). Defaults need no configuration.

CSRF posture: SameSite cookies + `Origin` validation on every
POST/PATCH/PUT/DELETE (cross-host Origin → 403; no-Origin and embed-marked
requests pass; there is no CORS surface).

## 5. Environment variables

Required: `DATABASE_URL` (see §2). Build-time: `NEXT_PUBLIC_APP_URL` (the
production HTTPS origin — set BEFORE `next build`, or redeploy after
changing). Server-side AI credentials per `docs/ai-integration.md` (optional;
the managed gateway needs no key).

Optional Phase 7 controls (defaults are safe; see `.env.example` for the full
annotated list): `SESSION_SECURE_COOKIES`, `BEAN_ALLOW_INSECURE_COOKIES`,
`RATE_LIMIT_BACKEND=db` (multi-instance), `SCRYPT_COST=hardened` (new-hash
cost; existing hashes verify regardless), `LOG_LEVEL`,
`ERROR_WEBHOOK_URL`, `CSP_ENABLED=0` (escape hatch), `CSP_FRAME_ANCESTORS`.

Startup validation (`src/instrumentation.ts`) fails fast — exit 1 — on:
missing production `DATABASE_URL`; `SESSION_SECURE_COOKIES=false` without the
escape hatch; unknown values of known variables; partial S3 configuration.

## 6. HTTPS requirements

- Terminate TLS at the proxy; forward `Host` unchanged and set
  `X-Forwarded-For <client-ip>` (the rate-limit key uses the RIGHTMOST
  XFF hop — do not add client-controlled headers to that chain).
- Cookies are `Secure` in production (browsers require it for the
  `SameSite=None` embed mode).
- The app sends `Content-Security-Policy` (same-origin defaults; no
  `frame-ancestors` by default). Set `CSP_FRAME_ANCESTORS="'self'"` (or an
  explicit origin list) once the embedding story is fixed. Do NOT add
  `X-Frame-Options` alongside a frame-ancestors decision — CSP supersedes it.

## 7. Process startup

```bash
# build (or in CI): generates the PostgreSQL client + standalone output
bun run vercel-build          # = prisma generate --schema prisma/schema.postgres.prisma && next build && static copy

# run (the repo's own start script sets NODE_ENV=production)
NODE_ENV=production DATABASE_URL=... node .next/standalone/server.js
# (package.json uses bun; node works identically for the standalone server)
```

Startup order: environment validation (`instrumentation.ts`) → Prisma client
→ HTTP listener. A misconfigured production environment refuses to start.

## 8. Health checks

| Probe | Path | Meaning | Use for |
|---|---|---|---|
| Liveness | `GET /api/health` → 200 | process is up (no dependencies touched) | container restart |
| Readiness | `GET /api/ready` → 200/503 | database answers `SELECT 1` AND the media-storage driver responds | load balancer / start traffic |

Both responses are coarse (no versions, no paths, no error details).

## 9. Backup schedule

| Target | Tool | Cadence (recommended) | Retention |
|---|---|---|---|
| PostgreSQL | `bun scripts/ops/backup-db.ts` (wraps `pg_dump --format=custom`, verifies with `pg_restore --list`) or managed-provider snapshots | daily + pre-deploy | 30 days, off-host copy |
| SQLite (single-host) | same script (`VACUUM INTO` snapshot + `integrity_check` + row-count parity) | daily | 30 days |
| Media (local driver) | `bun scripts/ops/backup-media.ts` (tar.gz of `uploads/`, file-count verified) | daily | 30 days |
| Media (S3 driver) | bucket versioning/replication (provider-side) | continuous | provider policy |

Both scripts print verification results and exit non-zero on failure — wire
them to cron/systemd timers with failure alerting (`ERROR_WEBHOOK_URL`).

## 10. Restore / rollback

**Restore rehearsal (executed in Phase 7, see the delivery doc):**
`bun scripts/ops/restore-db.ts --from <backup> --to /tmp/restored.sqlite3`
verifies integrity + row parity without touching the live database. For a
real restore: stop the server →
`bun scripts/ops/restore-db.ts --from <backup> --replace-live --yes` (SQLite)
or `--yes` (PostgreSQL `pg_restore --clean --if-exists`) → restart →
`GET /api/ready` must return 200.

**Application rollback:**
1. Keep the previous standalone build on the host (e.g.
   `.next-releases/<version>/`); rollback = point the service unit back at
   the previous release directory and restart (≤ 1 minute, no data touch).
2. Database rollback = §restore above (schema changes are additive-only, so
   an old binary runs against the new schema).
3. Never roll forward with unapplied SQL artifacts — re-run the readiness
   probe after any schema operation.

## 11. Operational logging & monitoring

- Logs are JSON lines (`LOG_LEVEL`, default `info` in production) to
  stdout/stderr; ship them with any log collector.
- Hard rule: no passwords, tokens, prompt contents, or secret env values in
  logs — string fields pass secret redaction before output.
- Unhandled API failures emit `api.unhandled_error` events and POST to
  `ERROR_WEBHOOK_URL` when configured (redacted metadata only).

## 12. Deployment authorization

No production migration, deployment, or cutover is authorized from this
repository alone. An owner must: provision the host/DB, apply §2, set §5,
build, smoke-test §8 on the real host, and only then route traffic. The
sandbox has verified the build and the procedures, not a production
deployment.
