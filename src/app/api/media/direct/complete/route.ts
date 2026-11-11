import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, handler, getClientKey, rateLimit } from "@/lib/api-helpers";
import { UploadError, completeDirectUpload } from "@/lib/media";

/**
 * POST /api/media/direct/complete — step 3 of the presigned direct upload
 * flow (P2 production media infrastructure).
 *
 * Called by the browser AFTER its direct PUT to object storage finishes. The
 * server then — and only then — verifies what actually landed:
 *   1. the MediaAsset exists, is owned by the caller, and is PENDING;
 *   2. the object exists in storage and its exact byte length is within the
 *      kind's cap (HeadObject — the body is not trusted, only measured);
 *   3. the CONTENT is re-validated server-side: magic bytes decide the real
 *      mime, the sniffed kind must match the declared kind, and text
 *      documents get the same whole-file NUL-byte/UTF-8 scan as the classic
 *      upload path.
 * Only after all three pass does the row flip PENDING → READY and become
 * attachable/deliverable. A failed verification deletes the object AND the
 * row — a rejected upload leaves nothing behind.
 *
 * Contract (tests/media-direct.test.ts pins it):
 *   - no/invalid session        → 401
 *   - not the owner / no row    → 400 "Upload not found"
 *   - object never uploaded     → 400 (honest message, row cleaned)
 *   - content/kind mismatch     → 400 (object + row deleted)
 *   - success                   → 200 { media: { id, kind, mime, size, url } }
 */

export const runtime = "nodejs";

// Bounds verification-request abuse (a user could otherwise hammer complete
// on PENDING rows to force repeated object reads). Shares the upload quota.
const COMPLETE_LIMIT = 60;
const COMPLETE_WINDOW_MS = 60 * 60 * 1000;

export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return err("Authentication required", 401);

  if (!rateLimit(`upload:${user.id}:${getClientKey(req)}`, COMPLETE_LIMIT, COMPLETE_WINDOW_MS)) {
    return err("Too many requests — try again later.", 429);
  }

  let body: { mediaId?: unknown };
  try {
    body = (await req.json()) as { mediaId?: unknown };
  } catch {
    return err("Expected a JSON body: { mediaId }", 400);
  }
  const mediaId = typeof body.mediaId === "string" ? body.mediaId : "";
  if (!mediaId) return err("mediaId is required", 400);

  let media;
  try {
    media = await completeDirectUpload(mediaId, user.id);
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
