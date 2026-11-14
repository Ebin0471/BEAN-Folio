/**
 * Media & artifact backup (M21 — shared core on scripts/ops/lib/backup-core.ts).
 *
 *   bun scripts/ops/backup-media.ts --out backups/media
 *
 * Archives the media tree to <out>/media-<timestamp>.tar.gz and verifies the
 * archive by FULL ROUND-TRIP extraction with per-file SHA-256 comparison —
 * a backup is only reported successful when its contents have been proven
 * byte-identical to the source. A JSON manifest sidecar (<artifact>.json)
 * records the checksum ledger for later verification by the orchestrator
 * and the restore path.
 *
 * Driver handling (fixes the two M21 defects):
 *   - MEDIA_LOCAL_ROOT is RESPECTED: the local driver archives
 *     `<MEDIA_LOCAL_ROOT or cwd>/uploads` via the storage module's
 *     uploadRoot() — never a hardcoded path.
 *   - S3: media lives in the bucket, so this script performs a REAL,
 *     verifiable backup: it lists every object under uploads/, downloads
 *     every object, verifies sizes, stages the exact local layout, tars it
 *     and round-trip-verifies the archive with per-object checksums. When
 *     the S3 configuration is incomplete or the backup cannot be verified,
 *     the script FAILS with actionable instructions — it NEVER exits 0
 *     without having actually backed up the media.
 *   - MEDIA_STORAGE_DRIVER=local forces the local driver (tests/sandbox).
 *
 * CODE GIFTZ workspaces (data/giftz-workspaces) are disposable, reproducible
 * from their git baselines + task records — deliberately NOT in the media
 * archive (documented in the deployment doc).
 *
 * Secrets: S3 credentials are never printed; the manifest records only the
 * endpoint/bucket/prefix. Exit 0 + a JSON result line on verified success;
 * non-zero on any failure — a failed backup leaves no artifact behind.
 */

import { resolve } from "node:path";
import { uploadRoot } from "../../src/lib/storage";
import { resolveMediaBackupMode } from "./lib/media-mode";
import { backupMediaLocal, backupMediaS3 } from "./lib/backup-core";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : "backups/media");

try {
  const mode = resolveMediaBackupMode();
  let manifest;
  if (mode.driver === "s3") {
    console.log(`Backing up S3 media (bucket ${mode.cfg.bucket}) → ${outDir}`);
    manifest = await backupMediaS3(mode.cfg, outDir);
  } else {
    const mediaRoot = uploadRoot();
    console.log(`Backing up local media (root ${mediaRoot}) → ${outDir}`);
    manifest = await backupMediaLocal(mediaRoot, outDir);
  }

  const file = resolve(outDir, manifest.file);
  console.log(`Media backup verified OK: ${file}`);
  console.log(`  files: ${manifest.fileCount} · size: ${(manifest.bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(
    JSON.stringify({
      event: "backup.ok",
      file,
      bytes: manifest.bytes,
      sha256: manifest.sha256,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      driver: manifest.driver,
      manifestSidecar: `${file}.json`,
    }),
  );
  // The S3 client's keep-alive connection pool would keep Bun's event loop
  // alive forever in a CLI context — exit explicitly once verified.
  process.exit(0);
} catch (err) {
  console.error(`[backup-media] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  console.error("[backup-media] no verified media backup was produced — see the message above for the exact fix.");
  process.exit(1);
}
