import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, handler, getClientKey, rateLimit } from "@/lib/api-helpers";
import { MEDIA_RULES, UploadError, validateDirectUploadRequest } from "@/lib/media";
import { buildStorageKey, presignedPutUrl, storageDriver } from "@/lib/storage";

/**
 * POST /api/media/direct/presign — step 1 of the presigned direct upload flow
 * (P2 production media infrastructure).
 *
 * The browser asks for a short-lived presigned PUT URL and then uploads the
 * file bytes STRAIGHT to object storage — file contents never pass through a
 * Next.js API handler. This removes the app server's request-body cap from
 * the upload path (the classic POST /api/media/upload is bounded by e.g.
 * Vercel's ~4.5 MB function body limit) and keeps large media (64 MB videos)
 * off the web tier entirely.
 *
 * Contract (tests/media-direct.test.ts pins it):
 *   - no/invalid session                     → 401
 *   - storage driver is not S3 (local disk)  → 501 (classic upload remains available)
 *   - invalid kind/size/filename/mime        → 400 (UploadError message)
 *   - rate limit (same 30/h quota as upload) → 429
 *   - success                                → 200 { media: { id, kind, uploadUrl, headers, expiresIn } }
 *
 * The created MediaAsset row starts status=PENDING — invisible to every
 * read path until POST /api/media/direct/complete verifies the stored bytes
 * (magic bytes + size + kind match) and flips it to READY. Abandoned PENDING
 * rows (browser died mid-upload) are purged — object included — by the
 * daily maintenance sweep.
 *
 * SECURITY: the bucket stays PRIVATE. A presigned PUT grants write access to
 * exactly one object key (owner-scoped, unguessable) for 10 minutes; it can
 * never read, list, or overwrite another user's object. Delivery continues
 * to go through GET /api/media/:id/raw behind the authorization ladder.
 */

export const runtime = "nodejs";

const UPLOAD_LIMIT = 30; // same abuse quota as the classic multipart upload
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;
const PRESIGN_EXPIRES_SEC = 600; // 10 minutes to start the browser PUT

export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return err("Authentication required", 401);

  if (!rateLimit(`upload:${user.id}:${getClientKey(req)}`, UPLOAD_LIMIT, UPLOAD_WINDOW_MS)) {
    return err("Upload limit reached — try again later.", 429);
  }

  if (storageDriver() !== "s3") {
    return err(
      "Direct uploads require S3-compatible object storage (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY). This deployment stores media on local disk — use the standard upload flow.",
      501
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err("Expected a JSON body: { kind, size, filename, mime }", 400);
  }

  let parsed: { kind: string; size: number; filename: string; mime: string };
  try {
    parsed = validateDirectUploadRequest({
      kind: body.kind,
      size: body.size,
      filename: body.filename,
      mime: body.mime,
    });
  } catch (e) {
    if (e instanceof UploadError) return err(e.message, 400);
    throw e;
  }

  const extByMime: Record<string, string> = {
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
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "application/json": "json",
    "text/html": "html",
    "text/css": "css",
    "application/javascript": "js",
  };
  const ext = extByMime[parsed.mime] ?? "bin";
  const storagePath = buildStorageKey(user.id, ext);

  const uploadUrl = await presignedPutUrl(storagePath, parsed.mime, PRESIGN_EXPIRES_SEC);
  if (!uploadUrl) {
    return err("Could not create the upload URL — object storage is unavailable. Try again later.", 502);
  }

  // The row is created only AFTER the presign succeeded, and stays PENDING —
  // nothing is downloadable or attachable until complete verifies the bytes.
  const media = await db.mediaAsset.create({
    data: {
      ownerId: user.id,
      kind: parsed.kind,
      filename: parsed.filename,
      mime: parsed.mime, // declared value; replaced by the sniffed mime on complete
      size: parsed.size, // declared value; replaced by the exact object size on complete
      status: "PENDING",
      storagePath,
    },
  });

  return ok({
    media: {
      id: media.id,
      kind: media.kind,
      uploadUrl,
      headers: { "Content-Type": parsed.mime },
      expiresIn: PRESIGN_EXPIRES_SEC,
    },
  });
});

// MEDIA_RULES anchors the kind allowlist contract (validation itself lives in
// validateDirectUploadRequest, which reads the same table).
void MEDIA_RULES;
