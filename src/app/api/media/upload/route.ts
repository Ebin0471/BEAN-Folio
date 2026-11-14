import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, handler, getClientKey, rateLimit } from "@/lib/api-helpers";
import { UploadError, saveUpload } from "@/lib/media";

/**
 * POST /api/media/upload — the classic multipart upload transport.
 *
 * The browser POSTs the file as multipart/form-data (`file` field) and this
 * handler stores the bytes through the storage abstraction (local disk, or
 * S3-compatible object storage in production) and creates a READY MediaAsset.
 *
 * This route is REQUIRED: the client (lib/client.ts) probes the presigned
 * direct flow first and falls back to this endpoint when the deployment
 * answers 501 (local-disk storage). Without it the fallback POST used to be
 * captured by the dynamic /api/media/[id] route — which exports no POST —
 * so every upload failed with 405 Method Not Allowed. App Router gives the
 * static segment precedence over [id], so /api/media/upload resolves here
 * while /api/media/<uuid> keeps resolving to [id].
 *
 * Validation is identical to the direct flow's completion step: magic bytes
 * decide the real mime (client MIME is never trusted), per-kind size caps
 * are enforced, and text uploads get the whole-file NUL-byte/UTF-8 scan.
 * Everything lives in saveUpload (lib/media.ts) — this handler only does
 * auth, abuse control and response shaping.
 *
 * Contract (mirrors the direct flow; pinned by tests/media-direct.test.ts):
 *   - no/invalid session                    → 401
 *   - rate limit (same 30/h upload quota)   → 429
 *   - not multipart / missing `file` field  → 400
 *   - invalid content, type or size         → 400 (UploadError message)
 *   - success                               → 200 { media: { id, kind, mime, size, url } }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPLOAD_LIMIT = 30; // same abuse quota as the presigned direct flow
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return err("Authentication required", 401);

  if (!rateLimit(`upload:${user.id}:${getClientKey(req)}`, UPLOAD_LIMIT, UPLOAD_WINDOW_MS)) {
    return err("Upload limit reached — try again later.", 429);
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return err("Expected a multipart/form-data body with a `file` field.", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return err("Missing file — send the media as a `file` field in multipart/form-data.", 400);
  }

  let media;
  try {
    media = await saveUpload(file, user.id);
  } catch (e) {
    if (e instanceof UploadError) return err(e.message, 400);
    throw e;
  }

  return ok({
    media: {
      id: media.id,
      kind: media.kind,
      mime: media.mime,
      size: media.size,
      url: `/api/media/${media.id}/raw`,
    },
  });
});
