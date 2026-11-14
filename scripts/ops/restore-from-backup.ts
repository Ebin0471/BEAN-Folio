/**
 * BEAN FOLIO M21 — safe recovery from a coordinated backup.
 *
 *   bun scripts/ops/restore-from-backup.ts --manifest <backup-manifest-*.json> \
 *        [--staging <dir>] [--confirm-live] [--yes]
 *
 * Safety contract (DEVELOPMENT_SAFETY.md §2/§3):
 *
 *   1. VALIDATE FIRST — the coordinated manifest is structurally validated
 *      (schema, status:"complete") and BOTH artifacts are re-verified:
 *      recomputed sha256 + byte size against the manifest AND the sidecar
 *      ledgers; the media archive is additionally round-trip extracted and
 *      every file checksum-compared. Any mismatch ABORTS before anything
 *      is touched.
 *   2. PRE-RESTORE BACKUP — a fresh, verified backup of the CURRENT
 *      database (and current media for live restores) is created into
 *      <staging>/pre-restore/ FIRST. A live restore refuses to run if this
 *      backup fails.
 *   3. ISOLATED BY DEFAULT — without --confirm-live the restore lands ONLY
 *      in a staging directory (default: <manifest-dir>/restore-drill-<ts>):
 *      the database snapshot is copied and integrity-checked, the media
 *      archive is extracted and checksum-verified. The live system is not
 *      touched.
 *   4. EXPLICIT HUMAN CONFIRMATION — touching production requires BOTH
 *      --confirm-live AND --yes on the command line (this environment has
 *      no interactive TTY; the flags ARE the explicit confirmation). The
 *      script prints the stop-the-app checklist before swapping anything.
 *   5. NEVER AUTOMATIC OVER PRODUCTION — the live database swap preserves
 *      the previous file as <live>.bak-<ts> first; the live media copy is
 *      performed file-by-file from the verified staging tree; the live S3
 *      restore re-uploads only after re-verifying every staged checksum.
 *      PostgreSQL live restores are NOT automated (pg_restore --clean is
 *      destructive): the exact command is printed for a human to run.
 *
 * Exit codes: 0 ok · 1 failure · 2 refused/usage.
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_KEY_TABLES,
  ORCHESTRATOR_SCHEMA,
  backupMediaLocal,
  backupMediaS3,
  backupSqliteSnapshot,
  loadArtifactManifest,
  parseSqlitePath,
  restoreObjectsToS3,
  sha256File,
  sqliteIntegrity,
  sqliteRowCounts,
  sqliteTableCount,
  verifyArtifactFile,
  walkFiles,
  type ArtifactManifest,
  type OrchestratorManifest,
} from "./lib/backup-core";
import { resolveMediaBackupMode } from "./lib/media-mode";
import { uploadRoot } from "../../src/lib/storage";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(name);

const manifestArg = arg("--manifest");
if (!manifestArg) {
  console.error(
    "Usage: bun scripts/ops/restore-from-backup.ts --manifest <backup-manifest-*.json> [--staging <dir>] [--confirm-live] [--yes]",
  );
  process.exit(2);
}
const manifestPath = resolve(manifestArg);
if (!existsSync(manifestPath)) {
  console.error(`[restore] coordinated manifest not found: ${manifestPath}`);
  process.exit(1);
}

const liveRequested = hasFlag("--confirm-live");
const yes = hasFlag("--yes");

function refused(message: string): never {
  console.error(`[restore] REFUSED: ${message}`);
  console.error("[restore] Nothing was modified.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 1. Validate the coordinated manifest + both artifacts (before ANY change)
// ---------------------------------------------------------------------------

let orchestrated: OrchestratorManifest;
try {
  orchestrated = JSON.parse(await Bun.file(manifestPath).text()) as OrchestratorManifest;
} catch (err) {
  console.error(`[restore] coordinated manifest is not valid JSON: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
if (orchestrated.schema !== ORCHESTRATOR_SCHEMA) {
  refused(`manifest schema mismatch: expected ${ORCHESTRATOR_SCHEMA}, got ${String(orchestrated.schema)}`);
}
if (orchestrated.status !== "complete") {
  refused(`manifest status is "${orchestrated.status}" — only fully verified (status:"complete") backups can be restored`);
}
const outDir = resolve(orchestrated.outDir ?? dirname(manifestPath));
if (!orchestrated.database?.artifact || !orchestrated.media?.artifact) {
  refused("manifest does not connect both required artifacts (database + media)");
}

const dbArtifactPath = resolve(outDir, orchestrated.database.artifact);
const mediaArtifactPath = resolve(outDir, orchestrated.media.artifact);
for (const [label, path] of [
  ["database artifact", dbArtifactPath],
  ["media artifact", mediaArtifactPath],
] as const) {
  if (!existsSync(path)) {
    console.error(`[restore] ${label} missing on disk: ${path}`);
    process.exit(1);
  }
}

let dbSidecar: ArtifactManifest;
let mediaSidecar: ArtifactManifest;
try {
  dbSidecar = loadArtifactManifest(resolve(outDir, orchestrated.database.manifest!));
  const v = verifyArtifactFile(dbArtifactPath, dbSidecar);
  if (!v.ok) throw new Error(`database artifact failed verification: ${v.errors.join("; ")}`);
  console.log(`[restore] database artifact verified: sha256 ${dbSidecar.sha256} · ${dbSidecar.bytes} bytes`);

  mediaSidecar = loadArtifactManifest(resolve(outDir, orchestrated.media.manifest!));
  const m = verifyArtifactFile(mediaArtifactPath, mediaSidecar);
  if (!m.ok) throw new Error(`media artifact failed verification: ${m.errors.join("; ")}`);
  if (!mediaSidecar.entries?.length) throw new Error("media manifest has no checksum ledger");
  console.log(`[restore] media artifact verified: sha256 ${mediaSidecar.sha256} · ${mediaSidecar.fileCount} files`);
} catch (err) {
  console.error(`[restore] INVALID BACKUP REJECTED: ${err instanceof Error ? err.message : err}`);
  console.error("[restore] Nothing was modified — the backup does not match its manifest.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Staging directory + PRE-RESTORE BACKUP of the current state
// ---------------------------------------------------------------------------

const staging = arg("--staging")
  ? resolve(arg("--staging")!)
  : join(dirname(manifestPath), `restore-drill-${new Date().toISOString().replace(/[:.]/g, "-")}`);
if (existsSync(staging)) {
  refused(`staging directory already exists: ${staging} — pick a fresh directory (nothing is ever overwritten)`);
}
mkdirSync(staging, { recursive: true });
const preRestoreDir = join(staging, "pre-restore");

console.log(`[restore] staging (isolated): ${staging}`);
console.log(`[restore] creating a fresh PRE-RESTORE BACKUP of the current state → ${preRestoreDir}`);

const url = process.env.DATABASE_URL ?? "";
let liveDbPath: string | null = null;
const preRestoreNotes: string[] = [];

if (/^postgres/i.test(url)) {
  preRestoreNotes.push(
    "DATABASE_URL is PostgreSQL — pg_dump tooling or provider PITR owns pre-restore backups here; live restore is not automated (see below).",
  );
} else if (url) {
  liveDbPath = resolve(url.startsWith("file:") ? parseSqlitePath(url) : url);
  try {
    const pre = await backupSqliteSnapshot(liveDbPath, join(preRestoreDir, "db"), DEFAULT_KEY_TABLES);
    console.log(`[restore] pre-restore database backup: ${join(preRestoreDir, "db", pre.file)} (sha256 ${pre.sha256})`);
  } catch (err) {
    console.error(`[restore] PRE-RESTORE BACKUP FAILED: ${err instanceof Error ? err.message : err}`);
    if (liveRequested) {
      console.error("[restore] a live restore REFUSES to run without a successful pre-restore backup.");
      process.exit(1);
    }
    preRestoreNotes.push(`pre-restore db backup failed: ${err instanceof Error ? err.message : err}`);
  }
} else {
  preRestoreNotes.push("DATABASE_URL is not set — the current database cannot be backed up (staging-only validation still runs).");
}

let mediaMode: ReturnType<typeof resolveMediaBackupMode> | null = null;
try {
  mediaMode = resolveMediaBackupMode();
} catch (err) {
  preRestoreNotes.push(`media driver resolution failed: ${err instanceof Error ? err.message : err}`);
  mediaMode = null;
}

let preRestoreMediaOk = false;
if (mediaMode) {
  try {
    if (mediaMode.driver === "local") {
      const pre = await backupMediaLocal(uploadRoot(), join(preRestoreDir, "media"));
      console.log(`[restore] pre-restore media backup: ${join(preRestoreDir, "media", pre.file)} (${pre.fileCount} files)`);
      preRestoreMediaOk = true;
    } else {
      const pre = await backupMediaS3(mediaMode.cfg, join(preRestoreDir, "media"));
      console.log(`[restore] pre-restore media backup (S3): ${join(preRestoreDir, "media", pre.file)} (${pre.fileCount} objects)`);
      preRestoreMediaOk = true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // An ALREADY-EMPTY medium has nothing to preserve — that is precisely the
    // disaster a restore recovers from. Tolerate exactly that case (loudly);
    // every other pre-restore failure refuses the live restore.
    const emptyMedium = /0 objects under prefix|nothing to back up|contains no files/.test(message);
    if (emptyMedium) {
      console.warn("[restore] PRE-RESTORE MEDIA BACKUP SKIPPED: the current medium is EMPTY — nothing to preserve.");
      console.warn("[restore] (This is the disaster scenario itself; the restore will re-populate the medium from the verified backup.)");
      preRestoreNotes.push("pre-restore media backup skipped: current medium empty (nothing to preserve)");
      preRestoreMediaOk = true; // empty medium — nothing at risk
    } else {
      console.error(`[restore] PRE-RESTORE MEDIA BACKUP FAILED: ${message}`);
      if (liveRequested) {
        console.error("[restore] a live restore REFUSES to run without a successful pre-restore media backup.");
        process.exit(1);
      }
      preRestoreNotes.push(`pre-restore media backup failed: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Isolated staging restore (the default — production is never touched)
// ---------------------------------------------------------------------------

const restoredDbDir = join(staging, "restored", "database");
mkdirSync(restoredDbDir, { recursive: true });

if (dbSidecar.engine === "postgresql") {
  console.log("[restore] PostgreSQL dump: checksum-verified above. Extract/restore requires pg_restore (see the live section).");
} else {
  const restoredDbPath = join(restoredDbDir, dbSidecar.file);
  copyFileSync(dbArtifactPath, restoredDbPath);
  const integrity = sqliteIntegrity(restoredDbPath);
  if (integrity !== "ok") {
    console.error(`[restore] restored copy fails integrity_check: "${integrity}" — the BACKUP is corrupt.`);
    console.error("[restore] Nothing was modified. Investigate the backup artifact.");
    process.exit(1);
  }
  const counts = sqliteRowCounts(restoredDbPath, DEFAULT_KEY_TABLES);
  console.log(`[restore] restored database copy verified (integrity ok, tables: ${sqliteTableCount(restoredDbPath)})`);
  for (const [table, n] of Object.entries(counts)) console.log(`  ${table}: ${n} rows`);
}

const restoredMediaRoot = join(staging, "restored", "media");
mkdirSync(restoredMediaRoot, { recursive: true });
const extract = spawnSync("tar", ["-xzf", mediaArtifactPath, "-C", restoredMediaRoot], {
  stdio: ["ignore", "ignore", "pipe"],
  encoding: "utf8",
});
if (extract.status !== 0) {
  console.error(`[restore] media archive extraction failed: ${extract.stderr?.slice(0, 300)}`);
  process.exit(1);
}
// Per-file checksum comparison against the manifest ledger.
{
  const stagedFiles = walkFiles(join(restoredMediaRoot, "uploads"));
  const expected = mediaSidecar.entries!;
  if (stagedFiles.length !== expected.length) {
    console.error(
      `[restore] media extraction count mismatch: ${stagedFiles.length} vs ${expected.length} — INVALID BACKUP REJECTED. Nothing was modified.`,
    );
    process.exit(1);
  }
  let mismatch: string | null = null;
  for (const abs of stagedFiles) {
    const rel = abs.slice(restoredMediaRoot.length + 1);
    const entry = expected.find((e) => e.path === rel);
    if (!entry) {
      mismatch = `unexpected file in archive: ${rel}`;
      break;
    }
    if (statSync(abs).size !== entry.bytes || sha256File(abs) !== entry.sha256) {
      mismatch = `checksum mismatch for ${rel}`;
      break;
    }
  }
  if (mismatch) {
    console.error(`[restore] INVALID BACKUP REJECTED: ${mismatch} — Nothing was modified.`);
    process.exit(1);
  }
  console.log(`[restore] extracted media verified: ${stagedFiles.length} files, all checksums match the manifest ledger`);
}

// ---------------------------------------------------------------------------
// 4. Live restore — ONLY with --confirm-live AND --yes (explicit human action)
// ---------------------------------------------------------------------------

if (!liveRequested) {
  console.log(
    JSON.stringify({
      event: "restore.staging.ok",
      staging,
      restoredDb: dbSidecar.engine === "postgresql" ? null : join(restoredDbDir, dbSidecar.file),
      restoredMedia: join(restoredMediaRoot, "uploads"),
      preRestore: { dir: preRestoreDir, mediaOk: preRestoreMediaOk, notes: preRestoreNotes },
      live: "untouched (staging-only drill — pass --confirm-live --yes to restore over production)",
    }),
  );
  console.log("[restore] STAGING DRILL COMPLETE — live system untouched.");
  process.exit(0);
}

if (!yes) {
  refused("live restore requires BOTH --confirm-live and --yes (explicit human confirmation).");
}
if (mediaMode && mediaSidecar.driver && mediaMode.driver !== mediaSidecar.driver) {
  refused(
    `media driver mismatch: the backup is from "${mediaSidecar.driver}" but this environment currently resolves to ` +
      `"${mediaMode.driver}". Restoring across drivers would put the data on the wrong medium.`,
  );
}

console.log("======================================================================");
console.log("  LIVE RESTORE — STOP THE APP FIRST");
console.log("----------------------------------------------------------------------");
console.log("  Stop every process using the database and media (Next standalone,");
console.log("  dev server, queue workers) before this swap. A running worker could");
console.log("  write to the OLD file handle after the swap and lose its writes.");
console.log(`  Manifest     : ${manifestPath}`);
console.log(`  Live DB      : ${liveDbPath ?? "(PostgreSQL — not automated)"}`);
console.log(`  Live media   : driver ${mediaMode?.driver ?? "?"}`);
console.log("======================================================================");

// ---- live database ----
if (/^postgres/i.test(url)) {
  console.log("[restore] PostgreSQL: run this yourself from a host with pg_restore (destructive — reviewed by a human):");
  console.log(`  pg_restore --no-owner --clean --if-exists --dbname "$DATABASE_URL" ${dbArtifactPath}`);
} else if (liveDbPath) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const bakPath = `${liveDbPath}.bak-${stamp}`;
  copyFileSync(liveDbPath, bakPath);
  const tmpPath = `${liveDbPath}.restoring-${process.pid}`;
  try {
    copyFileSync(dbArtifactPath, tmpPath);
    const integrity = sqliteIntegrity(tmpPath);
    if (integrity !== "ok") throw new Error(`restored temp fails integrity_check: "${integrity}"`);
    for (const suffix of ["-wal", "-shm"]) {
      const stray = `${liveDbPath}${suffix}`;
      if (existsSync(stray)) rmSync(stray, { force: true });
    }
    renameSync(tmpPath, liveDbPath);
    console.log(`[restore] live database swapped: ${liveDbPath}`);
    console.log(`[restore] previous database preserved as: ${bakPath}`);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    } catch {
      /* best effort */
    }
    console.error(
      `[restore] LIVE DB RESTORE FAILED AND ROLLED BACK — live file unchanged: ${err instanceof Error ? err.message : err}`,
    );
    console.error(`[restore] the pre-restore copy of the previous database is at: ${bakPath}`);
    process.exit(1);
  }
}

// ---- live media ----
if (mediaMode?.driver === "local") {
  const liveUploads = join(uploadRoot(), "uploads");
  const stagedUploads = join(restoredMediaRoot, "uploads");
  if (!existsSync(stagedUploads)) {
    console.error("[restore] staged media tree missing — cannot copy to live. Live DB already swapped; see the .bak file.");
    process.exit(1);
  }
  let copied = 0;
  for (const abs of walkFiles(stagedUploads)) {
    const rel = abs.slice(stagedUploads.length + 1);
    const target = join(liveUploads, rel);
    if (!resolve(target).startsWith(resolve(liveUploads) + "/")) {
      throw new Error(`staged path escapes the live media root: ${rel}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(abs, target);
    copied += 1;
  }
  console.log(`[restore] live media restored: ${copied} files copied into ${liveUploads}`);
} else if (mediaMode?.driver === "s3") {
  const stagedRoot = restoredMediaRoot; // keys are "uploads/…" relative to this root
  const restored = await restoreObjectsToS3(mediaMode.cfg, mediaSidecar.entries!, stagedRoot);
  console.log(
    `[restore] live S3 media restored: ${restored} objects re-uploaded to bucket ${mediaMode.cfg.bucket} (checksum-verified before each upload)`,
  );
}

console.log(
  JSON.stringify({
    event: "restore.live.ok",
    staging,
    manifest: manifestPath,
    liveDatabase: liveDbPath,
    liveMediaDriver: mediaMode?.driver ?? null,
    preRestore: { dir: preRestoreDir },
  }),
);
console.log("[restore] LIVE RESTORE COMPLETE — restart the app, then verify GET /api/ready and a DB-backed route.");
process.exit(0);
