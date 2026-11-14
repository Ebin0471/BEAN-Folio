/**
 * M21 — media backup mode resolution, shared by the media backup CLI and the
 * orchestrator.
 *
 * The honesty rule: when S3 mode is REQUESTED (explicitly via
 * MEDIA_STORAGE_DRIVER=s3 or implicitly via any S3_* variable being set), the
 * configuration must be COMPLETE — otherwise this resolves to a failure, not
 * a silent fallback to local (which would back up the wrong medium and
 * report success).
 *
 * MEDIA_STORAGE_DRIVER=local forces the local driver (tests/sandbox).
 */

import { s3Config, storageDriver } from "../../../src/lib/storage";
import type { S3Config } from "../../../src/lib/storage";

export const S3_VAR_NAMES = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

export type MediaBackupMode = { driver: "local" } | { driver: "s3"; cfg: S3Config };

export function resolveMediaBackupMode(env: NodeJS.ProcessEnv = process.env): MediaBackupMode {
  const driverEnv = (env.MEDIA_STORAGE_DRIVER ?? "").trim().toLowerCase();
  if (driverEnv === "local") return { driver: "local" };

  const presentS3Vars = S3_VAR_NAMES.filter((name) => (env[name] ?? "").trim() !== "");
  if (driverEnv === "s3" || presentS3Vars.length > 0) {
    const cfg = s3Config();
    if (!cfg) {
      const missing = S3_VAR_NAMES.filter((name) => (env[name] ?? "").trim() === "");
      throw new Error(
        `S3 media backup requested but the S3 configuration is incomplete.\n` +
          `  Missing environment variables: ${missing.join(", ")}\n` +
          `  Required: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY ` +
          `(optional: S3_REGION, S3_FORCE_PATH_STYLE — see src/lib/storage.ts).\n` +
          `  Either complete the S3 configuration, or set MEDIA_STORAGE_DRIVER=local to back up ` +
          `the local uploads/ tree instead. Refusing to report success without backing up the media.`,
      );
    }
    return { driver: "s3", cfg };
  }
  return storageDriver() === "s3" ? { driver: "s3", cfg: s3Config()! } : { driver: "local" };
}
