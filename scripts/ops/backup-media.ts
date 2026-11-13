/**
 * Media & artifact backup (Phase 7 operational readiness).
 *
 *   bun scripts/ops/backup-media.ts --out backups/media
 *
 * Archives the media tree (uploads/ — user uploads, LAXII outputs, approved
 * artifact bytes) to <out>/media-<timestamp>.tar.gz using the system tar,
 * then verifies the archive by listing it and comparing the file COUNT to the
 * live tree. CODE GIFTZ workspaces (data/giftz-workspaces) are disposable,
 * reproducible from their git baselines + task records — deliberately NOT in
 * the media archive (documented in the deployment doc).
 *
 * For S3-driver deployments the media lives in the bucket — back THAT up
 * with the provider's versioning/replication; this script prints that note.
 */

import { spawnSync } from "child_process";
import { mkdirSync, existsSync, readdirSync, statSync, rmSync } from "fs";
import { join, resolve } from "path";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : "backups/media");

const root = process.cwd();
const uploadsDir = join(root, "uploads");

const { s3Config, storageDriver } = await import("../../src/lib/storage");
if (storageDriver() === "s3") {
  console.log(
    "MEDIA_STORAGE_DRIVER=s3 — media lives in the object store. Back up the BUCKET " +
      "(provider-side versioning/replication); this script only archives local trees."
  );
  process.exit(0);
}

if (!existsSync(uploadsDir)) {
  console.error("uploads/ directory does not exist — nothing to back up.");
  process.exit(1);
}

function countFiles(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(p);
    else if (entry.isFile()) n += 1;
  }
  return n;
}

const fileCount = countFiles(uploadsDir);
if (fileCount === 0) {
  console.error("uploads/ contains no files — nothing to back up.");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const archive = join(outDir, `media-${stamp}.tar.gz`);

// Archive relative to the project root so restore lands in ./uploads/….
const tar = spawnSync("tar", ["-czf", archive, "-C", root, "uploads"], {
  stdio: ["ignore", "ignore", "pipe"],
  encoding: "utf8",
});
if (tar.status !== 0) {
  console.error(`tar failed: ${tar.stderr?.slice(0, 300) ?? "unknown error"}`);
  if (existsSync(archive)) rmSync(archive, { force: true });
  process.exit(1);
}

// Verify: list the archive, count entries under uploads/, compare.
const list = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
if (list.status !== 0) {
  console.error("Archive is not readable (tar -tzf failed).");
  process.exit(1);
}
const archived = list.stdout.split("\n").filter((l) => l.startsWith("uploads/") && !l.endsWith("/")).length;
if (archived !== fileCount) {
  console.error(`Archive verification FAILED: ${archived} files archived vs ${fileCount} on disk.`);
  process.exit(1);
}

console.log(`Media backup verified OK: ${archive}`);
console.log(`  files: ${archived} · size: ${(statSync(archive).size / 1024 / 1024).toFixed(2)} MB`);
