# O6 Migration Registration — OpportunityInvitation + InvitationNegotiation additive tables

**Status: REGISTERED — PostgreSQL variant NOT applied anywhere (deployment
prerequisite). SQLite variant applied only to the isolated QA database of the
M-O6 workspace (2026-11-19, under verified backup `8f63c736…` with a verified
restore rehearsal). No production database exists or was touched in this
sandbox.**

Additive-only: two new tables `OpportunityInvitation` + `InvitationNegotiation`
+ nine indexes (seven non-unique, two unique). No existing table, column or
index is touched. Model parity: **96 models** identical across both dialects
(`scripts/check-schema-parity.ts`).

## 1. Registered migration SQL (canonical artifacts)

| Dialect | Artifact | SHA-256 |
| --- | --- | --- |
| SQLite | `docs/deployment/o6-invitations-additive-sqlite.sql` | `ba139b6465e35ac15705fb3eb662f851620c6f31cb3bf61007d8604015cdb1a4` |
| PostgreSQL | `docs/deployment/o6-invitations-additive-postgres.sql` | `a32a8f6f624cc08d95214534b30347f1b33d1370d3b47c804ceded4dead2ac79` |

Both files are exact `prisma migrate diff` output (nothing hand-written),
reviewed statement by statement: only `CREATE TABLE` + `CREATE INDEX` (the PG
variant's `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` statements are the
standard additive foreign-key additions of the new tables themselves — no
existing object is altered). The destructive screen
(`^DROP|^DELETE|^UPDATE|TRUNCATE|RENAME|ALTER COLUMN|DROP TABLE|DROP COLUMN|DROP INDEX|DROP CONSTRAINT`)
matches ZERO statements in both variants — the `ON DELETE CASCADE/SET NULL`
clauses inside the new tables' own FK definitions are the only "DELETE"
tokens and are part of the additive `CREATE TABLE` / `ADD CONSTRAINT`
statements.

Reproducibility (verified byte-for-byte this session):

```bash
git show cba7b57c4719a381a43916491ce4ae132148901b:prisma/schema.prisma > /tmp/baseline-sqlite.prisma
bunx prisma migrate diff --from-schema-datamodel /tmp/baseline-sqlite.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
# → byte-identical to docs/deployment/o6-invitations-additive-sqlite.sql
```

Concurrency-safety note (owner override A): the unique index
`OpportunityInvitation_organizationId_opportunityId_candidateUserId_activeInvitationToken_key`
implements the one-non-terminal-invitation-per-(org, opportunity, candidate)
invariant for BOTH dialects without partial indexes — `activeInvitationToken`
holds the sentinel `"ACTIVE"` while the row is non-terminal and NULL once
terminal; NULLs are distinct in SQLite and PostgreSQL unique indexes, so any
number of terminal rows coexist while concurrent duplicate sends collide at
the database level.

## 2. Execution order (binding)

1. Approval gate — owner-approved (M-O6 full implementation authorization,
   RD-1…RD-18 + owner overrides A/B).
2. Backup first — done this session for the QA database
   (`/home/z/o6-qa-backups/db-2026-11-19T13-24-59-247Z.sqlite3`, sha256
   `8f63c7360594cc66ce44fb4b12adaa1b8c6970272216c1bea651838ff94fca5f`,
   94 tables, verified restore rehearsal into
   `/home/z/o6-drill/restored.db` — integrity ok, row parity verified).
3. SQLite (sandbox/dev/QA): apply the exact registered SQL once behind the
   fail-closed guard (`scripts/ops/qa-db-env.sh assert`); then
   `prisma migrate diff --from-url … --to-schema-datamodel prisma/schema.prisma`
   must report an **empty migration** (verified) and `prisma db push` must
   report "already in sync" (verified).
4. PostgreSQL — DEPLOYMENT PREREQUISITE: apply the registered DDL exactly
   once as the LAST step of the registered deployment order
   **O2.1 → O3 → O4 → O5 → O6**, each gated by the O2.1-style
   `information_schema` column-type verification before the next step.
   Never executed in-sandbox.
5. Verify: `PRAGMA integrity_check` ok, `PRAGMA foreign_key_check` 0 rows,
   table count 96, pre-existing row counts unchanged (verified this session:
   User 1280, TalentMatch 4052, CandidateShortlist 19 — before and after
   identical).

## 3. Rollback

Forward-only schema policy (MIGRATIONS.md §3): rollback = restore from the
verified pre-migration backup, or (data-level, additive-safe) drop the
`InvitationNegotiation` and `OpportunityInvitation` tables — no existing
table is modified by this migration.
