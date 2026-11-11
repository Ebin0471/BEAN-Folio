import type {
  ImageProvider,
  LaxiiRequest,
  TextToImageRequest,
  ImageToImageRequest,
  SizeRequest,
} from "./types";
import { LaxiiError } from "./types";
import { managedProvider } from "./providers/managed";
import { diffusersProvider } from "./providers/diffusers";
import { geminiProvider } from "./providers/gemini";
import { openaiProvider } from "./providers/openai";
import { resolveProvider as routerResolveProvider } from "./providers/capabilities";
import { anyStyle, nearestGenerationSize } from "./styles";
import {
  applyGrade,
  compositeKeepRegion,
  compositePreservedSubject,
  finalizeSize,
  loadMeta,
  normalizeToPng,
  type SubjectMaskSource,
} from "./pipeline/compose";
import { verifyPreserveComposite } from "./pipeline/validate";
import {
  assessPlate,
  matteConfidenceError,
  MAX_COVERAGE,
  MIN_COVERAGE,
  segmentationAvailable,
  subjectMatte,
  type PlateAssessment,
} from "./pipeline/segment";
import { createWorkspace, sweepStale, writeFrame } from "./tempstore";
import { exportImage } from "./pipeline/quality";

/**
 * LAXII engine orchestrator.
 *
 * Pure image-engine logic: given a validated request it selects a provider,
 * runs the real pipeline (generate → preserve → grade → verify → export) and
 * returns result BUFFERS with measured quality metadata. Persistence is the
 * caller's job (the BEAN Folio API layer stores them as owner-scoped
 * MediaAssets; any other host can do something else).
 *
 * Dependency inversion: the source image is injected as a `read()` closure,
 * so this module never touches BEAN storage, DB or auth.
 *
 * Honest failure rule: any missing capability (provider unavailable, style
 * unknown, source unreadable) fails with LaxiiError. Nothing is faked.
 */

const PROVIDERS: Record<string, ImageProvider> = {
  managed: managedProvider,
  diffusers: diffusersProvider,
  gemini: geminiProvider,
  openai: openaiProvider,
};

/**
 * Resolve the provider to actually run, honoring the request preference.
 * Delegates to the router (providers/capabilities.ts) — single source of truth
 * shared with the /api/laxii/capabilities endpoint that drives the UI.
 */
export async function resolveProvider(pref: LaxiiRequest["provider"]): Promise<ImageProvider> {
  return routerResolveProvider(pref);
}

// ------------------------------------------------------------------ outputs

/** A finished variation, ready for persistence by the host application. */
export interface EngineOutput {
  buffer: Buffer;
  width: number;
  height: number;
  format: NonNullable<LaxiiRequest["format"]>;
  bytes: number;
  /** Measured Laplacian-variance sharpness score (0–100). */
  sharpness: number;
  /** Coarse 8×8 blockiness heuristic (0–100, lower is better). */
  blockiness: number;
  /** Which subject mask produced a PRESERVE result ("modnet" = ML matte;
   *  "window" = the user's manually marked subject window). */
  segmentation?: "modnet" | "window";
}

export interface RunOutcome {
  results: EngineOutput[];
  providerId: string;
  providerLabel: string;
}

/** Progress reporter — the host maps stage → percent for its own UI. */
export type ProgressFn = (stage: string, percent: number) => void;

export async function runRequest(req: LaxiiRequest, onProgress: ProgressFn): Promise<RunOutcome> {
  await sweepStale();
  const provider = await resolveProvider(req.provider);
  return runRequestWithProvider(req, provider, onProgress);
}

/**
 * Run a request against an EXPLICIT provider. Exported so regression tests
 * can drive the real engine with a stubbed provider (retry ladder, gate
 * decisions) without network inference.
 */
export async function runRequestWithProvider(req: LaxiiRequest, provider: ImageProvider, onProgress: ProgressFn): Promise<RunOutcome> {
  switch (req.kind) {
    case "AVATAR":
      return runAvatar(req, provider, onProgress);
    case "BANNER":
      return runBanner(req, provider, onProgress);
    case "BACKGROUND":
      return runBackground(req, provider, onProgress);
    case "UPSCALE":
      return runUpscale(req, onProgress);
    case "EDIT":
      return runEdit(req, provider, onProgress);
    // Conversational creative studio kinds:
    case "GENERATE":
      return runGenerate(req, provider, onProgress);
    case "VARIATIONS":
      return runVariations(req, provider, onProgress);
    case "REMOVE_BG":
      return runRemoveBackground(req, onProgress);
    case "OUTPAINT":
      return runOutpaint(req, provider, onProgress);
    default:
      throw new LaxiiError("Unsupported request kind");
  }
}

// ------------------------------------------------------------------ backdrop prompt builders

/**
 * Vocabulary that must NEVER reach a backdrop prompt. These terms describe
 * the SUBJECT of a portrait (the very thing preserved-pixel mode keeps
 * original); fed to the empty-scene generator they directly command it to
 * paint a person — the root cause of the "every generated scene contained a
 * person" failure when users write avatar-transformation instructions such
 * as “corporate headshot, charcoal blazer, confident expression”.
 */
const PERSON_TERM_RE =
  /\b(person|people|man|men|woman|women|girl|boy|lady|gentleman|guy|dude|face|facial|headshot|portrait|selfie|expression|expressions|hair|hairstyle|haircut|skin|eye|eyes|smile|smiling|gaze|pose|poses|posing|posture|body|silhouette|figure|blazer|suit|shirt|tie|jacket|dress|outfit|clothing|attire|apparel|garment|wear|wearing|wardrobe|identity|likeness|photo|photograph|picture|reference|upload|uploaded|subject)\b/i;

/** Vocabulary that IS meaningful for a backdrop (scene, light, color, mood). */
const SCENE_TERM_RE =
  /\b(background|backdrop|scene|scenery|setting|environment|lighting|light|lights|tone|tones|tint|color|colors|colour|colours|gradient|glow|shadow|shadows|studio|wall|walls|ambience|ambiance|atmosphere|mood|vignette|bokeh|room|space|texture|grain|haze|beam|beams|highlight|highlights|contrast|palette|filter|grade)\b/i;

/**
 * Filter user instructions down to backdrop-safe clauses. Deterministic and
 * dependency-free: a clause survives only when it contains NO person/subject
 * vocabulary AND at least one scene/light/color term. Everything else —
 * clothing, faces, poses, references to the uploaded photo — is dropped,
 * because in PRESERVE mode none of it can influence the preserved pixels
 * anyway, and in the backdrop prompt it paints people.
 */
export function backdropSafeInstructions(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  const clauses = text
    .split(/[\n;,.!?·•\u2022]+|\s[-–—]\s/)
    .map((c) => c.trim())
    .filter(Boolean);
  const kept: string[] = [];
  for (const clause of clauses) {
    if (PERSON_TERM_RE.test(clause)) continue;
    if (!SCENE_TERM_RE.test(clause)) continue;
    if (kept.join(", ").length + clause.length > 240) break;
    kept.push(clause);
  }
  return kept.join(", ");
}

/** Front-loaded emptiness constraints — affirmative phrasing, no “portrait”. */
const EMPTY_SCENE_CONSTRAINTS =
  "completely empty scene, scenery only, absolutely no people, no mannequin, no statue, no figure, no face, no body parts, no silhouettes, no text, no watermark";

/** Core (style + light + safe instructions) fragment of the backdrop prompt. */
function backdropCorePrompt(req: LaxiiRequest): string {
  const preset = anyStyle(req.style);
  if (!preset) throw new LaxiiError("Unknown avatar style preset");
  const safe = backdropSafeInstructions(req.instructions ?? "");
  return ["empty studio backdrop plate for photo compositing", preset.scene, preset.light ?? "", safe]
    .filter(Boolean)
    .join(", ");
}

/**
 * Genuinely DIFFERENT backdrop prompts per retry attempt (§ Part A fix).
 * Attempt 0: full scene description. Attempt 1: same scene with a stronger
 * vacancy emphasis. Attempt 2: minimal fail-safe prompt — style and
 * instruction fragments are dropped entirely because an on-style plate that
 * keeps failing the person gate is worth less than an empty plate at all.
 */
export function backdropPromptLadder(req: LaxiiRequest): string[] {
  const core = backdropCorePrompt(req);
  return [
    `${core}, ${EMPTY_SCENE_CONSTRAINTS}, high quality, detailed`,
    `${core}, strictly vacant plate, alternate composition emphasis, ${EMPTY_SCENE_CONSTRAINTS}, high quality, detailed`,
    `plain seamless empty studio backdrop wall, soft even gradient lighting, ${EMPTY_SCENE_CONSTRAINTS}, high quality, detailed`,
  ];
}

function guidedAvatarPrompt(req: LaxiiRequest): string {
  const style = anyStyle(req.style);
  const name = style ? style.label.toLowerCase() : "professional portrait";
  const extra = req.instructions ? `, ${req.instructions.trim()}` : "";
  return [
    `Rebuild this photo as a ${name}:`,
    style?.scene ?? "",
    style?.light ? `, ${style.light}` : "",
    ", keep the person's face and likeness recognizable, professional portrait framing",
    `${extra}, high quality, detailed`,
  ].join(" ");
}

// ------------------------------------------------------------------ avatar

async function runAvatar(req: LaxiiRequest, provider: ImageProvider, onProgress: ProgressFn): Promise<RunOutcome> {
  if (!req.source) throw new LaxiiError("Avatar generation needs a reference photo");
  if (!req.identityMode) throw new LaxiiError("Avatar generation needs an identity mode");
  const style = anyStyle(req.style);
  if (!style) throw new LaxiiError("Unknown avatar style preset");

  onProgress("Preparing reference", 5);
  const sourceBuf = await normalizeToPng(await req.source.read());
  const results: EngineOutput[] = [];
  const variations = Math.max(1, Math.min(4, req.variations || 1));

  // Per-run diagnostic workspace (private temp store, age-swept) — every
  // processing stage is saved so failures can be inspected stage by stage.
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const workspace = await createWorkspace(runId);

  if (req.identityMode === "PRESERVE") {
    // Identity = the original pixels, composited back over generated scenes
    // through the EXACT spec equation. The subject mask comes from the local
    // segmentation stack when available; otherwise the user's manually marked
    // subject window is the mask. Both paths are numerically validated before
    // export — a defective composite FAILS the job instead of shipping.
    const mask = await resolveSubjectMask(sourceBuf, req.subject, onProgress);

    for (let i = 0; i < variations; i++) {
      onProgress(`Generating scene ${i + 1}/${variations}`, 15 + Math.round((30 * i) / variations));
      const { plate, personCoverage, attempts, gateLog } = await generateCleanBackdrop(
        provider,
        req,
        i,
        // Evidence trail: every rejected plate + its actual MODNet mask is
        // persisted to the diagnostic workspace BEFORE regeneration, so a
        // rejection can always be inspected image-by-image afterwards.
        async (rejectedPlate, assessment, attempt) => {
          await writeFrame(workspace, `${i + 1}-plate-rejected-${attempt + 1}.png`, rejectedPlate);
          await writeFrame(
            workspace,
            `${i + 1}-plate-rejected-${attempt + 1}-mask.png`,
            await sharpMaskPng(assessment.alpha, assessment.width, assessment.height)
          );
        }
      );
      onProgress(`Compositing variation ${i + 1}/${variations}`, 45 + Math.round((45 * i) / variations));
      const graded = await applyGrade(plate, style.grade);

      const { composite, mask: maskPng, mapping, featherPx, plate: normalizedPlate } = await compositePreservedSubject(
        graded,
        sourceBuf,
        mask.source,
        req.size
      );
      const check = await verifyPreserveComposite({
        composited: composite,
        plate: normalizedPlate,
        originalFrame: sourceBuf,
        mapping,
        mask: maskPng,
        target: req.size,
      });

      await writeDiagnostics(workspace, {
        variation: i + 1,
        original: sourceBuf,
        maskPng,
        binaryMask: await binaryMask(maskPng, req.size),
        plate: graded,
        composite,
        meta: {
          segmentation: mask.segmentation,
          coveragePct: mask.coveragePct,
          mapping,
          featherPx,
          validation: check,
          platePersonCoveragePct: Math.round(personCoverage * 1000) / 10,
          plateAttempts: attempts,
          plateGate: gateLog,
          style: style.id,
          providerId: provider.id,
        },
      });

      results.push(await exportResult(composite, req, mask.segmentation));
    }
  } else {
    // AI_GUIDED — genuine image-to-image inference; identity is NOT guaranteed.
    for (let i = 0; i < variations; i++) {
      onProgress(`Guided generation ${i + 1}/${variations}`, 20 + Math.round((55 * i) / variations));
      const guided = await provider.imageToImage({
        prompt: guidedAvatarPrompt(req),
        image: sourceBuf,
        width: req.size.width,
        height: req.size.height,
      });
      const graded = await applyGrade(guided, style.grade);
      results.push(await exportResult(graded, req));
    }
  }
  onProgress("Done", 100);
  return { results, providerId: provider.id, providerLabel: provider.label };
}

/**
 * Resolve the subject mask for PRESERVE avatars:
 *   1. MODNet matte (Apache-2.0 local stack) — primary, confidence-gated;
 *   2. the user's manually marked subject window — documented fallback;
 *   3. nothing usable → honest failure (never a defective export).
 */
async function resolveSubjectMask(
  sourceBuf: Buffer,
  subject: LaxiiRequest["subject"],
  onProgress: ProgressFn
): Promise<{ source: SubjectMaskSource; segmentation: "modnet" | "window"; coveragePct: number | null }> {
  const windowRect = subject && subject.w > 0 && subject.h > 0 ? subject : null;
  if (segmentationAvailable().ok) {
    onProgress("Detecting subject", 8);
    const matte = await subjectMatte(sourceBuf);
    if (matte.coverage < MIN_COVERAGE || matte.coverage > MAX_COVERAGE) throw matteConfidenceError(matte.coverage);
    return { source: { type: "matte", ...matte }, segmentation: "modnet", coveragePct: Math.round(matte.coverage * 1000) / 10 };
  }
  if (windowRect) {
    // Manual mask fallback — the UI's subject window IS the mask. Area sanity
    // is enforced in compositePreservedSubject (covered by the regression suite).
    return { source: { type: "window", rect: windowRect }, segmentation: "window", coveragePct: null };
  }
  throw new LaxiiError(
    "Subject segmentation is unavailable on this deployment and no subject window was provided. Mark the subject window in Profile Studio, or install the local segmentation weights with: bun ./scripts/laxii/prefetch-models.ts"
  );
}

/** Gate log entry persisted in the job diagnostics manifest. */
export interface PlateGateEntry {
  attempt: number;
  decision: PlateAssessment["decision"];
  coveragePct: number;
  reason: string;
}

/** Grayscale raw alpha → single-channel PNG (diagnostics). */
async function sharpMaskPng(alpha: Buffer, width: number, height: number): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

/**
 * Generate an EMPTY backdrop for PRESERVE avatars — the §5 quality gate:
 *
 *  1. every plate is scanned by the local matting stack;
 *  2. a flagged plate is INSPECTED before rejection — mask shape + skin
 *     evidence decide between a real painted person (reject) and a MODNet
 *     false positive such as plants or furniture (accept, logged);
 *  3. a rejected plate is saved to the diagnostic workspace together with
 *     its mask, then regenerated with the next rung of a genuinely
 *     different prompt ladder (stronger vacancy emphasis, then a minimal
 *     fail-safe prompt);
 *  4. after the ladder is exhausted the job fails honestly with an
 *     actionable message instead of compositing a stranger behind the
 *     preserved subject.
 */
export async function generateCleanBackdrop(
  provider: ImageProvider,
  req: LaxiiRequest,
  variationIndex: number,
  onRejected?: (plate: Buffer, assessment: PlateAssessment, attempt: number) => Promise<void> | void
): Promise<{ plate: Buffer; personCoverage: number; attempts: number; gateLog: PlateGateEntry[] }> {
  const MAX_PLATE_ATTEMPTS = 3;
  const ladder = backdropPromptLadder(req);
  let lastCoverage = 0;
  const gateLog: PlateGateEntry[] = [];
  for (let attempt = 0; attempt < MAX_PLATE_ATTEMPTS; attempt++) {
    const plate = await provider.textToImage({
      prompt: ladder[attempt],
      width: req.size.width,
      height: req.size.height,
    });
    if (!segmentationAvailable().ok) {
      // No segmentation → no gate (documented downgrade; the compositing
      // validation still applies downstream).
      return { plate, personCoverage: -1, attempts: attempt + 1, gateLog };
    }
    const assessment = await assessPlate(plate);
    if (assessment.decision !== "person") {
      if (assessment.decision === "false-positive") {
        gateLog.push({ attempt: attempt + 1, decision: assessment.decision, coveragePct: Math.round(assessment.coverage * 1000) / 10, reason: assessment.reason });
        console.error(
          `[laxii] backdrop attempt ${attempt + 1} accepted as a false positive (${(assessment.coverage * 100).toFixed(1)}% coverage — ${assessment.reason})`
        );
      }
      return { plate, personCoverage: assessment.coverage, attempts: attempt + 1, gateLog };
    }
    lastCoverage = assessment.coverage;
    gateLog.push({ attempt: attempt + 1, decision: assessment.decision, coveragePct: Math.round(assessment.coverage * 1000) / 10, reason: assessment.reason });
    console.error(
      `[laxii] backdrop attempt ${attempt + 1} rejected: person detected (${(assessment.coverage * 100).toFixed(1)}% coverage — ${assessment.reason}); regenerating with a different empty-scene prompt`
    );
    if (onRejected) await onRejected(plate, assessment, attempt);
  }
  throw new LaxiiError(
    `The image engine could not produce an empty backdrop — ${MAX_PLATE_ATTEMPTS} genuinely different empty-scene prompts all produced a person (last detection: ${((lastCoverage || 0) * 100).toFixed(1)}% of the frame). Please retry the job; generation is nondeterministic. If it keeps failing, simplify your custom instructions — descriptions of clothing, faces or poses never affect a preserved-pixel backdrop.`
  );
}

/** Threshold the feathered mask into a binary preview for diagnostics. */
async function binaryMask(maskPng: Buffer, size: SizeRequest): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const alpha = await sharp(maskPng).extractChannel(3).raw().toBuffer();
  const bin = Buffer.alloc(alpha.length);
  for (let i = 0; i < alpha.length; i++) bin[i] = alpha[i] > 127 ? 255 : 0;
  return sharp(bin, { raw: { width: size.width, height: size.height, channels: 1 } }).png().toBuffer();
}

/** Persist every stage of a variation to the private temp workspace. */
async function writeDiagnostics(
  workspace: string,
  data: {
    variation: number;
    original: Buffer;
    maskPng: Buffer;
    binaryMask: Buffer;
    plate: Buffer;
    composite: Buffer;
    meta: Record<string, unknown>;
  }
): Promise<void> {
  const v = data.variation;
  await writeFrame(workspace, `${v}-original.png`, data.original);
  await writeFrame(workspace, `${v}-subject-mask-binary.png`, data.binaryMask);
  await writeFrame(workspace, `${v}-alpha-feathered.png`, data.maskPng);
  await writeFrame(workspace, `${v}-generated-background.png`, data.plate);
  await writeFrame(workspace, `${v}-final-composite.png`, data.composite);
  await writeFrame(workspace, "manifest.json", Buffer.from(JSON.stringify(data.meta, null, 2)));
}

// ------------------------------------------------------------------ banner

async function runBanner(req: LaxiiRequest, provider: ImageProvider, onProgress: ProgressFn): Promise<RunOutcome> {
  // Style preset is OPTIONAL in the conversational studio: a natural-language
  // description alone is a valid banner brief. Profile Studio presets unchanged.
  const style = req.style ? anyStyle(req.style) : null;
  if (req.style && !style) throw new LaxiiError("Unknown banner style preset");
  const extra = req.instructions?.trim() ?? "";
  const prompt = [style?.scene ?? "", extra, "high quality, detailed"].filter(Boolean).join(", ");
  if (!req.instructions?.trim() && !style) throw new LaxiiError("Describe the banner design you want");
  const results: EngineOutput[] = [];
  const variations = Math.max(1, Math.min(4, req.variations || 1));

  for (let i = 0; i < variations; i++) {
    onProgress(`Generating banner ${i + 1}/${variations}`, 10 + Math.round((35 * i) / variations));
    const genSize = nearestGenerationSize(req.size.width, req.size.height);
    const plate = await provider.textToImage({ prompt, width: genSize.width, height: genSize.height });

    onProgress(`Compositing variation ${i + 1}/${variations}`, 45 + Math.round((45 * i) / variations));
    let scene = style ? await applyGrade(plate, style.grade) : plate;

    // Content preservation: the keep-region layers the ORIGINAL pixels
    // (logos, text, existing content) back over the generated backdrop.
    // The generator never redraws them — it never receives them at all.
    if (req.source && req.subject && req.subject.w > 0 && req.subject.h > 0) {
      const original = await normalizeToPng(await req.source.read());
      scene = await compositeKeepRegion(scene, original, req.subject);
    }

    const finalized = await finalizeSize(scene, req.size);
    results.push(await exportResult(finalized, req));
  }
  onProgress("Done", 100);
  return { results, providerId: provider.id, providerLabel: provider.label };
}

// ------------------------------------------------------------------ background

async function runBackground(req: LaxiiRequest, provider: ImageProvider, onProgress: ProgressFn): Promise<RunOutcome> {
  if (!req.source) throw new LaxiiError("Background replacement needs a source image");
  const style = anyStyle(req.style);
  if (!style) throw new LaxiiError("Unknown background style preset");
  const normalized = await normalizeToPng(await req.source.read());
  const meta = await loadMeta(normalized);
  if (!meta.width || !meta.height) throw new LaxiiError("Source image has no dimensions");

  const results: EngineOutput[] = [];
  const variations = Math.max(1, Math.min(4, req.variations || 1));

  for (let i = 0; i < variations; i++) {
    onProgress(`Generating new backgrounds ${i + 1}/${variations}`, 10 + Math.round((35 * i) / variations));
    const extra = req.instructions ? `, ${req.instructions.trim()}` : "";
    const plate = await provider.textToImage({
      prompt: `${style.scene}${extra}, no text, high quality`,
      width: meta.width,
      height: meta.height,
    });
    onProgress(`Replacing background ${i + 1}/${variations}`, 45 + Math.round((45 * i) / variations));
    const graded = await applyGrade(plate, style.grade);
    // Keep-region defaults to a generous center window so the subject stays original.
    const keep = req.subject ?? { x: 15, y: 8, w: 70, h: 84 };
    const composed = await compositeKeepRegion(graded, normalized, keep);
    const finalized = await finalizeSize(composed, req.size);
    results.push(await exportResult(finalized, req));
  }
  onProgress("Done", 100);
  return { results, providerId: provider.id, providerLabel: provider.label };
}

// ------------------------------------------------------------------ upscale

async function runUpscale(req: LaxiiRequest, onProgress: ProgressFn): Promise<RunOutcome> {
  if (!req.source) throw new LaxiiError("Upscaling needs a source image");
  // Upscaling is a deterministic sharp operation — no inference, no GPU.
  const original = await req.source.read();
  const meta = await loadMeta(original);
  if (!meta.width || !meta.height) throw new LaxiiError("Source image has no dimensions");
  const factor = req.factor ?? 2;
  onProgress("Upscaling", 30);
  const cappedW = Math.min(4096, meta.width * factor);
  const cappedH = Math.min(4096, meta.height * factor);
  const { default: sharp } = await import("sharp");
  const upscaled = await sharp(original)
    .resize(cappedW, cappedH, { kernel: "lanczos3", fit: "fill" })
    .sharpen({ sigma: 0.9, m1: 0.5, m2: 1.0 })
    .png()
    .toBuffer();
  onProgress("Exporting", 80);
  // Export at the COMPUTED size — the job's params carry a 0×0 placeholder
  // for UPSCALE (the real size derives from the source × factor at runtime).
  const results = [await exportResult(upscaled, { ...req, size: { width: cappedW, height: cappedH } })];
  onProgress("Done", 100);
  return { results, providerId: "sharp-lanczos", providerLabel: "Local Lanczos upscaling (sharp)" };
}

// ------------------------------------------------------------------ edit

async function runEdit(req: LaxiiRequest, provider: ImageProvider, onProgress: ProgressFn): Promise<RunOutcome> {
  if (!req.source) throw new LaxiiError("Editing needs a source image");
  if (!req.instructions?.trim()) throw new LaxiiError("Describe the edit you want in the instructions");
  const normalized = await normalizeToPng(await req.source.read());
  // Multi-reference edits (e.g. “put this logo on this product photo”): the
  // engine passes extra references when the provider supports them.
  const extraRefs: Buffer[] = [];
  for (const ref of (req.refs ?? []).slice(0, 3)) {
    extraRefs.push(await normalizeToPng(await ref.read()));
  }
  onProgress("Editing with AI", 25);
  const edited = await provider.imageToImage({
    prompt: `${req.instructions.trim()}, maintain overall composition, high quality`,
    image: normalized,
    extraImages: extraRefs.length ? extraRefs : undefined,
    width: req.size.width,
    height: req.size.height,
  });
  onProgress("Exporting", 80);
  const results = [await exportResult(edited, req)];
  onProgress("Done", 100);
  return { results, providerId: provider.id, providerLabel: provider.label };
}

// ---------------------------------------------------------- creative studio kinds

/** Read the request's extra reference images (honest failure on unreadable refs). */
async function readExtraRefs(req: LaxiiRequest): Promise<Buffer[]> {
  const refs = req.refs ?? [];
  const bufs: Buffer[] = [];
  for (const ref of refs.slice(0, 3)) {
    let buf: Buffer;
    try {
      buf = await ref.read();
    } catch {
      throw new LaxiiError("One of the reference images could not be read from your library");
    }
    bufs.push(await normalizeToPng(buf));
  }
  return bufs;
}

/** GENERATE — text-to-image (optionally reference-conditioned), N variations. */
async function runGenerate(req: LaxiiRequest, provider: ImageProvider, onProgress: ProgressFn): Promise<RunOutcome> {
  const prompt = req.instructions?.trim();
  if (!prompt) throw new LaxiiError("Describe what you want to generate");
  const refs = await readExtraRefs(req);
  const results: EngineOutput[] = [];
  const variations = Math.max(1, Math.min(4, req.variations || 1));
  for (let i = 0; i < variations; i++) {
    onProgress(`Generating ${i + 1}/${variations}`, 10 + Math.round((70 * i) / variations));
    const buf = refs.length
      ? await provider.imageToImage({
          prompt,
          image: refs[0],
          extraImages: refs.slice(1).length ? refs.slice(1) : undefined,
          width: req.size.width,
          height: req.size.height,
        })
      : await provider.textToImage({ prompt, width: req.size.width, height: req.size.height });
    results.push(await exportResult(buf, req));
  }
  onProgress("Done", 100);
  return { results, providerId: provider.id, providerLabel: provider.label };
}

/** VARIATIONS — N genuine generative variations of a source image. */
async function runVariations(req: LaxiiRequest, provider: ImageProvider, onProgress: ProgressFn): Promise<RunOutcome> {
  if (!req.source) throw new LaxiiError("Variations need a source image");
  const normalized = await normalizeToPng(await req.source.read());
  const userDirection = req.instructions?.trim();
  const basePrompt =
    "Create a fresh variation of this image: keep the same subject, identity and overall composition, " +
    "while exploring a new interpretation of style, lighting and detail. High quality, detailed." +
    (userDirection ? ` Direction: ${userDirection}.` : "");
  const results: EngineOutput[] = [];
  const variations = Math.max(1, Math.min(4, req.variations || 1));
  for (let i = 0; i < variations; i++) {
    onProgress(`Creating variation ${i + 1}/${variations}`, 10 + Math.round((70 * i) / variations));
    const buf = await provider.imageToImage({
      prompt: basePrompt,
      image: normalized,
      width: req.size.width,
      height: req.size.height,
    });
    results.push(await exportResult(buf, req));
  }
  onProgress("Done", 100);
  return { results, providerId: provider.id, providerLabel: provider.label };
}

/**
 * REMOVE_BG — subject cutout to a transparent PNG through the LOCAL MODNet
 * alpha matte (the same license-verified segmentation stack the PRESERVE
 * avatar pipeline uses). No provider inference, no fake thresholding — the
 * hair-level matte IS the output alpha.
 */
async function runRemoveBackground(req: LaxiiRequest, onProgress: ProgressFn): Promise<RunOutcome> {
  if (!req.source) throw new LaxiiError("Background removal needs a source image");
  if (!segmentationAvailable().ok) {
    throw new LaxiiError(
      "Background removal needs the local segmentation weights. Install them with: bun ./scripts/laxii/prefetch-models.ts"
    );
  }
  const normalized = await normalizeToPng(await req.source.read());
  onProgress("Detecting subject", 30);
  const matte = await subjectMatte(normalized);
  if (matte.coverage < MIN_COVERAGE) throw matteConfidenceError(matte.coverage);

  onProgress("Cutting out subject", 60);
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(normalized).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let alpha = matte.alpha;
  if (matte.width !== info.width || matte.height !== info.height) {
    // Defensive: the matte must match the frame — resize it if a pipeline
    // stage changed dimensions (never silently misalign alpha).
    alpha = await sharp(alpha, { raw: { width: matte.width, height: matte.height, channels: 1 } })
      .resize(info.width, info.height, { fit: "fill" })
      .raw()
      .toBuffer();
  }
  for (let i = 0; i < info.width * info.height; i++) data[i * 4 + 3] = alpha[i];
  const cutout = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();

  onProgress("Exporting", 85);
  const results = [
    await exportResult(cutout, { ...req, size: { width: info.width, height: info.height }, format: "PNG" }, "modnet"),
  ];
  onProgress("Done", 100);
  return { results, providerId: "modnet-local", providerLabel: "Local MODNet matting (segmentation cutout)" };
}

/**
 * OUTPAINT — real generative canvas expansion: the source is centered on the
 * target canvas over a blurred self-prior, and the model completes the scene
 * so the whole frame becomes one continuous picture. Sharp only BUILDS the
 * prior — the semantic completion is genuine model inference.
 */
async function runOutpaint(req: LaxiiRequest, provider: ImageProvider, onProgress: ProgressFn): Promise<RunOutcome> {
  if (!req.source) throw new LaxiiError("Canvas expansion needs a source image");
  const target = { width: Math.max(16, Math.min(4096, req.size.width)), height: Math.max(16, Math.min(4096, req.size.height)) };
  const original = await normalizeToPng(await req.source.read());
  const { default: sharp } = await import("sharp");

  onProgress("Preparing canvas", 15);
  const bg = await sharp(original).resize(target.width, target.height, { fit: "cover" }).blur(32).toBuffer();
  const fg = await sharp(original).resize(target.width, target.height, { fit: "inside" }).png().toBuffer();
  const fgMeta = await loadMeta(fg);
  const canvas = await sharp(bg)
    .composite([
      {
        input: fg,
        left: Math.round((target.width - fgMeta.width) / 2),
        top: Math.round((target.height - fgMeta.height) / 2),
      },
    ])
    .png()
    .toBuffer();

  onProgress("Extending scene with AI", 40);
  const prompt =
    "Seamlessly extend and complete the scene of this image so the ENTIRE canvas is one continuous, coherent picture. " +
    "Keep the central original content unchanged; naturally continue the environment, lighting, textures and perspective " +
    "into the surrounding area. No text, no watermark, no border artifacts. High quality, detailed." +
    (req.instructions?.trim() ? ` ${req.instructions.trim()}` : "");
  const completed = await provider.imageToImage({ prompt, image: canvas, width: target.width, height: target.height });

  onProgress("Exporting", 85);
  const finalized = await finalizeSize(completed, target);
  const results = [await exportResult(finalized, { ...req, size: target })];
  onProgress("Done", 100);
  return { results, providerId: provider.id, providerLabel: provider.label };
}

// ------------------------------------------------------------------ shared

async function exportResult(buf: Buffer, req: LaxiiRequest, segmentation?: "modnet" | "window"): Promise<EngineOutput> {
  const out = await exportImage(buf, req.size, req.format ?? "PNG", req.quality ?? 92);
  return {
    buffer: out.data,
    width: out.width,
    height: out.height,
    format: req.format ?? "PNG",
    bytes: out.data.length,
    sharpness: out.sharpness,
    blockiness: out.blockiness,
    segmentation,
  };
}

export type { TextToImageRequest, ImageToImageRequest };
