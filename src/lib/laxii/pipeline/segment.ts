import path from "path";
import { existsSync } from "fs";
import sharp from "sharp";
import { LaxiiError } from "../types";
import type { Tensor } from "@huggingface/transformers";

/**
 * LAXII local subject-segmentation stack (§3 of the compositing spec).
 *
 * Model: Xenova/modnet — portrait alpha matting.
 *   - Upstream model: ZHKKKe/MODNet, Apache-2.0 (verified: repo LICENSE).
 *   - ONNX port:      huggingface.co/Xenova/modnet, license apache-2.0
 *                     (verified: model card metadata).
 *   - Runtime:        @huggingface/transformers (Apache-2.0), onnxruntime-node
 *                     CPU inference — no GPU, no paid API.
 *
 * Weights are prefetched into `data/laxii-models/` with
 * `bun ./scripts/laxii/prefetch-models.ts`. Jobs NEVER download at generation
 * time; if the cache is missing the stack reports unavailable and the engine
 * fails honestly (or falls back to the user's manually marked subject window)
 * instead of exporting a defective composite.
 *
 * The matte decides subject pixels ONLY. It is never logged, never persisted
 * into job params, and never used for anything besides the compositing
 * equation (privacy §7).
 */

const MODEL_ID = "Xenova/modnet";
export const MODEL_CACHE_DIR = path.resolve(process.cwd(), "data", "laxii-models");

/** Confidence gates — outside these bounds the matte is not trustworthy. */
export const MIN_COVERAGE = 0.015; // <1.5% of frame → subject not detected
export const MAX_COVERAGE = 0.85; // >85% of frame → segmentation unreliable

/** Callable functional model — transformers.js PreTrainedModel instances are
 *  callable; this structural type keeps the real module out of the graph. */
type ModnetModel = (input: { input: unknown }) => Promise<{ output: unknown[] }>;
type Processor = (image: unknown) => Promise<{ pixel_values: unknown }>;

let loaded: Promise<{ model: ModnetModel; processor: Processor }> | null = null;

/** Cheap, truthful availability check: env kill-switch + cached weights on disk. */
export function segmentationAvailable(): { ok: boolean; reason?: string } {
  if (process.env.LAXII_DISABLE_SEGMENTATION === "1") {
    return { ok: false, reason: "disabled via LAXII_DISABLE_SEGMENTATION" };
  }
  const onnx = path.join(MODEL_CACHE_DIR, "Xenova", "modnet", "onnx", "model.onnx"); // fp32 (default)
  const quant = path.join(MODEL_CACHE_DIR, "Xenova", "modnet", "onnx", "model_quantized.onnx");
  if (!existsSync(onnx) && !existsSync(quant)) {
    return { ok: false, reason: `model weights not cached (run: bun ./scripts/laxii/prefetch-models.ts — expected ${onnx})` };
  }
  return { ok: true };
}

async function loadModel(): Promise<{ model: ModnetModel; processor: Processor }> {
  if (!loaded) {
    loaded = (async () => {
      const tf = await import("@huggingface/transformers");
      tf.env.cacheDir = MODEL_CACHE_DIR;
      tf.env.localModelPath = MODEL_CACHE_DIR;
      const [model, processor] = await Promise.all([
        tf.AutoModel.from_pretrained(MODEL_ID, { dtype: "fp32" }),
        tf.AutoProcessor.from_pretrained(MODEL_ID),
      ]);
      return { model: model as unknown as ModnetModel, processor: processor as unknown as Processor };
    })().catch((e) => {
      loaded = null; // allow a retry on the next job
      throw new LaxiiError(`Subject segmentation model failed to load: ${e instanceof Error ? e.message : "unknown error"}`);
    });
  }
  return loaded;
}

export interface SubjectMatte {
  /** Grayscale alpha (0–255), raw single channel, width×height. */
  alpha: Buffer;
  width: number;
  height: number;
  /** Fraction of the frame with alpha > 0.5 (confidence signal). */
  coverage: number;
  /** Alpha-weighted centroid, normalized 0–1 — the subject's visual center. */
  centroid: { x: number; y: number };
  /** Alpha-weighted bounding box, normalized 0–1. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Compute the subject alpha matte for a normalized source frame.
 * Throws LaxiiError when the stack is unavailable — the engine decides
 * between the manual-window fallback and an honest failure.
 */
export async function subjectMatte(normalizedPng: Buffer): Promise<SubjectMatte> {
  const av = segmentationAvailable();
  if (!av.ok) throw new LaxiiError(`Subject segmentation is unavailable: ${av.reason}`);

  const meta = await sharp(normalizedPng).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new LaxiiError("Reference image has no dimensions");

  const { model, processor } = await loadModel();

  // Feed the model RGB pixels through RawImage (constructed directly from
  // decoded raw pixels — no temp files, no URLs, nothing leaves the process).
  const { RawImage } = await import("@huggingface/transformers");
  const rgb = await sharp(normalizedPng).removeAlpha().raw().toBuffer();
  const image = new RawImage(new Uint8Array(rgb), width, height, 3);

  const { pixel_values } = await processor(image);
  const { output } = await model({ input: pixel_values });

  // Matte: 1×1×S×S tensor (0..1) → grayscale at the source dims.
  const first = output[0] as { mul(n: number): { to(t: string): Tensor } };
  const tfModule = await import("@huggingface/transformers");
  const matteImage = await tfModule.RawImage.fromTensor(first.mul(255).to("uint8")).resize(width, height);

  const alpha = Buffer.from(matteImage.data);
  if (alpha.length !== width * height) {
    throw new LaxiiError("Subject segmentation returned an unexpected mask size");
  }

  // Coverage + centroid + bbox (alpha-weighted, thresholded at 0.5).
  let cov = 0;
  let mass = 0;
  let sx = 0;
  let sy = 0;
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = alpha[y * width + x];
      if (a > 127) cov++;
      if (a > 8) {
        const w = a / 255;
        mass += w;
        sx += w * x;
        sy += w * y;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  const coverage = cov / (width * height);
  const centroid = mass > 0 ? { x: sx / mass / width, y: sy / mass / height } : { x: 0.5, y: 0.5 };
  const bbox =
    mass > 0
      ? { x0: x0 / width, y0: y0 / height, x1: (x1 + 1) / width, y1: (y1 + 1) / height }
      : { x0: 0, y0: 0, x1: 1, y1: 1 };

  return { alpha, width, height, coverage, centroid, bbox };
}

/** Human-readable reason when the matte fails the confidence gate. */
export function matteConfidenceError(coverage: number): LaxiiError {
  if (coverage < MIN_COVERAGE) {
    return new LaxiiError(
      "Subject segmentation confidence is too low — no clear subject was detected in the reference photo. Upload a clearer photo where the subject is visible, or mark the subject window manually in Profile Studio and retry."
    );
  }
  return new LaxiiError(
    "Subject segmentation confidence is too low — the detected subject covers almost the entire photo, so the background could not be identified reliably. Use a photo with some distance around the subject, or mark a tighter subject window in Profile Studio."
  );
}

/** A PRESERVE backdrop must be person-free above this fraction of the frame. */
export const PLATE_PERSON_MAX = 0.04;

// ------------------------------------------------------------------ plate person gate (§5)

/**
 * Shape analysis of a thresholded alpha mask, computed on a downsampled grid
 * (≤256×256) so it stays cheap even on 4K plates. These statistics let the
 * engine INSPECT the actual mask before rejecting a plate — MODNet is a
 * portrait-matting model, not a person classifier, and it can light up on
 * plants, furniture or strong textures (false positives).
 */
export interface MaskShape {
  /** Fraction of the frame above threshold (grid-level). */
  coverage: number;
  /** Number of 4-connected foreground components on the sampled grid. */
  components: number;
  /** Largest component mass / total foreground mass (0–1). */
  largestShare: number;
  /** Largest-component bbox height / width (a standing figure is ≥ ~1). */
  aspect: number;
  /** Largest-component bbox height / frame height. */
  heightFraction: number;
  /** Foreground cells within 3% of the frame border / total foreground. */
  borderShare: number;
}

/** What the plate gate decided — and why (recorded in job diagnostics). */
export type PlateDecision = "clean" | "person" | "false-positive";

export interface PlateAssessment {
  decision: PlateDecision;
  /** MODNet coverage of the full-resolution plate. */
  coverage: number;
  shape: MaskShape;
  /** Skin-tone pixels found inside the high-alpha region. */
  skinEvidence: boolean;
  /** Human-readable, log-safe reason for the decision. */
  reason: string;
  /** Raw alpha (grayscale, width×height) — diagnostics only, never logged. */
  alpha: Buffer;
  width: number;
  height: number;
}

/** Thresholds that make a flagged mask look like an actual human figure. */
const PERSON_MIN_LARGEST_SHARE = 0.6; // one dominant connected blob
const PERSON_MIN_ASPECT = 0.85; // roughly taller than wide
const PERSON_MIN_HEIGHT = 0.3; // spans a meaningful part of the frame
const PERSON_MAX_BORDER_SHARE = 0.3; // not smeared along the frame edges

/**
 * Downsample + threshold the alpha, then measure the mask's connected
 * structure. Deterministic, allocation-light, no model calls.
 */
export function analyzeMaskShape(alpha: Buffer, width: number, height: number): MaskShape {
  if (!width || !height || alpha.length < width * height) {
    return { coverage: 0, components: 0, largestShare: 0, aspect: 0, heightFraction: 0, borderShare: 0 };
  }
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 256));
  const gw = Math.max(1, Math.floor((width - 1) / step) + 1);
  const gh = Math.max(1, Math.floor((height - 1) / step) + 1);
  const grid = new Uint8Array(gw * gh);
  let fg = 0;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (alpha[gy * step * width + gx * step] > 127) {
        grid[gy * gw + gx] = 1;
        fg++;
      }
    }
  }
  const total = gw * gh;
  const coverage = fg / total;
  if (fg === 0) return { coverage, components: 0, largestShare: 0, aspect: 0, heightFraction: 0, borderShare: 0 };

  // 4-connected components (iterative flood fill — no recursion on 65k cells).
  const seen = new Uint8Array(gw * gh);
  const stack: number[] = [];
  let largest = 0;
  let largestBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  let components = 0;
  const borderBand = Math.max(1, Math.round(0.03 * Math.max(gw, gh)));
  let borderFg = 0;
  for (let start = 0; start < gw * gh; start++) {
    if (!grid[start] || seen[start]) continue;
    components++;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let mass = 0;
    let x0 = gw;
    let y0 = gh;
    let x1 = 0;
    let y1 = 0;
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const cx = idx % gw;
      const cy = (idx - cx) / gw;
      mass++;
      if (cx < x0) x0 = cx;
      if (cy < y0) y0 = cy;
      if (cx > x1) x1 = cx;
      if (cy > y1) y1 = cy;
      if (cx < borderBand || cy < borderBand || cx >= gw - borderBand || cy >= gh - borderBand) borderFg++;
      if (cx > 0 && grid[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack.push(idx - 1); }
      if (cx < gw - 1 && grid[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack.push(idx + 1); }
      if (cy > 0 && grid[idx - gw] && !seen[idx - gw]) { seen[idx - gw] = 1; stack.push(idx - gw); }
      if (cy < gh - 1 && grid[idx + gw] && !seen[idx + gw]) { seen[idx + gw] = 1; stack.push(idx + gw); }
    }
    if (mass > largest) {
      largest = mass;
      largestBox = { x0, y0, x1, y1 };
    }
  }
  const bw = largestBox.x1 - largestBox.x0 + 1;
  const bh = largestBox.y1 - largestBox.y0 + 1;
  return {
    coverage,
    components,
    largestShare: largest / fg,
    aspect: bh / bw,
    heightFraction: bh / gh,
    borderShare: borderFg / fg,
  };
}

/**
 * Decide whether a flagged mask is an actual PERSON.
 *
 * Conservative by design: when the evidence is ambiguous the plate is
 * treated as a person (regenerate) — a false rejection costs one retry,
 * a missed person ships a stranger behind the preserved subject.
 * Human-SHAPED objects (statues, mannequins) are person-like here and are
 * therefore rejected too.
 */
export function decidePlatePerson(
  shape: MaskShape,
  skinEvidence: boolean
): { decision: Exclude<PlateDecision, "clean">; reason: string } {
  const personLike =
    shape.largestShare >= PERSON_MIN_LARGEST_SHARE &&
    shape.aspect >= PERSON_MIN_ASPECT &&
    shape.heightFraction >= PERSON_MIN_HEIGHT &&
    shape.borderShare <= PERSON_MAX_BORDER_SHARE;
  if (personLike || skinEvidence) {
    return {
      decision: "person",
      reason: personLike
        ? `mask is figure-shaped (dominant blob ${(shape.largestShare * 100).toFixed(0)}% of mass, h/w ${shape.aspect.toFixed(2)}, height ${(shape.heightFraction * 100).toFixed(0)}% of frame)`
        : "skin tones found inside the flagged region",
    };
  }
  return {
    decision: "false-positive",
    reason: `mask is not figure-shaped (${shape.components} fragments, dominant blob only ${(shape.largestShare * 100).toFixed(0)}% of mass, h/w ${shape.aspect.toFixed(2)}, border ${(shape.borderShare * 100).toFixed(0)}%) and no skin tones inside it`,
  };
}

/** Classic RGB skin-tone screen, sampled sparsely for speed. */
function looksLikeSkin(r: number, g: number, b: number): boolean {
  return r > 70 && g > 30 && b > 15 && r > g && g >= b * 0.8 && r - Math.min(g, b) > 10 && r - g > 8;
}

/** Look for skin-tone pixels inside the confident mask region (alpha > 200). */
async function skinEvidenceInMask(imagePng: Buffer, matte: SubjectMatte): Promise<boolean> {
  const { data, info } = await sharp(imagePng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const channels = info.channels;
  let sampled = 0;
  let skin = 0;
  const stride = Math.max(1, Math.floor((w * h) / 24000));
  for (let i = 0; i < w * h; i += stride) {
    if (matte.alpha[i] <= 200) continue;
    sampled++;
    if (looksLikeSkin(data[i * channels], data[i * channels + 1], data[i * channels + 2])) skin++;
  }
  return sampled > 0 && skin / sampled > 0.04;
}

/**
 * Full plate assessment (§5 quality gate): MODNet matte → coverage gate →
 * inspect the actual mask shape + skin evidence before rejecting. A plate is
 * accepted only as "clean" (low coverage) or as a proven "false-positive"
 * (flagged by the matte but demonstrably not a person). Everything else —
 * including any ambiguous case — is rejected as a person.
 */
export async function assessPlate(imagePng: Buffer): Promise<PlateAssessment> {
  const matte = await subjectMatte(imagePng);
  const shape = analyzeMaskShape(matte.alpha, matte.width, matte.height);
  if (matte.coverage <= PLATE_PERSON_MAX) {
    return {
      decision: "clean",
      coverage: matte.coverage,
      shape,
      skinEvidence: false,
      reason: `person coverage ${(matte.coverage * 100).toFixed(2)}% is under the ${(PLATE_PERSON_MAX * 100).toFixed(0)}% gate`,
      alpha: matte.alpha,
      width: matte.width,
      height: matte.height,
    };
  }
  const skin = await skinEvidenceInMask(imagePng, matte);
  const { decision, reason } = decidePlatePerson(shape, skin);
  return {
    decision,
    coverage: matte.coverage,
    shape,
    skinEvidence: skin,
    reason,
    alpha: matte.alpha,
    width: matte.width,
    height: matte.height,
  };
}
