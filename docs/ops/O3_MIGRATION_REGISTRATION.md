# O3 Migration Registration — Opportunity & OpportunitySkill models (M-O3)

**Status: REGISTERED — PostgreSQL variant NOT applied anywhere (deployment
prerequisite). SQLite variant applied ONLY to this workspace's isolated QA
database (`db/custom.db`, behind the fail-closed guard
`scripts/ops/qa-db-env.sh`), after a verified backup and a restore
rehearsal. No production database exists or was touched in this sandbox.**

The registered SQL files are **exact, byte-for-byte `prisma migrate diff`
output** (from-schema-datamodel → to-schema-datamodel at the M-O3 change
boundary `e073faa0…` → working tree) — nothing hand-written or hand-edited.

## 1. Registered migration SQL (canonical artifacts)

| Dialect | Artifact (exact generated SQL) | SHA-256 | Bytes |
| --- | --- | --- | --- |
| SQLite | `docs/deployment/o3-opportunity-models-additive-sqlite.sql` | `292e7650924c2202cfb7a42a06471d525b1f436d569daefa3afa432d23e272ee` | 2123 |
| PostgreSQL | `docs/deployment/o3-opportunity-models-additive-postgres.sql` | `ec20abf027d58d5be3889ce7f3c4ff32893c754a3287a54b771b24836c988671` | 2449 |

Content summary — **purely additive**:

- `CREATE TABLE "Opportunity"` (22 columns; salary bounds as native `BIGINT`;
  FKs: `organizationId → EmployerOrganization` CASCADE,
  `createdByUserId → User` SET NULL, `publishedByUserId → User` SET NULL)
- `CREATE TABLE "OpportunitySkill"` (compound `PRIMARY KEY (opportunityId, skillId)`;
  FKs: → `Opportunity` CASCADE, → `Skill` CASCADE)
- 4 `CREATE INDEX` statements (`Opportunity_organizationId_status_idx`,
  `Opportunity_status_updatedAt_idx`, `Opportunity_createdByUserId_idx`,
  `OpportunitySkill_skillId_idx`)

Destructive-statement screen: `DROP / DELETE / UPDATE / TRUNCATE / RENAME /
ALTER COLUMN` — **zero matches** in both artifacts (the `ON DELETE/UPDATE`
phrases inside FK constraint definitions are the only matches of a naive
screen and are additive constraint DDL).

## 2. Execution order and preconditions

1. **Backup first** (non-negotiable, `MIGRATIONS.md` §2 Step 0):
   `DATABASE_URL="file:<qa-db>" bun scripts/ops/backup-db.ts --out <dir>`
   — verified in this workspace (pre-schema backup
   `db-2026-11-18T07-34-59-441Z.sqlite3`, sha256
   `89b6bfbfa4e144140fbce577bfe3be6d21d867f8f6d0c8a0a58cc4ebd1fa7712`,
   90 tables, integrity ok) **and a restore rehearsal into a throwaway
   path** (`restore-db.ts --from … --to /home/z/o3-qa-backups/rehearsal-restored.db`,
   integrity ok, 90 tables).
2. **Fail-closed guard**: `scripts/ops/qa-db-env.sh assert` must pass before
   any DB-touching command (refuses unset/ambiguous/foreign/non-SQLite
   targets, refuses to run inside the preserved legacy workspace).
3. **SQLite (sandbox/QA only)**: `bunx prisma db push` with the explicitly
   pinned `DATABASE_URL` — no `--accept-data-loss` (never permitted).
   Post-push verification: 92 tables, `PRAGMA integrity_check` = ok,
   `PRAGMA foreign_key_check` = 0 violations.
4. **PostgreSQL (deployment prerequisite — NOT executed)**: review
   `docs/deployment/o3-opportunity-models-additive-postgres.sql` statement
   by statement, take a `pg_dump` backup, apply exactly once, then verify
   with `bun scripts/check-postgres-schema-readiness.ts` and
   `bun scripts/verify-postgres-migration.ts` per `MIGRATIONS.md` §2/§6.
   The `information_schema` column-type gate from O2.1 applies unchanged.

## 3. Parity gate

`bun scripts/check-schema-parity.ts` → `SCHEMA PARITY OK — 92 models
identical across sqlite + postgres mirror` (90 pre-O3 + the two new models
byte-identical in both schema files).

## 4. Rollback

Forward-only at the schema level (`MIGRATIONS.md` §3). Data-level rollback =
restore the verified pre-migration backup into a scratch path and re-apply a
corrected migration. The two new tables carry no pre-existing data and no
existing table was altered, so N-1 application compatibility is structural.
