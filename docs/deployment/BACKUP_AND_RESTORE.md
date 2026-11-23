# BEAN Folio — Backup & Restore

Binding policy: DEVELOPMENT_SAFETY.md §3 (never restore older data over
newer without approval; never blindly commit the live DB). The M21 verified
tooling is the only supported path.

## What exists (verified tooling)

| Tool | Backs up | Evidence of correctness |
|---|---|---|
| `scripts/ops/backup-db.ts` | SQLite `VACUUM INTO` snapshot + SHA-256 manifest (pg_dump command printed for Postgres hosts) | protocol §6: row-parity verified |
| `scripts/ops/backup-media.ts` | `uploads/` archive + SHA-256 manifest; row count must equal `MediaAsset` rows | protocol §6: 29 files == 29 rows verified |
| `scripts/ops/backup-all.ts` | DB + media orchestration, guarded retention | verified end-to-end on the 100-model schema |
| `scripts/ops/restore-from-backup.ts` | guarded restore with pre-restore backup + isolated drill mode | protocol §2 |

## Production (Postgres in compose)

```bash
# logical dump (run from the host; consistent, compressed, timestamped)
docker compose --env-file .env.compose exec -T db \
  pg_dump -U beanfolio -d beanfolio -Fc \
  > "backups/beanfolio-$(date +%Y%m%d-%H%M%S).dump"   # Windows PowerShell: "> \"backups\\beanfolio-$($(Get-Date).ToString('yyyyMMdd-HHmmss')).dump\""

# verify a dump is readable
docker compose --env-file .env.compose exec -T db pg_restore --list < first.dump | head

# media (single-host tier: the `media` volume)
docker run --rm --volumes-from $(docker compose --env-file .env.compose ps -q app) \
  -v "$(pwd)/backups:/backup" alpine tar czf /backup/media-$(date +%Y%m%d-%H%M%S).tgz /data/uploads
# S3 tier: bucket versioning + lifecycle rules are the backup (no local step).
```

## Restore drill (isolated FIRST — never over live state)

```bash
# 1. create a scratch stack
docker compose -p bean-restore --env-file .env.compose up -d db
# 2. restore into scratch
cat backups/<dump>.dump | docker compose -p bean-restore exec -T db \
  pg_restore -U beanfolio -d beanfolio --clean --if-exists
# 3. integrity probes (row counts vs manifest; FK checks via app boot)
# 4. only after human approval: point the real stack at the restored volume
```

SQLite development path uses the M21 scripts directly (they guard against
production contexts via `scripts/lib/seed-guard.ts`-style checks).

## Upgrade safety

- Schema changes are additive-only; `prisma db push` on the Postgres mirror
  after every image upgrade (`PRODUCTION_DEPLOYMENT.md` §Release).
- Take a dump immediately BEFORE any schema push.
- Retention: keep ≥ 7 daily + 4 weekly dumps off-host (rsync/S3 sync of
  `backups/`), rotations guarded — never delete the newest backup.

## What is NEVER backed up / restored

- `.env.compose`, `.git/bean-auth/` vault (secrets stay out of backups and Git)
- Nothing from `deploy`/preservation branches — they carry historical DB
  blobs and must never be resurrected into the live stack
