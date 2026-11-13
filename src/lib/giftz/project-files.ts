/**
 * GIFTZ project file store — the REAL file tree of a generated site.
 *
 * Files are database rows (GiftzProjectFile) with confined relative paths.
 * The security model mirrors lib/giftz/workspace.ts's path confinement, but
 * everything lives in the DB: there is no filesystem to escape, so
 * `constrainProjectPath` validates the PATH SHAPE itself (no absolute paths,
 * no `..`, no backslashes, no NUL, bounded depth/length, no `.git` segments)
 * and every write re-validates before touching a row.
 *
 * Sources: "generated" rows are the deterministic compiler's projection of the
 * content model and may be replaced on config saves; "user" rows come from
 * the code editor and "ai" rows from the file-level agent — the compiler
 * never overwrites those (sync reports them instead).
 */

import { db } from "@/lib/db";

export const PROJECT_FILE_LIMITS = {
  maxFiles: 300,
  /** Per-file cap for text (utf8) rows. */
  maxTextBytes: 262_144, // 256KB
  /** Per-file cap for binary rows (decoded size). */
  maxBase64Bytes: 4_194_304, // 4MB decoded
  /** Total project size cap (decoded bytes across all rows). */
  maxTotalBytes: 31_457_280, // 30MB
  maxPathDepth: 8,
  maxPathLength: 200,
} as const;

export class ProjectFileError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = "invalid_path") {
    super(message);
    this.name = "ProjectFileError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Confine a client-supplied relative path to a safe project-internal shape.
 * Throws ProjectFileError on anything unsafe; returns the normalized path
 * (duplicate slashes collapsed, no trailing slash). Case is preserved —
 * paths are case-sensitive. Reserved top-level names are NOT enforced except
 * that any segment equal to `.git` is forbidden.
 */
export function constrainProjectPath(raw: unknown): string {
  if (typeof raw !== "string") throw new ProjectFileError("File path must be a string");
  if (raw.length === 0) throw new ProjectFileError("File path is empty");
  if (raw.startsWith("/")) throw new ProjectFileError("File path must be relative (no leading '/')");
  if (raw.includes("\\")) throw new ProjectFileError("File path must use '/' separators");
  if (raw.includes("\0")) throw new ProjectFileError("File path contains an invalid character");
  if (raw.length > PROJECT_FILE_LIMITS.maxPathLength) {
    throw new ProjectFileError(`File path exceeds the ${PROJECT_FILE_LIMITS.maxPathLength}-character limit`, 413, "path_too_long");
  }
  const normalized = raw.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (normalized.length === 0) throw new ProjectFileError("File path is empty");
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === "..") throw new ProjectFileError("File path must not contain '..'");
    if (seg.startsWith(".")) throw new ProjectFileError("File path segments must not start with '.'");
    if (seg.length === 0) throw new ProjectFileError("File path contains an empty segment");
  }
  if (segments.length > PROJECT_FILE_LIMITS.maxPathDepth) {
    throw new ProjectFileError(`File path exceeds the ${PROJECT_FILE_LIMITS.maxPathDepth}-segment depth limit`, 413, "path_too_deep");
  }
  if (segments.includes(".git")) {
    throw new ProjectFileError("File path must not contain a '.git' segment");
  }
  return normalized;
}

/** Decoded byte size of one row's content (base64 rows are decoded before counting). */
export function projectContentSizeBytes(content: string, encoding: string): number {
  if (encoding === "base64") {
    return Buffer.from(content, "base64").byteLength;
  }
  return Buffer.byteLength(content, "utf8");
}

/**
 * Enforce count / total-size / per-file caps for one incoming write against
 * the current tree. Replacing an existing path does not double-count it.
 * Throws ProjectFileError 413 when a cap is exceeded.
 */
export function assertProjectLimits(
  existing: { path: string; sizeBytes: number; encoding: string }[],
  incoming: { path: string; content: string; encoding: string }
): void {
  if (incoming.encoding !== "utf8" && incoming.encoding !== "base64") {
    throw new ProjectFileError('encoding must be "utf8" or "base64"', 400, "invalid_encoding");
  }
  const perFileCap = incoming.encoding === "base64" ? PROJECT_FILE_LIMITS.maxBase64Bytes : PROJECT_FILE_LIMITS.maxTextBytes;
  const incomingSize = projectContentSizeBytes(incoming.content, incoming.encoding);
  if (incomingSize > perFileCap) {
    throw new ProjectFileError(
      `"${incoming.path}" is too large (${incomingSize} bytes; the per-file limit is ${perFileCap})`,
      413,
      "file_too_large"
    );
  }
  if (existing.length >= PROJECT_FILE_LIMITS.maxFiles && !existing.some((r) => r.path === incoming.path)) {
    throw new ProjectFileError(
      `The project already has ${PROJECT_FILE_LIMITS.maxFiles} files — the per-project limit`,
      413,
      "too_many_files"
    );
  }
  const replaced = existing.find((r) => r.path === incoming.path);
  const totalWithoutReplaced = existing.reduce((n, r) => n + r.sizeBytes, 0) - (replaced?.sizeBytes ?? 0);
  if (totalWithoutReplaced + incomingSize > PROJECT_FILE_LIMITS.maxTotalBytes) {
    throw new ProjectFileError(
      `The project would exceed its ${PROJECT_FILE_LIMITS.maxTotalBytes}-byte total size limit`,
      413,
      "project_too_large"
    );
  }
}

/** All file rows of one project, ordered by path (stable tree order). */
export function listProjectFiles(siteId: string) {
  return db.giftzProjectFile.findMany({
    where: { siteId },
    orderBy: { path: "asc" },
  });
}

/** One row by confined path, or null. */
export async function readProjectFile(siteId: string, path: string) {
  return db.giftzProjectFile.findUnique({
    where: { siteId_path: { siteId, path } },
  });
}

/** Upsert one row; computes sizeBytes from the content and bumps updatedAt. */
export async function writeProjectFile(
  siteId: string,
  path: string,
  content: string,
  encoding: "utf8" | "base64",
  source: "generated" | "user" | "ai"
) {
  const sizeBytes = projectContentSizeBytes(content, encoding);
  return db.giftzProjectFile.upsert({
    where: { siteId_path: { siteId, path } },
    create: { siteId, path, content, encoding, source, sizeBytes },
    update: { content, encoding, source, sizeBytes, updatedAt: new Date() },
  });
}

/** Delete one row by path. Returns whether a row was actually removed. */
export async function deleteProjectFile(siteId: string, path: string): Promise<boolean> {
  const res = await db.giftzProjectFile.deleteMany({ where: { siteId, path } });
  return res.count > 0;
}

/** Aggregate tree stats for summaries (GET /api/giftz/sites/[id], files tree). */
export async function projectTreeSummary(
  siteId: string
): Promise<{ fileCount: number; totalBytes: number; lastUpdatedAt: string | null }> {
  const agg = await db.giftzProjectFile.aggregate({
    where: { siteId },
    _count: { _all: true },
    _sum: { sizeBytes: true },
    _max: { updatedAt: true },
  });
  return {
    fileCount: agg._count._all,
    totalBytes: agg._sum.sizeBytes ?? 0,
    lastUpdatedAt: agg._max.updatedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// MIME detection — single source of truth for preview/public/build serving.
// Text vs binary is decided by the row's encoding; the map here only names
// the Content-Type from the path extension.
// ---------------------------------------------------------------------------

const TEXT_MIME_BY_EXT: Record<string, string> = {
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  webmanifest: "application/manifest+json",
};

const BINARY_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  avif: "image/avif",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
};

const TEXT_EXTENSIONS = new Set(Object.keys(TEXT_MIME_BY_EXT));

/** Best-effort Content-Type for a project path (unknown → octet-stream). */
export function mimeForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === path) return "application/octet-stream"; // no extension
  return TEXT_MIME_BY_EXT[ext] ?? BINARY_MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * True when the path's extension is a KNOWN binary type (images, fonts,
 * media, pdf) and not a known text type. The file agent cannot produce
 * binary content, so plans must never create such files — this predicate
 * powers that rule and the build's zero-byte warning.
 */
export function isBinaryPath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === path) return false; // no extension → treated as text
  return !TEXT_MIME_BY_EXT[ext] && Boolean(BINARY_MIME_BY_EXT[ext]);
}

/** Whether a MIME type from mimeForPath is a text type (charset appending). */
export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json" || mime === "application/manifest+json";
}

/** Whether the path extension maps to one of the known text MIME types. */
export function isTextPath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ext !== path && ext in TEXT_MIME_BY_EXT;
}
