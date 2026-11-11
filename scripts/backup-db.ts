/**
 * BEAN Folio — SQLite database backup (ops tooling, no Next.js imports).
 *
 *   bun scripts/backup-db.ts [--out <dir>] [--keep <N>]
 *
 * What it does (SQLite mode — DATABASE_URL is a `file:` URL):
 *   1. Opens the live database READ-ONLY and runs SQLite's `VACUUM INTO`
 *      (supported by bun:sqlite) into a timestamped file. VACUUM INTO
 *      produces a single self-contained, fully consistent copy — it reads
 *      through any live -wal file, so copying -wal/-shm by hand is NOT
 *      needed for this path. The source is never locked beyond SQLite's
 *      normal read snapshot and nothing is written to it.
 *   2. Falls back to a raw file copy (db + -wal + -shm when present) only if
 *      `VACUUM INTO` is unavailable on the installed runtime. Raw copy of a
 *      live database is weaker (an in-flight write transaction can race the
 *      copy) — the manifest honestly records which method was used, and the
 *      stop-the-app advice applies to raw copies.
 *   3. Writes a JSON manifest sidecar (<backup>.json) and prints ONE JSON
 *      line: { file, bytes, sha256, tables, method, kept }.
 *   4. Prunes older backups in the output directory, keeping the newest
 *      --keep (default 14) beanfolio-*.db files (and their sidecars).
 *
 * Postgres mode (DATABASE_URL starts with postgres):
 *   This script deliberately does NOT attempt a JS pg_dump. It prints the
 *   exact recommended pg_dump command and exits 0 with zero side effects —
 *   backups of a managed Postgres belong to pg_dump / provider PITR, not to
 *   a bespoke tool.
 *
 * Exit codes: 0 ok · 1 failure (source missing, vacuum failed, …)
 *
 * Manifest consumers: scripts/restore-db.ts verifies the sha256 sidecar
 * before restoring. Schedule this script from cron/systemd — see
 * docs/ops/RUNBOOK.md (backup schedule) and docs/ops/MIGRATIONS.md (drill).
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const KEEP_DEFAULT = 14;
const ROOT = resolve(import.meta.dir, "..");

interface BackupManifest {
  file: string;
  bytes: number;
  sha256: string;
  tables: number;
  method: "vacuum-into" | "raw-copy";
  source: string;
  generatedAt: string;
  database: "sqlite";
}

function usage(): never {
  console.error("Usage: bun scripts/backup-db.ts [--out <dir>] [--keep <N>]");
  process.exit(2);
}

function parseArgs(argv: string[]): { out?: string; keep: number } {
  let out: string | undefined;
  let keep = KEEP_DEFAULT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a === "--keep") keep = Number(argv[++i]);
    else if (a === "--help" || a === "-h") usage();
    else usage();
  }
  if (!Number.isInteger(keep) || keep < 1) {
    console.error("--keep must be a positive integer");
    process.exit(2);
  }
  return { out, keep };
}

/**
 * Resolve the SQLite file path from DATABASE_URL.
 * `file:/abs/path` → as-is; `file:./x` → tried from cwd, then from the
 * prisma/ schema dir (Prisma resolves relative file: URLs against the
 * schema location), then repo root. Missing DATABASE_URL → repo default
 * db/custom.db (the documented sandbox layout).
 */
function resolveSqlitePath(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return join(ROOT, "db", "custom.db");

  if (/^postgres(ql)?:\/\//i.test(url)) {
    // Handled by caller (pg_dump guidance) — unreachable here.
    return "";
  }
  if (!/^file:/i.test(url)) {
    // Plain path (non-URL form) — accept it as-is.
    return resolve(url);
  }

  const raw = url.slice("file:".length).replace(/^\/\//, "");
  if (/^\/[^/]/.test(raw)) return raw; // absolute
  const candidates = [
    resolve(process.cwd(), raw),
    resolve(ROOT, "prisma", raw),
    resolve(ROOT, raw),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // Nothing exists — return the cwd-relative candidate so the error message
  // names a concrete, checkable path.
  return candidates[0]!;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function countTables(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    const row = db
      .query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function timestampUtc(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function pruneOldBackups(outDir: string, keep: number): { kept: string[]; pruned: string[] } {
  const files = readdirSync(outDir)
    .filter((f) => /^beanfolio-\d{8}-\d{6}\.db$/.test(f))
    .sort()
    .reverse(); // newest first (timestamped names sort lexicographically)
  const kept: string[] = [];
  const pruned: string[] = [];
  files.forEach((f, i) => {
    if (i < keep) {
      kept.push(f);
    } else {
      try {
        unlinkSync(join(outDir, f));
        const sidecar = join(outDir, `${f}.json`);
        if (existsSync(sidecar)) unlinkSync(sidecar);
        pruned.push(f);
      } catch {
        // A file that cannot be deleted must not fail the backup itself.
      }
    }
  });
  return { kept, pruned };
}

async function backupSqlite(sourcePath: string, outDir: string, keep: number): Promise<void> {
  if (!existsSync(sourcePath)) {
    console.error(`[backup-db] source database not found: ${sourcePath}`);
    console.error("[backup-db] check DATABASE_URL (see .env.example) and run from the repo root.");
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const stamp = timestampUtc();
  const finalPath = join(outDir, `beanfolio-${stamp}.db`);
  const tmpPath = `${finalPath}.vacuuming-${process.pid}`;

  let method: BackupManifest["method"] = "vacuum-into";
  try {
    // Read-only handle: the source can never be modified by this script.
    const src = new Database(sourcePath, { readonly: true });
    try {
      // Single quoted-string escape for the VACUUM INTO target path.
      src.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
    renameSync(tmpPath, finalPath);
  } catch (err) {
    // Fallback: raw copy. Honest downgrade — see manifest.method.
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    console.warn(
      "[backup-db] VACUUM INTO unavailable on this runtime — falling back to raw file copy. " +
        "Stop the app (or accept a small consistency risk on a live WAL database) for raw copies.",
    );
    console.warn(`[backup-db] reason: ${err instanceof Error ? err.message : String(err)}`);
    try {
      copyFileSync(sourcePath, finalPath);
      const wal = `${sourcePath}-wal`;
      const shm = `${sourcePath}-shm`;
      const walTarget = `${finalPath}-wal`;
      const shmTarget = `${finalPath}-shm`;
      if (existsSync(wal)) copyFileSync(wal, walTarget);
      if (existsSync(shm)) copyFileSync(shm, shmTarget);
      method = "raw-copy";
    } catch (copyErr) {
      console.error(`[backup-db] raw-copy fallback failed: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`);
      process.exit(1);
    }
  }

  const bytes = statSync(finalPath).size;
  const sha256 = await sha256File(finalPath);
  const tables = countTables(finalPath);

  const manifest: BackupManifest = {
    file: `beanfolio-${stamp}.db`,
    bytes,
    sha256,
    tables,
    method,
    source: sourcePath,
    generatedAt: new Date().toISOString(),
    database: "sqlite",
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(outDir, `${manifest.file}.json`), `${JSON.stringify(manifest, null, 2)}\n`);

  const { kept, pruned } = pruneOldBackups(outDir, keep);

  // Single-line manifest for log aggregation / cron capture.
  console.log(
    JSON.stringify({
      event: "backup.ok",
      file: join(outDir, manifest.file),
      bytes,
      sha256,
      tables,
      method,
      kept: kept.length,
      pruned: pruned.length,
    }),
  );
  if (pruned.length > 0) {
    console.log(`[backup-db] pruned (keep=${keep}): ${pruned.join(", ")}`);
  }
}

function printPostgresGuidance(): void {
  // Honest boundary: a JS reimplementation of pg_dump would be a liability.
  // pg_dump understands server versioning, catalog reads and custom formats.
  const stamp = timestampUtc();
  console.log(
    JSON.stringify({
      event: "backup.postgres.guidance",
      database: "postgres",
      tool: "pg_dump (no JS reimplementation — by design)",
    }),
  );
  console.log(`
[backup-db] DATABASE_URL is PostgreSQL — this script takes no side effects (exit 0).
[backup-db] Use pg_dump from a host that can reach the database (run on YOUR machine
[backup-db] or an ops box; managed providers also offer automated backups + PITR).

Recommended (custom format — restorable with pg_restore, supports parallel + selective restore):

  pg_dump --no-owner --no-privileges --format=custom \\
    --file="beanfolio-${stamp}.dump" "$DATABASE_URL"

Notes:
  - The pg_dump major version must be >= the server's major version.
  - Restore drill: pg_restore --clean --if-exists --dbname "<scratch-db>" beanfolio-*.dump
  - Keep the dump OFF shared/ephemeral storage; upload to object storage with
    server-side encryption and retention (see docs/ops/RUNBOOK.md §backups).
  - Managed providers (Neon/Supabase/RDS) already provide point-in-time recovery —
    enable and VERIFY it; a PITR toggle is not a tested restore.
`);
}

async function main(): Promise<void> {
  const { out, keep } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL?.trim() ?? "";

  if (/^postgres(ql)?:\/\//i.test(url)) {
    printPostgresGuidance();
    return; // exit 0, zero side effects
  }

  const sourcePath = resolveSqlitePath();
  const outDir = resolve(out ?? join(ROOT, "db", "backups"));
  await backupSqlite(sourcePath, outDir, keep);
}

main().catch((e: unknown) => {
  console.error("[backup-db] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
