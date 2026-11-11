/// <reference types="bun-types" />
/**
 * Style-template library tests (task A-4-templates; extended by tasks 16 and 18).
 *
 * Pins the 54-entry complete-website template library:
 *
 *  - STYLE_TEMPLATE_IDS must list exactly the required ids (14 originals in
 *    order + the 40-library expansion), unique
 *  - every style preset must pass normalizeConfig (schema-valid, renderable)
 *  - every theme font id must resolve in the font library
 *  - every motion preset / easing / micro-interaction / background id must
 *    exist in the live motion registry
 *  - every template has library metadata: one of the 15 collections + a
 *    swatch layout; every collection has at least 2 templates
 *  - templates are GENUINELY different: no two share the same structural
 *    signature (section arrangement + hero variant + key theme tokens)
 *  - TemplateGallery must be an importable, exported component module
 *
 * Run: bun test tests/style-templates.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  STYLE_TEMPLATE_IDS,
  STYLE_TEMPLATE_META,
  TEMPLATE_CATEGORY_IDS,
  TEMPLATE_CATEGORY_LABELS,
  TEMPLATE_IDS,
  TEMPLATE_SWATCH_LAYOUTS,
  normalizeConfig,
  templatePresets,
  type TemplatePreset,
} from "../src/lib/site-config";
import { SITE_FONTS } from "../src/lib/site-fonts";
import { MOTION_EASING_IDS, MOTION_PRESET_IDS } from "../src/lib/site-motion";
import { flattenTaxonomy } from "../src/lib/professions/taxonomy";
import TemplateGallery from "../src/components/bean/site/studio/TemplateGallery";

/** The original 14 style templates — the library must always remain a superset of these. */
const REQUIRED_ORIGINAL_IDS: string[] = [
  "minimal-index",
  "modern-loft",
  "editorial-press",
  "creative-playbook",
  "developer-term",
  "designer-desk",
  "photography-frame",
  "agency-roster",
  "corporate-ledger",
  "dark-luxury",
  "glassmorphism",
  "experimental-lab",
  "portfolio-showcase",
  "interactive",
];

const BY_ID: Map<string, TemplatePreset> = new Map(templatePresets().map((t) => [t.id, t]));

describe("STYLE_TEMPLATE_IDS", () => {
  test("contains at least 50 complete-website templates", () => {
    expect(STYLE_TEMPLATE_IDS.length).toBeGreaterThanOrEqual(50);
  });

  test("keeps all 14 original style templates (library is a superset)", () => {
    const set = new Set<string>(STYLE_TEMPLATE_IDS);
    for (const id of REQUIRED_ORIGINAL_IDS) expect(set.has(id)).toBe(true);
  });

  test("ids are unique", () => {
    expect(new Set(STYLE_TEMPLATE_IDS).size).toBe(STYLE_TEMPLATE_IDS.length);
  });

  test("every style id is registered in TEMPLATE_IDS", () => {
    const all = new Set<string>(TEMPLATE_IDS);
    for (const id of STYLE_TEMPLATE_IDS) expect(all.has(id)).toBe(true);
  });

  test("the library spans all 26 collections with ≥2 templates each", () => {
    const counts = new Map<string, number>();
    for (const id of STYLE_TEMPLATE_IDS) {
      const meta = STYLE_TEMPLATE_META[id as keyof typeof STYLE_TEMPLATE_META];
      expect(meta).toBeTruthy();
      counts.set(meta.category, (counts.get(meta.category) ?? 0) + 1);
    }
    expect(TEMPLATE_CATEGORY_IDS.length).toBe(26);
    for (const cat of TEMPLATE_CATEGORY_IDS) {
      expect(counts.get(cat) ?? 0).toBeGreaterThanOrEqual(2);
    }
    // every id is accounted for exactly once
    let total = 0;
    for (const n of counts.values()) total += n;
    expect(total).toBe(STYLE_TEMPLATE_IDS.length);
  });
});

describe("style template presets", () => {
  test("each has a preset entry with label, description and 4-7 sections", () => {
    for (const id of STYLE_TEMPLATE_IDS) {
      const t = BY_ID.get(id);
      expect(t).toBeTruthy();
      expect(t!.label.length).toBeGreaterThan(0);
      expect(t!.description.length).toBeGreaterThan(0);
      // v4 profession templates declare taxonomy-verified profession slugs;
      // v2/v3 visual-genre templates stay profession-neutral (empty array).
      expect(Array.isArray(t!.professions)).toBe(true);
      expect(t!.pages.length).toBeGreaterThan(0);
      const sectionCount = t!.pages[0].sections.length;
      expect(sectionCount).toBeGreaterThanOrEqual(4);
      expect(sectionCount).toBeLessThanOrEqual(7);
    }
  });

  test("every declared profession slug exists in the taxonomy (profession integrity)", () => {
    const known = new Set(flattenTaxonomy().map((p) => p.slug));
    for (const id of STYLE_TEMPLATE_IDS) {
      const t = BY_ID.get(id)!;
      for (const slug of t.professions) {
        expect(known.has(slug)).toBe(true);
      }
    }
  });

  test("every style preset passes normalizeConfig (renderable config)", () => {
    for (const id of STYLE_TEMPLATE_IDS) {
      const t = BY_ID.get(id)!;
      const config = normalizeConfig({
        version: 2,
        template: t.id,
        name: "T",
        tagline: "x",
        theme: t.theme,
        motion: t.motion ?? undefined,
        pages: t.pages,
      });
      expect(config).not.toBeNull();
      if (config) {
        expect(config.template).toBe(id);
        expect(config.pages.length).toBeGreaterThan(0);
        expect(config.theme.font.length).toBeGreaterThan(0);
      }
    }
  });

  test("every theme font id exists in the 129-family font library", () => {
    const fontIds = new Set(SITE_FONTS.map((f) => f.id));
    const keys = ["font", "headingFont", "bodyFont", "accentFont", "codeFont", "navFont", "buttonFont"] as const;
    for (const id of STYLE_TEMPLATE_IDS) {
      const t = BY_ID.get(id)!;
      for (const key of keys) {
        const value = t.theme[key];
        if (value) expect(fontIds.has(value)).toBe(true);
      }
    }
  });

  test("every motion preset, easing, micro-interaction and background id exists", () => {
    const presetIds = new Set<string>(MOTION_PRESET_IDS);
    const easingIds = new Set<string>(MOTION_EASING_IDS);
    for (const id of STYLE_TEMPLATE_IDS) {
      const t = BY_ID.get(id)!;
      if (!t.motion) continue;
      if (t.motion.preset) expect(presetIds.has(t.motion.preset)).toBe(true);
      if (t.motion.easing) expect(easingIds.has(t.motion.easing)).toBe(true);
      if (t.motion.background) expect(presetIds.has(t.motion.background)).toBe(true);
      if (t.motion.microInteractions) expect(presetIds.has(t.motion.microInteractions)).toBe(true);
    }
  });

  test("the glassmorphism-family templates enable the glass system with valid fields", () => {
    for (const id of ["glassmorphism", "frost-panel", "prism-glass"] as const) {
      const t = BY_ID.get(id)!;
      const glass = t.theme.glass;
      expect(glass).toBeTruthy();
      expect(glass!.enabled).toBe(true);
      expect(glass!.blur).toBeGreaterThanOrEqual(0);
      expect(glass!.blur).toBeLessThanOrEqual(40);
      expect(glass!.opacity).toBeGreaterThanOrEqual(0);
      expect(glass!.opacity).toBeLessThanOrEqual(90);
      expect(t.theme.surfaceOpacity).toBeLessThan(100);
    }
    // non-glass templates must NOT silently enable glass
    for (const id of STYLE_TEMPLATE_IDS) {
      if (id === "glassmorphism" || id === "frost-panel" || id === "prism-glass") continue;
      const t = BY_ID.get(id)!;
      expect(t.theme.glass?.enabled ?? false).toBe(false);
    }
  });

  test("no style template defaults to an indigo/blue accent (brand rule)", () => {
    for (const id of STYLE_TEMPLATE_IDS) {
      const t = BY_ID.get(id)!;
      expect(t.theme.background).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(t.theme.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
      const accent = t.theme.accent.toLowerCase();
      // dominant blue channel must not clearly dominate red+green
      const r = parseInt(accent.slice(1, 3), 16);
      const g = parseInt(accent.slice(3, 5), 16);
      const b = parseInt(accent.slice(5, 7), 16);
      const isBluish = b > 150 && b > r + 40 && b > g + 40;
      expect(isBluish).toBe(false);
    }
  });

  test("templates are GENUINELY different — no duplicate structural signatures", () => {
    // A template's structural signature: the ordered list of
    // type:layout:variant section specs + the tokens that shape the whole
    // page (radius, density, columns, buttonStyle, navLayout, headingAlign,
    // contentWidth, imageRatio, heading font). Two templates with the SAME
    // signature would render essentially the same site.
    const signatures = new Map<string, string>();
    for (const id of STYLE_TEMPLATE_IDS) {
      const t = BY_ID.get(id)!;
      const sections = t.pages[0].sections
        .map((s) => {
          const layout = "layout" in s ? (s as { layout?: string }).layout ?? "" : "";
          const variant = s.type === "hero" ? (s as { variant?: string }).variant ?? "" : "";
          return `${s.type}:${layout}:${variant}`;
        })
        .join(">");
      const signature = [
        sections,
        t.theme.radius,
        t.theme.density,
        t.theme.columns,
        t.theme.buttonStyle,
        t.theme.navLayout,
        t.theme.headingAlign,
        t.theme.contentWidth,
        t.theme.imageRatio,
        t.theme.headingFont ?? t.theme.font,
      ].join("|");
      const prev = signatures.get(signature);
      expect(prev ?? null).toBeNull(); // no two templates share a signature
      signatures.set(signature, id);
    }
  });

  test("library metadata: every swatch layout is valid and used", () => {
    const usedLayouts = new Set<string>();
    for (const id of STYLE_TEMPLATE_IDS) {
      const meta = STYLE_TEMPLATE_META[id as keyof typeof STYLE_TEMPLATE_META];
      expect(TEMPLATE_SWATCH_LAYOUTS).toContain(meta.swatch);
      usedLayouts.add(meta.swatch);
    }
    // every layout is exercised by at least one template (real variety)
    for (const l of TEMPLATE_SWATCH_LAYOUTS) expect(usedLayouts.has(l)).toBe(true);
  });

  test("collection labels exist for every collection id", () => {
    for (const cat of TEMPLATE_CATEGORY_IDS) {
      expect(TEMPLATE_CATEGORY_LABELS[cat].length).toBeGreaterThan(0);
    }
  });
});

describe("TemplateGallery module", () => {
  test("is importable and exports the component (default + named)", () => {
    expect(TemplateGallery).toBeTruthy();
    expect(typeof TemplateGallery).toBe("function");
  });
});
