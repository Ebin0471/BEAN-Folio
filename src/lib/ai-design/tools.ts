/**
 * Code Giftz — the mutation-tool registry.
 *
 * THE single source of truth for what the agent can actually execute against a
 * website draft. A plan step is only valid when its `tool` is one of these ids;
 * the executor implements exactly these tools — nothing else can run, so the
 * agent can never claim (or attempt) an action the platform does not support.
 *
 * Two families:
 *  - deterministic tools resolve entirely from the plan step (a token patch or
 *    a curated library id) and run WITHOUT a model call — reliable and exact;
 *  - model tools are executed by a scoped LLM step whose output is validated
 *    against the site schema before it touches the working config.
 *
 * Anything a user might ask for that is NOT in this registry (custom code,
 * form backends, third-party embeds, uploads, publishing…) is listed in
 * UNSUPPORTED so prompts, the UI and the docs state the limit honestly.
 */

export type ToolFamily = "deterministic" | "model";
export type ToolTargetKind = "none" | "section" | "page" | "library-id";

export interface ToolDef {
  id: string;
  label: string;
  family: ToolFamily;
  /** What kind of target the step's `targets` array must resolve to. */
  targetKind: ToolTargetKind;
  /** Whether the step requires an instruction for a model call. */
  needsInstruction: boolean;
  description: string;
}

export const STEP_TOOLS: readonly ToolDef[] = [
  {
    id: "theme.tokens",
    label: "Design tokens",
    family: "deterministic",
    targetKind: "none",
    needsInstruction: false,
    description: "Colors, surface, radius, density, type scale, line height, letter spacing, heading weight, content width, columns, button/link style, image ratio, divider, page transition, nav layout, heading alignment, glass, the site name and the tagline — applied from the step's patch.",
  },
  {
    id: "typography.fonts",
    label: "Typography",
    family: "deterministic",
    targetKind: "none",
    needsInstruction: false,
    description: "Heading/body/accent/code typefaces from the 129-family library — applied from the step's patch (headingFont, bodyFont, accentFont, codeFont).",
  },
  {
    id: "motion.configure",
    label: "Motion & animation",
    family: "deterministic",
    targetKind: "none",
    needsInstruction: false,
    description: "Reveal preset, duration, stagger, easing, intensity, hover effects, scroll reveal, once/repeat, background effect, 3D scenes (scene3d block), micro-interactions — applied from the step's patch.",
  },
  {
    id: "palette.apply",
    label: "Color system",
    family: "deterministic",
    targetKind: "library-id",
    needsInstruction: false,
    description: "Apply one curated color system by id (targets: [paletteId]) — color tokens only; typography, layout and motion untouched.",
  },
  {
    id: "preset.apply",
    label: "Design preset",
    family: "deterministic",
    targetKind: "library-id",
    needsInstruction: false,
    description: "Apply one curated design-preset token set (colors + type + motion together) by id (targets: [presetId]).",
  },
  {
    id: "template.apply",
    label: "Template",
    family: "deterministic",
    targetKind: "library-id",
    needsInstruction: false,
    description: "Switch to one of the curated templates by id (targets: [templateId]) — its theme/motion/nav defaults; pages and content are kept.",
  },
  {
    id: "section.add",
    label: "Add section",
    family: "model",
    targetKind: "page",
    needsInstruction: true,
    description: "Create a new section (any of the 15 section types: hero, about, projects, skills, stats, collections, contact, services, experience, gallery, testimonials, process, faq, pricing, logos) on a target page, with its content.",
  },
  {
    id: "section.update",
    label: "Update section",
    family: "model",
    targetKind: "section",
    needsInstruction: true,
    description: "Edit the content/fields/layout of existing sections (targets: section ids).",
  },
  {
    id: "section.reorder",
    label: "Restructure sections",
    family: "model",
    targetKind: "page",
    needsInstruction: true,
    description: "Reorder, duplicate or reorganize sections on a target page.",
  },
  {
    id: "section.remove",
    label: "Remove section",
    family: "model",
    targetKind: "section",
    needsInstruction: true,
    description: "Delete sections (targets: section ids).",
  },
  {
    id: "page.add",
    label: "Add page",
    family: "model",
    targetKind: "none",
    needsInstruction: true,
    description: "Create an additional website page (max 8) with its sections.",
  },
  {
    id: "page.update",
    label: "Update page",
    family: "model",
    targetKind: "page",
    needsInstruction: true,
    description: "Rename pages, toggle visibility or restyle page-level structure (targets: page ids).",
  },
  {
    id: "page.remove",
    label: "Remove page",
    family: "model",
    targetKind: "page",
    needsInstruction: true,
    description: "Delete a page (never the last remaining one).",
  },
  {
    id: "content.write",
    label: "Content editing",
    family: "model",
    targetKind: "section",
    needsInstruction: true,
    description: "Write or refine real copy (titles, bodies, service/experience/testimonial/process/faq/pricing items) inside existing sections. Never invents facts, quotes, metrics, clients or prices.",
  },
  {
    id: "site.compose",
    label: "Compose custom website",
    family: "model",
    targetKind: "none",
    needsInstruction: true,
    description: "Build a COMPLETE custom website (every page and section) from the user's uploaded source materials and stated vision — the 'Create my own website' workflow. Generates a fresh composition instead of forcing a preset template; real profile data still flows in through the {bio}/{name}/{headline}/{location}/{availability} placeholders at view time.",
  },
] as const;

export const TOOL_IDS = STEP_TOOLS.map((t) => t.id);

const BY_ID = new Map(STEP_TOOLS.map((t) => [t.id, t]));

export function getTool(id: string): ToolDef | null {
  return BY_ID.get(id) ?? null;
}

/** Capabilities the platform genuinely does NOT have — surfaced, never faked. */
export const UNSUPPORTED_CAPABILITIES: readonly string[] = [
  "Custom HTML/CSS/JS code editing (the site is schema-driven; export the ZIP to edit code by hand)",
  "Form builders or form submission backends (the contact section renders an inquiry/mailto flow)",
  "Generating images into the site (source images come from materials uploaded via the 'Create my own website' workflow, or the editor's own logo/cover uploaders)",
  "Publishing, unpublishing or touching the live website (publishing is a separate manual action)",
  "Third-party embeds (maps, video iframes, analytics snippets)",
  "Custom domains or DNS (see the publish dialog for hosting/export options)",
];
