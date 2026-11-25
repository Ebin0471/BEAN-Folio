/**
 * LAXII — local portrait segmentation/matting (M33.4-C).
 *
 * Runs the MODNet portrait-matting ONNX model LOCALLY (onnxruntime-node,
 * CPU) against the weights already pinned in this repository
 * (`data/laxii-models/Xenova/modnet/onnx/model.onnx`).
 *
 * Provenance and licence (verified 2026-11-25):
 *  - Weights: Xenova/modnet on Hugging Face at commit fa2fa546052fba4c08921230a26cc69a333fca12,
 *    model card declares Apache-2.0; the local file's sha256
 *    (07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9)
 *    equals the Hub LFS oid for onnx/model.onnx at that commit.
 *  - Upstream model: ZHKKKe/MODNet (Apache-2.0 licence including the
 *    released pretrained weights) — a commercial-use-permitted checkpoint,
 *    unlike the research-only InsightFace/InstantID families the guide
 *    prohibits.
 *  - Runtime: onnxruntime-node (MIT). No ComfyUI/GPL code is involved.
 *
 * Privacy: segmentation is fully local. Protected subject pixels NEVER
 * leave the process through this module — the background plate generation
 * path sends a text prompt only (see avatar-identity.ts).
 *
 * Honesty: a mask that fails the documented sanity bounds is an ERROR, not
 * a degraded output — the caller must fail the job (guide §6.1: "If the
 * required mask cannot be produced ... stop and explain why").
 */
import path from "node:path";

import sharp from "sharp";

export interface PortraitMatte {
  /** Alpha values in [0,1], row-major, matteWidth×matteHeight. */
  alpha: Float32Array;
  width: number;
  height: number;
  /** Fraction of pixels with alpha > 0.5 (measured, not assumed). */
  coverage: number;
}

/** Documented mask sanity bounds — outside them the mask is "uncertain". */
export const MASK_BOUNDS = {
  /** Minimum plausible subject share of the frame (below: segmentation failed). */
  minCoverage: 0.02,
  /** Maximum plausible subject share (above: the mask is suspiciously full). */
  maxCoverage: 0.92,
  /** Minimum subject bounding-box share of frame area. */
  minBboxArea: 0.01,
} as const;

let sessionPromise: Promise<import("onnxruntime-node").InferenceSession> | null = null;

function modelPath(): string {
  return path.resolve(process.cwd(), "data", "laxii-models", "Xenova", "modnet", "onnx", "model.onnx");
}

async function getSession(): Promise<import("onnxruntime-node").InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await import("onnxruntime-node");
      return ort.InferenceSession.create(modelPath(), {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      });
    })();
  }
  return sessionPromise;
}

/**
 * Run MODNet on a decoded image and return the portrait alpha matte at the
 * model's resolution. Deterministic, CPU-only, no network.
 */
export async function runPortraitMatte(input: Buffer): Promise<PortraitMatte> {
  const ort = await import("onnxruntime-node");
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) throw new Error("segmentation: image could not be decoded");
  // Preprocess per the pinned preprocessor_config.json: resize so the
  // shortest edge is 512, pad/round to a 32px divisibility, rescale 1/255,
  // normalize mean/std 0.5.
  const shortest = Math.min(meta.width, meta.height);
  const scale = 512 / shortest;
  let w = Math.max(32, Math.round((meta.width * scale) / 32) * 32);
  let h = Math.max(32, Math.round((meta.height * scale) / 32) * 32);
  w = Math.min(w, 2048);
  h = Math.min(h, 2048);
  const { data, info } = await sharp(input)
    .removeAlpha()
    .resize(w, h, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = info.width * info.height;
  const planar = new Float32Array(3 * plane);
  for (let i = 0, px = 0; i < plane; i += 1, px += info.channels) {
    planar[i] = (data[px] / 255 - 0.5) / 0.5;
    planar[plane + i] = (data[px + 1] / 255 - 0.5) / 0.5;
    planar[2 * plane + i] = (data[px + 2] / 255 - 0.5) / 0.5;
  }
  const session = await getSession();
  const feeds: Record<string, import("onnxruntime-node").Tensor> = {};
  feeds[session.inputNames[0]] = new ort.Tensor("float32", planar, [1, 3, info.height, info.width]);
  const out = await session.run(feeds);
  const matte = out[session.outputNames[0]];
  let above = 0;
  const matteData = matte.data as Float32Array;
  for (let i = 0; i < matteData.length; i += 1) if (matteData[i] > 0.5) above += 1;
  return {
    alpha: Float32Array.from(matteData),
    width: matte.dims[matte.dims.length - 1],
    height: matte.dims[matte.dims.length - 2],
    coverage: above / matte.data.length,
  };
}

export interface MaskValidation {
  ok: boolean;
  reason: string | null;
  coverage: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  bboxArea: number;
}

/**
 * Validate a matte against the documented sanity bounds. An invalid mask is
 * an uncertain mask — the pipeline must fail closed, never export.
 */
export function validateMask(matte: PortraitMatte, bounds: typeof MASK_BOUNDS = MASK_BOUNDS): MaskValidation {
  const { alpha, width, height, coverage } = matte;
  const total = width * height;
  if (total === 0) return { ok: false, reason: "mask is empty", coverage, bbox: null, bboxArea: 0 };
  if (coverage < bounds.minCoverage) {
    return { ok: false, reason: `subject coverage ${coverage.toFixed(4)} is below the minimum ${bounds.minCoverage} — the segmentation almost certainly failed`, coverage, bbox: null, bboxArea: 0 };
  }
  if (coverage > bounds.maxCoverage) {
    return { ok: false, reason: `subject coverage ${coverage.toFixed(4)} is above the maximum ${bounds.maxCoverage} — the mask is suspiciously full`, coverage, bbox: null, bboxArea: 0 };
  }
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alpha[y * width + x] > 0.5) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    return { ok: false, reason: "no confident subject pixels in the matte", coverage, bbox: null, bboxArea: 0 };
  }
  const bbox = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const bboxArea = (bbox.width * bbox.height) / total;
  if (bboxArea < bounds.minBboxArea) {
    return { ok: false, reason: `subject bounding box covers only ${(bboxArea * 100).toFixed(2)}% of the frame — uncertain mask`, coverage, bbox, bboxArea };
  }
  return { ok: true, reason: null, coverage, bbox, bboxArea };
}

/**
 * Detect a PERSON in a generated background plate: a portrait-matting model
 * run over a clean scene returns a near-empty matte; a plate containing a
 * person returns a substantial one. This is the (ported, documented) gate
 * that rejects generated scenes containing unwanted humans.
 */
export async function plateContainsPerson(plateBytes: Buffer): Promise<{ contains: boolean; coverage: number }> {
  const matte = await runPortraitMatte(plateBytes);
  return { contains: matte.coverage > MASK_BOUNDS.minCoverage, coverage: matte.coverage };
}

/**
 * Resize a matte (model resolution) to the target canvas with the SAME
 * transform the subject pixels get (a uniform resize here, since the
 * identity pipeline maps the subject 1:1 to a canvas of the source's own
 * dimensions — see avatar-identity.ts).
 */
export async function resizeMatteToCanvas(
  matte: PortraitMatte,
  targetW: number,
  targetH: number
): Promise<{ alpha: Float32Array; width: number; height: number }> {
  const raw = Buffer.alloc(matte.width * matte.height * 4);
  for (let i = 0; i < matte.width * matte.height; i += 1) {
    const a = Math.max(0, Math.min(255, Math.round(matte.alpha[i] * 255)));
    raw[i * 4] = 255;
    raw[i * 4 + 1] = 255;
    raw[i * 4 + 2] = 255;
    raw[i * 4 + 3] = a;
  }
  const upscaled = await sharp(raw, { raw: { width: matte.width, height: matte.height, channels: 4 } })
    .resize(targetW, targetH, { fit: "fill" })
    .extractChannel(3)
    .raw()
    .toBuffer();
  const alpha = new Float32Array(targetW * targetH);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = upscaled[i] / 255;
  return { alpha, width: targetW, height: targetH };
}
