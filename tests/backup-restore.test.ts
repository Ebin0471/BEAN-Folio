/// <reference types="bun-types" />
/**
 * M21 — scripts/ops/restore-from-backup.ts regression tests.
 *
 * Covers the acceptance criteria "Invalid backup rejected", "Checksum
 * mismatch detected", "Restore tested in an isolated environment" and
 * "Never restore automatically over production data":
 *
 *   - staging drill: valid backup → restored DB (integrity ok) + media
 *     (per-file checksums verified) + pre-restore snapshot, live untouched
 *   - tampered database artifact → INVALID BACKUP REJECTED (exit 1)
 *   - tampered media archive → INVALID BACKUP REJECTED (exit 1)
 *   - failed-status manifest → REFUSED (exit 2)
 *   - live restore without --confirm-live / --yes → REFUSED (exit 2),
 *     live files byte-identical afterwards, no .bak created
 *   - live local drill: DB swapped with .bak preservation, media restored
 *     from the verified staging tree
 *   - live S3 drill: objects re-uploaded to the bucket, checksum-verified
 *
 * All live targets are TEMP paths (DATABASE_URL / MEDIA_LOCAL_ROOT) — the
 * real db/custom.db, uploads/ and /home/z/beanfolio-backups/ are untouched.
 *
 * Run: bun test tests/backup-restore.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { startS3CompatServer, type S3Fixture } from "./helpers/s3-compat-server";

const ROOT = resolve(import.meta.dir, "..");
const ORCHESTRATOR = join(ROOT, "scripts", "ops", "backup-all.ts");
const RESTORE = join(ROOT, "scripts", "ops", "restore-from-backup.ts");
const MANIFEST_SCHEMA = "beanfolio-backup-manifest/v1";

const tempDirs: string[] = [];
const servers: S3Fixture[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const s of servers) s.stop();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** ASYNC spawn — the S3 tests share the process with a live fixture server. */
async function runScript(script: string, args: string[], env: Record<string, string>): Promise<SpawnResult> {
  const fullEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const k of ["MEDIA_STORAGE_DRIVER", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
    delete fullEnv[k];
  }
  Object.assign(fullEnv, env);
  const proc = Bun.spawn([process.execPath, script, ...args], {
    cwd: ROOT,
    env: fullEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function createSqliteFixture(dbPath: string, userRows: number): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new Database(dbPath);
  try {
    for (const table of ["User", "Project", "MediaAsset", "AgentTask", "AgentArtifact", "Session"]) {
      db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY)`);
    }
    const stmt = db.prepare('INSERT INTO "User" (id) VALUES (?)');
    for (let i = 0; i < userRows; i++) stmt.run(`user-${i}`);
  } finally {
    db.close();
  }
}

function userCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query('SELECT COUNT(*) AS c FROM "User"').get() as { c: number }).c;
  } finally {
    db.close();
  }
}

function seedMedia(root: string): void {
  mkdirSync(join(root, "uploads", "owner-1"), { recursive: true });
  writeFileSync(join(root, "uploads", "owner-1", "live-media.txt"), "current live media");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function latestManifestPath(outDir: string): string {
  const manifests = readdirSync(outDir).filter((f) => f.startsWith("backup-manifest-") && f.endsWith(".json")).sort();
  expect(manifests.length).toBeGreaterThanOrEqual(1);
  return join(outDir, manifests[manifests.length - 1]!);
}

describe("restore-from-backup.ts (M21)", () => {
  test("staging drill: isolated restore verifies DB integrity + media checksums; live untouched", async () => {
    const work = makeTempDir("beanfolio-restore-staging-");
    const liveDb = join(work, "live.sqlite3");
    createSqliteFixture(liveDb, 11);
    const liveMediaRoot = makeTempDir("beanfolio-restore-media-");
    seedMedia(liveMediaRoot);
    const backupOut = join(work, "backup");
    const staging = join(work, "drill");

    const backup = await runScript(ORCHESTRATOR, ["--out", backupOut], {
      DATABASE_URL: `file:${liveDb}`,
      MEDIA_STORAGE_DRIVER: "local",
      MEDIA_LOCAL_ROOT: liveMediaRoot,
    });
    expect(backup.exitCode).toBe(0);
    const liveDbBefore = sha256(liveDb);

    const restore = await runScript(RESTORE, ["--manifest", latestManifestPath(backupOut), "--staging", staging], {
      DATABASE_URL: `file:${liveDb}`,
      MEDIA_STORAGE_DRIVER: "local",
      MEDIA_LOCAL_ROOT: liveMediaRoot,
    });
    expect(restore.exitCode).toBe(0);
    expect(restore.stdout).toContain("STAGING DRILL COMPLETE");
    expect(restore.stdout).toContain("all checksums match the manifest ledger");

    // Staging contains: pre-restore snapshot + restored db + restored media.
    expect(existsSync(join(staging, "pre-restore", "db"))).toBe(true);
    expect(existsSync(join(staging, "pre-restore", "media"))).toBe(true);
    const restoredDbDir = join(staging, "restored", "database");
    const restoredDb = readdirSync(restoredDbDir).find((f) => f.endsWith(".sqlite3"));
    expect(restoredDb).toBeDefined();
    expect(userCount(join(restoredDbDir, restoredDb!))).toBe(11);
    expect(existsSync(join(staging, "restored", "media", "uploads", "owner-1"))).toBe(true);

    // LIVE UNTOUCHED: byte-identical, no .bak created.
    expect(sha256(liveDb)).toBe(liveDbBefore);
    expect(readdirSync(work).some((f) => f.includes(".bak-"))).toBe(false);
    expect(readFileSync(join(liveMediaRoot, "uploads", "owner-1", "live-media.txt"), "utf8")).toBe("current live media");
  });

  test("tampered database artifact: INVALID BACKUP REJECTED before anything is touched", async () => {
    const work = makeTempDir("beanfolio-restore-tamperdb-");
    const liveDb = join(work, "live.sqlite3");
    createSqliteFixture(liveDb, 3);
    const liveMediaRoot = makeTempDir("beanfolio-restore-tmedia-");
    seedMedia(liveMediaRoot);
    const backupOut = join(work, "backup");

    await runScript(ORCHESTRATOR, ["--out", backupOut], {
      DATABASE_URL: `file:${liveDb}`,
      MEDIA_STORAGE_DRIVER: "local",
      MEDIA_LOCAL_ROOT: liveMediaRoot,
    });
    const manifestPath = latestManifestPath(backupOut);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const dbArtifact = join(manifest.outDir, manifest.database.artifact);

    const bytes = readFileSync(dbArtifact);
    bytes[200] ^= 0xff;
    writeFileSync(dbArtifact, bytes);

    const liveDbBefore = sha256(liveDb);
    const restore = await runScript(RESTORE, ["--manifest", manifestPath, "--staging", join(work, "drill")], {
      DATABASE_URL: `file:${liveDb}`,
      MEDIA_STORAGE_DRIVER: "local",
      MEDIA_LOCAL_ROOT: liveMediaRoot,
    });
    expect(restore.exitCode).toBe(1);
    expect(restore.stderr).toContain("INVALID BACKUP REJECTED");
    expect(sha256(liveDb)).toBe(liveDbBefore); // live untouched
    expect(existsSync(join(work, "drill"))).toBe(false); // staging never created
  });

  test("tampered media archive: checksum mismatch detected, restore aborted", async () => {
    const work = makeTempDir("beanfolio-restore-tampermedia-");
    const liveDb = join(work, "live.sqlite3");
    createSqliteFixture(liveDb, 3);
    const liveMediaRoot = makeTempDir("beanfolio-restore-tmedia2-");
    seedMedia(liveMediaRoot);
    const backupOut = join(work, "backup");

    await runScript(ORCHESTRATOR, ["--out", backupOut], {
      DATABASE_URL: `file:${liveDb}`,
      MEDIA_STORAGE_DRIVER: "local",
      MEDIA_LOCAL_ROOT: liveMediaRoot,
    });
    const manifestPath = latestManifestPath(backupOut);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const mediaArtifact = join(manifest.outDir, manifest.media.artifact);

    // Corrupt the archive contents (the recorded archive checksum will no
    // longer match → verification must reject BEFORE extraction/copying).
    const bytes = readFileSync(mediaArtifact);
    bytes[bytes.length - 30] ^= 0xff;
    writeFileSync(mediaArtifact, bytes);

    const restore = await runScript(RESTORE, ["--manifest", manifestPath, "--staging", join(work, "drill")], {
      DATABASE_URL: `file:${liveDb}`,
      MEDIA_STORAGE_DRIVER: "local",
      MEDIA_LOCAL_ROOT: liveMediaRoot,
    });
    expect(restore.exitCode).toBe(1);
    expect(restore.stderr).toContain("INVALID BACKUP REJECTED");
    // Pre-restore snapshot may exist (it runs before the artifact check is
    // complete), but nothing was restored over the live system.
    expect(readFileSync(join(liveMediaRoot, "uploads", "owner-1", "live-media.txt"), "utf8")).toBe("current live media");
  });

  test("failed-status manifest: REFUSED (exit 2)", async () => {
    const work = makeTempDir("beanfolio-restore-failedman-");
    const liveMediaRoot = makeTempDir("beanfolio-restore-fmedia-");
    seedMedia(liveMediaRoot);
    const backupOut = join(work, "backup");

    // Force a FAILED backup: media mode S3-incomplete.
    const backup = await runScript(ORCHESTRATOR, ["--out", backupOut], {
      DATABASE_URL: "",
      MEDIA_LOCAL_ROOT: liveMediaRoot,
      S3_ENDPOINT: "http://127.0.0.1:9",
    });
    expect(backup.exitCode).toBe(1);
    const manifestPath = latestManifestPath(backupOut);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.status).toBe("failed");

    const restore = await runScript(RESTORE, ["--manifest", manifestPath, "--staging", join(work, "drill")], {
      MEDIA_STORAGE_DRIVER: "local",
      MEDIA_LOCAL_ROOT: liveMediaRoot,
    });
    expect(restore.exitCode).toBe(2);
    expect(restore.stderr).toContain('manifest status is "failed"');
    expect(existsSync(join(work, "drill"))).toBe(false);
  });

  test("confirmation flags: without --confirm-live → staging drill; --confirm-live without --yes → REFUSED", async () => {
    const work = makeTempDir("beanfolio-restore-refuse-");
    const liveDb = join(work, "live.sqlite3");
    createSqliteFixture(liveDb, 7);
    const liveMediaRoot = makeTempDir("beanfolio-restore-rmedia-");
    seedMedia(liveMediaRoot);
    const backupOut = join(work, "backup");

    await runScript(ORCHESTRATOR, ["--out", backupOut], {
      DATABASE_URL: `file:${liveDb}`,
      MEDIA_STORAGE_DRIVER: "local",
      MEDIA_LOCAL_ROOT: liveMediaRoot,
    });
    const manifestPath = latestManifestPath(backupOut);
    const liveDbBefore = sha256(liveDb);

    // Scenario A: --yes WITHOUT --confirm-live → the script performs the
    // STAGING drill only (safe default), never touches production.
    const stagingOnly = await runScript(
      RESTORE,
      ["--manifest", manifestPath, "--staging", join(work, "drill-a"), "--yes"],
      {
        DATABASE_URL: `file:${liveDb}`,
        MEDIA_STORAGE_DRIVER: "local",
        MEDIA_LOCAL_ROOT: liveMediaRoot,
      },
    );
    expect(stagingOnly.exitCode).toBe(0);
    expect(stagingOnly.stdout).toContain("STAGING DRILL COMPLETE");
    expect(sha256(liveDb)).toBe(liveDbBefore);
    expect(readdirSync(work).filter((f) => f.includes(".bak-")).length).toBe(0);

    // Scenario B: --confirm-live WITHOUT --yes → REFUSED before any swap.
    const refused = await runScript(
      RESTORE,
      ["--manifest", manifestPath, "--staging", join(work, "drill-b"), "--confirm-live"],
      {
        DATABASE_URL: `file:${liveDb}`,
        MEDIA_STORAGE_DRIVER: "local",
        MEDIA_LOCAL_ROOT: liveMediaRoot,
      },
    );
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("requires BOTH --confirm-live and --yes");
    expect(sha256(liveDb)).toBe(liveDbBefore);
    expect(readdirSync(work).filter((f) => f.includes(".bak-")).length).toBe(0);
  });

  test("live local drill: DB swapped with .bak preservation + media restored from verified staging", async () => {
    const work = makeTempDir("beanfolio-restore-live-");
    // Live DB has 2 users; the BACKUP DB has 9 — after the live restore the
    // live DB must contain 9 and the .bak must contain the original 2.
    const liveDb = join(work, "live.sqlite3");
    createSqliteFixture(liveDb, 2);
    const backupSourceDb = join(work, "backup-source.sqlite3");
    createSqliteFixture(backupSourceDb, 9);
    const liveMediaRoot = makeTempDir("beanfolio-restore-livemedia-");
    seedMedia(liveMediaRoot);
    const backupMediaRoot = makeTempDir("beanfolio-restore-bmedia-");
    mkdirSync(join(backupMediaRoot, "uploads", "restored-owner"), { recursive: true });
    writeFileSync(join(backupMediaRoot, "uploads", "restored-owner", "restored.txt"), "restored media content");
    const backupOut = join(work, "backup");

    const backup = await runScript(ORCHESTRATOR, ["--out", backupOut], {
      DATABASE_URL: `file:${backupSourceDb}`,
      MEDIA_STORAGE_DRIVER: "local",
      MEDIA_LOCAL_ROOT: backupMediaRoot,
    });
    expect(backup.exitCode).toBe(0);

    const restore = await runScript(
      RESTORE,
      ["--manifest", latestManifestPath(backupOut), "--staging", join(work, "drill"), "--confirm-live", "--yes"],
      {
        DATABASE_URL: `file:${liveDb}`,
        MEDIA_STORAGE_DRIVER: "local",
        MEDIA_LOCAL_ROOT: liveMediaRoot,
      },
    );
    expect(restore.exitCode).toBe(0);
    expect(restore.stdout).toContain("live database swapped");
    expect(restore.stdout).toContain("previous database preserved as");
    expect(restore.stdout).toContain('"event":"restore.live.ok"');

    // Live DB now carries the BACKUP content (9 users).
    expect(userCount(liveDb)).toBe(9);
    // The .bak carries the PREVIOUS content (2 users).
    const baks = readdirSync(work).filter((f) => f.startsWith("live.sqlite3.bak-"));
    expect(baks.length).toBe(1);
    expect(userCount(join(work, baks[0]!))).toBe(2);

    // Live media now carries the BACKUP media (restored-owner); the old live
    // file remains (merge semantics — tar/ledger restore never deletes).
    expect(readFileSync(join(liveMediaRoot, "uploads", "restored-owner", "restored.txt"), "utf8")).toBe("restored media content");
  });

  test("live S3 drill: objects re-uploaded to the bucket, checksum-verified", async () => {
    const fixture = await startS3CompatServer({
      bucket: "beanfolio-restore-s3",
      objects: { "uploads/old/kept.txt": "bucket content" },
    });
    servers.push(fixture);
    const work = makeTempDir("beanfolio-restore-s3-");
    const liveDb = join(work, "live.sqlite3");
    createSqliteFixture(liveDb, 4);
    const backupOut = join(work, "backup");

    // Backup FROM the bucket (the "media to restore").
    const backup = await runScript(ORCHESTRATOR, ["--out", backupOut], {
      DATABASE_URL: `file:${liveDb}`,
      S3_ENDPOINT: fixture.endpoint,
      S3_BUCKET: "beanfolio-restore-s3",
      S3_ACCESS_KEY_ID: "test-access-key",
      S3_SECRET_ACCESS_KEY: "test-secret-key",
      S3_REGION: "us-east-1",
      S3_FORCE_PATH_STYLE: "true",
    });
    expect(backup.exitCode).toBe(0);

    // Simulate disaster: the bucket loses its objects.
    fixture.bucket.clear();
    expect(fixture.bucket.size).toBe(0);

    // Live restore re-uploads everything from the verified backup.
    const restore = await runScript(
      RESTORE,
      ["--manifest", latestManifestPath(backupOut), "--staging", join(work, "drill"), "--confirm-live", "--yes"],
      {
        DATABASE_URL: `file:${liveDb}`,
        S3_ENDPOINT: fixture.endpoint,
        S3_BUCKET: "beanfolio-restore-s3",
        S3_ACCESS_KEY_ID: "test-access-key",
        S3_SECRET_ACCESS_KEY: "test-secret-key",
        S3_REGION: "us-east-1",
        S3_FORCE_PATH_STYLE: "true",
      },
    );
    expect(restore.exitCode).toBe(0);
    expect(restore.stdout).toContain("live S3 media restored");

    // The bucket has every backed-up object back, byte-identical.
    expect(fixture.bucket.get("uploads/old/kept.txt")?.toString()).toBe("bucket content");
    const puts = [...fixture.puts.keys()];
    expect(puts).toContain("uploads/old/kept.txt");
    expect(fixture.puts.get("uploads/old/kept.txt")?.toString()).toBe("bucket content");
  });

  test("usage: missing --manifest exits 2", async () => {
    const res = await runScript(RESTORE, [], {});
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Usage:");
  });
});
