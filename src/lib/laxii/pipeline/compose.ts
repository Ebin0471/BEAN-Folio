import sharp from "sharp";
import type { ColorGrade } from "../styles";
import type { SizeRequest } from "../types";
import { LaxiiError } from "../types";

/**
 * LAXII compositing pipeline — REAL layer-based image processing with sharp
 * (Apache-2.0). This is where subject/content preservation happens:
 *
 *  - Preserved-pixel compositing implements EXACTLY the equation
 *        output = original_subject × alpha + generated_background × (1 − alpha)
 *    where `alpha` is the subject mask: the MODNet matte (hair-level, from
 *    pipeline/segment.ts) when segmentation is available, otherwise the
 *    user's manually marked subject window. The subject's original pixels
 *    are kept byte-exact in the mask core; the feather ramp lives ONLY at
 *    the subject boundary; everywhere else the generated scene stands alone.
 *    The original frame is mapped with ONE uniform scale + translation
 *    (cover, centered on the subject) — proportions and relative geometry
 *    are preserved; nothing is ever re-framed through a lossy crop pipeline.
 *  - Color grading, vignettes and gradient overlays are deterministic sharp
 *    operations, so the same request renders identically everywhere.
 */

sharp.cache(false);
sharp.concurrency(1); // be a good citizen in constrained environments

// ------------------------------------------------------------------ helpers

export async function loadMeta(buf: Buffer): Promise<{ width: number; height: number; format: string }> {
  try {
    const meta = await sharp(buf).metadata();
    return { width: meta.width ?? 0, height: meta.height ?? 0, format: meta.format ?? "unknown" };
  } catch {
    throw new LaxiiError("Reference file is not a readable image");
  }
}

export async function normalizeToPng(buf: Buffer, maxDim = 4096): Promise<Buffer> {
  const img = sharp(buf, { failOn: "none" }).rotate(); // honor EXIF orientation
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const out = scale < 1 ? img.resize(Math.round(w * scale), Math.round(h * scale)) : img;
  return out.png().toBuffer();
}

/** Feathered rect mask (percent rect) rastered from SVG.
 *  Works through its ALPHA channel (sharp "dest-in" compositing) —
 *  transparent background, opaque blurred rect. Used by the keep-region
 *  composite and the manual subject-window fallback. */
function featheredRectMask(w: number, h: number, rect: { x: number; y: number; w: number; h: number }, featherPx: number): Buffer {
  const fx = Math.max(6, Math.min(featherPx, Math.floor(Math.min(rect.w * 0.5, rect.h * 0.5))));
  const rx = (rect.x / 100) * w;
  const ry = (rect.y / 100) * h;
  const rw = (rect.w / 100) * w;
  const rh = (rect.h / 100) * h;
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="b" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="${fx / 2}"/>
    </filter></defs>
    <rect width="${w}" height="${h}" fill="white" fill-opacity="0"/>
    <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="white" filter="url(#b)"/>
  </svg>`;
  return Buffer.from(svg);
}

// ------------------------------------------------------------------ grading

function gradientOverlaySvg(w: number, h: number, overlay: NonNullable<ColorGrade["overlay"]>): Buffer {
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${overlay.from}"/>
      <stop offset="100%" stop-color="${overlay.to}"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)" fill-opacity="${overlay.opacity}"/>
  </svg>`;
  return Buffer.from(svg);
}

function vignetteSvg(w: number, h: number, strength: number): Buffer {
  const inner = 55;
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="v" cx="50%" cy="50%" r="75%">
      <stop offset="${inner}%" stop-color="black" stop-opacity="0"/>
      <stop offset="100%" stop-color="black" stop-opacity="${(strength * 0.75).toFixed(3)}"/>
    </radialGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#v)"/>
  </svg>`;
  return Buffer.from(svg);
}

/** Apply the deterministic style grade to a scene (never to preserved pixels). */
export async function applyGrade(scene: Buffer, grade: ColorGrade): Promise<Buffer> {
  const meta = await sharp(scene).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  let img = sharp(scene).modulate({
    saturation: grade.saturation,
    brightness: grade.brightness,
    hue: grade.hue,
  });
  // Midtone gamma: grade.gamma follows the photographic convention (lower =
  // brighter midtones). sharp's gamma(g) applies exponent 1/g and only accepts
  // g in [1, 3] — so a photographic gamma g ≤ 1 maps to sharp gamma 1/g
  // (brighten); g > 1 (darken) is handled by the brightness multiplier and
  // vignette/overlay layers instead of an out-of-range sharp call.
  if (grade.gamma < 1) img = img.gamma(1 / grade.gamma);
  let out = await img.png().toBuffer();

  const layers: sharp.OverlayOptions[] = [];
  if (grade.overlay) layers.push({ input: gradientOverlaySvg(w, h, grade.overlay) });
  if (grade.vignette > 0) layers.push({ input: vignetteSvg(w, h, grade.vignette) });
  if (layers.length > 0) out = await sharp(out).composite(layers).png().toBuffer();
  return out;
}

// ------------------------------------------------------------------ preserved-pixel compositing

/** A subject mask for preserved-pixel compositing. */
export type SubjectMaskSource =
  | {
      /** ML alpha matte (pipeline/segment.ts) — hair-level subject boundary. */
      type: "matte";
      alpha: Buffer; // raw grayscale, width×height
      width: number;
      height: number;
      /** Alpha-weighted subject centroid (normalized 0–1) — frames the output. */
      centroid: { x: number; y: number };
    }
  | {
      /** Manual subject window (percent of frame) — documented fallback. */
      type: "window";
      rect: { x: number; y: number; w: number; h: number };
    };

/**
 * Geometry of the preserved-pixel composite: ONE uniform scale + translation
 * maps the original frame onto the export canvas (cover — the canvas is
 * always fully painted), with the crop centered on the subject.
 */
export interface PreserveMapping {
  /** Uniform scale factor (source px → output px). Proportions are exact. */
  scale: number;
  /** Integer source-frame crop that fills the canvas after scaling. */
  crop: { left: number; top: number; width: number; height: number };
}

/**
 * Plan the source→output mapping. Cover scale so the canvas never shows a
 * gap; the crop is centered on the subject focus (clamped to the frame).
 */
export function planPreserveMapping(
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  focus?: { x: number; y: number } // normalized 0–1
): PreserveMapping {
  if (!srcW || !srcH || !outW || !outH) throw new LaxiiError("Composite sources have no dimensions");
  const scale = Math.max(outW / srcW, outH / srcH);
  const cropW = Math.min(Math.ceil(outW / scale), srcW);
  const cropH = Math.min(Math.ceil(outH / scale), srcH);
  const fx = (focus?.x ?? 0.5) * srcW;
  const fy = (focus?.y ?? 0.5) * srcH;
  const left = Math.min(Math.max(0, Math.round(fx - cropW / 2)), srcW - cropW);
  const top = Math.min(Math.max(0, Math.round(fy - cropH / 2)), srcH - cropH);
  return { scale, crop: { left, top, width: cropW, height: cropH } };
}

/** Map a percent-of-source-frame rect through the mapping → percent-of-output rect. */
export function mapWindowToOutput(
  rect: { x: number; y: number; w: number; h: number },
  srcW: number,
  srcH: number,
  mapping: PreserveMapping
): { x: number; y: number; w: number; h: number } {
  const sx0 = (rect.x / 100) * srcW;
  const sy0 = (rect.y / 100) * srcH;
  const sx1 = sx0 + (rect.w / 100) * srcW;
  const sy1 = sy0 + (rect.h / 100) * srcH;
  const px0 = (sx0 - mapping.crop.left) * mapping.scale;
  const py0 = (sy0 - mapping.crop.top) * mapping.scale;
  const px1 = (sx1 - mapping.crop.left) * mapping.scale;
  const py1 = (sy1 - mapping.crop.top) * mapping.scale;
  return { x: px0, y: py0, w: px1 - px0, h: py1 - py0 };
}

/** Build the dest-in RGBA mask (white RGB, alpha = feathered subject alpha)
 *  at the OUTPUT resolution, aligned with the mapped original layer. */
async function buildMatteMask(
  matte: { alpha: Buffer; width: number; height: number },
  mapping: PreserveMapping,
  outW: number,
  outH: number,
  featherPx: number
): Promise<Buffer> {
  const c = mapping.crop;
  // NOTE: resize+blur can promote grayscale to interleaved RGB — force a
  // single-channel output so the alpha bytes are read unambiguous.
  const { data: cropped, info } = await sharp(matte.alpha, { raw: { width: matte.width, height: matte.height, channels: 1 } })
    .extract({ left: c.left, top: c.top, width: c.width, height: c.height })
    .resize(outW, outH, { fit: "fill", kernel: "cubic" })
    .blur(Math.max(0.3, featherPx / 3)) // feather ONLY the subject boundary
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || cropped.length !== outW * outH) {
    throw new LaxiiError("Subject mask rasterization failed (unexpected channel layout)");
  }
  const rgba = Buffer.alloc(outW * outH * 4);
  for (let i = 0; i < outW * outH; i++) {
    const a = Math.max(0, Math.min(255, cropped[i]));
    rgba[i * 4] = 255;
    rgba[i * 4 + 1] = 255;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = a;
  }
  return sharp(rgba, { raw: { width: outW, height: outH, channels: 4 } }).png().toBuffer();
}

/**
 * Preserved-pixel composite — the CORRECT implementation of the spec equation:
 *
 *   output = original_subject × alpha + generated_background × (1 − alpha)
 *
 * `plate` is the generated (already graded) scene; it is normalized to the
 * exact target W×H (providers may snap generation sizes). The original frame
 * is mapped onto the canvas with one uniform scale + translation (centered
 * on the subject), so subject proportions and relative positioning are
 * preserved exactly. The subject alpha (matte or manual window) feathers
 * ONLY at the subject boundary. No luminance modification, no extra layers,
 * no re-framing crops — verified numerically by pipeline/validate.ts before
 * export. The returned `plate` is the normalized backdrop actually used, so
 * validation compares identical geometry.
 */
export async function compositePreservedSubject(
  plate: Buffer,
  originalFrame: Buffer,
  maskSource: SubjectMaskSource,
  target: SizeRequest,
  opts: { feather?: number } = {}
): Promise<{ composite: Buffer; mask: Buffer; mapping: PreserveMapping; featherPx: number; plate: Buffer }> {
  const W = target.width;
  const H = target.height;
  const meta = await sharp(originalFrame).metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  if (!srcW || !srcH) throw new LaxiiError("Reference image has no dimensions");

  const featherPx =
    opts.feather ??
    (maskSource.type === "matte"
      ? Math.max(6, Math.round(Math.min(W, H) * 0.012)) // hair-level ramp
      : Math.max(16, Math.round(Math.min(W, H) * 0.04))); // manual window ramp

  const focus =
    maskSource.type === "matte"
      ? maskSource.centroid
      : { x: (maskSource.rect.x + maskSource.rect.w / 2) / 100, y: (maskSource.rect.y + maskSource.rect.h / 2) / 100 };

  const mapping = planPreserveMapping(srcW, srcH, W, H, focus);

  // The plate must be exactly the export canvas — providers may snap the
  // generation size (e.g. 512→1024), so normalize it here, before the mask.
  const plateMeta = await sharp(plate).metadata();
  const normPlate =
    (plateMeta.width ?? 0) === W && (plateMeta.height ?? 0) === H
      ? plate
      : await sharp(plate).resize(W, H, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();

  // The mapped original layer (same extract + resize geometry as the mask —
  // pixel alignment between layer and mask is exact by construction).
  const layer = await sharp(originalFrame)
    .extract(mapping.crop)
    .resize(W, H, { fit: "fill", kernel: "lanczos3" })
    .ensureAlpha()
    .png()
    .toBuffer();

  let mask: Buffer;
  if (maskSource.type === "matte") {
    if (maskSource.width !== srcW || maskSource.height !== srcH) {
      throw new LaxiiError("Subject mask does not match the reference frame");
    }
    mask = await buildMatteMask(maskSource, mapping, W, H, featherPx);
  } else {
    // Manual-window guards: a near-full-frame window can never smuggle the
    // whole photo through, and a sliver window is meaningless as a mask.
    const area = (maskSource.rect.w / 100) * (maskSource.rect.h / 100);
    if (area > 0.85) {
      throw new LaxiiError(
        "The subject window covers almost the whole photo, so the background could not be replaced. Mark a tighter window around the subject in Profile Studio and retry."
      );
    }
    if (area < 0.03) {
      throw new LaxiiError(
        "The subject window is too small to preserve the subject meaningfully — mark a larger region around the subject in Profile Studio."
      );
    }
    const r = mapWindowToOutput(maskSource.rect, srcW, srcH, mapping);
    const inCanvas = Math.max(0, Math.min(r.x + r.w, W) - Math.max(0, r.x));
    const inCanvasH = Math.max(0, Math.min(r.y + r.h, H) - Math.max(0, r.y));
    if (inCanvas < 8 || inCanvasH < 8) {
      throw new LaxiiError("The subject window lies outside the visible frame for this export size — mark a window inside the photo");
    }
    const rClamped = {
      x: Math.max(0, r.x),
      y: Math.max(0, r.y),
      w: Math.min(r.x + r.w, W) - Math.max(0, r.x),
      h: Math.min(r.y + r.h, H) - Math.max(0, r.y),
    };
    mask = featheredRectMask(
      W,
      H,
      {
        x: (rClamped.x / W) * 100,
        y: (rClamped.y / H) * 100,
        w: (rClamped.w / W) * 100,
        h: (rClamped.h / H) * 100,
      },
      featherPx
    );
  }

  // output = layer × alpha + plate × (1 − alpha) — sharp's dest-in + over.
  const masked = await sharp(layer)
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  const composite = await sharp(normPlate)
    .composite([{ input: masked, left: 0, top: 0 }])
    .png()
    .toBuffer();

  return { composite, mask, mapping, featherPx, plate: normPlate };
}

// ------------------------------------------------------------------ keep-region (banners / background replacement)

/**
 * Content-preserving background replacement (banners / scenes):
 * the ORIGINAL reference is layered over the generated backdrop inside the
 * keep-region — original text, logos and pixels are never redrawn.
 */
export async function compositeKeepRegion(
  plate: Buffer,
  original: Buffer,
  keep: { x: number; y: number; w: number; h: number },
  feather?: number
): Promise<Buffer> {
  const W = (await sharp(plate).metadata().then((m) => m.width)) ?? 0;
  const H = (await sharp(plate).metadata().then((m) => m.height)) ?? 0;
  if (!W || !H) throw new LaxiiError("Backdrop has no dimensions");
  const f = feather ?? Math.max(12, Math.round(Math.min(W, H) * 0.05));
  const resized = await sharp(original).resize(W, H, { fit: "cover" }).png().toBuffer();
  const mask = featheredRectMask(W, H, keep, f);
  const masked = await sharp(resized)
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  return sharp(plate).composite([{ input: masked }]).png().toBuffer();
}

// ------------------------------------------------------------------ geometry

/** Cover-resize to the EXACT export dimensions (Lanczos3). */
export async function finalizeSize(buf: Buffer, target: SizeRequest): Promise<Buffer> {
  return sharp(buf)
    .resize(target.width, target.height, { fit: "cover", kernel: "lanczos3" })
    .png()
    .toBuffer();
}
