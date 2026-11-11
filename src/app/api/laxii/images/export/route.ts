import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit } from "@/lib/api-helpers";
import { getObject } from "@/lib/storage";

import { fitToCanvas } from "@/lib/laxii/image-ops";
import { probeImage, pngHasAlpha } from "@/lib/laxii/validate";
import { storeGeneratedMedia } from "@/lib/laxii/service";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({
  versionId: z.string().min(1),
  format: z.enum(["png", "jpeg", "webp"]).default("png"),
});

/**
 * POST /api/laxii/images/export — re-encode ANY owned generated image (e.g. an
 * avatar) as PNG / JPEG / WebP at its true stored dimensions and hand back a
 * verified, owner-scoped asset. Mirrors the banner export contract: the
 * response reports the ACTUAL verified dimensions — never a claimed size.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-image-export:${user.id}`, 12, 60_000)) return ERR.rateLimited();

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return err("Invalid export request.", 400);
  const { versionId, format } = parsed.data;

  const version = await db.laxiiImageVersion.findUnique({
    where: { id: versionId },
    include: { media: true, conversation: { select: { userId: true } } },
  });
  if (!version || version.conversation.userId !== user.id) return ERR.notFound();
  if (version.media.status !== "READY") return err("The source image is no longer available.", 400);

  const source = await getObject(version.media.storagePath);
  const probe = probeImage(source);
  if (!probe) return err("The source image failed validation and cannot be exported.", 400);

  // Native-size re-encode (cover-fit with equal target dims is a no-op resize).
  const out = await fitToCanvas(source, probe.width, probe.height, format);
  const verify = probeImage(out.bytes);
  if (!verify || verify.width !== probe.width || verify.height !== probe.height) {
    return err("Export failed the size verification. Please try again.", 500);
  }

  const label = `LAXII image ${probe.width}x${probe.height}.${format === "jpeg" ? "jpg" : format}`;
  const mediaId = await storeGeneratedMedia(user.id, out.bytes, out.mime, verify.width, verify.height, label);

  return ok({
    export: {
      mediaId,
      url: `/api/media/${mediaId}/raw`,
      width: verify.width,
      height: verify.height,
      mime: out.mime,
      bytes: out.bytes.length,
      transparent: format === "png" && pngHasAlpha(out.bytes),
    },
  });
});
