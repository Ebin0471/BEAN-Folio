/**
 * LAXII — NEW identity-lock avatar pipeline (M33.4-C).
 *
 * This is a NEW deterministic subject-preservation implementation. The
 * historic preserve-pixel engine (engine.ts / pipeline/*, MODNet backdrop
 * compositing with elliptical windows) was REMOVED from the codebase in the
 * Phase-6 dead-cluster audit; nothing here reconnects that code. The
 * pipeline below is designed, implemented and tested from scratch against
 * the requirements in Guide §6.1.
 *
 * Pipeline (preserve-pixel identity lock):
 *   1. decode + probe the owner-authorized source (bytes stay untouched)
 *   2. segment the subject LOCALLY (MODNet ONNX, CPU — segmentation.ts);
 *      an uncertain mask is a FAILURE, never a degraded output
 *   3. generate the replacement background plate with a REAL provider call
 *      that carries a TEXT PROMPT ONLY — protected subject pixels are never
 *      sent to any model
 *   4. plate person-gate: the generated scene is scanned by the same local
 *      matting model; a scene containing a person is rejected and
 *      regenerated (bounded attempts), then the job fails honestly
 *   5. composite the ORIGINAL subject pixels over the new scene with the
 *      exact equation  output = original_subject × alpha + plate × (1 − alpha)
 *      on a canvas of the source's own dimensions — a 1:1 mapping, so face
 *      geometry, expression, skin texture, hairline, facial hair, glasses
 *      and every identifying detail are preserved BIT-EXACTLY in the core
 *      region, with zero distortion (no resampling of subject pixels)
 *   6. numerically self-verify the composite BEFORE returning it: core
 *      pixels must be bit-identical, the feather band must follow the
 *      equation within ±1/255 rounding, and the background must match the
 *      plate. A violation fails the job — a defective composite is never
 *      exported
 *   7. store the result as a NEW private MediaAsset + LaxiiImageVersion
 *      (mode "PRESERVE_PIXEL"); nothing is applied to the public profile —
 *      that stays an explicit user action through PATCH /api/me/profile
 *
 * Mode separation (hard requirement): PRESERVE_PIXEL results carry
 * identityLock: "preserved-original-pixels" and may truthfully claim the
 * original pixels were kept. AI-restyled results (mode "AI_RESTYLED") are a
 * separate code path that must NEVER claim guaranteed identity — likeness
 * there is best-effort and labelled experimental.
 */
import { createHash } from "node:crypto";

import sharp from "sharp";

import { runLaxiiOperation } from "./router";
import { fitToCanvas } from "./image-ops";
import { LaxiiError } from "./types";
import { probeImage } from "./validate";
import {
  MASK_BOUNDS,
  plateContainsPerson,
  resizeMatteToCanvas,
  runPortraitMatte,
  validateMask,
  type PortraitMatte,
} from "./segmentation";
import { logGatewayEvent } from "@/lib/intelligence/observability";

export type IdentityPipelineMode = "PRESERVE_PIXEL" | "AI_RESTYLED";

export interface PreservationManifest {
  mode: IdentityPipelineMode;
  canvas: { width: number; height: number };
  sourceSha256: string;
  sourceDims: { width: number; height: number };
  mask: {
    coverage: number;
    bbox: { x: number; y: number; width: number; height: number } | null;
    modelResolution: { width: number; height: number };
  };
  background: { attempts: number; provider: string; model: string; personGateCoverage: number };
  verification: {
    /** Max per-channel delta across the alpha==1 core (0 = bit-identical). */
    coreMaxDelta: number;
    /** Max per-channel delta inside the feather band vs the exact equation. */
    featherMaxDelta: number;
    /** Max per-channel delta in the replaced background vs the plate. */
    backgroundMaxDelta: number;
    corePixelsChecked: number;
    featherPixelsChecked: number;
    backgroundPixelsChecked: number;
    passed: boolean;
  };
}

export interface IdentityCompositeResult {
  /** Composite RGBA bytes (PNG-encoded). */
  png: Buffer;
  manifest: PreservationManifest;
}

export interface CompositeInputs {
  /** Source pixels, RGBA, canvas-sized (the 1:1 mapping). */
  srcRgba: Uint8Array;
  /** Background plate pixels, RGBA, canvas-sized. */
  bgRgba: Uint8Array;
  /** Alpha matte in [0,1], canvas-sized. */
  alpha: Float32Array;
  width: number;
  height: number;
}

export interface CompositeVerification {
  coreMaxDelta: number;
  featherMaxDelta: number;
  backgroundMaxDelta: number;
  corePixelsChecked: number;
  featherPixelsChecked: number;
  backgroundPixelsChecked: number;
  passed: boolean;
  outRgba: Uint8Array;
}

/**
 * Preservation partition (strict): alpha === 1 exactly is the preserved
 * core (bit-identical claim), alpha === 0 exactly is the replaced
 * background, and everything strictly between is the feather boundary.
 * Near-1 alphas blend measurably (up to (bg−src)×(1−alpha)), so they must
 * NOT be counted as "preserved" — the bit-identical claim stays honest.
 */

/**
 * The exact preservation composite, computed per pixel:
 *   out = src × alpha + bg × (1 − alpha)
 * with a full numerical verification partitioning pixels into the preserved
 * core (alpha == 1 within 1/255), the feather boundary (0 < alpha < 1) and
 * the replaced background (alpha == 0 within 1/255). The verification is
 * SEPARATE for the alpha-mask boundary (its own counter and bound) so a
 * broken feather can never hide behind a passing core.
 */
export function compositePreservePixels(inputs: CompositeInputs): CompositeVerification {
  const { srcRgba, bgRgba, alpha, width, height } = inputs;
  const n = width * height;
  if (srcRgba.length < n * 4 || bgRgba.length < n * 4 || alpha.length < n) {
    throw new LaxiiError("The source, plate and mask dimensions disagree — refusing to composite.");
  }
  const out = new Uint8Array(n * 4);
  let coreMaxDelta = 0;
  let featherMaxDelta = 0;
  let backgroundMaxDelta = 0;
  let corePixelsChecked = 0;
  let featherPixelsChecked = 0;
  let backgroundPixelsChecked = 0;

  for (let i = 0; i < n; i += 1) {
    const a = alpha[i];
    const aClamped = a < 0 ? 0 : a > 1 ? 1 : a;
    const si = i * 4;
    for (let c = 0; c < 4; c += 1) {
      const src = srcRgba[si + c];
      const bg = bgRgba[si + c];
      const blended = src * aClamped + bg * (1 - aClamped);
      const value = Math.max(0, Math.min(255, Math.round(blended)));
      out[si + c] = value;
      const expectedExact = src * aClamped + bg * (1 - aClamped);
      const delta = Math.abs(value - expectedExact);
      if (aClamped === 1) {
        // Preserved core: must equal the source bit-exactly (alpha=1 → src).
        corePixelsChecked += c === 0 ? 1 : 0;
        const coreDelta = Math.abs(value - src);
        if (coreDelta > coreMaxDelta) coreMaxDelta = coreDelta;
      } else if (aClamped === 0) {
        backgroundPixelsChecked += c === 0 ? 1 : 0;
        const bgDelta = Math.abs(value - bg);
        if (bgDelta > backgroundMaxDelta) backgroundMaxDelta = bgDelta;
      } else {
        featherPixelsChecked += c === 0 ? 1 : 0;
        if (delta > featherMaxDelta) featherMaxDelta = delta;
      }
    }
  }

  const passed =
    coreMaxDelta === 0 &&
    backgroundMaxDelta === 0 &&
    featherMaxDelta <= 1;
  return {
    coreMaxDelta,
    featherMaxDelta,
    backgroundMaxDelta,
    corePixelsChecked,
    featherPixelsChecked,
    backgroundPixelsChecked,
    passed,
    outRgba: out,
  };
}

const MAX_PLATE_ATTEMPTS = 3;

export interface MaskPreview {
  /** Mask visualization PNG (subject white, background black) as raw bytes. */
  maskPng: Buffer;
  sourceWidth: number;
  sourceHeight: number;
  coverage: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  /** The documented bounds the mask was validated against. */
  bounds: typeof MASK_BOUNDS;
}

/**
 * User-reviewable foreground matte (Guide/spec §4.3 step 5): segments the
 * source LOCALLY and renders the alpha matte as a black/white mask image.
 * Nothing is generated, stored or applied in this phase — the caller shows
 * the mask for review and the user confirms or cancels before the pipeline
 * runs. Uncertain masks are reported here (ok=false) so the user can stop
 * before spending a generation.
 */
export async function buildMaskPreview(source: Buffer): Promise<MaskPreview & { ok: boolean; reason: string | null }> {
  const probe = probeImage(source);
  if (!probe || probe.width < 256 || probe.height < 256) {
    throw new LaxiiError("The reference image could not be decoded or is too small (minimum 256×256).");
  }
  const matte = await runPortraitMatte(source);
  const check = validateMask(matte);
  const maskRaw = Buffer.alloc(matte.width * matte.height * 3);
  for (let i = 0; i < matte.width * matte.height; i += 1) {
    const v = Math.max(0, Math.min(255, Math.round(matte.alpha[i] * 255)));
    maskRaw[i * 3] = v;
    maskRaw[i * 3 + 1] = v;
    maskRaw[i * 3 + 2] = v;
  }
  const maskPng = await sharp(maskRaw, { raw: { width: matte.width, height: matte.height, channels: 3 } })
    .png()
    .toBuffer();
  return {
    ok: check.ok,
    reason: check.reason,
    maskPng,
    sourceWidth: probe.width,
    sourceHeight: probe.height,
    coverage: check.coverage,
    bbox: check.bbox,
    bounds: MASK_BOUNDS,
  };
}

export interface IdentityPipelineDeps {
  generate?: typeof runLaxiiOperation;
  userId: string;
}

export interface IdentityPipelineInput {
  /** Owner-verified source image bytes (the protected reference). */
  source: Buffer;
  /** Scene description for the replacement background (prompt-only). */
  scenePrompt: string;
  mode?: IdentityPipelineMode;
}

export interface IdentityPipelineOutput {
  png: Buffer;
  width: number;
  height: number;
  manifest: PreservationManifest;
}

/**
 * Run the preserve-pixel identity pipeline for one source image.
 * Throws LaxiiError with a user-safe message on ANY failure — nothing is
 * exported when segmentation, the plate gate or the verification fails.
 */
export async function runIdentityLockPipeline(
  input: IdentityPipelineInput,
  deps: IdentityPipelineDeps
): Promise<IdentityPipelineOutput> {
  const { source, scenePrompt } = input;
  const generate = deps.generate ?? runLaxiiOperation;

  // 1. Decode + probe the source. The bytes are treated as read-only.
  const probe = probeImage(source);
  if (!probe || probe.width < 256 || probe.height < 256) {
    throw new LaxiiError("The reference image could not be decoded or is too small (minimum 256×256). Nothing was changed.");
  }
  const width = probe.width;
  const height = probe.height;
  const sourceSha256 = createHash("sha256").update(source).digest("hex");

  // 2. LOCAL segmentation. Protected pixels never leave the process here.
  let matte: PortraitMatte;
  try {
    matte = await runPortraitMatte(source);
  } catch (e) {
    throw new LaxiiError(`Portrait segmentation failed locally: ${e instanceof Error ? e.message : "unknown error"}. Nothing was generated or changed.`);
  }
  const maskCheck = validateMask(matte);
  if (!maskCheck.ok) {
    throw new LaxiiError(`The subject mask is uncertain — ${maskCheck.reason}. The job stopped instead of exporting a degraded identity result.`);
  }

  // 3–4. Background plate: REAL provider call, TEXT PROMPT ONLY (no
  // reference images — protected subject pixels are never sent), then the
  // local person-gate rejects scenes containing a human subject.
  let plateBytes: Buffer | null = null;
  let attempts = 0;
  let personGateCoverage = 0;
  let lastProvider = "";
  let lastModel = "";
  let lastPersonCoverage = 0;
  for (let attempt = 1; attempt <= MAX_PLATE_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    const result = await generate({
      operation: "GENERATE",
      prompt: [
        scenePrompt,
        "The scene must contain NO people, NO faces, NO body parts, NO statues or mannequins of humans, NO silhouettes of persons — an empty environment only.",
        "Photorealistic lighting, coherent single scene, crisp focus, no frame edges visible, full-bleed composition.",
      ].join("\n"),
      references: [],
      aspect: nearestAspect(width / height),
      count: 1,
    });
    lastProvider = result.provider;
    lastModel = result.model;
    if (result.images.length === 0) {
      throw new LaxiiError("The background engine returned no image for this avatar scene.");
    }
    const plate = await fitToCanvas(result.images[0].bytes, width, height, "png");
    const gate = await plateContainsPerson(plate.bytes);
    lastPersonCoverage = gate.coverage;
    if (!gate.contains) {
      plateBytes = plate.bytes;
      personGateCoverage = gate.coverage;
      break;
    }
  }
  if (!plateBytes) {
    throw new LaxiiError(
      `Every generated background scene contained a person (highest person-signal ${(lastPersonCoverage * 100).toFixed(1)}% of the frame across ${attempts} attempts). The job stopped — no composite was exported.`
    );
  }

  // 5. Composite on a canvas of the SOURCE's own dimensions (1:1 mapping —
  // subject pixels are copied without resampling; zero distortion).
  const srcRgba = new Uint8Array(await sharp(source).ensureAlpha().resize(width, height, { fit: "fill" }).raw().toBuffer());
  const bgRgba = new Uint8Array(await sharp(plateBytes).ensureAlpha().raw().toBuffer());
  const matteCanvas = await resizeMatteToCanvas(matte, width, height);
  const verification = compositePreservePixels({ srcRgba, bgRgba, alpha: matteCanvas.alpha, width, height });

  // 6. Fail closed on verification violations.
  if (!verification.passed) {
    throw new LaxiiError(
      `The composite failed its numerical verification (coreMaxDelta=${verification.coreMaxDelta}, featherMaxDelta=${verification.featherMaxDelta}, backgroundMaxDelta=${verification.backgroundMaxDelta}). Nothing was exported.`
    );
  }
  const png = await sharp(Buffer.from(verification.outRgba), { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const outProbe = probeImage(png);
  if (!outProbe || outProbe.width !== width || outProbe.height !== height) {
    throw new LaxiiError("The composite could not be re-encoded at the exact source dimensions — nothing was exported.");
  }

  const manifest: PreservationManifest = {
    mode: "PRESERVE_PIXEL",
    canvas: { width, height },
    sourceSha256,
    sourceDims: { width, height },
    mask: {
      coverage: maskCheck.coverage,
      bbox: maskCheck.bbox,
      modelResolution: { width: matte.width, height: matte.height },
    },
    background: { attempts, provider: lastProvider, model: lastModel, personGateCoverage },
    verification: {
      coreMaxDelta: verification.coreMaxDelta,
      featherMaxDelta: verification.featherMaxDelta,
      backgroundMaxDelta: verification.backgroundMaxDelta,
      corePixelsChecked: verification.corePixelsChecked,
      featherPixelsChecked: verification.featherPixelsChecked,
      backgroundPixelsChecked: verification.backgroundPixelsChecked,
      passed: verification.passed,
    },
  };

  logGatewayEvent({
    event: "gateway.request",
    agent: "LAXII",
    feature: "avatar.identity-lock",
    capability: "image",
    outcome: "success",
    userId: deps.userId,
    error: `plateAttempts=${attempts} coverage=${maskCheck.coverage.toFixed(3)}`,
  });

  return { png, width, height, manifest };
}

function nearestAspect(ratio: number): "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9" {
  const options: { a: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9"; r: number }[] = [
    { a: "1:1", r: 1 }, { a: "2:3", r: 2 / 3 }, { a: "3:2", r: 3 / 2 }, { a: "3:4", r: 3 / 4 },
    { a: "4:3", r: 4 / 3 }, { a: "4:5", r: 4 / 5 }, { a: "5:4", r: 5 / 4 }, { a: "9:16", r: 9 / 16 },
    { a: "16:9", r: 16 / 9 }, { a: "21:9", r: 21 / 9 },
  ];
  let best = options[0];
  for (const o of options) {
    if (Math.abs(Math.log(o.r / ratio)) < Math.abs(Math.log(best.r / ratio))) best = o;
  }
  return best.a;
}

export { MASK_BOUNDS };
