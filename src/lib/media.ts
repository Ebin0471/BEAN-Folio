import { db } from "@/lib/db";
import {
  buildStorageKey,
  deleteObject,
  getObject,
  getObjectRange,
  objectMetadata,
  putObject,
} from "@/lib/storage";

/**
 * Media upload boundary.
 * Blobs are stored through the storage abstraction (src/lib/storage.ts —
 * local disk, or S3-compatible object storage in production) and served
 * through /api/media/[id]/raw. Validation uses magic bytes — client MIME
 * types are never trusted on their own.
 */

export const MEDIA_RULES: Record<string, { mimes: string[]; maxBytes: number; label: string }> = {
  IMAGE: { mimes: ["image/jpeg", "image/png", "image/webp", "image/gif"], maxBytes: 8 * 1024 * 1024, label: "Image" },
  VIDEO: { mimes: ["video/mp4", "video/webm", "video/quicktime"], maxBytes: 64 * 1024 * 1024, label: "Video" },
  AUDIO: { mimes: ["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg"], maxBytes: 20 * 1024 * 1024, label: "Audio" },
  // DOCUMENT includes PDFs, OOXML office formats (Word/PowerPoint/Excel —
  // presentations, papers, reports), plain-text formats (markdown, CSV, JSON,
  // HTML, CSS, JS) and zip-based archives/design sources (Sketch, XD, Keynote
  // are zip containers — stored inert, served as downloads, never executed).
  // Text is detected by content (UTF-8, no NUL bytes); OOXML/zip by the PK
  // magic refined through the file's extension.
  DOCUMENT: {
    mimes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/zip",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "text/html",
      "text/css",
      "application/javascript",
    ],
    maxBytes: 10 * 1024 * 1024,
    label: "Document",
  },
};

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/zip": "zip",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "text/html": "html",
  "text/css": "css",
  "application/javascript": "js",
};

/** Extension → canonical text mime (only for extensions we deliberately accept). */
const TEXT_MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
};

/**
 * Zip-container refinement: all OOXML office files and most design sources
 * (Sketch, XD, Keynote) share the same PK zip magic, so content alone cannot
 * tell them apart — the extension selects the canonical mime. Extensions not
 * listed stay generic application/zip. Every result must still pass the
 * DOCUMENT rule's mime allowlist in saveUpload.
 */
const ZIP_MIME_BY_EXT: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  // Zip-based design/source files keep the generic zip mime.
  zip: "application/zip",
  sketch: "application/zip",
  xd: "application/zip",
  key: "application/zip",
};

/** Zip-family check: OOXML office mimes + generic zip share one magic. */
function isZipFamilyMime(mime: string): boolean {
  return (
    mime === "application/zip" ||
    mime.startsWith("application/vnd.openxmlformats-officedocument.")
  );
}

/** Sniff actual content type from magic bytes. Returns mime or null when unknown. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.slice(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  if (buf.slice(0, 4).toString("ascii") === "ftyp") return "video/mp4"; // handled below, kept for safety
  if (buf.slice(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.slice(8, 12).toString("ascii");
    if (brand.startsWith("qt")) return "video/quicktime";
    return "video/mp4";
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
  if (buf.slice(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  // Zip container: OOXML office documents (docx/pptx/xlsx) and design sources
  // (Sketch, XD, Keynote) all start with PK\x03\x04 — refined by extension in
  // saveUpload / completeDirectUpload.
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)
    return "application/zip";
  if (buf.slice(0, 3).toString("ascii") === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))
    return "audio/mpeg";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WAVE")
    return "audio/wav";
  if (buf.slice(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  return sniffTextMime(buf) ? "text/plain" : null;
}

/**
 * Text detection: a buffer is accepted as text when it is valid UTF-8 and
 * contains no NUL bytes (anything with a NUL byte is binary — executables,
 * archives, images — and must never pass as text). Returns true when the
 * buffer looks like text; the canonical mime is refined by file extension in
 * saveUpload. Deliberately conservative: short samples (< 12 bytes) are
 * rejected like every other format.
 */
export function sniffTextMime(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  for (const b of buf) if (b === 0x00) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function kindForMime(mime: string): string | null {
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("video/")) return "VIDEO";
  if (mime.startsWith("audio/")) return "AUDIO";
  if (
    mime === "application/pdf" ||
    isZipFamilyMime(mime) ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/javascript"
  )
    return "DOCUMENT";
  return null;
}

export class UploadError extends Error {}

/**
 * Validate + persist an uploaded file and create its MediaAsset row.
 * Throws UploadError with a user-safe message when validation fails.
 */
export async function saveUpload(file: File, ownerId: string) {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new UploadError("No file provided");
  }
  const head = Buffer.from(await file.slice(0, 16).arrayBuffer());
  let sniffed = sniffMime(head);
  if (!sniffed) {
    // The 16-byte head can split a multi-byte UTF-8 character in half (e.g. a
    // résumé whose first 16 bytes end inside an em-dash), which the strict
    // text decoder reports as invalid — legitimate text files were rejected
    // as "unrecognized". Every supported BINARY format carries a magic
    // signature that fits in the head, so re-sniffing a larger sample for the
    // text path is safe: it still rejects anything containing a NUL byte or
    // invalid UTF-8.
    const sample = Buffer.from(await file.slice(0, 4096).arrayBuffer());
    if (sniffTextMime(sample)) {
      sniffed = "text/plain";
    } else {
      throw new UploadError("Unsupported or unrecognized file type");
    }
  }

  // Text content is type-refined by the filename's extension (content alone
  // cannot distinguish markdown from CSV). The extension only ever selects
  // among the ALLOWED text mimes — unknown extensions stay text/plain — and
  // the file is stored inert (served as a download, never executed).
  if (sniffed === "text/plain") {
    const ext = (file.name || "").split(".").pop()?.toLowerCase() ?? "";
    const refined = TEXT_MIME_BY_EXT[ext];
    if (refined) sniffed = refined;
  }

  // Zip containers refine the same way: PK magic → canonical OOXML/zip mime
  // selected by extension; unknown extensions stay application/zip.
  if (sniffed === "application/zip") {
    const ext = (file.name || "").split(".").pop()?.toLowerCase() ?? "";
    const refined = ZIP_MIME_BY_EXT[ext];
    if (refined) sniffed = refined;
  }

  const kind = kindForMime(sniffed);
  if (!kind) throw new UploadError("File type not supported");
  const rule = MEDIA_RULES[kind];
  if (!rule.mimes.includes(sniffed)) throw new UploadError(`This ${rule.label.toLowerCase()} format is not allowed`);
  if (file.size > rule.maxBytes) {
    throw new UploadError(`${rule.label} exceeds the ${Math.round(rule.maxBytes / (1024 * 1024))}MB limit`);
  }
  if (file.size === 0) throw new UploadError("File is empty");

  const ext = EXT_BY_MIME[sniffed] ?? "bin";
  const storagePath = buildStorageKey(ownerId, ext);

  // Stream the rest of the file (head bytes are re-included by slicing from 0)
  const full = Buffer.from(await file.arrayBuffer());
  // Re-verify on the full buffer for formats whose header spans more bytes.
  // For text, re-run the NUL/UTF-8 check over the WHOLE file — a text upload
  // with appended binary garbage must be rejected, not stored.
  const isTextish =
    sniffed.startsWith("text/") || sniffed === "application/json" || sniffed === "application/javascript";
  const reSniffed = sniffMime(full.slice(0, 16));
  // Zip-family files re-sniff as generic application/zip regardless of the
  // extension refinement above — that difference is expected, not a change.
  const zipConsistent = isZipFamilyMime(sniffed) && reSniffed === "application/zip";
  if (reSniffed !== sniffed && !zipConsistent) {
    if (!(isTextish && sniffTextMime(full))) throw new UploadError("File content changed during upload");
  } else if (isTextish && !sniffTextMime(full)) {
    // The head looked like text but the body contains NUL bytes or invalid
    // UTF-8 — binary garbage masquerading as a document. Reject it instead of
    // storing (and later serving) mislabeled binary content.
    throw new UploadError("Unsupported or unrecognized file type");
  }
  await putObject(storagePath, full, sniffed);

  const media = await db.mediaAsset.create({
    data: {
      ownerId,
      kind,
      filename: (file.name || storagePath.split("/").pop() || "upload").slice(0, 180),
      mime: sniffed,
      size: full.length,
      status: "READY",
      storagePath,
    },
  });
  return media;
}

export async function deleteMediaFile(storagePath: string): Promise<void> {
  await deleteObject(storagePath);
}

// ---------------------------------------------------------------------------
// Direct (presigned) uploads — P2 production media infrastructure
// ---------------------------------------------------------------------------

/**
 * Validate a direct-upload request BEFORE anything is stored. The browser
 * uploads bytes straight to object storage via a presigned PUT; at sign time
 * we can only validate the DECLARED kind/size/filename — content is verified
 * authoritatively in completeDirectUpload() (magic bytes re-sniffed server-
 * side, exactly like the classic multipart path). Throws UploadError with a
 * user-safe message.
 */
export function validateDirectUploadRequest(input: {
  kind?: unknown;
  size?: unknown;
  filename?: unknown;
  mime?: unknown;
}): { kind: string; size: number; filename: string; mime: string } {
  const kind = typeof input.kind === "string" ? input.kind.toUpperCase() : "";
  const rule = MEDIA_RULES[kind];
  if (!rule) throw new UploadError("Unsupported media kind");

  const size = typeof input.size === "number" ? Math.floor(input.size) : Number.NaN;
  if (!Number.isFinite(size) || size <= 0) throw new UploadError("File is empty");
  if (size > rule.maxBytes) {
    throw new UploadError(`${rule.label} exceeds the ${Math.round(rule.maxBytes / (1024 * 1024))}MB limit`);
  }

  const filename = (typeof input.filename === "string" ? input.filename : "").slice(0, 180);
  if (!filename.trim()) throw new UploadError("Filename is required");

  // The declared mime only pre-selects the storage key extension and the
  // presigned PUT's Content-Type. It is never trusted as the final type —
  // completeDirectUpload() sniffs the actual bytes.
  const declared = typeof input.mime === "string" ? input.mime.split(";")[0].trim().toLowerCase() : "";
  const extFromName = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() ?? "" : "";
  const mime = rule.mimes.includes(declared)
    ? declared
    : (Object.entries(EXT_BY_MIME).find(([, ext]) => ext === extFromName)?.[0] ?? "");
  if (!mime || !rule.mimes.includes(mime)) {
    throw new UploadError(`This ${rule.label.toLowerCase()} format is not allowed`);
  }

  return { kind, size, filename, mime };
}

/**
 * Complete a direct upload: verify the object actually arrived, re-validate
 * its CONTENT server-side (magic bytes + size + kind match), then flip the
 * MediaAsset PENDING → READY. On any validation failure the object and the
 * row are deleted — a failed direct upload leaves nothing behind.
 *
 * Content verification mirrors the classic path:
 *  - IMAGE/DOCUMENT/AUDIO: full body is read (bounded by the kind's size
 *    cap) — images get intrinsic dimensions, text documents get the full
 *    NUL-byte/UTF-8 scan.
 *  - VIDEO: head bytes + exact Content-Length only (no transcoding exists;
 *    the browser plays the stored original, and a 64 MB re-read on complete
 *    would be wasted work).
 */
export async function completeDirectUpload(mediaId: string, ownerId: string) {
  const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!asset || asset.ownerId !== ownerId) throw new UploadError("Upload not found");
  if (asset.status === "READY") return asset; // idempotent re-complete
  if (asset.status !== "PENDING") throw new UploadError("This upload can no longer be completed");

  const rule = MEDIA_RULES[asset.kind];
  // Async cleanup + `Promise<never>` return: call sites `return fail(...)` so
  // TS narrows correctly (no TS18047 cascades), cleanup COMPLETES before the
  // rejection surfaces, and a failed direct upload leaves NOTHING behind
  // (object + row deleted).
  const fail = async (message: string): Promise<never> => {
    await deleteObject(asset.storagePath).catch(() => undefined);
    await db.mediaAsset.deleteMany({ where: { id: asset.id, status: "PENDING" } }).catch(() => undefined);
    throw new UploadError(message);
  };

  const meta = await objectMetadata(asset.storagePath);
  if (!meta) return fail("Upload not found — the file never reached storage. Please try again.");
  if (meta.size === 0) return fail("File is empty");
  if (meta.size > rule.maxBytes) {
    return fail(`${rule.label} exceeds the ${Math.round(rule.maxBytes / (1024 * 1024))}MB limit`);
  }

  const head = await getObjectRange(asset.storagePath, 0, 15).catch(() => null);
  if (!head) return fail("Upload could not be verified — please try again.");
  let sniffed = sniffMime(head);
  if (!sniffed) {
    // Same head-splits-a-UTF-8-character case as the classic path: re-sniff a
    // larger sample for the text path.
    const sample = await getObjectRange(asset.storagePath, 0, 4095).catch(() => null);
    if (sample && sniffTextMime(sample)) sniffed = "text/plain";
  }
  if (!sniffed) return fail("Unsupported or unrecognized file type");

  // Text content is refined by the stored filename's extension (content alone
  // cannot distinguish markdown from CSV) — same rule as the classic path.
  if (sniffed === "text/plain") {
    const ext = asset.filename.includes(".") ? asset.filename.split(".").pop()?.toLowerCase() ?? "" : "";
    const refined = (TEXT_MIME_BY_EXT as Record<string, string>)[ext];
    if (refined) sniffed = refined;
  }

  // Zip containers refine identically (PK magic → OOXML/zip by extension).
  if (sniffed === "application/zip") {
    const ext = asset.filename.includes(".") ? asset.filename.split(".").pop()?.toLowerCase() ?? "" : "";
    const refined = (ZIP_MIME_BY_EXT as Record<string, string>)[ext];
    if (refined) sniffed = refined;
  }

  const sniffedKind = kindForMime(sniffed);
  if (!sniffedKind || sniffedKind !== asset.kind || !rule.mimes.includes(sniffed)) {
    // The browser sent bytes that are not what it declared. Nothing is stored.
    return fail("File content does not match the selected file type");
  }

  let width: number | null = null;
  let height: number | null = null;
  const isTextish =
    sniffed.startsWith("text/") || sniffed === "application/json" || sniffed === "application/javascript";
  if (asset.kind === "IMAGE" || (asset.kind === "DOCUMENT" && isTextish)) {
    // Bounded full read (≤8 MB image / ≤10 MB document): dims for images,
    // whole-file NUL/UTF-8 verification for text — binary garbage appended
    // after the first 4 KB must not pass as a text document.
    const full = await getObjectFull(asset.storagePath, meta.size).catch(() => null);
    if (!full) return fail("Upload could not be verified — please try again.");
    if (asset.kind === "IMAGE") {
      const dims = imageDimensions(full);
      width = dims?.width ?? null;
      height = dims?.height ?? null;
    } else if (!sniffTextMime(full)) {
      return fail("Unsupported or unrecognized file type");
    }
  }

  const updated = await db.mediaAsset.update({
    where: { id: asset.id },
    data: { status: "READY", mime: sniffed, size: meta.size, width, height },
  });
  return updated;
}

/** Read the whole object (bounded — callers cap by kind before calling). */
async function getObjectFull(storagePath: string, expectedSize: number): Promise<Buffer | null> {
  try {
    if (expectedSize > 32 * 1024 * 1024) return null; // defensive cap
    return await getObject(storagePath);
  } catch {
    return null;
  }
}

/** For IMAGE assets, read intrinsic dimensions (jpeg/png/gif/webp only). */
export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off < buf.length - 9) {
        if (buf[off] !== 0xff) break;
        const marker = buf[off + 1];
        const len = buf.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        off += 2 + len;
      }
    }
    if (buf.slice(0, 4).toString("ascii") === "GIF8") {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") {
      const chunk = buf.slice(12, 16).toString("ascii");
      if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8X") {
        return {
          width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
          height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}
