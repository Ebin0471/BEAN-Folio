/**
 * Database RESTORE (Phase 7 operational readiness) — the rehearsal half of
 * backup/restore. Restoring over a LIVE database is destructive, so this
 * script refuses to do that without an explicit flag.
 *
 * SQLite — restore a snapshot to a TARGET FILE (default: a scratch path next
 * to the backup; the live db file is never touched without --replace-live):
 *
 *   bun scripts/ops/restore-db.ts --from backups/db/db-<ts>.sqlite3 \
 *        [--to /tmp/restored.sqlite3] [--replace-live]
 *
 *   - copies the snapshot to the target, runs PRAGMA integrity_check, and
 *     prints row counts of the key tables for manual parity review;
 *   - --replace-live: additionally swaps the restored file into the live
 *     DATABASE_URL path (server must be STOPPED; requires --yes as well).
 *
 * PostgreSQL — restore a pg_dump custom-format archive:
 *
 *   bun scripts/ops/restore-db.ts --from backups/db/db-<ts>.dump --yes
 *
 *   - runs `pg_restore --no-owner --clean --if-exists --dbname=$DATABASE_URL`
 *     (destructive to the target database — hence the --yes requirement).
 *
 * Exit 0 only when the restored artifact verifies.
 */

import { spawnSync } from "child_process";
import { existsSync, copyFileSync, renameSync, statSync } from "fs";
import { resolve, join, dirname } from "path";
import { Database } from "bun:sqlite";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(name);

const from = arg("--from");
if (!from || !existsSync(from)) {
  console.error("Usage: bun scripts/ops/restore-db.ts --from <backup-file> [--to <path>] [--replace-live] [--yes]");
  process.exit(1);
}
const source = resolve(from);

const url = process.env.DATABASE_URL ?? "";
if (!url) {
  console.error("DATABASE_URL is not set — no restore target known.");
  process.exit(1);
}
const engine = url.startsWith("postgres") ? "postgresql" : url.startsWith("file:") ? "sqlite" : "unknown";

const KEY_TABLES = ["User", "Project", "MediaAsset", "AgentTask", "AgentArtifact", "Session"] as const;

function parseSqlitePath(u: string): string {
  let p = u.replace(/^file:/, "");
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  return resolve(p);
}

function verifySqlite(dbPath: string, label: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") {
      console.error(`${label}: integrity_check FAILED: ${integrity.integrity_check}`);
      return false;
    }
    console.log(`${label}: integrity ok`);
    for (const table of KEY_TABLES) {
      const c = (db.query(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
      console.log(`  ${label} ${table}: ${c} rows`);
    }
    return true;
  } finally {
    db.close();
  }
}

if (engine === "sqlite") {
  const liveDb = parseSqlitePath(url);
  const target = arg("--to") ? resolve(arg("--to")!) : join(dirname(source), `restored-${Date.now()}.sqlite3`);
  copyFileSync(source, target);
  console.log(`Restored snapshot → ${target} (${(statSync(target).size / 1024 / 1024).toFixed(2)} MB)`);
  if (!verifySqlite(target, "restored")) process.exit(1);
  console.log(`Source snapshot: ${verifySqlite(source, "snapshot") ? "verified" : "FAILED"}`);

  if (hasFlag("--replace-live")) {
    if (!hasFlag("--yes")) {
      console.error("Refusing to overwrite the LIVE database without --yes (and a stopped server).");
      process.exit(1);
    }
    console.log(`--replace-live: swapping restored file into ${liveDb} (live db moved to ${liveDb}.pre-restore)`);
    renameSync(liveDb, `${liveDb}.pre-restore`);
    copyFileSync(target, liveDb);
    console.log("Live database replaced. Start the server and run the readiness probe.");
  } else {
    console.log("Rehearsal only — the live database was NOT touched (pass --replace-live --yes to swap).");
  }
  process.exit(0);
}

if (engine === "postgresql") {
  if (!hasFlag("--yes")) {
    console.error("Refusing to run a destructive pg_restore without --yes.");
    process.exit(1);
  }
  const restore = spawnSync(
    "pg_restore",
    ["--no-owner", "--clean", "--if-exists", "--dbname", url, source],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" }
  );
  if (restore.status !== 0) {
    console.error(`pg_restore failed: ${restore.stderr?.slice(0, 500) ?? "unknown error"}`);
    process.exit(1);
  }
  console.log("pg_restore completed. Verify with the schema readiness probe:");
  console.log("  bun run scripts/check-postgres-schema-readiness.ts");
  process.exit(0);
}

console.error(`Unsupported DATABASE_URL engine: ${url.slice(0, url.indexOf(":")) || "unknown"}`);
process.exit(1);
