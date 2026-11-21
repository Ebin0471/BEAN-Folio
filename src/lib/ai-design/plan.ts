/**
 * Code Giftz — plan schema + validation.
 *
 * A plan is the agent's structured implementation strategy for a request:
 * ordered steps, each bound to a REAL mutation tool, with dependencies,
 * change-family classification (design / content / functionality /
 * architecture), explicit preservation constraints from the user, and — for
 * deterministic tools — the exact patch or library id to apply.
 *
 * Everything here is validated against the REAL site before a plan is offered
 * to the user: unknown tools, targets that do not exist, forward/cyclic
 * dependencies and constraint conflicts are rejected. The model proposes; this
 * module disposes.
 *
 * Pure module — safe to import from client and server code.
 */
import { z } from "zod";

import { getTool } from "@/lib/ai-design/tools";
import type { SiteDigest } from "@/lib/ai-design/digest";
import { resolveConstraintTarget } from "@/lib/ai-design/constraints";
import { PALETTES } from "@/lib/site-palettes";
import { GLASS_PRESET_IDS, designPresets, templatePresets } from "@/lib/site-config";
import { motionPresetsByScope } from "@/lib/site-motion";
import { gsapMotionBlockSchema, backgroundEffectsSchema } from "@/lib/giftz/motion-engine";
import { scene3dBlockSchema } from "@/lib/giftz/scene3d";

// ---------------------------------------------------------------- patch schema
// Deterministic token patches — every field optional, merged onto the working
// config and re-validated by the site schema. Structural changes (pages,
// sections) are NEVER patched — they belong to model tools, so partial section
// shapes can never sneak into the config.

const hexColor = z.string().regex(/^#[0-9a-fA-F]{3,8}$/);

export const themePatchSchema = z
  .object({
    background: hexColor.optional(),
    foreground: hexColor.optional(),
    accent: hexColor.optional(),
    accent2: hexColor.optional(),
    surface: hexColor.optional(),
    border: hexColor.optional(),
    muted: hexColor.optional(),
    focus: hexColor.optional(),
    gradient: z
      .object({ from: hexColor, to: hexColor, angle: z.number().int().min(0).max(360) })
      .nullable()
      .optional(),
    surfaceOpacity: z.number().int().min(20).max(100).optional(),
    radius: z.enum(["none", "md", "full"]).optional(),
    density: z.enum(["compact", "regular", "relaxed"]).optional(),
    typeScale: z.enum(["intimate", "balanced", "grand"]).optional(),
    lineHeight: z.enum(["tight", "normal", "relaxed"]).optional(),
    letterSpacing: z.enum(["tight", "normal", "wide"]).optional(),
    headingWeight: z.enum(["light", "semibold", "bold"]).optional(),
    contentWidth: z.enum(["narrow", "regular", "wide"]).optional(),
    columns: z.union([z.literal(0), z.literal(2), z.literal(3)]).optional(),
    buttonStyle: z.enum(["sharp", "rounded", "pill", "outline"]).optional(),
    linkStyle: z.enum(["underline", "accent", "plain"]).optional(),
    imageRatio: z.enum(["4/3", "3/2", "1/1", "16/9"]).optional(),
    divider: z.enum(["none", "line", "accent"]).optional(),
    pageTransition: z.enum(["none", "fade", "slide", "rise", "zoom"]).optional(),
    navLayout: z.enum(["inline", "stacked", "centered"]).optional(),
    headingAlign: z.enum(["left", "center"]).optional(),
    headingFont: z.string().max(48).optional(),
    bodyFont: z.string().max(48).optional(),
    accentFont: z.string().max(48).optional(),
    codeFont: z.string().max(48).optional(),
    // Navigation/button typefaces are real SiteTheme tokens — the planner may
    // legitimately target them, so the patch schema must accept them too
    // (planner ↔ schema ↔ executor alignment; the executor derives them
    // through deriveTheme exactly like the other font roles).
    navFont: z.string().max(48).optional(),
    buttonFont: z.string().max(48).optional(),
  })
  .strict();

export const motionPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    preset: z.string().max(48).optional(),
    duration: z.number().int().min(150).max(1200).optional(),
    stagger: z.number().int().min(0).max(240).optional(),
    easing: z.string().max(40).optional(),
    intensity: z.number().int().min(0).max(100).optional(),
    hoverEffects: z.boolean().optional(),
    scrollReveal: z.boolean().optional(),
    once: z.boolean().optional(),
    // Per-reveal delay — a real motionSchema token (0-600ms). Kept in lockstep
    // with lib/site-config's motionSchema so the planner can never name a
    // token the executor rejects (and vice versa).
    delay: z.number().int().min(0).max(600).optional(),
    background: z.string().max(40).optional(),
    microInteractions: z.string().max(40).optional(),
    // Thin reading-progress indicator — a real motionSchema token (boolean).
    scrollProgress: z.boolean().optional(),
    // GIFTZ GSAP Motion Engine (M15) — validated against the motion-engine
    // preset registry by normalizeConfig; null disables the engine.
    gsap: gsapMotionBlockSchema.nullable().optional(),
  })
  .strict();

/**
 * Glassmorphism patch — mirrors the REAL glass schema (lib/site-config
 * glassSchema): every field is optional so a step can tune ONE aspect (blur
 * only, or just enable a preset) without resetting the rest. The executor
 * deep-merges this onto the existing glass config and the site schema
 * re-validates the result — no invented properties, no free-form CSS.
 */
export const glassPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    preset: z.enum(GLASS_PRESET_IDS).optional(),
    /** Which site elements get the glass treatment. */
    targets: z
      .object({
        nav: z.boolean().optional(),
        cards: z.boolean().optional(),
        buttons: z.boolean().optional(),
      })
      .strict()
      .optional(),
    blur: z.number().int().min(0).max(40).optional(),
    /** Tint opacity percentage (0–90; higher = more solid). */
    opacity: z.number().int().min(0).max(90).optional(),
    tint: hexColor.optional(),
    borderOpacity: z.number().int().min(0).max(100).optional(),
    borderWidth: z.number().int().min(0).max(4).optional(),
    highlight: z.number().int().min(0).max(100).optional(),
    shadow: z.number().int().min(0).max(100).optional(),
    /** Subtle gradient inside the glass surface. */
    gradient: z.boolean().optional(),
  })
  .strict();

export const designPatchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    tagline: z.string().max(160).optional(),
    theme: themePatchSchema.extend({ glass: glassPatchSchema.nullable().optional() }).optional(),
    motion: motionPatchSchema.optional(),
    // GIFTZ Vanta background engine (M16) — full-block replace semantics;
    // null disables the background engine.
    backgroundEffects: backgroundEffectsSchema.nullable().optional(),
    // GIFTZ structured 3D scene engine (GZ-3) — full-block replace semantics;
    // null disables the 3D engine.
    scene3d: scene3dBlockSchema.nullable().optional(),
  })
  .strict();

export type DesignPatch = z.infer<typeof designPatchSchema>;

// ---------------------------------------------------------------- patch coercion
// Models naturally write FLAT patches ("headingFont": "…", "duration": 400)
// even though the canonical shape nests fonts under theme and motion keys
// under motion. The plan boundary accepts BOTH: this coercion folds flat
// font/motion keys into their canonical groups before the strict schema
// runs. Deterministic, idempotent, and it keeps the internal contract strict.

const FONT_KEYS = ["headingFont", "bodyFont", "accentFont", "codeFont", "navFont", "buttonFont"] as const;
const MOTION_KEYS = ["enabled", "preset", "duration", "stagger", "delay", "easing", "intensity", "hoverEffects", "scrollReveal", "once", "microInteractions", "background", "scrollProgress"] as const;
/** Theme tokens that models write flat ("typeScale": "grand") — folded into theme. */
const THEME_TOKEN_KEYS = [
  "foreground", "accent", "accent2", "surface", "border", "muted", "focus", "gradient",
  "surfaceOpacity", "radius", "density", "typeScale", "lineHeight", "letterSpacing",
  "headingWeight", "contentWidth", "columns", "buttonStyle", "linkStyle", "imageRatio",
  "divider", "pageTransition", "navLayout", "headingAlign",
] as const;
/**
 * Glass-system keys models write FLAT on a patch ("blur": 24). They exist in
 * NO other token group, so folding them into theme.glass loses nothing and
 * rescues the patch from a strict-schema rejection. Bare "opacity" maps to
 * glass opacity (the theme-level one is "surfaceOpacity").
 */
const GLASS_FLAT_KEYS: Record<string, string> = {
  blur: "blur",
  opacity: "opacity",
  tint: "tint",
  borderOpacity: "borderOpacity",
  borderWidth: "borderWidth",
  highlight: "highlight",
  shadow: "shadow",
};
/** Explicitly prefixed glass keys ("glassBlur": 24) — same fold, zero ambiguity. */
const GLASS_PREFIXED_KEYS: Record<string, string> = {
  glassEnabled: "enabled",
  glassPreset: "preset",
  glassBlur: "blur",
  glassOpacity: "opacity",
  glassTint: "tint",
  glassBorderOpacity: "borderOpacity",
  glassBorderWidth: "borderWidth",
  glassHighlight: "highlight",
  glassShadow: "shadow",
  glassGradient: "gradient",
};
/** Per-target glass switches ("glassNav": true) — folded into theme.glass.targets. */
const GLASS_TARGET_KEYS: Record<string, string> = {
  glassNav: "nav",
  glassCards: "cards",
  glassButtons: "buttons",
};
const GLASS_PRESET_LIST = GLASS_PRESET_IDS as readonly string[];

/**
 * Glass shorthand: a model may write "glass": "frosted" (a preset name) or
 * "glass": "none" (disable) instead of a full object. Known words become the
 * real token object; unknown strings pass through for the strict schema to
 * reject PRECISELY (never silently guessed into a different token).
 */
function glassShorthand(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim().toLowerCase();
  if (["none", "off", "disabled", "flat", "solid"].includes(t)) return { enabled: false };
  if (GLASS_PRESET_LIST.includes(t)) return { enabled: true, preset: t };
  return v;
}

export function coerceDesignPatch(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const src = { ...(raw as Record<string, unknown>) };
  const themeIn: Record<string, unknown> =
    src.theme && typeof src.theme === "object" && !Array.isArray(src.theme)
      ? { ...(src.theme as Record<string, unknown>) }
      : {};
  const motionIn: Record<string, unknown> =
    src.motion && typeof src.motion === "object" && !Array.isArray(src.motion)
      ? { ...(src.motion as Record<string, unknown>) }
      : {};
  /** Merge one key into the theme.glass group (creating/deep-folding targets). */
  const foldGlass = (key: string, value: unknown) => {
    if (key === "targets") {
      const t =
        themeIn.glass && typeof themeIn.glass === "object" && !Array.isArray(themeIn.glass)
          ? (themeIn.glass as Record<string, unknown>)
          : {};
      const targets = t.targets && typeof t.targets === "object" && !Array.isArray(t.targets) ? { ...(t.targets as Record<string, unknown>) } : {};
      Object.assign(targets, value as Record<string, unknown>);
      t.targets = targets;
      themeIn.glass = t;
      return;
    }
    if (themeIn.glass && typeof themeIn.glass === "object" && !Array.isArray(themeIn.glass)) {
      (themeIn.glass as Record<string, unknown>)[key] = value;
    } else {
      themeIn.glass = { [key]: value };
    }
  };
  for (const k of Object.keys(src)) {
    if (k === "theme" || k === "motion" || k === "name" || k === "tagline") continue;
    const v = src[k];
    if (k === "glass") {
      themeIn.glass = glassShorthand(v);
      delete src[k];
      continue;
    }
    if (k in GLASS_PREFIXED_KEYS) {
      foldGlass(GLASS_PREFIXED_KEYS[k], v);
      delete src[k];
      continue;
    }
    if (k in GLASS_TARGET_KEYS) {
      foldGlass("targets", { [GLASS_TARGET_KEYS[k]]: v });
      delete src[k];
      continue;
    }
    if (k in GLASS_FLAT_KEYS) {
      foldGlass(GLASS_FLAT_KEYS[k], v);
      delete src[k];
      continue;
    }
    if ((FONT_KEYS as readonly string[]).includes(k)) {
      themeIn[k] = v;
      delete src[k];
      continue;
    }
    if ((MOTION_KEYS as readonly string[]).includes(k)) {
      // "background" is ambiguous: a motion background id is "bg-*", a theme
      // background is a color. Colors stay in the theme group.
      if (k === "background" && !(typeof v === "string" && v.startsWith("bg-"))) {
        themeIn[k] = v;
      } else {
        motionIn[k] = v;
      }
      delete src[k];
      continue;
    }
    if ((THEME_TOKEN_KEYS as readonly string[]).includes(k)) {
      themeIn[k] = v;
      delete src[k];
      continue;
    }
  }
  if (Object.keys(themeIn).length > 0) src.theme = themeIn;
  if (Object.keys(motionIn).length > 0) src.motion = motionIn;
  // A string glass shorthand may also arrive NESTED inside the theme group
  // ("theme": { "glass": "dark" }) — normalize it exactly like the flat one.
  if (typeof themeIn.glass === "string") themeIn.glass = glassShorthand(themeIn.glass);
  return src;
}

// ---------------------------------------------------------------- plan kinds

export const PLAN_STEP_KINDS = ["design", "content", "functionality", "architecture"] as const;
type PlanStepKind = (typeof PLAN_STEP_KINDS)[number];

// ---------------------------------------------------------------- plan JSON normalization
// Models keep producing SCHEMATICALLY-valid-in-spirit plans that fail the
// strict Zod contract for representational reasons only: null instead of a
// missing optional field, a single string instead of a one-element array,
// wrongly-cased enums, unknown keys inside a patch, steps as an object.
// None of those change WHAT the plan does — they only change how it is
// WRITTEN. normalizePlanJson coerces exactly those representations and
// strips token keys the schema does not define (the strict schema still
// validates everything that remains — nothing security-relevant is weakened:
// tool membership, target existence, constraints and the patch merge are all
// validated downstream exactly as before).

const PLAN_KINDS = PLAN_STEP_KINDS;
const PLAN_RISKS = ["low", "medium", "high"] as const;
/** Known theme token keys of the patch schema, with a shape check per key. */
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const THEME_ENUMS: Record<string, readonly string[]> = {
  radius: ["none", "md", "full"],
  density: ["compact", "regular", "relaxed"],
  typeScale: ["intimate", "balanced", "grand"],
  lineHeight: ["tight", "normal", "relaxed"],
  letterSpacing: ["tight", "normal", "wide"],
  headingWeight: ["light", "semibold", "bold"],
  contentWidth: ["narrow", "regular", "wide"],
  buttonStyle: ["sharp", "rounded", "pill", "outline"],
  linkStyle: ["underline", "accent", "plain"],
  imageRatio: ["4/3", "3/2", "1/1", "16/9"],
  divider: ["none", "line", "accent"],
  pageTransition: ["none", "fade", "slide", "rise", "zoom"],
  navLayout: ["inline", "stacked", "centered"],
  headingAlign: ["left", "center"],
};
const THEME_COLOR_KEYS = ["background", "foreground", "accent", "accent2", "surface", "border", "muted", "focus"] as const;
const THEME_FONT_KEYS = ["headingFont", "bodyFont", "accentFont", "codeFont", "navFont", "buttonFont"] as const;
const MOTION_FIELDS = new Set([
  "enabled", "preset", "duration", "stagger", "delay", "easing", "intensity",
  "hoverEffects", "scrollReveal", "once", "background", "microInteractions", "scrollProgress",
]);

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i >= min && i <= max ? i : null;
}

function asStringArray(v: unknown, max: number): string[] | null {
  // Single string → one-element array (a very common model shorthand).
  if (typeof v === "string") return v.trim() ? [v.trim().slice(0, 80)] : [];
  if (!Array.isArray(v)) return null;
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .slice(0, max);
}

/** Keep only patch keys the strict patch schemas actually define, with valid shapes. */
function sanitizePatchGroup(group: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!group || typeof group !== "object" || Array.isArray(group)) return out;
  const g = group as Record<string, unknown>;
  for (const [k, v] of Object.entries(g)) {
    if (THEME_COLOR_KEYS.includes(k as (typeof THEME_COLOR_KEYS)[number])) {
      if (typeof v === "string" && HEX_RE.test(v.trim())) out[k] = v.trim();
      continue;
    }
    if (k === "gradient") {
      if (v === null) {
        out[k] = null;
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        const gr = v as Record<string, unknown>;
        const from = typeof gr.from === "string" && HEX_RE.test(gr.from.trim()) ? gr.from.trim() : null;
        const to = typeof gr.to === "string" && HEX_RE.test(gr.to.trim()) ? gr.to.trim() : null;
        const angle = clampInt(gr.angle, 0, 360);
        if (from && to && angle !== null) out[k] = { from, to, angle };
      }
      continue;
    }
    if (k === "surfaceOpacity") {
      const n = clampInt(v, 20, 100);
      if (n !== null) out[k] = n;
      continue;
    }
    if (k in THEME_ENUMS) {
      if (typeof v === "string" && THEME_ENUMS[k].includes(v)) out[k] = v;
      continue;
    }
    if (k === "columns") {
      const n = clampInt(v, 0, 3);
      if (n === 0 || n === 2 || n === 3) out[k] = n;
      continue;
    }
    if (THEME_FONT_KEYS.includes(k as (typeof THEME_FONT_KEYS)[number])) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 48);
      continue;
    }
    if (k === "glass") {
      // object → sanitized glass token group; preset string → enabled token;
      // null → glass explicitly disabled (a REAL, executable token state).
      if (v === null) {
        out[k] = null;
        continue;
      }
      const sanitized = sanitizeGlassGroup(typeof v === "string" ? glassShorthand(v) : v);
      if (sanitized !== null) out[k] = sanitized;
      continue;
    }
    // Unknown theme key — dropped (the strict schema would reject the whole
    // plan for it; the sanitized plan simply does not carry the junk).
  }
  return out;
}

/**
 * Keep only glass keys the REAL glass schema defines, with valid shapes and
 * ranges. Returns null for a null group (glass explicitly disabled), and a
 * sanitized object otherwise (empty → null — nothing valid survived).
 */
function sanitizeGlassGroup(group: unknown): Record<string, unknown> | null {
  if (group === null) return null;
  if (!group || typeof group !== "object" || Array.isArray(group)) return null;
  const g = group as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof g.enabled === "boolean") out.enabled = g.enabled;
  if (typeof g.preset === "string" && GLASS_PRESET_LIST.includes(g.preset.trim().toLowerCase())) {
    out.preset = g.preset.trim().toLowerCase();
  }
  if (g.targets && typeof g.targets === "object" && !Array.isArray(g.targets)) {
    const t = g.targets as Record<string, unknown>;
    const targets: Record<string, unknown> = {};
    for (const tk of ["nav", "cards", "buttons"] as const) {
      if (typeof t[tk] === "boolean") targets[tk] = t[tk];
    }
    if (Object.keys(targets).length > 0) out.targets = targets;
  }
  for (const [key, min, max] of [
    ["blur", 0, 40],
    ["opacity", 0, 90],
    ["borderOpacity", 0, 100],
    ["borderWidth", 0, 4],
    ["highlight", 0, 100],
    ["shadow", 0, 100],
  ] as const) {
    const raw = g[key];
    if (raw === undefined) continue;
    const n = clampInt(raw, min, max);
    if (n !== null) out[key] = n;
  }
  if (typeof g.tint === "string" && HEX_RE.test(g.tint.trim())) out.tint = g.tint.trim();
  if (typeof g.gradient === "boolean") out.gradient = g.gradient;
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeMotionGroup(group: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!group || typeof group !== "object" || Array.isArray(group)) return out;
  const g = group as Record<string, unknown>;
  for (const [k, v] of Object.entries(g)) {
    if (!MOTION_FIELDS.has(k)) continue;
    if (k === "enabled" || k === "hoverEffects" || k === "scrollReveal" || k === "once" || k === "scrollProgress") {
      if (typeof v === "boolean") out[k] = v;
      continue;
    }
    if (k === "duration") {
      const n = clampInt(v, 150, 1200);
      if (n !== null) out[k] = n;
      continue;
    }
    if (k === "stagger") {
      const n = clampInt(v, 0, 240);
      if (n !== null) out[k] = n;
      continue;
    }
    if (k === "delay") {
      const n = clampInt(v, 0, 600);
      if (n !== null) out[k] = n;
      continue;
    }
    if (k === "intensity") {
      const n = clampInt(v, 0, 100);
      if (n !== null) out[k] = n;
      continue;
    }
    if (k === "preset") {
      if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 48);
      continue;
    }
    if (k === "easing" || k === "background" || k === "microInteractions") {
      if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 40);
      continue;
    }
  }
  return out;
}

/**
 * Normalize one patch object (flat OR nested) into the strict designPatch
 * shape. Unknown/invalid token keys are dropped, not guessed; if nothing
 * valid remains the patch becomes null (a deterministic tool without a patch
 * is then caught by validatePlan with a PRECISE "must carry a token patch"
 * diagnostic instead of an opaque schema failure).
 */
function sanitizePatch(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const coerced = coerceDesignPatch(raw) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof coerced.name === "string" && coerced.name.trim()) out.name = coerced.name.trim().slice(0, 80);
  if (typeof coerced.tagline === "string") out.tagline = coerced.tagline.slice(0, 160);
  const theme = sanitizePatchGroup(coerced.theme);
  if (Object.keys(theme).length > 0) out.theme = theme;
  const motion = sanitizeMotionGroup(coerced.motion);
  if (Object.keys(motion).length > 0) out.motion = motion;
  // Full-block engines (Vanta background, 3D scenes) pass through ONLY when
  // they parse against their own strict block schemas — an invalid block is
  // dropped (never guessed into a different engine), and null keeps the
  // documented "disable" semantics.
  const parseBlock = (value: unknown, schema: z.ZodType): unknown | undefined => {
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  };
  if ("backgroundEffects" in coerced) {
    const parsed = parseBlock(coerced.backgroundEffects, backgroundEffectsSchema);
    if (parsed !== undefined) out.backgroundEffects = parsed;
  }
  if ("scene3d" in coerced) {
    const parsed = parseBlock(coerced.scene3d, scene3dBlockSchema);
    if (parsed !== undefined) out.scene3d = parsed;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------- patch repair
// Deterministic tools MUST carry a patch. Models occasionally describe the
// tokens in the step's instruction/summary instead of writing the patch
// object (glassmorphism asks are the recurring case) — the validator then
// correctly rejects the step. When the step's OWN text names concrete,
// unambiguous tokens, rebuilding the patch deterministically is better than
// burning the one repair round (or failing the whole plan): only explicit
// token vocabulary and well-formed hex colors become patch keys — nothing is
// guessed, and the repaired step re-enters the SAME strict validator.

export interface PatchRepairReport {
  stepId: string;
  title: string;
  /** Top-level patch groups that were rebuilt (e.g. "theme", "motion"). */
  groups: string[];
}

function hexLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const HEX_GLOBAL_RE = /#[0-9a-fA-F]{3,8}\b/g;
/** Role keyword → theme color token, matched in the window BEFORE a hex. */
const COLOR_ROLE_RE: [RegExp, string][] = [
  [/\b(background|backdrop|page bg|bg)\b/i, "background"],
  [/\b(foreground|body text|text colou?r|heading colou?r)\b/i, "foreground"],
  [/\baccent(?!\s*(2|two|secondary))/i, "accent"],
  [/\b(accent\s*(2|two)|secondary accent)\b/i, "accent2"],
  [/\b(surface|card)\b/i, "surface"],
  [/\bborder\b/i, "border"],
  [/\bmuted\b/i, "muted"],
  [/\bfocus\b/i, "focus"],
];

function enumNear(lower: string, tokenRe: RegExp, words: Record<string, string>): string | null {
  const m = tokenRe.exec(lower);
  if (!m) return null;
  const window = lower.slice(Math.max(0, m.index - 24), m.index + m[0].length + 40);
  for (const [word, value] of Object.entries(words)) {
    if (window.includes(word)) return value;
  }
  return null;
}

/**
 * Derive a conservative token patch from free text (a step's instruction /
 * title / summary plus the user's request). ONLY explicit, unambiguous
 * vocabulary becomes tokens: hex colors with a color-role keyword nearby,
 * named glass presets, explicit token names with a valid enum word, numeric
 * glass/motion values. Ambiguous or unknown vocabulary is ignored — the
 * strict validator, not this helper, remains the authority.
 */
export function deriveTokensFromText(text: string, toolId = "theme.tokens"): Record<string, unknown> {
  const lower = text.toLowerCase();
  const theme: Record<string, unknown> = {};
  const motion: Record<string, unknown> = {};

  // ---- glassmorphism ----
  const glassOff = /\b(no|without|remove|disable|turn off|switch off)\b[^.]{0,24}\b(glass|glassmorphism|frosted)\b/.test(lower);
  const glassOn = /\b(glass|glassmorphism|frosted)\b/.test(lower);
  if (glassOff) {
    theme.glass = { enabled: false };
  } else if (glassOn) {
    const glass: Record<string, unknown> = { enabled: true };
    for (const preset of ["smoked", "crystal", "aurora", "soft", "dark", "frosted"]) {
      if (new RegExp(`\\b${preset}\\b`).test(lower)) {
        glass.preset = preset;
        break;
      }
    }
    const blurM = /\bblur\b[^.\d]{0,16}(\d{1,2})(?!\d)|(\d{1,2})\s*px\s*\bblur\b/.exec(lower);
    const blur = blurM ? clampInt(blurM[1] ?? blurM[2], 0, 40) : null;
    if (blur !== null) glass.blur = blur;
    if (!glass.preset) {
      // No preset named: pick the neutral preset for the palette the text
      // implies — dark glass on a dark background, frosted otherwise.
      const bgHex = COLOR_ROLE_RE.length > 0 ? hexForRole(lower, "background") : null;
      glass.preset = bgHex && hexLuminance(bgHex) < 0.4 ? "dark" : "frosted";
    }
    theme.glass = glass;
  }

  // ---- hex colors → role tokens ----
  // Each hex is judged by the text between ITSELF and the PREVIOUS hex — a
  // role keyword must never reach back across another color ("background
  // #0b0b0d, champagne accent #d4b46a" assigns each hex to its own role).
  const hexes = [...text.matchAll(HEX_GLOBAL_RE)];
  const assigned = new Set<string>();
  for (let i = 0; i < hexes.length; i += 1) {
    const m = hexes[i]!;
    const segStart = i === 0 ? 0 : (hexes[i - 1]!.index ?? 0) + hexes[i - 1]![0].length;
    const segment = lower.slice(segStart, m.index ?? 0);
    for (const [re, token] of COLOR_ROLE_RE) {
      if (assigned.has(token)) continue;
      if (re.test(segment)) {
        // "accent 2" / "secondary accent" must win over the bare accent rule
        if (token === "accent" && /\b(accent\s*(2|two)|secondary accent)\b/.test(segment)) continue;
        theme[token] = m[0].toLowerCase();
        assigned.add(token);
        break;
      }
    }
  }
  if (hexes.length === 1 && assigned.size === 0) {
    // A single color with no role keyword: the accent is the conventional ask.
    theme.accent = hexes[0]![0].toLowerCase();
  }
  if (/\bgradient\b/.test(lower) && hexes.length >= 2) {
    const angleM = /(\d{1,3})\s*(?:deg|degrees)/.exec(lower);
    const fromIdx = hexes.findIndex((h) => /\bfrom\b/.test(lower.slice(Math.max(0, (h.index ?? 0) - 20), h.index ?? 0)));
    const toIdx = hexes.findIndex((h) => /\bto\b/.test(lower.slice(Math.max(0, (h.index ?? 0) - 20), h.index ?? 0)));
    if (angleM && fromIdx !== -1 && toIdx !== -1) {
      const angle = clampInt(angleM[1], 0, 360);
      if (angle !== null) theme.gradient = { from: hexes[fromIdx]![0].toLowerCase(), to: hexes[toIdx]![0].toLowerCase(), angle };
    }
  }

  // ---- surface opacity (a real theme token) ----
  const soM = /\bsurface\s*opacity\b\D{0,12}(\d{1,3})(?!\d)|(\d{1,3})\s*%\s*surface\s*opacity\b/.exec(lower);
  const surfaceOpacity = soM ? clampInt(soM[1] ?? soM[2], 20, 100) : null;
  if (surfaceOpacity !== null) theme.surfaceOpacity = surfaceOpacity;

  // ---- explicit enum tokens ----
  const radius = enumNear(lower, /\b(radius|corner)\b/, { sharp: "none", square: "none", rounded: "md", round: "md", soft: "md", pill: "full", full: "full" });
  if (radius) theme.radius = radius;
  const density = enumNear(lower, /\bdensity\b/, { compact: "compact", regular: "regular", relaxed: "relaxed" });
  if (density) theme.density = density;
  const typeScale = enumNear(lower, /\btype\s?scale\b/, { intimate: "intimate", balanced: "balanced", grand: "grand" });
  if (typeScale) theme.typeScale = typeScale;
  const lineHeight = enumNear(lower, /\bline\s?height\b/, { tight: "tight", normal: "normal", relaxed: "relaxed" });
  if (lineHeight) theme.lineHeight = lineHeight;
  const letterSpacing = enumNear(lower, /\bletter\s?spacing\b|\btracking\b/, { tight: "tight", normal: "normal", wide: "wide" });
  if (letterSpacing) theme.letterSpacing = letterSpacing;
  const headingWeight = enumNear(lower, /\b(heading[^.]{0,16}weight|font weight|headings?)\b/, { light: "light", semibold: "semibold", bold: "bold" });
  if (headingWeight) theme.headingWeight = headingWeight;
  const contentWidth = enumNear(lower, /\b(content|container)\s?width\b/, { narrow: "narrow", regular: "regular", wide: "wide" });
  if (contentWidth) theme.contentWidth = contentWidth;
  const buttonStyle = enumNear(lower, /\bbuttons?\b/, { sharp: "sharp", outline: "outline", pill: "pill", rounded: "rounded" });
  if (buttonStyle) theme.buttonStyle = buttonStyle;
  const navLayout = enumNear(lower, /\b(nav\s?layout|navigation layout|masthead)\b/, { inline: "inline", stacked: "stacked", centered: "centered" });
  if (navLayout) theme.navLayout = navLayout;
  const headingAlign = enumNear(lower, /\b(heading[^.]{0,12}align|align headings?)\b/, { left: "left", center: "center" });
  if (headingAlign) theme.headingAlign = headingAlign;
  const pageTransition = enumNear(lower, /\bpage transitions?\b/, { none: "none", fade: "fade", slide: "slide", rise: "rise", zoom: "zoom" });
  if (pageTransition) theme.pageTransition = pageTransition;
  const divider = enumNear(lower, /\bdividers?\b/, { none: "none", line: "line", accent: "accent" });
  if (divider) theme.divider = divider;
  const ratioM = /\b(image|aspect)\s?ratio\b[^.]{0,16}\b(4\s?\/\s?3|3\s?\/\s?2|1\s?\/\s?1|16\s?\/\s?9)\b/.exec(lower);
  if (ratioM) theme.imageRatio = ratioM[2].replace(/\s+/g, "");
  const colM = /\b(one|two|three|1|2|3)[\s-]?column/.exec(lower);
  if (colM) {
    const n = { one: 0, "1": 0, two: 2, "2": 2, three: 3, "3": 3 }[colM[1]!];
    if (n === 0 || n === 2 || n === 3) theme.columns = n;
  }

  // ---- motion values (any deterministic step may carry motion tokens) ----
  const durM = /\bduration\b\D{0,10}(\d{2,4})(?!\d)|(\d{2,4})\s*ms\b/.exec(lower);
  const duration = durM ? clampInt(durM[1] ?? durM[2], 150, 1200) : null;
  if (duration !== null && /\bmotion|animat|reveal|transition/.test(lower)) motion.duration = duration;
  const stagM = /\bstagger\b\D{0,10}(\d{1,3})(?!\d)/.exec(lower);
  const stagger = stagM ? clampInt(stagM[1], 0, 240) : null;
  if (stagger !== null) motion.stagger = stagger;
  const intM = /\bintensity\b\D{0,10}(\d{1,3})(?!\d)/.exec(lower);
  const intensity = intM ? clampInt(intM[1], 0, 100) : null;
  if (intensity !== null) motion.intensity = intensity;
  if (toolId === "motion.configure") {
    // A preset id is only honored when the text PRESENTS it as the preset —
    // near the words preset/reveal/animation/transition — never because the
    // user's style vocabulary happens to contain a preset id ("cinematic
    // portfolio" must not silently become preset "cinematic").
    const ids = motionPresetsByScope("reveal").map((p) => p.id);
    const named = ids.find((id) => {
      const idRe = new RegExp(`\\b${id.replace(/[-]/g, "[- ]?")}\\b`);
      const m = idRe.exec(lower);
      if (!m) return false;
      const window = `${lower.slice(Math.max(0, m.index - 30), m.index)} ${lower.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 30)}`;
      return /\bpreset\b|\breveal\b|\breveals\b|\banimat|\btransition/.test(window);
    });
    if (named) motion.preset = named;
  }

  // ---- site name / tagline (quoted strings, explicit intent only) ----
  // "Update site name and tagline to 'Atelier North' / 'Design with heart.'"
  // — a model-planned rename step that carried its VALUES in the instruction
  // but forgot the patch. Only QUOTED strings next to explicit rename intent
  // become patch values — a quoted phrase elsewhere in the text is never a
  // rename. Bounded by the schema (name ≤ 80, tagline ≤ 160).
  let nameValue: string | null = null;
  let taglineValue: string | null = null;
  const QUOTE_RE = /[“"“”«»]([^“"“”«»]{1,80})[”"“”«»]/g;
  const quoted = [...text.matchAll(QUOTE_RE)].map((m) => m[1]!.trim()).filter((s) => s.length >= 1);
  if (quoted.length > 0) {
    const nameIntent = /\b(site|website)\s+name\b|\brename\b|\bname\s+(the|this)\s+(site|website)\b|\btitled?\b/.test(lower);
    const taglineIntent = /\btagline\b|\bsubtitle\b|\bslogan\b/.test(lower);
    if (nameIntent) {
      // The FIRST quote near the name intent wins (a tagline intent carries
      // its own quote after it when both are present).
      const nameQuote = quoted[0]!;
      if (nameQuote.length <= 80) nameValue = nameQuote;
    }
    if (taglineIntent && quoted.length > (nameIntent ? 1 : 0)) {
      const tagQuote = quoted[nameIntent ? 1 : 0]!;
      if (tagQuote.length <= 160) taglineValue = tagQuote;
    }
  }

  const out: Record<string, unknown> = {};
  if (nameValue !== null) out.name = nameValue;
  if (taglineValue !== null) out.tagline = taglineValue;
  if (Object.keys(theme).length > 0) out.theme = theme;
  if (Object.keys(motion).length > 0) out.motion = motion;
  return out;
}

/** The background-role hex from the text, if any (used for the glass preset pick). */
function hexForRole(lower: string, role: string): string | null {
  const roleRe = COLOR_ROLE_RE.find(([, token]) => token === role)?.[0];
  if (!roleRe) return null;
  for (const m of lower.matchAll(HEX_GLOBAL_RE)) {
    const before = lower.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0);
    if (roleRe.test(before)) return m[0];
  }
  return null;
}

/**
 * Rebuild missing patches for deterministic steps from their OWN text + the
 * user's request. Pure: returns a new plan; repaired steps carry a sanitized
 * patch that re-enters the SAME validation (nothing is bypassed). When no
 * tokens can be derived the step is left untouched for the validator's
 * precise diagnostic.
 */
export function repairMissingTokenPatches(
  plan: DesignPlan,
  request: string
): { plan: DesignPlan; repaired: PatchRepairReport[] } {
  const repaired: PatchRepairReport[] = [];
  const steps = plan.steps.map((step) => {
    const tool = getTool(step.tool);
    if (!tool || tool.family !== "deterministic") return step;
    if (tool.id === "palette.apply" || tool.id === "preset.apply" || tool.id === "template.apply") return step;
    if (step.patch && Object.keys(step.patch).length > 0) return step;
    const source = [step.instruction, step.summary, step.title, request].filter((s) => s && s.trim()).join(". ");
    const derived = sanitizePatch(deriveTokensFromText(source, tool.id)) as DesignPatch | null;
    if (!derived) return step;
    repaired.push({ stepId: step.id, title: step.title, groups: Object.keys(derived) });
    return { ...step, patch: derived };
  });
  if (repaired.length === 0) return { plan, repaired };
  const note = `Rebuilt the missing token patch${repaired.length === 1 ? "" : "es"} of ${repaired
    .map((r) => `“${r.title}”`)
    .join(", ")} from the step's own instructions (${repaired.flatMap((r) => r.groups).join(", ")}).`
  return { plan: { ...plan, steps, notes: [plan.notes, note].filter(Boolean).join(" ") }, repaired };
}

function normalizeEnum<T extends readonly string[]>(v: unknown, allowed: T): T[number] | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return (allowed as readonly string[]).includes(t) ? (t as T[number]) : null;
}

const MODEL_TOOLS = new Set(["section.add", "section.update", "section.reorder", "section.remove", "page.add", "page.update", "page.remove", "content.write", "site.compose"]);

/**
 * Remap MODEL steps that carry a token patch onto the deterministic tool the
 * patch actually implements. Pure — the remapped plan re-enters the SAME
 * validator.
 */
function remapModelStepsWithPatches(plan: DesignPlan): { plan: DesignPlan; changed: boolean } {
  let changed = false;
  const steps = plan.steps.map((step) => {
    if (!MODEL_TOOLS.has(step.tool) || !step.patch || Object.keys(step.patch).length === 0) return step;
    const patch = step.patch as Record<string, unknown>;
    const hasTheme = patch.theme !== undefined || Object.keys(patch).some((k) => !MODEL_TOOLS.has(k) && k !== "motion");
    const hasMotion = patch.motion !== undefined;
    if (!hasTheme && !hasMotion) return step;
    changed = true;
    return {
      ...step,
      tool: hasTheme ? "theme.tokens" : "motion.configure",
      kind: "design" as const,
      instruction: "",
    };
  });
  return changed ? { plan: { ...plan, steps }, changed } : { plan, changed };
}

/**
 * Singular/loose constraint-target forms → canonical token groups (mirror of
 * the resolver in lib/ai-design/constraints.ts, digest-independent subset).
 */
const CONSTRAINT_GROUP_ALIASES: Record<string, string> = {
  color: "colors",
  colors: "colors",
  theme: "theme",
  font: "fonts",
  fonts: "fonts",
  typography: "typography",
  motion: "motion",
  content: "content",
  section: "sections",
  sections: "sections",
  page: "pages",
  pages: "pages",
  name: "name",
  tagline: "tagline",
};

/** Tools whose steps MUTATE a token group — the self-contradiction drop
 * consults this (the site.compose tool replaces the whole draft, so it
 * contradicts every structural/design group). */
const CONSTRAINT_GROUP_MUTATORS: Record<string, readonly string[]> = {
  theme: ["theme.tokens", "palette.apply", "preset.apply", "template.apply", "site.compose"],
  colors: ["theme.tokens", "palette.apply", "preset.apply", "template.apply", "site.compose"],
  typography: ["typography.fonts", "preset.apply", "template.apply", "site.compose"],
  fonts: ["typography.fonts", "preset.apply", "template.apply", "site.compose"],
  motion: ["motion.configure", "preset.apply", "template.apply", "site.compose"],
  content: ["section.add", "section.update", "section.remove", "section.reorder", "content.write", "page.add", "page.update", "page.remove", "site.compose"],
  pages: ["section.add", "section.update", "section.remove", "section.reorder", "content.write", "page.add", "page.update", "page.remove", "site.compose"],
  sections: ["section.add", "section.update", "section.remove", "section.reorder", "content.write", "page.add", "page.update", "page.remove", "site.compose"],
};

/**
 * Tool-name aliases — models invent plausible tool names (observed live:
 * "section.configure", "add_section"). Only UNAMBIGUOUS synonyms fold onto
 * the real registry ids; anything else is left untouched and fails
 * validation honestly (the strict registry is never bypassed — canonical
 * ids still pass through getTool exactly as before).
 */
const TOOL_SYNONYMS: Record<string, string> = {
  add_section: "section.add", section_create: "section.add", section_new: "section.add", new_section: "section.add", create_section: "section.add",
  section_configure: "section.update", section_edit: "section.update", section_modify: "section.update", section_style: "section.update", section_restyle: "section.update", update_section: "section.update", edit_section: "section.update", modify_section: "section.update", configure_section: "section.update",
  section_delete: "section.remove", remove_section: "section.remove", delete_section: "section.remove",
  reorder_section: "section.reorder", reorder_sections: "section.reorder",
  add_page: "page.add", page_create: "page.add", create_page: "page.add", new_page: "page.add",
  update_page: "page.update", page_edit: "page.update", edit_page: "page.update",
  page_delete: "page.remove", remove_page: "page.remove", delete_page: "page.remove",
  theme_tokens: "theme.tokens", theme_patch: "theme.tokens", design_tokens: "theme.tokens", tokens: "theme.tokens",
  typography: "typography.fonts", typography_fonts: "typography.fonts", fonts: "typography.fonts", font: "typography.fonts",
  motion: "motion.configure", motion_configure: "motion.configure", motion_preset: "motion.configure", animation: "motion.configure", animations: "motion.configure",
  palette: "palette.apply", palette_apply: "palette.apply", apply_palette: "palette.apply", color: "palette.apply", colors: "palette.apply",
  preset: "preset.apply", preset_apply: "preset.apply", apply_preset: "preset.apply", design_preset: "preset.apply",
  template: "template.apply", template_apply: "template.apply", apply_template: "template.apply",
  content_write: "content.write", write_content: "content.write", content: "content.write", copy_write: "content.write",
  compose: "site.compose", compose_site: "site.compose", site_compose: "site.compose", compose_website: "site.compose",
};

function canonicalizeToolName(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (!t) return t;
  const key = t.replace(/[^a-z0-9.]+/g, "_").replace(/^_+|_+$/g, "");
  return TOOL_SYNONYMS[key] ?? t;
}

function capped(v: unknown, max: number): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}

/**
 * Coerce a raw model JSON object into a shape the strict designPlanSchema can
 * judge on REPRESENTATION alone. Pure: returns a new object, never mutates.
 */
export function normalizePlanJson(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const reply = capped(src.reply, 800);
  if (reply !== null) out.reply = reply;
  const notes = capped(src.notes, 800);
  if (notes !== null) out.notes = notes;
  const clarifying = capped(src.clarifyingQuestion, 400);
  if (clarifying !== null) out.clarifyingQuestion = clarifying;

  // constraints: null / non-array → []; entries keep only { text, targets }.
  const constraintsRaw = Array.isArray(src.constraints) ? src.constraints : [];
  const constraints: unknown[] = [];
  for (const c of constraintsRaw.slice(0, 6)) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const cc = c as Record<string, unknown>;
    const text = capped(cc.text, 200);
    if (text === null) continue;
    const targets = asStringArray(cc.targets, 16) ?? [];
    constraints.push({ text, targets });
  }
  out.constraints = constraints;

  // steps: null → []; a SINGLE step object → [step]; keep object entries only.
  let stepsRaw: unknown[];
  if (Array.isArray(src.steps)) {
    stepsRaw = src.steps;
  } else if (src.steps && typeof src.steps === "object") {
    const s = src.steps as Record<string, unknown>;
    stepsRaw = typeof s.tool === "string" || typeof s.id === "string" || typeof s.title === "string" ? [s] : [];
  } else {
    stepsRaw = [];
  }

  const steps: unknown[] = [];
  let fallbackIndex = 0;
  for (const s of stepsRaw.slice(0, 8)) {
    if (!s || typeof s !== "object" || Array.isArray(s)) continue;
    fallbackIndex += 1;
    const st = s as Record<string, unknown>;
    const step: Record<string, unknown> = {};

    const id = capped(st.id, 40)?.trim();
    step.id = id && id.length > 0 ? id : `s${fallbackIndex}`;

    const title = capped(st.title, 120)?.trim() ?? "";
    const summaryRaw = capped(st.summary, 500)?.trim() ?? "";
    // A create-mode site.compose instruction carries the user's COMPLETE
    // vision — bounded only by the composer limit (50,000), never truncated
    // into silence.
    const instructionRaw = capped(st.instruction, 50_000)?.trim() ?? "";
    // title/summary have min(3): fall back through sibling fields so a plan
    // is not lost over an empty label. Everything still passes the schema.
    const fallbackLabel = (summaryRaw || instructionRaw || title || "Website change").slice(0, 120) || "Website change";
    step.title = title.length >= 3 ? title : fallbackLabel;
    step.summary = summaryRaw.length >= 3 ? summaryRaw : (instructionRaw || title || fallbackLabel).slice(0, 500);
    step.instruction = instructionRaw;

    const toolRaw = capped(st.tool, 40)?.trim() ?? "";
    step.tool = canonicalizeToolName(toolRaw);

    const kind = normalizeEnum(st.kind, PLAN_KINDS);
    if (kind) step.kind = kind;
    const risk = normalizeEnum(st.risk, PLAN_RISKS);
    if (risk) step.risk = risk;

    const targets = asStringArray(st.targets, 16);
    step.targets = targets ?? [];
    const dependsOn = asStringArray(st.dependsOn, 8);
    step.dependsOn = dependsOn ?? [];

    const patch = sanitizePatch(st.patch);
    if (patch) step.patch = patch;

    steps.push(step);
  }
  out.steps = steps;

  // Self-contradiction drop (GZ-1): a model-invented preservation constraint
  // whose target the plan's OWN steps mutate is noise the model added against
  // its own request (observed live 2026-11-21: "Create a multi-page website"
  // produced a "pages untouched" constraint, then page.add steps — the whole
  // expensive plan died on validator conflicts). Contradicted targets are
  // removed per-constraint (partial constraints stay as strong as they can
  // honestly be) and a constraint left with zero targets is dropped entirely;
  // genuinely user-stated constraints that the plan HONORS keep their full
  // enforcement (validator conflicts, executor byte-identical restore,
  // verifier). Constraints with NO targets at all are untouched (their shape
  // remains the strict schema's business), and section-id/page targets are
  // resolved against the digest later on the strict validator path.
  const targetContradicted = (target: unknown): boolean => {
    const group = String(target).trim().toLowerCase();
    const canonical = CONSTRAINT_GROUP_ALIASES[group] ?? group;
    // name/tagline are patched only via theme.tokens' top-level name/tagline
    // patch keys — checked directly (they have no tool-mapping group).
    if (canonical === "name" || canonical === "tagline") {
      return steps.some((s) => {
        const st = s as { tool?: unknown; patch?: Record<string, unknown> | null };
        return typeof st.tool === "string" && canonicalizeToolName(st.tool) === "theme.tokens" && typeof st.patch?.[canonical] === "string";
      });
    }
    const tools = CONSTRAINT_GROUP_MUTATORS[canonical];
    if (!tools) return false;
    return steps.some((s) => {
      const st = s as { tool?: unknown };
      return typeof st.tool === "string" && tools.includes(canonicalizeToolName(st.tool));
    });
  };
  out.constraints = constraints.flatMap((c) => {
    const cc = c as { text?: unknown; targets?: unknown[] };
    if (!Array.isArray(cc.targets) || cc.targets.length === 0) return [cc];
    const keptTargets = cc.targets.filter((t) => !targetContradicted(t));
    if (keptTargets.length === 0) return []; // fully self-contradicted → dropped
    return [{ text: cc.text, targets: keptTargets }];
  });

  return out;
}

// ---------------------------------------------------------------- plan schema

/**
 * A string field that TRUNCATES to `max` instead of failing the whole plan.
 * Over-long free-text fields (a compose instruction, a verbose reply) are a
 * model excess, not a security boundary — the expensive plan should survive
 * with the field shortened. Structural limits (step count, targets, patch
 * shape) stay strict.
 */
function cappedString(max: number) {
  return z.preprocess((v) => (typeof v === "string" ? v.slice(0, max) : v), z.string());
}

export const planStepSchema = z.object({
  id: z.string().min(1).max(40),
  title: cappedString(120).pipe(z.string().min(3)),
  tool: z.string().max(40),
  kind: z.enum(PLAN_STEP_KINDS).default("design"),
  /** Section ids / page ids / library ids the step operates on. */
  targets: z.array(z.string().max(80)).max(16).default([]),
  /** What the step will do, in one or two sentences (shown to the user). */
  summary: cappedString(500).pipe(z.string().min(3)),
  /** Detailed execution instruction for model tools (or empty for deterministic). */
  instruction: cappedString(50_000).default(""),
  /** Exact token patch for deterministic tools — flat or nested, coerced on parse. */
  patch: z.preprocess(coerceDesignPatch, designPatchSchema.nullish()),
  /** Must reference EARLIER steps only — plans are ordered DAGs by construction. */
  dependsOn: z.array(z.string().max(40)).max(8).default([]),
  risk: z.enum(["low", "medium", "high"]).default("low"),
});
export type PlanStep = z.infer<typeof planStepSchema>;

export const designPlanSchema = z.object({
  reply: cappedString(800).default(""),
  /** Overall approach notes shown under the plan. */
  notes: cappedString(800).optional(),
  /** Explicit preservation constraints extracted from the user's request. */
  constraints: z
    .array(
      z.object({
        text: cappedString(200).pipe(z.string().min(3)),
        /** Section ids / types / page ids / token groups to keep byte-identical. */
        targets: z.array(z.string().max(80)).max(16).default([]),
      })
    )
    .max(6)
    .default([]),
  /** Present ONLY when a missing decision blocks safe execution. */
  clarifyingQuestion: z.string().max(400).nullish(),
  steps: z.array(planStepSchema).max(8),
});
export type DesignPlan = z.infer<typeof designPlanSchema>;

// ---------------------------------------------------------------- self-repair

/**
 * Drop plan constraints that are NOT grounded in the user's request.
 *
 * Models occasionally add plausible-sounding preservation constraints the
 * user never stated ("keep all sections untouched") and then plan steps that
 * violate them — the validator correctly rejects the plan, but rejecting a
 * whole plan over a constraint the user never asked for is worse than
 * dropping that constraint.
 */
/**
 * Preservation-context test — a constraint is only GROUNDED in the request
 * when a constraint word appears in a sentence that actually expresses
 * PRESERVATION. Models hallucinate plausible constraints whose words appear
 * in the request in a completely different role ("Configure cinematic motion"
 * in the request grounded an invented "keep the motion untouched" constraint
 * that then contradicted the plan's own steps — observed live). A word must
 * share a sentence with a preservation verb to protect anything. Pure —
 * testable.
 */

const PRESERVATION_CONTEXT_RE =
  /\b(keep|keeps|keeping|leave|leaves|leaving|preserve|preserves|preserving|retain|retains|maintain|maintains|maintaining|untouched|unchanged|unchanging|except|aside|apart|intact|asis|stay|stays|staying|remain|remains|remaining|as\s+is|don't|dont|do\s*not|hands\s*off|freeze|no\s*changes?\s+to)\b/i;

function isConstraintGroundedInRequest(constraintText: string, targets: string[], request: string): boolean {
  const req = request.toLowerCase();
  const words = [
    ...constraintText.toLowerCase().split(/[^a-z]+/),
    ...targets.flatMap((t) => t.toLowerCase().split(/[^a-z]+/)),
  ].filter((w) => w.length >= 4);
  if (words.length === 0) return false;
  // Sentence split on the request's own punctuation; a word grounds the
  // constraint only when its sentence carries a preservation verb.
  const sentences = request.split(/[.!?\n;]+/).map((s) => s.toLowerCase()).filter((s) => s.trim().length > 0);
  for (const w of words) {
    for (const sentence of sentences) {
      if (sentence.includes(w) && PRESERVATION_CONTEXT_RE.test(sentence)) return true;
    }
    // A bare target that IS a preservation phrase (e.g. a constraint target
    // list containing "colors" inside "keep my colors") also grounds when the
    // request as a whole contains a preservation verb AND the word.
    if (req.includes(w) && PRESERVATION_CONTEXT_RE.test(req)) return true;
  }
  return false;
}

export function dropUngroundedConstraints(
  plan: DesignPlan,
  request: string
): { plan: DesignPlan; dropped: string[] } {
  const dropped: string[] = [];
  const kept = plan.constraints.filter((c) => {
    const grounded = isConstraintGroundedInRequest(c.text, c.targets, request);
    if (!grounded) dropped.push(c.text);
    return grounded;
  });
  if (dropped.length === 0) return { plan, dropped };
  return { plan: { ...plan, constraints: kept }, dropped };
}

/**
 * Drop constraints whose targets do not EXIST on the website ("keep the
 * current template" — "template" is not a resolvable target kind).
 *
 * A constraint that names nothing real protects nothing real: the validator
 * would otherwise reject the WHOLE plan over a target no step could ever
 * honor. Resolvable constraints (section ids/types, page ids, token groups)
 * are never touched, so user-stated protections against real regions always
 * survive. A constraint with SOME resolvable targets is narrowed to them —
 * its real protection is kept, only the imaginary target goes. Pure —
 * testable.
 */
export function dropUnresolvableConstraints(
  plan: DesignPlan,
  digest: SiteDigest
): { plan: DesignPlan; dropped: string[]; narrowed: string[] } {
  const dropped: string[] = [];
  const narrowed: string[] = [];
  const kept = plan.constraints.flatMap((c) => {
    const good = c.targets.filter((t) => resolveConstraintTarget(t, digest) !== null || pageTargetMatches(t, digest));
    if (good.length === c.targets.length) return [c];
    if (good.length === 0) {
      dropped.push(c.text);
      return [];
    }
    narrowed.push(c.text);
    return [{ text: c.text, targets: good }];
  });
  if (dropped.length === 0 && narrowed.length === 0) return { plan, dropped, narrowed };
  return { plan: { ...plan, constraints: kept }, dropped, narrowed };
}

// ---------------------------------------------------------------- validation

export interface PlanIssue {
  code:
    | "unknown-tool"
    | "missing-instruction"
    | "unknown-section-target"
    | "unknown-page-target"
    | "unknown-library-target"
    | "forward-dependency"
    | "duplicate-step"
    | "constraint-conflict"
    | "invalid-patch"
    | "page-remove-last"
    | "unreachable-target";
  message: string;
  stepId?: string;
}

function sectionTargetMatches(target: string, digest: SiteDigest): boolean {
  const t = target.trim().toLowerCase();
  for (const page of digest.pages) {
    for (const s of page.sections) {
      if (s.id.toLowerCase() === t) return true;
      if (s.type.toLowerCase() === t) return true;
    }
  }
  return false;
}

function pageTargetMatches(target: string, digest: SiteDigest): boolean {
  const t = target.trim().toLowerCase();
  return digest.pages.some((p) => p.id.toLowerCase() === t || p.name.toLowerCase() === t);
}

/**
 * Per-tool patch requirements, quoted verbatim in the validator's diagnostic
 * so a rejected step explains EXACTLY what its patch must carry (and the
 * repair prompt can quote it back).
 */
const PATCH_HINTS: Record<string, string> = {
  "theme.tokens":
    'a token patch — e.g. { "theme": { "accent": "#d4b46a" } }; for glassmorphism: { "theme": { "glass": { "enabled": true, "preset": "frosted" } } }',
  "typography.fonts":
    'a font patch — e.g. { "theme": { "headingFont": "fraunces", "bodyFont": "inter" } }',
  "motion.configure":
    'a motion patch — e.g. { "motion": { "preset": "fadeUp", "duration": 500, "intensity": 60 } }',
};

/**
 * Validate a model-proposed plan against the REAL digest. Deterministic and
 * strict: a plan with any issue is never shown to the user or executed.
 */
export function validatePlan(plan: DesignPlan, digest: SiteDigest): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const seenIds = new Set<string>();

  plan.steps.forEach((step, index) => {
    const tool = getTool(step.tool);
    if (!tool) {
      issues.push({ code: "unknown-tool", message: `Step ${index + 1} uses unknown tool “${step.tool}”.`, stepId: step.id });
      return;
    }
    if (step.id.toLowerCase() !== step.id || step.id.includes(" ")) {
      // cosmetic; ids are opaque — accept anything but track duplicates
    }
    if (seenIds.has(step.id)) {
      issues.push({ code: "duplicate-step", message: `Duplicate step id “${step.id}”.`, stepId: step.id });
    }
    seenIds.add(step.id);

    // instructions / patches per family (an EMPTY patch object counts as none —
    // models often attach "patch": {} to model tools)
    const hasPatch = Boolean(step.patch && Object.keys(step.patch).length > 0);
    if (tool.family === "model" && tool.needsInstruction && step.instruction.trim().length < 3) {
      issues.push({ code: "missing-instruction", message: `Step “${step.title}” (${tool.id}) needs an execution instruction.`, stepId: step.id });
    }
    if (tool.family === "deterministic" && tool.id !== "palette.apply" && tool.id !== "preset.apply" && tool.id !== "template.apply") {
      if (!hasPatch) {
        issues.push({ code: "invalid-patch", message: `Step “${step.title}” (${tool.id}) must carry ${PATCH_HINTS[tool.id] ?? "a token patch"}.`, stepId: step.id });
      }
    }
    if (tool.family === "model" && hasPatch) {
      issues.push({ code: "invalid-patch", message: `Model tool “${tool.id}” cannot carry a deterministic patch.`, stepId: step.id });
    }

    // library targets resolve against the REAL curated libraries
    if (tool.targetKind === "library-id") {
      if (step.targets.length !== 1) {
        issues.push({ code: "unknown-library-target", message: `Step “${step.title}” must target exactly one library id.`, stepId: step.id });
      } else {
        const id = step.targets[0];
        const exists =
          (tool.id === "palette.apply" && PALETTES.some((p) => p.id === id)) ||
          (tool.id === "preset.apply" && designPresets().some((p) => p.id === id)) ||
          (tool.id === "template.apply" && templatePresets().some((t) => t.id === id));
        if (!exists) {
          issues.push({ code: "unknown-library-target", message: `Step “${step.title}” targets “${id}” which is not in the ${tool.label} library.`, stepId: step.id });
        }
      }
    }

    // section/page targets exist in the digest
    if (tool.targetKind === "section") {
      if (step.targets.length === 0) {
        issues.push({ code: "unreachable-target", message: `Step “${step.title}” must name the sections it edits.`, stepId: step.id });
      }
      for (const t of step.targets) {
        if (!sectionTargetMatches(t, digest)) {
          issues.push({ code: "unknown-section-target", message: `Step “${step.title}” targets “${t}” which is not a section on this website.`, stepId: step.id });
        }
      }
    }
    if (tool.targetKind === "page") {
      if (step.targets.length === 0 && tool.id !== "section.add" && tool.id !== "page.add") {
        issues.push({ code: "unreachable-target", message: `Step “${step.title}” must name the page it works on.`, stepId: step.id });
      }
      for (const t of step.targets) {
        if (!pageTargetMatches(t, digest) && !sectionTargetMatches(t, digest)) {
          issues.push({ code: "unknown-page-target", message: `Step “${step.title}” targets “${t}” which is not a page on this website.`, stepId: step.id });
        }
      }
    }

    // removing the only page is never valid
    if (tool.id === "page.remove" && digest.pageCount <= 1) {
      issues.push({ code: "page-remove-last", message: "The website needs at least one page — it cannot be removed.", stepId: step.id });
    }

    // dependencies reference earlier steps only → cycles are impossible
    for (const dep of step.dependsOn) {
      if (!plan.steps.slice(0, index).some((s) => s.id === dep)) {
        issues.push({ code: "forward-dependency", message: `Step “${step.title}” depends on “${dep}” which is not a previous step.`, stepId: step.id });
      }
    }
  });

  // constraint targets must resolve; steps must not touch constrained targets.
  // Detection is CANONICAL: a constraint on the "projects" type must catch a
  // step targeting the concrete section id, and vice versa; token-group
  // constraints catch the deterministic tools that mutate those groups.
  const TOKEN_GROUP_TOOLS: Record<string, readonly string[]> = {
    theme: ["theme.tokens", "palette.apply", "preset.apply", "template.apply"],
    colors: ["theme.tokens", "palette.apply", "preset.apply", "template.apply"],
    typography: ["typography.fonts", "preset.apply", "template.apply"],
    fonts: ["typography.fonts", "preset.apply", "template.apply"],
    motion: ["motion.configure", "preset.apply", "template.apply"],
    navlayout: ["theme.tokens"],
    content: ["section.add", "section.update", "section.remove", "section.reorder", "content.write", "page.add", "page.update", "page.remove"],
    pages: ["section.add", "section.update", "section.remove", "section.reorder", "content.write", "page.add", "page.update", "page.remove"],
    sections: ["section.add", "section.update", "section.remove", "section.reorder", "content.write", "page.add", "page.update", "page.remove"],
    name: [],
    tagline: [],
  };

  const resolvedConstraints: { kind: string; value: string; raw: string }[] = [];
  for (const c of plan.constraints) {
    for (const t of c.targets) {
      const r = resolveConstraintTarget(t, digest);
      if (r) {
        resolvedConstraints.push({ kind: r.kind, value: r.value, raw: t });
        continue;
      }
      const raw = t.trim().toLowerCase();
      const isPage = pageTargetMatches(t, digest);
      if (!isPage) {
        issues.push({ code: "unknown-section-target", message: `The constraint “${c.text}” targets “${t}” which does not exist on this website.` });
      } else {
        resolvedConstraints.push({ kind: "page", value: raw, raw: t });
      }
    }
  }

  const sectionIdType = (id: string): string | null => {
    const t = id.trim().toLowerCase();
    for (const page of digest.pages) for (const s of page.sections) if (s.id.toLowerCase() === t) return s.type.toLowerCase();
    return null;
  };

  for (const step of plan.steps) {
    const tool = getTool(step.tool);
    if (!tool) continue; // already reported
    // Canonical forms of the step's targets: the raw target, plus the type of
    // a section it names, plus the page it lives on.
    const stepCanon = new Set<string>();
    for (const t of step.targets) {
      const lt = t.trim().toLowerCase();
      if (!lt) continue;
      stepCanon.add(lt);
      for (const page of digest.pages) {
        for (const s of page.sections) {
          if (s.id.toLowerCase() === lt) {
            stepCanon.add(s.type.toLowerCase());
            stepCanon.add(page.id.toLowerCase());
          }
        }
      }
    }
    for (const c of resolvedConstraints) {
      let conflict = false;
      if (c.kind === "section-type") {
        conflict = stepCanon.has(c.value);
      } else if (c.kind === "section-id") {
        const protType = sectionIdType(c.value);
        conflict = stepCanon.has(c.value) || (protType !== null && stepCanon.has(protType));
      } else if (c.kind === "page") {
        conflict = stepCanon.has(c.value);
      } else if (c.kind === "token-group") {
        conflict = (TOKEN_GROUP_TOOLS[c.value.toLowerCase()] ?? []).includes(step.tool);
      }
      if (conflict) {
        issues.push({
          code: "constraint-conflict",
          message: `Step “${step.title}” modifies ${c.raw}, which the request asked to keep untouched.`,
          stepId: step.id,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------- target canonicalization
// Models keep INVENTING plausible targets ("page-home", "hero-1") instead of
// copying the REAL ids from the digest ("home", "hero-lx2j3-1"). When the
// intended target is unambiguous, rewriting it deterministically is better
// than rejecting an expensive plan — and it keeps the planner, validator,
// executor and renderer on ONE authoritative set of identifiers (schema-aware
// operations instead of free-form names). Pure — testable.

/** Common aliases for the site's home page — the FIRST page is the home page. */
const HOME_PAGE_ALIASES = new Set(["home", "homepage", "home-page", "home_page", "home page", "index", "landing", "main-page", "main page"]);
/** Constraint-target namespaces models write ("theme.name") before the real token group ("name"). */
const CONSTRAINT_NS_PREFIXES = ["theme.", "site.", "global.", "site-", "theme_"];

export interface CanonicalizeReport {
  /** How many step/constraint targets were rewritten to real ids. */
  changed: number;
  /** Up to 3 human-readable rewrites, e.g. "page-home → home". */
  examples: string[];
}

interface CanonIndex {
  pages: { id: string; name: string; lowerId: string; lowerName: string }[];
  sections: { id: string; type: string; title: string; lowerId: string; lowerType: string; lowerTitle: string }[];
  sectionTypes: Map<string, string[]>;
  /** Section id (lowercased) → owning page id. */
  sectionPage: Map<string, string>;
}

function buildCanonIndex(digest: SiteDigest): CanonIndex {
  const pages = digest.pages.map((p) => ({ id: p.id, name: p.name, lowerId: p.id.toLowerCase(), lowerName: p.name.toLowerCase() }));
  const sectionPage = new Map<string, string>();
  const sections = digest.pages.flatMap((p) => {
    for (const s of p.sections) sectionPage.set(s.id.toLowerCase(), p.id);
    return p.sections.map((s) => ({ id: s.id, type: s.type, title: s.title, lowerId: s.id.toLowerCase(), lowerType: s.type.toLowerCase(), lowerTitle: s.title.toLowerCase() }));
  });
  const sectionTypes = new Map<string, string[]>();
  for (const s of sections) {
    const list = sectionTypes.get(s.lowerType) ?? [];
    list.push(s.id);
    sectionTypes.set(s.lowerType, list);
  }
  return { pages, sections, sectionTypes, sectionPage };
}

function pageByRef(index: CanonIndex, ref: string): string | null {
  const t = ref.trim().toLowerCase();
  if (!t) return null;
  const byId = index.pages.find((p) => p.lowerId === t);
  if (byId) return byId.id;
  const byName = index.pages.find((p) => p.lowerName === t);
  if (byName) return byName.id;
  return null;
}

/**
 * Resolve ONE page-kind target to a real page id, or null.
 * Order: exact id → exact name → noise-prefix strip ("page-home") →
 * home-page alias (first page IS the home page) → the only page of a
 * one-page website (any page target can only mean that page).
 */
function canonPageTarget(index: CanonIndex, raw: string): { id: string; from: string } | null {
  const t = raw.trim();
  if (!t) return null;
  const direct = pageByRef(index, t);
  if (direct) return direct === t ? null : { id: direct, from: t };
  const stripped = t.toLowerCase().replace(/^page[-_:]\s*/, "").trim();
  if (stripped && stripped !== t.toLowerCase()) {
    const viaStrip = pageByRef(index, stripped);
    if (viaStrip) return { id: viaStrip, from: t };
  }
  const bare = (stripped || t.toLowerCase()).replace(/[-_]/g, " ").trim();
  if (HOME_PAGE_ALIASES.has(bare) || HOME_PAGE_ALIASES.has(stripped)) {
    const first = index.pages[0];
    if (first && !pageByRef(index, "home")) return { id: first.id, from: t };
  }
  if (index.pages.length === 1) return { id: index.pages[0].id, from: t };
  return null;
}

/**
 * Resolve ONE section-kind target to a real section id, or null.
 * Order: exact id → exact type (already valid — canonicalize case only) →
 * noise-prefix strip → "<type>-<n>" invented pattern when EXACTLY ONE section
 * of that type exists → exact title.
 */
function canonSectionTarget(index: CanonIndex, raw: string): { id: string; from: string } | null {
  const t = raw.trim();
  if (!t) return null;
  const lt = t.toLowerCase();
  const byId = index.sections.find((s) => s.lowerId === lt);
  if (byId) return byId.id === t ? null : { id: byId.id, from: t };
  const stripped = lt.replace(/^section[-_:]\s*/, "").trim();
  if (stripped && stripped !== lt) {
    const viaStrip = canonSectionTarget(index, stripped);
    if (viaStrip) return { id: viaStrip.id, from: t };
  }
  // Exact type ref: legal vocabulary — canonicalize to the REAL id only when
  // exactly one section of that type exists (unambiguous). With several, the
  // type ref already resolves and must keep covering ALL of them.
  const typeList = index.sectionTypes.get(stripped);
  if (typeList) return typeList.length === 1 ? { id: typeList[0]!, from: t } : null;
  // "hero-1" / "about-section" style invented ids grounded in a real type.
  for (const [type, ids] of index.sectionTypes) {
    if (ids.length !== 1) continue;
    if (new RegExp(`^${type}([-_ ]?\\d*([-_ ]?section)?)?$`).test(stripped)) return { id: ids[0]!, from: t };
  }
  const byTitle = index.sections.find((s) => s.lowerTitle === lt);
  if (byTitle) return { id: byTitle.id, from: t };
  return null;
}

/**
 * The regions a constraint's OWN TEXT names — used to narrow over-broad
 * page-level constraint targets. "Keep the existing hero, site name and
 * champagne accent" protects a hero section + two token groups, NOT the
 * whole home page; models keep writing the page id anyway, which makes the
 * plan self-conflict with its own steps. Deterministic and conservative:
 * only keywords the text explicitly mentions become targets. Returns null
 * when the text names nothing narrower (a genuine whole-page protection).
 */
function narrowPageConstraint(text: string): string[] | null {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const type of ["hero", "about", "projects", "collections", "services", "experience", "gallery", "testimonials", "skills", "stats", "contact"]) {
    if (lower.includes(type)) out.push(type);
  }
  if (/\bsite name\b|\bsite's name\b|\bname\b/.test(lower)) out.push("name");
  if (/\btagline\b/.test(lower)) out.push("tagline");
  if (/\bcolor|accent|palette\b/.test(lower)) out.push("colors");
  if (/\bfont|typography|typeface\b/.test(lower)) out.push("fonts");
  if (/\bmotion|animation/.test(lower)) out.push("motion");
  if (out.length === 0) return null;
  return Array.from(new Set(out));
}

/**
 * Rewrite near-miss step/constraint targets to the ids that actually exist.
 * Deterministic and conservative: a target is rewritten ONLY when the website
 * structure makes the intent unambiguous; everything else stays for the
 * validator (and its honest "does not exist" diagnostics) to judge.
 */
export function canonicalizePlanTargets(plan: DesignPlan, digest: SiteDigest): { plan: DesignPlan; report: CanonicalizeReport } {
  const index = buildCanonIndex(digest);
  let changed = 0;
  const examples: string[] = [];
  /** Pages the plan's own steps actually touch (constraint narrowing only applies there). */
  const touchedPages = new Set<string>();

  const record = (from: string, to: string) => {
    changed += 1;
    if (examples.length < 3 && from !== to) examples.push(`${from} → ${to}`);
  };

  const steps = plan.steps.map((step) => {
    if (step.targets.length === 0) return step;
    const tool = getTool(step.tool);
    const isPageTool = tool?.targetKind === "page";
    const isSectionTool = tool?.targetKind === "section";
    if (!isPageTool && !isSectionTool) return step;
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const t of step.targets) {
      const hit = isPageTool ? canonPageTarget(index, t) : canonSectionTarget(index, t);
      const final = hit?.id ?? t;
      if (hit) record(t, final);
      // Touched-page tracking uses the CANONICAL target whether or not the
      // rewrite changed anything ("home" on the home page is already exact).
      if (isPageTool) {
        const pageId = pageByRef(index, final);
        if (pageId) touchedPages.add(pageId);
      } else if (isSectionTool) {
        const pageId = index.sectionPage.get(final.toLowerCase());
        if (pageId) touchedPages.add(pageId);
      }
      if (!seen.has(final)) {
        seen.add(final);
        targets.push(final);
      }
    }
    return { ...step, targets };
  });

  const constraints = plan.constraints.map((c) => {
    if (c.targets.length === 0) return c;
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const t of c.targets) {
      let candidate = t.trim();
      // "theme.name" → "name", "site.colors" → "colors" — the token groups
      // are the REAL schema vocabulary; namespaced paths are not.
      const lower = candidate.toLowerCase();
      for (const ns of CONSTRAINT_NS_PREFIXES) {
        if (lower.startsWith(ns) && candidate.slice(ns.length).trim()) {
          candidate = candidate.slice(ns.length).trim();
          break;
        }
      }
      // Already-valid constraint vocabulary (token groups, real ids/types,
      // known phrases) is NEVER rewritten — protection stays exactly as set.
      const resolved = resolveConstraintTarget(candidate, digest);
      if (resolved && resolved.kind !== "page") {
        if (!seen.has(candidate)) {
          seen.add(candidate);
          targets.push(candidate);
        }
        continue;
      }
      if (resolved?.kind === "page") {
        // Over-broad page protection: when the plan's own steps MODIFY the
        // constrained page AND the constraint's text names SPECIFIC regions
        // (hero, name, colors…), the user's words protect those parts — a
        // whole-page target would make the plan self-conflict. Narrow to
        // exactly what the text names; untouched pages keep full protection.
        if (touchedPages.has(resolved.value)) {
          const narrowed = narrowPageConstraint(c.text);
          if (narrowed) {
            record(t, narrowed.join("+"));
            for (const n of narrowed) {
              if (!seen.has(n)) {
                seen.add(n);
                targets.push(n);
              }
            }
            continue;
          }
        }
        if (!seen.has(candidate)) {
          seen.add(candidate);
          targets.push(candidate);
        }
        continue;
      }
      if (!resolved) {
        // "page-home" constraint targets → the real page id, then sections.
        const pageHit = canonPageTarget(index, candidate);
        if (pageHit) {
          candidate = pageHit.id;
        } else {
          const sectionHit = canonSectionTarget(index, candidate);
          if (sectionHit) candidate = sectionHit.id;
        }
      }
      if (candidate !== t.trim()) record(t, candidate);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        targets.push(candidate);
      }
    }
    return { ...c, targets };
  });

  if (changed === 0) return { plan, report: { changed: 0, examples: [] } };
  const next: DesignPlan = { ...plan, steps, constraints };
  const note = `Rewrote ${changed} target${changed === 1 ? "" : "s"} to the ids that actually exist on this website (${examples.join("; ")}${changed > examples.length ? "; …" : ""}).`;
  return { plan: { ...next, notes: [next.notes, note].filter(Boolean).join(" ") }, report: { changed, examples } };
}

// ---------------------------------------------------------------- plan resolution
// Pure resolution of ONE model JSON response into a PlanOutcome — shared by
// the first planning attempt and the bounded repair attempt so both run the
// EXACT same normalization → schema → digest-validation → constraint-repair
// pipeline. `schemaErrors` carries the real Zod diagnostics so a genuinely
// malformed plan fails with a meaningful, reportable error (never a generic
// "rephrase" dead end), and so the repair prompt can quote the exact problems.

/**
 * What one planning response resolved to: an executable plan, a plain
 * reply-only answer (no steps), or a digest-level rejection with issues.
 * Defined here (not in plan-core) so plan.ts stays dependency-free.
 */
export type PlanOutcome =
  | { kind: "plan"; plan: DesignPlan }
  | { kind: "reply"; reply: string; clarifyingQuestion: string | null }
  | { kind: "invalid"; reply: string; issues: PlanIssue[] };

export interface ResolvedPlanJson {
  /** Raw JSON as the model wrote it (pre-normalization), for repair prompts. */
  raw: Record<string, unknown>;
  outcome: PlanOutcome;
}

export function resolvePlanJson(
  parsedJson: Record<string, unknown>,
  digest: SiteDigest,
  request: string
): { ok: true; resolved: ResolvedPlanJson } | { ok: false; schemaErrors: string[] } {
  const normalized = normalizePlanJson(parsedJson);

  // Zero-step outcomes are legitimate: an off-scope general question gets a
  // brief answer + RIISHE pointer; an under-specified ask gets ONE focused
  // clarifying question. Neither plans nor executes anything.
  const stepsOut = normalized.steps as unknown[];
  if (stepsOut.length === 0) {
    const reply = typeof normalized.reply === "string" ? normalized.reply : "";
    const clarifying = typeof normalized.clarifyingQuestion === "string" ? normalized.clarifyingQuestion : null;
    return {
      ok: true,
      resolved: {
        raw: parsedJson,
        outcome: {
          kind: "reply" as const,
          reply: reply || clarifying || "Could you clarify what you'd like changed?",
          clarifyingQuestion: clarifying,
        },
      },
    };
  }

  // Schema-validate the (normalized) plan shape…
  const planCheck = designPlanSchema.safeParse(normalized);
  if (!planCheck.success) {
    const flat = planCheck.error.issues ?? [];
    const schemaErrors = flat
      .slice(0, 6)
      .map((i) => `${i.path.length ? `${i.path.join(".")}` : "(plan)"}: ${i.message}`);
    if (flat.length > 6) schemaErrors.push(`…and ${flat.length - 6} more schema issues`);
    return { ok: false, schemaErrors };
  }
  const canon = canonicalizePlanTargets(planCheck.data as DesignPlan, digest);
  let plan = canon.plan;
  let issues: PlanIssue[] = validatePlan(plan, digest);

  // Deterministic-patch repair: when a token step carries NO patch (the model
  // described the tokens in its instruction instead — glassmorphism asks are
  // the recurring case), rebuild the patch from the step's OWN text before
  // anything else judges the plan. The rebuilt patch re-enters the EXACT same
  // validator; if tokens cannot be derived, the step stays untouched and the
  // precise per-tool diagnostic (with the patch requirements quoted) stands.
  if (issues.some((i) => i.code === "invalid-patch")) {
    const attempt = repairMissingTokenPatches(plan, request);
    if (attempt.repaired.length > 0) {
      const rechecked = validatePlan(attempt.plan, digest);
      if (rechecked.length < issues.length) {
        plan = attempt.plan;
        issues = rechecked;
      }
    }
    // Inverse case (observed live): a MODEL tool step carries a deterministic
    // patch — the model meant to change tokens but bound the wrong tool. The
    // patch content names its real tool unambiguously (theme keys →
    // theme.tokens, motion keys → motion.configure); remapping is grounded in
    // the model's own payload, and the remapped step re-enters the SAME
    // validator. Nothing is invented; a patch that names no token group stays
    // rejected honestly.
    const remapped = remapModelStepsWithPatches(plan);
    if (remapped.changed) {
      const rechecked = validatePlan(remapped.plan, digest);
      if (rechecked.length < issues.length) {
        plan = remapped.plan;
        issues = rechecked;
      }
    }
  }

  if (issues.length > 0) {
    // Self-repair: if the ONLY problems stem from constraints the model
    // invented (conflicts it created, or unresolvable constraint targets —
    // never step-level problems), drop the constraints not grounded in the
    // user's request and re-validate. Constraints the user actually stated
    // are never dropped — those plans stay rejected and surface.
    const constraintRelated = (i: PlanIssue) =>
      i.code === "constraint-conflict" || (i.code === "unknown-section-target" && !i.stepId);
    if (issues.every(constraintRelated)) {
      const { plan: repaired, dropped } = dropUngroundedConstraints(plan, request);
      if (dropped.length > 0 && validatePlan(repaired, digest).length === 0) {
        const note = `Dropped ${dropped.length} preservation constraint${dropped.length === 1 ? "" : "s"} the model added on its own (you never asked for ${dropped.length === 1 ? "it" : "them"}). Constraints you state are always enforced, never dropped.`;
        return {
          ok: true,
          resolved: { raw: parsedJson, outcome: { kind: "plan" as const, plan: { ...repaired, notes: [repaired.notes, note].filter(Boolean).join(" ") } } },
        };
      }
      // Second repair: constraints whose targets DO NOT EXIST on this
      // website protect nothing real. Dropping/narrowing them cannot weaken
      // any genuine, resolvable protection — those are never touched.
      const { plan: unblocked, dropped: unresolvable, narrowed } = dropUnresolvableConstraints(repaired, digest);
      if (unresolvable.length + narrowed.length > 0 && validatePlan(unblocked, digest).length === 0) {
        const bits: string[] = [];
        if (unresolvable.length > 0)
          bits.push(`Removed ${unresolvable.length} preservation constraint${unresolvable.length === 1 ? "" : "s"} that named thing${unresolvable.length === 1 ? "s" : ""} which do not exist on this website`);
        if (narrowed.length > 0)
          bits.push(`Narrowed ${narrowed.length} constraint${narrowed.length === 1 ? "" : "s"} to the parts of the site that actually exist`);
        const note = `${bits.join("; ")} — nothing real was protected by the removed parts. Constraints pointing at real regions are always enforced.`;
        return {
          ok: true,
          resolved: { raw: parsedJson, outcome: { kind: "plan" as const, plan: { ...unblocked, notes: [unblocked.notes, note].filter(Boolean).join(" ") } } },
        };
      }
    }
    const reply = typeof normalized.reply === "string" ? normalized.reply : "";
    return { ok: true, resolved: { raw: parsedJson, outcome: { kind: "invalid" as const, reply, issues: issues.slice(0, 8) } } };
  }

  return { ok: true, resolved: { raw: parsedJson, outcome: { kind: "plan" as const, plan } } };
}
