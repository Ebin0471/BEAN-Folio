/// <reference types="bun-types" />
/**
 * M21 — scripts/ops/backup-media.ts LOCAL-driver regression tests.
 *
 * The two original defects fixed here:
 *   D1: MEDIA_LOCAL_ROOT was ignored (hardcoded <cwd>/uploads) — now the
 *       storage module's uploadRoot() decides, and a test proves it.
 *   D2: (covered in backup-media-s3.test.ts) S3 mode used to exit 0 having
 *       backed up nothing.
 *
 * Everything runs in TEMP media roots — the live uploads/ tree is never
 * touched. fileCount assertions are the MEDIA_LOCAL_ROOT proof: the live
 * tree has ~1400 files; a test root has 2. If the script ignored the env
 * var, fileCount could never be 2.
 *
 * Run: bun test tests/backup-media.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "ops", "backup-media.ts");
const MANIFEST_SCHEMA = "beanfolio-backup-manifest/v1";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScript(args: string[], extraEnv: Record<string, string>): SpawnResult {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  // Neutralize inherited S3/driver vars so tests are deterministic.
  for (const k of ["MEDIA_STORAGE_DRIVER", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
    delete env[k];
  }
  Object.assign(env, extraEnv);
  const res = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: res.exitCode ?? 1,
    stdout: res.stdout ? res.stdout.toString() : "",
    stderr: res.stderr ? res.stderr.toString() : "",
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function seedMedia(root: string): { textBytes: number; binBytes: number } {
  const uploads = join(root, "uploads", "user-a");
  mkdirSync(uploads, { recursive: true });
  const text = "BEAN Folio media backup fixture — résumé with multi-byte characters é\n".repeat(10);
  writeFileSync(join(uploads, "resume.txt"), text);
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(200).fill(7)]);
  writeFileSync(join(uploads, "image.bin"), bin);
  return { textBytes: Buffer.byteLength(text), binBytes: bin.length };
}

describe("backup-media.ts local driver (M21)", () => {
  test("respects MEDIA_LOCAL_ROOT: archives exactly the 2 test files (not the live cwd tree)", () => {
    const mediaRoot = makeTempDir("beanfolio-mediabackup-root-");
    const expected = seedMedia(mediaRoot);
    const outDir = join(makeTempDir("beanfolio-mediabackup-out-"), "out");

    const res = runScript(["--out", outDir], { MEDIA_STORAGE_DRIVER: "local", MEDIA_LOCAL_ROOT: mediaRoot });
    expect(res.exitCode).toBe(0);

    const jsonLine = res.stdout.split("\n").find((l) => l.startsWith('{"event":"backup.ok"'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as Record<string, unknown>;
    // THE MEDIA_LOCAL_ROOT PROOF: exactly the 2 seeded files, never the live tree.
    expect(parsed.fileCount).toBe(2);
    expect(parsed.driver).toBe("local");
    expect(parsed.totalBytes).toBe(expected.textBytes + expected.binBytes);

    // Sidecar ledger matches the seeded content byte-for-byte.
    // (manifestSidecar in the JSON line is already the full sidecar path.)
    const sidecar = JSON.parse(readFileSync(parsed.manifestSidecar as string, "utf8"));
    expect(sidecar.schema).toBe(MANIFEST_SCHEMA);
    expect(sidecar.fileCount).toBe(2);
    const entries = sidecar.entries as Array<{ path: string; bytes: number; sha256: string }>;
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(["uploads/user-a/image.bin", "uploads/user-a/resume.txt"]);
    const resume = entries.find((e) => e.path.endsWith("resume.txt"))!;
    expect(resume.bytes).toBe(expected.textBytes);
    expect(resume.sha256).toBe(sha256(join(mediaRoot, "uploads/user-a/resume.txt")));

    // The artifact itself exists and its own checksum sidecar matches.
    const archive = parsed.file as string;
    expect(existsSync(archive)).toBe(true);
    const artifactSidecar = JSON.parse(readFileSync(`${archive}.json`, "utf8")) as Record<string, unknown>;
    expect(artifactSidecar.sha256).toBe(sha256(archive));
  });

  test("MEDIA_LOCAL_ROOT pointing at a root without uploads/: exit 1 naming the actual path", () => {
    const emptyRoot = makeTempDir("beanfolio-mediabackup-emptyroot-");
    const outDir = join(makeTempDir("beanfolio-mediabackup-out2-"), "out");

    const res = runScript(["--out", outDir], { MEDIA_STORAGE_DRIVER: "local", MEDIA_LOCAL_ROOT: emptyRoot });
    expect(res.exitCode).toBe(1);
    // Actionable failure names the MEDIA_LOCAL_ROOT-derived directory, proving the
    // env var was consumed (the old hardcoded cwd path would never appear here).
    expect(res.stderr).toContain(join(emptyRoot, "uploads"));
    expect(res.stderr).toContain("MEDIA_LOCAL_ROOT");
    if (existsSync(outDir)) {
      expect(readdirSync(outDir).filter((f) => f.endsWith(".tar.gz")).length).toBe(0);
    }
  });

  test("empty uploads/ tree: exit 1, no artifact (an empty backup is not a success)", () => {
    const mediaRoot = makeTempDir("beanfolio-mediabackup-nofiles-");
    mkdirSync(join(mediaRoot, "uploads"), { recursive: true });
    const outDir = join(makeTempDir("beanfolio-mediabackup-out3-"), "out");

    const res = runScript(["--out", outDir], { MEDIA_STORAGE_DRIVER: "local", MEDIA_LOCAL_ROOT: mediaRoot });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("nothing to back up");
    if (existsSync(outDir)) {
      expect(readdirSync(outDir).filter((f) => f.endsWith(".tar.gz")).length).toBe(0);
    }
  });

  test("S3 env vars present but incomplete: exit 1 listing the missing vars (no silent fallback)", () => {
    const mediaRoot = makeTempDir("beanfolio-mediabackup-s3partial-");
    seedMedia(mediaRoot);
    const outDir = join(makeTempDir("beanfolio-mediabackup-out4-"), "out");

    const res = runScript(["--out", outDir], {
      MEDIA_LOCAL_ROOT: mediaRoot,
      S3_ENDPOINT: "http://127.0.0.1:9",
      // S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY deliberately missing
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

  test("tampered backups are detected by the shared verifier (two vectors)", async () => {
    const { verifyMediaArchive, loadArtifactManifest } = await import("../scripts/ops/lib/backup-core");
    const mediaRoot = makeTempDir("beanfolio-mediabackup-tamper-");
    seedMedia(mediaRoot);
    const outDir = join(makeTempDir("beanfolio-mediabackup-out5-"), "out");

    const res = runScript(["--out", outDir], { MEDIA_STORAGE_DRIVER: "local", MEDIA_LOCAL_ROOT: mediaRoot });
    expect(res.exitCode).toBe(0);
    const archive = readdirSync(outDir).find((f) => f.endsWith(".tar.gz"))!;
    const sidecarPath = join(outDir, `${archive}.json`);
    const manifest = loadArtifactManifest(sidecarPath);

    // Untampered archive verifies.
    verifyMediaArchive(join(outDir, archive), manifest);

    // Vector 1 — tampered MANIFEST: a forged ledger entry must be caught as a
    // precise checksum mismatch against the intact archive.
    const forged = JSON.parse(readFileSync(sidecarPath, "utf8")) as typeof manifest;
    const victim = forged.entries!.find((e) => e.path.endsWith("resume.txt"))!;
    victim.sha256 = victim.sha256.replace(/^.{4}/, "beef");
    expect(() => verifyMediaArchive(join(outDir, archive), forged)).toThrow(/checksum mismatch/);

    // Vector 2 — tampered ARCHIVE: flipping archive bytes must fail verification
    // (gzip CRC / tar failure or a ledger mismatch — any rejection counts).
    const bytes = readFileSync(join(outDir, archive));
    bytes[bytes.length - 50] ^= 0xff;
    writeFileSync(join(outDir, archive), bytes);
    expect(() => verifyMediaArchive(join(outDir, archive), manifest)).toThrow();
  });
});
