# Deployment options — approved paths (M22 Phase 2, decision O3, 2026-11-14)

Two production paths are prepared and reviewed. **Neither is activated**: this
repo contains no live deployment, and activating either is an explicit owner
action (protocol §3 gate 5). Both run the SAME data model — the PostgreSQL
mirror `prisma/schema.postgres.prisma` (85 models, parity-verified by
`scripts/check-schema-parity.ts`).

## Path A — self-hosted (Docker Compose + Caddy TLS, or systemd + Caddy)

Artifacts (all in-repo, unactivated):

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage build → standalone Next server on the PostgreSQL client; non-root; `HEALTHCHECK /api/health`; SIGTERM queue drain |
| `docker-compose.yml` | app + PostgreSQL 16 + Caddy edge; volumes for pgdata/media; compose env from `.env.compose` (create it yourself — never commit) |
| `Caddyfile.production` | Automatic-HTTPS reverse proxy forwarding `Host` + `X-Forwarded-For` (the rate-limit key depends on the rightmost XFF hop) |
| `deploy/bean-folio.service` | systemd unit for the bare-metal variant (`Restart=always`, SIGTERM drain, hardened) |

Bring-up (Path A, Docker variant):

1. Create `.env.compose` (gitignored): `POSTGRES_PASSWORD`, `BEAN_DOMAIN`,
   `NEXT_PUBLIC_APP_URL=https://<domain>`, optional `LOG_LEVEL`,
   `ERROR_WEBHOOK_URL`.
2. `docker compose --env-file .env.compose up -d --build`
3. Apply the database DDL once: generate it from the mirror
   (`bunx prisma migrate diff --from-empty --to-schema-datamodel
   prisma/schema.postgres.prisma --script > pg-ddl.sql`), review it, then
   apply inside the `db` container. Additive deltas (e.g.
   `docs/deployment/additive-portfolio-models-migration.sql`) follow the
   same review-then-apply flow.
4. Verify: `curl https://<domain>/api/health` → `ok:true`;
   `curl https://<domain>/api/ready` → `ready:true`.

Rollback (Path A): keep the previous image tag (or previous standalone
artifact + symlink flip — production-deployment.md §3.8); the database is
forward-only: additive SQL only, never destructive, restore path is the M21
backup/restore tooling (`scripts/ops/backup-all.ts`,
`scripts/ops/restore-from-backup.ts`).

## Path B — Vercel

Already prepared and verified in-repo: `package.json → vercel-build`
generates the client from the PostgreSQL mirror before `next build`;
`output: "standalone"` and `src/proxy.ts` rewrites are Vercel-compatible.

1. Import the GitHub repo (`Ebin0471/BEAN-Folio`, branch `main`) into Vercel.
2. Provision Vercel Postgres + a private S3-compatible bucket.
3. Set env vars in the Vercel project: `DATABASE_URL` (pooled Postgres URL —
   never hand-typed; see the P1000 note in docs/deployment.md),
   `NEXT_PUBLIC_APP_URL`, all four `S3_*` vars (stateless host — required),
   `RATE_LIMIT_BACKEND=postgres`, optional `ERROR_WEBHOOK_URL`, `LOG_LEVEL`.
4. Redeploy after setting `NEXT_PUBLIC_APP_URL` (build-time inlined).
5. Verify `/api/health` + `/api/ready` as above. Note the ~4.5 MB function
   body limit for the multipart upload path (large videos → presigned
   direct upload, docs/media-pipeline.md §5).

## Before ANY activation

- Run the M21 backup suite against the target (`scripts/ops/backup-all.ts`).
- Production `DATABASE_URL` must point at PostgreSQL; the startup validator
  fails fast on a partial S3 config, insecure cookie policy, malformed
  `DATABASE_URL` and unknown backend values (src/lib/startup-validation.ts).
- The publishing rule is unchanged: GitHub carries source only, published
  exclusively through `scripts/ops/bean-sync.sh` (protocol §5). Runtime
  data, databases, backups, uploads and secrets are never pushed.
