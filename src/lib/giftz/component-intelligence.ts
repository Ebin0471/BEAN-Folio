/**
 * GIFTZ Component Intelligence (M17) — the internal capability registry,
 * AI selection guidance and the design-consistency engine.
 *
 * EVERY component in this registry is an ORIGINAL GIFTZ implementation:
 * rendered by the deterministic exporter from the SiteConfig content model,
 * animated through the GIFTZ motion engine (CSS presets, GSAP or Vanta) and
 * styled exclusively through the site's own theme tokens.
 *
 * React Bits (github.com/DavidHDev/react-bits) is used strictly as a DESIGN
 * AND TECHNICAL REFERENCE for interaction patterns — its catalogue is
 * MIT + Commons Clause and is NEVER copied, bundled, redistributed or
 * exposed here. See docs/GIFTZ_REACT_BITS_LICENSE_REVIEW.md for the full
 * licensing position and the independent-implementation decisions.
 */

import { z } from "zod";
import type { SiteConfig, SiteTheme } from "@/lib/site-config";
import { GSAP_MOTION_PRESET_IDS, VANTA_EFFECT_IDS } from "@/lib/giftz/motion-engine";

// ---------------------------------------------------------------- registry

export type ComponentCategoryId =
  | "typography"
  | "interactive"
  | "galleries"
  | "backgrounds"
  | "layout"
  | "micro-interactions";

export interface ComponentRegistryEntry {
  /** Stable capability id (kebab-case). */
  id: string;
  name: string;
  category: ComponentCategoryId;
  description: string;
  /** What renders it — generated sites are static HTML/CSS/JS. */
  framework: "static-html" | "react-rendered";
  /** Styling approach — always the site's own token system. */
  styling: "theme-tokens";
  /** Extra npm dependencies the generated site needs (kept minimal). */
  requiredDependencies: readonly string[];
  /** Animation engine the component leans on. */
  animationEngine: "none" | "css" | "gsap" | "vanta";
  /** The concrete capability it maps to in the platform (preset ids, sections, motion tokens). */
  implementation: string;
  propsSchema: z.ZodType;
  responsive: true;
  accessibility: string;
  performance: "light" | "moderate" | "heavy";
  /** Provenance — every entry here is original work. */
  origin: "original";
  license: "GIFTZ original (no third-party source)";
  version: string;
  compatible: true;
}

const perf = z.enum(["light", "moderate", "heavy"]).default("light");
const trueBool = z.boolean().default(true);

function entry(def: Omit<ComponentRegistryEntry, "origin" | "license" | "compatible" | "version">): ComponentRegistryEntry {
  return { ...def, origin: "original", license: "GIFTZ original (no third-party source)", version: "1.0.0", compatible: true };
}

export const COMPONENT_REGISTRY: readonly ComponentRegistryEntry[] = [
  // ---- A. Typography
  entry({ id: "split-word-reveal", name: "Split word reveal", category: "typography", description: "Headline split into words, revealed in reading order.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap", "gsap/SplitText"], animationEngine: "gsap", implementation: "gsap preset word-reveal (heading targets)", propsSchema: z.object({ stagger: z.number().min(0).max(600).optional(), duration: z.number().min(100).max(6000).optional() }).strict(), responsive: true, accessibility: "SplitText aria:auto keeps a screen-reader copy of the full text", performance: "light" }),
  entry({ id: "character-reveal", name: "Character cascade", category: "typography", description: "Per-character headline cascade for short display text.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap", "gsap/SplitText"], animationEngine: "gsap", implementation: "gsap preset char-reveal", propsSchema: z.object({ stagger: z.number().min(0).max(200).optional() }).strict(), responsive: true, accessibility: "aria-hidden split units + sr-only original text", performance: "moderate" }),
  entry({ id: "line-mask-reveal", name: "Line mask reveal", category: "typography", description: "Editorial line-by-line masked headline entrance.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap", "gsap/SplitText"], animationEngine: "gsap", implementation: "gsap presets line-reveal / split-clip", propsSchema: z.object({ splitBy: z.enum(["words", "chars", "lines"]).optional() }).strict(), responsive: true, accessibility: "sr-only original text preserved", performance: "light" }),
  entry({ id: "typewriter", name: "Typewriter", category: "typography", description: "Terminal-style progressive text typing (looping optional).", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap"], animationEngine: "gsap", implementation: "gsap preset typewriter", propsSchema: z.object({ speed: z.number().min(10).max(200).optional(), loop: z.boolean().optional() }).strict(), responsive: true, accessibility: "sr-only full text is always present", performance: "light" }),
  entry({ id: "rotating-headline", name: "Rotating headline", category: "typography", description: "Headline cycles through 2-8 words in place.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap"], animationEngine: "gsap", implementation: "gsap preset rotating-headline", propsSchema: z.object({ words: z.array(z.string().min(1).max(60)).min(2).max(8), interval: z.number().min(1200).max(10000).optional() }).strict(), responsive: true, accessibility: "sr-only concatenation announces every word", performance: "light" }),
  entry({ id: "scramble-text", name: "Scramble text", category: "typography", description: "Decode-style text scramble on reveal.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap", "gsap/ScrambleTextPlugin"], animationEngine: "gsap", implementation: "gsap preset scramble-text", propsSchema: z.object({ chars: z.string().max(40).optional() }).strict(), responsive: true, accessibility: "Static fallback under reduced motion; final text always lands", performance: "light" }),
  entry({ id: "gradient-headline", name: "Gradient text reveal", category: "typography", description: "Background-clip gradient sweep across the headline.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap"], animationEngine: "gsap", implementation: "gsap preset gradient-text", propsSchema: z.object({}).strict(), responsive: true, accessibility: "Text remains selectable and readable (fill-color fallback)", performance: "light" }),
  entry({ id: "blur-reveal", name: "Blur reveal", category: "typography", description: "Headline sharpens from a soft blur.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap"], animationEngine: "gsap", implementation: "gsap preset blur-reveal", propsSchema: z.object({ blur: z.number().min(0).max(24).optional() }).strict(), responsive: true, accessibility: "Reduced motion renders fully sharp", performance: "light" }),

  // ---- B. Interactive
  entry({ id: "hover-lift-card", name: "Hover lift", category: "interactive", description: "Cards/buttons rise + scale on hover.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap"], animationEngine: "gsap", implementation: "gsap preset hover-lift (also available as CSS micro-interaction hover-lift)", propsSchema: z.object({ lift: z.number().min(2).max(24).optional(), scale: z.number().min(1).max(1.2).optional() }).strict(), responsive: true, accessibility: "Desktop pointer devices only; keyboard focus untouched", performance: "light" }),
  entry({ id: "magnetic-button", name: "Magnetic button", category: "interactive", description: "Cursor-attracted button with elastic spring-back.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap"], animationEngine: "gsap", implementation: "gsap preset magnetic-button", propsSchema: z.object({ strength: z.number().min(0.05).max(0.8).optional() }).strict(), responsive: true, accessibility: "Pointer-only decoration; the button itself never moves from its hit target's keyboard position", performance: "light" }),
  entry({ id: "card-tilt", name: "3D card tilt", category: "interactive", description: "Perspective tilt following the cursor.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap"], animationEngine: "gsap", implementation: "gsap preset card-tilt", propsSchema: z.object({ max: z.number().min(2).max(15).optional(), scale: z.number().min(1).max(1.08).optional() }).strict(), responsive: true, accessibility: "Touch/mobile off; reduced motion disables it", performance: "moderate" }),
  entry({ id: "animated-tabs", name: "Animated tabs", category: "interactive", description: "FLIP-animated panel swap between tab buttons.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap", "gsap/Flip"], animationEngine: "gsap", implementation: "gsap preset tab-transition (buttons/panels selectors)", propsSchema: z.object({ buttons: z.string().min(1).max(200), panels: z.string().min(1).max(200) }).strict(), responsive: true, accessibility: "Panels toggle display; keyboard click works via native buttons", performance: "light" }),
  entry({ id: "nav-hover-motion", name: "Navigation hover motion", category: "interactive", description: "Underline/fade/slide treatments for nav links.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap"], animationEngine: "gsap", implementation: "gsap preset nav-transition", propsSchema: z.object({ style: z.enum(["underline", "fade", "slide"]).optional() }).strict(), responsive: true, accessibility: "Purely decorative; links stay focus-visible", performance: "light" }),
  entry({ id: "accordion-motion", name: "Accordion motion", category: "interactive", description: "Animated open/close for native <details> elements.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap"], animationEngine: "gsap", implementation: "gsap preset accordion-motion", propsSchema: z.object({}).strict(), responsive: true, accessibility: "Native details/summary semantics preserved", performance: "light" }),
  entry({ id: "modal-transition", name: "Modal transition", category: "interactive", description: "Fade/scale/FLIP entrance for an in-page panel toggled by a trigger.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap", "gsap/Flip"], animationEngine: "gsap", implementation: "gsap preset modal-transition", propsSchema: z.object({ trigger: z.string().min(1).max(200), target: z.string().min(1).max(200) }).strict(), responsive: true, accessibility: "Display toggles instantly under reduced motion", performance: "light" }),
  entry({ id: "animated-counter", name: "Animated counter", category: "interactive", description: "Numbers count up when they scroll into view.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap", "gsap/ScrollTrigger"], animationEngine: "gsap", implementation: "gsap preset number-counter (stats sections)", propsSchema: z.object({ end: z.number().optional(), decimals: z.number().int().min(0).max(2).optional(), prefix: z.string().max(8).optional(), suffix: z.string().max(8).optional() }).strict(), responsive: true, accessibility: "Final value renders immediately under reduced motion", performance: "light" }),

  // ---- C. Galleries & media
  entry({ id: "masonry-gallery", name: "Masonry gallery", category: "galleries", description: "Multi-column masonry image wall (CSS columns).", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "gallery section layout \"masonry\" + motion presets", propsSchema: z.object({ limit: z.number().int().min(1).max(24).optional() }).strict(), responsive: true, accessibility: "Semantic figure/figcaption markup", performance: "light" }),
  entry({ id: "strip-gallery", name: "Strip gallery", category: "galleries", description: "Horizontal scrolling media strip.", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "gallery section layout \"strip\"", propsSchema: z.object({}).strict(), responsive: true, accessibility: "Native horizontal scroll, keyboard reachable", performance: "light" }),
  entry({ id: "editorial-rows", name: "Editorial rows", category: "galleries", description: "Alternating media/text project rows.", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "projects section layout \"editorial\"", propsSchema: z.object({}).strict(), responsive: true, accessibility: "Real links to project detail pages", performance: "light" }),
  entry({ id: "gallery-flip", name: "Gallery FLIP transition", category: "galleries", description: "Click-to-expand media with FLIP position/size animation.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap", "gsap/Flip"], animationEngine: "gsap", implementation: "gsap preset gallery-flip", propsSchema: z.object({ scale: z.number().min(1).max(1.15).optional() }).strict(), responsive: true, accessibility: "Images stay focusable; instant toggle under reduced motion", performance: "light" }),
  entry({ id: "parallax-media", name: "Parallax media", category: "galleries", description: "Scrubbed vertical drift for hero/section imagery.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap", "gsap/ScrollTrigger"], animationEngine: "gsap", implementation: "gsap preset parallax-image (desktop only, restrained range)", propsSchema: z.object({ amount: z.number().min(-80).max(80).optional() }).strict(), responsive: true, accessibility: "Disabled on mobile + reduced motion", performance: "moderate" }),
  entry({ id: "video-reel", name: "Video reel", category: "galleries", description: "Real playable video reel (strip/grid) from owned media.", framework: "react-rendered", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "reel section (muted autoplay on the live site; poster images in exports)", propsSchema: z.object({ videos: z.array(z.object({ mediaId: z.string().max(64), caption: z.string().max(160).optional() })).max(5) }).strict(), responsive: true, accessibility: "Muted + playsinline autoplay, captions supported", performance: "moderate" }),

  // ---- D. Backgrounds
  entry({ id: "css-animated-background", name: "CSS animated background", category: "backgrounds", description: "Declarative animated background layer (aurora, grid, noise, gradient motion).", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "motion.background presets (site-motion background scope)", propsSchema: z.object({ preset: z.string().max(40) }).strict(), responsive: true, accessibility: "Reduced-motion renders a static wash", performance: "light" }),
  entry({ id: "vanta-webgl-background", name: "Vanta WebGL background", category: "backgrounds", description: "Interactive three.js background effect (fog, waves, net, globe...).", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["three", "vanta"], animationEngine: "vanta", implementation: `backgroundEffects block (effects: ${VANTA_EFFECT_IDS.join(", ")}) with static fallback`, propsSchema: z.object({ effect: z.string().min(1).max(32), settings: z.record(z.string(), z.unknown()).optional() }).strict(), responsive: true, accessibility: "prefers-reduced-motion + WebGL-failure fallback keep content readable", performance: "heavy" }),
  entry({ id: "gsap-scene-background", name: "GSAP scene background", category: "backgrounds", description: "Scripted decorative background motion (drifting shapes, drawing strokes).", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap"], animationEngine: "gsap", implementation: "gsap presets svg-draw / motion-path targeting background svg layers", propsSchema: z.object({}).strict(), responsive: true, accessibility: "Decorative only — aria-hidden layers, static under reduced motion", performance: "moderate" }),

  // ---- E. Layout
  entry({ id: "hero-classic", name: "Hero (classic/split/centered/cover)", category: "layout", description: "Four hero layouts driven by the content model.", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "hero section variants + layered-hero gsap preset", propsSchema: z.object({ variant: z.enum(["classic", "split", "centered", "cover"]).optional() }).strict(), responsive: true, accessibility: "Single h1 per page; fluid clamp() type", performance: "light" }),
  entry({ id: "bento-grid", name: "Bento feature grid", category: "layout", description: "Mixed-size feature/service tiles in a CSS grid.", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "services section layout \"cards\" with staggered entrance", propsSchema: z.object({ items: z.number().int().min(0).max(8).optional() }).strict(), responsive: true, accessibility: "Grid collapses to one column on mobile", performance: "light" }),
  entry({ id: "stats-band", name: "Statistics band", category: "layout", description: "3-up stat cards with animated counters.", framework: "static-html", styling: "theme-tokens", requiredDependencies: ["gsap", "gsap/ScrollTrigger"], animationEngine: "gsap", implementation: "stats section + number-counter preset", propsSchema: z.object({}).strict(), responsive: true, accessibility: "Final numbers always present in markup", performance: "light" }),
  entry({ id: "pricing-table", name: "Pricing section", category: "layout", description: "Tier cards with one highlighted plan.", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "pricing section (cards/rows layouts)", propsSchema: z.object({ tiers: z.number().int().min(0).max(4).optional() }).strict(), responsive: true, accessibility: "Highlighted tier announced in text, not color alone", performance: "light" }),
  entry({ id: "testimonials-wall", name: "Testimonials", category: "layout", description: "Quote cards / stacked quotes (empty until user fills them).", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "testimonials section", propsSchema: z.object({ items: z.number().int().min(0).max(8).optional() }).strict(), responsive: true, accessibility: "blockquotes with cite semantics", performance: "light" }),
  entry({ id: "timeline-section", name: "Experience timeline", category: "layout", description: "Chronological rail of roles/education.", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "experience section layout \"timeline\"", propsSchema: z.object({}).strict(), responsive: true, accessibility: "Ordered semantics preserved", performance: "light" }),
  entry({ id: "process-steps", name: "Process steps", category: "layout", description: "Numbered/steps/grid how-I-work layout.", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "process section", propsSchema: z.object({}).strict(), responsive: true, accessibility: "Ordered list semantics", performance: "light" }),
  entry({ id: "contact-band", name: "Contact band", category: "layout", description: "Availability + mailto contact close.", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "contact section (mailto links)", propsSchema: z.object({}).strict(), responsive: true, accessibility: "Real mailto: links with visible labels", performance: "light" }),

  // ---- F. Micro-interactions
  entry({ id: "css-micro-hover", name: "CSS micro-interactions", category: "micro-interactions", description: "Hover treatments for buttons/links from the micro-interaction registry.", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "motion.microInteractions presets (site-motion hover scope)", propsSchema: z.object({ preset: z.string().max(40) }).strict(), responsive: true, accessibility: "CSS-only, disabled under reduced motion", performance: "light" }),
  entry({ id: "scroll-progress-bar", name: "Scroll progress", category: "micro-interactions", description: "Thin reading-progress bar fixed to the viewport top.", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "motion.scrollProgress (vanilla) or gsap preset scroll-progress", propsSchema: z.object({}).strict(), responsive: true, accessibility: "aria-hidden decoration", performance: "light" }),
  entry({ id: "page-transition", name: "Page transition", category: "micro-interactions", description: "Fade/slide/rise/zoom transition between pages.", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "theme.pageTransition", propsSchema: z.object({}).strict(), responsive: true, accessibility: "Instant under reduced motion", performance: "light" }),
  entry({ id: "stagger-entrance-grid", name: "Staggered grid entrance", category: "micro-interactions", description: "Grid children cascade in on reveal.", framework: "static-html", styling: "theme-tokens", requiredDependencies: [], animationEngine: "css", implementation: "motion presets stagger family / gsap stagger-entrance", propsSchema: z.object({ stagger: z.number().min(0).max(600).optional() }).strict(), responsive: true, accessibility: "Content visible without JS; failsafe timeout forces visibility", performance: "light" }),
];

export const COMPONENT_REGISTRY_IDS = COMPONENT_REGISTRY.map((c) => c.id);

export function getComponent(id: string): ComponentRegistryEntry | null {
  return COMPONENT_REGISTRY.find((c) => c.id === id) ?? null;
}

export function componentsByCategory(category: ComponentCategoryId): ComponentRegistryEntry[] {
  return COMPONENT_REGISTRY.filter((c) => c.category === category);
}

// ---------------------------------------------------------------- selection engine

export interface SiteBrief {
  /** Website category, e.g. "photography-portfolio", "saas", "restaurant". */
  category: string;
  /** Visual direction keywords, e.g. ["cinematic", "luxury", "minimal"]. */
  visualDirection: string[];
  /** Section types the site needs (site-config SECTION_TYPES vocabulary). */
  sections: string[];
  /** Hard constraints from the user ("no heavy webgl", "works offline"...). */
  constraints?: string[];
}

export interface ComponentSelection {
  components: ComponentRegistryEntry[];
  /** Human-readable reasons (shown in proposals / docs). */
  reasons: string[];
}

const DIRECTION_RULES: { keywords: string[]; componentIds: string[]; reason: string }[] = [
  { keywords: ["cinematic", "film", "storytelling", "editorial"], componentIds: ["split-word-reveal", "parallax-media", "line-mask-reveal"], reason: "cinematic direction → sequenced typography + scrubbed parallax" },
  { keywords: ["luxury", "premium", "elegant", "high-end"], componentIds: ["blur-reveal", "gradient-headline", "css-animated-background"], reason: "luxury direction → restrained, atmospheric motion (no loud 3D)" },
  { keywords: ["playful", "bold", "experimental"], componentIds: ["scramble-text", "card-tilt", "character-reveal"], reason: "playful direction → tactile, expressive interactions" },
  { keywords: ["minimal", "clean", "quiet"], componentIds: ["stagger-entrance-grid"], reason: "minimal direction → CSS-only restrained motion" },
  { keywords: ["tech", "saas", "developer", "product"], componentIds: ["animated-counter", "animated-tabs", "css-animated-background"], reason: "product direction → counter social proof, animated tab transitions" },
  { keywords: ["interactive", "immersive", "3d"], componentIds: ["vanta-webgl-background", "card-tilt", "magnetic-button"], reason: "immersive direction → WebGL atmosphere + pointer-reactive cards" },
];

/**
 * M36.6 — the explicit allowlist of visual-direction terms the selection
 * engine actually understands (derived from DIRECTION_RULES so the two can
 * never drift). Planners/architects extract direction keywords ONLY from
 * this list; anything else in a brief is honest silence, never an invented
 * direction.
 */
export const SUPPORTED_DIRECTION_TERMS: readonly string[] = [...new Set(DIRECTION_RULES.flatMap((r) => r.keywords))];

/**
 * Deterministic component selection for a site brief. The AI planner uses
 * `componentCapabilityDoc()` for vocabulary; this pure function is the
 * fallback/consistency check that keeps selections honest and reproducible.
 */
export function selectComponents(brief: SiteBrief): ComponentSelection {
  const components: ComponentRegistryEntry[] = [];
  const reasons: string[] = [];
  const push = (id: string, reason: string) => {
    const component = getComponent(id);
    if (!component) return;
    if (components.some((c) => c.id === id)) return;
    if (brief.constraints?.some((c) => c === "no-heavy-webgl" && component.performance === "heavy")) return;
    if (brief.constraints?.includes("offline") && component.requiredDependencies.length > 0 && component.animationEngine === "vanta") return;
    components.push(component);
    reasons.push(reason);
  };

  const directionText = brief.visualDirection.join(" ").toLowerCase() + " " + brief.category.toLowerCase();
  for (const rule of DIRECTION_RULES) {
    if (rule.keywords.some((k) => directionText.includes(k))) {
      for (const id of rule.componentIds) push(id, `${rule.reason} (${brief.category})`);
    }
  }

  // Section-driven selections — deterministic mapping from needed sections.
  const sectionRules: Record<string, { id: string; reason: string }> = {
    hero: { id: "hero-classic", reason: "site needs a hero" },
    stats: { id: "stats-band", reason: "stats section present → animated counters" },
    pricing: { id: "pricing-table", reason: "pricing section present" },
    testimonials: { id: "testimonials-wall", reason: "testimonials section present" },
    experience: { id: "timeline-section", reason: "experience section present" },
    process: { id: "process-steps", reason: "process section present" },
    contact: { id: "contact-band", reason: "contact section present" },
    gallery: { id: "masonry-gallery", reason: "gallery section present" },
    reel: { id: "video-reel", reason: "reel section present" },
    projects: { id: "editorial-rows", reason: "projects section present" },
    services: { id: "bento-grid", reason: "services section present" },
  };
  for (const sectionType of brief.sections) {
    const rule = sectionRules[sectionType];
    if (rule) push(rule.id, rule.reason);
  }

  // Every site gets the CSS micro-interaction baseline.
  push("css-micro-hover", "baseline micro-interactions for buttons/links");
  return { components, reasons };
}

/** Prompt block — the vocabulary the planner may choose from. */
export function componentCapabilityDoc(): string {
  const byCategory = (["typography", "interactive", "galleries", "backgrounds", "layout", "micro-interactions"] as const)
    .map((category) => `  ${category}: ${componentsByCategory(category).map((c) => c.id).join(", ")}`)
    .join("\n");
  return `COMPONENT INTELLIGENCE (GIFTZ original implementations — pick a focused set, never everything):
${byCategory}
All components render from the content model with the site's own theme tokens; animated ones use the motion engine above (css presets / motion.gsap / backgroundEffects). Heavy components (vanta-webgl-background) are for immersive directions only and must never gate access to content.`;
}

// ---------------------------------------------------------------- design consistency engine

export interface ConsistencyWarning {
  componentId: string;
  message: string;
}

export interface ConsistencyResult {
  /** Component ids the direction should NOT use (with reasons). */
  warnings: ConsistencyWarning[];
  /** Coerced motion intensity guidance (0-100). */
  maxAnimationIntensity: number;
  /** Whether heavy WebGL backgrounds fit this direction. */
  webglAllowed: boolean;
}

const LUXURY_MARKERS = ["luxury", "premium", "elegant", "editorial", "minimal", "quiet", "refined"];
const LOUD_MARKERS = ["neon", "cyber", "experimental", "playful", "arcade"];

/**
 * Design-consistency gate: a component set must serve the site's existing
 * visual language. Given the theme + brief it flags incompatible choices and
 * bounds animation intensity (e.g. a luxury portfolio never gets neon
 * buttons, a minimal SaaS site never gets heavy 3D confetti).
 */
export function applyDesignConsistency(brief: SiteBrief, theme: SiteTheme, requestedComponentIds: string[]): ConsistencyResult {
  const warnings: ConsistencyWarning[] = [];
  const directionText = [...brief.visualDirection, brief.category].join(" ").toLowerCase();
  const luxury = LUXURY_MARKERS.some((m) => directionText.includes(m));
  const loud = LOUD_MARKERS.some((m) => directionText.includes(m));

  for (const id of requestedComponentIds) {
    const component = getComponent(id);
    if (!component) continue;
    if (luxury && (component.performance === "heavy" || component.id === "scramble-text")) {
      warnings.push({
        componentId: id,
        message: `"${component.name}" is too loud for a ${brief.visualDirection.join("/")} direction — prefer blur/gradient/line-mask reveals`,
      });
    }
    if (component.animationEngine === "vanta" && theme.typeScale === "intimate" && theme.density === "compact") {
      warnings.push({
        componentId: id,
        message: "a WebGL background fights this compact/intimate layout — consider a CSS animated background instead",
      });
    }
  }

  const maxAnimationIntensity = luxury ? 55 : loud ? 80 : 70;
  const webglAllowed = !luxury || brief.visualDirection.some((v) => ["immersive", "interactive"].includes(v.toLowerCase()));
  return { warnings, maxAnimationIntensity, webglAllowed };
}

/**
 * Post-plan consistency pass over a built config: clamps motion intensity to
 * the direction budget and returns the warnings for the proposal summary.
 * Deterministic; never silently rewrites content.
 */
export function enforceDesignConsistency(config: SiteConfig, brief: SiteBrief): { config: SiteConfig; warnings: string[] } {
  const gsapIds = (config.motion.gsap?.animations ?? [])
    .filter((a) => a.enabled)
    .map((a) => `gsap:${a.preset}`);
  const bg = config.backgroundEffects?.enabled ? ["vanta-webgl-background"] : [];
  const result = applyDesignConsistency(brief, config.theme, [...gsapIds, ...bg]);
  const warnings = result.warnings.map((w) => `${w.componentId}: ${w.message}`);
  let next = config;
  if (config.motion.intensity > result.maxAnimationIntensity) {
    next = {
      ...config,
      motion: { ...config.motion, intensity: result.maxAnimationIntensity },
    };
    warnings.push(`motion intensity clamped to ${result.maxAnimationIntensity} for the "${brief.visualDirection.join("/")}" direction`);
  }
  return { config: next, warnings };
}

/** Compact doc for the file-level agent's plan prompt (M17 selection rules). */
export function componentSelectionRules(): string {
  return [
    "Component selection rules (M17):",
    `- Choose a FOCUSED component set from: ${COMPONENT_REGISTRY_IDS.join(", ")}.`,
    "- Reuse what the site already has before adding; never stack every effect.",
    "- Keep the visual language coherent (a luxury portfolio gets no neon/toy interactions; a minimal SaaS page gets no heavy 3D).",
    "- Every generated component must stay responsive (360-1920px), keyboard accessible and fully readable with animations disabled.",
  ].join("\n");
}
