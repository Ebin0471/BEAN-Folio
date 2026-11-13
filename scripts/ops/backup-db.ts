/**
 * Database backup (Phase 7 operational readiness).
 *
 *   bun scripts/ops/backup-db.ts --out backups/db
 *
 * SQLite (file: DATABASE_URL):
 *   - backups via `VACUUM INTO` — a consistent, compacted snapshot taken
 *     through SQLite's own machinery (safe while the app is running);
 *   - the snapshot is verified with PRAGMA integrity_check;
 *   - row counts of key tables are compared source vs snapshot.
 *
 * PostgreSQL (postgres: DATABASE_URL):
 *   - shells out to `pg_dump --format=custom` (pg_dump must be installed);
 *   - the dump is verified with `pg_restore --list` (header parse = readable).
 *
 * Secrets: the connection string is NEVER printed (only its engine type).
 * Exit 0 + the backup path on success; non-zero on any verification failure.
 */

import { spawnSync } from "child_process";
import { mkdirSync, existsSync, statSync, rmSync } from "fs";
import { join, resolve } from "path";
import { Database } from "bun:sqlite";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : "backups/db");

const url = process.env.DATABASE_URL ?? "";
if (!url) {
  console.error("DATABASE_URL is not set — nothing to back up.");
  process.exit(1);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseSqlitePath(url: string): string {
  // file:./db/custom.db | file:/abs/path.db  (+ optional ?params)
  let p = url.replace(/^file:/, "");
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  return resolve(p);
}

const KEY_TABLES = ["User", "Project", "MediaAsset", "AgentTask", "AgentArtifact", "Session"] as const;

function backupSqlite(dbPath: string, dest: string): boolean {
  if (!existsSync(dbPath)) {
    console.error(`SQLite database not found at ${dbPath}`);
    return false;
  }
  const src = new Database(dbPath, { readonly: true });
  try {
    src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  // Integrity + parity verification on the SNAPSHOT.
  const snap = new Database(dest, { readonly: true });
  try {
    const integrity = snap.query("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") {
      console.error(`Snapshot integrity_check FAILED: ${integrity.integrity_check}`);
      return false;
    }
    const source = new Database(dbPath, { readonly: true });
    try {
      for (const table of KEY_TABLES) {
        const a = (source.query(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
        const b = (snap.query(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
        if (a !== b) {
          console.error(`Row-count mismatch on ${table}: source=${a} snapshot=${b}`);
          return false;
        }
        console.log(`  ${table}: ${a} rows (verified)`);
      }
    } finally {
      source.close();
    }
  } finally {
    snap.close();
  }
  return true;
}

function backupPostgres(dest: string): boolean {
  const dump = spawnSync("pg_dump", ["--format=custom", "--file", dest, "--no-owner", url], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (dump.status !== 0) {
    console.error(`pg_dump failed: ${dump.stderr?.slice(0, 500) ?? "unknown error"}`);
    return false;
  }
  // Verify the archive is readable.
  const list = spawnSync("pg_restore", ["--list", dest], { encoding: "utf8" });
  if (list.status !== 0 || !list.stdout.includes("PostgreSQL database dump")) {
    console.error("pg_restore --list failed — dump archive is not verifiably readable.");
    return false;
  }
  return true;
}

mkdirSync(outDir, { recursive: true });
const engine = url.startsWith("postgres") ? "postgresql" : url.startsWith("file:") ? "sqlite" : "unknown";
const file = join(outDir, engine === "postgresql" ? `db-${timestamp()}.dump` : `db-${timestamp()}.sqlite3`);
console.log(`Backing up (${engine}) → ${file}`);

let ok = false;
if (engine === "sqlite") {
  ok = backupSqlite(parseSqlitePath(url), file);
} else if (engine === "postgresql") {
  ok = backupPostgres(file);
} else {
  console.error(`Unsupported DATABASE_URL engine: ${url.slice(0, url.indexOf(":")) || "unknown"}`);
}

if (!ok) {
  if (existsSync(file)) rmSync(file, { force: true });
  process.exit(1);
}
const size = statSync(file).size;
console.log(`Backup verified OK: ${file} (${(size / 1024 / 1024).toFixed(2)} MB)`);
