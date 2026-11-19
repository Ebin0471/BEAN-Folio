# O4 Migration Registration — TalentMatch additive table

**Status: REGISTERED — PostgreSQL variant NOT applied anywhere (deployment
prerequisite). SQLite variant applied only to the isolated QA database of the
M-O4 workspace (2026-11-19, under verified backup
`b417afc365ad65b8d38d14bac8daa3f646351c212531bd78770ab2f606f91bad` with a
byte-identical restore rehearsal). No production database was touched or
exists in this sandbox.**

Additive-only: one new table `TalentMatch` + three indexes. No existing table,
column or index is touched. Model parity: 93 models identical across both
dialects (`scripts/check-schema-parity.ts`).

## 1. Registered migration SQL (canonical artifacts)

| Dialect | Artifact | SHA-256 |
| --- | --- | --- |
| SQLite | `docs/deployment/o4-talent-match-additive-sqlite.sql` | `2b04e849202fb0026a3796f1a91332957feb098363d2268d3e8cbdd8c7791f7a` |
| PostgreSQL | `docs/deployment/o4-talent-match-additive-postgres.sql` | `4ead00966d4ff501ef1a2596343992cb1b9c6a90767f4f65ffbc5b5d0fb11d85` |

Both files are exact `prisma migrate diff` output (nothing hand-written),
reviewed statement by statement: only `CREATE TABLE` + `CREATE INDEX` — no
`DROP`, `ALTER COLUMN`, `RENAME`, `TRUNCATE`, `DELETE` or `UPDATE` (the only
pattern hits are the `ON DELETE CASCADE / ON UPDATE CASCADE` referential
actions of the new table's own foreign keys).

Reproducibility (verified byte-for-byte this session):

```bash
git show 9d5e57f27d8a9a7ce8eb3736153269995c465f6c:prisma/schema.prisma > /tmp/sqlite-old.prisma
bunx prisma migrate diff --from-schema-datamodel /tmp/sqlite-old.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
# → byte-identical to docs/deployment/o4-talent-match-additive-sqlite.sql
# (same command shape for the postgres mirror)
```

## 2. Execution order (binding)

1. Approval gate — this M-O4 schema change is owner-approved (implementation
   authorization, decisions D1–D15 + safeguards A/B/C).
2. Backup first (`scripts/backup-db.ts`, verified + restore-rehearsed) — done
   this session for the QA database.
3. SQLite (sandbox/dev/QA): apply the exact registered SQL once, then
   `prisma migrate diff --from-url … --to-schema-datamodel prisma/schema.prisma`
   must report an **empty migration** and `prisma db push` "already in sync".
4. PostgreSQL — DEPLOYMENT PREREQUISITE: apply the registered DDL exactly once
   (`psql "$DATABASE_URL" -f docs/deployment/o4-talent-match-additive-postgres.sql`)
   as part of the ordered deployment sequence O2.1 → O3 → O4 → O5 (see
   `docs/ops/O3_MIGRATION_REGISTRATION.md`). Never executed in-sandbox.
5. Verify: `PRAGMA integrity_check` ok, `PRAGMA foreign_key_check` 0 rows,
   table count 93, pre-existing row counts unchanged (users/opportunities
   verified unchanged this session).

## 3. Rollback

Forward-only schema policy (MIGRATIONS.md §3): rollback = restore from the
verified pre-migration backup, or (data-level, additive-safe) drop the
`TalentMatch` table — no existing table is modified by this migration.
