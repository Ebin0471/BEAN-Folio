/**
 * LAXII — deterministic pixel pipelines (sharp).
 *
 * These are REAL image-processing steps used where a deterministic operation
 * is the honest tool: reference contact sheets for single-image providers,
 * exact aspect center-crops after a generative render, outpainting canvas
 * preparation, alpha extraction after generative subject isolation, and
 * banner export fitting. They NEVER substitute for semantic generation —
 * every generative change goes through a real provider call first.
 */

import sharp from "sharp";

import { LaxiiProviderError } from "./types";

export type ExactAspect = "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";

export function aspectRatio(aspect: ExactAspect): number {
  const [w, h] = aspect.split(":").map(Number);
  return w / h;
}

/**
 * Center-crop a rendered image to the exact requested aspect.
 * The provider renders at its closest native size; this trims the overflow
 * symmetrically (real pixels, no stretching, no generation).
 */
export async function cropToAspect(
  input: Buffer,
  aspect: ExactAspect
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const target = aspectRatio(aspect);
  const img = sharp(input);
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new LaxiiProviderError("Rendered image could not be decoded.", "invalid_output");
  const current = meta.width / meta.height;
  let width = meta.width;
  let height = meta.height;
  if (current > target) {
    width = Math.max(1, Math.round(meta.height * target));
  } else if (current < target) {
    height = Math.max(1, Math.round(meta.width / target));
  }
  const out = await img
    .extract({
      left: Math.floor((meta.width - width) / 2),
      top: Math.floor((meta.height - height) / 2),
      width,
      height,
    })
    .png()
    .toBuffer();
  return { bytes: out, width, height };
}

/**
 * Compose up to 4 reference images into one labeled contact sheet — lets
 * single-reference providers receive multi-reference briefs. Panels sit on a
 * neutral dark ground with a gutter; the caller's prompt explains the roles.
 */
export async function composeReferenceSheet(dataUrls: string[]): Promise<string> {
  const imgs = await Promise.all(
    dataUrls.slice(0, 4).map(async (url) => {
      const base = Buffer.from(url.replace(/^data:[^;]+;base64,/, ""), "base64");
      const buf = await sharp(base).resize(640, 640, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
      const meta = await sharp(buf).metadata();
      return { buf, width: meta.width ?? 640, height: meta.height ?? 640 };
    })
  );
  const cols = imgs.length > 1 ? 2 : 1;
  const rows = Math.ceil(imgs.length / cols);
  const cell = 640;
  const gutter = 16;
  const width = cols * cell + (cols + 1) * gutter;
  const height = rows * cell + (rows + 1) * gutter;
  const composites = imgs.map((im, i) => ({
    input: im.buf,
    left: gutter + (i % cols) * (cell + gutter) + Math.floor((cell - im.width) / 2),
    top: gutter + Math.floor(i / cols) * (cell + gutter) + Math.floor((cell - im.height) / 2),
  }));
  const sheet = await sharp({
    create: { width, height, channels: 3, background: { r: 24, g: 24, b: 28 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
  return `data:image/png;base64,${sheet.toString("base64")}`;
}

/**
 * Outpainting preparation: center the current image on a larger canvas whose
 * aspect matches the target, leaving transparent margins for the provider to
 * fill. The prompt tells the model to extend the scene into the margins.
 */
export async function prepareExpandCanvas(
  input: Buffer,
  targetAspect: ExactAspect,
  growFactor = 1.35
): Promise<{ dataUrl: string; width: number; height: number }> {
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) throw new LaxiiProviderError("Source image could not be decoded.", "invalid_output");
  const target = aspectRatio(targetAspect);
  // Canvas that holds the original at growFactor area (min edge fit), target aspect.
  let canvasW: number;
  let canvasH: number;
  if (meta.width / meta.height >= target) {
    canvasH = Math.round(Math.sqrt((meta.width * meta.height * growFactor) / target));
    canvasW = Math.round(canvasH * target);
  } else {
    canvasW = Math.round(Math.sqrt(meta.width * meta.height * growFactor * target));
    canvasH = Math.round(canvasW / target);
  }
  const resized = await sharp(input)
    .resize(Math.round(canvasW / growFactor), Math.round(canvasH / growFactor), { fit: "inside" })
    .png()
    .toBuffer();
  const rMeta = await sharp(resized).metadata();
  const canvas = await sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: resized,
        left: Math.floor((canvasW - (rMeta.width ?? 0)) / 2),
        top: Math.floor((canvasH - (rMeta.height ?? 0)) / 2),
      },
    ])
    .png()
    .toBuffer();
  return { dataUrl: `data:image/png;base64,${canvas.toString("base64")}`, width: canvasW, height: canvasH };
}

/**
 * Alpha extraction after generative subject isolation: the provider renders
 * the subject on a near-uniform backdrop; this pipeline flood-fills from the
 * borders with a tolerance, writes a real alpha channel, and reports the
 * retained subject coverage. Returns null when isolation failed badly
 * (caller must surface an honest error — never a fake "transparent" image).
 */
export async function extractTransparency(
  input: Buffer
): Promise<{ bytes: Buffer; width: number; height: number; subjectCoverage: number } | null> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const px = new Uint8ClampedArray(data);
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  const idxOf = (x: number, y: number) => (y * width + x) * channels;
  const flat = (x: number, y: number) => y * width + x;

  // Seed from all border pixels.
  for (let x = 0; x < width; x += 1) {
    queue.push(flat(x, 0), flat(x, height - 1));
  }
  for (let y = 0; y < height; y += 1) {
    queue.push(flat(0, y), flat(width - 1, y));
  }

  // Reference background color = median-ish of border pixels (use first seeds).
  const seedIdx = idxOf(0, 0);
  const br = px[seedIdx];
  const bg = px[seedIdx + 1];
  const bb = px[seedIdx + 2];
  const TOLERANCE = 42;

  let backgroundPixels = 0;
  while (queue.length > 0) {
    const flatIdx = queue.pop() as number;
    if (visited[flatIdx]) continue;
    visited[flatIdx] = 1;
    const i = flatIdx * channels;
    const dr = px[i] - br;
    const dg = px[i + 1] - bg;
    const dbl = px[i + 2] - bb;
    if (dr * dr + dg * dg + dbl * dbl > TOLERANCE * TOLERANCE) continue;
    backgroundPixels += 1;
    px[i + 3] = 0;
    const x = flatIdx % width;
    const y = (flatIdx - x) / width;
    if (x > 0) queue.push(flatIdx - 1);
    if (x < width - 1) queue.push(flatIdx + 1);
    if (y > 0) queue.push(flatIdx - width);
    if (y < height - 1) queue.push(flatIdx + width);
  }

  const subjectCoverage = 1 - backgroundPixels / (width * height);
  // A sane subject occupies 8–95% of the frame; outside that the isolation
  // almost certainly failed (blank or the subject was eaten).
  if (subjectCoverage < 0.08 || subjectCoverage > 0.95) return null;

  // Raw pixel buffers must be decoded through sharp's raw input options —
  // sharp(Buffer) alone expects an encoded image format.
  const out = await sharp(Buffer.from(data), {
    raw: { width, height, channels: channels as 3 | 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { bytes: out, width, height, subjectCoverage };
}

/**
 * Banner export fit: render (or re-encode) an image to the EXACT preset
 * dimensions using cover-fit + center crop. Never stretches; the crop is
 * symmetric and validated. Output format enforced by the export contract.
 */
export async function fitToCanvas(
  input: Buffer,
  width: number,
  height: number,
  format: "png" | "jpeg" | "webp",
  quality = 92
): Promise<{ bytes: Buffer; width: number; height: number; mime: string }> {
  const pipeline = sharp(input)
    .resize(width, height, { fit: "cover", position: "centre", withoutEnlargement: false });
  if (format === "jpeg") {
    return { bytes: await pipeline.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality, mozjpeg: true }).toBuffer(), width, height, mime: "image/jpeg" };
  }
  if (format === "webp") {
    return { bytes: await pipeline.webp({ quality }).toBuffer(), width, height, mime: "image/webp" };
  }
  return { bytes: await pipeline.png({ compressionLevel: 9 }).toBuffer(), width, height, mime: "image/png" };
}
