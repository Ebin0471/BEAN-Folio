# O2.1 Migration Registration — Salary BigInt widening (defect O2-ACC-01)

**Status: REGISTERED — PostgreSQL variant NOT applied anywhere (deployment prerequisite). SQLite variant applied only to the isolated QA database (2026-11-17, isolated-restore-drilled, per the O2.1 remediation report). No production database was touched or exists in this sandbox.**

This registration makes the salary `Int → BigInt` migration reproducible and
discoverable from the repository. The registered SQL files are **exact,
byte-for-byte `prisma migrate diff` output** — nothing was hand-written or
hand-edited. This doc complements `docs/ops/MIGRATIONS.md` (§2/§3/§4 flows)
and `docs/ops/BACKUP_AND_RECOVERY.md` (verified backup/restore tooling); it
does not replace them.

- Defect: O2-ACC-01 — approved salary payloads in `(2,147,483,647, 10,000,000,000]`
  paise exceeded Prisma `Int` columns; under the old schema a failed write left
  the out-of-range value in SQLite and permanently corrupted the profile row
  (`P2023 Inconsistent column data`).
- Fix (O2.1, working tree at baseline `26c18d600670e20ad9ca6fda4c8e4aface2b30aa`):
  `CandidateOpportunityProfile.salaryMinPaise` and `salaryMaxPaise` widened
  `Int? → BigInt?` in **both** Prisma schemas (parity-verified, 90 models
  identical), with checked BigInt↔number conversion at the API boundary.

---

## 1. Registered migration SQL (canonical artifacts)

| Dialect | Artifact (exact generated SQL) | SHA-256 | Bytes |
| --- | --- | --- | --- |
| PostgreSQL | `docs/deployment/o2.1-salary-bigint-postgres-migration.sql` | `dfbc34b3a0c8ff12bbd9f9e748f22b0ca08c831538387691c2d20e9add763ed6` | 161 |
| SQLite | `docs/deployment/o2.1-salary-bigint-sqlite-migration.sql` | `63a52bd45b4b847f98fdf1a9cfe33782aa56f7a19af2ed4b9ffbf3392dfcd153` | 2051 |

The PostgreSQL DDL in full (the file is canonical; shown here for review):

```sql
-- AlterTable
ALTER TABLE "CandidateOpportunityProfile" ALTER COLUMN "salaryMinPaise" SET DATA TYPE BIGINT,
ALTER COLUMN "salaryMaxPaise" SET DATA TYPE BIGINT;
```

Metadata-only widening: no table rewrite, no row data touched, no
DROP/RENAME of any object. The SQLite artifact is Prisma's standard
`RedefineTables` plan (new table with `BIGINT` columns → `INSERT INTO …
SELECT` **every** column of **every** row → drop old → rename → recreate the
`userId` unique index and `visibilityStatus` index → restore the
`ON DELETE CASCADE` FK, wrapped in `PRAGMA defer_foreign_keys`) — all rows
are copied 1:1, no data loss semantics.

**Classification:** a column **type change** is destructive-adjacent under
`MIGRATIONS.md` §2 Step 4 review rule + §4 (even though this widening loses
no data). Production application therefore requires the **§4 approval
checklist** (written justification, restore-verified backup ≤ 24h, two-person
review of the exact SQL, maintenance window with app + queue workers stopped,
named rollback owner) — the plain additive flow of §2 Steps 4–5 does **not**
apply on its own.

### Reproducibility (verified byte-for-byte on 2026-11-17)

From the published baseline schema and the O2.1 proposed schema only —
no database required:

```bash
git show 26c18d600670e20ad9ca6fda4c8e4aface2b30aa:prisma/schema.postgres.prisma > /tmp/pg-old.prisma
bunx prisma migrate diff --from-schema-datamodel /tmp/pg-old.prisma \
  --to-schema-datamodel prisma/schema.postgres.prisma --script
# → byte-identical to docs/deployment/o2.1-salary-bigint-postgres-migration.sql

git show 26c18d600670e20ad9ca6fda4c8e4aface2b30aa:prisma/schema.prisma > /tmp/sqlite-old.prisma
bunx prisma migrate diff --from-schema-datamodel /tmp/sqlite-old.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
# → byte-identical to docs/deployment/o2.1-salary-bigint-sqlite-migration.sql
```

Operator path against a real pre-migration SQLite database (equivalent
output, also verified byte-identical against the QA pre-migration snapshot):

```bash
bunx prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma --script
```

Byte-equality was confirmed against the preserved O2.1 evidence artifacts
(`/home/z/beanfolio-backups/qa-o2.1/pg-migration-plan.sql`,
`sqlite-migration-plan.sql` — same SHA-256 values as the table above).

---

## 2. Execution order (binding)

1. **Approval gate first.** Complete the `MIGRATIONS.md` §4 destructive-adjacent
   checklist. No execution without it.
2. **Backup (non-negotiable, `MIGRATIONS.md` §2 Step 0):**
   - SQLite: `bun scripts/ops/backup-db.ts --out <outside-repo-dir>` (verified
     `VACUUM INTO` snapshot + SHA-256 sidecar).
   - PostgreSQL: `pg_dump --no-owner --no-privileges --format=custom --file="pre-migration-$(date -u +%Y%m%d-%H%M%S).dump" "$DATABASE_URL"`.
   - Restore-verify the backup per `BACKUP_AND_RECOVERY.md` §6 staging drill
     (`restore-from-backup.ts` / `restore-db.ts --target <throwaway-path>`)
     — a backup that has never been restored is not a backup.
3. **SQLite (sandbox/dev/QA):** `prisma db push` refuses any column cast
   without the banned `--accept-data-loss` (MIGRATIONS.md §2 Step 3 stop
   rule), so apply the **exact registered SQLite SQL in a single
   transaction** (e.g. via `bun:sqlite` inside a transaction), then:
   - `bunx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script`
     must report an **empty migration**;
   - `bun run db:push` must report "already in sync";
   - `bunx prisma generate` to refresh the client (`bigint | null` fields).
4. **PostgreSQL — DEPLOYMENT PREREQUISITE (see §4 of this doc):** apply the
   registered DDL exactly once — `psql "$DATABASE_URL" -f docs/deployment/o2.1-salary-bigint-postgres-migration.sql`
   (or the provider SQL editor). If a statement fails, re-run the readiness
   probe and apply only what is still missing; never force re-apply.
5. **Verify (queries in §3 of this doc) — including the mandatory column-type
   gate.** Do not proceed to deploy on a green `/api/ready` alone.
6. **Deploy the new application build.** Schema and app go out in the **same
   maintenance window** (see the N-1 caveat in §5 of this doc).

## 3. Verification queries

Database-type checks (the decisive gate):

```sql
-- PostgreSQL: both rows MUST return data_type/udt_name = bigint / int8
SELECT column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_name = 'CandidateOpportunityProfile'
  AND column_name IN ('salaryMinPaise', 'salaryMaxPaise');

-- SQLite: both rows MUST return type = BIGINT
SELECT name, type FROM pragma_table_info('CandidateOpportunityProfile')
WHERE name IN ('salaryMinPaise', 'salaryMaxPaise');
```

Schema-sync checks:

```bash
bun scripts/check-schema-parity.ts                                   # exit 0
bunx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script   # empty migration
bun scripts/check-postgres-schema-readiness.ts                       # exit 0 AFTER applying (existence-only — see §4)
```

Application-level checks (staging or throwaway account, not production data
mutation): `GET /api/ready` → 200; then `PUT /api/opportunities/me/profile`
with `salaryMinPaise: 2147483648, salaryMaxPaise: 10000000000` (+ currency
`INR`, period `YEAR`) → **201**, and `GET` returns those exact JSON numbers.
This exercises the exact value class that corrupted rows under the old
schema.

## 4. PostgreSQL migration is a DEPLOYMENT PREREQUISITE — and `/api/ready` cannot verify column types

The O2.1 application build **must not serve traffic against an unmigrated
PostgreSQL database**:

- The Prisma client is generated from `prisma/schema.postgres.prisma` (the
  Vercel build does this) and trusts the schema file — it expects `bigint`
  columns regardless of what the live database declares.
- Against an unmigrated database (`integer` salary columns): the app **boots
  fine** and reads/Int32-range writes succeed, but any over-Int32 salary
  write (the exact value class O2.1 exists to support, e.g. 10,000,000,000)
  fails with a raw PostgreSQL out-of-range error surfaced as HTTP 500.
  Degradation, not corruption — PostgreSQL rejects the value instead of
  storing it (unlike SQLite) — but the defect's failure mode is still live.
- `/api/ready` **cannot** catch this: it verifies only the startup-validation
  snapshot and database reachability (`SELECT 1` — see
  `src/app/api/ready/route.ts`). It is fully schema-agnostic; an unmigrated
  database passes it. `scripts/check-postgres-schema-readiness.ts` checks
  object **existence only** (no column types, and its inventory predates the
  O2 tables) — it also cannot catch this.

**Mandatory pre-deploy gate:** run the `information_schema.columns` query in
§3 against the production database and proceed **only** when both salary
columns report `bigint`/`int8`. This step has no automated substitute in the
current tooling.

## 5. Rollback considerations

- **Schema rollbacks are forward-only** (`MIGRATIONS.md` §3): no down-DDL is
  written or registered. Data-level rollback means restore.
- **Restore is the rollback:** SQLite
  `bun scripts/restore-db.ts <backup> --force` (or the coordinated
  `restore-from-backup.ts` staging-drill → live-restore flow with
  `--confirm-live --yes`); PostgreSQL `pg_restore --clean --if-exists` —
  the command is PRINTED for human review, never automated
  (`BACKUP_AND_RECOVERY.md` §6). Rows written between backup and incident
  are lost and must be documented (MIGRATIONS.md §3).
- **This is NOT an additive change — the N-1 compatibility rule does not
  apply.** `MIGRATIONS.md` §3's "roll the app back, additive schema is
  harmless to N-1" assumes additive columns/tables. A type widening is
  different: the OLD application build (Int-typed Prisma client) against the
  migrated schema (a) reads/writes fine only while every stored salary value
  ≤ 2,147,483,647 — any row above Int32 max is unreadable by the old client
  (`P2023`); and (b) the old build's validation still accepts up to
  ₹10 crore, so against a migrated PG schema it can **create** over-Int32
  rows it then cannot read back. **Do not roll the application back after
  migrating without also restoring pre-migration data; treat schema + app as
  one atomic release in the maintenance window.**
- The rollback owner is named in the §4 approval checklist before execution.

---

## 6. Provenance

- Generated by Prisma 6.19.2 (`prisma migrate diff`), reviewed statement by
  statement during O2.1 (remediation report §4.3–§4.4), re-verified
  byte-for-byte during this registration.
- Baseline: `26c18d600670e20ad9ca6fda4c8e4aface2b30aa` (published O2).
- Applied: SQLite variant → isolated QA database only, under verified
  backups (`55cb9f0a…` pre-migration artifact) with an isolated restore
  drill; PostgreSQL variant → **never executed** (no PG instance exists in
  this sandbox).
- Evidence: `/home/z/beanfolio-backups/qa-o2.1/` (backups, restore drill,
  before/after data-preservation snapshots, defect reproduction, test/build
  logs) and the O2.1 remediation + publication-preflight reports.
