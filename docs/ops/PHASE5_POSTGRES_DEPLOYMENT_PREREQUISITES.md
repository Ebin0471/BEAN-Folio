# BEAN Folio — Phase 5 PostgreSQL & Deployment Prerequisites (PREPARE ONLY)

**Status:** PREPARED (2026-11-21), **BLOCKED by design** — nothing in this document has
been executed against any production system and nothing may be executed without a
separate, explicit owner authorization per gate. This document exists so that, when the
owner opens a gate, the exact steps are already written, reviewed and reproducible —
not improvised under pressure.

**Current production-DB state (verified facts, not assumptions):**
- No PostgreSQL connection has ever been made by this program; no DDL has been applied
  to any production PostgreSQL; no deployment has been performed.
- The full O2.1 → O3 → O4 → O5 → O6 → O7 chain is **registered**: all 12 SQL artifacts
  committed at `docs/deployment/*.sql`, all 12 SHA-256 values recorded in
  `docs/ops/O*_MIGRATION_REGISTRATION.md`, all 12 verified byte-for-byte and re-derived
  from the published lineage schemas during Phase 3 (empty intermediate `migrate diff`,
  integrity ok, FK 0 at every stage, tables 90 → 100, fixtures preserved 1:1).
- SQLite QA/dev databases are at parity 100 (`SCHEMA PARITY OK — 100 models` re-run
  this phase).

---

## Gate A — PostgreSQL migration execution (owner approval required)

### A.0 Preconditions (all mandatory, verified at gate-opening time)

1. A managed PostgreSQL instance exists AND `DATABASE_URL` (postgres, `sslmode=require`)
   is provided by the owner in the target environment. **Never hand-typed** (P1000
   incident note in `docs/deployment.md` §0.4) — copy from the provider dashboard.
2. `NEXT_PUBLIC_APP_URL` production origin decided (build-time inlined — set BEFORE
   build).
3. Operator machine has `postgresql-client` installed (`pg_dump`/`pg_restore` available
   — the backup tooling refuses to fake success without it).
4. Maintenance window scheduled with the owner; rollback owner named.

### A.1 Order of execution (exact, one statement-block at a time)

| Step | Artifact (PostgreSQL) | Registered SHA-256 (verify before apply) | Nature |
|---|---|---|---|
| 1 | `docs/deployment/o2.1-salary-bigint-postgres-migration.sql` | `dfbc34b3a0c8ff12bbd9f9e748f22b0ca08c831538387691c2d20e9add763ed6` | **DESTRUCTIVE-ADJACENT** (widening `ALTER COLUMN`) — Gate A.2 extra requirements apply |
| 2 | `docs/deployment/o3-opportunity-models-additive-postgres.sql` | `ec20abf027d58d5be3889ce7f3c4ff32893c754a3287a54b771b24836c988671` | additive |
| 3 | `docs/deployment/o4-talent-match-additive-postgres.sql` | `4ead00966d4ff501ef1a2596343992cb1b9c6a90767f4f65ffbc5b5d0fb11d85` | additive |
| 4 | `docs/deployment/o5-candidate-shortlist-additive-postgres.sql` | `acf603e7265dc9c22bcc333f31e00d15fb085d9c54e8794680e72bfe3436d18e` | additive |
| 5 | `docs/deployment/o6-invitations-additive-postgres.sql` | `a32a8f6f624cc08d95214534b30347f1b33d1370d3b47c804ceded4dead2ac79` | additive |
| 6 | `docs/deployment/o7-hiring-rooms-additive-postgres.sql` | `696174baa5ef328b1d792a42be7092a7dbdc73a4f54b4efda8e108c0bd184ed0` | additive (4 CREATE TABLE + 2 CREATE UNIQUE INDEX + 9 CREATE INDEX + 14 ADD CONSTRAINT FK; human FKs SET NULL, owning aggregates CASCADE) |

Between every step: `PRAGMA`-equivalent verification = row-count parity snapshot of the
preservation fixtures (Step-0 backup manifest vs live), `pg_restore --list` readability
of the newest backup, and application smoke (`GET /api/ready` = `database: reachable`).

### A.2 O2.1 additional (destructive-adjacent) approval requirements

Per `docs/ops/MIGRATIONS.md` §4 and `docs/ops/O2_1_MIGRATION_REGISTRATION.md` §3/§4 —
ALL of the following, on top of Gate A.0, before step 1 may run:

1. Written justification recorded (why salary BigInt widening is necessary; what the
   residual risk is — the defect it fixes: approved salary payloads in
   `(2,147,483,647, 10,000,000,000]` exceeding int4).
2. Backup taken **and restore-verified** (A.3) within the last 24 h.
3. Two-person review of the exact 161-byte SQL statement (owner + operator; "no
   trust-the-generator" for destructive-adjacent statements).
4. App stopped, queue workers stopped (`QUEUE_ENABLED=false` or SIGTERM the drain
   workers) for the duration of the window.
5. Post-change verification plan (A.4) prepared in advance and a named rollback owner.
6. Explicit note in the execution record: the O2.1 SQLite sibling was proven
   replayable-by-construction in Phase 3, but the PostgreSQL statement is NOT assumed
   replayable — double application is refused and must never be attempted.

### A.3 Backup and restore evidence requirements (before step 1, and before deploy)

- `pg_dump --no-owner --no-privileges --format=custom --file="pre-migration-$(date -u
  +%Y%m%d-%H%M%S).dump" "$DATABASE_URL"` → record bytes + sha256.
- Restore evidence: `pg_restore --list <dump>` parses cleanly (readable archive) AND a
  drill restore into a scratch database succeeds (createdb scratch → pg_restore →
  table-count + key-row-count parity vs the dump's TOC) — the same standard the SQLite
  tooling enforces mechanically.
- SQLite side (if any legacy SQLite deployment exists in the beta path):
  `bun scripts/backup-db.ts` (VACUUM INTO + integrity + row parity + sha256 manifest)
  and a `restore-db.ts` drill to a disposable target.

### A.4 Production verification commands (post-migration, per step and final)

```bash
# 1. Artifact integrity re-verified at the moment of execution (example, step 6):
sha256sum docs/deployment/o7-hiring-rooms-additive-postgres.sql
#   must equal 696174baa5ef328b1d792a42be7092a7dbdc73a4f54b4efda8e108c0bd184ed0

# 2. Schema readiness after the full chain:
bun scripts/check-postgres-schema-readiness.ts     # expects 100 models present
bun scripts/check-schema-parity.ts                  # SCHEMA PARITY OK — 100 models

# 3. Migration end-to-end verification (read-only):
bun scripts/verify-postgres-migration.ts

# 4. Application-level readiness:
curl -s https://<production-origin>/api/ready       # startup ok, database reachable
curl -s https://<production-origin>/api/health      # queue counters present

# 5. Structural spot-checks inside psql:
#   \dt  → HiringRoom, HiringRoomMember, Interview, HiringStageEvent present
#   \d "HiringRoom"  → invitationId UNIQUE, stage/event FKs CASCADE, member user FK SET NULL
```

### A.5 What must NEVER happen

- No `prisma migrate dev/deploy` against production (the repo policy is explicit
  `migrate diff` → review → apply-once-by-hand; `MIGRATIONS.md` §2).
- No application of any artifact whose sha256 does not match the registration table.
- No "undo" of an additive migration by dropping (rollback = restore from the Step-0
  backup only).
- No destructive statement beyond the single registered O2.1 widening.

## Gate B — Deployment (owner approval required, separate from Gate A)

### B.1 Pre-deployment checks (from `docs/ops/GO_LIVE_CHECKLIST.md` §1–§3)

1. Clean-checkout build: `prisma generate --schema prisma/schema.postgres.prisma &&
   next build` with `bunx tsc --noEmit` clean (last verified: exit 0, 0 errors,
   2026-11-21).
2. Lint 0 errors (13 known warnings baseline), full suite green against staging.
3. Environment variables per GO_LIVE §2 (DATABASE_URL, NEXT_PUBLIC_APP_URL required;
   RATE_LIMIT_BACKEND/CACHE_BACKEND=postgres when >1 instance; feature flags empty =
   honestly disabled).
4. `serverExternalPackages: ["pdf-parse"]` verified in `next.config.ts`; resume parse
   smoke in the deployed preview.
5. Security headers present in a deployed response (X-Content-Type-Options,
   Referrer-Policy, Permissions-Policy, COOP; HSTS in production); CSP remains a
   documented deferral (M-1) — its absence is a recorded, accepted risk, not a blocker
   unless the owner re-prioritizes.

### B.2 Deployment procedure (Tier A reference: `docs/ops/DEPLOYMENT_TIERS.md`)

1. Build the immutable artifact from the verified `main` SHA (never from a dirty tree).
2. Start the standalone server (`NODE_ENV=production bun .next/standalone/server.js`)
   behind TLS (provider-managed or Caddy; `Caddyfile.production` is the committed
   reference config).
3. Worker topology decision recorded: single-instance in-process (`QUEUE_ENABLED=true`)
   or web+worker split (`QUEUE_ENABLED=false` + `bun scripts/queue-drain.ts`).
4. `GET /api/ready` until `startup ok`; then GO_LIVE §5 smoke tests in order (register
   throwaway → recovery key → onboarding; logout/login; project+upload+publish;
   LAXII V1 generation; resume export; rate-limit 429 sanity; private-window public
   profile).

### B.3 Rollback procedure

- App: redeploy the previous immutable artifact (keep the previous build; additive
  schema means the previous build runs against the newer schema).
- DB: restore from the pre-deployment verified dump only (A.3 evidence); record the
  exact restore command and target in the incident doc BEFORE deploying.
- Degradation levers: `CACHE_BACKEND`/`RATE_LIMIT_BACKEND` → memory;
  `QUEUE_ENABLED=false`; stuck queue jobs self-recover on next boot via heartbeat.

### B.4 Post-deployment checks

- GO_LIVE §5 smoke list green; `/api/health` counters returning to baseline ≤60 s
  after load; `api.error` structured lines present in logs with requestId and NO stack
  traces in production; external uptime poll active (G-1 operator action).
- Publication record: deployment SHA, artifact checksums, backup manifest ids, smoke
  results — appended to the central release checklist progress log.

## Gate C — Public launch (owner approval; out of scope for beta preparation)

Pre-conditions accumulate from the RC checklist (`PHASE5_RELEASE_CANDIDATE_CHECKLIST.md`
§go/no-go): beta exit criteria met, cohort expansions stable, owner go decision. This
document does not define the launch runbook yet; it only pins the gates that must have
been passed first (A → B → C, strictly in order, each with its own explicit approval).

---

## Boundary statement (binding)

Nothing in this document authorizes execution. The signing record for each gate is a
separate owner instruction referencing the gate id (A/B/C) and the target environment.
Until then: **no PostgreSQL connection, no DDL, no production data modification, no
deployment, no DNS change** — from any agent or session, in any phase.
