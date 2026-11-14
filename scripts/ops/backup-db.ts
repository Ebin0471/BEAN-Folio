/**
 * Database backup (M21 — shared core on scripts/ops/lib/backup-core.ts).
 *
 *   bun scripts/ops/backup-db.ts [--out backups/db] [--keep <N>] [--prune]
 *
 * SQLite (file: DATABASE_URL):
 *   - backups via `VACUUM INTO` — a consistent, compacted snapshot taken
 *     through SQLite's own machinery (safe while the app is running);
 *   - the snapshot is verified with PRAGMA integrity_check;
 *   - row counts of key tables are compared source vs snapshot;
 *   - a SHA-256 checksum + JSON manifest sidecar (<artifact>.json) record
 *     the backup metadata (bytes, sha256, tables, integrity, method, row
 *     parity, generatedAt) for later verification by the orchestrator and
 *     the restore path.
 *
 * PostgreSQL (postgres: DATABASE_URL):
 *   - shells out to `pg_dump --format=custom` (pg_dump must be installed);
 *   - the dump is verified with `pg_restore --list` (header parse = readable);
 *   - missing tooling FAILS with exact, actionable fix instructions — it is
 *     never reported as a successful backup.
 *
 * Retention (opt-in, M21):
 *   - --keep <N> builds a retention plan (dry run — prints what WOULD be
 *     pruned, deletes nothing);
 *   - --prune requires --keep and actually deletes the planned artifacts;
 *   - the newest verified-good backup is ALWAYS kept, artifacts without a
 *     valid checksum sidecar are never touched, and existing artifacts are
 *     never overwritten (fresh timestamped names only).
 *
 * Secrets: the connection string is NEVER printed (only its engine type).
 * Exit 0 + a JSON result line on success; non-zero on any failure — a failed
 * backup leaves no artifact behind.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  backupPostgresDump,
  backupSqliteSnapshot,
  applyRetention,
} from "./lib/backup-core";

const KEY_TABLES = ["User", "Project", "MediaAsset", "AgentTask", "AgentArtifact", "Session"] as const;

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : "backups/db");

let keep: number | null = null;
const keepIdx = args.indexOf("--keep");
if (keepIdx >= 0) {
  keep = Number(args[keepIdx + 1]);
  if (!Number.isInteger(keep) || keep < 1) {
    console.error("--keep must be a positive integer");
    process.exit(2);
  }
}
const prune = args.includes("--prune");
if (prune && keep === null) {
  console.error("--prune requires --keep <N> (explicit count — retention never guesses)");
  process.exit(2);
}

const url = process.env.DATABASE_URL ?? "";
if (!url) {
  console.error("DATABASE_URL is not set — nothing to back up.");
  process.exit(1);
}

function parseSqlitePath(u: string): string {
  // file:./db/custom.db | file:/abs/path.db  (+ optional ?params)
  let p = u.replace(/^file:/, "");
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  return resolve(p);
}

const engine = url.startsWith("postgres") ? "postgresql" : url.startsWith("file:") ? "sqlite" : "unknown";

try {
  let manifest;
  if (engine === "sqlite") {
    manifest = await backupSqliteSnapshot(parseSqlitePath(url), outDir, KEY_TABLES);
  } else if (engine === "postgresql") {
    manifest = await backupPostgresDump(url, outDir);
  } else {
    console.error(`Unsupported DATABASE_URL engine: ${url.slice(0, url.indexOf(":")) || "unknown"}`);
    process.exit(1);
  }

  const file = resolve(outDir, manifest.file);
  for (const [table, count] of Object.entries(manifest.rowParity ?? {})) {
    console.log(`  ${table}: ${count} rows (verified)`);
  }
  console.log(`Backup verified OK: ${file} (${(manifest.bytes / 1024 / 1024).toFixed(2)} MB)`);
  console.log(
    JSON.stringify({
      event: "backup.ok",
      file,
      bytes: manifest.bytes,
      sha256: manifest.sha256,
      tables: manifest.tables ?? null,
      integrity: manifest.integrity ?? null,
      method: manifest.method ?? null,
      manifestSidecar: `${file}.json`,
    }),
  );

  if (keep !== null) {
    const plan = applyRetention(outDir, keep, { apply: prune });
    if (!prune) {
      console.log(
        `[backup-db] retention dry-run (keep=${keep}): would prune ${plan.pruneFiles.length}, ` +
          `keeping ${plan.keepFiles.length} (newest verified-good always kept). ` +
          `Re-run with --prune to delete.`,
      );
    } else {
      console.log(`[backup-db] retention applied (keep=${keep}): pruned ${plan.pruneFiles.length}.`);
    }
    for (const s of plan.skipped) console.log(`  skipped ${s.file}: ${s.reason}`);
    console.log(
      JSON.stringify({
        event: "retention",
        applied: prune,
        keep,
        pruned: plan.pruneFiles,
        skipped: plan.skipped,
      }),
    );
  }
} catch (err) {
  console.error(`[backup-db] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  console.error("[backup-db] no verified backup was produced — see the message above for the exact fix.");
  process.exit(1);
}
