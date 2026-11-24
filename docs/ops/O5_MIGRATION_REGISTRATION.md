# O5 Migration Registration — CandidateShortlist additive table

**Status: REGISTERED — PostgreSQL variant NOT applied anywhere (deployment
prerequisite). SQLite variant applied only to the isolated QA database of the
M-O5 workspace (2026-11-19, under verified backup `b39d4c72…` with a verified
restore rehearsal). No production database was touched or exists in this
sandbox.**

Additive-only: one new table `CandidateShortlist` + three indexes. No
existing table, column or index is touched. Model parity: **94 models**
identical across both dialects (`scripts/check-schema-parity.ts`).

## 1. Registered migration SQL (canonical artifacts)

| Dialect | Artifact | SHA-256 |
| --- | --- | --- |
| SQLite | `docs/deployment/o5-candidate-shortlist-additive-sqlite.sql` | `99a0132c9e4f34ef62455f50bb8c822d335d14ffea1bf58c17d1630709f4834d` |
| PostgreSQL | `docs/deployment/o5-candidate-shortlist-additive-postgres.sql` | `acf603e7265dc9c22bcc333f31e00d15fb085d9c54e8794680e72bfe3436d18e` |

Both files are exact `prisma migrate diff` output (nothing hand-written),
reviewed statement by statement: only `CREATE TABLE` + `CREATE INDEX` (the
PG variant's `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` statements are the
standard additive foreign-key additions of the new table itself — no existing
object is altered).

Reproducibility (verified byte-for-byte this session):

```bash
git show a4d463bd5c43fa74fbfad4bc6eab51fd6bf6d7d9:prisma/schema.prisma > /tmp/sqlite-old5.prisma
bunx prisma migrate diff --from-schema-datamodel /tmp/sqlite-old5.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
# → byte-identical to docs/deployment/o5-candidate-shortlist-additive-sqlite.sql
```

## 2. Execution order (binding)

1. Approval gate — owner-approved (M-O4/O5 implementation authorization,
   decisions D1–D15 + safeguards A/B/C).
2. Backup first — done this session for the QA database
   (`beanfolio-20261119-115311.db`, sha256 `b39d4c72…`, 93 tables, verified
   restore rehearsal into a throwaway path).
3. SQLite (sandbox/dev/QA): apply the exact registered SQL once; then
   `prisma migrate diff --from-url … --to-schema-datamodel prisma/schema.prisma`
   must report an **empty migration** (verified) and `prisma db push` must
   report "already in sync".
4. PostgreSQL — DEPLOYMENT PREREQUISITE: apply the registered DDL exactly
   once as the LAST step of the registered deployment order
   **O2.1 → O3 → O4 → O5**. Never executed in-sandbox.
5. Verify: `PRAGMA integrity_check` ok, `PRAGMA foreign_key_check` 0 rows,
   table count 94, pre-existing row counts unchanged (users 955→955,
   TalentMatch 2834→2834 — verified this session).

## 3. Rollback

Forward-only schema policy (MIGRATIONS.md §3): rollback = restore from the
verified pre-migration backup, or (data-level, additive-safe) drop the
`CandidateShortlist` table — no existing table is modified by this migration.
