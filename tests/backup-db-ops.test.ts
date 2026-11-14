/// <reference types="bun-types" />
/**
 * M21 — scripts/ops/backup-db.ts regression tests.
 *
 * Everything runs against TEMP databases and TEMP output directories —
 * the live db/custom.db, uploads/ and /home/z/beanfolio-backups/ are never
 * touched. The script is executed as a real subprocess so exit codes,
 * stdout JSON lines and on-disk artifacts are all covered end-to-end.
 *
 * Covered:
 *   - SQLite backup: artifact + sidecar manifest, sha256 recomputation,
 *     integrity + row-parity metadata, JSON result line
 *   - immutability: a second run writes a NEW artifact (no overwrite)
 *   - failure honesty: missing source → exit 1, no artifact left behind
 *   - PostgreSQL tooling missing → exit 1 with actionable fix text
 *     (no pg_dump exists in this sandbox — the honest-failure path is the
 *     verifiable contract here)
 *   - retention: dry-run deletes nothing; --prune deletes planned files;
 *     the newest verified-good artifact is always kept; artifacts with a
 *     checksum-mismatched sidecar are never touched
 *
 * Run: bun test tests/backup-db-ops.test.ts
 */
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { planRetention } from "../scripts/ops/lib/backup-core";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "ops", "backup-db.ts");
const MANIFEST_SCHEMA = "beanfolio-backup-manifest/v1";
const KEY_TABLES = ["User", "Project", "MediaAsset", "AgentTask", "AgentArtifact", "Session"];

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

function runScript(args: string[], databaseUrl: string | null): SpawnResult {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (databaseUrl === null) delete env.DATABASE_URL;
  else env.DATABASE_URL = databaseUrl;
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

/** Create a small SQLite database that contains every key table plus one extra. */
function createSqliteFixture(dbPath: string): Record<string, number> {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new Database(dbPath);
  const counts: Record<string, number> = {
    User: 3,
    Project: 5,
    MediaAsset: 7,
    AgentTask: 2,
    AgentArtifact: 4,
    Session: 1,
  };
  try {
    for (const table of KEY_TABLES) {
      db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY, note TEXT)`);
      const n = counts[table]!;
      const stmt = db.prepare(`INSERT INTO "${table}" (id, note) VALUES (?, ?)`);
      for (let i = 0; i < n; i++) stmt.run(`${table}-${i}`, `row ${i}`);
    }
    db.exec("CREATE TABLE ExtraTable (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO ExtraTable (id) VALUES (?)").run("extra-1");
  } finally {
    db.close();
  }
  return counts;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Seed a plausible-looking prunable artifact with a sidecar (valid or tampered). */
function seedArtifact(dir: string, name: string, tamperSidecar: boolean): void {
  const body = `seeded artifact ${name}\n`.repeat(20);
  writeFileSync(join(dir, name), body);
  const sha = createHash("sha256").update(body).digest("hex");
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify({
      schema: MANIFEST_SCHEMA,
      kind: "database",
      engine: "sqlite",
      file: name,
      bytes: body.length,
      sha256: tamperSidecar ? `${sha.slice(0, -4)}beef` : sha,
      generatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

beforeEach(() => {
  // Each test builds its own temp dirs; nothing persists.
});

describe("backup-db.ts (M21)", () => {
  test("SQLite backup: artifact + sidecar manifest with sha256/integrity/row parity", async () => {
    const work = makeTempDir("beanfolio-dbbackup-ok-");
    const dbPath = join(work, "source.sqlite3");
    const counts = createSqliteFixture(dbPath);
    const outDir = join(work, "out");

    const res = runScript(["--out", outDir], `file:${dbPath}`);
    expect(res.exitCode).toBe(0);

    const files = readdirSync(outDir).filter((f) => f.endsWith(".sqlite3"));
    expect(files.length).toBe(1);
    const artifact = join(outDir, files[0]!);

    // Sidecar exists and every recorded value recomputes correctly.
    const sidecar = JSON.parse(readFileSync(`${artifact}.json`, "utf8")) as Record<string, unknown>;
    expect(sidecar.schema).toBe(MANIFEST_SCHEMA);
    expect(sidecar.kind).toBe("database");
    expect(sidecar.engine).toBe("sqlite");
    expect(sidecar.integrity).toBe("ok");
    expect(sidecar.sha256).toBe(sha256(artifact));
    expect(sidecar.bytes).toBe(existsSync(artifact) ? Bun.file(artifact).size : -1);
    const parity = sidecar.rowParity as Record<string, number>;
    for (const table of KEY_TABLES) expect(parity[table]).toBe(counts[table]);
    expect((sidecar.tables as number) >= 7).toBe(true); // 6 key tables + ExtraTable + internal bookkeeping
    expect(sidecar.method).toBe("vacuum-into");

    // JSON result line on stdout.
    const jsonLine = res.stdout.split("\n").find((l) => l.startsWith('{"event":"backup.ok"'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as Record<string, unknown>;
    expect(parsed.sha256).toBe(sidecar.sha256);
    expect(parsed.manifestSidecar).toBe(`${artifact}.json`);
  });

  test("immutability: a second run creates a new artifact, never overwrites", () => {
    const work = makeTempDir("beanfolio-dbbackup-immutable-");
    const dbPath = join(work, "source.sqlite3");
    createSqliteFixture(dbPath);
    const outDir = join(work, "out");

    const first = runScript(["--out", outDir], `file:${dbPath}`);
    expect(first.exitCode).toBe(0);
    const second = runScript(["--out", outDir], `file:${dbPath}`);
    expect(second.exitCode).toBe(0);

    const artifacts = readdirSync(outDir).filter((f) => f.endsWith(".sqlite3"));
    expect(artifacts.length).toBe(2);
    expect(new Set(artifacts).size).toBe(2); // distinct timestamped names
  });

  test("missing source database: exit 1, no artifact left behind", () => {
    const work = makeTempDir("beanfolio-dbbackup-missing-");
    const outDir = join(work, "out");
    const res = runScript(["--out", outDir], "file:/nonexistent/nope.sqlite3");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("FAILED");
    if (existsSync(outDir)) {
      expect(readdirSync(outDir).filter((f) => f.endsWith(".sqlite3")).length).toBe(0);
    }
  });

  test("empty DATABASE_URL: exit 1 with a clear message", () => {
    // (Bun auto-loads the repo .env for spawned scripts, so "unset" is not a
    // reachable state here — an explicitly empty value exercises the same
    // guard branch in the script.)
    const res = runScript(["--out", join(makeTempDir("beanfolio-dbbackup-nourl-"), "out")], "");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("DATABASE_URL is not set");
  });

  test("PostgreSQL without pg_dump tooling: exit 1 with actionable instructions (never fake success)", () => {
    const work = makeTempDir("beanfolio-dbbackup-pg-");
    const outDir = join(work, "out");
    const res = runScript(["--out", outDir], "postgresql://user:secret@example.invalid:5432/beanfolio");
    expect(res.exitCode).toBe(1);
    // Actionable, honest failure: names the missing tool + concrete fixes.
    expect(res.stderr).toContain("pg_dump is not installed");
    expect(res.stderr).toContain("postgresql-client");
    expect(res.stderr).toContain("No backup was written");
    if (existsSync(outDir)) {
      expect(readdirSync(outDir).filter((f) => f.endsWith(".dump")).length).toBe(0);
    }
  });

  test("retention dry-run: prints a plan, deletes nothing", () => {
    const work = makeTempDir("beanfolio-dbbackup-dryrun-");
    const dbPath = join(work, "source.sqlite3");
    createSqliteFixture(dbPath);
    const outDir = join(work, "out");
    mkdirSync(outDir, { recursive: true });
    seedArtifact(outDir, "db-2026-01-01T00-00-00-000Z.sqlite3", false);
    seedArtifact(outDir, "db-2026-01-02T00-00-00-000Z.sqlite3", false);

    const res = runScript(["--out", outDir, "--keep", "2"], `file:${dbPath}`);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("retention dry-run");
    // Both seeded artifacts (and their sidecars) are still on disk.
    for (const name of ["db-2026-01-01T00-00-00-000Z.sqlite3", "db-2026-01-02T00-00-00-000Z.sqlite3"]) {
      expect(existsSync(join(outDir, name))).toBe(true);
      expect(existsSync(join(outDir, `${name}.json`))).toBe(true);
    }
  });

  test("retention --prune: removes older verified artifacts, keeps newest verified-good", () => {
    const work = makeTempDir("beanfolio-dbbackup-prune-");
    const dbPath = join(work, "source.sqlite3");
    createSqliteFixture(dbPath);
    const outDir = join(work, "out");
    mkdirSync(outDir, { recursive: true });
    seedArtifact(outDir, "db-2026-01-01T00-00-00-000Z.sqlite3", false);
    seedArtifact(outDir, "db-2026-01-02T00-00-00-000Z.sqlite3", false);

    const res = runScript(["--out", outDir, "--keep", "2", "--prune"], `file:${dbPath}`);
    expect(res.exitCode).toBe(0);

    const remaining = readdirSync(outDir).filter((f) => f.endsWith(".sqlite3"));
    expect(remaining.length).toBe(2); // 1 newest fresh artifact + newest seeded
    expect(remaining.some((f) => f.startsWith("db-2026-"))).toBe(true); // the fresh one
    expect(remaining).toContain("db-2026-01-02T00-00-00-000Z.sqlite3"); // newest seeded kept
    expect(remaining).not.toContain("db-2026-01-01T00-00-00-000Z.sqlite3"); // oldest pruned
    // Its sidecar went with it.
    expect(existsSync(join(outDir, "db-2026-01-01T00-00-00-000Z.sqlite3.json"))).toBe(false);
  });

  test("retention guard: a future-dated TAMPERED artifact never gets the keep slot over the verified good", () => {
    const work = makeTempDir("beanfolio-dbbackup-guard-");
    const dbPath = join(work, "source.sqlite3");
    createSqliteFixture(dbPath);
    const outDir = join(work, "out");
    mkdirSync(outDir, { recursive: true });
    // Future-dated tampered artifact sorts NEWEST of all (above the fresh
    // backup the script is about to create). With keep=1 it takes the keep
    // slot — the last-known-good guard must then protect the newest
    // VERIFIED artifact (the fresh backup) from pruning anyway.
    seedArtifact(outDir, "db-2026-12-01T00-00-00-000Z.sqlite3", true);
    seedArtifact(outDir, "db-2026-02-01T00-00-00-000Z.sqlite3", false);

    const res = runScript(["--out", outDir, "--keep", "1", "--prune"], `file:${dbPath}`);
    expect(res.exitCode).toBe(0);

    const remaining = readdirSync(outDir).filter((f) => f.endsWith(".sqlite3"));
    // tampered (skipped — suspicious) + fresh verified backup (guarded) survive;
    // the older verified artifact beyond keep is pruned.
    expect(remaining.length).toBe(2);
    expect(remaining).toContain("db-2026-12-01T00-00-00-000Z.sqlite3");
    expect(remaining).not.toContain("db-2026-02-01T00-00-00-000Z.sqlite3");
    // The surviving non-tampered artifact must be the fresh verified backup —
    // i.e. a verified-good backup exists after retention (the guard held).
    const survivor = remaining.find((f) => !f.startsWith("db-2026-12"))!;
    expect(existsSync(join(outDir, `${survivor}.json`))).toBe(true);
  });

  test("retention refuses to plan pruning when no verified-good backup exists (lib-level)", () => {
    const work = makeTempDir("beanfolio-dbbackup-nogood-");
    const outDir = join(work, "out");
    mkdirSync(outDir, { recursive: true });
    seedArtifact(outDir, "db-2026-01-01T00-00-00-000Z.sqlite3", true); // tampered only

    const plan = planRetention(outDir, 1);
    expect(plan.verifiedCount).toBe(0);
    expect(plan.pruneFiles.length).toBe(0);
    expect(plan.skipped[0]?.reason).toContain("no verified-good backup");
  });

  test("--prune without --keep is refused", () => {
    const work = makeTempDir("beanfolio-dbbackup-badflags-");
    const dbPath = join(work, "source.sqlite3");
    createSqliteFixture(dbPath);
    const res = runScript(["--out", join(work, "out"), "--prune"], `file:${dbPath}`);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--prune requires --keep");
  });
});
