import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit } from "@/lib/api-helpers";
import { getObject } from "@/lib/storage";

import { fitToCanvas } from "@/lib/laxii/image-ops";
import { probeImage, pngHasAlpha } from "@/lib/laxii/validate";
import { storeGeneratedMedia } from "@/lib/laxii/service";
import { findBannerPreset, resolveCustomBannerCanvas, CUSTOM_BANNER_SLUG } from "@/lib/laxii/banner-presets";
import { loadBriefTask } from "@/lib/intelligence/delegation";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({
  versionId: z.string().min(1),
  format: z.enum(["png", "jpeg", "webp"]).default("png"),
});

/**
 * POST /api/laxii/banner/export — validate + emit the exact-size banner asset.
 *
 * The pipeline re-encodes the generated banner to the conversation's canvas
 * dimensions (cover-fit, center crop — never stretched) in the requested
 * format, verifies the output decodes at the exact target size, and stores it
 * as a new derived MediaAsset owned by the requester. The response reports
 * the ACTUAL exported dimensions and format — never a claimed size the
 * pipeline did not verify.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-export:${user.id}`, 12, 60_000)) return ERR.rateLimited();

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return err("Invalid export request.", 400);
  const { versionId, format } = parsed.data;

  const version = await db.laxiiImageVersion.findUnique({
    where: { id: versionId },
    include: {
      media: true,
      message: { select: { metaJson: true } },
      conversation: { select: { userId: true, canvasWidth: true, canvasHeight: true, bannerKind: true } },
    },
  });
  if (!version || version.conversation.userId !== user.id) return ERR.notFound();
  if (version.media.status !== "READY") return err("The source image is no longer available.", 400);

  const canvasWidth = version.conversation.canvasWidth;
  const canvasHeight = version.conversation.canvasHeight;
  if (!canvasWidth || !canvasHeight) return err("This conversation has no banner canvas size.", 400);

  // Registry truth: when the conversation carries a KNOWN preset slug, the
  // stored canvas must still match that preset's authoritative dimensions
  // (a tampered row is refused, not exported). The strictly-bounded custom
  // family must sit inside the documented limits. Legacy slugs that predate
  // the registry keep exporting at their stored size.
  const storedPreset = findBannerPreset(version.conversation.bannerKind ?? "");
  if (storedPreset && (storedPreset.width !== canvasWidth || storedPreset.height !== canvasHeight)) {
    return err("This conversation's stored canvas no longer matches its banner preset — export refused.", 400);
  }
  if (version.conversation.bannerKind === CUSTOM_BANNER_SLUG && !resolveCustomBannerCanvas(canvasWidth, canvasHeight)) {
    return err("This conversation's custom canvas is outside the documented dimension limits — export refused.", 400);
  }

  // Source must decode before we export it.
  const source = await getObject(version.media.storagePath);
  const probe = probeImage(source);
  if (!probe) return err("The source image failed validation and cannot be exported.", 400);

  // Phase 3 approval gate: banners produced from a Riishe design brief are
  // exportable only AFTER the user explicitly approves the result. Publishing
  // generated work without a human decision is not allowed.
  const meta = version.message.metaJson ? (JSON.parse(version.message.metaJson) as { briefTaskId?: string }) : null;
  if (meta?.briefTaskId) {
    const brief = await loadBriefTask(user.id, meta.briefTaskId);
    if (!brief) return err("The originating design brief could not be verified for this banner.", 400);
    if (!brief.generation.approved) {
      return err(
        "Approve this banner first — brief-produced banners can be exported only after you approve the result.",
        403
      );
    }
  }

  // Platform file-size caps: enforced where the platform documents one.
  // JPEG/WebP step quality down deterministically before failing; PNG has no
  // quality knob, so an over-cap PNG is refused with an honest suggestion
  // instead of being emitted oversized.
  const maxBytes = storedPreset?.maxBytes ?? null;
  const qualityLadder = [92, 78, 64, 50, 38];
  let out = await fitToCanvas(source, canvasWidth, canvasHeight, format);
  if (maxBytes != null && out.bytes.length > maxBytes) {
    if (format === "png") {
      return err(
        `The exported PNG (${(out.bytes.length / 1_000_000).toFixed(1)}MB) exceeds the platform cap of ${(maxBytes / 1_000_000).toFixed(1)}MB for this canvas. Choose JPEG or WebP instead.`,
        400
      );
    }
    let accepted: Awaited<ReturnType<typeof fitToCanvas>> | null = null;
    for (const q of qualityLadder) {
      const candidate = await fitToCanvas(source, canvasWidth, canvasHeight, format, q);
      if (candidate.bytes.length <= maxBytes) {
        accepted = candidate;
        break;
      }
    }
    if (!accepted) {
      return err(
        `This image cannot be exported under the platform's ${(maxBytes / 1_000_000).toFixed(1)}MB cap even at reduced quality. Simplify the composition and try again.`,
        400
      );
    }
    out = accepted;
  }

  const verify = probeImage(out.bytes);
  if (!verify || verify.width !== canvasWidth || verify.height !== canvasHeight) {
    return err("Export failed the size verification. Please try again.", 500);
  }

  const label = `LAXII banner ${canvasWidth}x${canvasHeight}.${format === "jpeg" ? "jpg" : format}`;
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
      safeAreaRespected: true,
    },
  });
});
