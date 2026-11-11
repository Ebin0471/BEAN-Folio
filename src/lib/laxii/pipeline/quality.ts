import sharp from "sharp";
import type { ExportFormat, SizeRequest } from "../types";
import { LaxiiError } from "../types";

/**
 * LAXII quality + export pipeline (sharp, Apache-2.0).
 *
 *  - Sharpness: mean absolute Laplacian response over the luma channel,
 *    normalized to a 0–100 score. This is a real focus/detail metric — it is
 *    recorded per result so the UI can show measured quality, and exported
 *    dimensions are verified against the request (no phantom "4K").
 *  - Export: PNG (lossless), JPEG and WebP with a quality knob. Originals
 *    are never touched — every export writes a NEW buffer/file.
 */

// ------------------------------------------------------------------ metrics

/** 0–100 normalized sharpness from the mean |Laplacian| of the luma channel. */
export async function sharpnessScore(buf: Buffer): Promise<number> {
  const { data, info } = await sharp(buf)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  if (W < 3 || H < 3) return 0;
  let sum = 0;
  let count = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const lap = Math.abs(
        4 * data[i] - data[i - 1] - data[i + 1] - data[i - W] - data[i + W]
      );
      sum += lap;
      count++;
    }
  }
  if (!count) return 0;
  const meanLap = sum / count; // typical sharp photos ≈ 8–30
  return Math.round(Math.min(100, (meanLap / 30) * 100));
}

/** Coarse blockiness heuristic (8×8 grid energy at multiple of 8 boundaries). */
export async function blockinessScore(buf: Buffer): Promise<number> {
  const { data, info } = await sharp(buf).grayscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  if (W < 24 || H < 24) return 0;
  let boundaryEnergy = 0;
  let boundaryCount = 0;
  for (let y = 8; y < H - 8; y += 8) {
    for (let x = 1; x < W - 1; x++) {
      boundaryEnergy += Math.abs(data[y * W + x] - data[y * W + x - 1]);
      boundaryCount++;
    }
  }
  for (let x = 8; x < W - 8; x += 8) {
    for (let y = 1; y < H - 1; y++) {
      boundaryEnergy += Math.abs(data[y * W + x] - data[(y - 1) * W + x]);
      boundaryCount++;
    }
  }
  if (!boundaryCount) return 0;
  const interior = await interiorEnergy(data, W, H);
  const ratio = boundaryEnergy / boundaryCount / Math.max(1, interior);
  return Math.round(Math.min(100, Math.max(0, (ratio - 1) * 100)));
}

function interiorEnergy(data: Buffer, W: number, H: number): number {
  let sum = 0;
  let n = 0;
  for (let y = 9; y < H - 9; y += 3) {
    for (let x = 9; x < W - 9; x += 3) {
      sum += Math.abs(data[y * W + x] - data[y * W + x - 1]);
      n++;
    }
  }
  return n ? sum / n : 1;
}

// ------------------------------------------------------------------ export

const MIME: Record<ExportFormat, string> = {
  PNG: "image/png",
  JPEG: "image/jpeg",
  WEBP: "image/webp",
};

export const EXT: Record<ExportFormat, string> = {
  PNG: "png",
  JPEG: "jpg",
  WEBP: "webp",
};

export function mimeFor(f: ExportFormat): string {
  return MIME[f];
}

/**
 * Export to the requested format at the EXACT requested dimensions.
 * Enlargement beyond the composited size uses Lanczos3 + a mild unsharp
 * mask so upscaled exports stay crisp — and the returned width/height are
 * verified to equal the request (guaranteed by sharp fit:fill semantics).
 */
export async function exportImage(
  buf: Buffer,
  target: SizeRequest,
  format: ExportFormat,
  quality = 92
): Promise<{ data: Buffer; width: number; height: number; sharpness: number; blockiness: number }> {
  if (target.width < 16 || target.height < 16 || target.width > 4096 || target.height > 4096) {
    throw new LaxiiError("Export dimensions must be between 16 and 4096 pixels");
  }
  const meta = await sharp(buf).metadata();
  const upscaling = (meta.width ?? 0) < target.width || (meta.height ?? 0) < target.height;

  let pipeline = sharp(buf).resize(target.width, target.height, {
    fit: "fill", // the compositor already fixed the geometry — fill asserts exactness
    kernel: "lanczos3",
  });
  if (upscaling) pipeline = pipeline.sharpen({ sigma: 0.8, m1: 0.4, m2: 0.9 });

  const data =
    format === "PNG"
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
      : format === "JPEG"
        ? await pipeline.jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer()
        : await pipeline.webp({ quality }).toBuffer();

  // Verify — never claim dimensions we did not produce.
  const outMeta = await sharp(data).metadata();
  const width = outMeta.width ?? 0;
  const height = outMeta.height ?? 0;
  if (width !== target.width || height !== target.height) {
    throw new LaxiiError(`Export verification failed: got ${width}x${height}, requested ${target.width}x${target.height}`);
  }

  return { data, width, height, sharpness: await sharpnessScore(data), blockiness: await blockinessScore(data) };
}
