/**
 * LAXII — plain-banner request compiler.
 *
 * Historically a banner request typed in the studio composer went to the
 * engine VERBATIM (plus a canvas hint): the model tried to paint the text
 * itself, misspelled headlines were common, no composition plan or quality
 * loop ran. This module compiles that free-form request into the SAME
 * structured DesignBrief the Riishe handoff uses, so EVERY banner benefits
 * from the professional pipeline:
 *
 *   composition plan → background without text → deterministic typography
 *   (exact wording, measured contrast, safe-area checks) → quality
 *   evaluation → bounded refinement → exact-canvas export.
 *
 * Determinism: quoted wording is extracted by regex (art-direction.ts) and
 * rendered deterministically; the user's request is preserved verbatim as
 * brief.request (highest precedence in compileBriefPrompt).
 */

import { extractQuotedTypography, detectArtDirection } from "./art-direction";
import { BRIEF_SCHEMA_VERSION, type DesignBrief } from "./design-brief";
import { CUSTOM_BANNER_SLUG, CUSTOM_CANVAS_LIMITS, findBannerPreset } from "./banner-presets";

/**
 * Compile a plain banner request into a synthetic USER-sourced brief.
 * Throws when the preset slug is unknown (the caller validated it already).
 * Custom canvases pass `canvasOverride` (both dimensions required, enforced
 * against the documented limits); registry slugs ignore the override unless
 * it disagrees with the preset, in which case they throw.
 */
export function buildPlainBannerBrief(
  prompt: string,
  presetSlug: string,
  canvasOverride?: { width: number; height: number }
): DesignBrief {
  const preset = findBannerPreset(presetSlug);
  if (preset) {
    if (canvasOverride && (canvasOverride.width !== preset.width || canvasOverride.height !== preset.height)) {
      throw new Error(`Canvas override disagrees with the authoritative "${presetSlug}" preset — refusing to guess dimensions.`);
    }
  } else if (presetSlug === CUSTOM_BANNER_SLUG) {
    if (!canvasOverride) throw new Error("Custom banner canvases require explicit width and height.");
    if (!canvasMatchesPreset({ presetSlug: CUSTOM_BANNER_SLUG, ...canvasOverride })) {
      throw new Error("Custom banner canvas is outside the documented dimension limits.");
    }
  } else {
    throw new Error(`Unknown banner preset "${presetSlug}" — refusing to compile a banner brief.`);
  }
  const width = preset ? preset.width : canvasOverride!.width;
  const height = preset ? preset.height : canvasOverride!.height;
  const trimmed = prompt.trim();
  const quoted = extractQuotedTypography(trimmed);
  const direction = detectArtDirection(trimmed);

  const directionBlock = [
    direction ? `Professional direction: ${direction.label}.` : "Professional direction: premium portfolio banner.",
    direction?.directive ?? "",
    `Canvas composition: anchor the subject and key elements in the vertical center band of the ${width}×${height} canvas; calm margins at the top and bottom; full-bleed, edge-to-edge scene.`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    // The user's request verbatim — authoritative, never paraphrased.
    request: trimmed,
    profession: null,
    targetAudience: null,
    portfolio: { permission: "self", used: false, summary: [] },
    visualIdentity: { toneWords: [], notes: [] },
    direction: directionBlock.slice(0, 1200),
    subject: {
      description: (quoted.subject || trimmed).slice(0, 600),
      focalPoint: "",
    },
    background: "",
    composition: {
      hierarchy: quoted.items.length ? "Text block first (deterministic layer), scene second" : "",
      // Deterministic default: text left, visual focal point right (the
      // composition planner mirrors the focal region accordingly).
      textPlacement: "left",
      notes: [],
    },
    palette: [],
    typography: {
      items: quoted.items.map((t) => ({ ...t, align: undefined, color: undefined })),
      notes: quoted.items.length
        ? ["Exact wording from the user's composer request — rendered by the deterministic typography layer, never re-spelled by the model."]
        : [],
    },
    canvas: { presetSlug, width, height },
    safeArea: preset
      ? preset.safeArea
      : {
          x: Math.round((width * (1 - 0.86)) / 2),
          y: Math.round((height * (1 - 0.9)) / 2),
          width: Math.round(width * 0.86),
          height: Math.round(height * 0.9),
        },
    referenceMediaIds: [],
    preserve: [],
    avoid: [],
    export: { format: "png", exactDimensions: true },
    revisions: [],
    source: "USER",
    sourceTaskId: "plain-banner",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Whether a (possibly legacy or custom) stored banner canvas can run through
 * the professional pipeline. Registry presets must match their authoritative
 * dimensions exactly; the strictly-bounded custom canvas family is valid when
 * the stored dimensions are inside the documented limits. Unknown/legacy
 * slugs keep the direct path (cover-fit composite) instead of failing.
 */
export function canvasMatchesPreset(canvas: { width: number; height: number; presetSlug: string }): boolean {
  const preset = findBannerPreset(canvas.presetSlug);
  if (preset) return preset.width === canvas.width && preset.height === canvas.height;
  if (canvas.presetSlug === CUSTOM_BANNER_SLUG) {
    const { minSide, maxSide, maxAreaPx } = CUSTOM_CANVAS_LIMITS;
    const { width, height } = canvas;
    return (
      Number.isInteger(width) &&
      Number.isInteger(height) &&
      width >= minSide &&
      height >= minSide &&
      width <= maxSide &&
      height <= maxSide &&
      width * height <= maxAreaPx
    );
  }
  return false;
}
