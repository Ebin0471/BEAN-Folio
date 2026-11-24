/**
 * BEAN FOLIO M21 — coordinated backup orchestrator.
 *
 *   bun scripts/ops/backup-all.ts [--out backups] [--keep <N>] [--prune]
 *
 * Runs BOTH required backup components through the shared verification core
 * (scripts/ops/lib/backup-core.ts):
 *
 *   1. database  — verified SQLite snapshot (VACUUM INTO + integrity + row
 *                  parity) or verified PostgreSQL pg_dump archive;
 *   2. media     — verified archive of the active storage driver's media
 *                  tree (local uploads/ or S3 bucket objects).
 *
 * It then writes ONE coordinated manifest (backup-manifest-<ts>.json) that
 * connects both artifacts and records EVERY verification result:
 *
 *   - artifact checksums (recomputed, not trusted from the component run),
 *   - archive readability + per-file checksum round-trip (media),
 *   - SQLite integrity re-check on the snapshot (database),
 *   - per-component errors when something failed.
 *
 * The operation FAILS CLOSED: if any required component or verification
 * fails, the manifest records status:"failed" with the errors and the
 * process exits non-zero — the run is never reported as a success.
 *
 * Artifacts are immutable: every file gets a fresh millisecond-timestamped
 * name and existing files are never overwritten. Retention is opt-in and
 * guarded (see planRetention): --keep <N> plans (dry run), --keep <N>
 * --prune applies, the newest verified-good artifact is always kept.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_KEY_TABLES,
  ORCHESTRATOR_SCHEMA,
  applyRetention,
  backupMediaLocal,
  backupMediaS3,
  backupPostgresDump,
  backupSqliteSnapshot,
  loadArtifactManifest,
  parseSqlitePath,
  sqliteIntegrity,
  timestampMs,
  verifyArtifactFile,
  verifyMediaArchive,
  writeJsonFresh,
  type ComponentCheck,
  type OrchestratorManifest,
} from "./lib/backup-core";
import { resolveMediaBackupMode } from "./lib/media-mode";
import { uploadRoot } from "../../src/lib/storage";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : "backups");

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

const errors: string[] = [];
function check(name: string, ok: boolean, detail: string): ComponentCheck {
  return { name, ok, detail };
}
function fail(component: "database" | "media", err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  errors.push(`${component}: ${message}`);
  console.error(`[backup-all] ${component} FAILED: ${message}`);
}

// ---------------------------------------------------------------------------
// Run components
// ---------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const dbOutDir = join(outDir, "db");
const mediaOutDir = join(outDir, "media");

const databaseChecks: ComponentCheck[] = [];
const mediaChecks: ComponentCheck[] = [];

let dbManifest = null as null | Awaited<ReturnType<typeof backupSqliteSnapshot>>;
let mediaManifest = null as null | Awaited<ReturnType<typeof backupMediaLocal>>;

const url = process.env.DATABASE_URL ?? "";
const engine = url.startsWith("postgres") ? "postgresql" : url.startsWith("file:") ? "sqlite" : "unknown";

if (!url) {
  const err = "DATABASE_URL is not set — nothing to back up.";
  errors.push(`database: ${err}`);
  console.error(`[backup-all] database FAILED: ${err}`);
} else if (engine === "sqlite") {
  try {
    dbManifest = await backupSqliteSnapshot(parseSqlitePath(url), dbOutDir, DEFAULT_KEY_TABLES);
    databaseChecks.push(check("artifact+sidecar", true, `${dbManifest.file} (${dbManifest.bytes} bytes)`));
  } catch (err) {
    fail("database", err);
  }
} else if (engine === "postgresql") {
  try {
    dbManifest = await backupPostgresDump(url, dbOutDir);
    databaseChecks.push(check("artifact+sidecar", true, `${dbManifest.file} (${dbManifest.bytes} bytes)`));
  } catch (err) {
    fail("database", err);
  }
} else {
  const err = `Unsupported DATABASE_URL engine: ${url.slice(0, url.indexOf(":")) || "unknown"}`;
  errors.push(`database: ${err}`);
  console.error(`[backup-all] database FAILED: ${err}`);
}

try {
  const mode = resolveMediaBackupMode();
  if (mode.driver === "s3") {
    console.log(`[backup-all] backing up S3 media (bucket ${mode.cfg.bucket})`);
    mediaManifest = await backupMediaS3(mode.cfg, mediaOutDir);
  } else {
    const mediaRoot = uploadRoot();
    console.log(`[backup-all] backing up local media (root ${mediaRoot})`);
    mediaManifest = await backupMediaLocal(mediaRoot, mediaOutDir);
  }
  mediaChecks.push(
    check(
      "artifact+sidecar",
      true,
      `${mediaManifest.file} (${mediaManifest.bytes} bytes, ${mediaManifest.fileCount} files, driver ${mediaManifest.driver})`,
    ),
  );
} catch (err) {
  fail("media", err);
}

// ---------------------------------------------------------------------------
// Coordinated verification pass (recompute everything, trust nothing)
// ---------------------------------------------------------------------------

const verificationChecks: ComponentCheck[] = [];

if (dbManifest) {
  const artifactPath = join(dbOutDir, dbManifest.file);
  try {
    const sidecar = loadArtifactManifest(`${artifactPath}.json`);
    const v = verifyArtifactFile(artifactPath, sidecar);
    verificationChecks.push(check("database.checksum", v.ok, v.ok ? `sha256 ${sidecar.sha256}` : v.errors.join("; ")));
    if (engine === "sqlite") {
      const integrity = sqliteIntegrity(artifactPath);
      verificationChecks.push(check("database.integrity", integrity === "ok", `PRAGMA integrity_check: ${integrity}`));
    }
  } catch (err) {
    verificationChecks.push(check("database.verify", false, err instanceof Error ? err.message : String(err)));
  }
}

if (mediaManifest) {
  const artifactPath = join(mediaOutDir, mediaManifest.file);
  try {
    const sidecar = loadArtifactManifest(`${artifactPath}.json`);
    const v = verifyArtifactFile(artifactPath, sidecar);
    verificationChecks.push(check("media.checksum", v.ok, v.ok ? `sha256 ${sidecar.sha256}` : v.errors.join("; ")));
    verifyMediaArchive(artifactPath, sidecar); // round-trip: extract + per-file sha256
    verificationChecks.push(check("media.archive", true, `${sidecar.fileCount} files round-trip verified`));
  } catch (err) {
    verificationChecks.push(check("media.verify", false, err instanceof Error ? err.message : String(err)));
  }
}

const allPassed =
  errors.length === 0 &&
  dbManifest !== null && // both components are REQUIRED — a missing one fails the run
  mediaManifest !== null &&
  verificationChecks.every((c) => c.ok);

const manifest: OrchestratorManifest = {
  schema: ORCHESTRATOR_SCHEMA,
  status: allPassed ? "complete" : "failed",
  generatedAt: new Date().toISOString(),
  outDir,
  database: {
    artifact: dbManifest ? join("db", dbManifest.file) : null,
    manifest: dbManifest ? join("db", `${dbManifest.file}.json`) : null,
    bytes: dbManifest?.bytes ?? null,
    sha256: dbManifest?.sha256 ?? null,
    checks: databaseChecks,
  },
  media: {
    artifact: mediaManifest ? join("media", mediaManifest.file) : null,
    manifest: mediaManifest ? join("media", `${mediaManifest.file}.json`) : null,
    bytes: mediaManifest?.bytes ?? null,
    sha256: mediaManifest?.sha256 ?? null,
    driver: mediaManifest?.driver ?? "local",
    checks: mediaChecks,
  },
  verification: { allPassed, checks: verificationChecks },
  errors,
};

const manifestPath = join(outDir, `backup-manifest-${timestampMs()}.json`);
writeJsonFresh(manifestPath, manifest);

if (dbManifest) {
  console.log(`Database backup: ${join(dbOutDir, dbManifest.file)} — sha256 ${dbManifest.sha256}`);
}
if (mediaManifest) {
  console.log(`Media backup:     ${join(mediaOutDir, mediaManifest.file)} — sha256 ${mediaManifest.sha256}`);
}

if (!allPassed) {
  console.error(`[backup-all] OPERATION FAILED — coordinated manifest (status: failed): ${manifestPath}`);
  for (const e of errors) console.error(`  error: ${e}`);
  process.exit(1);
}

console.log(`BACKUP COMPLETE — coordinated manifest: ${manifestPath}`);
console.log(
  JSON.stringify({
    event: "backup.all.ok",
    manifest: manifestPath,
    database: manifest.database.artifact,
    media: manifest.media.artifact,
    mediaDriver: manifest.media.driver,
    databaseSha256: manifest.database.sha256,
    mediaSha256: manifest.media.sha256,
  }),
);

// ---------------------------------------------------------------------------
// Retention (opt-in, guarded)
// ---------------------------------------------------------------------------

if (keep !== null) {
  for (const dir of [dbOutDir, mediaOutDir]) {
    if (!existsSync(dir)) continue;
    const plan = applyRetention(dir, keep, { apply: prune });
    console.log(
      `[backup-all] retention ${prune ? "applied" : "dry-run"} (keep=${keep}) in ${dir}: ` +
        `keep ${plan.keepFiles.length}, prune ${plan.pruneFiles.length}, skipped ${plan.skipped.length}.`,
    );
    for (const s of plan.skipped) console.log(`  skipped ${s.file}: ${s.reason}`);
  }
}

// The S3 client's keep-alive pool can hold the event loop open — exit explicitly.
process.exit(0);
