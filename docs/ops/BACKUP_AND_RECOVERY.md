# BEAN FOLIO — Backup & Disaster Recovery (M21)

Operational reference for data protection: what is backed up, how every
artifact is verified, how retention works, and how recovery is performed
safely. Introduced by M21; complements `docs/ops/RUNBOOK.md` §6 (cadence)
and `DEVELOPMENT_SAFETY.md` §3/§7 (policy + recovery-source inventory).

Prime directive (from `DEVELOPMENT_SAFETY.md`): **a backup that has never
been restored is not a backup** — and a backup tool that can report success
without verifiable evidence is worse than no tool. Every claim below is
backed by an automated test (`tests/backup-*.test.ts`).

---

## 1. What is protected

| Data class | Location | Backup vehicle |
| --- | --- | --- |
| SQLite database | `DATABASE_URL` (`file:…`, default `db/custom.db`) | `scripts/ops/backup-db.ts` / orchestrator — `VACUUM INTO` snapshot |
| PostgreSQL database | `postgres://` `DATABASE_URL` | `pg_dump --format=custom` (client tooling required; verified via `pg_restore --list`) |
| Uploaded media (local driver) | `<MEDIA_LOCAL_ROOT or cwd>/uploads/` | `scripts/ops/backup-media.ts` — tar.gz with per-file checksums |
| Uploaded media (S3 driver) | `S3_BUCKET` under `uploads/` | `scripts/ops/backup-media.ts` — downloads every object, archives + verifies |
| Code GIFTZ workspaces | `data/giftz-workspaces/` | deliberately NOT backed up — disposable, reproducible from git baselines + task records |

Never backed up / never published: `.env*`, vaults (`.git/bean-auth/`,
`.github-auth/`), tool artifacts, backups themselves.

## 2. Architecture

Shared core: `scripts/ops/lib/backup-core.ts` — manifest schemas,
checksums, verification primitives, retention. One implementation, so the
backup, orchestrator and restore paths cannot drift apart.

```
scripts/ops/backup-db.ts            verified DB backup (CLI)
scripts/ops/backup-media.ts         verified media backup (CLI, local + S3)
scripts/ops/backup-all.ts           coordinated orchestrator (CLI)
scripts/ops/restore-from-backup.ts  safe recovery (CLI)
scripts/ops/lib/backup-core.ts      shared core (schemas, checksums, retention)
scripts/ops/lib/media-mode.ts       driver resolution (local/s3, fail-closed)
tests/helpers/s3-compat-server.ts   S3-compatible API server fixture (tests only)
```

### Manifest sidecar (`<artifact>.json`, schema `beanfolio-backup-manifest/v1`)

Every artifact gets a sidecar written atomically (tmp + rename) next to it:

```json
{
  "schema": "beanfolio-backup-manifest/v1",
  "kind": "database | media",
  "engine": "sqlite | postgresql",
  "driver": "local | s3",
  "file": "db-2026-11-14T05-00-00-000Z.sqlite3",
  "bytes": 61440,
  "sha256": "…",
  "generatedAt": "2026-11-14T05:00:00.000Z",
  "integrity": "ok",
  "tables": 42,
  "method": "vacuum-into",
  "rowParity": { "User": 20, "Project": 14, "MediaAsset": 38, … },
  "source": "<mediaRoot> | { endpoint, bucket, prefix }",
  "fileCount": 1379,
  "totalBytes": 345000000,
  "entries": [ { "path": "uploads/…", "bytes": 123, "sha256": "…" } ]
}
```

`entries` is the per-file checksum ledger — the restore path re-verifies
every extracted file against it. This is what makes "checksum mismatch
detected" a tested property, not an aspiration.

### Coordinated manifest (`backup-manifest-<ts>.json`, schema `beanfolio-backup-orchestrator/v1`)

Written by `backup-all.ts` — connects BOTH artifacts of one run plus every
verification result:

```json
{
  "schema": "beanfolio-backup-orchestrator/v1",
  "status": "complete | failed",
  "generatedAt": "…",
  "outDir": "…",
  "database": { "artifact": "db/db-….sqlite3", "manifest": "db/db-….json", "sha256": "…", "checks": [ … ] },
  "media":    { "artifact": "media/media-….tar.gz", "manifest": "media/media-….json", "sha256": "…", "driver": "local | s3", "checks": [ … ] },
  "verification": { "allPassed": true, "checks": [ … ] },
  "errors": []
}
```

`status: "complete"` is only written when BOTH components succeeded AND
every verification check passed. Any failure → `status: "failed"` with the
errors recorded, exit non-zero. **The restore path refuses anything that is
not `status: "complete"`.**

## 3. What "verified" means (per artifact)

Database (SQLite):
1. `VACUUM INTO` snapshot through SQLite's own machinery (safe against a
   live WAL database; read-only on the source),
2. `PRAGMA integrity_check` on the SNAPSHOT must be `ok`,
3. row counts of key tables (`User`, `Project`, `MediaAsset`, `AgentTask`,
   `AgentArtifact`, `Session`) compared source vs snapshot,
4. sha256 recorded in the sidecar and RE-COMPUTED by the orchestrator.

Database (PostgreSQL): `pg_dump --format=custom` + `pg_restore --list`
header parse = readable archive + sha256. Missing client tooling fails
with the exact fix (install postgresql-client / run from an ops box /
rely on verified provider PITR) — never a fake success.

Media (local driver):
1. file ledger (path, bytes, sha256) built from the live tree,
2. tar.gz created relative to the media root so extraction lands in
   `uploads/…`,
3. **full round-trip proof**: the archive is extracted in a temp dir and
   every file is checksum-compared against the ledger BEFORE success is
   reported,
4. sidecar written.

Media (S3 driver):
1. paginated `ListObjectsV2` under `uploads/` (real AWS SDK client),
2. EVERY object downloaded, byte size verified against the listing,
3. staged into the exact local layout, tarred,
4. full round-trip proof as above,
5. sidecar written with per-object checksums + endpoint/bucket/prefix
   (never credentials).

An empty source (no files / 0 objects) is an explicit FAILURE, never an
empty success.

## 4. Usage

```bash
# Database only
bun scripts/ops/backup-db.ts --out /home/z/beanfolio-backups/db

# Media only (driver auto-detected; MEDIA_STORAGE_DRIVER=local forces local)
bun scripts/ops/backup-media.ts --out /home/z/beanfolio-backups/media

# Coordinated run (recommended — one manifest connects both artifacts)
bun scripts/ops/backup-all.ts --out /home/z/beanfolio-backups
```

Every CLI prints a machine-readable JSON result line
(`{"event":"backup.ok", …}` / `{"event":"backup.all.ok", …}`) for cron
capture, plus the manifest path.

Layout convention (matches `DEVELOPMENT_SAFETY.md` §1.7 and the existing
`/home/z/beanfolio-backups/` directory): `<out>/db/`, `<out>/media/`,
`<out>/backup-manifest-<ts>.json`.

Defaults when `--out` is omitted: `backups/db`, `backups/media`, `backups/`
(in-repo, gitignored). For durability prefer a path OUTSIDE the workspace
(sandbox recycles drop untracked files inside the project tree).

## 5. Retention (safe, configurable, opt-in)

Rules enforced by `planRetention`/`applyRetention` in the shared core:

1. **Deletion is always opt-in.** `--keep <N>` alone prints a dry-run plan.
   `--keep <N> --prune` actually deletes. Without `--keep`, nothing is ever
   pruned. `--prune` without `--keep` is refused (exit 2).
2. **The newest verified-good artifact is ALWAYS kept** — even when `--keep`
   would otherwise exclude it (last-known-good guard).
3. **Artifacts without a valid checksum sidecar are never touched** (unknown
   provenance — a human decides). Artifacts whose sidecar checksum no longer
   matches are reported as suspicious, never auto-deleted.
4. **Never overwrite.** Artifacts and manifests are written to fresh
   millisecond-timestamped names; an existing file aborts the operation
   (`assertFreshTarget`).
5. **Refusal when nothing is provably good**: a directory with zero
   verified-good backups is never pruned (touching it could destroy the
   last usable backup).
6. Foreign files (non-backup names, human notes) are never considered.

```bash
bun scripts/ops/backup-all.ts --out /home/z/beanfolio-backups --keep 14          # dry-run plan
bun scripts/ops/backup-all.ts --out /home/z/beanfolio-backups --keep 14 --prune  # apply
```

## 6. Recovery

### Staging drill (default — isolated, zero risk)

```bash
bun scripts/ops/restore-from-backup.ts --manifest /home/z/beanfolio-backups/backup-manifest-<ts>.json \
    --staging /tmp/restore-drill
```

The script, in order:
1. validates the coordinated manifest (schema, `status:"complete"`),
2. re-verifies BOTH artifacts (recomputed sha256 + bytes + sidecar ledgers;
   media additionally round-trip extracted and per-file compared) — any
   mismatch aborts as `INVALID BACKUP REJECTED` before anything happens,
3. creates a fresh PRE-RESTORE backup of the current database (and current
   media) into `<staging>/pre-restore/`,
4. restores into `<staging>/restored/`: database copy integrity-checked,
   media extracted and per-file verified,
5. prints a JSON result line. **The live system is untouched.**

### Live restore (explicit human action — two flags required)

```bash
bun scripts/ops/restore-from-backup.ts --manifest <manifest.json> \
    --confirm-live --yes
```

* `--confirm-live --yes` together are the explicit human confirmation (the
  sandbox has no interactive TTY; there is no prompt to answer blindly).
  `--confirm-live` without `--yes` is refused.
* A live restore REFUSES to run unless the pre-restore backups succeeded.
  (Exception, deliberately loud: the current medium is already EMPTY —
  that is the disaster itself; there is nothing to preserve.)
* Live database (SQLite): previous file preserved as `<live>.bak-<ts>` →
  copy to temp → integrity check → stray `-wal`/`-shm` removed → atomic
  rename. A failed swap rolls back with the live file untouched.
* Live media (local): file-by-file copy from the verified staging tree into
  `<MEDIA_LOCAL_ROOT or cwd>/uploads/` (merge semantics; the backup is the
  source of truth for the files it contains).
* Live media (S3): every object re-uploaded via `PutObjectCommand` only
  after its staged checksum matched the manifest ledger.
* Cross-driver restores are refused (a backup from S3 cannot silently land
  on local disk, and vice versa).
* PostgreSQL: the destructive `pg_restore --clean --if-exists` command is
  PRINTED for a human to review and run — never automated.

Human checklist before `--confirm-live`:
1. App stopped (dev server, standalone server, queue workers).
2. The manifest's `generatedAt` is the point-in-time you intend to restore.
3. Staging drill completed cleanly for this manifest.
4. Disk space for `<live>.bak-<ts>` + the restored data.
5. After the swap: `GET /api/ready` + a DB-backed route verified.

## 7. Publishing policy (bean-sync integration)

GitHub receives **source only** — databases, media, backups, coordinated
manifests, env files and vaults are never published:

* `scripts/ops/bean-sync.sh` now audits the STAGED PATHS for runtime data
  (`scan_runtime_data`) in addition to the existing credential-pattern scan.
  Any match aborts the publish before the commit is created. The guard was
  verified against the full M21 path set (13 legitimate paths pass, 8
  runtime-data paths are caught).
* The `main` lineage itself is verified source-only (`git log main -- '*.db'
  '*.sqlite3' '*.dump'` is empty; the remote tree carries no runtime files),
  and the in-repo default output `backups/` is gitignored.
* Publishing runs through the established workflow: descriptive commit on
  `main` → `bean-sync.sh` (remote-state gate → explicit-path staging →
  secret scan → runtime-data scan → commit → plain push → `git ls-remote`
  SHA verification). The stale `github-clean:main` push path would be a
  non-fast-forward rewind today (the `github-clean` branch predates M18) and
  is NOT used by the working policy; reconciliation is documented here
  rather than silently papered over.

## 8. Test coverage map

| Test file | Proves |
| --- | --- |
| `tests/backup-db-ops.test.ts` | SQLite backup artifact + sidecar (sha256/integrity/row parity), immutability, honest failures (missing source, empty `DATABASE_URL`, PG without tooling), retention dry-run/apply, last-known-good guard, tampered-artifact skip |
| `tests/backup-media.test.ts` | `MEDIA_LOCAL_ROOT` respected (the fileCount=2 proof), actionable missing-root failure, empty-tree refusal, incomplete-S3 refusal (no silent fallback), two tamper vectors detected |
| `tests/backup-media-s3.test.ts` | Real S3-compatible API backup: forced pagination, per-object download + size checks, sidecar ledger, foreign-prefix exclusion, incomplete-config / empty-bucket / truncated-object honest failures, `MEDIA_STORAGE_DRIVER=local` override |
| `tests/backup-orchestrator.test.ts` | Coordinated manifest connects + checksums match recomputation, immutability, fail-closed on media failure, fail-closed on missing `DATABASE_URL`, retention hooks, foreign files untouched |
| `tests/backup-restore.test.ts` | Staging drill (live untouched), tampered DB artifact rejected, tampered media rejected, failed-manifest refused, flag-refusal matrix, live local drill with `.bak` preservation, live S3 drill (bucket re-populated, checksums verified) |

## 9. Known limitations (honest)

* **PostgreSQL drill: NEEDS ATTENTION.** No PostgreSQL instance or
  `pg_dump`/`pg_restore` client exists in this sandbox, so the PG code path
  is covered by (a) preserved original verification logic, (b) the honest
  actionable-failure test, and (c) the printed-command boundary. A real
  PG backup/restore drill must be run on an environment with the client
  tooling before relying on it.
* **S3 verification uses an in-process S3-compatible API server** (real
  HTTP, real SigV4-signed AWS SDK client, path-style) — not a cloud bucket.
  This exercises the entire backup/restore code path end-to-end; a drill
  against a production bucket (MinIO/R2/S3) with real credentials is the
  final step for that acceptance criterion and requires credentials this
  sandbox does not hold.
* Backups are local-file based; shipping them off-host (object storage with
  encryption + retention) remains a RUNBOOK §6 operational responsibility.
