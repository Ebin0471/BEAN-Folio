import path from "path";
import { randomBytes } from "crypto";
import { mkdir, open, readFile, stat, unlink, writeFile } from "fs/promises";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * BEAN Folio — object storage boundary for uploaded media.
 *
 * Two drivers behind one API:
 *  - "local" (default): files under MEDIA_LOCAL_ROOT (default `<cwd>/uploads`),
 *    which is how the sandbox and any self-hosted single-instance deployment
 *    have always stored media.
 *  - "s3": any S3-compatible object store (AWS S3, Cloudflare R2, Supabase
 *    Storage, MinIO, …) configured via S3_ENDPOINT / S3_BUCKET /
 *    S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (+ optional S3_REGION and
 *    S3_FORCE_PATH_STYLE). This is the driver a stateless production host
 *    (e.g. Vercel) MUST use — its filesystem is ephemeral.
 *
 * `MediaAsset.storagePath` stores either a relative path ("uploads/…") for the
 * local driver or the object key for S3 — both are opaque strings resolved by
 * this module. Storage paths are validated to stay inside the media root,
 * so a tampered DB row can never make the app read arbitrary files.
 *
 * See docs/media-pipeline.md (storage layer status + Vercel body-size note).
 */

export type StorageDriver = "local" | "s3";

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  forcePathStyle: boolean;
}

/** Parse S3 env vars. Returns null unless ALL required vars are present. */
export function s3Config(): S3Config | null {
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.S3_REGION?.trim() || "auto",
    // Path-style addressing is what MinIO/R2/Supabase use; AWS endpoints use
    // virtual-hosted style. Opt out explicitly with S3_FORCE_PATH_STYLE=false.
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  };
}

/**
 * Active driver. `MEDIA_STORAGE_DRIVER=local` forces the local driver (even
 * with S3 vars set — used by tests/sandbox); otherwise S3 is used when fully
 * configured, and local is the fallback for unconfigured environments.
 */
export function storageDriver(): StorageDriver {
  if ((process.env.MEDIA_STORAGE_DRIVER ?? "").trim().toLowerCase() === "local") return "local";
  return s3Config() ? "s3" : "local";
}

/** Base directory that contains the `uploads/` media dir (configurable for tests). */
export function uploadRoot(): string {
  return process.env.MEDIA_LOCAL_ROOT ? path.resolve(process.env.MEDIA_LOCAL_ROOT) : process.cwd();
}

/** Absolute path of the local media directory (`<root>/uploads`). */
export function uploadDir(): string {
  return path.join(uploadRoot(), "uploads");
}

/**
 * Resolve a stored storagePath against the local media directory, refusing
 * anything that escapes `<root>/uploads` — so a tampered DB row can never
 * make the app read `.env`, the database, or source files.
 */
export function resolveLocalPath(storagePath: string): string {
  const mediaDir = uploadDir();
  const resolved = path.resolve(uploadRoot(), storagePath);
  if (resolved !== mediaDir && !resolved.startsWith(mediaDir + path.sep)) {
    throw new Error("Invalid storage path");
  }
  return resolved;
}

const clients = new Map<string, S3Client>();

function s3Client(cfg: S3Config): S3Client {
  const cacheKey = `${cfg.endpoint}|${cfg.region}|${cfg.accessKeyId}|${cfg.forcePathStyle}`;
  let client = clients.get(cacheKey);
  if (!client) {
    client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: cfg.forcePathStyle,
    });
    clients.set(cacheKey, client);
  }
  return client;
}

/** Store a blob. `storagePath` is the local relative path / S3 object key. */
export async function putObject(storagePath: string, body: Buffer, contentType: string): Promise<void> {
  if (storageDriver() === "s3") {
    const cfg = s3Config();
    if (!cfg) throw new Error("S3 storage is not configured");
    await s3Client(cfg).send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: storagePath,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      })
    );
    return;
  }
  const target = resolveLocalPath(storagePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
}

/** Read a blob. Throws when the object does not exist (caller decides 404). */
export async function getObject(storagePath: string): Promise<Buffer> {
  if (storageDriver() === "s3") {
    const cfg = s3Config();
    if (!cfg) throw new Error("S3 storage is not configured");
    const res = await s3Client(cfg).send(
      new GetObjectCommand({ Bucket: cfg.bucket, Key: storagePath })
    );
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error("Empty object body");
    return Buffer.from(bytes);
  }
  return readFile(resolveLocalPath(storagePath));
}

/** Total byte length of an object, without reading its content. */
export async function getObjectSize(storagePath: string): Promise<number> {
  if (storageDriver() === "s3") {
    const cfg = s3Config();
    if (!cfg) throw new Error("S3 storage is not configured");
    const res = await s3Client(cfg).send(
      new HeadObjectCommand({ Bucket: cfg.bucket, Key: storagePath })
    );
    return res.ContentLength ?? 0;
  }
  const s = await stat(resolveLocalPath(storagePath));
  return s.size;
}

/**
 * Read an inclusive byte range [start, end] of an object (for HTTP Range
 * requests — video seeking must not buffer whole files). Both drivers
 * support this natively: S3 via the Range parameter, local via positioned
 * file reads.
 */
export async function getObjectRange(storagePath: string, start: number, end: number): Promise<Buffer> {
  if (storageDriver() === "s3") {
    const cfg = s3Config();
    if (!cfg) throw new Error("S3 storage is not configured");
    const res = await s3Client(cfg).send(
      new GetObjectCommand({ Bucket: cfg.bucket, Key: storagePath, Range: `bytes=${start}-${end}` })
    );
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error("Empty object body");
    return Buffer.from(bytes);
  }
  const handle = await open(resolveLocalPath(storagePath), "r");
  try {
    const length = end - start + 1;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Presigned direct-PUT URL (P2 — production media infrastructure).
 *
 * Returns a short-lived URL the BROWSER uses to upload bytes straight to the
 * object store — file contents never pass through a Next.js API handler, so
 * upload size is bounded by the object store's own limits, not the app
 * server's request-body cap (e.g. Vercel's ~4.5 MB). Only valid when the S3
 * driver is active; the local-disk driver has no browser-reachable storage
 * endpoint and callers must fall back to the classic multipart upload.
 */
export async function presignedPutUrl(
  storagePath: string,
  contentType: string,
  expiresInSec = 600
): Promise<string | null> {
  if (storageDriver() !== "s3") return null;
  const cfg = s3Config();
  if (!cfg) return null;
  const cmd = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: storagePath,
    ContentType: contentType,
  });
  return getSignedUrl(s3Client(cfg), cmd, { expiresIn: expiresInSec });
}

/**
 * Object metadata for the direct-upload completion check: existence + exact
 * byte length without downloading the body. Null when the object is missing
 * (the browser never completed its PUT).
 */
export async function objectMetadata(storagePath: string): Promise<{ size: number } | null> {
  try {
    if (storageDriver() === "s3") {
      const cfg = s3Config();
      if (!cfg) return null;
      const res = await s3Client(cfg).send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: storagePath }));
      return { size: res.ContentLength ?? 0 };
    }
    const s = await stat(resolveLocalPath(storagePath));
    return { size: s.size };
  } catch {
    return null;
  }
}

/** Delete a blob. Idempotent — a missing object is not an error. */
export async function deleteObject(storagePath: string): Promise<void> {
  try {
    if (storageDriver() === "s3") {
      const cfg = s3Config();
      if (!cfg) throw new Error("S3 storage is not configured");
      await s3Client(cfg).send(
        new DeleteObjectCommand({ Bucket: cfg.bucket, Key: storagePath })
      );
    } else {
      await unlink(resolveLocalPath(storagePath));
    }
  } catch {
    // already gone — deletion stays idempotent across drivers
  }
}

/**
 * Storage key for a NEW upload: `uploads/<ownerId>/<base36-time><16 hex>.<ext>`
 * — unguessable, owner-scoped (docs/media-pipeline.md §4 key convention,
 * simplified: single original object, no variants yet).
 */
export function buildStorageKey(ownerId: string, ext: string): string {
  const safeOwner = ownerId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeExt = ext.replace(/[^a-z0-9]/gi, "") || "bin";
  return `uploads/${safeOwner}/${Date.now().toString(36)}${randomBytes(8).toString("hex")}.${safeExt}`;
}
