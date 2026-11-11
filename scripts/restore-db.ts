/**
 * BEAN Folio — SQLite database restore (ops tooling, no Next.js imports).
 *
 *   bun scripts/restore-db.ts <backupFile> [--force] [--target <path>]
 *
 * What it does:
 *   1. Verifies the backup against its sha256 manifest sidecar
 *      (`<backupFile>.json`, as written by scripts/backup-db.ts). Without a
 *      sidecar the hash is RECOMPUTED and printed — provenance is then
 *      unverified and says so (honest, not silent).
 *   2. Prints a prominent stop-the-app warning before touching anything.
 *   3. Pre-flights the backup itself: `PRAGMA integrity_check` must pass on
 *      the BACKUP file before the current database is put at risk.
 *   4. Restores via copy to a temp file → integrity check on the temp →
 *      atomic rename over the target. The previous target file (if any) is
 *      first preserved as <target>.bak-<timestamp>. A failed integrity check
 *      aborts with the current database untouched.
 *   5. Re-verifies the restored file and prints one JSON result line
 *      { restored, bytes, sha256, integrity, tables, manifest }.
 *
 * Safety rails:
 *   - Overwriting an existing target REQUIRES --force (explicit consent).
 *   - Refuses to run when DATABASE_URL is PostgreSQL and no --target was
 *     given (a SQLite file cannot be "restored" over Postgres — use
 *     pg_restore; see scripts/backup-db.ts guidance).
 *   - --target <path> exists for throwaway/scratch restores (restore drills)
 *     — restoring into a scratch path never touches the live database and
 *     needs no --force when the target does not exist yet.
 *
 * Exit codes: 0 ok · 1 failure (corrupt backup, hash mismatch, …)
 *             2 usage / refused (missing args, existing target without --force)
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createReadStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

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

interface RestoreResult {
  restored: string;
  bytes: number;
  sha256: string;
  integrity: "ok";
  tables: number;
  manifest: "verified" | "recomputed";
  backup: { file: string; sha256: string; generatedAt?: string; method?: string };
  previousBackup: string | null;
}

function usage(): never {
  console.error("Usage: bun scripts/restore-db.ts <backupFile> [--force] [--target <path>]");
  process.exit(2);
}

interface ParsedArgs {
  backupFile: string | null;
  force: boolean;
  target?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { backupFile: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") args.force = true;
    else if (a === "--target") args.target = argv[++i];
    else if (a === "--help" || a === "-h") usage();
    else if (args.backupFile === null) args.backupFile = a;
    else usage();
  }
  if (!args.backupFile) usage();
  return args;
}

/** Same resolution rules as scripts/backup-db.ts (documented there). */
function resolveDefaultSqliteTarget(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return join(ROOT, "db", "custom.db");
  if (!/^file:/i.test(url)) return resolve(url);
  const raw = url.slice("file:".length).replace(/^\/\//, "");
  if (/^\/[^/]/.test(raw)) return raw;
  const candidates = [resolve(process.cwd(), raw), resolve(ROOT, "prisma", raw), resolve(ROOT, raw)];
  for (const c of candidates) if (existsSync(c)) return c;
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

function findSidecar(backupFile: string): string | null {
  const candidates = [`${backupFile}.json`, backupFile.replace(/\.db$/i, ".json")];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function integrityCheck(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("PRAGMA integrity_check").get() as Record<string, string>;
    const value = row.integrity_check ?? Object.values(row)[0] ?? "unknown";
    return value;
  } finally {
    db.close();
  }
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

function printStopWarning(backupFile: string, target: string): void {
  console.log("======================================================================");
  console.log("  STOP THE APP BEFORE RESTORING");
  console.log("----------------------------------------------------------------------");
  console.log("  Stop every process using the database (Next standalone server,");
  console.log("  `bun scripts/queue-drain.ts` workers, dev server) before the");
  console.log("  rename lands. On a LIVE database with an in-process worker, a");
  console.log("  running job could write to the OLD file handle after the swap and");
  console.log("  those writes would be lost.");
  console.log(`  Backup : ${backupFile}`);
  console.log(`  Target : ${target}`);
  console.log("======================================================================");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const backupFile = resolve(args.backupFile!);

  if (!existsSync(backupFile)) {
    console.error(`[restore-db] backup file not found: ${backupFile}`);
    process.exit(1);
  }

  // ---- 1. Manifest verification (sidecar .json, else recompute honestly) ----
  const bytes = statSync(backupFile).size;
  const sha256 = await sha256File(backupFile);
  let manifestState: RestoreResult["manifest"] = "recomputed";
  let manifest: Partial<BackupManifest> = {};
  const sidecar = findSidecar(backupFile);
  if (sidecar) {
    let parsed: BackupManifest;
    try {
      parsed = JSON.parse(await Bun.file(sidecar).text()) as BackupManifest;
    } catch (e) {
      console.error(`[restore-db] manifest sidecar is not valid JSON: ${sidecar} (${e instanceof Error ? e.message : e})`);
      process.exit(1);
    }
    if (parsed.sha256 && parsed.sha256 !== sha256) {
      console.error(`[restore-db] SHA-256 MISMATCH — backup file does not match its manifest. Aborting.`);
      console.error(`  manifest : ${parsed.sha256}  (${sidecar})`);
      console.error(`  actual   : ${sha256}`);
      process.exit(1);
    }
    if (typeof parsed.bytes === "number" && parsed.bytes !== bytes) {
      console.error(`[restore-db] byte-size mismatch vs manifest (${parsed.bytes} != ${bytes}). Aborting.`);
      process.exit(1);
    }
    manifest = parsed;
    manifestState = "verified";
    console.log(`[restore-db] manifest verified: sha256 ${sha256} (${sidecar})`);
  } else {
    console.warn(
      `[restore-db] NO manifest sidecar found — recomputed sha256 ${sha256}. ` +
        `Provenance is UNVERIFIED (integrity of the file contents is still checked below).`,
    );
  }

  // ---- 2. Stop-the-app warning (printed before any mutation) ----
  const url = process.env.DATABASE_URL?.trim() ?? "";
  const target = args.target ? resolve(args.target) : resolveDefaultSqliteTarget();
  printStopWarning(backupFile, target);

  if (/^postgres(ql)?:\/\//i.test(url) && !args.target) {
    console.error(
      "[restore-db] DATABASE_URL is PostgreSQL and no --target was given. A SQLite backup file cannot be " +
        "restored over Postgres. For Postgres use: pg_restore --clean --if-exists --dbname <db> <dump>, " +
        "or pass --target <scratch-path> for a throwaway restore drill.",
    );
    process.exit(2);
  }

  // ---- 3. Pre-flight the BACKUP (never clobber a good DB with a bad backup) ----
  const backupIntegrity = integrityCheck(backupFile);
  if (backupIntegrity !== "ok") {
    console.error(`[restore-db] backup file fails PRAGMA integrity_check: "${backupIntegrity}". Aborting — target untouched.`);
    process.exit(1);
  }

  // ---- 4. Preserve current target (.bak) / refuse without --force ----
  let previousBackup: string | null = null;
  if (existsSync(target)) {
    if (!args.force) {
      console.error(`[restore-db] target exists: ${target}`);
      console.error("[restore-db] refusing to overwrite without --force.");
      console.error("[restore-db] for restore drills use a throwaway path: --target /tmp/restore-drill/restored.db");
      process.exit(2);
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    previousBackup = `${target}.bak-${stamp}`;
    copyFileSync(target, previousBackup);
    console.log(`[restore-db] current database preserved as: ${previousBackup}`);
  }

  // ---- 5. Copy → verify temp → atomic rename ----
  mkdirSync(dirname(target), { recursive: true });
  const stamp2 = Date.now();
  const tmpPath = `${target}.restoring-${stamp2}`;
  try {
    copyFileSync(backupFile, tmpPath);
    // Integrity-check the temp copy (protects against truncated copies too).
    const tmpIntegrity = integrityCheck(tmpPath);
    if (tmpIntegrity !== "ok") {
      throw new Error(`restored temp file fails integrity_check: "${tmpIntegrity}"`);
    }
    // Clean any stray live WAL/SHM leftovers that belonged to the old target —
    // a stale -wal from the previous database must never be applied to the new one.
    for (const suffix of ["-wal", "-shm"]) {
      const stray = `${target}${suffix}`;
      if (existsSync(stray)) unlinkSync(stray);
    }
    renameSync(tmpPath, target);
  } catch (e) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    console.error(`[restore-db] restore FAILED and was rolled back — target unchanged: ${e instanceof Error ? e.message : e}`);
    if (previousBackup) {
      console.error(`[restore-db] a pre-restore copy of the previous database is at: ${previousBackup}`);
    }
    process.exit(1);
  }

  // ---- 6. Verify the restored file ----
  const finalIntegrity = integrityCheck(target);
  if (finalIntegrity !== "ok") {
    console.error(`[restore-db] restored file integrity_check: "${finalIntegrity}" — MANUAL ACTION REQUIRED.`);
    if (previousBackup) {
      console.error(`[restore-db] recover the previous database: cp "${previousBackup}" "${target}"`);
    }
    process.exit(1);
  }
  const restoredTables = countTables(target);
  const expectedTables = typeof manifest.tables === "number" ? manifest.tables : null;
  if (expectedTables !== null && restoredTables !== expectedTables) {
    console.warn(
      `[restore-db] table-count note: manifest says ${expectedTables}, restored file has ${restoredTables}. ` +
        `(Raw-copy backups of a mid-migration database can legitimately differ.)`,
    );
  }

  const result: RestoreResult = {
    restored: target,
    bytes: statSync(target).size,
    sha256,
    integrity: "ok",
    tables: restoredTables,
    manifest: manifestState,
    backup: {
      file: backupFile,
      sha256,
      generatedAt: manifest.generatedAt,
      method: manifest.method,
    },
    previousBackup,
  };
  console.log(JSON.stringify({ event: "restore.ok", ...result }));
  console.log(
    `[restore-db] restored OK — integrity_check: ok, tables: ${restoredTables}` +
      `${expectedTables !== null ? ` (manifest: ${expectedTables})` : ""}` +
      `${previousBackup ? `, previous db saved as ${previousBackup}` : ""}`,
  );
  console.log("[restore-db] next: restart the app, then verify GET /api/ready and a DB-backed route (see docs/ops/RUNBOOK.md).");
}

main().catch((e: unknown) => {
  console.error("[restore-db] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
