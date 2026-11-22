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
import { findBannerPreset } from "./banner-presets";

/**
 * Compile a plain banner request into a synthetic USER-sourced brief.
 * Throws when the preset slug is unknown (the caller validated it already).
 */
export function buildPlainBannerBrief(prompt: string, presetSlug: string): DesignBrief {
  const preset = findBannerPreset(presetSlug);
  if (!preset) throw new Error(`Unknown banner preset "${presetSlug}" — refusing to compile a banner brief.`);
  const trimmed = prompt.trim();
  const quoted = extractQuotedTypography(trimmed);
  const direction = detectArtDirection(trimmed);

  const directionBlock = [
    direction ? `Professional direction: ${direction.label}.` : "Professional direction: premium portfolio banner.",
    direction?.directive ?? "",
    "Banner-specific composition: one coherent horizontal band; subject and key elements anchored in the vertical center half; calm margins above and below; full-bleed, edge-to-edge scene.",
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
    canvas: { presetSlug: preset.slug, width: preset.width, height: preset.height },
    safeArea: preset.safeArea,
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
 * Whether a (possibly legacy) stored banner canvas can run through the
 * professional pipeline: the pipeline is authoritative about preset
 * dimensions and refuses mismatches, so plain requests on legacy canvases
 * keep the direct path (cover-fit composite) instead of failing.
 */
export function canvasMatchesPreset(canvas: { width: number; height: number; presetSlug: string }): boolean {
  const preset = findBannerPreset(canvas.presetSlug);
  return Boolean(preset && preset.width === canvas.width && preset.height === canvas.height);
}
