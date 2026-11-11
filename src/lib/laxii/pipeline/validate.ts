import sharp from "sharp";
import type { SizeRequest } from "../types";
import { LaxiiError } from "../types";
import type { PreserveMapping } from "./compose";

/**
 * LAXII composite validation — numeric verification that a preserved-pixel
 * composite REALLY satisfies the spec equation before it may be exported:
 *
 *   output = original_subject × alpha + generated_background × (1 − alpha)
 *
 * Checks, all measured on raw pixels (§5 of the compositing spec):
 *   1. exact output dimensions,
 *   2. fully opaque result (no transparent holes),
 *   3. OUTSIDE the subject mask the pixels equal the generated plate
 *      (catches ghosted original background, duplicated reference layers,
 *      mask leakage, wrong layer order),
 *   4. INSIDE the mask core the pixels equal the mapped original frame
 *      (catches double-compositing, luminance tampering, wrong scaling),
 *   5. the feather ramp is confined to the mask boundary by construction
 *      (the inside/outside gates are sampled where alpha ≤0.02 / ≥0.98).
 *
 * A failed check THROWS — the job fails honestly instead of exporting a
 * defective image. Tolerances (mean |Δ| ≤ 2/255, outliers > 24 below 0.2%)
 * exist only for 8-bit rounding, never for visible artifacts.
 */

const OUTSIDE_ALPHA = 0.02; // ≤ → generated-background territory
const INSIDE_ALPHA = 0.98; // ≥ → preserved-pixel core
const MEAN_TOLERANCE = 2.0; // /255
const OUTLIER_DELTA = 24; // /255
const OUTLIER_FRACTION = 0.002;

export interface CompositeVerification {
  outsideMeanDelta: number;
  insideMeanDelta: number;
  outsideOutlierPct: number;
  insideOutlierPct: number;
  minAlpha: number;
  sampled: number;
}

export async function verifyPreserveComposite(opts: {
  composited: Buffer;
  plate: Buffer;
  originalFrame: Buffer;
  mapping: PreserveMapping;
  /** The dest-in mask actually used for the composite (RGBA png). */
  mask: Buffer;
  target: SizeRequest;
}): Promise<CompositeVerification> {
  const W = opts.target.width;
  const H = opts.target.height;

  // 1. dimensions
  const meta = await sharp(opts.composited).metadata();
  if ((meta.width ?? 0) !== W || (meta.height ?? 0) !== H) {
    throw new LaxiiError(`Composite validation failed: produced ${meta.width}x${meta.height}, expected ${W}x${H}`);
  }

  const [out, plate, maskRaw] = await Promise.all([
    sharp(opts.composited).ensureAlpha().raw().toBuffer(),
    sharp(opts.plate).ensureAlpha().raw().toBuffer(),
    sharp(opts.mask).ensureAlpha().raw().toBuffer(),
  ]);
  const mappedOriginal = await sharp(opts.originalFrame)
    .extract(opts.mapping.crop)
    .resize(W, H, { fit: "fill", kernel: "lanczos3" })
    .removeAlpha()
    .raw()
    .toBuffer();

  // 3 (prep). opacity: the composite must have no transparent holes
  let minAlpha = 255;
  for (let i = 3; i < out.length; i += 4) if (out[i] < minAlpha) minAlpha = out[i];
  if (minAlpha < 255) {
    throw new LaxiiError(`Composite validation failed: output is not fully opaque (min alpha ${minAlpha}/255 — transparent holes)`);
  }

  let outsideSum = 0;
  let outsideN = 0;
  let outsideOutliers = 0;
  let insideSum = 0;
  let insideN = 0;
  let insideOutliers = 0;
  let sampled = 0;

  const stride = 2; // sample every 2nd pixel — plenty of coverage, half the cost
  for (let y = 0; y < H; y += stride) {
    for (let x = 0; x < W; x += stride) {
      const p = (y * W + x) * 4;
      const p3 = (y * W + x) * 3; // mappedOriginal is RGB (3 channels)
      const a = maskRaw[p + 3] / 255;
      sampled++;
      if (a <= OUTSIDE_ALPHA) {
        const d = Math.abs(out[p] - plate[p]) + Math.abs(out[p + 1] - plate[p + 1]) + Math.abs(out[p + 2] - plate[p + 2]);
        outsideSum += d / 3;
        outsideN++;
        if (d / 3 > OUTLIER_DELTA) outsideOutliers++;
      } else if (a >= INSIDE_ALPHA) {
        const d =
          Math.abs(out[p] - mappedOriginal[p3]) +
          Math.abs(out[p + 1] - mappedOriginal[p3 + 1]) +
          Math.abs(out[p + 2] - mappedOriginal[p3 + 2]);
        insideSum += d / 3;
        insideN++;
        if (d / 3 > OUTLIER_DELTA) insideOutliers++;
      }
      // else: feather ramp — the documented boundary blend zone, skipped.
    }
  }

  if (!outsideN || !insideN) {
    throw new LaxiiError("Composite validation failed: subject mask has no usable outside/inside regions");
  }

  const outsideMeanDelta = outsideSum / outsideN;
  const insideMeanDelta = insideSum / insideN;
  const outsideOutlierPct = outsideOutliers / outsideN;
  const insideOutlierPct = insideOutliers / insideN;

  if (outsideMeanDelta > MEAN_TOLERANCE || outsideOutlierPct > OUTLIER_FRACTION) {
    throw new LaxiiError(
      `Composite validation failed: the generated background was altered or the original photo leaked outside the subject (mean Δ ${outsideMeanDelta.toFixed(2)}/255, outliers ${(outsideOutlierPct * 100).toFixed(2)}%). The job was rejected instead of exporting a defective image.`
    );
  }
  if (insideMeanDelta > MEAN_TOLERANCE || insideOutlierPct > OUTLIER_FRACTION) {
    throw new LaxiiError(
      `Composite validation failed: preserved subject pixels were modified during compositing (mean Δ ${insideMeanDelta.toFixed(2)}/255, outliers ${(insideOutlierPct * 100).toFixed(2)}%). The job was rejected instead of exporting a defective image.`
    );
  }

  return {
    outsideMeanDelta: round2(outsideMeanDelta),
    insideMeanDelta: round2(insideMeanDelta),
    outsideOutlierPct: round4(outsideOutlierPct),
    insideOutlierPct: round4(insideOutlierPct),
    minAlpha,
    sampled,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
