/// <reference types="bun-types" />
/**
 * M21 — scripts/ops/backup-media.ts S3-driver regression tests.
 *
 * The original defect D2: with an S3 driver the old script printed a note
 * and exited 0 — reporting success having backed up NOTHING. The fixed
 * script performs a REAL, verifiable S3 backup and every failure is honest.
 *
 * These tests run the production code path end-to-end: the actual
 * @aws-sdk/client-s3 client (SigV4-signed, path-style) talks over real
 * HTTP to tests/helpers/s3-compat-server.ts — an in-process S3-compatible
 * API server implementing ListObjectsV2 (with FORCED pagination so the
 * ContinuationToken loop is genuinely exercised), GetObject, HeadObject
 * and PutObject. No network beyond localhost is involved; no cloud
 * credentials are needed.
 *
 * Run: bun test tests/backup-media-s3.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startS3CompatServer, type S3Fixture } from "./helpers/s3-compat-server";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "ops", "backup-media.ts");
const BUCKET = "beanfolio-m21-test-bucket";

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

/**
 * ASYNC spawn — REQUIRED here. Bun.spawnSync blocks the parent's event
 * loop, and this file's fixture HTTP server lives in that same parent:
 * a sync spawn would deadlock (the child's S3 requests would queue forever
 * against a parent that can never serve them).
 */
async function runScript(args: string[], env: Record<string, string>): Promise<SpawnResult> {
  const fullEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const k of ["MEDIA_STORAGE_DRIVER", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
    delete fullEnv[k];
  }
  Object.assign(fullEnv, env);
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
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

function s3Env(fixture: S3Fixture): Record<string, string> {
  return {
    S3_ENDPOINT: fixture.endpoint,
    S3_BUCKET: BUCKET,
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    S3_REGION: "us-east-1",
    S3_FORCE_PATH_STYLE: "true",
  };
}

function seedBucket(): Record<string, string> {
  // 5 objects under uploads/ (varying sizes) + 1 object OUTSIDE the prefix
  // (must NOT appear in the backup).
  return {
    "uploads/user-a/alpha.txt": "alpha payload\n".repeat(50),
    "uploads/user-a/beta.bin": Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 251)).toString("binary"),
    "uploads/user-b/gamma.txt": "γ",
    "uploads/user-c/deep/nested/delta.json": '{"delta":true,"bytes":"café"}',
    "uploads/user-c/epsilon.bin": Buffer.alloc(4096, 0xab).toString("binary"),
    "other-prefix/NOT-MEDIA.txt": "must be excluded from the uploads/ backup",
  };
}

describe("backup-media.ts S3 driver (M21)", () => {
  test("real S3 backup: lists (paginated), downloads, verifies and archives every object", async () => {
    const fixture = await startS3CompatServer({ bucket: BUCKET, objects: seedBucket(), maxKeysPerPage: 2 });
    servers.push(fixture);
    const outDir = join(makeTempDir("beanfolio-s3backup-out-"), "out");

    const res = await runScript(["--out", outDir], s3Env(fixture));
    expect(res.exitCode).toBe(0);

    // The client really paginated: ListObjectsV2 pages of ≤2 keys.
    const listRequests = fixture.requests.filter((r) => r.method === "GET" && r.query["list-type"] === "2");
    expect(listRequests.length).toBeGreaterThanOrEqual(3); // 5 objects / 2 per page
    expect(listRequests.some((r) => "continuation-token" in r.query)).toBe(true);

    // Every uploads/ object was downloaded exactly once; the foreign-prefix
    // object was never touched.
    const downloads = fixture.requests.filter((r) => r.method === "GET" && r.key);
    const downloadedKeys = new Set(downloads.map((r) => r.key!));
    expect(downloadedKeys.size).toBe(5);
    expect(downloadedKeys.has("other-prefix/NOT-MEDIA.txt")).toBe(false);

    // Result line + sidecar.
    const jsonLine = res.stdout.split("\n").find((l) => l.startsWith('{"event":"backup.ok"'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as Record<string, unknown>;
    expect(parsed.fileCount).toBe(5);
    expect(parsed.driver).toBe("s3");
    const sidecar = JSON.parse(readFileSync(parsed.manifestSidecar as string, "utf8"));
    expect(sidecar.source).toEqual({ endpoint: fixture.endpoint, bucket: BUCKET, prefix: "uploads/" });
    const entries = sidecar.entries as Array<{ path: string; bytes: number; sha256: string }>;
    expect(entries.map((e) => e.path).sort()).toEqual([
      "uploads/user-a/alpha.txt",
      "uploads/user-a/beta.bin",
      "uploads/user-b/gamma.txt",
      "uploads/user-c/deep/nested/delta.json",
      "uploads/user-c/epsilon.bin",
    ]);
    // The archive exists with a matching checksum sidecar.
    const archive = parsed.file as string;
    expect(existsSync(archive)).toBe(true);
    expect(existsSync(`${archive}.json`)).toBe(true);
  });

  test("incomplete S3 configuration: exit 1 with the exact missing variables (never fake success)", async () => {
    const fixture = await startS3CompatServer({ bucket: BUCKET });
    servers.push(fixture);
    const outDir = join(makeTempDir("beanfolio-s3backup-partial-"), "out");

    const res = await runScript(["--out", outDir], {
      S3_ENDPOINT: fixture.endpoint,
      // bucket + credentials missing
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("S3 configuration is incomplete");
    expect(res.stderr).toContain("S3_BUCKET");
    expect(res.stderr).toContain("S3_ACCESS_KEY_ID");
    expect(res.stderr).toContain("S3_SECRET_ACCESS_KEY");
    if (existsSync(outDir)) {
      expect(readdirSync(outDir).filter((f) => f.endsWith(".tar.gz")).length).toBe(0);
    }
  });

  test("empty bucket/prefix: exit 1 with an explicit refusal (not an empty success)", async () => {
    const fixture = await startS3CompatServer({ bucket: BUCKET, objects: {} });
    servers.push(fixture);
    const outDir = join(makeTempDir("beanfolio-s3backup-empty-"), "out");

    const res = await runScript(["--out", outDir], s3Env(fixture));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("0 objects under prefix");
    expect(res.stderr).toContain("refusing to create an empty media backup");
    if (existsSync(outDir)) {
      expect(readdirSync(outDir).filter((f) => f.endsWith(".tar.gz")).length).toBe(0);
    }
  });

  test("GetObject returning fewer bytes than listed: exit 1 with the size mismatch (honest failure)", async () => {
    const fixture = await startS3CompatServer({
      bucket: BUCKET,
      objects: seedBucket(),
      // Serve alpha.txt truncated by 10 bytes — the download-time size check
      // must catch the corruption between listing and download.
      getObjectOverride: (key, body) => (key.endsWith("alpha.txt") ? body.subarray(0, body.length - 10) : undefined),
    });
    servers.push(fixture);
    const outDir = join(makeTempDir("beanfolio-s3backup-corrupt-"), "out");

    const res = await runScript(["--out", outDir], s3Env(fixture));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("size mismatch downloading s3://");
    if (existsSync(outDir)) {
      expect(readdirSync(outDir).filter((f) => f.endsWith(".tar.gz")).length).toBe(0);
    }
  });

  test("MEDIA_STORAGE_DRIVER=local overrides S3 env vars (sandbox/test escape hatch)", async () => {
    const mediaRoot = makeTempDir("beanfolio-s3backup-localover-");
    mkdirSync(join(mediaRoot, "uploads", "u"), { recursive: true });
    writeFileSync(join(mediaRoot, "uploads", "u", "local.txt"), "local override wins");
    const outDir = join(makeTempDir("beanfolio-s3backup-outlocal-"), "out");

    const fixture = await startS3CompatServer({ bucket: BUCKET, objects: seedBucket() });
    servers.push(fixture);
    const requestsBefore = fixture.requests.length;

    const res = await runScript(["--out", outDir], {
      ...s3Env(fixture),
      MEDIA_STORAGE_DRIVER: "local",
      MEDIA_LOCAL_ROOT: mediaRoot,
    });
    expect(res.exitCode).toBe(0);
    expect(fixture.requests.length).toBe(requestsBefore); // the bucket was never contacted
    expect(res.stdout).toContain('"driver":"local"');
  });
});
