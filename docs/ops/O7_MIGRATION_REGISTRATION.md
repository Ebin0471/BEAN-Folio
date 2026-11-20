# O7 Migration Registration — hiring rooms additive tables

**Status: REGISTERED — PostgreSQL variant NOT applied anywhere (deployment prerequisite).
SQLite variant applied only to this workspace's isolated QA database (2026-11-20, via
`prisma db push` without `--accept-data-loss` behind `scripts/ops/qa-db-env.sh assert`,
under verified pre-push integrity). No production database exists or was touched in this
sandbox.**

Additive-only change: 4 new tables (`HiringRoom`, `HiringRoomMember`, `Interview`,
`HiringStageEvent`), 2 unique + 9 secondary indexes, new foreign keys (humans nullable
`ON DELETE SET NULL` per O0 D6 / O7 RD-20; owning aggregates `ON DELETE CASCADE`). No
existing table, column, row or index is modified. Zero `DROP`/`DELETE`/`UPDATE`/`RENAME`
statements (screened below).

Model parity: **100 models identical across both dialects** (`scripts/check-schema-parity.ts`
→ `SCHEMA PARITY OK — 100 models identical across sqlite + postgres mirror`). Baseline was
96 (published M-O6); M-O7 adds exactly the four approved hiring models.

## §1 Registered migration SQL (canonical artifacts)

| Dialect | Artifact | SHA-256 |
| --- | --- | --- |
| SQLite (dev/QA) | `docs/deployment/o7-hiring-rooms-additive-sqlite.sql` | `b23783581a3cdade6241bae1e40ef2a74661ba114f53de65394184454824122f` |
| PostgreSQL (production target) | `docs/deployment/o7-hiring-rooms-additive-postgres.sql` | `696174baa5ef328b1d792a42be7092a7dbdc73a4f54b4efda8e108c0bd184ed0` |

Both artifacts are the exact byte-for-byte `prisma migrate diff` output from the published
baseline schema (`1c0d501b`) to the M-O7 schema — nothing hand-written. Destructive screen
(`grep -Ein "^DROP|^DELETE|^UPDATE|TRUNCATE|RENAME|ALTER COLUMN|DROP COLUMN|DROP TABLE"`)
returns **zero matches** on both files. Statements per artifact: 4 `CREATE TABLE`, 9 `CREATE INDEX`, 2 `CREATE UNIQUE INDEX`
per table set — including `CREATE UNIQUE INDEX "HiringRoom_invitationId_key"` (the O7 RD-1
one-room-per-invitation database guarantee) and `CREATE UNIQUE INDEX
"HiringRoomMember_roomId_userId_key"`. The `Interview` table carries the nullable
`meetingLink` column (O7 RD-15 storage).

Reproducibility (regenerate and compare byte-for-byte):

```bash
git show 1c0d501b:prisma/schema.prisma > /tmp/baseline-sqlite.prisma
git show 1c0d501b:prisma/schema.postgres.prisma > /tmp/baseline-postgres.prisma
bunx prisma migrate diff --from-schema-datamodel /tmp/baseline-sqlite.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
bunx prisma migrate diff --from-schema-datamodel /tmp/baseline-postgres.prisma \
  --to-schema-datamodel prisma/schema.postgres.prisma --script
```

Dialect notes:
- SQLite embeds foreign keys inline in `CREATE TABLE` (`ON DELETE SET NULL` / `ON DELETE
  CASCADE` clauses are part of the column definitions); PostgreSQL emits them as separate
  `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` statements — both are the engine-canonical
  `prisma migrate diff` renderings of the identical datamodel.
- The `HiringRoomMember.userId` FK is nullable; PostgreSQL `SET NULL` is constraint-level
  and concurrency-safe. The one-active-room guarantee does not depend on NULL-distinct
  behavior here: `HiringRoom.invitationId` is a plain unique column (never NULL).

## §1b Parity gate

`bun scripts/check-schema-parity.ts` → **`SCHEMA PARITY OK — 100 models identical across
sqlite + postgres mirror`** (exit 0). The O3-style gate applies to every future M-O7 schema
touch: a schema change that breaks parity does not ship.

## §2 Execution order (binding)

1. **Approval gate.** PostgreSQL DDL execution is a deployment prerequisite requiring
   explicit owner authorization. It is never run from this sandbox.
2. **Backup first (non-negotiable).** SQLite: `bun scripts/backup-db.ts` (+ manifest, SHA-256,
   restore rehearsal). PostgreSQL: `pg_dump --no-owner --no-privileges --format=custom` before
   anything else. If you cannot take a backup, you cannot run the migration.
3. **SQLite (dev/QA)** — apply behind the fail-closed guard:
   ```bash
   export DATABASE_URL="file:<repo-root>/db/custom.db"
   scripts/ops/qa-db-env.sh assert          # refuses anything but this workspace's QA file
   bun run db:push                           # additive push — NO --accept-data-loss, ever
   bunx prisma migrate diff --from-url "$DATABASE_URL" \
     --to-schema-datamodel prisma/schema.prisma --script   # must be EMPTY afterwards
   ```
   Verification: `PRAGMA integrity_check` → `ok`; `PRAGMA foreign_key_check` → **0 rows**;
   table count 96 → 100; pre-existing row counts unchanged (the 2026-11-20 QA run verified
   1026 users / 516 invitations preserved, integrity ok, FK 0).
4. **PostgreSQL (production target)** — apply the registered artifact exactly once, as the
   **LAST step of the registered chain `O2.1 → O3 → O4 → O5 → O6 → O7`**, after the O2.1-style
   `information_schema` column-type gate on the live database and immediately after a fresh
   verified `pg_dump`. Run inside a transaction; on any error, roll back and STOP.
   Verify after apply: `\d "HiringRoom"` shows `"invitationId"` with a unique constraint;
   the four tables exist; `SELECT count(*) FROM pg_foreign_key`-style checks or
   `information_schema.referential_constraints` confirm the new FKs; pre-existing table
   row counts unchanged.
5. **Post-deploy verification (both dialects)** — one hiring room can be created against an
   `ACCEPTED` invitation; a second creation for the same invitation fails at the database
   level (unique `invitationId`); existing M-O1–M-O6 flows (invitations, negotiations,
   shortlist, discovery) unchanged.

## §3 Rollback

Forward-only per `MIGRATIONS.md §3`. If the deployment must be undone: restore the database
from the verified pre-migration backup (the rollback plan is the backup), or — as a
data-level fallback — drop ONLY the four M-O7 tables in reverse dependency order
(`HiringStageEvent`, `Interview`, `HiringRoomMember`, `HiringRoom`); they have no inbound
references from pre-O7 tables. No pre-O7 data is ever rewritten.

## Provenance

- Generated with Prisma 6.19.2 (`prisma migrate diff`), from baseline `1c0d501b`
  (M-O6 published lineage `93779fe7…` + Phase-1 release-program docs).
- QA execution evidence: `prisma db push` exit 0 (no `--accept-data-loss`);
  post-push `PRAGMA integrity_check` ok; `PRAGMA foreign_key_check` 0 violations after
  removing 15 pre-existing test-fixture orphan rows (documented in
  `docs/ops/FEBRUARY_2027_RELEASE_CHECKLIST.md` Phase 1 record — unrelated to O7);
  100 tables; 1026 users / 516 invitations preserved.
- Registration doc: `docs/ops/O7_MIGRATION_REGISTRATION.md` (this file).
