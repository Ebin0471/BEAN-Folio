/// <reference types="bun-types" />
/**
 * M21 — scripts/ops/backup-all.ts (coordinated backup orchestrator) tests.
 *
 * The orchestrator must produce ONE manifest connecting the database and
 * media artifacts of a single run, verify EVERYTHING (checksums recomputed,
 * archive round-trip, SQLite integrity) and FAIL CLOSED when any required
 * component fails — never reporting a partial run as a success.
 *
 * All tests run against TEMP databases / media roots / output dirs. The
 * live db, uploads/ and /home/z/beanfolio-backups/ are never touched.
 *
 * Run: bun test tests/backup-orchestrator.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import {
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

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "ops", "backup-all.ts");
const ORCHESTRATOR_SCHEMA = "beanfolio-backup-orchestrator/v1";

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

function createSqliteFixture(dbPath: string): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new Database(dbPath);
  try {
    for (const table of ["User", "Project", "MediaAsset", "AgentTask", "AgentArtifact", "Session"]) {
      db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY)`);
      db.prepare(`INSERT INTO "${table}" (id) VALUES (?)`).run(`${table}-1`);
    }
  } finally {
    db.close();
  }
}

function seedMedia(root: string): void {
  mkdirSync(join(root, "uploads", "u1"), { recursive: true });
  writeFileSync(join(root, "uploads", "u1", "a.txt"), "media file a");
  writeFileSync(join(root, "uploads", "u1", "b.txt"), "media file b");
}

interface Env {
  env: Record<string, string>;
}

function tempEnv(): Env {
  const work = makeTempDir("beanfolio-orch-");
  const dbPath = join(work, "db.sqlite3");
  createSqliteFixture(dbPath);
  const mediaRoot = makeTempDir("beanfolio-orch-media-");
  seedMedia(mediaRoot);
  return {
    env: {
      DATABASE_URL: `file:${dbPath}`,
      MEDIA_STORAGE_DRIVER: "local",
      MEDIA_LOCAL_ROOT: mediaRoot,
    },
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readLatestManifest(outDir: string): Record<string, unknown> {
  const manifests = readdirSync(outDir).filter((f) => f.startsWith("backup-manifest-") && f.endsWith(".json")).sort();
  expect(manifests.length).toBeGreaterThanOrEqual(1);
  return JSON.parse(readFileSync(join(outDir, manifests[manifests.length - 1]!), "utf8"));
}

describe("backup-all.ts orchestrator (M21)", () => {
  test("complete run: coordinated manifest connects both verified artifacts", () => {
    const { env } = tempEnv();
    const outDir = join(makeTempDir("beanfolio-orch-out-"), "out");

    const res = runScript(["--out", outDir], env);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("BACKUP COMPLETE");

    const manifest = readLatestManifest(outDir);
    expect(manifest.schema).toBe(ORCHESTRATOR_SCHEMA);
    expect(manifest.status).toBe("complete");

    const database = manifest.database as Record<string, unknown>;
    const media = manifest.media as Record<string, unknown>;
    expect(database.artifact).toBeTruthy();
    expect(media.artifact).toBeTruthy();

    // The manifest CONNECTS the artifacts: its recorded sha256s match the
    // actual files on disk (recomputed here, independently).
    expect(database.sha256).toBe(sha256(join(outDir, database.artifact as string)));
    expect(media.sha256).toBe(sha256(join(outDir, media.artifact as string)));
    expect(existsSync(join(outDir, database.manifest as string))).toBe(true);
    expect(existsSync(join(outDir, media.manifest as string))).toBe(true);

    const verification = manifest.verification as Record<string, unknown>;
    expect(verification.allPassed).toBe(true);
    const checks = verification.checks as Array<{ name: string; ok: boolean }>;
    expect(checks.some((c) => c.name === "database.checksum" && c.ok)).toBe(true);
    expect(checks.some((c) => c.name === "database.integrity" && c.ok)).toBe(true);
    expect(checks.some((c) => c.name === "media.checksum" && c.ok)).toBe(true);
    expect(checks.some((c) => c.name === "media.archive" && c.ok)).toBe(true);

    // Layout matches the documented §1.7 convention (db/ + media/ subdirs).
    expect(existsSync(join(outDir, "db"))).toBe(true);
    expect(existsSync(join(outDir, "media"))).toBe(true);
  });

  test("immutability: a second run adds new artifacts — nothing overwritten", () => {
    const { env } = tempEnv();
    const outDir = join(makeTempDir("beanfolio-orch-out2-"), "out");

    expect(runScript(["--out", outDir], env).exitCode).toBe(0);
    const firstManifests = readdirSync(outDir).filter((f) => f.startsWith("backup-manifest-"));
    expect(runScript(["--out", outDir], env).exitCode).toBe(0);

    const manifests = readdirSync(outDir).filter((f) => f.startsWith("backup-manifest-"));
    expect(manifests.length).toBe(firstManifests.length + 1);
    const dbArtifacts = readdirSync(join(outDir, "db")).filter((f) => f.endsWith(".sqlite3"));
    expect(dbArtifacts.length).toBe(2);
    const mediaArchives = readdirSync(join(outDir, "media")).filter((f) => f.endsWith(".tar.gz"));
    expect(mediaArchives.length).toBe(2);
  });

  test("fail-closed: media component failure fails the ENTIRE operation (status: failed, exit 1)", () => {
    const { env } = tempEnv();
    const outDir = join(makeTempDir("beanfolio-orch-out3-"), "out");

    // S3 mode requested but incomplete → media component must fail.
    // NOTE: no MEDIA_STORAGE_DRIVER=local here — that would override the S3 intent.
    const res = runScript(["--out", outDir], {
      DATABASE_URL: env.DATABASE_URL,
      MEDIA_LOCAL_ROOT: env.MEDIA_LOCAL_ROOT,
      S3_ENDPOINT: "http://127.0.0.1:9",
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("S3 configuration is incomplete");
    expect(res.stdout).not.toContain("BACKUP COMPLETE");

    // …and the coordinated manifest honestly records the failure.
    const manifest = readLatestManifest(outDir);
    expect(manifest.status).toBe("failed");
    const errors = manifest.errors as string[];
    expect(errors.some((e) => e.startsWith("media:"))).toBe(true);

    const verification = manifest.verification as Record<string, unknown>;
    expect(verification.allPassed).toBe(false);
  });

  test("fail-closed: missing DATABASE_URL fails the operation with a recorded error", () => {
    const mediaRoot = makeTempDir("beanfolio-orch-media2-");
    seedMedia(mediaRoot);
    const outDir = join(makeTempDir("beanfolio-orch-out4-"), "out");

    // DATABASE_URL="" — the parent bun test process inherits the repo .env,
    // so an explicit empty value is the reachable "not configured" state.
    const res = runScript(["--out", outDir], {
      DATABASE_URL: "",
      MEDIA_STORAGE_DRIVER: "local",
      MEDIA_LOCAL_ROOT: mediaRoot,
    });
    expect(res.exitCode).toBe(1);
    const manifest = readLatestManifest(outDir);
    expect(manifest.status).toBe("failed");
    expect((manifest.errors as string[]).some((e) => e.includes("DATABASE_URL is not set"))).toBe(true);
    // The media artifact may exist (it is valid), but the RUN is not a success.
    expect(manifest.status).not.toBe("complete");
  });

  test("retention hooks: --keep dry-run deletes nothing; --keep --prune prunes guarded set", () => {
    const { env } = tempEnv();
    const outDir = join(makeTempDir("beanfolio-orch-out5-"), "out");

    // Run 1 (keep=2, dry) → creates artifacts.
    const dry = runScript(["--out", outDir, "--keep", "2"], env);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("retention dry-run");
    const dbAfterDry = readdirSync(join(outDir, "db")).filter((f) => f.endsWith(".sqlite3")).length;

    // Seed an old verified artifact into db/ so the prune has a candidate.
    const oldName = "db-2026-01-01T00-00-00-000Z.sqlite3";
    const oldBody = "old artifact";
    writeFileSync(join(outDir, "db", oldName), oldBody);
    writeFileSync(
      join(outDir, "db", `${oldName}.json`),
      JSON.stringify({
        schema: "beanfolio-backup-manifest/v1",
        kind: "database",
        engine: "sqlite",
        file: oldName,
        bytes: oldBody.length,
        sha256: createHash("sha256").update(oldBody).digest("hex"),
        generatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    // Run 2 (keep=2, prune) → the seeded old artifact beyond keep is removed,
    // the two fresh verified artifacts stay (newest verified-good guard).
    const pruned = runScript(["--out", outDir, "--keep", "2", "--prune"], env);
    expect(pruned.exitCode).toBe(0);
    expect(pruned.stdout).toContain("retention applied");

    const dbFiles = readdirSync(join(outDir, "db"));
    expect(dbFiles).not.toContain(oldName);
    // Both fresh verified artifacts survive (run 1 + run 2), the old seeded one is gone.
    expect(dbFiles.filter((f) => f.endsWith(".sqlite3")).length).toBe(dbAfterDry + 1);
  });

  test("retention never touches foreign files (non-backup names stay untouched)", () => {
    const { env } = tempEnv();
    const outDir = join(makeTempDir("beanfolio-orch-out6-"), "out");
    expect(runScript(["--out", outDir, "--keep", "1", "--prune"], env).exitCode).toBe(0);

    const foreign = join(outDir, "db", "important-notes.txt");
    writeFileSync(foreign, "human note — not a backup artifact");
    const before = existsSync(foreign);

    expect(runScript(["--out", outDir, "--keep", "1", "--prune"], env).exitCode).toBe(0);
    expect(existsSync(foreign)).toBe(before);
  });
});
