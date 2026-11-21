/**
 * GIFTZ Motion Engine (M15) + Background Engine (M16).
 *
 * A controlled animation-generation capability layered onto the existing GIFTZ
 * platform. Everything here is STRUCTURED DATA + a single audited runtime
 * interpreter — presets are never emitted as arbitrary executable strings by
 * the AI. The AI (and the visual Motion editor) produce validated config
 * blocks (site.config.json `motion.gsap` + `backgroundEffects`); the
 * deterministic compiler turns those blocks into:
 *   - vendor script rows  (assets/vendor/*.js — read from the pinned npm
 *     packages, self-contained, no CDN),
 *   - one generated runtime (assets/motion.js) = interpreter + sanitized
 *     JSON program.
 *
 * Safety model:
 *   - config is validated by zod + registry lookups (unknown preset ids,
 *     plugins, effects and settings are rejected or healed, never executed);
 *   - selectors are validated against a conservative allowlist;
 *   - the runtime never evals, never fetches (CSP `connect-src 'none'` holds),
 *     loads only local vendor files, and always leaves content visible when
 *     JS is disabled, GSAP fails to load, or the user prefers reduced motion;
 *   - animations enhance content — they are never a requirement to read it.
 *
 * This module is pure (no fs, no db) so it is safe to import from
 * lib/site-config (client bundles included). File-system vendor reads live in
 * the server-only exporter/compiler.
 */

import { z } from "zod";
import type { SiteConfig } from "@/lib/site-config";
import {
  SCENE3D_RUNTIME_PATH,
  compileScene3dBlock,
  type Scene3dSceneProgram,
} from "./scene3d";

// ---------------------------------------------------------------- plugins

export interface GsapPluginSpec {
  /** npm package relative dist path (pinned by package.json + lockfile). */
  pkgPath: string;
  /** File name emitted under assets/vendor/. */
  fileName: string;
  /** window global the plugin registers ("" for core). */
  global: string;
  approxBytes: number;
}

export const GSAP_PLUGIN_CATALOG = {
  core: { pkgPath: "gsap/dist/gsap.min.js", fileName: "gsap.min.js", global: "gsap", approxBytes: 73357 },
  ScrollTrigger: { pkgPath: "gsap/dist/ScrollTrigger.min.js", fileName: "ScrollTrigger.min.js", global: "ScrollTrigger", approxBytes: 44683 },
  SplitText: { pkgPath: "gsap/dist/SplitText.min.js", fileName: "SplitText.min.js", global: "SplitText", approxBytes: 7955 },
  ScrambleTextPlugin: { pkgPath: "gsap/dist/ScrambleTextPlugin.min.js", fileName: "ScrambleTextPlugin.min.js", global: "ScrambleTextPlugin", approxBytes: 11687 },
  MotionPathPlugin: { pkgPath: "gsap/dist/MotionPathPlugin.min.js", fileName: "MotionPathPlugin.min.js", global: "MotionPathPlugin", approxBytes: 22002 },
  MorphSVGPlugin: { pkgPath: "gsap/dist/MorphSVGPlugin.min.js", fileName: "MorphSVGPlugin.min.js", global: "MorphSVGPlugin", approxBytes: 21195 },
  Flip: { pkgPath: "gsap/dist/Flip.min.js", fileName: "Flip.min.js", global: "Flip", approxBytes: 25596 },
  Observer: { pkgPath: "gsap/dist/Observer.min.js", fileName: "Observer.min.js", global: "Observer", approxBytes: 10055 },
  CustomEase: { pkgPath: "gsap/dist/CustomEase.min.js", fileName: "CustomEase.min.js", global: "CustomEase", approxBytes: 7143 },
  Draggable: { pkgPath: "gsap/dist/Draggable.min.js", fileName: "Draggable.min.js", global: "Draggable", approxBytes: 35762 },
  DrawSVGPlugin: { pkgPath: "gsap/dist/DrawSVGPlugin.min.js", fileName: "DrawSVGPlugin.min.js", global: "DrawSVGPlugin", approxBytes: 15374 },
} as const satisfies Record<string, GsapPluginSpec>;

export type GsapPluginId = keyof typeof GSAP_PLUGIN_CATALOG;

export const VENDOR_DIR = "assets/vendor";
export const MOTION_RUNTIME_PATH = "assets/motion.js";
/** three.js is required by every Vanta effect (r134, MIT — verified pairing). */
export const THREE_VENDOR: GsapPluginSpec = {
  pkgPath: "three/build/three.min.js",
  fileName: "three.min.js",
  global: "THREE",
  approxBytes: 615601,
};
export const NOISE_TEXTURE_PATH = `${VENDOR_DIR}/noise.png`;

// ---------------------------------------------------------------- easing

export const GSAP_EASING_IDS = [
  "none",
  "power1.out", "power2.out", "power3.out",
  "power1.inOut", "power2.inOut", "power3.inOut",
  "sine.out", "sine.inOut",
  "expo.out",
  "circ.out",
  "back.out(1.4)",
  "elastic.out(1, 0.5)",
] as const;

export type GsapEasingId = (typeof GSAP_EASING_IDS)[number];

/** CustomEase path data — conservative SVG path grammar (M/L/C/Q/H/V/Z + numbers). */
const CUSTOM_EASE_PATH_RE = /^M[\d.,\s]+(C[\d.,\s-]+|L[\d.,\s-]+|Q[\d.,\s-]+|H[\d.-]+|V[\d.-]+)+Z?$/i;

// ---------------------------------------------------------------- selectors

/**
 * Conservative CSS selector allowlist for AI/user-provided targets: class,
 * id, tag, descendant/child/sibling combinators, attribute presence/equals on
 * class/id/data flags, pseudo-classes used by the engine. Rejects `@`, `{}`,
 * `*html` hacks, `javascript:`, and anything with quotes/semicolons.
 */
const SAFE_SELECTOR_RE = /^[A-Za-z0-9\s\-_.>#,:()[\]=~*|^-]+$/;

export function selectorIssue(selector: string): string | null {
  if (!selector || selector.length > 200) return "selector must be 1-200 characters";
  if (!SAFE_SELECTOR_RE.test(selector)) return "selector uses characters outside the safe allowlist";
  if (/\{\}|@|;|javascript/i.test(selector)) return "selector contains unsafe syntax";
  return null;
}

// ---------------------------------------------------------------- targets

export const GSAP_TARGET_ELEMENTS = [
  "container", "heading", "text", "cards", "images", "buttons", "nav", "svg", "stats", "children",
] as const;
export type GsapTargetElement = (typeof GSAP_TARGET_ELEMENTS)[number];

export const targetKindSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("section"),
    sectionId: z.string().min(1).max(64),
    element: z.enum(GSAP_TARGET_ELEMENTS).default("container"),
  }),
  z.object({
    kind: z.literal("selector"),
    selector: z.string().min(1).max(200),
  }),
]);

/** Suffix each target element maps to inside a section container. */
const ELEMENT_SELECTOR_SUFFIX: Record<GsapTargetElement, string> = {
  container: "",
  heading: " h1, ${S} h2",
  text: " p, ${S} h1, ${S} h2, ${S} h3",
  cards: " .bs-sh",
  images: " img",
  buttons: " .bs-btn, ${S} a",
  nav: " .bs-nav-link",
  svg: " svg",
  stats: " .bs-stat-value",
  children: " > *",
};

/**
 * Resolve an animation target into a concrete CSS selector (comma list).
 * Returns null when the target cannot be resolved (honest skip).
 */
export function resolveTargetSelector(
  target: z.infer<typeof targetKindSchema>,
  sectionIds: Set<string>
): { selector: string | null; issue: string | null } {
  if (target.kind === "selector") {
    const issue = selectorIssue(target.selector);
    if (issue) return { selector: null, issue };
    return { selector: target.selector, issue: null };
  }
  if (!sectionIds.has(target.sectionId)) {
    return { selector: null, issue: `section "${target.sectionId}" does not exist in the site content model` };
  }
  const base = `[data-gz-section="${target.sectionId}"]`;
  const suffix = ELEMENT_SELECTOR_SUFFIX[target.element];
  const selector = suffix.replace(/\$\{S\}/g, base) || base;
  return { selector: `${base}${suffix === "" ? "" : selector}`, issue: null };
}

// ---------------------------------------------------------------- shared option fields

const sharedPresetOptions = {
  duration: z.number().min(100).max(6000).optional(),
  delay: z.number().min(0).max(8000).optional(),
  easing: z.string().max(48).optional(),
  stagger: z.number().min(0).max(900).optional(),
};

const scrollTriggerWindow = z.object({
  type: z.enum(["load", "scroll", "interaction"]).default("load"),
  start: z.string().max(60).optional(),
  end: z.string().max(60).optional(),
  once: z.boolean().default(true),
});

/**
 * ScrollTrigger position/length grammar — accepts start/end positions like
 * "top 85%", "bottom top", "center 60%" and end lengths like "+=120%".
 */
const ST_POSITION_RE =
  /^(?:\+=\d+(?:\.\d+)?(?:%|px)|(?:top|bottom|center|left|right)(?: [+-]?\d+(?:\.\d+)?(?:px|%|vh|vw))?(?: (?:top|bottom|center|left|right)(?: [+-]?\d+(?:\.\d+)?(?:px|%|vh|vw))?)?)$/;

export function scrollPositionIssue(value: string): string | null {
  if (!ST_POSITION_RE.test(value.trim())) {
    return `"${value}" is not a valid ScrollTrigger position (e.g. "top 85%", "top bottom", "+=120%")`;
  }
  return null;
}

// ---------------------------------------------------------------- GSAP preset registry

export type GsapPresetCategory = "entrance" | "text" | "scroll" | "interactive" | "advanced";

export interface GsapMotionPresetDef {
  id: string;
  name: string;
  description: string;
  category: GsapPresetCategory;
  /** Element kinds this preset can legitimately target. */
  targets: readonly GsapTargetElement[];
  plugins: readonly GsapPluginId[];
  /** Default trigger for a new animation using this preset. */
  trigger: "load" | "scroll" | "interaction";
  defaults: { duration: number; delay: number; easing: GsapEasingId; stagger?: number };
  responsive: { mobile: "full" | "reduced" | "off" };
  /** What users with reduced motion get instead. */
  reducedMotion: string;
  /** Cleanup contract (enforced by the generated runtime). */
  cleanup: string;
  options: z.ZodType;
}

const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "must be a #rgb or #rrggbb hex color");

const entranceOptions = z
  .object({
    ...sharedPresetOptions,
    distance: z.number().min(8).max(200).optional(),
    blur: z.number().min(0).max(24).optional(),
  })
  .strict();

function entrance(
  id: string,
  name: string,
  description: string,
  defaults: { duration: number; delay: number; easing: GsapEasingId; stagger?: number } = { duration: 800, delay: 0, easing: "power2.out" }
): GsapMotionPresetDef {
  return {
    id,
    name,
    description,
    category: "entrance",
    targets: ["container", "heading", "text", "cards", "images", "buttons"],
    plugins: ["core"],
    trigger: "scroll",
    defaults,
    responsive: { mobile: "full" },
    reducedMotion: "Content renders fully visible and static (no transform, no opacity animation).",
    cleanup: "All tweens are created inside one gsap.context(); context.revert() on pagehide restores inline styles.",
    options: entranceOptions,
  };
}

const textOptions = z.object({ ...sharedPresetOptions, splitBy: z.enum(["words", "chars", "lines"]).optional() }).strict();

const rotateOptions = z
  .object({
    ...sharedPresetOptions,
    words: z.array(z.string().min(1).max(60)).min(2).max(8),
    interval: z.number().min(1200).max(10000).optional(),
  })
  .strict();

const typeOptions = z
  .object({ ...sharedPresetOptions, speed: z.number().min(10).max(200).optional(), loop: z.boolean().optional() })
  .strict();

const scrambleOptions = z
  .object({
    ...sharedPresetOptions,
    chars: z.string().max(40).regex(/^[A-Za-z0-9!#$%&*+=?]*$/, "chars must be alphanumeric/symbols only").optional(),
  })
  .strict();

const parallaxOptions = z.object({ ...sharedPresetOptions, amount: z.number().min(-80).max(80).optional() }).strict();

const pinOptions = z.object({ ...sharedPresetOptions, end: z.string().max(30).regex(/^\+=\d+%?$/, "end must look like '+=120%'") }).strict();

const counterOptions = z
  .object({
    ...sharedPresetOptions,
    end: z.number().optional(),
    decimals: z.number().int().min(0).max(2).optional(),
    prefix: z.string().max(8).optional(),
    suffix: z.string().max(8).optional(),
  })
  .strict();

const hoverLiftOptions = z.object({ ...sharedPresetOptions, lift: z.number().min(2).max(24).optional(), scale: z.number().min(1).max(1.2).optional() }).strict();

const magneticOptions = z.object({ ...sharedPresetOptions, strength: z.number().min(0.05).max(0.8).optional() }).strict();

const tiltOptions = z
  .object({
    ...sharedPresetOptions,
    max: z.number().min(2).max(15).optional(),
    scale: z.number().min(1).max(1.08).optional(),
    perspective: z.number().min(400).max(1600).optional(),
  })
  .strict();

const tabsOptions = z
  .object({
    ...sharedPresetOptions,
    buttons: z.string().min(1).max(200),
    panels: z.string().min(1).max(200),
    activeClass: z.string().max(40).regex(/^[A-Za-z0-9_-]+$/).optional(),
  })
  .strict();

const navOptions = z.object({ ...sharedPresetOptions, style: z.enum(["underline", "fade", "slide"]).optional() }).strict();

const galleryOptions = z.object({ ...sharedPresetOptions, scale: z.number().min(1).max(1.15).optional() }).strict();

const modalOptions = z
  .object({
    ...sharedPresetOptions,
    trigger: z.string().min(1).max(200),
    target: z.string().min(1).max(200),
    animation: z.enum(["fade", "scale", "flip"]).optional(),
  })
  .strict();

const pathPoint = z.object({ x: z.number().min(-2000).max(2000), y: z.number().min(-2000).max(2000) }).strict();

const motionPathOptions = z
  .object({
    ...sharedPresetOptions,
    points: z.array(pathPoint).min(2).max(24).optional(),
    pathSelector: z.string().min(1).max(200).optional(),
    autoRotate: z.boolean().optional(),
    loop: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.points || v.pathSelector, { message: "motion-path needs `points` or `pathSelector`" });

const morphOptions = z
  .object({ ...sharedPresetOptions, from: z.string().min(1).max(200), to: z.string().min(1).max(200), loop: z.boolean().optional() })
  .strict();

const flipOptions = z
  .object({ ...sharedPresetOptions, trigger: z.string().min(1).max(200), target: z.string().min(1).max(200), activeClass: z.string().max(40).regex(/^[A-Za-z0-9_-]+$/).optional() })
  .strict();

const sequenceStep = z.object({ preset: z.enum(["fade-up", "fade-in", "slide-left", "slide-right", "scale-in"]), at: z.number().min(0).max(8000) }).strict();

const timelineOptions = z
  .object({ ...sharedPresetOptions, steps: z.array(sequenceStep).min(2).max(8) })
  .strict();

const customEaseOptions = z
  .object({ name: z.string().min(2).max(40).regex(/^gz-[a-z0-9-]+$/, "ease name must look like 'gz-my-ease'"), path: z.string().min(4).max(400) })
  .strict();

const layeredHeroOptions = z
  .object({
    ...sharedPresetOptions,
    parallax: z.boolean().optional(),
    includeButtons: z.boolean().optional(),
  })
  .strict();

const svgDrawOptions = z.object({ ...sharedPresetOptions, strokeWidthOnly: z.boolean().optional() }).strict();

const progressOptions = z.object({ ...sharedPresetOptions, origin: z.enum(["left", "right"]).optional() }).strict();

const accordionOptions = z.object({ ...sharedPresetOptions }).strict();

function definePreset(def: GsapMotionPresetDef): GsapMotionPresetDef {
  return def;
}

export const GSAP_MOTION_PRESETS: readonly GsapMotionPresetDef[] = [
  // ---- entrance
  definePreset(entrance("fade-in", "Fade in", "Opacity-only entrance — the most restrained reveal.", { duration: 700, delay: 0, easing: "power1.out" })),
  definePreset(entrance("fade-up", "Fade up", "Rises into place while fading in.")),
  definePreset(entrance("fade-down", "Fade down", "Drops into place while fading in.")),
  definePreset(entrance("slide-left", "Slide left", "Enters from the right edge, moving left.")),
  definePreset(entrance("slide-right", "Slide right", "Enters from the left edge, moving right.")),
  definePreset(entrance("scale-in", "Scale in", "Grows from 94% to full size while fading in.")),
  definePreset(entrance("blur-reveal", "Blur reveal", "Starts blurred and slightly scaled, sharpens into focus.", { duration: 900, delay: 0, easing: "power2.out" })),
  definePreset(entrance("clip-reveal", "Clip reveal", "A clip-path window slides open over the content.")),
  definePreset(
    entrance("stagger-entrance", "Staggered entrance", "Direct children of the target enter one after another.", {
      duration: 700, delay: 0, easing: "power2.out", stagger: 80,
    })
  ),
  // ---- text
  definePreset({
    id: "word-reveal", name: "Word reveal", description: "Splits the heading into words and reveals them in order.",
    category: "text", targets: ["heading"], plugins: ["core", "SplitText"], trigger: "scroll",
    defaults: { duration: 700, delay: 0, easing: "power2.out", stagger: 60 },
    responsive: { mobile: "full" },
    reducedMotion: "Heading renders as plain visible text (SplitText is skipped entirely).",
    cleanup: "SplitText instances are reverted through gsap.context(); original HTML restored.",
    options: textOptions,
  }),
  definePreset({
    id: "char-reveal", name: "Character reveal", description: "Per-character cascade for headlines (reserved for short headings).",
    category: "text", targets: ["heading"], plugins: ["core", "SplitText"], trigger: "scroll",
    defaults: { duration: 500, delay: 0, easing: "power2.out", stagger: 24 },
    responsive: { mobile: "reduced" },
    reducedMotion: "Heading renders as plain visible text.",
    cleanup: "SplitText revert via gsap.context().",
    options: textOptions,
  }),
  definePreset({
    id: "line-reveal", name: "Line reveal", description: "Reveals a heading line by line through overflow masks.",
    category: "text", targets: ["heading"], plugins: ["core", "SplitText"], trigger: "scroll",
    defaults: { duration: 800, delay: 0, easing: "power3.out", stagger: 120 },
    responsive: { mobile: "full" },
    reducedMotion: "Heading renders as plain visible text.",
    cleanup: "SplitText revert via gsap.context().",
    options: textOptions,
  }),
  definePreset({
    id: "split-clip", name: "Split text clip", description: "Split units slide up inside clipped masks (editorial headline style).",
    category: "text", targets: ["heading"], plugins: ["core", "SplitText"], trigger: "scroll",
    defaults: { duration: 900, delay: 0, easing: "power3.out", stagger: 80 },
    responsive: { mobile: "full" },
    reducedMotion: "Heading renders as plain visible text.",
    cleanup: "SplitText revert via gsap.context().",
    options: textOptions,
  }),
  definePreset({
    id: "scramble-text", name: "Scramble text", description: "Decodes the text through a scramble cycle.",
    category: "text", targets: ["heading", "text"], plugins: ["core", "ScrambleTextPlugin"], trigger: "scroll",
    defaults: { duration: 1200, delay: 0, easing: "none" },
    responsive: { mobile: "full" },
    reducedMotion: "Text renders in its final form immediately.",
    cleanup: "Tween killed via gsap.context() revert.",
    options: scrambleOptions,
  }),
  definePreset({
    id: "gradient-text", name: "Gradient text reveal", description: "Sweeps a background gradient across the heading text.",
    category: "text", targets: ["heading"], plugins: ["core"], trigger: "scroll",
    defaults: { duration: 1100, delay: 0, easing: "power1.inOut" },
    responsive: { mobile: "full" },
    reducedMotion: "Gradient renders in its final position.",
    cleanup: "gsap.context() revert restores background-position.",
    options: z.object({ ...sharedPresetOptions }).strict(),
  }),
  definePreset({
    id: "rotating-headline", name: "Rotating headline", description: "Cycles through a list of words inside the heading.",
    category: "text", targets: ["heading"], plugins: ["core"], trigger: "load",
    defaults: { duration: 600, delay: 0, easing: "power2.inOut" },
    responsive: { mobile: "full" },
    reducedMotion: "Shows the first word statically.",
    cleanup: "Timeline killed on pagehide via gsap.context().",
    options: rotateOptions,
  }),
  definePreset({
    id: "typewriter", name: "Typewriter", description: "Types the text out character by character (screen-reader safe).",
    category: "text", targets: ["heading", "text"], plugins: ["core"], trigger: "load",
    defaults: { duration: 1800, delay: 200, easing: "none" },
    responsive: { mobile: "full" },
    reducedMotion: "Full text renders immediately (sr-only copy always present).",
    cleanup: "Interval/tween cancelled via gsap.context() revert.",
    options: typeOptions,
  }),
  // ---- scroll
  definePreset({
    id: "scroll-reveal", name: "Scroll reveal", description: "General-purpose scroll-triggered entrance for any section.",
    category: "scroll", targets: ["container", "heading", "text", "cards"], plugins: ["core", "ScrollTrigger"], trigger: "scroll",
    defaults: { duration: 800, delay: 0, easing: "power2.out" },
    responsive: { mobile: "full" },
    reducedMotion: "Content visible immediately; no ScrollTrigger created.",
    cleanup: "ScrollTriggers killed by gsap.context() revert.",
    options: z.object({ ...sharedPresetOptions, ...entranceOptions.shape }).strict(),
  }),
  definePreset({
    id: "stagger-cards", name: "Staggered cards", description: "Cards cascade in as their grid scrolls into view.",
    category: "scroll", targets: ["container", "cards"], plugins: ["core", "ScrollTrigger"], trigger: "scroll",
    defaults: { duration: 700, delay: 0, easing: "power2.out", stagger: 80 },
    responsive: { mobile: "full" },
    reducedMotion: "Cards visible immediately.",
    cleanup: "ScrollTriggers killed by gsap.context() revert.",
    options: entranceOptions,
  }),
  definePreset({
    id: "parallax-image", name: "Parallax image", description: "Image drifts vertically against scroll (scrubbed, restrained range).",
    category: "scroll", targets: ["images"], plugins: ["core", "ScrollTrigger"], trigger: "scroll",
    defaults: { duration: 1, delay: 0, easing: "none" },
    responsive: { mobile: "off" },
    reducedMotion: "Image stays in its natural position.",
    cleanup: "ScrollTriggers killed by gsap.context() revert.",
    options: parallaxOptions,
  }),
  definePreset({
    id: "pinned-section", name: "Pinned section", description: "Pins the section while a progress timeline plays (storytelling).",
    category: "scroll", targets: ["container"], plugins: ["core", "ScrollTrigger"], trigger: "scroll",
    defaults: { duration: 1, delay: 0, easing: "none" },
    responsive: { mobile: "off" },
    reducedMotion: "Section never pins; content flows normally.",
    cleanup: "Pin + triggers killed by gsap.context() revert.",
    options: pinOptions,
  }),
  definePreset({
    id: "horizontal-story", name: "Horizontal storytelling", description: "Pins the section and translates its panels horizontally as the user scrolls.",
    category: "scroll", targets: ["container"], plugins: ["core", "ScrollTrigger"], trigger: "scroll",
    defaults: { duration: 1, delay: 0, easing: "none" },
    responsive: { mobile: "off" },
    reducedMotion: "Panels remain in normal vertical flow.",
    cleanup: "Pin + triggers killed by gsap.context() revert.",
    options: pinOptions,
  }),
  definePreset({
    id: "scroll-progress", name: "Scroll progress", description: "Animates the target bar's scaleX with overall scroll progress.",
    category: "scroll", targets: ["container"], plugins: ["core", "ScrollTrigger"], trigger: "scroll",
    defaults: { duration: 1, delay: 0, easing: "none" },
    responsive: { mobile: "full" },
    reducedMotion: "Progress bar tracks scroll without a smoothed tween (instant updates).",
    cleanup: "ScrollTrigger killed by gsap.context() revert.",
    options: progressOptions,
  }),
  definePreset({
    id: "svg-draw", name: "SVG line drawing", description: "Draws inline SVG strokes as the section enters the viewport.",
    category: "scroll", targets: ["svg", "container"], plugins: ["core", "ScrollTrigger", "DrawSVGPlugin"], trigger: "scroll",
    defaults: { duration: 1600, delay: 0, easing: "power1.inOut" },
    responsive: { mobile: "full" },
    reducedMotion: "SVG strokes render fully drawn.",
    cleanup: "Tweens killed by gsap.context() revert.",
    options: svgDrawOptions,
  }),
  definePreset({
    id: "number-counter", name: "Number counter", description: "Counts a stat value up when it scrolls into view.",
    category: "scroll", targets: ["stats"], plugins: ["core", "ScrollTrigger"], trigger: "scroll",
    defaults: { duration: 1400, delay: 0, easing: "power1.out" },
    responsive: { mobile: "full" },
    reducedMotion: "Final number renders immediately.",
    cleanup: "Tween killed by gsap.context() revert.",
    options: counterOptions,
  }),
  // ---- interactive
  definePreset({
    id: "hover-lift", name: "Hover lift", description: "Target rises and scales slightly on hover.",
    category: "interactive", targets: ["cards", "buttons", "images"], plugins: ["core"], trigger: "interaction",
    defaults: { duration: 350, delay: 0, easing: "power2.out" },
    responsive: { mobile: "off" },
    reducedMotion: "No hover transform.",
    cleanup: "Listeners removed on pagehide via gsap.context().",
    options: hoverLiftOptions,
  }),
  definePreset({
    id: "magnetic-button", name: "Magnetic button", description: "Button gravitates toward the cursor and springs back.",
    category: "interactive", targets: ["buttons"], plugins: ["core"], trigger: "interaction",
    defaults: { duration: 400, delay: 0, easing: "power3.out" },
    responsive: { mobile: "off" },
    reducedMotion: "Button stays fixed.",
    cleanup: "Listeners removed via gsap.context().",
    options: magneticOptions,
  }),
  definePreset({
    id: "card-tilt", name: "Card tilt", description: "3D tilt following the cursor (desktop pointing devices only).",
    category: "interactive", targets: ["cards", "images"], plugins: ["core"], trigger: "interaction",
    defaults: { duration: 400, delay: 0, easing: "power2.out" },
    responsive: { mobile: "off" },
    reducedMotion: "No tilt — the card renders flat and static.",
    cleanup: "Listeners removed via gsap.context().",
    options: tiltOptions,
  }),
  definePreset({
    id: "tab-transition", name: "Tab transition", description: "FLIP-animated panel swap when a tab button is clicked.",
    category: "interactive", targets: ["container"], plugins: ["core", "Flip"], trigger: "interaction",
    defaults: { duration: 500, delay: 0, easing: "power2.inOut" },
    responsive: { mobile: "full" },
    reducedMotion: "Panels swap instantly.",
    cleanup: "Listeners removed via gsap.context().",
    options: tabsOptions,
  }),
  definePreset({
    id: "nav-transition", name: "Navigation transition", description: "Animated hover treatment for nav links.",
    category: "interactive", targets: ["nav"], plugins: ["core"], trigger: "interaction",
    defaults: { duration: 300, delay: 0, easing: "power1.out" },
    responsive: { mobile: "off" },
    reducedMotion: "Links use plain CSS hover color only.",
    cleanup: "Listeners removed via gsap.context().",
    options: navOptions,
  }),
  definePreset({
    id: "gallery-flip", name: "Gallery transition", description: "Smooth FLIP scale/position transition for gallery figures on click.",
    category: "interactive", targets: ["images", "cards"], plugins: ["core", "Flip"], trigger: "interaction",
    defaults: { duration: 500, delay: 0, easing: "power2.inOut" },
    responsive: { mobile: "full" },
    reducedMotion: "Images toggle state instantly.",
    cleanup: "Listeners removed via gsap.context().",
    options: galleryOptions,
  }),
  definePreset({
    id: "accordion-motion", name: "Accordion motion", description: "Animates <details> open/close height inside the section.",
    category: "interactive", targets: ["container"], plugins: ["core"], trigger: "interaction",
    defaults: { duration: 400, delay: 0, easing: "power2.out" },
    responsive: { mobile: "full" },
    reducedMotion: "Details toggle instantly (native behaviour).",
    cleanup: "Listeners removed via gsap.context().",
    options: accordionOptions,
  }),
  definePreset({
    id: "modal-transition", name: "Modal transition", description: "Animates a target panel in/out when a trigger element is clicked.",
    category: "interactive", targets: ["container"], plugins: ["core", "Flip"], trigger: "interaction",
    defaults: { duration: 450, delay: 0, easing: "power2.out" },
    responsive: { mobile: "full" },
    reducedMotion: "Panel toggles instantly.",
    cleanup: "Listeners removed via gsap.context().",
    options: modalOptions,
  }),
  // ---- advanced
  definePreset({
    id: "motion-path", name: "Motion path", description: "Moves the target along a validated point list or an inline SVG path.",
    category: "advanced", targets: ["images", "buttons", "svg", "container"], plugins: ["core", "MotionPathPlugin"], trigger: "load",
    defaults: { duration: 4000, delay: 0, easing: "sine.inOut" },
    responsive: { mobile: "reduced" },
    reducedMotion: "Element rests at the end of the path.",
    cleanup: "Tween killed via gsap.context().",
    options: motionPathOptions,
  }),
  definePreset({
    id: "svg-morph", name: "SVG morphing", description: "Morphs one inline SVG path into another.",
    category: "advanced", targets: ["svg"], plugins: ["core", "MorphSVGPlugin"], trigger: "load",
    defaults: { duration: 2000, delay: 0, easing: "power2.inOut" },
    responsive: { mobile: "full" },
    reducedMotion: "Shows the final path.",
    cleanup: "Tween killed via gsap.context().",
    options: morphOptions,
  }),
  definePreset({
    id: "flip-transition", name: "FLIP transition", description: "Captures position/size state and animates layout change on toggle.",
    category: "advanced", targets: ["container", "cards"], plugins: ["core", "Flip"], trigger: "interaction",
    defaults: { duration: 500, delay: 0, easing: "power2.inOut" },
    responsive: { mobile: "full" },
    reducedMotion: "State toggles instantly.",
    cleanup: "Listeners removed via gsap.context().",
    options: flipOptions,
  }),
  definePreset({
    id: "timeline-sequence", name: "Complex timeline", description: "Chained entrance steps at explicit offsets inside one timeline.",
    category: "advanced", targets: ["container", "cards", "text"], plugins: ["core"], trigger: "load",
    defaults: { duration: 700, delay: 0, easing: "power2.out" },
    responsive: { mobile: "full" },
    reducedMotion: "All steps end-state applied instantly.",
    cleanup: "Timeline killed via gsap.context().",
    options: timelineOptions,
  }),
  definePreset({
    id: "custom-ease", name: "Custom easing", description: "Registers a CustomEase curve other animations can reference by name.",
    category: "advanced", targets: ["container"], plugins: ["core", "CustomEase"], trigger: "load",
    defaults: { duration: 1, delay: 0, easing: "none" },
    responsive: { mobile: "full" },
    reducedMotion: "Ease registration is inert (no visual of its own).",
    cleanup: "Ease unregister on revert.",
    options: customEaseOptions,
  }),
  definePreset({
    id: "layered-hero", name: "Layered hero", description: "Cinematic hero: children cascade in, optional cover parallax.",
    category: "advanced", targets: ["container"], plugins: ["core", "ScrollTrigger"], trigger: "load",
    defaults: { duration: 1000, delay: 100, easing: "power3.out", stagger: 120 },
    responsive: { mobile: "reduced" },
    reducedMotion: "Hero children render visible and static.",
    cleanup: "Timeline + ScrollTrigger killed via gsap.context().",
    options: layeredHeroOptions,
  }),
];

export const GSAP_MOTION_PRESET_IDS = GSAP_MOTION_PRESETS.map((p) => p.id);

export function getGsapMotionPreset(id: string): GsapMotionPresetDef | null {
  return GSAP_MOTION_PRESETS.find((p) => p.id === id) ?? null;
}

// ---------------------------------------------------------------- config schemas (site.config.json blocks)

export const gsapAnimationSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "animation id must be kebab-case"),
  preset: z.string().min(1).max(48),
  target: targetKindSchema,
  trigger: scrollTriggerWindow.default({ type: "load", once: true }),
  options: z.record(z.string(), z.unknown()).default({}),
  responsive: z.object({ mobile: z.enum(["full", "reduced", "off"]).default("full") }).default({ mobile: "full" }),
  reducedMotion: z.enum(["static", "simplified"]).default("static"),
  enabled: z.boolean().default(true),
});

export const gsapMotionBlockSchema = z.object({
  enabled: z.boolean().default(false),
  respectReducedMotion: z.boolean().default(true),
  animations: z.array(gsapAnimationSchema).max(40).default([]),
});

export type GsapMotionBlock = z.infer<typeof gsapMotionBlockSchema>;
export type GsapAnimationSpec = z.infer<typeof gsapAnimationSchema>;

export const backgroundEffectsSchema = z.object({
  enabled: z.boolean().default(false),
  engine: z.literal("vanta").default("vanta"),
  effect: z.string().min(1).max(32),
  target: z
    .object({
      kind: z.enum(["page", "hero", "section"]).default("hero"),
      sectionId: z.string().max(64).optional(),
    })
    .default({ kind: "hero" }),
  settings: z.record(z.string(), z.unknown()).default({}),
  responsive: z.object({ mobile: z.enum(["full", "reduced", "off"]).default("reduced") }).default({ mobile: "reduced" }),
  accessibility: z.object({ respectReducedMotion: z.boolean().default(true) }).default({ respectReducedMotion: true }),
  fallback: z
    .object({
      kind: z.enum(["color", "gradient"]).default("color"),
      value: z.string().max(200).default("#101014"),
    })
    .default({ kind: "color", value: "#101014" }),
});

export type BackgroundEffects = z.infer<typeof backgroundEffectsSchema>;

// ---------------------------------------------------------------- Vanta effect registry

export interface VantaEffectDef {
  id: string;
  name: string;
  description: string;
  distFile: string;
  engine: "three";
  /** Settings allowlist derived from the installed package's real defaults. */
  settings: VantaEffectSettings;
  performance: "light" | "moderate" | "heavy";
  mobile: "supported" | "reduced" | "avoid";
  recommendedFor: string[];
  cleanup: string;
  requiresTexture?: boolean;
}

const vantaCommon = {
  mouseControls: z.boolean().optional(),
  touchControls: z.boolean().optional(),
  gyroControls: z.boolean().optional(),
  minHeight: z.number().int().min(0).max(4000).optional(),
  minWidth: z.number().int().min(0).max(4000).optional(),
  scale: z.number().min(0.2).max(8).optional(),
  scaleMobile: z.number().min(0.2).max(16).optional(),
};

const vantaEffect = (extra: Record<string, z.ZodTypeAny>) => {
  const shape = { ...vantaCommon, ...extra };
  const schema = z.object(shape).strict();
  return { schema, settingKeys: Object.keys(shape) };
};

/** Validated settings schema + documented keys for one Vanta effect. */
export interface VantaEffectSettings {
  schema: z.ZodType;
  settingKeys: readonly string[];
}

export const VANTA_EFFECTS: readonly VantaEffectDef[] = [
  {
    id: "FOG", name: "Fog", description: "Slow volumetric fog with soft color washes — atmospheric hero backgrounds.",
    distFile: "vanta.fog.min.js", engine: "three", performance: "moderate", mobile: "reduced",
    recommendedFor: ["agency", "luxury", "creative", "restaurant"],
    cleanup: "effect.destroy() removes the canvas, listeners and the render loop.",
    settings: vantaEffect({
      highlightColor: hexColor.optional(), midtoneColor: hexColor.optional(), lowlightColor: hexColor.optional(),
      baseColor: hexColor.optional(), blurFactor: z.number().min(0.1).max(1).optional(),
      speed: z.number().min(0.1).max(4).optional(), zoom: z.number().min(0.4).max(3).optional(),
    }),
  },
  {
    id: "NET", name: "Network", description: "Connected particle network responding to the pointer.",
    distFile: "vanta.net.min.js", engine: "three", performance: "light", mobile: "supported",
    recommendedFor: ["saas", "technology", "developer"],
    cleanup: "effect.destroy() removes the canvas, listeners and the render loop.",
    settings: vantaEffect({
      color: hexColor.optional(), backgroundColor: hexColor.optional(),
      points: z.number().int().min(4).max(40).optional(), maxDistance: z.number().min(8).max(40).optional(),
      spacing: z.number().min(10).max(60).optional(), showDots: z.boolean().optional(),
    }),
  },
  {
    id: "WAVES", name: "Waves", description: "Shaded animated ocean surface — calm, elegant motion.",
    distFile: "vanta.waves.min.js", engine: "three", performance: "moderate", mobile: "reduced",
    recommendedFor: ["travel", "hospitality", "luxury"],
    cleanup: "effect.destroy() removes the canvas, listeners and the render loop.",
    settings: vantaEffect({
      color: hexColor.optional(), shininess: z.number().min(0).max(100).optional(),
      waveHeight: z.number().min(2).max(40).optional(), waveSpeed: z.number().min(0.2).max(3).optional(),
      zoom: z.number().min(0.4).max(3).optional(),
    }),
  },
  {
    id: "GLOBE", name: "Globe", description: "Rotating dotted 3D globe with a connected point sphere.",
    distFile: "vanta.globe.min.js", engine: "three", performance: "heavy", mobile: "reduced",
    recommendedFor: ["global-business", "logistics"],
    cleanup: "effect.destroy() removes the canvas, listeners and the render loop.",
    settings: vantaEffect({
      color: hexColor.optional(), color2: hexColor.optional(), size: z.number().min(0.5).max(2).optional(),
      backgroundColor: hexColor.optional(), showDots: z.boolean().optional(),
    }),
  },
  {
    id: "BIRDS", name: "Birds", description: "Flocking 3D birds with variance-gradient coloring — the signature Vanta effect.",
    distFile: "vanta.birds.min.js", engine: "three", performance: "heavy", mobile: "avoid",
    recommendedFor: ["creative-portfolio", "agency"],
    cleanup: "effect.destroy() removes the canvas, listeners and the render loop.",
    settings: vantaEffect({
      color1: hexColor.optional(), color2: hexColor.optional(), backgroundColor: hexColor.optional(),
      colorMode: z.literal("varianceGradient").optional(), birdSize: z.number().min(0.5).max(3).optional(),
      wingSpan: z.number().min(8).max(60).optional(), speedLimit: z.number().min(1).max(12).optional(),
      separation: z.number().min(5).max(60).optional(), alignment: z.number().min(5).max(60).optional(),
      cohesion: z.number().min(5).max(60).optional(), quantity: z.number().int().min(1).max(12).optional(),
    }),
  },
  {
    id: "CELLS", name: "Cells", description: "Organic pulsing rings — biological, generative atmosphere.",
    distFile: "vanta.cells.min.js", engine: "three", performance: "moderate", mobile: "reduced",
    recommendedFor: ["science", "creative", "health"],
    cleanup: "effect.destroy() removes the canvas, listeners and the render loop.",
    settings: vantaEffect({
      color1: hexColor.optional(), color2: hexColor.optional(), backgroundColor: hexColor.optional(),
      amplitudeFactor: z.number().min(0.2).max(3).optional(), ringFactor: z.number().min(0.2).max(8).optional(),
      rotationFactor: z.number().min(0).max(2).optional(), size: z.number().min(0.5).max(3).optional(),
      speed: z.number().min(0.1).max(4).optional(),
    }),
  },
  {
    id: "DOTS", name: "Dots", description: "Drifting dot field with connective lines — subtle tech backdrop.",
    distFile: "vanta.dots.min.js", engine: "three", performance: "light", mobile: "supported",
    recommendedFor: ["saas", "portfolio", "minimal"],
    cleanup: "effect.destroy() removes the canvas, listeners and the render loop.",
    settings: vantaEffect({
      color: hexColor.optional(), color2: hexColor.optional(), backgroundColor: hexColor.optional(),
      size: z.number().min(0.5).max(6).optional(), spacing: z.number().min(15).max(80).optional(),
      showLines: z.boolean().optional(),
    }),
  },
  {
    id: "RINGS", name: "Rings", description: "Concentric pulsing rings — minimal, hypnotic motion.",
    distFile: "vanta.rings.min.js", engine: "three", performance: "light", mobile: "supported",
    recommendedFor: ["minimal", "luxury", "music"],
    cleanup: "effect.destroy() removes the canvas, listeners and the render loop.",
    settings: vantaEffect({ backgroundColor: hexColor.optional(), color: hexColor.optional() }),
  },
  {
    id: "TOPOLOGY", name: "Topology", description: "Wireframe contour grid — technical, architectural texture.",
    distFile: "vanta.topology.min.js", engine: "three", performance: "light", mobile: "supported",
    recommendedFor: ["architecture", "technology"],
    cleanup: "effect.destroy() removes the canvas, listeners and the render loop.",
    settings: vantaEffect({ color: hexColor.optional(), backgroundColor: hexColor.optional() }),
  },
  {
    id: "TRUNK", name: "Trunk", description: "Recursive branching structure — generative botanical lines.",
    distFile: "vanta.trunk.min.js", engine: "three", performance: "moderate", mobile: "reduced",
    recommendedFor: ["art", "nature", "creative"],
    cleanup: "effect.destroy() removes the canvas, listeners and the render loop.",
    settings: vantaEffect({
      color: hexColor.optional(), backgroundColor: hexColor.optional(),
      spacing: z.number().min(0).max(20).optional(), chaos: z.number().min(0).max(4).optional(),
    }),
  },
  {
    id: "CLOUDS", name: "Clouds (shader)", description: "Volumetric sky shader — self-contained, no texture fetch.",
    distFile: "vanta.clouds.min.js", engine: "three", performance: "heavy", mobile: "avoid",
    recommendedFor: ["travel", "hospitality"],
    cleanup: "effect.destroy() removes the canvas, listeners and the render loop.",
    settings: vantaEffect({
      backgroundColor: hexColor.optional(), skyColor: hexColor.optional(), cloudColor: hexColor.optional(),
      cloudShadowColor: hexColor.optional(), sunColor: hexColor.optional(), sunGlareColor: hexColor.optional(),
      sunlightColor: hexColor.optional(), speed: z.number().min(0.1).max(3).optional(),
      mouseEase: z.boolean().optional(),
    }),
  },
  {
    id: "CLOUDS2", name: "Clouds (textured)", description: "Noise-textured cloud shader — the compiler bundles a local noise texture.",
    distFile: "vanta.clouds2.min.js", engine: "three", performance: "heavy", mobile: "avoid",
    recommendedFor: ["travel", "atmospheric"],
    cleanup: "effect.destroy() removes the canvas, listeners and the render loop.",
    requiresTexture: true,
    settings: vantaEffect({
      backgroundColor: hexColor.optional(), skyColor: hexColor.optional(), cloudColor: hexColor.optional(),
      lightColor: hexColor.optional(), speed: z.number().min(0.1).max(3).optional(),
    }),
  },
  {
    id: "RIPPLE", name: "Ripple", description: "Interference ripples across a shaded plane.",
    distFile: "vanta.ripple.min.js", engine: "three", performance: "moderate", mobile: "reduced",
    recommendedFor: ["music", "events", "creative"],
    cleanup: "effect.destroy() removes the canvas, listeners and the render loop.",
    settings: vantaEffect({
      color1: hexColor.optional(), color2: hexColor.optional(), backgroundColor: hexColor.optional(),
      amplitudeFactor: z.number().min(0.2).max(3).optional(), ringFactor: z.number().min(0.5).max(12).optional(),
      rotationFactor: z.number().min(0).max(1).optional(), speed: z.number().min(0.1).max(4).optional(),
    }),
  },
];

/**
 * HALO is intentionally NOT exposed: the installed 0.5.24 dist carries no
 * verifiable defaultOptions for it, and the M16 spec forbids inventing
 * unsupported configuration options.
 */
export const VANTA_EFFECT_IDS = VANTA_EFFECTS.map((e) => e.id);

export function getVantaEffect(id: string): VantaEffectDef | null {
  return VANTA_EFFECTS.find((e) => e.id === id) ?? null;
}

// ---------------------------------------------------------------- validation / sanitization

export interface MotionIssue {
  path: string;
  message: string;
}

export interface ValidationOutcome<T> {
  ok: boolean;
  issues: MotionIssue[];
  value: T | null;
}

function presetDefaultsIssue(preset: GsapMotionPresetDef | null, options: Record<string, unknown>): MotionIssue[] {
  if (!preset) return [];
  const issues: MotionIssue[] = [];
  const parsed = preset.options.safeParse(options);
  if (!parsed.success) {
    for (const problem of parsed.error.issues.slice(0, 4)) {
      issues.push({ path: problem.path.join("."), message: problem.message });
    }
  }
  return issues;
}

function easingIssue(preset: GsapMotionPresetDef | null, options: Record<string, unknown>): MotionIssue | null {
  const easing = options?.easing;
  if (typeof easing !== "string" || easing.length === 0) return null;
  if ((GSAP_EASING_IDS as readonly string[]).includes(easing)) return null;
  if (/^gz-[a-z0-9-]+$/.test(easing)) return null; // registered by a custom-ease preset
  return { path: "options.easing", message: `unknown easing "${easing}"` };
}

function triggerIssues(trigger: { type: string; start?: string; end?: string }): MotionIssue[] {
  const issues: MotionIssue[] = [];
  if (trigger.type === "scroll") {
    if (trigger.start !== undefined) {
      const issue = scrollPositionIssue(trigger.start);
      if (issue) issues.push({ path: "trigger.start", message: issue });
    }
    if (trigger.end !== undefined) {
      const issue = scrollPositionIssue(trigger.end);
      if (issue) issues.push({ path: "trigger.end", message: issue });
    }
  }
  return issues;
}

/**
 * Validate + sanitize a motion.gsap block against the preset registry.
 * Unknown presets are rejected (not healed) — the caller decides whether to
 * drop the animation or surface the error.
 */
export function validateGsapMotionBlock(block: GsapMotionBlock, sectionIds: Set<string>): ValidationOutcome<GsapMotionBlock> {
  const issues: MotionIssue[] = [];
  const seenIds = new Set<string>();
  const seenTargets = new Map<string, number>();
  const animations = block.animations.filter((animation) => {
    const preset = getGsapMotionPreset(animation.preset);
    if (!preset) {
      issues.push({ path: `animations.${animation.id}.preset`, message: `unknown preset "${animation.preset}"` });
      return false;
    }
    if (!animation.enabled) return true;
    const target = animation.target as { kind: string; sectionId?: string; selector?: string; element?: string };
    if (target.kind === "section" && target.sectionId && !sectionIds.has(target.sectionId)) {
      issues.push({ path: `animations.${animation.id}.target`, message: `section "${target.sectionId}" does not exist` });
      return false;
    }
    if (target.kind === "selector" && target.selector) {
      const issue = selectorIssue(target.selector);
      if (issue) {
        issues.push({ path: `animations.${animation.id}.target`, message: issue });
        return false;
      }
    }
    for (const issue of presetDefaultsIssue(preset, animation.options as Record<string, unknown>)) {
      issues.push({ path: `animations.${animation.id}.${issue.path}`, message: issue.message });
    }
    const easing = easingIssue(preset, animation.options as Record<string, unknown>);
    if (easing) issues.push({ path: `animations.${animation.id}.${easing.path}`, message: easing.message });
    for (const issue of triggerIssues(animation.trigger as { type: string; start?: string; end?: string })) {
      issues.push({ path: `animations.${animation.id}.${issue.path}`, message: issue.message });
    }
    // Plugin capability gate — an animation may only use registered plugins.
    for (const plugin of preset.plugins) {
      if (!(plugin in GSAP_PLUGIN_CATALOG)) {
        issues.push({ path: `animations.${animation.id}.preset`, message: `unsupported plugin "${plugin}"` });
        return false;
      }
    }
    if (seenIds.has(animation.id)) {
      issues.push({ path: `animations.${animation.id}`, message: "duplicate animation id" });
      return false;
    }
    seenIds.add(animation.id);
    const targetKey = JSON.stringify(animation.target);
    const count = (seenTargets.get(targetKey) ?? 0) + 1;
    seenTargets.set(targetKey, count);
    if (count > 1) {
      issues.push({
        path: `animations.${animation.id}.target`,
        message: `duplicate target for the same preset family — animation #${count} targeting identical selector`,
      });
    }
    return true;
  });
  return { ok: issues.length === 0, issues, value: { ...block, animations } };
}

/** Validate + sanitize a backgroundEffects block against the Vanta registry. */
export function validateBackgroundEffects(
  block: BackgroundEffects,
  sectionIds: Set<string>
): ValidationOutcome<BackgroundEffects> {
  const issues: MotionIssue[] = [];
  if (!block.enabled) return { ok: true, issues, value: block };
  const effect = getVantaEffect(block.effect);
  if (!effect) {
    issues.push({ path: "backgroundEffects.effect", message: `unknown effect "${block.effect}"` });
    return { ok: false, issues, value: null };
  }
  if (block.target.kind === "section") {
    if (!block.target.sectionId || !sectionIds.has(block.target.sectionId)) {
      issues.push({ path: "backgroundEffects.target", message: "target.kind 'section' requires an existing sectionId" });
    }
  }
  const parsed = effect.settings.schema.safeParse(block.settings ?? {});
  if (!parsed.success) {
    for (const problem of parsed.error.issues.slice(0, 4)) {
      issues.push({
        path: `backgroundEffects.settings.${problem.path.join(".")}`,
        message: `${problem.message} (allowed keys: ${effect.settings.settingKeys.join(", ")})`,
      });
    }
  }
  return { ok: issues.length === 0, issues, value: block };
}

// ---------------------------------------------------------------- motion program

export interface MotionStep {
  id: string;
  preset: string;
  selector: string;
  trigger: { type: "load" | "scroll" | "interaction"; start: string; end: string; once: boolean };
  options: Record<string, unknown>;
  responsive: { mobile: "full" | "reduced" | "off" };
  reducedMotion: "static" | "simplified";
}

export interface VantaProgram {
  effect: string;
  distFile: string;
  selector: string;
  settings: Record<string, unknown>;
  responsive: { mobile: "full" | "reduced" | "off" };
  respectReducedMotion: boolean;
  fallback: { kind: "color" | "gradient"; value: string };
  textureUrl: string | null;
}

export interface MotionProgram {
  gsapEnabled: boolean;
  respectReducedMotion: boolean;
  animations: MotionStep[];
  plugins: GsapPluginId[];
  vanta: VantaProgram | null;
  /** Structured 3D scenes (GZ-3) — empty when none are enabled/valid. */
  scene3d: Scene3dSceneProgram[];
}

export interface VendorFileSpec {
  path: string;
  pkgPath: string;
  encoding: "utf8";
  approxBytes: number;
}

/** Every local file the compiled site must carry for this program to work. */
export function vendorFileSpecs(program: MotionProgram | null): VendorFileSpec[] {
  if (!program) return [];
  const specs: VendorFileSpec[] = [];
  const needsThree = Boolean(program.vanta) || program.scene3d.length > 0;
  if (program.gsapEnabled) {
    for (const plugin of program.plugins) {
      const spec = GSAP_PLUGIN_CATALOG[plugin];
      specs.push({ path: `${VENDOR_DIR}/${spec.fileName}`, pkgPath: spec.pkgPath, encoding: "utf8", approxBytes: spec.approxBytes });
    }
  }
  if (needsThree) {
    const three = THREE_VENDOR;
    specs.push({ path: `${VENDOR_DIR}/${three.fileName}`, pkgPath: three.pkgPath, encoding: "utf8", approxBytes: three.approxBytes });
    if (program.vanta) {
      const effect = getVantaEffect(program.vanta.effect);
      if (effect) {
        specs.push({
          path: `${VENDOR_DIR}/${effect.distFile}`,
          pkgPath: `vanta/dist/${effect.distFile}`,
          encoding: "utf8",
          approxBytes: 30000,
        });
      }
    }
  }
  return specs;
}

export function pluginsForAnimations(animations: MotionStep[]): GsapPluginId[] {
  const order: GsapPluginId[] = ["core"];
  const add = (id: GsapPluginId) => {
    if (!order.includes(id)) order.push(id);
  };
  for (const step of animations) {
    const preset = getGsapMotionPreset(step.preset);
    if (!preset) continue;
    for (const plugin of preset.plugins) add(plugin);
  }
  return order;
}

/**
 * Compile the site config into a runtime program. Entries referencing
 * unknown presets/effects/targets are dropped and reported in `issues` —
 * never silently executed.
 */
export function compileMotionProgram(config: SiteConfig): { program: MotionProgram | null; issues: MotionIssue[] } {
  const issues: MotionIssue[] = [];
  const sectionIds = new Set<string>(config.pages.flatMap((page) => page.sections.map((s) => s.id)));
  const heroSectionIds = new Set(
    config.pages.flatMap((page) => page.sections).filter((s) => s.type.startsWith("hero")).map((s) => s.id)
  );

  const gsapBlock = (config.motion as unknown as { gsap?: GsapMotionBlock } | undefined)?.gsap;
  let animations: MotionStep[] = [];
  let gsapEnabled = false;
  let respectReducedMotion = true;
  if (gsapBlock?.enabled) {
    gsapEnabled = true;
    respectReducedMotion = gsapBlock.respectReducedMotion;
    const validation = validateGsapMotionBlock(gsapBlock, sectionIds);
    issues.push(...validation.issues.map((i) => ({ path: `motion.gsap.${i.path}`, message: i.message })));
    for (const animation of validation.value?.animations ?? []) {
      if (!animation.enabled) continue;
      const resolved = resolveTargetSelector(
        animation.target as Parameters<typeof resolveTargetSelector>[0],
        sectionIds
      );
      if (!resolved.selector) {
        if (resolved.issue) issues.push({ path: `motion.gsap.animations.${animation.id}.target`, message: resolved.issue });
        continue;
      }
      const preset = getGsapMotionPreset(animation.preset);
      if (!preset) continue;
      animations.push({
        id: animation.id,
        preset: animation.preset,
        selector: resolved.selector,
        trigger: {
          type: animation.trigger.type,
          start: animation.trigger.start ?? (preset.trigger === "scroll" ? "top 85%" : "top bottom"),
          end: animation.trigger.end ?? "+=100%",
          once: animation.trigger.once,
        },
        options: (animation.options ?? {}) as Record<string, unknown>,
        responsive: animation.responsive,
        reducedMotion: animation.reducedMotion,
      });
    }
  }

  let vanta: VantaProgram | null = null;
  const bg = config.backgroundEffects;
  if (bg?.enabled) {
    const validation = validateBackgroundEffects(bg, sectionIds);
    issues.push(...validation.issues.map((i) => ({ path: `backgroundEffects.${i.path}`, message: i.message })));
    const effect = getVantaEffect(bg.effect);
    if (effect && validation.value) {
      let selector = ".bs-bg-host";
      if (bg.target.kind === "hero") {
        const heroSection = config.pages
          .flatMap((p) => p.sections)
          .find((s) => s.type.startsWith("hero"));
        selector = heroSection ? `[data-gz-section="${heroSection.id}"]` : ".bs-bg-host";
      } else if (bg.target.kind === "section" && bg.target.sectionId && sectionIds.has(bg.target.sectionId)) {
        selector = `[data-gz-section="${bg.target.sectionId}"]`;
      }
      vanta = {
        effect: effect.id,
        distFile: effect.distFile,
        selector,
        settings: (bg.settings ?? {}) as Record<string, unknown>,
        responsive: bg.responsive,
        respectReducedMotion: bg.accessibility.respectReducedMotion,
        fallback: bg.fallback,
        textureUrl: effect.requiresTexture ? `./${NOISE_TEXTURE_PATH}` : null,
      };
    }
  }

  // Structured 3D scenes (GZ3) — compiled from the site config's scene3d block.
  const scene3dBlock = (config as unknown as { scene3d?: import("./scene3d").Scene3dBlock }).scene3d;
  const scene3dCompiled = compileScene3dBlock(scene3dBlock, sectionIds, heroSectionIds);
  issues.push(...scene3dCompiled.issues.map((i) => ({ path: i.path, message: i.message })));
  const scene3dScenes = scene3dCompiled.scenes;

  if (!gsapEnabled && !vanta && scene3dScenes.length === 0) return { program: null, issues };
  const hasGsapContent = gsapEnabled && animations.length > 0;
  if (!hasGsapContent && !vanta && scene3dScenes.length === 0) return { program: null, issues };
  return {
    program: {
      gsapEnabled: hasGsapContent,
      respectReducedMotion,
      animations,
      plugins: pluginsForAnimations(animations),
      vanta,
      scene3d: scene3dScenes,
    },
    issues,
  };
}

/** Script tags (deferred, local-only) injected into every generated page head. */
export function motionScriptTags(program: MotionProgram | null): string[] {
  if (!program) return [];
  const tags: string[] = [];
  const threeTagged = new Set<string>();
  if (program.gsapEnabled) {
    for (const plugin of program.plugins) {
      const spec = GSAP_PLUGIN_CATALOG[plugin];
      tags.push(`<script src="./${VENDOR_DIR}/${spec.fileName}" defer></script>`);
    }
  }
  if (program.vanta) {
    tags.push(`<script src="./${VENDOR_DIR}/${THREE_VENDOR.fileName}" defer></script>`);
    threeTagged.add(THREE_VENDOR.fileName);
    const effect = getVantaEffect(program.vanta.effect);
    if (effect) tags.push(`<script src="./${VENDOR_DIR}/${effect.distFile}" defer></script>`);
  }
  if (program.scene3d.length > 0 && !threeTagged.has(THREE_VENDOR.fileName)) {
    tags.push(`<script src="./${VENDOR_DIR}/${THREE_VENDOR.fileName}" defer></script>`);
    threeTagged.add(THREE_VENDOR.fileName);
  }
  if ((program.gsapEnabled || program.vanta) && tags.length) {
    tags.push(`<script src="./${MOTION_RUNTIME_PATH}" defer></script>`);
  }
  if (program.scene3d.length > 0) tags.push(`<script src="./${SCENE3D_RUNTIME_PATH}" defer></script>`);
  return tags;
}

/** Server-generated noise texture path (see lib/site-export.ts). */
export function vendorSpecsIncludingTexture(program: MotionProgram | null): VendorFileSpec[] {
  const specs = vendorFileSpecs(program);
  if (program?.vanta?.textureUrl) {
    specs.push({ path: NOISE_TEXTURE_PATH, pkgPath: "(generated)", encoding: "utf8", approxBytes: 65536 });
  }
  return specs;
}

// ---------------------------------------------------------------- runtime generator

/**
 * Build the generated `assets/motion.js` — a fixed, audited interpreter plus
 * the sanitized program embedded as JSON. The interpreter never evals, never
 * fetches, and always leaves content visible when motion cannot run.
 */
export function buildMotionRuntime(program: MotionProgram): string {
  const configJson = JSON.stringify({
    respectReducedMotion: program.respectReducedMotion,
    animations: program.animations,
    vanta: program.vanta,
  }).replace(/</g, "\\u003c");

  return `/* GIFTZ Motion Engine runtime — generated file (interpreter v1).
 * Fixed audited interpreter; the motion program below is sanitized,
 * registry-validated data. No eval, no network, no CDN. Content stays
 * visible when JS is disabled, GSAP fails to load, or the visitor prefers
 * reduced motion (?motion=static forces the static preview).
 */
(function () {
  "use strict";
  var CFG = ${configJson};
  var VENDOR = "./${VENDOR_DIR}/";
  var anims = CFG.animations || [];
  var vantaCfg = CFG.vanta || null;
  var ctx = null;
  var vantaEffect = null;
  var cleanups = [];

  function qs(sel, root) {
    try { return (root || document).querySelector(sel); }
    catch (e) { return null; }
  }
  function qsa(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    catch (e) { return []; }
  }
  function num(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }
  function str(v, d) { return typeof v === "string" && v.length ? v : d; }
  function bool(v, d) { return typeof v === "boolean" ? v : d; }

  var params = new URLSearchParams(window.location.search);
  var forced = params.get("motion");
  var osReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var reduced = (CFG.respectReducedMotion !== false) && (osReduced || forced === "static");
  if (forced === "on") reduced = false;

  function applyStaticFallback() {
    if (vantaCfg && vantaCfg.fallback && vantaCfg.fallback.value) {
      var host = qsa(vantaCfg.selector)[0];
      if (host) {
        host.style.background = vantaCfg.fallback.kind === "gradient"
          ? "linear-gradient(135deg, " + vantaCfg.fallback.value + ", rgba(0,0,0,0))"
          : vantaCfg.fallback.value;
      }
    }
  }

  // ------------------------------------------------ Vanta background engine
  function hexToInt(hex) {
    if (typeof hex !== "string") return hex;
    var m = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (m) return parseInt(m[1], 16);
    var m3 = /^#([0-9a-fA-F]{3})$/.exec(hex);
    if (m3) return parseInt(m3[1][0] + m3[1][0] + m3[1][1] + m3[1][1] + m3[1][2] + m3[1][2], 16);
    return hex;
  }

  function initVanta() {
    if (!vantaCfg || !window.VANTA || !window.VANTA[vantaCfg.effect]) {
      if (vantaCfg) console.warn("[GIFTZ] Vanta effect unavailable — static fallback applied.");
      applyStaticFallback();
      return;
    }
    if (vantaCfg.respectReducedMotion !== false && reduced) { applyStaticFallback(); return; }
    var host = qsa(vantaCfg.selector)[0];
    if (!host) { applyStaticFallback(); return; }
    var hasWebGL = false;
    try { hasWebGL = !!(document.createElement("canvas").getContext && (document.createElement("canvas").getContext("webgl") || document.createElement("canvas").getContext("experimental-webgl"))); } catch (e) { hasWebGL = false; }
    if (!hasWebGL) { applyStaticFallback(); return; }
    var settings = vantaCfg.settings || {};
    var opts = {};
    for (var key in settings) {
      var value = settings[key];
      if (/Color/i.test(key) && typeof value === "string") value = hexToInt(value);
      opts[key] = value;
    }
    opts.el = host;
    opts.THREE = window.THREE || undefined;
    if (vantaCfg.textureUrl) opts.texturePath = vantaCfg.textureUrl;
    if (vantaCfg.responsive && vantaCfg.responsive.mobile === "reduced" && window.innerWidth < 768) {
      if (num(opts.scaleMobile, 0) === 0) opts.scaleMobile = 1.2;
      if (typeof opts.speed === "number") opts.speed = opts.speed * 0.5;
    }
    try {
      // Vanta's register() exposes FACTORY functions (arrow wrappers around
      // the EffectClass constructor) — call them, never 'new' them.
      vantaEffect = window.VANTA[vantaCfg.effect](opts);
      cleanups.push(function () { try { if (vantaEffect) vantaEffect.destroy(); } catch (e) {} });
    } catch (e) {
      console.warn("[GIFTZ] Vanta init failed — static fallback applied.", e);
      applyStaticFallback();
    }
  }

  // ------------------------------------------------ GSAP motion interpreter
  function stVars(step, extra) {
    var vars = extra || {};
    if (step.trigger && step.trigger.type === "scroll" && window.ScrollTrigger) {
      vars.scrollTrigger = {
        trigger: step.triggerHost || qs(step.selector) || document.body,
        start: step.trigger.start || "top 85%",
        end: step.trigger.end || "+=100%",
        once: bool(step.trigger.once, true),
        scroller: window.__gzScroller || window,
      };
    }
    return vars;
  }

  function ease(step, def) {
    var e = str(step.options && step.options.easing, def);
    return e === "none" ? "none" : e;
  }

  function dur(step, def) { return num(step.options && step.options.duration, def) / 1000; }
  function del(step, def) { return num(step.options && step.options.delay, def) / 1000; }
  function stag(step, def) { return num(step.options && step.options.stagger, def) / 1000; }

  function initGsap() {
    var gsap = window.gsap;
    var registered = [];
    [["ScrollTrigger", window.ScrollTrigger], ["SplitText", window.SplitText], ["ScrambleTextPlugin", window.ScrambleTextPlugin],
     ["MotionPathPlugin", window.MotionPathPlugin], ["MorphSVGPlugin", window.MorphSVGPlugin], ["Flip", window.Flip],
     ["CustomEase", window.CustomEase], ["Draggable", window.Draggable], ["Observer", window.Observer],
     ["DrawSVGPlugin", window.DrawSVGPlugin]].forEach(function (pair) {
      if (pair[1] && gsap.registerPlugin) { gsap.registerPlugin(pair[1]); registered.push(pair[0]); }
    });
    if (window.ScrollTrigger) window.ScrollTrigger.config({ limitCallbacks: true, ignoreMobileResize: true });

    ctx = gsap.context(function () {
      var usedEases = {};
      // Register custom eases first so later steps can reference them.
      anims.forEach(function (step) {
        if (step.preset !== "custom-ease" || !window.CustomEase) return;
        try {
          var name = str(step.options.name, "");
          if (name && /^gz-[a-z0-9-]+$/.test(name)) {
            CustomEase.create(name, str(step.options.path, "M0,0 C0.2,0 0.3,1 1,1"));
            usedEases[name] = true;
          }
        } catch (e) { console.warn("[GIFTZ] custom-ease rejected:", e); }
      });
      function easeOf(step, def) {
        var e = ease(step, def);
        return usedEases[e] ? e : e;
      }

      var inited = new Map();
      function once(el, fn) {
        if (!el) return;
        var key = el;
        if (inited.get(key)) return;
        inited.set(key, true);
        fn(el);
      }

      anims.forEach(function (step) {
        var opts = step.options || {};
        var targets = qsa(step.selector);
        if (!targets.length) return;
        // Duplicate-initialization guard — one animation per element+preset.
        targets = targets.filter(function (el) {
          var flag = "gz" + step.id;
          if (el[flag]) return false;
          el[flag] = true;
          return true;
        });
        if (!targets.length) return;
        var mobileOff = step.responsive && step.responsive.mobile === "off" && window.innerWidth < 768;
        var mobileReduced = step.responsive && step.responsive.mobile === "reduced" && window.innerWidth < 768;
        if (mobileOff) return;
        if (mobileReduced) { gsap.set(targets, { clearProps: "all" }); return; }
        step.triggerHost = targets[0].closest("[data-gz-section]") || targets[0];
        var d = dur(step, 800), dl = del(step, 0), e = easeOf(step, "power2.out"), sg = stag(step, 0);

        switch (step.preset) {
          case "fade-in": targets.forEach(function (el) { once(el, function () { gsap.from(el, stVars(step, { opacity: 0, duration: d, delay: dl, ease: e })); }); }); break;
          case "fade-up": targets.forEach(function (el) { once(el, function () { gsap.from(el, stVars(step, { opacity: 0, y: num(opts.distance, 28), duration: d, delay: dl, ease: e })); }); }); break;
          case "fade-down": targets.forEach(function (el) { once(el, function () { gsap.from(el, stVars(step, { opacity: 0, y: -num(opts.distance, 28), duration: d, delay: dl, ease: e })); }); }); break;
          case "slide-left": targets.forEach(function (el) { once(el, function () { gsap.from(el, stVars(step, { opacity: 0, x: num(opts.distance, 40), duration: d, delay: dl, ease: e })); }); }); break;
          case "slide-right": targets.forEach(function (el) { once(el, function () { gsap.from(el, stVars(step, { opacity: 0, x: -num(opts.distance, 40), duration: d, delay: dl, ease: e })); }); }); break;
          case "scale-in": targets.forEach(function (el) { once(el, function () { gsap.from(el, stVars(step, { opacity: 0, scale: 0.94, duration: d, delay: dl, ease: e })); }); }); break;
          case "blur-reveal": targets.forEach(function (el) { once(el, function () { gsap.from(el, stVars(step, { opacity: 0, filter: "blur(" + num(opts.blur, 10) + "px)", scale: 0.985, duration: d, delay: dl, ease: e })); }); }); break;
          case "clip-reveal": targets.forEach(function (el) { once(el, function () { gsap.from(el, stVars(step, { clipPath: "inset(0 100% 0 0)", duration: d, delay: dl, ease: e })); }); }); break;
          case "stagger-entrance": {
            var children = targets[0].children;
            if (children && children.length) gsap.from(children, stVars(step, { opacity: 0, y: num(opts.distance, 24), duration: d, delay: dl, ease: e, stagger: sg || 0.08 }));
            break;
          }
          case "word-reveal": case "char-reveal": case "line-reveal": case "split-clip": {
            if (!window.SplitText) return;
            targets.forEach(function (el) {
              once(el, function () {
                var by = str(opts.splitBy, step.preset === "char-reveal" ? "chars" : step.preset === "line-reveal" || step.preset === "split-clip" ? "lines" : "words");
                var split = new SplitText(el, { type: by === "chars" ? "chars,words" : by, aria: "auto" });
                var unit = by === "chars" ? split.chars : by === "lines" ? split.lines : split.words;
                if (!unit || !unit.length) return;
                if (step.preset === "split-clip") {
                  gsap.from(unit, stVars(step, { yPercent: 110, duration: d, delay: dl, ease: e, stagger: sg || 0.08 }));
                } else {
                  gsap.from(unit, stVars(step, { opacity: 0, yPercent: 30, duration: d, delay: dl, ease: e, stagger: sg }));
                }
              });
            });
            break;
          }
          case "scramble-text": {
            if (!window.ScrambleTextPlugin) return;
            targets.forEach(function (el) {
              once(el, function () {
                var original = el.textContent || "";
                gsap.to(el, stVars(step, { duration: d, delay: dl, scrambleText: { text: original, chars: str(opts.chars, "upperCase"), speed: 1 } }));
              });
            });
            break;
          }
          case "gradient-text": {
            targets.forEach(function (el) {
              once(el, function () {
                el.style.backgroundImage = el.style.backgroundImage || "linear-gradient(90deg, currentColor 40%, rgba(255,255,255,0) 50%, currentColor 60%)";
                el.style.webkitBackgroundClip = "text";
                el.style.backgroundClip = "text";
                el.style.webkitTextFillColor = "transparent";
                gsap.fromTo(el, { backgroundPosition: "120% 0" }, Object.assign(stVars(step, { duration: d, delay: dl, ease: e }), { backgroundPosition: "-40% 0" }));
              });
            });
            break;
          }
          case "rotating-headline": {
            var words = Array.isArray(opts.words) ? opts.words.filter(function (w) { return typeof w === "string"; }).slice(0, 8) : [];
            if (words.length < 2) return;
            var el = targets[0];
            once(el, function () {
              var interval = num(opts.interval, 3000);
              var holder = document.createElement("span");
              holder.setAttribute("aria-hidden", "true");
              holder.style.display = "inline-block";
              var sr = document.createElement("span");
              sr.className = "sr-only";
              sr.textContent = el.textContent + " " + words.join(" ");
              el.textContent = "";
              el.appendChild(sr);
              el.appendChild(holder);
              var tl = gsap.timeline({ repeat: -1, delay: dl });
              holder.textContent = words[0];
              words.slice(1).concat(words[0]).forEach(function (word) {
                tl.to(holder, { opacity: 0, y: -12, duration: d / 2, ease: e })
                  .add(function () { holder.textContent = word; })
                  .fromTo(holder, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: d / 2, ease: e })
                  .add("+=" + interval / 1000);
              });
            });
            break;
          }
          case "typewriter": {
            targets.forEach(function (el) {
              once(el, function () {
                var full = el.textContent || "";
                var sr = document.createElement("span");
                sr.className = "sr-only";
                sr.textContent = full;
                var visible = document.createElement("span");
                visible.setAttribute("aria-hidden", "true");
                el.textContent = "";
                el.appendChild(sr);
                el.appendChild(visible);
                var speed = num(opts.speed, 40);
                var stepMs = Math.max(16, Math.round(1000 / speed));
                var i = 0;
                var timer = window.setInterval(function () {
                  i++;
                  visible.textContent = full.slice(0, i);
                  if (i >= full.length) window.clearInterval(timer);
                }, stepMs);
                cleanups.push(function () { window.clearInterval(timer); });
              });
            });
            break;
          }
          case "scroll-reveal": {
            targets.forEach(function (el) {
              once(el, function () {
                gsap.from(el, stVars(step, { opacity: 0, y: num(opts.distance, 32), duration: d, delay: dl, ease: e }));
              });
            });
            break;
          }
          case "stagger-cards": {
            var grid = targets[0];
            once(grid, function () {
              var kids = grid.classList.contains("bs-stagger") ? grid.querySelectorAll(".bs-sh") : grid.children;
              if (kids && kids.length) gsap.from(kids, stVars(step, { opacity: 0, y: num(opts.distance, 28), duration: d, delay: dl, ease: e, stagger: sg || 0.08 }));
            });
            break;
          }
          case "parallax-image": {
            if (!window.ScrollTrigger) return;
            targets.forEach(function (el) {
              once(el, function () {
                gsap.fromTo(el, { yPercent: -num(opts.amount, 24) }, { yPercent: num(opts.amount, 24), ease: "none",
                  scrollTrigger: { trigger: step.triggerHost || el, start: "top bottom", end: "bottom top", scrub: true, scroller: window.__gzScroller || window } });
              });
            });
            break;
          }
          case "pinned-section": {
            if (!window.ScrollTrigger) return;
            var host = targets[0];
            once(host, function () {
              gsap.to(host, { ease: "none",
                scrollTrigger: { trigger: host, start: "top top", end: str(opts.end, "+=120%"), pin: true, scrub: bool(opts.scrub, true), scroller: window.__gzScroller || window } });
            });
            break;
          }
          case "horizontal-story": {
            if (!window.ScrollTrigger) return;
            var wrap = targets[0];
            once(wrap, function () {
              var inner = wrap.firstElementChild;
              if (!inner) return;
              var distance = Math.max(0, inner.scrollWidth - wrap.clientWidth);
              if (!distance) return;
              gsap.to(inner, { x: -distance, ease: "none",
                scrollTrigger: { trigger: wrap, start: "top top", end: str(opts.end, "+=" + Math.round(distance / 2) + "px"), pin: true, scrub: true, invalidateOnRefresh: true, scroller: window.__gzScroller || window } });
            });
            break;
          }
          case "scroll-progress": {
            if (!window.ScrollTrigger) return;
            var bar = targets[0];
            once(bar, function () {
              gsap.fromTo(bar, { scaleX: (str(opts.origin, "left") === "right" ? 1 : 0) }, { scaleX: str(opts.origin, "left") === "right" ? 0 : 1, ease: "none",
                scrollTrigger: { trigger: document.body, start: "top top", end: "bottom bottom", scrub: 0.4, scroller: window.__gzScroller || window } });
            });
            break;
          }
          case "svg-draw": {
            if (!window.DrawSVGPlugin) return;
            var svgs = [];
            targets.forEach(function (el) {
              if (el.tagName === "svg") svgs.push(el);
              else svgs.push.apply(svgs, el.querySelectorAll("svg path, svg line, svg circle, svg polyline"));
            });
            if (!svgs.length) return;
            gsap.from(svgs, stVars(step, { drawSVG: "0%", duration: d, delay: dl, ease: e, stagger: sg || 0.1 }));
            break;
          }
          case "number-counter": {
            targets.forEach(function (el) {
              once(el, function () {
                var end = num(opts.end, parseFloat((el.textContent || "").replace(/[^0-9.\\-]/g, "")));
                if (!isFinite(end)) return;
                var decimals = num(opts.decimals, 0);
                var counter = { value: 0 };
                gsap.to(counter, stVars(step, { value: end, duration: d, delay: dl, ease: e, onUpdate: function () {
                  el.textContent = str(opts.prefix, "") + counter.value.toFixed(decimals) + str(opts.suffix, "");
                } }));
              });
            });
            break;
          }
          case "hover-lift": {
            targets.forEach(function (el) {
              once(el, function () {
                var lift = -num(opts.lift, 8), scale = num(opts.scale, 1.03);
                el.addEventListener("mouseenter", function () { gsap.to(el, { y: lift, scale: scale, duration: d, ease: e }); });
                el.addEventListener("mouseleave", function () { gsap.to(el, { y: 0, scale: 1, duration: d, ease: e }); });
              });
            });
            break;
          }
          case "magnetic-button": {
            targets.forEach(function (el) {
              once(el, function () {
                var strength = num(opts.strength, 0.3);
                var move = function (ev) {
                  var rect = el.getBoundingClientRect();
                  gsap.to(el, { x: (ev.clientX - rect.left - rect.width / 2) * strength, y: (ev.clientY - rect.top - rect.height / 2) * strength, duration: d, ease: e });
                };
                var reset = function () { gsap.to(el, { x: 0, y: 0, duration: d * 1.4, ease: "elastic.out(1, 0.4)" }); };
                el.addEventListener("mousemove", move);
                el.addEventListener("mouseleave", reset);
              });
            });
            break;
          }
          case "card-tilt": {
            targets.forEach(function (el) {
              once(el, function () {
                var max = num(opts.max, 8), scale = num(opts.scale, 1.02), persp = num(opts.perspective, 900);
                el.style.transformStyle = "preserve-3d";
                el.addEventListener("mousemove", function (ev) {
                  var rect = el.getBoundingClientRect();
                  var px = (ev.clientX - rect.left) / rect.width - 0.5;
                  var py = (ev.clientY - rect.top) / rect.height - 0.5;
                  gsap.to(el, { rotateY: px * max * 2, rotateX: -py * max * 2, scale: scale, transformPerspective: persp, duration: d, ease: e });
                });
                el.addEventListener("mouseleave", function () { gsap.to(el, { rotateX: 0, rotateY: 0, scale: 1, duration: d * 1.6, ease: "power2.out" }); });
              });
            });
            break;
          }
          case "tab-transition": {
            if (!window.Flip) return;
            var buttonsSel = str(opts.buttons, ""), panelsSel = str(opts.panels, "");
            if (!buttonsSel || !panelsSel) return;
            var activeClass = str(opts.activeClass, "is-active");
            once(targets[0], function () {
              var buttons = qsa(buttonsSel), panels = qsa(panelsSel);
              if (!buttons.length || !panels.length) return;
              buttons.forEach(function (btn, index) {
                btn.addEventListener("click", function () {
                  var state = Flip.getState(panels);
                  panels.forEach(function (panel, pi) {
                    var show = pi === index;
                    panel.classList.toggle("gz-hidden-panel", !show);
                    panel.style.display = show ? "" : "none";
                  });
                  buttons.forEach(function (b, bi) { b.classList.toggle(activeClass, bi === index); });
                  Flip.from(state, { duration: d, ease: e, absolute: true });
                });
              });
            });
            break;
          }
          case "nav-transition": {
            targets.forEach(function (el) {
              once(el, function () {
                var style = str(opts.style, "underline");
                el.addEventListener("mouseenter", function () {
                  if (style === "fade") gsap.fromTo(el, { opacity: 0.75 }, { opacity: 1, duration: d, ease: e });
                  else if (style === "slide") gsap.fromTo(el, { x: -4 }, { x: 0, duration: d, ease: e });
                  else gsap.fromTo(el, { backgroundImage: "linear-gradient(currentColor, currentColor)", backgroundSize: "0% 1px", backgroundRepeat: "no-repeat", backgroundPosition: "left bottom" }, { backgroundSize: "100% 1px", duration: d, ease: e });
                });
              });
            });
            break;
          }
          case "gallery-flip": {
            if (!window.Flip) return;
            targets.forEach(function (el) {
              once(el, function () {
                var scaleTo = num(opts.scale, 1.08);
                var expanded = false;
                el.addEventListener("click", function () {
                  var state = Flip.getState(el);
                  expanded = !expanded;
                  el.style.zIndex = expanded ? "30" : "";
                  gsap.set(el, { scale: expanded ? scaleTo : 1 });
                  Flip.from(state, { duration: d, ease: e, scale: true });
                });
              });
            });
            break;
          }
          case "accordion-motion": {
            targets.forEach(function (host) {
              once(host, function () {
                var details = host.tagName === "DETAILS" ? [host] : host.querySelectorAll("details");
                Array.prototype.forEach.call(details, function (item) {
                  item.addEventListener("toggle", function () {
                    var body = item.querySelector("p, ul, div");
                    if (!body) return;
                    if (item.open) gsap.from(body, { opacity: 0, height: 0, duration: d, ease: e, clearProps: "height" });
                  });
                });
              });
            });
            break;
          }
          case "modal-transition": {
            var triggerSel = str(opts.trigger, ""), targetSel = str(opts.target, "");
            if (!triggerSel || !targetSel) return;
            once(targets[0], function () {
              var trigger = qs(triggerSel), panel = qs(targetSel);
              if (!trigger || !panel) return;
              var open = false;
              var animate = str(opts.animation, "fade");
              trigger.addEventListener("click", function () {
                open = !open;
                if (open) {
                  panel.style.display = "";
                  if (animate === "flip" && window.Flip) { var st = Flip.getState(panel); gsap.set(panel, { opacity: 1, scale: 1 }); Flip.from(st, { duration: d, ease: e }); }
                  else if (animate === "scale") gsap.from(panel, { opacity: 0, scale: 0.92, duration: d, ease: e });
                  else gsap.from(panel, { opacity: 0, y: 12, duration: d, ease: e });
                } else {
                  gsap.to(panel, { opacity: 0, duration: d / 2, ease: e, onComplete: function () { panel.style.display = "none"; gsap.set(panel, { opacity: 1 }); } });
                }
              });
            });
            break;
          }
          case "motion-path": {
            if (!window.MotionPathPlugin) return;
            var pathPoints = Array.isArray(opts.points) ? opts.points : null;
            var pathSel = str(opts.pathSelector, "");
            targets.forEach(function (el) {
              once(el, function () {
                var motionVars = { duration: d, delay: dl, ease: e, motionPath: pathPoints
                  ? { path: pathPoints, curviness: 1.2 }
                  : { path: pathSel, align: pathSel, alignOrigin: [0.5, 0.5], autoRotate: bool(opts.autoRotate, false) } };
                var tween = gsap.to(el, motionVars);
                if (bool(opts.loop, false) && tween) tween.repeat(-1).yoyo(true);
              });
            });
            break;
          }
          case "svg-morph": {
            if (!window.MorphSVGPlugin) return;
            var fromSel = str(opts.from, ""), toSel = str(opts.to, "");
            if (!fromSel || !toSel) return;
            var fromPath = qs(fromSel), toPath = qs(toSel);
            if (!fromPath || !toPath) return;
            var morph = gsap.to(fromPath, { duration: d, delay: dl, ease: e, morphSVG: toPath, repeat: bool(opts.loop, false) ? -1 : 0, yoyo: bool(opts.loop, false) });
            if (morph && bool(opts.loop, false)) morph.repeat(-1).yoyo(true);
            break;
          }
          case "flip-transition": {
            if (!window.Flip) return;
            var trigSel = str(opts.trigger, ""), targSel = str(opts.target, "");
            if (!trigSel || !targSel) return;
            once(targets[0], function () {
              var trig = qs(trigSel), targ = qs(targSel);
              if (!trig || !targ) return;
              var activeClass2 = str(opts.activeClass, "is-flipped");
              trig.addEventListener("click", function () {
                var state = Flip.getState(targ);
                targ.classList.toggle(activeClass2);
                Flip.from(state, { duration: d, ease: e });
              });
            });
            break;
          }
          case "timeline-sequence": {
            var steps = Array.isArray(opts.steps) ? opts.steps : [];
            if (steps.length < 2) return;
            var host2 = targets[0];
            once(host2, function () {
              var kids = host2.children;
              if (!kids || !kids.length) return;
              var tl = gsap.timeline({ delay: dl });
              steps.forEach(function (s) {
                var idx = Math.min(kids.length - 1, Math.max(0, Math.round(num(s.at, 0) / 100)));
                var presetKind = str(s.preset, "fade-up");
                var fromVars = presetKind === "fade-in" ? { opacity: 0 } : presetKind === "slide-left" ? { opacity: 0, x: 36 } : presetKind === "slide-right" ? { opacity: 0, x: -36 } : presetKind === "scale-in" ? { opacity: 0, scale: 0.94 } : { opacity: 0, y: 28 };
                fromVars.duration = d / 2;
                fromVars.ease = e;
                tl.from(kids[idx], fromVars, num(s.at, 0) / 1000);
              });
            });
            break;
          }
          case "layered-hero": {
            var hero = targets[0];
            once(hero, function () {
              var layers = hero.querySelectorAll("h1, h2, p, .bs-cta-row, img" + (bool(opts.includeButtons, true) ? ", a" : ""));
              if (layers && layers.length) gsap.from(layers, { opacity: 0, y: num(opts.distance, 36), duration: d, delay: dl, ease: e, stagger: sg || 0.12 });
              if (bool(opts.parallax, true) && window.ScrollTrigger) {
                var cover = hero.querySelector("img.bs-parallax") || hero.querySelector("img");
                if (cover) gsap.to(cover, { yPercent: 12, ease: "none",
                  scrollTrigger: { trigger: hero, start: "top top", end: "bottom top", scrub: true, scroller: window.__gzScroller || window } });
              }
            });
            break;
          }
        }
      });
    });
  }

  // ------------------------------------------------ lifecycle
  function cleanup() {
    cleanups.forEach(function (fn) { try { fn(); } catch (e) {} });
    cleanups = [];
    try { if (ctx) ctx.revert(); } catch (e) {}
    ctx = null;
  }
  window.addEventListener("pagehide", cleanup, { once: true });

  function start() {
    if (reduced) { applyStaticFallback(); return; }
    if (vantaCfg) initVanta();
    if (anims.length) {
      if (!window.gsap) { console.warn("[GIFTZ] Motion runtime: gsap unavailable — content stays fully visible."); applyStaticFallback(); return; }
      try { initGsap(); } catch (e) { console.warn("[GIFTZ] Motion runtime error — content stays fully visible.", e); }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
`;
}

// ---------------------------------------------------------------- AI capability doc

export function motionCapabilityDoc(): string {
  const ids = GSAP_MOTION_PRESET_IDS.join(", ");
  const effects = VANTA_EFFECT_IDS.join(", ");
  return `GSAP MOTION ENGINE (motion.gsap in site.config.json)
- Enable with motion.gsap.enabled=true; add entries to motion.gsap.animations.
- Each entry: { id (kebab-case), preset, target, trigger, options, responsive, reducedMotion, enabled }.
- preset ids: ${ids}.
- target: { kind: "section", sectionId: <existing section id>, element: container|heading|text|cards|images|buttons|nav|svg|stats|children } OR { kind: "selector", selector: <validated CSS selector> }.
- trigger: { type: load|scroll|interaction, start/end (scroll positions like "top 85%"), once }.
- options per preset are validated; unknown keys or values are rejected. Durations 100-6000ms.
- The runtime, vendor files (assets/vendor/*.js) and cleanup are generated automatically — NEVER hand-write gsap imports, NEVER reference CDNs, NEVER use eval.
- Prefer 3-8 well-chosen animations; more than ~12 is excessive.
VANTA BACKGROUND ENGINE (backgroundEffects in site.config.json)
- { enabled, engine: "vanta", effect, target: { kind: page|hero|section }, settings, responsive, accessibility, fallback }.
- effect ids: ${effects}.
- settings must use the effect's documented keys (hex colors like "#1a1a2e"); unknown keys are rejected.
- The three.js + effect vendor files and the init/destroy/fallback runtime are generated automatically.`;
}
