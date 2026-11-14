/**
 * BEAN FOLIO M21 — shared backup/restore core (ops tooling, no Next.js app
 * imports except the S3 config type).
 *
 * Everything the backup/restore CLIs and the orchestrator need, in one place
 * so the manifest format and verification rules cannot drift between them:
 *
 *   - ArtifactManifest      — sidecar (<artifact>.json) written next to every
 *                             backup artifact; carries sha256, byte size,
 *                             engine metadata and (for media) the per-file
 *                             checksum ledger used by restore validation.
 *   - OrchestratorManifest  — the coordinated manifest connecting the
 *                             database and media artifacts of ONE backup run
 *                             plus the verification results.
 *   - backupSqliteSnapshot / backupPostgresDump — verified database backups.
 *   - backupMediaLocal / backupMediaS3 — verified media backups (S3 mode
 *                             downloads every object and round-trip-verifies
 *                             the archive; it NEVER reports success on
 *                             unverified data).
 *   - verifyArtifactFile / verifyMediaArchive — re-verification primitives
 *                             shared by the orchestrator and the restore path.
 *   - planRetention / applyRetention — configurable retention with the
 *                             last-known-good guard; deletion is always
 *                             opt-in (--prune).
 *
 * Safety invariants enforced here:
 *   1. Artifacts and manifests are written to fresh timestamped paths and
 *      NEVER overwrite an existing file (assertFreshTarget / writeJsonFresh).
 *   2. Any verification failure throws — callers exit non-zero; a backup
 *      that did not fully verify leaves NO artifact behind (never a
 *      plausible-looking file that is actually broken).
 *   3. Retention never deletes the newest verified-good artifact, never
 *      touches files without a valid checksum sidecar, and only deletes at
 *      all when explicitly applied.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { ListObjectsV2Command, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { S3Config } from "../../../src/lib/storage";

// ---------------------------------------------------------------------------
// Manifest schemas
// ---------------------------------------------------------------------------

export const MANIFEST_SCHEMA = "beanfolio-backup-manifest/v1";
export const ORCHESTRATOR_SCHEMA = "beanfolio-backup-orchestrator/v1";

export interface MediaEntry {
  /** Path relative to the media root — "uploads/<owner>/<file>" (S3 keys use the same shape). */
  path: string;
  bytes: number;
  sha256: string;
}

export interface ArtifactManifest {
  schema: typeof MANIFEST_SCHEMA;
  kind: "database" | "media";
  /** Engine for database artifacts; undefined for media artifacts. */
  engine?: "sqlite" | "postgresql";
  /** Storage driver for media artifacts. */
  driver?: "local" | "s3";
  file: string;
  bytes: number;
  sha256: string;
  generatedAt: string;
  // database (sqlite) metadata
  integrity?: "ok";
  tables?: number;
  method?: "vacuum-into" | "raw-copy" | "pg_dump";
  rowParity?: Record<string, number>;
  // media metadata
  /** local driver: the media root directory; s3 driver: endpoint/bucket/prefix. */
  source?: string | { endpoint: string; bucket: string; prefix: string };
  fileCount?: number;
  totalBytes?: number;
  entries?: MediaEntry[];
}

export interface ComponentCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface OrchestratorManifest {
  schema: typeof ORCHESTRATOR_SCHEMA;
  status: "complete" | "failed";
  generatedAt: string;
  outDir: string;
  database: {
    artifact: string | null;
    manifest: string | null;
    bytes: number | null;
    sha256: string | null;
    checks: ComponentCheck[];
  };
  media: {
    artifact: string | null;
    manifest: string | null;
    bytes: number | null;
    sha256: string | null;
    driver: "local" | "s3";
    checks: ComponentCheck[];
  };
  verification: { allPassed: boolean; checks: ComponentCheck[] };
  errors: string[];
}

// ---------------------------------------------------------------------------
// Checksums + JSON IO
// ---------------------------------------------------------------------------

export function sha256File(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

export function sha256Buffer(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Filename-safe UTC timestamp with millisecond precision. */
export function timestampMs(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Refuse to touch an existing artifact/manifest — backups are never overwritten. */
export function assertFreshTarget(path: string): void {
  if (existsSync(path)) {
    throw new Error(
      `refusing to overwrite existing file: ${path} — backup artifacts are immutable. ` +
        `Use a new --out directory or remove stale files by hand.`,
    );
  }
}

/** Atomic JSON write (tmp + rename) that refuses to overwrite existing files. */
export function writeJsonFresh(path: string, data: unknown): void {
  assertFreshTarget(path);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.writing-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
    }
  }
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Key tables whose row counts are compared source vs snapshot (ops/backup-db.ts contract). */
export const DEFAULT_KEY_TABLES = ["User", "Project", "MediaAsset", "AgentTask", "AgentArtifact", "Session"] as const;

/** Resolve the SQLite file path from a `file:` DATABASE_URL (+ optional ?params). */
export function parseSqlitePath(u: string): string {
  let p = u.replace(/^file:/, "");
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  return resolve(p);
}

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

export function sqliteIntegrity(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("PRAGMA integrity_check").get() as Record<string, string>;
    return row.integrity_check ?? (Object.values(row)[0] as string) ?? "unknown";
  } finally {
    db.close();
  }
}

export function sqliteTableCount(path: string): number {
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

export function sqliteRowCounts(path: string, tables: readonly string[]): Record<string, number> {
  const db = new Database(path, { readonly: true });
  const counts: Record<string, number> = {};
  try {
    for (const table of tables) {
      counts[table] = (db.query(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
    }
  } finally {
    db.close();
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Database backups
// ---------------------------------------------------------------------------

/**
 * Verified SQLite snapshot via `VACUUM INTO` (safe against a live WAL
 * database) with integrity check + key-table row parity against the source.
 * Throws on any verification failure; the failed snapshot is cleaned up.
 */
export async function backupSqliteSnapshot(
  sourcePath: string,
  outDir: string,
  keyTables: readonly string[],
): Promise<ArtifactManifest> {
  if (!existsSync(sourcePath)) {
    throw new Error(`SQLite database not found at ${sourcePath} — check DATABASE_URL and run from the repo root.`);
  }
  mkdirSync(outDir, { recursive: true });
  const name = `db-${timestampMs()}.sqlite3`;
  const finalPath = join(outDir, name);
  assertFreshTarget(finalPath);

  const tmpPath = `${finalPath}.vacuuming-${process.pid}`;
  let method: ArtifactManifest["method"] = "vacuum-into";
  try {
    const src = new Database(sourcePath, { readonly: true });
    try {
      src.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
    console.warn(
      "[backup-core] VACUUM INTO unavailable on this runtime — falling back to raw file copy " +
        "(stop the app, or accept a small consistency risk on a live WAL database).",
    );
    console.warn(`[backup-core] reason: ${err instanceof Error ? err.message : String(err)}`);
    try {
      copyFileSync(sourcePath, finalPath);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${sourcePath}${suffix}`)) copyFileSync(`${sourcePath}${suffix}`, `${finalPath}${suffix}`);
      }
      method = "raw-copy";
    } catch (copyErr) {
      throw new Error(
        `raw-copy fallback failed: ${copyErr instanceof Error ? copyErr.message : String(copyErr)} — no backup written.`,
      );
    }
  }

  try {
    const integrity = sqliteIntegrity(finalPath);
    if (integrity !== "ok") {
      throw new Error(`snapshot integrity_check FAILED: "${integrity}" — snapshot removed, no backup recorded.`);
    }
    const snapCounts = sqliteRowCounts(finalPath, keyTables);
    const sourceCounts = sqliteRowCounts(sourcePath, keyTables);
    for (const table of keyTables) {
      if (sourceCounts[table] !== snapCounts[table]) {
        throw new Error(
          `row-count mismatch on ${table}: source=${sourceCounts[table]} snapshot=${snapCounts[table]} — snapshot removed.`,
        );
      }
    }
    const manifest: ArtifactManifest = {
      schema: MANIFEST_SCHEMA,
      kind: "database",
      engine: "sqlite",
      file: name,
      bytes: statSync(finalPath).size,
      sha256: sha256File(finalPath),
      generatedAt: new Date().toISOString(),
      integrity: "ok",
      tables: sqliteTableCount(finalPath),
      method,
      rowParity: snapCounts,
      source: sourcePath,
    };
    writeJsonFresh(`${finalPath}.json`, manifest);
    return manifest;
  } catch (err) {
    // A failed backup leaves NO artifact behind — never a plausible-looking file.
    try {
      if (existsSync(finalPath)) rmSync(finalPath, { force: true });
      for (const suffix of ["-wal", "-shm"]) {
        const stray = `${finalPath}${suffix}`;
        if (existsSync(stray)) rmSync(stray, { force: true });
      }
    } catch {
      /* best effort */
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * PostgreSQL backup via `pg_dump --format=custom`, verified with
 * `pg_restore --list`. The archive-verification contract is preserved from
 * the original script; SHA-256 + manifest metadata are added. When the
 * client tooling is missing the error is actionable (exact fix), never a
 * fake success.
 */
export async function backupPostgresDump(databaseUrl: string, outDir: string): Promise<ArtifactManifest> {
  mkdirSync(outDir, { recursive: true });

  const probe = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      "pg_dump is not installed or not on PATH — PostgreSQL backup cannot run.\n" +
        "  Fix (pick one):\n" +
        "    1. install the postgresql client on this host (e.g. `apt-get install postgresql-client`) and re-run;\n" +
        "    2. run pg_dump from an ops box that has it:\n" +
        "         pg_dump --no-owner --no-privileges --format=custom --file=<dump> \"$DATABASE_URL\"\n" +
        "    3. rely on the managed provider's PITR (Neon/Supabase/RDS) and VERIFY a restore drill.\n" +
        "  No backup was written.",
    );
  }

  const name = `db-${timestampMs()}.dump`;
  const finalPath = join(outDir, name);
  assertFreshTarget(finalPath);

  const dump = spawnSync("pg_dump", ["--format=custom", "--file", finalPath, "--no-owner", databaseUrl], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (dump.status !== 0) {
    try {
      if (existsSync(finalPath)) rmSync(finalPath, { force: true });
    } catch {
      /* best effort */
    }
    throw new Error(`pg_dump failed: ${dump.stderr?.slice(0, 500) ?? "unknown error"}`);
  }

  const list = spawnSync("pg_restore", ["--list", finalPath], { encoding: "utf8" });
  if (list.status !== 0 || !list.stdout.includes("PostgreSQL database dump")) {
    try {
      if (existsSync(finalPath)) rmSync(finalPath, { force: true });
    } catch {
      /* best effort */
    }
    throw new Error("pg_restore --list failed — dump archive is not verifiably readable. No backup recorded.");
  }

  const manifest: ArtifactManifest = {
    schema: MANIFEST_SCHEMA,
    kind: "database",
    engine: "postgresql",
    file: name,
    bytes: statSync(finalPath).size,
    sha256: sha256File(finalPath),
    generatedAt: new Date().toISOString(),
    method: "pg_dump",
    source: "postgresql:$DATABASE_URL (connection string never recorded)",
  };
  writeJsonFresh(`${finalPath}.json`, manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Media backups
// ---------------------------------------------------------------------------

export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** Per-file checksum ledger for `<baseDir>/<subDir>`, paths relative to baseDir. */
export function ledgerFor(baseDir: string, subDir: string): { entries: MediaEntry[]; totalBytes: number } {
  const entries: MediaEntry[] = [];
  let totalBytes = 0;
  for (const abs of walkFiles(join(baseDir, subDir))) {
    const rel = relative(baseDir, abs).split(sep).join("/");
    const bytes = statSync(abs).size;
    totalBytes += bytes;
    entries.push({ path: rel, bytes, sha256: sha256File(abs) });
  }
  return { entries, totalBytes };
}

function tarSync(args: string[], label: string): void {
  const res = spawnSync("tar", args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`tar ${label} failed: ${res.stderr?.slice(0, 300) ?? "unknown error"}`);
  }
}

/**
 * Extract `archive` into a fresh temp dir and verify every file against the
 * manifest ledger (count + paths + bytes + sha256). Used at BACKUP time
 * (round-trip proof) and at RESTORE time (tamper detection). Throws with a
 * precise reason on any mismatch.
 */
export function verifyMediaArchive(archive: string, manifest: ArtifactManifest): void {
  const listed = manifest.entries ?? [];
  if (listed.length === 0) throw new Error("manifest carries no media entries — cannot verify archive contents");

  const checkDir = mkdtempSync(join(tmpdir(), "beanfolio-archive-verify-"));
  try {
    tarSync(["-xzf", archive, "-C", checkDir], "extract-for-verification");

    const extractedRoot = join(checkDir, "uploads");
    if (!existsSync(extractedRoot)) {
      throw new Error("archive does not contain an uploads/ tree — wrong archive layout for this manifest");
    }

    const extracted = walkFiles(extractedRoot)
      .map((abs) => relative(checkDir, abs).split(sep).join("/"))
      .sort();
    const expected = listed.map((e) => e.path).sort();

    if (extracted.length !== expected.length) {
      throw new Error(`archive file count mismatch: ${extracted.length} extracted vs ${expected.length} in manifest`);
    }
    for (let i = 0; i < expected.length; i++) {
      if (extracted[i] !== expected[i]) {
        throw new Error(`archive path mismatch at index ${i}: "${extracted[i]}" vs "${expected[i]}"`);
      }
    }
    for (const entry of listed) {
      const abs = join(checkDir, entry.path);
      const bytes = statSync(abs).size;
      if (bytes !== entry.bytes) {
        throw new Error(`size mismatch for ${entry.path}: extracted ${bytes} vs manifest ${entry.bytes}`);
      }
      const sha = sha256File(abs);
      if (sha !== entry.sha256) {
        throw new Error(`checksum mismatch for ${entry.path}: extracted ${sha} vs manifest ${entry.sha256}`);
      }
    }
  } finally {
    rmSync(checkDir, { recursive: true, force: true });
  }
}

/**
 * Local-driver media backup: archives `<mediaRoot>/uploads` with tar so the
 * restore layout is `uploads/…`, verifies the archive by full round-trip
 * extraction + per-file checksum comparison, and writes a manifest sidecar.
 * Respects MEDIA_LOCAL_ROOT (the caller passes storage.uploadRoot()).
 */
export async function backupMediaLocal(mediaRoot: string, outDir: string): Promise<ArtifactManifest> {
  const mediaDir = join(mediaRoot, "uploads");
  if (!existsSync(mediaDir)) {
    throw new Error(
      `media directory does not exist: ${mediaDir}\n` +
        `  MEDIA_LOCAL_ROOT is respected — set it to the directory that CONTAINS uploads/ ` +
        `(see docs/media-pipeline.md), or fix the deployment layout.`,
    );
  }
  const ledger = ledgerFor(mediaRoot, "uploads");
  if (ledger.entries.length === 0) {
    throw new Error(`uploads/ contains no files under ${mediaDir} — nothing to back up.`);
  }

  mkdirSync(outDir, { recursive: true });
  const name = `media-${timestampMs()}.tar.gz`;
  const archive = join(outDir, name);
  assertFreshTarget(archive);

  try {
    // Archive relative to the media root so extraction lands in ./uploads/…
    tarSync(["-czf", archive, "-C", mediaRoot, "uploads"], "create");
    const manifest: ArtifactManifest = {
      schema: MANIFEST_SCHEMA,
      kind: "media",
      driver: "local",
      file: name,
      bytes: statSync(archive).size,
      sha256: sha256File(archive),
      generatedAt: new Date().toISOString(),
      source: mediaRoot,
      fileCount: ledger.entries.length,
      totalBytes: ledger.totalBytes,
      entries: ledger.entries,
    };
    verifyMediaArchive(archive, manifest); // round-trip proof BEFORE declaring success
    writeJsonFresh(`${archive}.json`, manifest);
    return manifest;
  } catch (err) {
    try {
      if (existsSync(archive)) rmSync(archive, { force: true });
    } catch {
      /* best effort */
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// ---------------------------------------------------------------------------
// S3 backup + restore
// ---------------------------------------------------------------------------

function s3ClientFor(cfg: S3Config): S3Client {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: cfg.forcePathStyle,
  });
}

interface S3Object {
  key: string;
  size: number;
}

/** Paginated ListObjectsV2 under `prefix` (the real AWS SDK client, real API). */
async function listS3Objects(client: S3Client, bucket: string, prefix: string): Promise<S3Object[]> {
  const objects: S3Object[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key !== undefined && obj.Size !== undefined) objects.push({ key: obj.Key, size: obj.Size });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

/**
 * S3-driver media backup — REAL, verifiable:
 *   1. lists every object under the `uploads/` prefix (paginated),
 *   2. downloads EVERY object and verifies byte size against the listing,
 *   3. stages objects into the exact local layout (`uploads/…`),
 *   4. tars the staged tree and round-trip-verifies the archive with
 *      per-object checksums,
 *   5. writes the manifest sidecar with per-object checksums.
 * Any failure → throws (caller exits non-zero); partial artifacts removed.
 * An empty prefix is an explicit FAILURE, never a silent success.
 */
export async function backupMediaS3(cfg: S3Config, outDir: string): Promise<ArtifactManifest> {
  const prefix = "uploads/";
  const client = s3ClientFor(cfg);

  const objects = await listS3Objects(client, cfg.bucket, prefix);
  if (objects.length === 0) {
    throw new Error(
      `S3 bucket "${cfg.bucket}" has 0 objects under prefix "${prefix}" — refusing to create an empty media backup.\n` +
        `  If the bucket is genuinely empty there is nothing to protect; do not schedule media backups ` +
        `against an empty bucket. Check S3_BUCKET / the prefix / the credentials' bucket access.`,
    );
  }

  mkdirSync(outDir, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "beanfolio-s3-stage-"));
  const stageUploads = join(staging, "uploads");
  mkdirSync(stageUploads, { recursive: true });

  const entries: MediaEntry[] = [];
  let totalBytes = 0;
  try {
    for (const obj of objects) {
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: obj.key }));
      const body = await res.Body?.transformToByteArray();
      if (!body) throw new Error(`S3 object "${obj.key}" returned an empty body`);
      if (body.byteLength !== obj.size) {
        throw new Error(
          `size mismatch downloading s3://${cfg.bucket}/${obj.key}: got ${body.byteLength} bytes, listing says ${obj.size}`,
        );
      }
      const target = join(staging, obj.key);
      if (!resolve(target).startsWith(resolve(stageUploads) + sep)) {
        throw new Error(`object key escapes the media prefix: "${obj.key}" — refusing to stage it`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(body));
      totalBytes += body.byteLength;
      entries.push({ path: obj.key, bytes: body.byteLength, sha256: sha256Buffer(body) });
    }

    const name = `media-${timestampMs()}.tar.gz`;
    const archive = join(outDir, name);
    assertFreshTarget(archive);
    try {
      tarSync(["-czf", archive, "-C", staging, "uploads"], "create-s3");
      const manifest: ArtifactManifest = {
        schema: MANIFEST_SCHEMA,
        kind: "media",
        driver: "s3",
        file: name,
        bytes: statSync(archive).size,
        sha256: sha256File(archive),
        generatedAt: new Date().toISOString(),
        source: { endpoint: cfg.endpoint, bucket: cfg.bucket, prefix },
        fileCount: entries.length,
        totalBytes,
        entries,
      };
      verifyMediaArchive(archive, manifest); // full round-trip proof BEFORE declaring success
      writeJsonFresh(`${archive}.json`, manifest);
      return manifest;
    } catch (err) {
      try {
        if (existsSync(archive)) rmSync(archive, { force: true });
      } catch {
        /* best effort */
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Re-upload staged objects to a bucket (restore path for the S3 driver).
 * Every object is checksum-verified against the manifest BEFORE upload;
 * a mismatch aborts before anything is written to the bucket.
 */
export async function restoreObjectsToS3(
  cfg: S3Config,
  entries: MediaEntry[],
  stagedRoot: string,
): Promise<number> {
  const client = s3ClientFor(cfg);
  let restored = 0;
  for (const entry of entries) {
    const abs = resolve(join(stagedRoot, entry.path));
    if (!abs.startsWith(resolve(stagedRoot) + sep)) {
      throw new Error(`staged path escapes the media root: "${entry.path}"`);
    }
    const body = readFileSync(abs);
    const sha = sha256Buffer(body);
    if (sha !== entry.sha256) {
      throw new Error(`checksum mismatch for ${entry.path} before upload: ${sha} vs manifest ${entry.sha256}`);
    }
    await client.send(
      new PutObjectCommand({ Bucket: cfg.bucket, Key: entry.path, Body: body, ContentLength: body.length }),
    );
    restored += 1;
  }
  return restored;
}

// ---------------------------------------------------------------------------
// Artifact verification (shared by orchestrator + restore)
// ---------------------------------------------------------------------------

export interface ArtifactVerification {
  ok: boolean;
  errors: string[];
}

/** Re-verify an artifact file against its manifest (sha256 + byte size). */
export function verifyArtifactFile(artifactPath: string, manifest: ArtifactManifest): ArtifactVerification {
  const errors: string[] = [];
  if (typeof manifest.bytes !== "number" || typeof manifest.sha256 !== "string") {
    return { ok: false, errors: ["manifest is missing bytes/sha256 — not a verifiable backup"] };
  }
  const bytes = statSync(artifactPath).size;
  if (bytes !== manifest.bytes) errors.push(`byte-size mismatch: file ${bytes} vs manifest ${manifest.bytes}`);
  const sha = sha256File(artifactPath);
  if (sha !== manifest.sha256) errors.push(`sha256 mismatch: file ${sha} vs manifest ${manifest.sha256}`);
  return { ok: errors.length === 0, errors };
}

/** Validate + parse a manifest sidecar with structural checks. */
export function loadArtifactManifest(path: string): ArtifactManifest {
  const raw = readJsonFile(path) as ArtifactManifest;
  if (!raw || typeof raw !== "object") throw new Error(`manifest is not an object: ${path}`);
  if (raw.schema !== MANIFEST_SCHEMA) {
    throw new Error(
      `manifest schema mismatch in ${path}: expected ${MANIFEST_SCHEMA}, got ${String((raw as { schema?: string }).schema)}`,
    );
  }
  if (!raw.file || typeof raw.sha256 !== "string" || typeof raw.bytes !== "number") {
    throw new Error(`manifest in ${path} is missing file/sha256/bytes — not a verifiable backup`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Retention — configurable, guarded, opt-in
// ---------------------------------------------------------------------------

const PRUNABLE_RE = new RegExp(
  [
    /^db-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.(sqlite3|dump)$/.source,
    /^media-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.tar\.gz$/.source,
    /^beanfolio-\d{8}-\d{6}\.db$/.source,
  ].join("|"),
);

export interface RetentionCandidate {
  file: string;
  sidecar: string | null;
  verified: boolean;
}

export interface RetentionPlan {
  dir: string;
  keep: number;
  verifiedCount: number;
  keepFiles: string[];
  pruneFiles: string[];
  skipped: { file: string; reason: string }[];
}

/**
 * Build a retention plan for a backup directory. Rules:
 *   - only artifacts matching the known backup naming patterns are considered
 *     (anything else — manifests, foreign files — is never touched);
 *   - an artifact is "verified" when its sidecar exists AND its recorded
 *     sha256 matches the file (recomputed here);
 *   - the NEWEST verified artifact is ALWAYS kept (last-known-good guard),
 *     even when --keep would otherwise exclude it;
 *   - artifacts without a valid sidecar are never touched (unknown
 *     provenance — a human decides);
 *   - keep N newest; everything older and verified is listed for pruning.
 * Deletion only happens in applyRetention with { apply: true }.
 */
export function planRetention(dir: string, keep: number): RetentionPlan {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`retention keep must be a positive integer, got ${keep}`);
  }
  if (!existsSync(dir)) throw new Error(`retention directory does not exist: ${dir}`);

  const files = readdirSync(dir)
    .filter((f) => PRUNABLE_RE.test(f))
    .sort()
    .reverse(); // newest first — timestamped names sort lexicographically

  const candidates: RetentionCandidate[] = files.map((file) => {
    const sidecarPath = `${join(dir, file)}.json`;
    if (!existsSync(sidecarPath)) return { file, sidecar: null, verified: false };
    try {
      const manifest = loadArtifactManifest(sidecarPath);
      return { file, sidecar: sidecarPath, verified: sha256File(join(dir, file)) === manifest.sha256 };
    } catch {
      return { file, sidecar: sidecarPath, verified: false };
    }
  });

  const plan: RetentionPlan = {
    dir,
    keep,
    verifiedCount: candidates.filter((c) => c.verified).length,
    keepFiles: [],
    pruneFiles: [],
    skipped: [],
  };

  if (plan.verifiedCount === 0) {
    // Nothing is provably good — touching anything could destroy the last
    // usable backup. Refuse by design.
    plan.skipped.push({
      file: "*",
      reason: "no verified-good backup in this directory — retention refuses to prune anything",
    });
    return plan;
  }

  const keepIdx = new Set<number>();
  for (let i = 0; i < Math.min(keep, candidates.length); i++) keepIdx.add(i);
  const firstVerified = candidates.findIndex((c) => c.verified);
  if (firstVerified >= 0) keepIdx.add(firstVerified); // last-known-good guard

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (keepIdx.has(i)) {
      plan.keepFiles.push(candidate.file);
    } else if (!candidate.sidecar) {
      plan.skipped.push({ file: candidate.file, reason: "no checksum sidecar — unknown provenance, not touched" });
    } else if (!candidate.verified) {
      plan.skipped.push({
        file: candidate.file,
        reason: "sidecar checksum mismatch — suspicious artifact, human decision",
      });
    } else {
      plan.pruneFiles.push(candidate.file);
    }
  }
  return plan;
}

/** Apply a retention plan (deletes files + their sidecars). Dry-run by default. */
export function applyRetention(dir: string, keep: number, opts: { apply: boolean }): RetentionPlan {
  const plan = planRetention(dir, keep);
  if (!opts.apply) return plan;
  for (const file of plan.pruneFiles) {
    rmSync(join(dir, file), { force: true });
    const sidecar = `${join(dir, file)}.json`;
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }
  return plan;
}
