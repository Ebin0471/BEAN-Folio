/**
 * BEAN Folio — Website Builder configuration schema (v2).
 *
 * Single source of truth shared by the client (WebsiteBuilderView,
 * SiteRenderer, Code Giftz design panel) and the server (/api/me/site, /api/ai/design).
 * Every persisted config — user edits and AI proposals alike — must pass
 * `siteConfigSchema` before it is stored or rendered.
 *
 * v2 additions (all backward compatible — legacy v1 JSON is migrated by
 * `normalizeConfig`, which always outputs a fully-populated v2 config):
 *  - a 129-family font library (heading/body/accent/code fonts, per-family
 *    weights — see lib/site-fonts.ts; legacy ids editorial/clean/mono migrate)
 *  - 38 curated color systems (lib/site-palettes.ts) applied as color-token
 *    overlays — they never touch typography, layout or motion
 *  - secondary accent + focus tokens, background gradients, surface opacity
 *  - a real glassmorphism system (blur/opacity/tint/border/highlight/shadow,
 *    per-target: nav, cards, buttons) with presets and a no-backdrop fallback
 *  - the motion library (lib/site-motion.ts): 107 distinct presets + none,
 *    five easings, decorative background effects, micro-interaction presets,
 *    once/repeat reveals and per-section motion overrides
 *  - navigation layouts and heading alignment
 *
 * Rules preserved from v1:
 *  - legacy single-page `sections` configs migrate into `pages`
 *  - derived theme tokens for surface/border/muted and fonts
 *  - invalid configs normalize to null — callers must never render those
 */
import { z } from "zod";

import { MOTION_PRESET_IDS, MOTION_EASING_IDS, getMotionPreset } from "@/lib/site-motion";
import {
  gsapMotionBlockSchema,
  backgroundEffectsSchema,
  validateGsapMotionBlock,
  validateBackgroundEffects,
  type BackgroundEffects,
  type GsapMotionBlock,
} from "@/lib/giftz/motion-engine";
import { resolveFont, fontStack } from "@/lib/site-fonts";
// v4 profession-template families (see src/lib/site-templates/professions/).
// Factories are called at read time (never at module init) so the circular
// type/value dependency with this file stays safe.
import { newsroomTemplates } from "@/lib/site-templates/professions/newsroom";
import { writingTemplates } from "@/lib/site-templates/professions/writing";
import { technologyTemplates } from "@/lib/site-templates/professions/technology";
import { engineeringTemplates } from "@/lib/site-templates/professions/engineering";
import { creativeArtsTemplates } from "@/lib/site-templates/professions/creative-arts";
import { performingArtsTemplates } from "@/lib/site-templates/professions/performing-arts";
import { businessTemplates } from "@/lib/site-templates/professions/business";
import { healthTemplates } from "@/lib/site-templates/professions/health";
import { educationTemplates } from "@/lib/site-templates/professions/education";
import { scienceTemplates } from "@/lib/site-templates/professions/science";
import { tradesTemplates } from "@/lib/site-templates/professions/trades";

// ------------------------------------------------------------------ helpers

const CSS_COLOR = z.string().regex(/^#[0-9a-fA-F]{3,8}$|^[a-z]+$/i).max(32);

/**
 * Normalize a CSS color to the 6-digit hex form every consumer assumes
 * (mixHex derivation, WCAG luminance, <input type="color"> values).
 * #abc → #aabbcc, #rrggbbaa → alpha dropped onto an opaque hex; bare words
 * (rare, hand-authored configs) pass through unchanged for direct CSS use.
 */
export function normalizeHexColor(c: string): string {
  const t = c.trim();
  let m = /^#([0-9a-fA-F]{3})$/.exec(t);
  if (m) return `#${m[1][0]}${m[1][0]}${m[1][1]}${m[1][1]}${m[1][2]}${m[1][2]}`.toLowerCase();
  m = /^#([0-9a-fA-F]{4})$/.exec(t);
  if (m) {
    const [r, g, b] = [m[1][0], m[1][1], m[1][2]];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(t);
  if (m) return `#${m[1].toLowerCase()}`;
  m = /^#([0-9a-fA-F]{8})$/.exec(t);
  if (m) return `#${m[1].slice(0, 6).toLowerCase()}`;
  return t;
}

/** Mix two hex colors. t=0 → a, t=1 → b. Non-hex inputs return b. */
export function mixHex(a: string, b: string, t: number): string {
  const parse = (c: string): [number, number, number] | null => {
    const m = /^#([0-9a-fA-F]{6})$/.exec(c.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return /^#[0-9a-fA-F]{3,8}$/.test(b) ? b : "#888888";
  const ch = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * t);
  return `#${((1 << 24) | (ch(0) << 16) | (ch(1) << 8) | ch(2)).toString(16).slice(1)}`;
}

/** Schema input shape — defaults optional (used by template/preset authors). */
type ThemeInput = z.input<typeof themeSchema>;

/**
 * A theme after derivation: every token is a concrete string / number and
 * every font id resolves in the library.
 */
export interface ResolvedTheme {
  background: string;
  foreground: string;
  accent: string;
  accent2: string;
  surface: string;
  border: string;
  muted: string;
  focus: string;
  gradient: { from: string; to: string; angle: number } | null;
  surfaceOpacity: number;
  font: SiteFontId;
  headingFont: SiteFontId;
  bodyFont: SiteFontId;
  accentFont: SiteFontId;
  codeFont: SiteFontId;
  navFont: SiteFontId;
  buttonFont: SiteFontId;
  radius: SiteTheme["radius"];
  density: SiteTheme["density"];
  typeScale: SiteTheme["typeScale"];
  lineHeight: SiteTheme["lineHeight"];
  letterSpacing: SiteTheme["letterSpacing"];
  headingWeight: SiteTheme["headingWeight"];
  contentWidth: SiteTheme["contentWidth"];
  columns: SiteTheme["columns"];
  buttonStyle: SiteTheme["buttonStyle"];
  linkStyle: SiteTheme["linkStyle"];
  imageRatio: SiteTheme["imageRatio"];
  divider: SiteTheme["divider"];
  pageTransition: SiteTheme["pageTransition"];
  navLayout: SiteTheme["navLayout"];
  headingAlign: SiteTheme["headingAlign"];
  /** Glass system (null = disabled/absent). */
  glass: SiteGlass | null;
}

/** A font id that is guaranteed to resolve in the library after derivation. */
export type SiteFontId = string;

export function deriveTheme(theme: ThemeInput): ResolvedTheme {
  const parsed = themeSchema.parse(theme);
  // Normalize every color token to 6-digit hex BEFORE derivation — 3-digit,
  // 4-digit or 8-digit hex values would silently break mixHex defaults, WCAG
  // contrast math and the builder's <input type="color"> controls otherwise.
  const base = {
    ...parsed,
    background: normalizeHexColor(parsed.background),
    foreground: normalizeHexColor(parsed.foreground),
    accent: normalizeHexColor(parsed.accent),
    accent2: parsed.accent2 ? normalizeHexColor(parsed.accent2) : parsed.accent2,
    surface: parsed.surface ? normalizeHexColor(parsed.surface) : parsed.surface,
    border: parsed.border ? normalizeHexColor(parsed.border) : parsed.border,
    muted: parsed.muted ? normalizeHexColor(parsed.muted) : parsed.muted,
    focus: parsed.focus ? normalizeHexColor(parsed.focus) : parsed.focus,
    gradient: parsed.gradient
      ? { ...parsed.gradient, from: normalizeHexColor(parsed.gradient.from), to: normalizeHexColor(parsed.gradient.to) }
      : parsed.gradient,
    glass: parsed.glass
      ? { ...parsed.glass, tint: parsed.glass.tint ? normalizeHexColor(parsed.glass.tint) : parsed.glass.tint }
      : parsed.glass,
  };
  const headingFont = resolveFont(base.headingFont ?? base.font).id;
  const bodyFont = resolveFont(base.bodyFont ?? base.font).id;
  return {
    ...base,
    font: headingFont,
    headingFont,
    bodyFont,
    accentFont: resolveFont(base.accentFont, headingFont).id,
    codeFont: resolveFont(base.codeFont, "geist-mono").id,
    // Nav and buttons default to the BODY typeface — an absent role never
    // changes what an existing site looks like, and setting one role never
    // touches the others (control isolation).
    navFont: resolveFont(base.navFont, bodyFont).id,
    buttonFont: resolveFont(base.buttonFont, bodyFont).id,
    surface: base.surface ?? mixHex(base.background, base.foreground, 0.06),
    border: base.border ?? mixHex(base.background, base.foreground, 0.18),
    muted: base.muted ?? mixHex(base.foreground, base.background, 0.42),
    accent2: base.accent2 ?? mixHex(base.accent, base.foreground, 0.35),
    focus: base.focus ?? mixHex(base.accent, base.background, 0.35),
    gradient: base.gradient ?? null,
    glass: base.glass ?? null,
  };
}

/** Ready CSS font stacks for a resolved theme (renderer + AI preview reuse).
 * `opts.external` resolves bundled families to their real Google Fonts names
 * for documents that do not carry the app's next/font variables (static-site
 * export) — see fontStack for the context contract. */
export function themeFontStacks(theme: ResolvedTheme, opts: { external?: boolean } = {}) {
  return {
    heading: fontStack(theme.headingFont, opts),
    body: fontStack(theme.bodyFont, opts),
    accent: fontStack(theme.accentFont, opts),
    code: fontStack(theme.codeFont, opts),
    nav: fontStack(theme.navFont, opts),
    button: fontStack(theme.buttonFont, opts),
  };
}

// ------------------------------------------------------------------ sections

export const SECTION_TYPES = [
  "hero", "about", "projects", "skills", "stats", "collections", "contact",
  "services", "experience", "gallery", "testimonials",
  "process", "faq", "pricing", "logos",
  "featured", "reel",
] as const;
export type SiteSectionType = (typeof SECTION_TYPES)[number];

export const HERO_VARIANTS = ["classic", "centered", "split", "cover"] as const;
export type HeroVariant = (typeof HERO_VARIANTS)[number];

/** Font selector field — free id validated at derivation against the library. */
const fontId = z.string().max(48);

/**
 * Per-section motion override — "Inherit" (absent) uses the site-wide motion
 * system; explicit values apply to this section only.
 */
export const sectionMotionSchema = z.object({
  preset: z.string().max(48).optional(),
  duration: z.number().int().min(150).max(1200).optional(),
  intensity: z.number().int().min(0).max(100).optional(),
  stagger: z.number().int().min(0).max(240).optional(),
  disabled: z.boolean().optional(),
});
export type SectionMotion = z.infer<typeof sectionMotionSchema>;

export const sectionBaseSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(SECTION_TYPES),
  visible: z.boolean().default(true),
  /** Empty allowed — an untitled section simply renders no heading (and never
   * blocks saving, which a min(1) rule previously did from the Title input). */
  title: z.string().max(120),
  motion: sectionMotionSchema.optional(),
  /**
   * Per-section style overrides (direct editing). Absent fields inherit the
   * site-wide theme — a section override never leaks into other sections.
   */
  style: z
    .object({
      headingFont: fontId.optional(),
      headingWeight: z.enum(["light", "semibold", "bold"]).optional(),
      titleColor: CSS_COLOR.optional(),
      /** Section background band: inherit, surface token, accent wash, or a custom hex. */
      background: z.union([z.enum(["none", "surface", "wash"]), CSS_COLOR]).optional(),
      /** Content width override for this section only. */
      width: z.enum(["narrow", "regular", "wide"]).optional(),
      /** Vertical rhythm override for this section only. */
      spacing: z.enum(["compact", "regular", "relaxed"]).optional(),
      /** Heading alignment override for this section only. */
      headingAlign: z.enum(["left", "center"]).optional(),
    })
    .optional(),
});

export type SectionStyle = NonNullable<z.infer<typeof sectionBaseSchema>["style"]>;

export const heroSectionSchema = sectionBaseSchema.extend({
  type: z.literal("hero"),
  subtitle: z.string().max(280).default(""),
  variant: z.enum(HERO_VARIANTS).default("classic"),
  /** Optional call-to-action button label; empty = no button. */
  ctaLabel: z.string().max(40).default(""),
  /**
   * Optional CTA destination. Empty = the default in-site anchor to the
   * contact section (#bs-contact). Accepts in-page anchors (#…) or absolute
   * http(s) URLs; anything else (javascript:, data:, vbscript:…) is dropped
   * at render time — see safeCtaHref in SiteRenderer / site-export.
   */
  ctaHref: z.string().max(300).default(""),
});

export const aboutSectionSchema = sectionBaseSchema.extend({
  type: z.literal("about"),
  body: z.string().max(4000).default(""),
});

export const projectsSectionSchema = sectionBaseSchema.extend({
  type: z.literal("projects"),
  limit: z.number().int().min(1).max(24).default(6),
  layout: z.enum(["grid", "featured", "list", "editorial"]).default("grid"),
  /** Optional category slug filter (e.g. "writing"). */
  category: z.string().max(40).default(""),
});

/**
 * FEATURED WORK — the editorial showcase, deliberately independent from the
 * "projects" section (the complete public collection). Content selection is
 * explicit: the creator either curates `projectIds` here in the studio, or —
 * when empty — the section renders ONLY projects the creator has starred
 * (featured) at platform level. It NEVER falls back to the whole collection,
 * so Featured Work and All Projects can never display overlapping content.
 */
export const featuredSectionSchema = sectionBaseSchema.extend({
  type: z.literal("featured"),
  subtitle: z.string().max(280).default(""),
  /** Explicit curation — project ids in display order (max 6). */
  projectIds: z.array(z.string().min(1).max(64)).max(6).default([]),
  layout: z.enum(["grid", "featured", "editorial"]).default("featured"),
});

/**
 * VIDEO REEL — up to five chosen videos in creator-controlled order, rendered
 * as playable content (thumbnail first-frame + a real video player on click).
 * Videos are MediaAsset references; ownership + VIDEO-kind are validated at
 * the save boundary (/api/me/site) and public streaming is granted only for
 * PUBLISHED sites by the media raw route.
 */
export const reelSectionSchema = sectionBaseSchema.extend({
  type: z.literal("reel"),
  subtitle: z.string().max(280).default(""),
  /** Up to five videos, in display order. */
  videos: z
    .array(
      z.object({
        mediaId: z.string().min(1).max(64),
        caption: z.string().max(160).default(""),
      })
    )
    .max(5)
    .default([]),
  layout: z.enum(["strip", "grid"]).default("strip"),
});

export const skillsSectionSchema = sectionBaseSchema.extend({
  type: z.literal("skills"),
});

export const statsSectionSchema = sectionBaseSchema.extend({
  type: z.literal("stats"),
});

export const collectionsSectionSchema = sectionBaseSchema.extend({
  type: z.literal("collections"),
  limit: z.number().int().min(1).max(12).default(3),
});

export const contactSectionSchema = sectionBaseSchema.extend({
  type: z.literal("contact"),
  body: z.string().max(1200).default(""),
});

export const servicesSectionSchema = sectionBaseSchema.extend({
  type: z.literal("services"),
  layout: z.enum(["cards", "rows"]).default("cards"),
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(80),
        description: z.string().max(300).default(""),
      })
    )
    .max(8)
    .default([]),
});

export const experienceSectionSchema = sectionBaseSchema.extend({
  type: z.literal("experience"),
  layout: z.enum(["timeline", "rows"]).default("timeline"),
  entries: z
    .array(
      z.object({
        role: z.string().min(1).max(80),
        org: z.string().max(80).default(""),
        period: z.string().max(40).default(""),
        description: z.string().max(400).default(""),
      })
    )
    .max(10)
    .default([]),
});

export const gallerySectionSchema = sectionBaseSchema.extend({
  type: z.literal("gallery"),
  source: z.enum(["projects", "collections"]).default("projects"),
  limit: z.number().int().min(1).max(24).default(9),
  layout: z.enum(["masonry", "grid", "strip"]).default("masonry"),
});

export const testimonialsSectionSchema = sectionBaseSchema.extend({
  type: z.literal("testimonials"),
  layout: z.enum(["cards", "stack"]).default("cards"),
  items: z
    .array(
      z.object({
        quote: z.string().min(1).max(500),
        name: z.string().min(1).max(80),
        role: z.string().max(80).default(""),
      })
    )
    .max(8)
    .default([]),
});

export const processSectionSchema = sectionBaseSchema.extend({
  type: z.literal("process"),
  layout: z.enum(["steps", "grid", "numbers"]).default("steps"),
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(80),
        description: z.string().max(400).default(""),
      })
    )
    .max(8)
    .default([]),
});

export const faqSectionSchema = sectionBaseSchema.extend({
  type: z.literal("faq"),
  items: z
    .array(
      z.object({
        question: z.string().min(1).max(200),
        answer: z.string().max(800).default(""),
      })
    )
    .max(10)
    .default([]),
});

export const pricingSectionSchema = sectionBaseSchema.extend({
  type: z.literal("pricing"),
  layout: z.enum(["cards", "rows"]).default("cards"),
  tiers: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        price: z.string().max(40).default(""),
        period: z.string().max(40).default(""),
        description: z.string().max(200).default(""),
        features: z.array(z.string().max(80)).max(6).default([]),
        ctaLabel: z.string().max(40).default(""),
        /** The emphasized tier renders with the accent treatment. */
        highlighted: z.boolean().default(false),
      })
    )
    .max(4)
    .default([]),
});

/**
 * Client / collaborator wordmarks. Names must come from the USER (entered or
 * uploaded materials) — the AI planner never invents clients; empty items
 * render clearly-labelled placeholder tiles instead of fabricated logos.
 */
export const logosSectionSchema = sectionBaseSchema.extend({
  type: z.literal("logos"),
  note: z.string().max(200).default(""),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
      })
    )
    .max(12)
    .default([]),
});

export const siteSectionSchema = z.discriminatedUnion("type", [
  heroSectionSchema,
  aboutSectionSchema,
  projectsSectionSchema,
  featuredSectionSchema,
  reelSectionSchema,
  skillsSectionSchema,
  statsSectionSchema,
  collectionsSectionSchema,
  contactSectionSchema,
  servicesSectionSchema,
  experienceSectionSchema,
  gallerySectionSchema,
  testimonialsSectionSchema,
  processSectionSchema,
  faqSectionSchema,
  pricingSectionSchema,
  logosSectionSchema,
]);
export type SiteSection = z.infer<typeof siteSectionSchema>;

// ------------------------------------------------------------------ theme

export const GLASS_PRESET_IDS = ["frosted", "smoked", "crystal", "aurora", "soft", "dark", "custom"] as const;
export type GlassPresetId = (typeof GLASS_PRESET_IDS)[number];

export const glassSchema = z.object({
  enabled: z.boolean().default(false),
  preset: z.enum(GLASS_PRESET_IDS).default("frosted"),
  /** Which site elements get the glass treatment (real, rendered targets). */
  targets: z
    .object({
      nav: z.boolean().default(true),
      cards: z.boolean().default(true),
      buttons: z.boolean().default(false),
    })
    .default(() => ({ nav: true, cards: true, buttons: false })),
  blur: z.number().int().min(0).max(40).default(16),
  /** Tint opacity percentage (0–90; higher = more solid). */
  opacity: z.number().int().min(0).max(90).default(42),
  tint: CSS_COLOR.default("#ffffff"),
  borderOpacity: z.number().int().min(0).max(100).default(35),
  borderWidth: z.number().int().min(0).max(4).default(1),
  /** Top-edge highlight strength (0–100). */
  highlight: z.number().int().min(0).max(100).default(35),
  /** Drop shadow strength (0–100). */
  shadow: z.number().int().min(0).max(100).default(35),
  /** Optional subtle gradient inside the glass surface. */
  gradient: z.boolean().default(true),
});
export type SiteGlass = z.infer<typeof glassSchema>;

export type GlassTargets = SiteGlass["targets"];

/** Concrete values for each named glass preset. */
export const GLASS_PRESETS: Record<Exclude<GlassPresetId, "custom">, Partial<SiteGlass>> = {
  frosted: { blur: 16, opacity: 42, tint: "#ffffff", borderOpacity: 35, borderWidth: 1, highlight: 35, shadow: 35, gradient: true },
  smoked: { blur: 10, opacity: 58, tint: "#202024", borderOpacity: 40, borderWidth: 1, highlight: 20, shadow: 45, gradient: false },
  crystal: { blur: 6, opacity: 16, tint: "#ffffff", borderOpacity: 60, borderWidth: 1, highlight: 70, shadow: 12, gradient: true },
  aurora: { blur: 26, opacity: 26, tint: "#9d7bff", borderOpacity: 45, borderWidth: 1, highlight: 55, shadow: 30, gradient: true },
  soft: { blur: 12, opacity: 55, tint: "#ffffff", borderOpacity: 22, borderWidth: 1, highlight: 18, shadow: 25, gradient: false },
  dark: { blur: 18, opacity: 58, tint: "#0a0a0c", borderOpacity: 40, borderWidth: 1, highlight: 25, shadow: 55, gradient: true },
};

export function applyGlassPreset(preset: Exclude<GlassPresetId, "custom">): Partial<SiteGlass> {
  return GLASS_PRESETS[preset];
}

/** Legacy v1 font ids (migrated to library ids on read; never shown as choices). */
export const FONT_CHOICES = ["editorial", "clean", "mono"] as const;

export const themeSchema = z.object({
  /** Page background — any valid CSS color string. */
  background: CSS_COLOR,
  /** Main text color. */
  foreground: CSS_COLOR,
  /** Accent (links, highlights) — brand default is champagne gold. */
  accent: CSS_COLOR,
  /** Secondary accent (quotes, timeline dots, hover pairings). */
  accent2: CSS_COLOR.optional(),
  /** Card / raised surface background (defaults derived from bg+fg). */
  surface: CSS_COLOR.optional(),
  /** Hairline / border color. */
  border: CSS_COLOR.optional(),
  /** Secondary (muted) text color. */
  muted: CSS_COLOR.optional(),
  /** Keyboard focus outline color (derived from accent when absent). */
  focus: CSS_COLOR.optional(),
  /** Optional page background gradient (null = solid background). */
  gradient: z
    .object({ from: CSS_COLOR, to: CSS_COLOR, angle: z.number().int().min(0).max(360) })
    .nullable()
    .optional(),
  /** Card surface opacity percentage (100 = solid). */
  surfaceOpacity: z.number().int().min(20).max(100).default(100),
  /** Legacy base font (v1). Kept as the fallback for heading/body. */
  font: fontId.default("fraunces"),
  /** Heading typeface — id from the 129-family library. */
  headingFont: fontId.optional(),
  /** Body typeface. */
  bodyFont: fontId.optional(),
  /** Accent typeface — uppercase meta labels, quote attributions, stats. */
  accentFont: fontId.optional(),
  /** Code/technical typeface — handles, stat values, meta chips. */
  codeFont: fontId.optional(),
  /** Navigation typeface — masthead page links. Absent = body typeface. */
  navFont: fontId.optional(),
  /** Button typeface — every .bs-btn on the site. Absent = body typeface. */
  buttonFont: fontId.optional(),
  radius: z.enum(["none", "md", "full"]).default("md"),
  density: z.enum(["compact", "regular", "relaxed"]).default("regular"),
  /** Heading size ladder. */
  typeScale: z.enum(["intimate", "balanced", "grand"]).default("balanced"),
  lineHeight: z.enum(["tight", "normal", "relaxed"]).default("normal"),
  letterSpacing: z.enum(["tight", "normal", "wide"]).default("normal"),
  headingWeight: z.enum(["light", "semibold", "bold"]).default("semibold"),
  /** Page content width. */
  contentWidth: z.enum(["narrow", "regular", "wide"]).default("regular"),
  /** Fixed project/gallery column count; 0 = responsive auto. */
  columns: z.union([z.literal(0), z.literal(2), z.literal(3)]).default(0),
  buttonStyle: z.enum(["sharp", "rounded", "pill", "outline"]).default("rounded"),
  linkStyle: z.enum(["underline", "accent", "plain"]).default("accent"),
  imageRatio: z.enum(["4/3", "3/2", "1/1", "16/9"]).default("4/3"),
  divider: z.enum(["none", "line", "accent"]).default("line"),
  /** Transition when switching pages inside the site nav. */
  pageTransition: z.enum(["none", "fade", "slide", "rise", "zoom"]).default("fade"),
  /** Masthead arrangement. */
  navLayout: z.enum(["inline", "stacked", "centered"]).default("inline"),
  /** Section heading alignment. */
  headingAlign: z.enum(["left", "center"]).default("left"),
  /** Glassmorphism system (null/absent = disabled). */
  glass: glassSchema.nullish(),
});
export type SiteTheme = z.infer<typeof themeSchema>;

// ------------------------------------------------------------------ motion

/**
 * Legacy alias list kept for older imports; the live registry lives in
 * lib/site-motion.ts and carries 107 presets + none.
 */
export const MOTION_PRESETS = MOTION_PRESET_IDS;

export const motionSchema = z.object({
  enabled: z.boolean().default(true),
  preset: z.string().max(48).default("fadeUp"),
  /** Base animation duration in ms. */
  duration: z.number().int().min(150).max(1200).default(600),
  /** Per-item stagger in ms for grid/card entrances. */
  stagger: z.number().int().min(0).max(240).default(60),
  /** Base delay before a reveal transition starts (ms) — stagger sits on top of it. */
  delay: z.number().int().min(0).max(600).default(0),
  easing: z.enum(MOTION_EASING_IDS).default("smooth"),
  /** 0-100 — how far elements travel / how strong effects are. */
  intensity: z.number().int().min(0).max(100).default(50),
  /** Card image zoom + button micro-interactions on hover (master switch). */
  hoverEffects: z.boolean().default(true),
  /** Scroll-triggered section reveals. */
  scrollReveal: z.boolean().default(true),
  /** Reveal once (true) or re-play every time sections re-enter the viewport. */
  once: z.boolean().default(true),
  /** Decorative animated background (background presets). */
  background: z.string().max(40).default("bg-none"),
  /** Micro-interaction preset for nav links and buttons. */
  microInteractions: z.string().max(40).default("hover-lift"),
  /** Thin reading-progress indicator fixed to the top of the page. */
  scrollProgress: z.boolean().default(false),
  /**
   * GIFTZ GSAP motion block (M15) — additive, optional. Validated against the
   * motion-engine preset registry in normalizeConfig (section ids known
   * there); unknown presets/animations are dropped, never executed.
   */
  gsap: gsapMotionBlockSchema.optional(),
});
export type SiteMotion = z.infer<typeof motionSchema>;

export function defaultMotion(): SiteMotion {
  return motionSchema.parse({});
}

// ------------------------------------------------------------------ pages

export const sitePageSchema = z.object({
  id: z.string().min(1).max(64),
  /** Page name shown in the site navigation. */
  name: z.string().min(1).max(60),
  visible: z.boolean().default(true),
  sections: z.array(siteSectionSchema).min(1, "Every page needs at least one section").max(12),
});
export type SitePage = z.infer<typeof sitePageSchema>;

// ------------------------------------------------------------------ config

export const TEMPLATE_IDS = [
  // classic (v1) templates — kept so legacy configs stay valid
  "atelier", "mono", "gallery",
  // v2 profession templates
  "dev-console", "product-studio", "brand-atelier", "lens-gallery", "motion-reel",
  "illustration-desk", "architecture-index", "byline-journal", "growth-consult",
  "founder-story", "sound-room", "classroom-folio", "polymath-index",
  // v2 style templates — visual genres (any profession), shown in the studio gallery
  "minimal-index", "modern-loft", "editorial-press", "creative-playbook",
  "developer-term", "designer-desk", "photography-frame", "agency-roster",
  "corporate-ledger", "dark-luxury", "glassmorphism", "experimental-lab",
  "portfolio-showcase", "interactive",
  // v3 style templates — the library expansion (54 complete-website designs)
  "paper-fold", "whisper-grid", "ink-brief",
  "studio-line", "meridian-work", "clear-span",
  "gazette-noir", "folio-review", "broadsheet",
  "collage-wall", "marker-pad", "circus-pop",
  "kernel-dark", "api-notes", "silicon-slate",
  "grid-pencil", "velvet-type",
  "silver-halide", "daylight-studio",
  "film-cell", "director-cut", "night-screening",
  "pitch-deck", "collective-works",
  "corner-office", "quarterly",
  "onyx-foil", "midnight-suite", "noir-marble",
  "frost-panel", "prism-glass",
  "cursor-arcade", "kinetic-poster",
  "concrete-plan", "interior-muse", "blueprint-room",
  "solo-card", "one-person-studio", "name-plate", "open-for-work",
  // v4 profession templates — the universal profession expansion (73
  // genuinely distinct complete-website designs, each mapped to taxonomy
  // profession slugs via TemplatePreset.professions). Grouped by family in
  // src/lib/site-templates/professions/.
  "news-anchor-desk", "broadcast-studio", "field-report-kit", "investigative-dossier",
  "press-photographer", "video-journal-cut", "radio-airwave", "podcast-atlas",
  "newsroom-desk", "explainer-brief", "byline-media",
  "author-folio", "poet-pages", "copywriter-desk", "tech-doc-hub", "translator-bridge",
  "frontend-craft", "backend-forge", "mobile-launchpad", "game-dev-arcade", "ai-ml-lab",
  "data-notebook", "analyst-report", "cyber-shield", "devops-pipeline", "product-roadmap", "ux-research-lab",
  "civil-works", "mechanical-forge", "electronics-bench",
  "fine-artist-canvas", "sculptor-atelier", "digital-artist-lab", "fashion-lookbook",
  "interior-designer-muse", "industrial-design-lab", "stylist-editorial", "beauty-bar", "pattern-maker-textile",
  "musician-stage", "actor-callboard", "voice-booth", "dancer-stage", "filmmaker-cut",
  "video-editor-suite", "sound-booth", "casting-desk",
  "consultant-suite", "founder-ventures", "finance-ledger", "realestate-listing",
  "legal-chambers", "event-atelier", "marketer-funnel",
  "doctor-clinic", "nurse-care", "physio-motion", "dietitian-plate", "therapy-practice",
  "teacher-classroom", "professor-lecture", "scholar-thesis", "student-launch",
  "scientist-lab", "eco-field", "agro-harvest",
  "chef-table", "baker-oven", "tailor-atelier", "barber-chair", "tattoo-ink", "florist-bloom", "trades-guild",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/**
 * The complete-website template library shown in the studio gallery — ordered
 * by collection. Unlike the profession templates these are visual genres
 * (professions: []) — a quick way to give any site a complete, coherent look.
 * Every id here is a WHOLE website design (structure, section arrangement,
 * color treatment, typography configuration, responsive behavior) — never a
 * single font/animation/color preset. Those live exclusively in their own
 * Customization panels. Consumed by the studio TemplateGallery.
 */
export const STYLE_TEMPLATE_IDS = [
  // Minimal & clean
  "minimal-index", "paper-fold", "whisper-grid", "ink-brief",
  // Modern professional
  "modern-loft", "studio-line", "meridian-work", "clear-span",
  // Editorial & magazine
  "editorial-press", "gazette-noir", "folio-review", "broadsheet",
  // Creative portfolio
  "creative-playbook", "portfolio-showcase", "collage-wall", "marker-pad", "circus-pop",
  // Developer & technology
  "developer-term", "kernel-dark", "api-notes", "silicon-slate",
  // Designer portfolio
  "designer-desk", "grid-pencil", "velvet-type",
  // Photography
  "photography-frame", "silver-halide", "daylight-studio",
  // Videography & filmmaking
  "film-cell", "director-cut", "night-screening",
  // Agency & studio
  "agency-roster", "pitch-deck", "collective-works",
  // Corporate & business
  "corporate-ledger", "corner-office", "quarterly",
  // Dark luxury
  "dark-luxury", "onyx-foil", "midnight-suite", "noir-marble",
  // Glassmorphism
  "glassmorphism", "frost-panel", "prism-glass",
  // Interactive & experimental
  "experimental-lab", "interactive", "cursor-arcade", "kinetic-poster",
  // Architecture & interior
  "concrete-plan", "interior-muse", "blueprint-room",
  // Freelance & personal branding
  "solo-card", "one-person-studio", "name-plate", "open-for-work",
  // v4 profession families (TemplatePreset.professions declares compatibility)
  "news-anchor-desk", "broadcast-studio", "field-report-kit", "investigative-dossier",
  "press-photographer", "video-journal-cut", "radio-airwave", "podcast-atlas",
  "newsroom-desk", "explainer-brief", "byline-media",
  "author-folio", "poet-pages", "copywriter-desk", "tech-doc-hub", "translator-bridge",
  "frontend-craft", "backend-forge", "mobile-launchpad", "game-dev-arcade", "ai-ml-lab",
  "data-notebook", "analyst-report", "cyber-shield", "devops-pipeline", "product-roadmap", "ux-research-lab",
  "civil-works", "mechanical-forge", "electronics-bench",
  "fine-artist-canvas", "sculptor-atelier", "digital-artist-lab", "fashion-lookbook",
  "interior-designer-muse", "industrial-design-lab", "stylist-editorial", "beauty-bar", "pattern-maker-textile",
  "musician-stage", "actor-callboard", "voice-booth", "dancer-stage", "filmmaker-cut",
  "video-editor-suite", "sound-booth", "casting-desk",
  "consultant-suite", "founder-ventures", "finance-ledger", "realestate-listing",
  "legal-chambers", "event-atelier", "marketer-funnel",
  "doctor-clinic", "nurse-care", "physio-motion", "dietitian-plate", "therapy-practice",
  "teacher-classroom", "professor-lecture", "scholar-thesis", "student-launch",
  "scientist-lab", "eco-field", "agro-harvest",
  "chef-table", "baker-oven", "tailor-atelier", "barber-chair", "tattoo-ink", "florist-bloom", "trades-guild",
] as const;
export type StyleTemplateId = (typeof STYLE_TEMPLATE_IDS)[number];

// ------------------------------------------------------------------ template collections

/** Stable collection (category) ids for the template library. */
export const TEMPLATE_CATEGORY_IDS = [
  "minimal-clean",
  "modern-professional",
  "editorial-magazine",
  "creative-portfolio",
  "developer-technology",
  "designer-portfolio",
  "photography",
  "videography-filmmaking",
  "agency-studio",
  "corporate-business",
  "dark-luxury",
  "glassmorphism",
  "interactive-experimental",
  "architecture-interior",
  "freelance-personal",
  // v4 profession families
  "newsroom-broadcast",
  "writing-publishing",
  "technology-professions",
  "engineering-disciplines",
  "creative-arts-professions",
  "performing-arts",
  "business-finance-professions",
  "health-wellness",
  "education-academia",
  "science-environment",
  "trades-services",
] as const;
export type TemplateCategoryId = (typeof TEMPLATE_CATEGORY_IDS)[number];

export const TEMPLATE_CATEGORY_LABELS: Record<TemplateCategoryId, string> = {
  "minimal-clean": "Minimal & clean",
  "modern-professional": "Modern professional",
  "editorial-magazine": "Editorial & magazine",
  "creative-portfolio": "Creative portfolio",
  "developer-technology": "Developer & technology",
  "designer-portfolio": "Designer portfolio",
  photography: "Photography",
  "videography-filmmaking": "Videography & filmmaking",
  "agency-studio": "Agency & studio",
  "corporate-business": "Corporate & business",
  "dark-luxury": "Dark luxury",
  glassmorphism: "Glassmorphism",
  "interactive-experimental": "Interactive & experimental",
  "architecture-interior": "Architecture & interior",
  "freelance-personal": "Freelance & personal branding",
  // v4 profession families
  "newsroom-broadcast": "Newsroom & broadcast",
  "writing-publishing": "Writing & publishing",
  "technology-professions": "Technology professions",
  "engineering-disciplines": "Engineering disciplines",
  "creative-arts-professions": "Creative & visual arts",
  "performing-arts": "Performing arts",
  "business-finance-professions": "Business & finance",
  "health-wellness": "Health & wellness",
  "education-academia": "Education & academia",
  "science-environment": "Science & environment",
  "trades-services": "Skilled trades & services",
};

/**
 * How a template's gallery thumbnail is COMPOSED. Each layout renders a
 * genuinely different miniature structure (masthead, hero arrangement, content
 * blocks) so two templates never look alike just because their colors differ.
 */
export const TEMPLATE_SWATCH_LAYOUTS = [
  "grid", "featured", "list", "masonry", "strip", "editorial", "split", "cover", "centered", "timeline",
] as const;
export type TemplateSwatchLayout = (typeof TEMPLATE_SWATCH_LAYOUTS)[number];

/**
 * Per-template library metadata: which collection it belongs to and how its
 * thumbnail is composed. Kept beside the presets (not inside them) so legacy
 * profession templates and normalized configs stay untouched.
 */
export const STYLE_TEMPLATE_META: Record<StyleTemplateId, { category: TemplateCategoryId; swatch: TemplateSwatchLayout }> = {
  "minimal-index": { category: "minimal-clean", swatch: "list" },
  "paper-fold": { category: "minimal-clean", swatch: "list" },
  "whisper-grid": { category: "minimal-clean", swatch: "grid" },
  "ink-brief": { category: "minimal-clean", swatch: "editorial" },
  "modern-loft": { category: "modern-professional", swatch: "split" },
  "studio-line": { category: "modern-professional", swatch: "split" },
  "meridian-work": { category: "modern-professional", swatch: "timeline" },
  "clear-span": { category: "modern-professional", swatch: "centered" },
  "editorial-press": { category: "editorial-magazine", swatch: "centered" },
  "gazette-noir": { category: "editorial-magazine", swatch: "editorial" },
  "folio-review": { category: "editorial-magazine", swatch: "featured" },
  "broadsheet": { category: "editorial-magazine", swatch: "list" },
  "creative-playbook": { category: "creative-portfolio", swatch: "split" },
  "portfolio-showcase": { category: "creative-portfolio", swatch: "featured" },
  "collage-wall": { category: "creative-portfolio", swatch: "masonry" },
  "marker-pad": { category: "creative-portfolio", swatch: "grid" },
  "circus-pop": { category: "creative-portfolio", swatch: "featured" },
  "developer-term": { category: "developer-technology", swatch: "grid" },
  "kernel-dark": { category: "developer-technology", swatch: "list" },
  "api-notes": { category: "developer-technology", swatch: "list" },
  "silicon-slate": { category: "developer-technology", swatch: "split" },
  "designer-desk": { category: "designer-portfolio", swatch: "cover" },
  "grid-pencil": { category: "designer-portfolio", swatch: "grid" },
  "velvet-type": { category: "designer-portfolio", swatch: "centered" },
  "photography-frame": { category: "photography", swatch: "masonry" },
  "silver-halide": { category: "photography", swatch: "cover" },
  "daylight-studio": { category: "photography", swatch: "grid" },
  "film-cell": { category: "videography-filmmaking", swatch: "strip" },
  "director-cut": { category: "videography-filmmaking", swatch: "list" },
  "night-screening": { category: "videography-filmmaking", swatch: "strip" },
  "agency-roster": { category: "agency-studio", swatch: "featured" },
  "pitch-deck": { category: "agency-studio", swatch: "centered" },
  "collective-works": { category: "agency-studio", swatch: "split" },
  "corporate-ledger": { category: "corporate-business", swatch: "list" },
  "corner-office": { category: "corporate-business", swatch: "featured" },
  "quarterly": { category: "corporate-business", swatch: "list" },
  "dark-luxury": { category: "dark-luxury", swatch: "cover" },
  "onyx-foil": { category: "dark-luxury", swatch: "cover" },
  "midnight-suite": { category: "dark-luxury", swatch: "centered" },
  "noir-marble": { category: "dark-luxury", swatch: "split" },
  "glassmorphism": { category: "glassmorphism", swatch: "split" },
  "frost-panel": { category: "glassmorphism", swatch: "split" },
  "prism-glass": { category: "glassmorphism", swatch: "centered" },
  "experimental-lab": { category: "interactive-experimental", swatch: "masonry" },
  "interactive": { category: "interactive-experimental", swatch: "grid" },
  "cursor-arcade": { category: "interactive-experimental", swatch: "grid" },
  "kinetic-poster": { category: "interactive-experimental", swatch: "centered" },
  "concrete-plan": { category: "architecture-interior", swatch: "grid" },
  "interior-muse": { category: "architecture-interior", swatch: "cover" },
  "blueprint-room": { category: "architecture-interior", swatch: "timeline" },
  "solo-card": { category: "freelance-personal", swatch: "centered" },
  "one-person-studio": { category: "freelance-personal", swatch: "split" },
  "name-plate": { category: "freelance-personal", swatch: "centered" },
  "open-for-work": { category: "freelance-personal", swatch: "split" },
  // v4 profession families — swatch mirrors each template's lead structure
  "news-anchor-desk": { category: "newsroom-broadcast", swatch: "cover" },
  "broadcast-studio": { category: "newsroom-broadcast", swatch: "split" },
  "field-report-kit": { category: "newsroom-broadcast", swatch: "list" },
  "investigative-dossier": { category: "newsroom-broadcast", swatch: "editorial" },
  "press-photographer": { category: "newsroom-broadcast", swatch: "masonry" },
  "video-journal-cut": { category: "newsroom-broadcast", swatch: "strip" },
  "radio-airwave": { category: "newsroom-broadcast", swatch: "centered" },
  "podcast-atlas": { category: "newsroom-broadcast", swatch: "featured" },
  "newsroom-desk": { category: "newsroom-broadcast", swatch: "timeline" },
  "explainer-brief": { category: "newsroom-broadcast", swatch: "editorial" },
  "byline-media": { category: "newsroom-broadcast", swatch: "grid" },
  "author-folio": { category: "writing-publishing", swatch: "featured" },
  "poet-pages": { category: "writing-publishing", swatch: "list" },
  "copywriter-desk": { category: "writing-publishing", swatch: "split" },
  "tech-doc-hub": { category: "writing-publishing", swatch: "list" },
  "translator-bridge": { category: "writing-publishing", swatch: "grid" },
  "frontend-craft": { category: "technology-professions", swatch: "split" },
  "backend-forge": { category: "technology-professions", swatch: "grid" },
  "mobile-launchpad": { category: "technology-professions", swatch: "centered" },
  "game-dev-arcade": { category: "technology-professions", swatch: "cover" },
  "ai-ml-lab": { category: "technology-professions", swatch: "editorial" },
  "data-notebook": { category: "technology-professions", swatch: "list" },
  "analyst-report": { category: "technology-professions", swatch: "featured" },
  "cyber-shield": { category: "technology-professions", swatch: "list" },
  "devops-pipeline": { category: "technology-professions", swatch: "grid" },
  "product-roadmap": { category: "technology-professions", swatch: "featured" },
  "ux-research-lab": { category: "technology-professions", swatch: "editorial" },
  "civil-works": { category: "engineering-disciplines", swatch: "cover" },
  "mechanical-forge": { category: "engineering-disciplines", swatch: "grid" },
  "electronics-bench": { category: "engineering-disciplines", swatch: "grid" },
  "fine-artist-canvas": { category: "creative-arts-professions", swatch: "masonry" },
  "sculptor-atelier": { category: "creative-arts-professions", swatch: "grid" },
  "digital-artist-lab": { category: "creative-arts-professions", swatch: "cover" },
  "fashion-lookbook": { category: "creative-arts-professions", swatch: "strip" },
  "interior-designer-muse": { category: "creative-arts-professions", swatch: "featured" },
  "industrial-design-lab": { category: "creative-arts-professions", swatch: "grid" },
  "stylist-editorial": { category: "creative-arts-professions", swatch: "masonry" },
  "beauty-bar": { category: "creative-arts-professions", swatch: "split" },
  "pattern-maker-textile": { category: "creative-arts-professions", swatch: "grid" },
  "musician-stage": { category: "performing-arts", swatch: "strip" },
  "actor-callboard": { category: "performing-arts", swatch: "featured" },
  "voice-booth": { category: "performing-arts", swatch: "grid" },
  "dancer-stage": { category: "performing-arts", swatch: "masonry" },
  "filmmaker-cut": { category: "performing-arts", swatch: "cover" },
  "video-editor-suite": { category: "performing-arts", swatch: "grid" },
  "sound-booth": { category: "performing-arts", swatch: "list" },
  "casting-desk": { category: "performing-arts", swatch: "centered" },
  "consultant-suite": { category: "business-finance-professions", swatch: "split" },
  "founder-ventures": { category: "business-finance-professions", swatch: "centered" },
  "finance-ledger": { category: "business-finance-professions", swatch: "list" },
  "realestate-listing": { category: "business-finance-professions", swatch: "cover" },
  "legal-chambers": { category: "business-finance-professions", swatch: "list" },
  "event-atelier": { category: "business-finance-professions", swatch: "masonry" },
  "marketer-funnel": { category: "business-finance-professions", swatch: "featured" },
  "doctor-clinic": { category: "health-wellness", swatch: "split" },
  "nurse-care": { category: "health-wellness", swatch: "centered" },
  "physio-motion": { category: "health-wellness", swatch: "cover" },
  "dietitian-plate": { category: "health-wellness", swatch: "split" },
  "therapy-practice": { category: "health-wellness", swatch: "centered" },
  "teacher-classroom": { category: "education-academia", swatch: "centered" },
  "professor-lecture": { category: "education-academia", swatch: "editorial" },
  "scholar-thesis": { category: "education-academia", swatch: "list" },
  "student-launch": { category: "education-academia", swatch: "centered" },
  "scientist-lab": { category: "science-environment", swatch: "split" },
  "eco-field": { category: "science-environment", swatch: "cover" },
  "agro-harvest": { category: "science-environment", swatch: "masonry" },
  "chef-table": { category: "trades-services", swatch: "cover" },
  "baker-oven": { category: "trades-services", swatch: "grid" },
  "tailor-atelier": { category: "trades-services", swatch: "grid" },
  "barber-chair": { category: "trades-services", swatch: "split" },
  "tattoo-ink": { category: "trades-services", swatch: "masonry" },
  "florist-bloom": { category: "trades-services", swatch: "masonry" },
  "trades-guild": { category: "trades-services", swatch: "list" },
};

const configShape = z.object({
  version: z.union([z.literal(1), z.literal(2)]).default(2),
  template: z.enum(TEMPLATE_IDS),
  /** Website display name shown in the site header/hero. */
  name: z.string().min(1).max(80),
  tagline: z.string().max(160).default(""),
  /** Cover image media override (optional — falls back to profile cover). */
  coverMediaId: z.string().max(64).nullish(),
  /**
   * Branding logo shown in the site masthead (optional — absent = the text
   * site name only, exactly as before). Either an uploaded media asset id
   * (owner-scoped, served through /api/media/<id>/raw) or the built-in BEAN
   * Folio brand mark (logoPreset). Always optional and never forced onto a
   * creator's website; the renderer preserves the image's aspect ratio.
   */
  logoMediaId: z.string().max(64).nullish(),
  logoPreset: z.enum(["bean-folio"]).nullish(),
  theme: themeSchema,
  motion: motionSchema.optional(),
  /**
   * GIFTZ Vanta background engine (M16) — additive, optional. Validated
   * against the motion-engine effect registry in normalizeConfig.
   */
  backgroundEffects: backgroundEffectsSchema.optional(),
  /** Legacy v1 single-page sections. Migrated into `pages` on read. */
  sections: z.array(siteSectionSchema).min(1).max(12).optional(),
  pages: z.array(sitePageSchema).min(1).max(8).optional(),
});

export const siteConfigSchema = configShape.refine(
  (c) => (c.pages && c.pages.length > 0) || (c.sections && c.sections.length > 0),
  { message: "A website needs at least one page or section" }
);

/** Schema output shape (pre-migration). */
type RawSiteConfig = z.infer<typeof siteConfigSchema>;

/**
 * Normalized, runtime-ready config. `pages` is always populated and is the
 * single source of truth for rendering; the legacy top-level `sections`
 * array is consumed by migration.
 */
export interface SiteConfig {
  version: 2;
  template: TemplateId;
  name: string;
  tagline: string;
  coverMediaId?: string | null;
  /** Branding logo — uploaded media id or the built-in BEAN Folio mark. */
  logoMediaId?: string | null;
  logoPreset?: "bean-folio" | null;
  theme: SiteTheme;
  motion: SiteMotion;
  /** Vanta animated background (optional — absent = no background engine). */
  backgroundEffects?: BackgroundEffects;
  pages: SitePage[];
}

/** The built-in BEAN Folio brand mark served from /brand (public, no auth). */
export const BEAN_FOLIO_LOGO_PATH = "/brand/bean-folio-logo.png";

/** Resolve a config's masthead logo to a renderable src, or null when absent. */
export function siteLogoSrc(config: Pick<SiteConfig, "logoMediaId" | "logoPreset"> | null | undefined): string | null {
  if (!config) return null;
  if (config.logoPreset === "bean-folio") return BEAN_FOLIO_LOGO_PATH;
  if (config.logoMediaId && /^[A-Za-z0-9_-]{1,64}$/.test(config.logoMediaId)) {
    return `/api/media/${config.logoMediaId}/raw`;
  }
  return null;
}

/**
 * Resolve the hero cover image override (config.coverMediaId) to a renderable
 * src, or null when absent — callers fall back to the profile cover. Same id
 * validation as siteLogoSrc; ownership is enforced server-side (media raw
 * route + /api/me/site PUT), so an unowned id simply never renders.
 */
export function siteCoverSrc(config: Pick<SiteConfig, "coverMediaId"> | null | undefined): string | null {
  const id = config?.coverMediaId;
  if (id && /^[A-Za-z0-9_-]{1,64}$/.test(id)) return `/api/media/${id}/raw`;
  return null;
}

/**
 * A masthead logo href that is safe to put in an <a>/<img> context: only
 * in-page anchors and absolute http(s) URLs pass; anything else (javascript:,
 * data:, vbscript:, protocol-relative) returns null and the default anchor
 * is used. Applied to hero CTA destinations at render time.
 */
export function safeCtaHref(href: string | null | undefined): string | null {
  const h = (href ?? "").trim();
  if (!h) return null;
  if (h.startsWith("#") && h.length > 1) return h;
  if (/^https?:\/\/[^\s]+$/i.test(h)) return h;
  return null;
}

/** Defensive read helper — never let a missing/legacy `sections` array crash a render. */
export function getVisibleSections(config: SiteConfig | null | undefined, pageId?: string): SiteSection[] {
  if (!config || typeof config !== "object") return [];
  const page = pageId ? config.pages.find((p) => p.id === pageId) : config.pages[0];
  const sections = page?.sections ?? config.pages[0]?.sections ?? [];
  return sections.filter((s) => s && typeof s === "object" && s.visible !== false);
}

/** The first visible page (used when no explicit page is selected). */
export function homePage(config: SiteConfig): SitePage {
  return config.pages.find((p) => p.visible) ?? config.pages[0];
}

/**
 * Minimal seed for a NEW GIFTZ-generated site (independent from the user's
 * portfolio website — a GiftzSite never starts from the portfolio draft).
 * One empty hero on one page with neutral tokens: the site.compose create
 * flow replaces everything, so the seed only has to be a schema-valid,
 * renderable starting point.
 */
export function blankGiftzSeedConfig(name = "New site"): SiteConfig {
  const hero = makeSection("hero") as Extract<SiteSection, { type: "hero" }>;
  hero.title = "{name}";
  const theme = deriveTheme({
    background: "#0d0e12",
    foreground: "#f5f4ef",
    accent: "#d4af6a",
    font: "fraunces",
    radius: "md",
    density: "relaxed",
  });
  return {
    version: 2,
    template: "atelier",
    name,
    tagline: "",
    coverMediaId: null,
    logoMediaId: null,
    logoPreset: null,
    theme,
    motion: defaultMotion(),
    pages: [{ id: "home", name: "Home", visible: true, sections: [hero] }],
  };
}

/** Resolve a section's effective motion (section override wins over site-wide). */
export function sectionMotion(site: SiteMotion, section: SiteSection): SiteMotion {
  const o = section.motion;
  if (!o) return site;
  const preset = o.preset && getMotionPreset(o.preset) ? o.preset : site.preset;
  return {
    ...site,
    enabled: site.enabled && !o.disabled,
    preset,
    duration: o.duration ?? site.duration,
    intensity: o.intensity ?? site.intensity,
    stagger: o.stagger ?? site.stagger,
  };
}

// ------------------------------------------------------------------ section factory

/** Fresh section ids so duplicated presets never share React keys. */
let uid = 0;
function sid(type: string): string {
  uid += 1;
  return `${type}-${Date.now().toString(36)}-${uid}`;
}

export function makeSection(type: SiteSectionType): SiteSection {
  const base = { id: sid(type), visible: true };
  switch (type) {
    case "hero":
      return { ...base, type: "hero", title: "Selected work", subtitle: "", variant: "classic", ctaLabel: "", ctaHref: "" };
    case "about":
      return { ...base, type: "about", title: "About", body: "" };
    case "projects":
      return { ...base, type: "projects", title: "Projects", limit: 6, layout: "grid", category: "" };
    case "featured":
      return { ...base, type: "featured", title: "Featured work", subtitle: "", projectIds: [], layout: "featured" };
    case "reel":
      return { ...base, type: "reel", title: "Video reel", subtitle: "", videos: [], layout: "strip" };
    case "skills":
      return { ...base, type: "skills", title: "Skills & tools" };
    case "stats":
      return { ...base, type: "stats", title: "At a glance" };
    case "collections":
      return { ...base, type: "collections", title: "Collections", limit: 3 };
    case "contact":
      return { ...base, type: "contact", title: "Contact", body: "Available for commissions and collaborations." };
    case "services":
      return { ...base, type: "services", title: "Services", layout: "cards", items: [] };
    case "experience":
      return { ...base, type: "experience", title: "Experience", layout: "timeline", entries: [] };
    case "gallery":
      return { ...base, type: "gallery", title: "Gallery", source: "projects", limit: 9, layout: "masonry" };
    case "testimonials":
      return { ...base, type: "testimonials", title: "Kind words", layout: "cards", items: [] };
    case "process":
      return { ...base, type: "process", title: "Process", layout: "steps", items: [] };
    case "faq":
      return { ...base, type: "faq", title: "FAQ", items: [] };
    case "pricing":
      return { ...base, type: "pricing", title: "Pricing", layout: "cards", tiers: [] };
    case "logos":
      return { ...base, type: "logos", title: "Clients & collaborators", note: "", items: [] };
  }
}

// ------------------------------------------------------------------ design presets (full token sets)

export interface DesignPreset {
  id: string;
  label: string;
  description: string;
  theme: SiteTheme;
  motion?: Partial<SiteMotion>;
}

export function designPresets(): DesignPreset[] {
  return [
    {
      id: "dark-luxury", label: "Dark Luxury", description: "Near-black canvas, champagne accent, grand serif headings.",
      theme: { background: "#0a0a0c", foreground: "#f5f2ea", accent: "#d4af6a", accent2: "#b8925a", surface: "#131318", border: "#2a2a33", muted: "#a5a3a0", focus: "#e8c886", gradient: null, surfaceOpacity: 100, font: "fraunces", headingFont: "fraunces", bodyFont: "geist-sans", radius: "md", density: "relaxed", typeScale: "grand", lineHeight: "normal", letterSpacing: "wide", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "3/2", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "fadeUp", duration: 700, easing: "smooth", intensity: 55 },
    },
    {
      id: "editorial-minimal", label: "Editorial Minimal", description: "Paper white, mono-accent, quiet serif typography.",
      theme: { background: "#faf9f6", foreground: "#111110", accent: "#111110", accent2: "#8a8d93", surface: "#ffffff", border: "#e3e1da", muted: "#6f6d68", focus: "#111110", gradient: null, surfaceOpacity: 100, font: "lora", headingFont: "fraunces", bodyFont: "lora", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "relaxed", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow", columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "3/2", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "blurIn", duration: 500, intensity: 35 },
    },
    {
      id: "creative-brutalist", label: "Creative Brutalist", description: "High contrast, hard edges, oversized mono headings.",
      theme: { background: "#f2f0e9", foreground: "#101010", accent: "#ff4d00", accent2: "#101010", surface: "#ffffff", border: "#101010", muted: "#565550", focus: "#ff4d00", gradient: null, surfaceOpacity: 100, font: "jetbrains-mono", headingFont: "jetbrains-mono", bodyFont: "geist-sans", radius: "none", density: "compact", typeScale: "grand", lineHeight: "tight", letterSpacing: "tight", headingWeight: "bold", contentWidth: "wide", columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "4/3", divider: "accent", pageTransition: "slide", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "fadeUp", duration: 350, easing: "snap", intensity: 30 },
    },
    {
      id: "warm-modern", label: "Warm Modern", description: "Cream canvas, terracotta accent, friendly rounded cards.",
      theme: { background: "#fbf7f0", foreground: "#33291f", accent: "#c46a3a", accent2: "#4f7c5e", surface: "#ffffff", border: "#e8ded0", muted: "#8a7c6c", focus: "#a3522a", gradient: null, surfaceOpacity: 100, font: "figtree", headingFont: "figtree", bodyFont: "figtree", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "4/3", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "fadeUp", duration: 500, intensity: 45 },
    },
    {
      id: "cinematic-portfolio", label: "Cinematic Portfolio", description: "Deep charcoal, widescreen imagery, slow cinematic reveals.",
      theme: { background: "#0d0f12", foreground: "#eef0f2", accent: "#e8bc51", accent2: "#7d9a6d", surface: "#16191e", border: "#272b33", muted: "#9aa0a8", focus: "#f2d076", gradient: null, surfaceOpacity: 100, font: "fraunces", headingFont: "fraunces", bodyFont: "geist-sans", radius: "none", density: "relaxed", typeScale: "grand", lineHeight: "normal", letterSpacing: "wide", headingWeight: "light", contentWidth: "wide", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "16/9", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "cinematic", duration: 850, easing: "drift", intensity: 70 },
    },
    {
      id: "swiss-grid", label: "Swiss Grid", description: "Strict white grid, red accent, bold objective type.",
      theme: { background: "#ffffff", foreground: "#0a0a0a", accent: "#d92b2b", accent2: "#0a0a0a", surface: "#ffffff", border: "#d9d9d9", muted: "#616161", focus: "#d92b2b", gradient: null, surfaceOpacity: 100, font: "inter", headingFont: "inter", bodyFont: "inter", radius: "none", density: "compact", typeScale: "balanced", lineHeight: "tight", letterSpacing: "normal", headingWeight: "bold", contentWidth: "wide", columns: 3, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "1/1", divider: "line", pageTransition: "none", navLayout: "stacked", headingAlign: "left" },
      motion: { preset: "stagger", duration: 400, stagger: 70, easing: "snap" },
    },
    {
      id: "monochrome-studio", label: "Monochrome Studio", description: "Greys only — restrained, documentation-like calm.",
      theme: { background: "#111214", foreground: "#e8e8e8", accent: "#9ba1a6", accent2: "#d4d4d4", surface: "#191b1e", border: "#2c2f33", muted: "#8b9095", focus: "#c2c7cc", gradient: null, surfaceOpacity: 100, font: "hanken-grotesk", headingFont: "hanken-grotesk", bodyFont: "hanken-grotesk", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "outline", linkStyle: "underline", imageRatio: "3/2", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "fadeUp", duration: 500, intensity: 40 },
    },
    {
      id: "vibrant-creative", label: "Vibrant Creative", description: "Warm paper, coral accent, pill buttons, playful energy.",
      theme: { background: "#fdf6ee", foreground: "#1f1a17", accent: "#e2543e", accent2: "#2f7f6f", surface: "#ffffff", border: "#f0e2d2", muted: "#7d7066", focus: "#c23c27", gradient: null, surfaceOpacity: 100, font: "outfit", headingFont: "outfit", bodyFont: "outfit", radius: "full", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold", contentWidth: "regular", columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "4/3", divider: "none", pageTransition: "slide", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "stagger", duration: 450, stagger: 80, intensity: 60 },
    },
    {
      id: "soft-minimal", label: "Soft Minimal", description: "Off-white calm, sage accent, generous breathing room.",
      theme: { background: "#f7f8f7", foreground: "#24312a", accent: "#5e8c74", accent2: "#b0876a", surface: "#ffffff", border: "#e2e8e4", muted: "#75827b", focus: "#3f6e54", gradient: null, surfaceOpacity: 100, font: "karla", headingFont: "karla", bodyFont: "karla", radius: "md", density: "relaxed", typeScale: "intimate", lineHeight: "relaxed", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "3/2", divider: "none", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "fadeUp", duration: 450, intensity: 35 },
    },
    {
      id: "experimental-art-direction", label: "Experimental Art Direction", description: "Violet-black, acid accent, mixed type, mask reveals.",
      theme: { background: "#0b0a10", foreground: "#f2eff8", accent: "#c7f24c", accent2: "#b18cff", surface: "#14121c", border: "#2a2740", muted: "#a29dbb", focus: "#d9fa7a", gradient: null, surfaceOpacity: 100, font: "space-grotesk", headingFont: "space-grotesk", bodyFont: "geist-sans", radius: "none", density: "regular", typeScale: "grand", lineHeight: "tight", letterSpacing: "wide", headingWeight: "bold", contentWidth: "wide", columns: 0, buttonStyle: "outline", linkStyle: "plain", imageRatio: "3/2", divider: "accent", pageTransition: "slide", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "maskReveal", duration: 700, easing: "drift", intensity: 75 },
    },
  ];
}

// ------------------------------------------------------------------ templates

export interface TemplatePreset {
  id: TemplateId;
  label: string;
  description: string;
  /** Profession slugs this template is recommended for (filter chips). */
  professions: string[];
  theme: ThemeInput;
  motion?: Partial<SiteMotion>;
  pages: SitePage[];
}

function tplSection(type: SiteSectionType, overrides: Partial<SiteSection> = {}): SiteSection {
  return { ...makeSection(type), ...overrides, id: sid(type) } as SiteSection;
}

export function templatePresets(): TemplatePreset[] {
  return [
    // ---------------- classic v1 (kept for legacy configs)
    {
      id: "atelier", label: "Atelier (classic)", description: "Editorial serif, warm dark canvas, generous spacing.",
      professions: [],
      theme: { background: "#090a0c", foreground: "#f7f5ef", accent: "#e8bc51", font: "fraunces", radius: "md", density: "relaxed" },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "Studio of {name}", subtitle: "{headline} — {location}" } as Partial<SiteSection>),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        // Featured Work is a REAL editorial showcase (type "featured"): only
        // curated/starred projects render — never a slice of All Projects.
        tplSection("featured", { title: "Featured work", subtitle: "", projectIds: [], layout: "featured" } as Partial<SiteSection>),
        tplSection("projects", { title: "All projects", limit: 12, layout: "grid" } as Partial<SiteSection>),
        tplSection("skills", { title: "Skills & tools" }),
        tplSection("contact", { title: "Contact", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "mono", label: "Mono (classic)", description: "Single column, quiet grey, documentation-like clarity.",
      professions: [],
      theme: { background: "#f7f5ef", foreground: "#090a0c", accent: "#8a8d93", font: "geist-sans", radius: "none", density: "regular" },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}" } as Partial<SiteSection>),
        tplSection("stats", { title: "At a glance" }),
        tplSection("projects", { title: "Projects", limit: 12, layout: "grid" } as Partial<SiteSection>),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Get in touch", body: "" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "gallery", label: "Gallery (classic)", description: "Media-forward grid, deep graphite, minimal chrome.",
      professions: [],
      theme: { background: "#17191d", foreground: "#f7f5ef", accent: "#e8bc51", font: "fraunces", radius: "full", density: "compact" },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}" } as Partial<SiteSection>),
        tplSection("projects", { title: "Latest work", limit: 9, layout: "grid" } as Partial<SiteSection>),
        tplSection("collections", { title: "Collections", limit: 3 } as Partial<SiteSection>),
        tplSection("contact", { title: "Say hello", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---------------- v2 profession templates
    {
      id: "dev-console", label: "Developer Console", description: "Terminal-flavoured dark theme, mono headings, engineering case studies front and centre.",
      professions: ["software-dev"],
      theme: { background: "#0c0e10", foreground: "#e6e8ea", accent: "#3fbf8f", surface: "#12151a", border: "#232a30", muted: "#8d949b", font: "jetbrains-mono", headingFont: "jetbrains-mono", bodyFont: "geist-sans", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 2, buttonStyle: "sharp", linkStyle: "accent", imageRatio: "16/9", divider: "line", pageTransition: "fade" },
      motion: { preset: "stagger", duration: 400, stagger: 60 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}", variant: "classic" } as Partial<SiteSection>),
        tplSection("stats", { title: "Track record" }),
        tplSection("projects", { title: "Engineering work", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("skills", { title: "Stack & tools" }),
        tplSection("experience", { title: "Experience" }),
        tplSection("contact", { title: "Contact", body: "Open to engineering roles and collaborations. {availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "product-studio", label: "Product Studio", description: "Refined dark studio look with featured case studies and a services strip.",
      professions: ["ui-ux", "product-design"],
      theme: { background: "#101113", foreground: "#f4f4f2", accent: "#e8bc51", surface: "#181a1d", border: "#2b2e33", muted: "#9b9d99", font: "inter", headingFont: "inter", bodyFont: "inter", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "4/3", divider: "line", pageTransition: "fade" },
      motion: { preset: "fadeUp", duration: 550 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split" } as Partial<SiteSection>),
        tplSection("projects", { title: "Case studies", limit: 4, layout: "featured" } as Partial<SiteSection>),
        tplSection("services", { title: "What I do" }),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Start a project", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "brand-atelier", label: "Brand Atelier", description: "Editorial serif atelier with a full-bleed cover hero and curated collections.",
      professions: ["graphic-design", "marketing"],
      theme: { background: "#090a0c", foreground: "#f7f5ef", accent: "#e8bc51", surface: "#141519", border: "#26282e", muted: "#a3a094", font: "fraunces", headingFont: "fraunces", bodyFont: "geist-sans", radius: "md", density: "relaxed", typeScale: "grand", lineHeight: "normal", letterSpacing: "wide", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "3/2", divider: "line", pageTransition: "fade" },
      motion: { preset: "maskReveal", duration: 650, intensity: 60 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "Studio of {name}", subtitle: "{headline} — {location}", variant: "cover" } as Partial<SiteSection>),
        tplSection("projects", { title: "Selected identity work", limit: 6, layout: "editorial" } as Partial<SiteSection>),
        tplSection("collections", { title: "Collections", limit: 3 } as Partial<SiteSection>),
        tplSection("about", { title: "The studio", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Commissions", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "lens-gallery", label: "Lens Gallery", description: "Image-first masonry and strips for photographers and filmmakers.",
      professions: ["photography", "film-video"],
      theme: { background: "#0e0e10", foreground: "#f2f1ec", accent: "#d9c9a8", surface: "#151518", border: "#28282c", muted: "#98948c", font: "geist-sans", headingFont: "fraunces", bodyFont: "geist-sans", radius: "none", density: "compact", typeScale: "balanced", lineHeight: "normal", letterSpacing: "wide", headingWeight: "light", contentWidth: "wide", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "3/2", divider: "line", pageTransition: "fade" },
      motion: { preset: "zoom", duration: 600, intensity: 45 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "cover" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Recent frames", limit: 12, layout: "masonry" } as Partial<SiteSection>),
        tplSection("projects", { title: "Series & films", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("contact", { title: "Book a shoot", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "motion-reel", label: "Motion Reel", description: "Cinematic 16:9 reel layout with slow reveals for motion and 3D artists.",
      professions: ["motion-design", "music"],
      theme: { background: "#0a0b0d", foreground: "#f0eee9", accent: "#f0c75e", surface: "#131519", border: "#24272d", muted: "#94928c", font: "geist-sans", headingFont: "fraunces", bodyFont: "geist-sans", radius: "none", density: "regular", typeScale: "grand", lineHeight: "normal", letterSpacing: "wide", headingWeight: "light", contentWidth: "wide", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "16/9", divider: "line", pageTransition: "fade" },
      motion: { preset: "cinematic", duration: 850, easing: "drift", intensity: 70 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}", variant: "centered" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Reel", limit: 8, layout: "strip" } as Partial<SiteSection>),
        tplSection("projects", { title: "Projects", limit: 6, layout: "featured" } as Partial<SiteSection>),
        tplSection("skills", { title: "Toolbox" }),
        tplSection("contact", { title: "Let's talk", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "illustration-desk", label: "Illustration Desk", description: "Warm paper desk with a playful masonry wall of illustration work.",
      professions: ["illustration", "art"],
      theme: { background: "#fbf6ec", foreground: "#2d2620", accent: "#d98e4a", surface: "#ffffff", border: "#ecdfca", muted: "#8b7d6d", font: "geist-sans", headingFont: "fraunces", bodyFont: "geist-sans", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "1/1", divider: "none", pageTransition: "slide" },
      motion: { preset: "stagger", duration: 450, stagger: 70, intensity: 55 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "Hi, I'm {name}", subtitle: "{headline}", variant: "split" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Sketch wall", limit: 12, layout: "masonry" } as Partial<SiteSection>),
        tplSection("projects", { title: "Series", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("about", { title: "About me", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Commissions", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "architecture-index", label: "Architecture Index", description: "Precise squared grid, wide tracking, restrained palette for built work.",
      professions: ["architecture", "civil-engineering"],
      theme: { background: "#f4f3f0", foreground: "#17181a", accent: "#8a8d93", surface: "#ffffff", border: "#dcdbd6", muted: "#6f7175", font: "archivo", headingFont: "archivo", bodyFont: "archivo", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "wide", headingWeight: "semibold", contentWidth: "wide", columns: 2, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "1/1", divider: "line", pageTransition: "none" },
      motion: { preset: "fadeUp", duration: 450, intensity: 30 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline} — {location}", variant: "centered" } as Partial<SiteSection>),
        tplSection("projects", { title: "Built work", limit: 8, layout: "grid" } as Partial<SiteSection>),
        tplSection("experience", { title: "Practice history", layout: "rows" } as Partial<SiteSection>),
        tplSection("about", { title: "Approach", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Enquiries", body: "" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "byline-journal", label: "Byline Journal", description: "Narrow editorial column with serif type and a timeline of published work.",
      professions: ["writing", "education"],
      theme: { background: "#fbfaf7", foreground: "#1a1a1a", accent: "#9b2c2c", surface: "#ffffff", border: "#e6e3dc", muted: "#6d6a64", font: "newsreader", headingFont: "newsreader", bodyFont: "newsreader", radius: "none", density: "regular", typeScale: "intimate", lineHeight: "relaxed", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow", columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "3/2", divider: "line", pageTransition: "fade" },
      motion: { preset: "blurIn", duration: 500, intensity: 30 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}", variant: "classic" } as Partial<SiteSection>),
        tplSection("projects", { title: "Selected writing", limit: 8, layout: "list", category: "writing" } as Partial<SiteSection>),
        tplSection("projects", { title: "More stories", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("experience", { title: "Experience & education" }),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Contact", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "growth-consult", label: "Growth Consult", description: "Crisp consultant layout with services, proof and a stats strip.",
      professions: ["marketing"],
      theme: { background: "#ffffff", foreground: "#191c1f", accent: "#b0813c", surface: "#f7f6f3", border: "#e4e2dc", muted: "#6b7076", font: "public-sans", headingFont: "public-sans", bodyFont: "public-sans", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "16/9", divider: "line", pageTransition: "fade" },
      motion: { preset: "fadeUp", duration: 500 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split", ctaLabel: "Book a call" } as Partial<SiteSection>),
        tplSection("stats", { title: "Results" }),
        tplSection("services", { title: "How I help" }),
        tplSection("testimonials", { title: "Client words" }),
        tplSection("experience", { title: "Background", layout: "rows" } as Partial<SiteSection>),
        tplSection("contact", { title: "Get in touch", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "founder-story", label: "Founder Story", description: "Split hero narrative with journey timeline for founders and entrepreneurs.",
      professions: ["marketing", "other"],
      theme: { background: "#fffdf9", foreground: "#20242b", accent: "#3e6b4f", surface: "#ffffff", border: "#e9e6de", muted: "#757b84", font: "geist-sans", headingFont: "fraunces", bodyFont: "geist-sans", radius: "md", density: "relaxed", typeScale: "balanced", lineHeight: "relaxed", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "3/2", divider: "none", pageTransition: "fade" },
      motion: { preset: "fadeUp", duration: 550 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}", variant: "split", ctaLabel: "Read my story" } as Partial<SiteSection>),
        tplSection("about", { title: "The story so far", body: "{bio}" } as Partial<SiteSection>),
        tplSection("experience", { title: "Ventures" }),
        tplSection("projects", { title: "What I've built", limit: 6, layout: "editorial" } as Partial<SiteSection>),
        tplSection("contact", { title: "Say hello", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "sound-room", label: "Sound Room", description: "Dark listening-room aesthetic with a horizontal reel strip.",
      professions: ["music"],
      theme: { background: "#0b0c0e", foreground: "#efece6", accent: "#d9a85e", surface: "#14151a", border: "#25272c", muted: "#918e86", font: "geist-mono", headingFont: "fraunces", bodyFont: "geist-sans", radius: "md", density: "regular", typeScale: "grand", lineHeight: "normal", letterSpacing: "wide", headingWeight: "light", contentWidth: "wide", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "1/1", divider: "accent", pageTransition: "fade" },
      motion: { preset: "zoom", duration: 600 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Releases & sessions", limit: 10, layout: "strip" } as Partial<SiteSection>),
        tplSection("projects", { title: "Selected work", limit: 6, layout: "featured" } as Partial<SiteSection>),
        tplSection("services", { title: "Sessions", layout: "rows" } as Partial<SiteSection>),
        tplSection("contact", { title: "Booking", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "classroom-folio", label: "Classroom Folio", description: "Friendly educator layout with courses-as-services and experience rows.",
      professions: ["education"],
      theme: { background: "#f9f8f4", foreground: "#26301f", accent: "#4f7c5e", surface: "#ffffff", border: "#e4e6da", muted: "#74806c", font: "figtree", headingFont: "figtree", bodyFont: "figtree", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "relaxed", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "underline", imageRatio: "4/3", divider: "line", pageTransition: "fade" },
      motion: { preset: "fadeUp", duration: 450, intensity: 35 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}", variant: "classic" } as Partial<SiteSection>),
        tplSection("services", { title: "Courses & workshops" }),
        tplSection("experience", { title: "Teaching history", layout: "rows" } as Partial<SiteSection>),
        tplSection("skills", { title: "Areas of study" }),
        tplSection("testimonials", { title: "Student feedback" }),
        tplSection("contact", { title: "Office hours", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "polymath-index", label: "Polymath Index", description: "A curated mix for multidisciplinary practices — everything, in balance.",
      professions: ["other", "graphic-design", "film-video"],
      theme: { background: "#101013", foreground: "#efedf3", accent: "#c9a86a", surface: "#17171c", border: "#2a2a32", muted: "#9c99a4", font: "fraunces", headingFont: "fraunces", bodyFont: "geist-sans", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "3/2", divider: "line", pageTransition: "fade" },
      motion: { preset: "maskReveal", duration: 600 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}", variant: "split" } as Partial<SiteSection>),
        tplSection("projects", { title: "Selected work", limit: 4, layout: "featured" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Fragments", limit: 8, layout: "masonry" } as Partial<SiteSection>),
        tplSection("services", { title: "Practices" }),
        tplSection("experience", { title: "Path" }),
        tplSection("contact", { title: "Contact", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---------------- v2 style templates (visual genres — professions: [])
    {
      id: "minimal-index", label: "Minimal Index", description: "Near-white canvas, one ink accent, quiet type and generous whitespace.",
      professions: [],
      theme: { background: "#fbfbfa", foreground: "#141413", accent: "#141413", accent2: "#8a8d93", surface: "#ffffff", border: "#e6e5e1", muted: "#6f6e69", focus: "#141413", font: "geist-sans", headingFont: "geist-sans", bodyFont: "geist-sans", codeFont: "geist-mono", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "relaxed", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow", columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "3/2", divider: "line", pageTransition: "none", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "fade-up-soft", duration: 450, intensity: 30 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}" } as Partial<SiteSection>),
        tplSection("projects", { title: "Index", limit: 12, layout: "list" } as Partial<SiteSection>),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        tplSection("skills", { title: "Capabilities" }),
        tplSection("contact", { title: "Contact", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "modern-loft", label: "Modern Loft", description: "Graphite walls with warm copper light — a contemporary loft for modern work.",
      professions: [],
      theme: { background: "#17181b", foreground: "#f1efec", accent: "#d98e4a", accent2: "#c46a3a", surface: "#1f2126", border: "#2e3138", muted: "#9c9a94", focus: "#eab274", font: "inter", headingFont: "inter", bodyFont: "inter", codeFont: "jetbrains-mono", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "4/3", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "zoom", duration: 550, intensity: 45 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split" } as Partial<SiteSection>),
        tplSection("projects", { title: "Featured work", limit: 4, layout: "featured" } as Partial<SiteSection>),
        tplSection("services", { title: "Services" }),
        tplSection("experience", { title: "Experience" }),
        tplSection("contact", { title: "Get in touch", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "editorial-press", label: "Editorial Press", description: "Magazine masthead energy — grand serif headlines, press-red accents, bylines.",
      professions: [],
      theme: { background: "#faf7f1", foreground: "#1c1a17", accent: "#a03123", accent2: "#1c1a17", surface: "#ffffff", border: "#e5e0d5", muted: "#6e6a62", focus: "#a03123", font: "fraunces", headingFont: "fraunces", bodyFont: "newsreader", accentFont: "inter", codeFont: "geist-mono", radius: "none", density: "regular", typeScale: "grand", lineHeight: "normal", letterSpacing: "wide", headingWeight: "bold", contentWidth: "narrow", columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "3/2", divider: "line", pageTransition: "fade", navLayout: "stacked", headingAlign: "left" },
      motion: { preset: "maskReveal", duration: 650, intensity: 60 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered" } as Partial<SiteSection>),
        tplSection("projects", { title: "Featured stories", limit: 6, layout: "list" } as Partial<SiteSection>),
        tplSection("projects", { title: "The archive", limit: 12, layout: "grid" } as Partial<SiteSection>),
        tplSection("experience", { title: "Masthead", layout: "rows" } as Partial<SiteSection>),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Letters to the editor", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "creative-playbook", label: "Creative Playbook", description: "Bold coral and green, pill buttons, playful staggered layouts that refuse to sit still.",
      professions: [],
      theme: { background: "#fbf2e6", foreground: "#26201a", accent: "#e0603c", accent2: "#3f8f5f", surface: "#ffffff", border: "#f0e0cd", muted: "#7d7266", focus: "#c74a2a", font: "outfit", headingFont: "bricolage-grotesque", bodyFont: "outfit", accentFont: "jetbrains-mono", codeFont: "jetbrains-mono", radius: "full", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold", contentWidth: "regular", columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "4/3", divider: "none", pageTransition: "slide", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "stagger", duration: 450, stagger: 80, easing: "snap", intensity: 60, microInteractions: "hover-tilt" },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "Hey, I'm {name}", subtitle: "{headline}", variant: "split", ctaLabel: "See the work" } as Partial<SiteSection>),
        tplSection("projects", { title: "The playbook", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Fragments & doodles", limit: 12, layout: "masonry" } as Partial<SiteSection>),
        tplSection("services", { title: "Ways to play" }),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Say hi", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "developer-term", label: "Developer Terminal", description: "Phosphor green on a dark console — mono headings, sharp corners, typed-out reveals.",
      professions: [],
      theme: { background: "#0a0f0a", foreground: "#d6e4d6", accent: "#4ecf6e", accent2: "#b8cf8a", surface: "#101710", border: "#1f2e1f", muted: "#7d937d", focus: "#6fe08a", font: "jetbrains-mono", headingFont: "jetbrains-mono", bodyFont: "geist-sans", accentFont: "vt323", codeFont: "jetbrains-mono", radius: "none", density: "compact", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "sharp", linkStyle: "accent", imageRatio: "16/9", divider: "line", pageTransition: "none", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "type-steps", duration: 500, intensity: 40 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}" } as Partial<SiteSection>),
        tplSection("stats", { title: "Track record" }),
        tplSection("projects", { title: "Builds & experiments", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("skills", { title: "Stack" }),
        tplSection("experience", { title: "Log" }),
        tplSection("contact", { title: "Ping me", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "designer-desk", label: "Designer Desk", description: "An elegant serif-and-sans desk — featured case studies, burnt sienna, calm reveals.",
      professions: [],
      theme: { background: "#f4f1ea", foreground: "#221f1b", accent: "#a4552e", accent2: "#566246", surface: "#fbfaf7", border: "#e3ded2", muted: "#79736a", focus: "#a4552e", font: "fraunces", headingFont: "fraunces", bodyFont: "geist-sans", accentFont: "inter", codeFont: "geist-mono", radius: "md", density: "regular", typeScale: "grand", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "4/3", divider: "none", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "maskReveal", duration: 600, easing: "drift", intensity: 55 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "cover" } as Partial<SiteSection>),
        tplSection("projects", { title: "Selected case studies", limit: 4, layout: "featured" } as Partial<SiteSection>),
        tplSection("collections", { title: "Collections", limit: 3 } as Partial<SiteSection>),
        tplSection("services", { title: "Design services" }),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Start a project", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "photography-frame", label: "Photography Frame", description: "A dark neutral gallery wall — wide masonry frames, outline chrome, quiet zooms.",
      professions: [],
      theme: { background: "#121315", foreground: "#eceae6", accent: "#cfc8bc", accent2: "#8f8a80", surface: "#191a1d", border: "#2b2d31", muted: "#999489", focus: "#efece4", font: "tenor-sans", headingFont: "tenor-sans", bodyFont: "geist-sans", accentFont: "ibm-plex-mono", codeFont: "ibm-plex-mono", radius: "none", density: "compact", typeScale: "balanced", lineHeight: "normal", letterSpacing: "wide", headingWeight: "light", contentWidth: "wide", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "3/2", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "center" },
      motion: { preset: "media-zoom-slow", duration: 700, intensity: 50 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "cover" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Frames", limit: 12, layout: "masonry" } as Partial<SiteSection>),
        tplSection("projects", { title: "Series", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("collections", { title: "Collections", limit: 3 } as Partial<SiteSection>),
        tplSection("contact", { title: "Book a sitting", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "agency-roster", label: "Agency Roster", description: "Confident agency energy — bold berry accent, staggered grids, services up front.",
      professions: [],
      theme: { background: "#f7f6f3", foreground: "#191a1c", accent: "#b0325f", accent2: "#1c1d20", surface: "#ffffff", border: "#e2e1dc", muted: "#6e6f73", focus: "#b0325f", font: "space-grotesk", headingFont: "space-grotesk", bodyFont: "inter", codeFont: "jetbrains-mono", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold", contentWidth: "wide", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "16/9", divider: "line", pageTransition: "slide", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "stagger-scale", duration: 500, stagger: 70, intensity: 55 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split", ctaLabel: "Start a project" } as Partial<SiteSection>),
        tplSection("services", { title: "What we do" }),
        tplSection("skills", { title: "Capabilities" }),
        tplSection("projects", { title: "Client work", limit: 6, layout: "featured" } as Partial<SiteSection>),
        tplSection("stats", { title: "By the numbers" }),
        tplSection("testimonials", { title: "Client words" }),
        tplSection("contact", { title: "Work with us", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "corporate-ledger", label: "Corporate Ledger", description: "Structured and trustworthy — charcoal ink, one serious green, clean ruled dividers.",
      professions: [],
      theme: { background: "#f8f8f7", foreground: "#23262a", accent: "#2f5d50", accent2: "#23262a", surface: "#ffffff", border: "#dcdedb", muted: "#6c7176", focus: "#2f5d50", font: "public-sans", headingFont: "public-sans", bodyFont: "public-sans", codeFont: "ibm-plex-mono", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "16/9", divider: "line", pageTransition: "none", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "fade-only", duration: 450, intensity: 25, once: true },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "classic" } as Partial<SiteSection>),
        tplSection("services", { title: "Practice areas", layout: "rows" } as Partial<SiteSection>),
        tplSection("stats", { title: "Track record" }),
        tplSection("experience", { title: "Background", layout: "rows" } as Partial<SiteSection>),
        tplSection("testimonials", { title: "References" }),
        tplSection("contact", { title: "Contact", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "dark-luxury", label: "Dark Luxury", description: "Obsidian and champagne gold — grand serif display for a flagship presence.",
      professions: [],
      theme: { background: "#090a0c", foreground: "#f5f2ea", accent: "#e8bc51", accent2: "#b8925a", surface: "#121317", border: "#26272e", muted: "#a29e94", focus: "#f0cf87", font: "fraunces", headingFont: "fraunces", bodyFont: "geist-sans", accentFont: "italiana", codeFont: "geist-mono", radius: "md", density: "relaxed", typeScale: "grand", lineHeight: "normal", letterSpacing: "wide", headingWeight: "light", contentWidth: "regular", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "3/2", divider: "accent", pageTransition: "fade", navLayout: "centered", headingAlign: "center" },
      motion: { preset: "maskReveal", duration: 750, easing: "gentle", intensity: 45 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "Studio of {name}", subtitle: "{tagline} — {location}", variant: "cover" } as Partial<SiteSection>),
        tplSection("projects", { title: "Signature work", limit: 4, layout: "featured" } as Partial<SiteSection>),
        tplSection("collections", { title: "Collections", limit: 3 } as Partial<SiteSection>),
        tplSection("about", { title: "The house", body: "{bio}" } as Partial<SiteSection>),
        tplSection("services", { title: "Offerings" }),
        tplSection("contact", { title: "Enquiries", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "glassmorphism", label: "Glassmorphism", description: "Frosted glass cards floating over a warm dusk gradient — soft depth everywhere.",
      professions: [],
      theme: {
        background: "#1c1a19", foreground: "#f4f1ea", accent: "#e8bc51", accent2: "#d98e6a", surface: "#26221f", border: "#efe8da", muted: "#b5aea2", focus: "#f0cf87",
        gradient: { from: "#1c1a19", to: "#4a3b2c", angle: 165 },
        surfaceOpacity: 55,
        font: "manrope", headingFont: "manrope", bodyFont: "manrope", accentFont: "inter", codeFont: "jetbrains-mono",
        radius: "full", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "4/3", divider: "none", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
        glass: { enabled: true, preset: "dark", targets: { nav: true, cards: true, buttons: true }, blur: 22, opacity: 38, tint: "#26221f", borderOpacity: 45, borderWidth: 1, highlight: 55, shadow: 45, gradient: true },
      },
      motion: { preset: "blur-up", duration: 600, easing: "gentle", intensity: 50 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split" } as Partial<SiteSection>),
        tplSection("projects", { title: "Selected work", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("services", { title: "Services" }),
        tplSection("skills", { title: "Toolkit" }),
        tplSection("contact", { title: "Say hello", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "experimental-lab", label: "Experimental Lab", description: "Bone-and-coral duotone lab — centred type, stacked nav, magnetic hover physics.",
      professions: [],
      theme: { background: "#f2ede3", foreground: "#121212", accent: "#ff5c38", accent2: "#121212", surface: "#faf7f0", border: "#121212", muted: "#5c574e", focus: "#ff5c38", font: "syne", headingFont: "syne", bodyFont: "space-grotesk", accentFont: "space-mono", codeFont: "space-mono", radius: "none", density: "compact", typeScale: "grand", lineHeight: "tight", letterSpacing: "wide", headingWeight: "bold", contentWidth: "wide", columns: 3, buttonStyle: "sharp", linkStyle: "plain", imageRatio: "1/1", divider: "accent", pageTransition: "slide", navLayout: "stacked", headingAlign: "center" },
      motion: { preset: "rotate-in", duration: 550, easing: "snap", intensity: 80, microInteractions: "hover-magnet", background: "bg-glow-pulse" },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline} — {location}", variant: "centered" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Lab notes", limit: 9, layout: "masonry" } as Partial<SiteSection>),
        tplSection("projects", { title: "Experiments", limit: 6, layout: "editorial" } as Partial<SiteSection>),
        tplSection("skills", { title: "Apparatus" }),
        tplSection("stats", { title: "Findings" }),
        tplSection("contact", { title: "Open a channel", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "portfolio-showcase", label: "Portfolio Showcase", description: "A gallery built for finished work — wide 16:9 frames, featured case studies, unhurried cinematic reveals.",
      professions: [],
      theme: { background: "#101113", foreground: "#f0eee9", accent: "#d4a851", accent2: "#8f8a7f", surface: "#181a1e", border: "#2a2d33", muted: "#9a968c", focus: "#e5c878", font: "fraunces", headingFont: "fraunces", bodyFont: "geist-sans", accentFont: "ibm-plex-mono", codeFont: "ibm-plex-mono", radius: "md", density: "regular", typeScale: "grand", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "wide", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "16/9", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "media-cinema-open", duration: 700, intensity: 55 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "cover" } as Partial<SiteSection>),
        tplSection("projects", { title: "Showcase", limit: 6, layout: "featured" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Gallery wall", limit: 12, layout: "masonry" } as Partial<SiteSection>),
        tplSection("testimonials", { title: "Kind words" } as Partial<SiteSection>),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Commission work", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "interactive", label: "Interactive", description: "Alive under the cursor — breathing aurora backdrop, springy pill buttons, scroll-triggered cards with tilt physics.",
      professions: [],
      theme: { background: "#0d0f14", foreground: "#eef0f4", accent: "#ef6c4d", accent2: "#4fc38a", surface: "#151823", border: "#262b3a", muted: "#9aa0ae", focus: "#ff8f6b", font: "bricolage-grotesque", headingFont: "bricolage-grotesque", bodyFont: "outfit", accentFont: "jetbrains-mono", codeFont: "jetbrains-mono", radius: "full", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold", contentWidth: "regular", columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "4/3", divider: "none", pageTransition: "rise", navLayout: "inline", headingAlign: "center" },
      motion: { preset: "stagger-scale", duration: 520, stagger: 85, easing: "snap", intensity: 65, microInteractions: "hover-tilt", hoverEffects: true, background: "bg-aurora-soft" },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "Hey, I'm {name}", subtitle: "{tagline}", variant: "split", ctaLabel: "Explore the work" } as Partial<SiteSection>),
        tplSection("projects", { title: "Playground", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("skills", { title: "Toolkit" } as Partial<SiteSection>),
        tplSection("stats", { title: "By the numbers" } as Partial<SiteSection>),
        tplSection("testimonials", { title: "What people say" } as Partial<SiteSection>),
        tplSection("contact", { title: "Let's talk", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---------------- v3 style templates — library expansion (40 designs, 15 collections)

    // ---- Minimal & clean
    {
      id: "paper-fold", label: "Paper Fold", description: "Crisp paper-white folds with hairline rules, a numbered index and quiet grotesk type.",
      professions: [],
      theme: { background: "#f6f5f2", foreground: "#17181a", accent: "#4a4f3d", accent2: "#8a8d80", surface: "#ffffff", border: "#e3e1da", muted: "#6f6e68", focus: "#4a4f3d", font: "schibsted-grotesk", headingFont: "schibsted-grotesk", bodyFont: "lora", accentFont: "ibm-plex-mono", codeFont: "ibm-plex-mono", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "relaxed", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow", columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "3/2", divider: "line", pageTransition: "none", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "fade-up-soft", duration: 400, intensity: 25, once: true },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}" } as Partial<SiteSection>),
        tplSection("projects", { title: "Index", limit: 10, layout: "list" } as Partial<SiteSection>),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Correspondence", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "whisper-grid", label: "Whisper Grid", description: "An ultra-light two-column grid with sage accents and generous breathing room.",
      professions: [],
      theme: { background: "#fcfcfb", foreground: "#26262b", accent: "#7a7d68", accent2: "#a8aa9a", surface: "#ffffff", border: "#ecece6", muted: "#85857f", focus: "#7a7d68", font: "jost", headingFont: "jost", bodyFont: "hanken-grotesk", accentFont: "jost", codeFont: "geist-mono", radius: "md", density: "relaxed", typeScale: "balanced", lineHeight: "relaxed", letterSpacing: "normal", headingWeight: "light", contentWidth: "regular", columns: 2, buttonStyle: "outline", linkStyle: "accent", imageRatio: "4/3", divider: "none", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "gentle-appear", duration: 500, easing: "gentle", intensity: 30 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered" } as Partial<SiteSection>),
        tplSection("skills", { title: "What I do" }),
        tplSection("projects", { title: "Selected work", limit: 8, layout: "grid" } as Partial<SiteSection>),
        tplSection("collections", { title: "Collections", limit: 2 } as Partial<SiteSection>),
        tplSection("contact", { title: "Say hello", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "ink-brief", label: "Ink Brief", description: "A single narrow brief column — mono metadata, rust accents, reading-first rhythm.",
      professions: [],
      theme: { background: "#f4f4f2", foreground: "#1c1e21", accent: "#b3542d", accent2: "#1c1e21", surface: "#fbfbf9", border: "#e0ded8", muted: "#75736c", focus: "#b3542d", font: "source-serif-4", headingFont: "source-serif-4", bodyFont: "source-serif-4", accentFont: "ibm-plex-mono", codeFont: "ibm-plex-mono", radius: "none", density: "regular", typeScale: "intimate", lineHeight: "relaxed", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow", columns: 0, buttonStyle: "sharp", linkStyle: "accent", imageRatio: "3/2", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "kern-in", duration: 480, intensity: 35 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}" } as Partial<SiteSection>),
        tplSection("about", { title: "Brief", body: "{bio}" } as Partial<SiteSection>),
        tplSection("projects", { title: "Matters", limit: 6, layout: "list" } as Partial<SiteSection>),
        tplSection("experience", { title: "Record", layout: "rows" } as Partial<SiteSection>),
        tplSection("contact", { title: "Write to me", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Modern professional
    {
      id: "studio-line", label: "Studio Line", description: "Slate-ink professionalism on light grey — split hero, amber CTA, services as rows.",
      professions: [],
      theme: { background: "#f5f6f7", foreground: "#23272c", accent: "#c98a2b", accent2: "#23272c", surface: "#ffffff", border: "#e1e4e7", muted: "#6b7178", focus: "#c98a2b", font: "inter", headingFont: "inter-tight", bodyFont: "inter", accentFont: "inter", codeFont: "jetbrains-mono", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "16/9", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "executive-fade", duration: 500, intensity: 35 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split", ctaLabel: "Work with me" } as Partial<SiteSection>),
        tplSection("services", { title: "Services", layout: "rows" } as Partial<SiteSection>),
        tplSection("projects", { title: "Featured engagements", limit: 4, layout: "featured" } as Partial<SiteSection>),
        tplSection("stats", { title: "Track record" }),
        tplSection("contact", { title: "Book an intro call", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "meridian-work", label: "Meridian Work", description: "Warm grey canvas with copper accents and a proper career timeline.",
      professions: [],
      theme: { background: "#edeae5", foreground: "#26231f", accent: "#a05c2c", accent2: "#26231f", surface: "#f8f6f2", border: "#ddd8cf", muted: "#756f66", focus: "#a05c2c", font: "archivo", headingFont: "archivo", bodyFont: "work-sans", accentFont: "archivo", codeFont: "roboto-mono", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "underline", imageRatio: "4/3", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "section-bridge", duration: 550, intensity: 40 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline} — {location}" } as Partial<SiteSection>),
        tplSection("projects", { title: "Selected work", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("experience", { title: "Career", layout: "timeline" } as Partial<SiteSection>),
        tplSection("skills", { title: "Strengths" }),
        tplSection("testimonials", { title: "References" }),
        tplSection("contact", { title: "Contact", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "clear-span", label: "Clearspan", description: "Wide, airy white expanse with teal-green accents and a big confident type scale.",
      professions: [],
      theme: { background: "#ffffff", foreground: "#101214", accent: "#0f766e", accent2: "#134e4a", surface: "#f6f8f8", border: "#e2e8e7", muted: "#5f6b6a", focus: "#0f766e", font: "public-sans", headingFont: "red-hat-display", bodyFont: "public-sans", accentFont: "public-sans", codeFont: "ibm-plex-mono", radius: "md", density: "relaxed", typeScale: "grand", lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold", contentWidth: "wide", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "16/9", divider: "none", pageTransition: "zoom", navLayout: "inline", headingAlign: "center" },
      motion: { preset: "pop", duration: 480, easing: "snap", intensity: 45 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered", ctaLabel: "See the work" } as Partial<SiteSection>),
        tplSection("projects", { title: "Work", limit: 9, layout: "grid" } as Partial<SiteSection>),
        tplSection("services", { title: "How I help" }),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Get in touch", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Editorial & magazine
    {
      id: "gazette-noir", label: "Gazette Noir", description: "Near-black newsprint with bone-white serif headlines and red-ink accents.",
      professions: [],
      theme: { background: "#121110", foreground: "#ece7dd", accent: "#c0392b", accent2: "#8f8778", surface: "#1a1917", border: "#2c2a25", muted: "#9a9384", focus: "#c0392b", font: "playfair-display", headingFont: "playfair-display", bodyFont: "newsreader", accentFont: "ibm-plex-mono", codeFont: "ibm-plex-mono", radius: "none", density: "regular", typeScale: "grand", lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold", contentWidth: "narrow", columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "3/2", divider: "line", pageTransition: "fade", navLayout: "stacked", headingAlign: "left" },
      motion: { preset: "word-rise", duration: 550, intensity: 45 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered" } as Partial<SiteSection>),
        tplSection("projects", { title: "Top stories", limit: 8, layout: "list" } as Partial<SiteSection>),
        tplSection("projects", { title: "The archive", limit: 12, layout: "grid" } as Partial<SiteSection>),
        tplSection("experience", { title: "Masthead", layout: "rows" } as Partial<SiteSection>),
        tplSection("contact", { title: "Letters", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "folio-review", label: "Folio Review", description: "A cream review-journal with italic serif voice, bronze accents and essay-like layouts.",
      professions: [],
      theme: { background: "#f8f4ea", foreground: "#22201b", accent: "#8c6d46", accent2: "#22201b", surface: "#fdfaf3", border: "#e7dfcd", muted: "#7a7466", focus: "#8c6d46", font: "cormorant-garamond", headingFont: "cormorant-garamond", bodyFont: "spectral", accentFont: "cormorant-garamond", codeFont: "geist-mono", radius: "none", density: "relaxed", typeScale: "grand", lineHeight: "relaxed", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow", columns: 0, buttonStyle: "outline", linkStyle: "underline", imageRatio: "3/2", divider: "line", pageTransition: "fade", navLayout: "stacked", headingAlign: "left" },
      motion: { preset: "serif-rise", duration: 600, easing: "gentle", intensity: 40 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}" } as Partial<SiteSection>),
        tplSection("about", { title: "The review", body: "{bio}" } as Partial<SiteSection>),
        tplSection("projects", { title: "Essays & features", limit: 6, layout: "editorial" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Plates", limit: 8, layout: "masonry" } as Partial<SiteSection>),
        tplSection("testimonials", { title: "Critical notice" }),
        tplSection("contact", { title: "Submissions", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "broadsheet", label: "Broadsheet", description: "Stacked masthead, ruled columns and deep newspaper green — print discipline online.",
      professions: [],
      theme: { background: "#fbf9f4", foreground: "#191919", accent: "#1f4f3f", accent2: "#191919", surface: "#ffffff", border: "#e4e1d7", muted: "#6d6d66", focus: "#1f4f3f", font: "neuton", headingFont: "neuton", bodyFont: "pt-serif", accentFont: "newsreader", codeFont: "courier-prime", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold", contentWidth: "regular", columns: 2, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "3/2", divider: "line", pageTransition: "none", navLayout: "stacked", headingAlign: "left" },
      motion: { preset: "line-mask", duration: 500, intensity: 35 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}" } as Partial<SiteSection>),
        tplSection("projects", { title: "This week", limit: 8, layout: "grid" } as Partial<SiteSection>),
        tplSection("collections", { title: "Sections", limit: 3 } as Partial<SiteSection>),
        tplSection("services", { title: "Services", layout: "rows" } as Partial<SiteSection>),
        tplSection("contact", { title: "Newsroom contact", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Creative portfolio
    {
      id: "collage-wall", label: "Collage Wall", description: "Torn-paper collage energy — cream base, coral and mustard blocks, masonry wall of work.",
      professions: [],
      theme: { background: "#f6ead8", foreground: "#33261d", accent: "#e2573d", accent2: "#d9a031", surface: "#fff8ee", border: "#ecd9bd", muted: "#8a7663", focus: "#e2573d", font: "bricolage-grotesque", headingFont: "bricolage-grotesque", bodyFont: "dm-sans", accentFont: "space-mono", codeFont: "space-mono", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold", contentWidth: "wide", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "1/1", divider: "none", pageTransition: "slide", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "stagger-right", duration: 480, stagger: 75, easing: "snap", intensity: 55 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split" } as Partial<SiteSection>),
        tplSection("gallery", { title: "The wall", limit: 12, layout: "masonry" } as Partial<SiteSection>),
        tplSection("projects", { title: "Projects", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Collaborate", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "marker-pad", label: "Marker Pad", description: "Sketchbook grid paper, thick ink borders and highlighter-yellow marks.",
      professions: [],
      theme: { background: "#fffdf5", foreground: "#17161a", accent: "#f2c811", accent2: "#17161a", surface: "#ffffff", border: "#17161a", muted: "#6d6c66", focus: "#17161a", font: "anton", headingFont: "anton", bodyFont: "space-grotesk", accentFont: "space-mono", codeFont: "space-mono", radius: "none", density: "regular", typeScale: "grand", lineHeight: "tight", letterSpacing: "normal", headingWeight: "bold", contentWidth: "regular", columns: 0, buttonStyle: "sharp", linkStyle: "plain", imageRatio: "4/3", divider: "line", pageTransition: "slide", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "crisp-pop", duration: 420, easing: "snap", intensity: 60 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}", variant: "centered" } as Partial<SiteSection>),
        tplSection("projects", { title: "Sketches → shipped", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("skills", { title: "Materials" }),
        tplSection("stats", { title: "Margin notes" }),
        tplSection("contact", { title: "Pass me the pen", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "circus-pop", label: "Circus Pop", description: "Saturated pop-art palette — coral pink on butter, pill buttons, playful featured blocks.",
      professions: [],
      theme: { background: "#fff1e6", foreground: "#33161f", accent: "#e4497c", accent2: "#f2a03d", surface: "#ffffff", border: "#ffd9c2", muted: "#96666f", focus: "#e4497c", font: "unbounded", headingFont: "unbounded", bodyFont: "nunito-sans", accentFont: "unbounded", codeFont: "jetbrains-mono", radius: "full", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold", contentWidth: "regular", columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "4/3", divider: "none", pageTransition: "rise", navLayout: "inline", headingAlign: "center" },
      motion: { preset: "domino", duration: 500, stagger: 90, easing: "snap", intensity: 60 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split", ctaLabel: "Step right up" } as Partial<SiteSection>),
        tplSection("projects", { title: "Headliners", limit: 3, layout: "featured" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Stickers", limit: 8, layout: "strip" } as Partial<SiteSection>),
        tplSection("testimonials", { title: "Applause" }),
        tplSection("contact", { title: "Join the show", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Developer & technology
    {
      id: "kernel-dark", label: "Kernel Log", description: "Low-glare IDE dark, muted terminal green, compact mono density for engineers.",
      professions: [],
      theme: { background: "#0d1112", foreground: "#c8d3d1", accent: "#58a662", accent2: "#8ab48f", surface: "#121819", border: "#1f292b", muted: "#7d8c89", focus: "#6fbf7a", font: "fira-code", headingFont: "fira-code", bodyFont: "geist-sans", accentFont: "fira-code", codeFont: "fira-code", radius: "none", density: "compact", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "sharp", linkStyle: "accent", imageRatio: "16/9", divider: "line", pageTransition: "none", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "type-steps", duration: 450, intensity: 35 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}" } as Partial<SiteSection>),
        tplSection("projects", { title: "Commits", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("skills", { title: "Stack" }),
        tplSection("experience", { title: "History", layout: "timeline" } as Partial<SiteSection>),
        tplSection("contact", { title: "Reach me", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "api-notes", label: "API Notes", description: "Documentation-style light theme — mono headings, burnt-orange links, spec-like lists.",
      professions: [],
      theme: { background: "#fbfbfa", foreground: "#1f2328", accent: "#9a4a1e", accent2: "#1f2328", surface: "#ffffff", border: "#e6e4df", muted: "#6e7276", focus: "#9a4a1e", font: "source-code-pro", headingFont: "source-code-pro", bodyFont: "source-serif-4", accentFont: "source-code-pro", codeFont: "source-code-pro", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "relaxed", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow", columns: 0, buttonStyle: "sharp", linkStyle: "accent", imageRatio: "16/9", divider: "line", pageTransition: "none", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "fade-only", duration: 400, intensity: 20, once: true },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}" } as Partial<SiteSection>),
        tplSection("skills", { title: "Endpoints I cover" }),
        tplSection("projects", { title: "Written work", limit: 8, layout: "list" } as Partial<SiteSection>),
        tplSection("experience", { title: "Changelog", layout: "rows" } as Partial<SiteSection>),
        tplSection("contact", { title: "Issues & contact", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "silicon-slate", label: "Silicon Slate", description: "Warm slate dark with amber circuit accents — hardware-grade product engineering feel.",
      professions: [],
      theme: { background: "#141519", foreground: "#e3e1dc", accent: "#d9a13b", accent2: "#8f8a80", surface: "#1b1d22", border: "#2a2d34", muted: "#98948b", focus: "#e6b558", font: "sora", headingFont: "sora", bodyFont: "geist-sans", accentFont: "ibm-plex-mono", codeFont: "ibm-plex-mono", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "16/9", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "grid-iris", duration: 600, intensity: 50 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split" } as Partial<SiteSection>),
        tplSection("stats", { title: "Benchmarks" }),
        tplSection("projects", { title: "Builds", limit: 4, layout: "featured" } as Partial<SiteSection>),
        tplSection("experience", { title: "Timeline", layout: "timeline" } as Partial<SiteSection>),
        tplSection("contact", { title: "Signal me", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Designer portfolio
    {
      id: "grid-pencil", label: "Pencil Grid", description: "Draftsman layout — light drafting grey, graphite rules and red-pen accents.",
      professions: [],
      theme: { background: "#f2f2f0", foreground: "#1d1e20", accent: "#cc4433", accent2: "#1d1e20", surface: "#fafaf8", border: "#dcdcd8", muted: "#6f7073", focus: "#cc4433", font: "space-grotesk", headingFont: "space-grotesk", bodyFont: "inter", accentFont: "space-grotesk", codeFont: "roboto-mono", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "wide", headingWeight: "semibold", contentWidth: "regular", columns: 2, buttonStyle: "outline", linkStyle: "accent", imageRatio: "1/1", divider: "line", pageTransition: "slide", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "mask-center", duration: 520, intensity: 45 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}" } as Partial<SiteSection>),
        tplSection("projects", { title: "Drawings", limit: 9, layout: "grid" } as Partial<SiteSection>),
        tplSection("collections", { title: "Sets", limit: 3 } as Partial<SiteSection>),
        tplSection("skills", { title: "Instruments" }),
        tplSection("contact", { title: "Commissions", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "velvet-type", label: "Velvet Type", description: "Deep plum velvet with gold display type — fashion-house drama for type-led designers.",
      professions: [],
      theme: { background: "#241a20", foreground: "#f3ece2", accent: "#d3a550", accent2: "#9c7a3c", surface: "#2d2128", border: "#3c2d36", muted: "#b3a695", focus: "#e6bd68", font: "bodoni-moda", headingFont: "bodoni-moda", bodyFont: "manrope", accentFont: "italiana", codeFont: "geist-mono", radius: "none", density: "relaxed", typeScale: "grand", lineHeight: "normal", letterSpacing: "wide", headingWeight: "light", contentWidth: "regular", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "3/2", divider: "accent", pageTransition: "fade", navLayout: "centered", headingAlign: "center" },
      motion: { preset: "kern-in", duration: 650, easing: "gentle", intensity: 50 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered" } as Partial<SiteSection>),
        tplSection("projects", { title: "Selected type work", limit: 6, layout: "editorial" } as Partial<SiteSection>),
        tplSection("services", { title: "Practice" }),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Enquiries", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Photography
    {
      id: "silver-halide", label: "Silver Halide", description: "Pure black-and-white film — grayscale frames, centered lapidary serif, quiet zooms.",
      professions: [],
      theme: { background: "#101010", foreground: "#ededed", accent: "#bdbdbd", accent2: "#8f8f8f", surface: "#181818", border: "#2a2a2a", muted: "#9a9a9a", focus: "#e0e0e0", font: "marcellus", headingFont: "marcellus", bodyFont: "geist-sans", accentFont: "ibm-plex-mono", codeFont: "ibm-plex-mono", radius: "none", density: "compact", typeScale: "balanced", lineHeight: "normal", letterSpacing: "wide", headingWeight: "light", contentWidth: "wide", columns: 0, buttonStyle: "outline", linkStyle: "underline", imageRatio: "3/2", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "center" },
      motion: { preset: "media-grayscale-in", duration: 650, intensity: 40 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "cover" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Contact sheets", limit: 12, layout: "masonry" } as Partial<SiteSection>),
        tplSection("projects", { title: "Series", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("about", { title: "Darkroom notes", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Prints & bookings", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "daylight-studio", label: "Daylight Studio", description: "A bright white photo studio — huge 3/2 frames, single-weight type, near-zero chrome.",
      professions: [],
      theme: { background: "#ffffff", foreground: "#141517", accent: "#1a1a1a", accent2: "#8f8f8f", surface: "#f7f7f6", border: "#e8e8e6", muted: "#757575", focus: "#1a1a1a", font: "italiana", headingFont: "italiana", bodyFont: "work-sans", accentFont: "questrial", codeFont: "geist-mono", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "wide", headingWeight: "light", contentWidth: "wide", columns: 0, buttonStyle: "outline", linkStyle: "plain", imageRatio: "3/2", divider: "none", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "media-zoom-settle", duration: 600, intensity: 35 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Latest shoots", limit: 9, layout: "grid" } as Partial<SiteSection>),
        tplSection("collections", { title: "Portfolio sets", limit: 3 } as Partial<SiteSection>),
        tplSection("contact", { title: "Book the studio", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Videography & filmmaking
    {
      id: "film-cell", label: "Film Cell", description: "Cinema black with projector-warm amber — sprocket-strip galleries and 16:9 frames.",
      professions: [],
      theme: { background: "#0b0a09", foreground: "#efe9dd", accent: "#e0a33c", accent2: "#9a7a3c", surface: "#151310", border: "#292520", muted: "#a29884", focus: "#eebb5e", font: "bebas-neue", headingFont: "bebas-neue", bodyFont: "spectral", accentFont: "courier-prime", codeFont: "courier-prime", radius: "none", density: "regular", typeScale: "grand", lineHeight: "normal", letterSpacing: "wide", headingWeight: "light", contentWidth: "wide", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "16/9", divider: "accent", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "film-fade", duration: 700, easing: "drift", intensity: 50 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "cover" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Reel strips", limit: 10, layout: "strip" } as Partial<SiteSection>),
        tplSection("projects", { title: "Films", limit: 3, layout: "featured" } as Partial<SiteSection>),
        tplSection("services", { title: "Crew for hire" }),
        tplSection("contact", { title: "Screenings & bookings", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "director-cut", label: "Director's Cut", description: "Slate charcoal with clapperboard bars — works as a dated list, credits as timeline.",
      professions: [],
      theme: { background: "#191b1e", foreground: "#e8e6e1", accent: "#c4553a", accent2: "#8f9296", surface: "#212429", border: "#31353b", muted: "#9b9d9f", focus: "#d96a4d", font: "oswald", headingFont: "oswald", bodyFont: "source-serif-4", accentFont: "ibm-plex-mono", codeFont: "ibm-plex-mono", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "wide", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "sharp", linkStyle: "accent", imageRatio: "16/9", divider: "line", pageTransition: "slide", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "prev-next-slide", duration: 500, intensity: 45 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}" } as Partial<SiteSection>),
        tplSection("projects", { title: "Filmography", limit: 8, layout: "list" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Stills", limit: 8, layout: "masonry" } as Partial<SiteSection>),
        tplSection("experience", { title: "Credits", layout: "timeline" } as Partial<SiteSection>),
        tplSection("contact", { title: "Representation", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "night-screening", label: "Night Screening", description: "Deep aubergine screening room with rose-gold glow — soft crossfades for moving image.",
      professions: [],
      theme: { background: "#170f16", foreground: "#efe6ec", accent: "#d98e6a", accent2: "#b06a8a", surface: "#221522", border: "#382436", muted: "#b39aa8", focus: "#e8a684", font: "dm-serif-display", headingFont: "dm-serif-display", bodyFont: "onest", accentFont: "dm-serif-display", codeFont: "geist-mono", radius: "md", density: "relaxed", typeScale: "grand", lineHeight: "normal", letterSpacing: "normal", headingWeight: "light", contentWidth: "wide", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "16/9", divider: "none", pageTransition: "fade", navLayout: "centered", headingAlign: "center" },
      motion: { preset: "media-crossfade", duration: 700, easing: "gentle", intensity: 45 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Now showing", limit: 6, layout: "strip" } as Partial<SiteSection>),
        tplSection("projects", { title: "Screening archive", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("testimonials", { title: "Festival notes" }),
        tplSection("contact", { title: "Screenings", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Agency & studio
    {
      id: "pitch-deck", label: "Pitch Deck", description: "Agency one-pager energy — massive black display type, marker-orange accents, services up front.",
      professions: [],
      theme: { background: "#ffffff", foreground: "#101012", accent: "#ff5a1f", accent2: "#101012", surface: "#f7f6f4", border: "#e6e4e0", muted: "#6d6d70", focus: "#ff5a1f", font: "archivo-black", headingFont: "archivo-black", bodyFont: "inter-tight", accentFont: "inter-tight", codeFont: "jetbrains-mono", radius: "none", density: "compact", typeScale: "grand", lineHeight: "tight", letterSpacing: "tight", headingWeight: "bold", contentWidth: "wide", columns: 0, buttonStyle: "sharp", linkStyle: "plain", imageRatio: "16/9", divider: "line", pageTransition: "slide", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "headline-mask", duration: 520, easing: "snap", intensity: 60 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered", ctaLabel: "Start a project" } as Partial<SiteSection>),
        tplSection("services", { title: "Capabilities" }),
        tplSection("projects", { title: "Pitches that landed", limit: 4, layout: "featured" } as Partial<SiteSection>),
        tplSection("stats", { title: "Outcomes" }),
        tplSection("testimonials", { title: "Clients" }),
        tplSection("contact", { title: "New business", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "collective-works", label: "Collective Works", description: "Warm sand and espresso duo-tone — a studio roster with service rows and editorial grids.",
      professions: [],
      theme: { background: "#efe9df", foreground: "#2a251f", accent: "#6d4f3a", accent2: "#a08363", surface: "#f9f5ee", border: "#ddd2c0", muted: "#7d7263", focus: "#6d4f3a", font: "familjen-grotesk", headingFont: "familjen-grotesk", bodyFont: "lora", accentFont: "familjen-grotesk", codeFont: "roboto-mono", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "underline", imageRatio: "4/3", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "stagger-left", duration: 500, stagger: 70, intensity: 45 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split" } as Partial<SiteSection>),
        tplSection("services", { title: "What the studio does", layout: "rows" } as Partial<SiteSection>),
        tplSection("projects", { title: "Collective works", limit: 8, layout: "grid" } as Partial<SiteSection>),
        tplSection("experience", { title: "Studio history", layout: "rows" } as Partial<SiteSection>),
        tplSection("contact", { title: "Brief us", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Corporate & business
    {
      id: "corner-office", label: "Corner Office", description: "Executive charcoal-green — stats strip, services rows, references, zero frivolity.",
      professions: [],
      theme: { background: "#f4f5f4", foreground: "#1d241f", accent: "#2e5e4e", accent2: "#1d241f", surface: "#ffffff", border: "#dfe3e0", muted: "#68706a", focus: "#2e5e4e", font: "red-hat-display", headingFont: "red-hat-display", bodyFont: "public-sans", accentFont: "public-sans", codeFont: "ibm-plex-mono", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "16/9", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "executive-fade", duration: 450, intensity: 25, once: true },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}" } as Partial<SiteSection>),
        tplSection("stats", { title: "By the numbers" }),
        tplSection("services", { title: "Practice areas", layout: "rows" } as Partial<SiteSection>),
        tplSection("experience", { title: "Leadership", layout: "rows" } as Partial<SiteSection>),
        tplSection("testimonials", { title: "References" }),
        tplSection("contact", { title: "Contact", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "quarterly", label: "Quarterly", description: "A crisp annual-report feel — white, ruled lines, forest accents, mono section numerals.",
      professions: [],
      theme: { background: "#fbfcfa", foreground: "#20241f", accent: "#3f6f4f", accent2: "#20241f", surface: "#ffffff", border: "#e2e6df", muted: "#6b736b", focus: "#3f6f4f", font: "hanken-grotesk", headingFont: "hanken-grotesk", bodyFont: "hanken-grotesk", accentFont: "ibm-plex-mono", codeFont: "ibm-plex-mono", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow", columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "3/2", divider: "line", pageTransition: "none", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "steady-fade-up", duration: 450, intensity: 25 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}" } as Partial<SiteSection>),
        tplSection("about", { title: "Overview", body: "{bio}" } as Partial<SiteSection>),
        tplSection("stats", { title: "Key figures" }),
        tplSection("projects", { title: "Reports & case notes", limit: 6, layout: "list" } as Partial<SiteSection>),
        tplSection("contact", { title: "Investor contact", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Dark luxury
    {
      id: "onyx-foil", label: "Onyx & Foil", description: "Pure onyx with rose-gold foil hairlines — jewelry-window serif for flagship presence.",
      professions: [],
      theme: { background: "#0b0a0a", foreground: "#f0e9e2", accent: "#d8a08a", accent2: "#a87e6a", surface: "#141110", border: "#292321", muted: "#a89c92", focus: "#e5b7a3", font: "gilda-display", headingFont: "gilda-display", bodyFont: "tenor-sans", accentFont: "italiana", codeFont: "geist-mono", radius: "none", density: "relaxed", typeScale: "grand", lineHeight: "normal", letterSpacing: "wide", headingWeight: "light", contentWidth: "regular", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "3/2", divider: "accent", pageTransition: "fade", navLayout: "centered", headingAlign: "center" },
      motion: { preset: "mask-up", duration: 750, easing: "gentle", intensity: 40 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "cover" } as Partial<SiteSection>),
        tplSection("projects", { title: "Signature pieces", limit: 3, layout: "featured" } as Partial<SiteSection>),
        tplSection("collections", { title: "Collections", limit: 3 } as Partial<SiteSection>),
        tplSection("services", { title: "Maison services" }),
        tplSection("contact", { title: "Private enquiries", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "midnight-suite", label: "Midnight Suite", description: "Midnight-green black with brass fittings — relaxed pacing, quiet luxury in every gap.",
      professions: [],
      theme: { background: "#0a120f", foreground: "#eae6da", accent: "#b08d4a", accent2: "#7d9a8a", surface: "#101a16", border: "#1f2d27", muted: "#96a096", focus: "#c8a55e", font: "marcellus", headingFont: "marcellus", bodyFont: "alice", accentFont: "marcellus", codeFont: "geist-mono", radius: "md", density: "relaxed", typeScale: "balanced", lineHeight: "relaxed", letterSpacing: "wide", headingWeight: "light", contentWidth: "regular", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "4/3", divider: "none", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "gentle-appear", duration: 650, easing: "gentle", intensity: 35 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered" } as Partial<SiteSection>),
        tplSection("about", { title: "The suite", body: "{bio}" } as Partial<SiteSection>),
        tplSection("projects", { title: "Residences", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("services", { title: "Amenities" }),
        tplSection("testimonials", { title: "Guest book" }),
        tplSection("contact", { title: "Concierge", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "noir-marble", label: "Noir Marble", description: "Charcoal and ivory marble with grand Prata serif — a gallery-grade split layout.",
      professions: [],
      theme: { background: "#141414", foreground: "#f2efe9", accent: "#e3d9c6", accent2: "#b0a68f", surface: "#1d1d1d", border: "#323232", muted: "#a5a099", focus: "#efe6d4", font: "prata", headingFont: "prata", bodyFont: "geist-sans", accentFont: "prata", codeFont: "ibm-plex-mono", radius: "none", density: "regular", typeScale: "grand", lineHeight: "normal", letterSpacing: "normal", headingWeight: "light", contentWidth: "regular", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "3/2", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "curtain", duration: 700, easing: "drift", intensity: 50 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split" } as Partial<SiteSection>),
        tplSection("projects", { title: "Exhibits", limit: 6, layout: "editorial" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Marble hall", limit: 8, layout: "masonry" } as Partial<SiteSection>),
        tplSection("contact", { title: "Appointments", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Glassmorphism
    {
      id: "frost-panel", label: "Frost Panel", description: "Daylight frost — pale warm gradient behind translucent white glass panels.",
      professions: [],
      theme: {
        background: "#efe9e2", foreground: "#2b2a28", accent: "#b4763a", accent2: "#8c6d46", surface: "#ffffff", border: "#d9cfc2", muted: "#7a746c", focus: "#b4763a",
        gradient: { from: "#f2ece4", to: "#d8c9b8", angle: 180 },
        surfaceOpacity: 62,
        font: "plus-jakarta-sans", headingFont: "plus-jakarta-sans", bodyFont: "inter", accentFont: "plus-jakarta-sans", codeFont: "jetbrains-mono",
        radius: "full", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "4/3", divider: "none", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
        glass: { enabled: true, preset: "frosted", targets: { nav: true, cards: true, buttons: false }, blur: 18, opacity: 62, tint: "#ffffff", borderOpacity: 55, borderWidth: 1, highlight: 65, shadow: 35, gradient: true },
      },
      motion: { preset: "blur-up", duration: 550, easing: "gentle", intensity: 40 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split" } as Partial<SiteSection>),
        tplSection("projects", { title: "Selected work", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("services", { title: "Services" }),
        tplSection("skills", { title: "Toolbox" }),
        tplSection("contact", { title: "Say hello", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "prism-glass", label: "Prism Glass", description: "Dusk gradient with vivid glass cards and a breathing glow — glass with real depth.",
      professions: [],
      theme: {
        background: "#191320", foreground: "#f1ecf4", accent: "#e0a33c", accent2: "#c76a8a", surface: "#241b2e", border: "#efe0d2", muted: "#b0a4bc", focus: "#eebb5e",
        gradient: { from: "#191320", to: "#3a2438", angle: 200 },
        surfaceOpacity: 58,
        font: "sora", headingFont: "sora", bodyFont: "outfit", accentFont: "sora", codeFont: "jetbrains-mono",
        radius: "full", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "4/3", divider: "none", pageTransition: "rise", navLayout: "inline", headingAlign: "center",
        glass: { enabled: true, preset: "aurora", targets: { nav: true, cards: true, buttons: true }, blur: 26, opacity: 42, tint: "#2a1f33", borderOpacity: 50, borderWidth: 1, highlight: 60, shadow: 50, gradient: true },
      },
      motion: { preset: "pop", duration: 500, easing: "snap", intensity: 50, background: "bg-glow-pulse" },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered" } as Partial<SiteSection>),
        tplSection("projects", { title: "Through the prism", limit: 9, layout: "grid" } as Partial<SiteSection>),
        tplSection("stats", { title: "Refractions" }),
        tplSection("testimonials", { title: "Light rays" }),
        tplSection("contact", { title: "Catch the light", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Interactive & experimental
    {
      id: "cursor-arcade", label: "Cursor Arcade", description: "Arcade dark with coral/lime neon — magnetic hovers, drifting particles, springy pills.",
      professions: [],
      theme: { background: "#101014", foreground: "#f2f2ee", accent: "#ff6b4a", accent2: "#b8e04a", surface: "#17171d", border: "#2b2b33", muted: "#9c9ca4", focus: "#ff8a6a", font: "unbounded", headingFont: "unbounded", bodyFont: "space-grotesk", accentFont: "space-mono", codeFont: "space-mono", radius: "full", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold", contentWidth: "regular", columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "4/3", divider: "none", pageTransition: "rise", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "stagger-scale", duration: 480, stagger: 80, easing: "snap", intensity: 70, microInteractions: "hover-magnet", background: "bg-particles-drift" },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split", ctaLabel: "Insert coin" } as Partial<SiteSection>),
        tplSection("projects", { title: "High scores", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("skills", { title: "Power-ups" }),
        tplSection("stats", { title: "Leaderboard" }),
        tplSection("contact", { title: "Player two", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "kinetic-poster", label: "Kinetic Poster", description: "Butter-yellow poster board with huge condensed type — marquee energy, list-driven.",
      professions: [],
      theme: { background: "#f5d90a", foreground: "#131313", accent: "#ff4d2e", accent2: "#131313", surface: "#f9e95c", border: "#131313", muted: "#5c5424", focus: "#131313", font: "big-shoulders-display", headingFont: "big-shoulders-display", bodyFont: "archivo", accentFont: "space-mono", codeFont: "space-mono", radius: "none", density: "compact", typeScale: "grand", lineHeight: "tight", letterSpacing: "tight", headingWeight: "bold", contentWidth: "wide", columns: 0, buttonStyle: "sharp", linkStyle: "plain", imageRatio: "1/1", divider: "line", pageTransition: "slide", navLayout: "stacked", headingAlign: "center" },
      motion: { preset: "word-fade", duration: 450, easing: "snap", intensity: 55 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}", variant: "centered" } as Partial<SiteSection>),
        tplSection("projects", { title: "Posters", limit: 8, layout: "list" } as Partial<SiteSection>),
        tplSection("gallery", { title: "Billboard", limit: 6, layout: "strip" } as Partial<SiteSection>),
        tplSection("contact", { title: "Book the artist", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Architecture & interior
    {
      id: "concrete-plan", label: "Concrete Plan", description: "Raw concrete greys, squared frames and 1:1 imagery — built-work precision.",
      professions: [],
      theme: { background: "#e8e7e4", foreground: "#222220", accent: "#8c8a84", accent2: "#222220", surface: "#f4f3f1", border: "#d4d2cd", muted: "#71706b", focus: "#5c5a55", font: "archivo", headingFont: "archivo", bodyFont: "inter", accentFont: "archivo", codeFont: "roboto-mono", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "wide", headingWeight: "semibold", contentWidth: "wide", columns: 2, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "1/1", divider: "line", pageTransition: "none", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "subtle-shift", duration: 500, intensity: 25 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline} — {location}" } as Partial<SiteSection>),
        tplSection("projects", { title: "Built work", limit: 8, layout: "grid" } as Partial<SiteSection>),
        tplSection("experience", { title: "Practice", layout: "rows" } as Partial<SiteSection>),
        tplSection("services", { title: "Services", layout: "rows" } as Partial<SiteSection>),
        tplSection("contact", { title: "Enquiries", body: "" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "interior-muse", label: "Interior Muse", description: "Plaster, walnut and brass — editorial layouts for interiors with warm cover imagery.",
      professions: [],
      theme: { background: "#f3ede4", foreground: "#33291f", accent: "#a5713c", accent2: "#6d5843", surface: "#faf6ef", border: "#e2d7c6", muted: "#82735f", focus: "#a5713c", font: "forum", headingFont: "forum", bodyFont: "figtree", accentFont: "forum", codeFont: "geist-mono", radius: "md", density: "relaxed", typeScale: "grand", lineHeight: "normal", letterSpacing: "normal", headingWeight: "light", contentWidth: "regular", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "3/2", divider: "none", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "media-float-in", duration: 620, intensity: 40 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "cover" } as Partial<SiteSection>),
        tplSection("projects", { title: "Rooms", limit: 6, layout: "editorial" } as Partial<SiteSection>),
        tplSection("collections", { title: "Lookbooks", limit: 3 } as Partial<SiteSection>),
        tplSection("about", { title: "The studio", body: "{bio}" } as Partial<SiteSection>),
        tplSection("contact", { title: "Consultations", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "blueprint-room", label: "Blueprint Room", description: "Deep green-slate drafting table — mono annotations, ruled plans, plotted grids.",
      professions: [],
      theme: { background: "#1d2622", foreground: "#e6ebe6", accent: "#d9c9a8", accent2: "#8aa694", surface: "#242f2a", border: "#34423c", muted: "#9aab9f", focus: "#e8d8b4", font: "archivo", headingFont: "archivo", bodyFont: "inter", accentFont: "jetbrains-mono", codeFont: "jetbrains-mono", radius: "none", density: "compact", typeScale: "balanced", lineHeight: "normal", letterSpacing: "wide", headingWeight: "semibold", contentWidth: "wide", columns: 2, buttonStyle: "sharp", linkStyle: "accent", imageRatio: "16/9", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "grid-iris", duration: 550, intensity: 45 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}" } as Partial<SiteSection>),
        tplSection("projects", { title: "Plotted work", limit: 9, layout: "grid" } as Partial<SiteSection>),
        tplSection("skills", { title: "Instruments" }),
        tplSection("experience", { title: "Site history", layout: "timeline" } as Partial<SiteSection>),
        tplSection("contact", { title: "Site visits", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---- Freelance & personal branding
    {
      id: "solo-card", label: "Solo Card", description: "A personal calling card — single centered column, compact, straight to the point.",
      professions: [],
      theme: { background: "#f7f5f1", foreground: "#26242a", accent: "#c25e4c", accent2: "#26242a", surface: "#ffffff", border: "#e6e2da", muted: "#77737c", focus: "#c25e4c", font: "onest", headingFont: "instrument-serif", bodyFont: "onest", accentFont: "onest", codeFont: "geist-mono", radius: "full", density: "compact", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow", columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "3/2", divider: "none", pageTransition: "fade", navLayout: "inline", headingAlign: "center" },
      motion: { preset: "subtle-rise", duration: 420, intensity: 25 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}", variant: "centered" } as Partial<SiteSection>),
        tplSection("skills", { title: "What I'm good at" }),
        tplSection("projects", { title: "Recent work", limit: 5, layout: "list" } as Partial<SiteSection>),
        tplSection("contact", { title: "Get in touch", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "one-person-studio", label: "One-Person Studio", description: "Freelance studio with services first — warm white, forest green, honest structure.",
      professions: [],
      theme: { background: "#fafaf7", foreground: "#232823", accent: "#3c6e4f", accent2: "#232823", surface: "#ffffff", border: "#e2e6df", muted: "#6d746c", focus: "#3c6e4f", font: "albert-sans", headingFont: "young-serif", bodyFont: "albert-sans", accentFont: "albert-sans", codeFont: "ibm-plex-mono", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "4/3", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "confident-mask", duration: 520, intensity: 40 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split", ctaLabel: "Check availability" } as Partial<SiteSection>),
        tplSection("services", { title: "How I can help" }),
        tplSection("projects", { title: "Client work", limit: 3, layout: "featured" } as Partial<SiteSection>),
        tplSection("experience", { title: "Before going solo", layout: "rows" } as Partial<SiteSection>),
        tplSection("contact", { title: "Start a conversation", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "name-plate", label: "Name Plate", description: "An engraved brass plate on deep olive — formal personal branding with inscription caps.",
      professions: [],
      theme: { background: "#26291f", foreground: "#efe9d8", accent: "#c9a86a", accent2: "#8f9a7a", surface: "#2e3226", border: "#454a38", muted: "#a8a58f", focus: "#d9bb80", font: "cinzel", headingFont: "cinzel", bodyFont: "eb-garamond", accentFont: "cinzel", codeFont: "geist-mono", radius: "none", density: "regular", typeScale: "balanced", lineHeight: "relaxed", letterSpacing: "wide", headingWeight: "light", contentWidth: "narrow", columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "3/2", divider: "accent", pageTransition: "fade", navLayout: "centered", headingAlign: "center" },
      motion: { preset: "ink-reveal", duration: 600, easing: "gentle", intensity: 40 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{headline}", variant: "centered" } as Partial<SiteSection>),
        tplSection("about", { title: "About", body: "{bio}" } as Partial<SiteSection>),
        tplSection("projects", { title: "Undertakings", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("testimonials", { title: "Letters of note" }),
        tplSection("contact", { title: "Correspondence", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },
    {
      id: "open-for-work", label: "Open for Work", description: "Availability-first freelance — bright, badge-clear, skills and services up front.",
      professions: [],
      theme: { background: "#ffffff", foreground: "#1f2124", accent: "#0f8a5f", accent2: "#1f2124", surface: "#f6faf8", border: "#e0e8e4", muted: "#68716c", focus: "#0f8a5f", font: "lexend", headingFont: "lexend", bodyFont: "inter", accentFont: "lexend", codeFont: "jetbrains-mono", radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "16/9", divider: "none", pageTransition: "fade", navLayout: "inline", headingAlign: "left" },
      motion: { preset: "focus-ring", duration: 450, intensity: 30 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tplSection("hero", { title: "{name}", subtitle: "{tagline}", variant: "split", ctaLabel: "Available now" } as Partial<SiteSection>),
        tplSection("skills", { title: "Skills" }),
        tplSection("projects", { title: "Recent gigs", limit: 6, layout: "grid" } as Partial<SiteSection>),
        tplSection("services", { title: "Packages", layout: "rows" } as Partial<SiteSection>),
        tplSection("contact", { title: "Hire me", body: "{availability}" } as Partial<SiteSection>),
      ]}],
    },

    // ---------------- v4 profession templates (universal profession expansion)
    // Authored per family in src/lib/site-templates/professions/ — each a
    // genuinely distinct complete-website design with taxonomy-verified
    // profession compatibility. Applied via the same gallery Apply / Live
    // preview / Revert flows and the AI's template.apply tool.
    ...newsroomTemplates(),
    ...writingTemplates(),
    ...technologyTemplates(),
    ...engineeringTemplates(),
    ...creativeArtsTemplates(),
    ...performingArtsTemplates(),
    ...businessTemplates(),
    ...healthTemplates(),
    ...educationTemplates(),
    ...scienceTemplates(),
    ...tradesTemplates(),
  ];
}

export function defaultConfig(template: TemplateId = "atelier"): SiteConfig {
  const preset = templatePresets().find((t) => t.id === template) ?? templatePresets()[0];
  return {
    version: 2,
    template: preset.id,
    name: "My website",
    tagline: "",
    coverMediaId: null,
    logoMediaId: null,
    logoPreset: null,
    theme: deriveTheme(preset.theme),
    motion: normalizeMotion({ ...defaultMotion(), ...(preset.motion ?? {}) }),
    pages: preset.pages.map((p) => ({ ...p, sections: p.sections.map((s) => ({ ...s })) })),
  };
}

/** Validate a motion object against the live registry (unknown ids → defaults). */
export function normalizeMotion(input: Partial<SiteMotion> | null | undefined): SiteMotion {
  const m = motionSchema.parse(input ?? {});
  if (!getMotionPreset(m.preset)) m.preset = "fadeUp";
  if (!getMotionPreset(m.background)) m.background = "bg-none";
  if (!getMotionPreset(m.microInteractions)) m.microInteractions = "hover-lift";
  return m;
}

/** Validate + normalize a glass object (unknown preset → frosted values). */
export function normalizeGlass(input: Partial<SiteGlass> | null | undefined): SiteGlass {
  const g = glassSchema.parse(input ?? {});
  return g;
}

/**
 * Legacy category slugs that early templates/prompts shipped before the real
 * Profession taxonomy settled. Exact-match project filters could never match
 * them (sections rendered permanently empty), so normalizeConfig heals them
 * to the live slugs on every read.
 */
const LEGACY_CATEGORY_SLUGS: Record<string, string> = {
  "writing-journalism": "writing",
  "software-development": "software-dev",
  "ui-ux-design": "ui-ux",
  "marketing-business": "marketing",
  "music-audio": "music",
  "fine-art": "art",
  "education-research": "education",
};

function healLegacyCategorySlugs(pages: SitePage[]): SitePage[] {
  return pages.map((p) => ({
    ...p,
    sections: p.sections.map((s) =>
      s.type === "projects" && s.category && LEGACY_CATEGORY_SLUGS[s.category]
        ? { ...s, category: LEGACY_CATEGORY_SLUGS[s.category] }
        : s
    ),
  }));
}

/**
 * Normalize any parsed-but-possibly-incomplete config into a renderable one.
 * Accepts an object OR a raw JSON string (as stored in SiteDesign.draftConfig).
 * Migrates legacy v1 single-page configs into the `pages` model, maps legacy
 * font ids, validates motion/glass/palette ids against their registries, applies
 * derived theme tokens, and stamps version 2.
 * Returns null for anything that does not satisfy the schema — callers must
 * treat null as "invalid/corrupt", never render it.
 */
export function normalizeConfig(input: unknown): SiteConfig | null {
  let candidate = input;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  const parsed = siteConfigSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const raw = parsed.data as RawSiteConfig;

  const pages: SitePage[] = 
    raw.pages && raw.pages.length > 0
      ? raw.pages
      : [{ id: "home", name: "Home", visible: true, sections: raw.sections ?? [] }];

  const motion = normalizeMotion(raw.motion);
  const healedPages = healLegacyCategorySlugs(pages);
  const sectionIds = new Set(healedPages.flatMap((page) => page.sections.map((s) => s.id)));

  // GIFTZ motion engine (M15): registry-validate the gsap block with real
  // section ids; invalid animations are dropped, the block stays inspectable.
  let gsap: GsapMotionBlock | undefined = motion.gsap ?? undefined;
  if (gsap?.enabled) {
    const validation = validateGsapMotionBlock(gsap, sectionIds);
    gsap = { ...gsap, animations: validation.value?.animations ?? [] };
    if (!validation.ok && gsap.animations.length === 0) {
      gsap = { ...gsap, enabled: false };
    }
  }

  // GIFTZ background engine (M16): registry-validate the Vanta block;
  // an invalid effect/settings combination normalizes to disabled.
  let backgroundEffects: BackgroundEffects | undefined = raw.backgroundEffects ?? undefined;
  if (backgroundEffects?.enabled) {
    const validation = validateBackgroundEffects(backgroundEffects, sectionIds);
    backgroundEffects =
      validation.ok && validation.value ? validation.value : { ...backgroundEffects, enabled: false };
  }

  return {
    version: 2,
    template: raw.template,
    name: raw.name,
    tagline: raw.tagline,
    coverMediaId: raw.coverMediaId ?? null,
    logoMediaId: raw.logoMediaId ?? null,
    logoPreset: raw.logoPreset ?? null,
    theme: deriveTheme(raw.theme),
    motion: gsap !== undefined ? { ...motion, gsap } : motion,
    backgroundEffects,
    pages: healedPages,
  };
}

/**
 * WHY a config was rejected — the precise schema issues `normalizeConfig`
 * reduces to `null`. Same acceptance contract, same schema: [] means the
 * input IS valid; otherwise each entry names the failing path and the real
 * reason ("pages.0.sections.2.type: Invalid input (received: "showreel")").
 * Union discriminators produce generic messages, so the offending value is
 * read from the input at the failing path and appended — a rejected step can
 * be REPAIRED against actual diagnostics instead of a generic shrug.
 * Output is bounded and schema-derived only — safe for user-facing errors.
 */
function valueAtPath(input: unknown, path: PropertyKey[]): unknown {
  let current: unknown = input;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

function describeReceived(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return JSON.stringify(value.length > 60 ? `${value.slice(0, 57)}…` : value);
  try {
    const s = JSON.stringify(value) ?? "unknown";
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  } catch {
    return null;
  }
}

export function explainConfigIssues(input: unknown, max = 6): string[] {
  let candidate = input;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return ["The configuration is not valid JSON."];
    }
  }
  const parsed = siteConfigSchema.safeParse(candidate);
  if (parsed.success) return [];
  return parsed.error.issues.slice(0, max).map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "(root)";
    // zod's union failures say only "Invalid input" — name the value that
    // failed so the report (and the repair prompt) is actionable.
    const generic = i.code === "invalid_union" && /invalid input/i.test(i.message);
    const received = generic ? describeReceived(valueAtPath(candidate, i.path)) : null;
    return `${path}: ${i.message}${received ? ` (received: ${received})` : ""}`;
  });
}
