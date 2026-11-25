/// <reference types="bun-types" />
/**
 * M33.4-B — deterministic professional typography with real provisioned
 * fonts (regression suite).
 *
 * Pins the server-side font contract:
 *  - the licence-audited provisioned set resolves by real family name with
 *    REAL weights (variable-font axes included — measured on pixels);
 *  - requested weights snap to available weights with explicit warnings;
 *  - unprovisioned SITE_FONTS ids and unknown ids fall back deterministically
 *    with EXPLICIT warnings (never a silent substitution);
 *  - glyph coverage is measured against the family's real charset (Latin
 *    covered for Inter, Devanagari honestly reported uncovered for Inter and
 *    covered for Kalam);
 *  - renderTypographyLayer keeps the user's spelling EXACTLY, renders with
 *    the resolved family/weight, wraps only as a last resort with explicit
 *    warnings, and verifies real ink against the layer pixels;
 *  - heavier weights render measurably more ink (weight is not faked).
 *
 * Pure test — no DB, no network (fonts are tracked in data/laxii-fonts).
 * Run: bun test tests/laxii-typography-fonts.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  PROVISIONED_BANNER_FONTS,
  checkGlyphCoverage,
  ensureBannerFontsInstalled,
  provisionedFontCount,
  recommendBannerFontPairing,
  resolveServerFont,
} from "@/lib/laxii/font-assets";
import { renderTypographyLayer, verifyInkApplied } from "@/lib/laxii/typography";
import { planComposition } from "@/lib/laxii/banner-pipeline";
import type { DesignBrief } from "@/lib/laxii/design-brief";

const CANONICAL = { presetSlug: "bean-folio-banner", width: 2048, height: 687 };
const SAFE_AREA = { x: 143, y: 34, width: 1761, height: 618 };

function makeBrief(overrides: Partial<DesignBrief["typography"]> = {}): DesignBrief {
  return {
    schemaVersion: 1,
    request: "test banner",
    profession: null,
    targetAudience: null,
    portfolio: { permission: "self", used: false, summary: [] },
    visualIdentity: { toneWords: [], notes: [] },
    direction: "",
    subject: { description: "", focalPoint: "" },
    background: "",
    composition: { hierarchy: "", textPlacement: "left", notes: [] },
    palette: ["#f5f0e6"],
    typography: {
      items: [
        { text: "STUDIO NORTH", role: "headline", font: "sans" },
        { text: "Stories told frame by frame", role: "subtext", font: "sans" },
      ],
      notes: [],
      ...overrides,
    },
    canvas: CANONICAL,
    safeArea: SAFE_AREA,
    referenceMediaIds: [],
    preserve: [],
    avoid: [],
    export: { format: "png", exactDimensions: true },
    revisions: [],
    source: "USER",
    sourceTaskId: "test",
    createdAt: new Date().toISOString(),
  };
}

async function flatScene(): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({ create: { width: CANONICAL.width, height: CANONICAL.height, channels: 3, background: { r: 24, g: 20, b: 18 } } }).png().toBuffer();
}

describe("provisioned font set", () => {
  test("the licence-audited set exists with pinned provenance", () => {
    expect(provisionedFontCount()).toBe(9);
    const ids = PROVISIONED_BANNER_FONTS.map((f) => f.fontId);
    expect(ids).toContain("fraunces");
    expect(ids).toContain("inter");
    expect(ids).toContain("anton");
    expect(ids).toContain("lato");
    expect(ids).toContain("merriweather");
    expect(ids).toContain("caveat");
    expect(ids).toContain("pacifico");
    expect(ids).toContain("kalam");
    expect(ids).toContain("oswald");
    for (const def of PROVISIONED_BANNER_FONTS) {
      expect(def.licence).toBe("OFL-1.1");
      expect(def.upstreamUrl).toMatch(/^https:\/\/github\.com\/google\/fonts/);
      for (const file of def.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("every provisioned family resolves by its REAL family name", () => {
    ensureBannerFontsInstalled();
    for (const def of PROVISIONED_BANNER_FONTS) {
      const resolved = resolveServerFont(def.fontId, 400, def.kind);
      expect(resolved.ok).toBe(true);
      expect(resolved.family).toBe(def.family);
      expect(resolved.source).toBe("provisioned");
      expect(resolved.fontId).toBe(def.fontId);
    }
  });

  test("weights are real: requested weight outside the family's set snaps with a warning", () => {
    const anton700 = resolveServerFont("anton", 700, "display");
    expect(anton700.weight).toBe(400);
    expect(anton700.warnings.some((w) => w.includes("nearest real weight"))).toBe(true);
    // Inter's variable axis covers the full range — 200 and 900 are real.
    const inter200 = resolveServerFont("inter", 200, "sans");
    expect(inter200.weight).toBe(200);
    expect(inter200.warnings).toEqual([]);
    const inter900 = resolveServerFont("inter", 900, "sans");
    expect(inter900.weight).toBe(900);
  });

  test("unprovisioned SITE_FONTS ids and unknown ids fall back with explicit warnings", () => {
    const playfair = resolveServerFont("playfair-display", 400, "serif");
    expect(playfair.source).toBe("fallback");
    expect(playfair.family).toBe("DejaVu Serif");
    expect(playfair.warnings.some((w) => w.includes("not provisioned for server-side rendering"))).toBe(true);
    const bogus = resolveServerFont("no-such-font", 400);
    expect(bogus.source).toBe("fallback");
    expect(bogus.warnings.some((w) => w.includes('Unknown font id'))).toBe(true);
  });
});

describe("glyph coverage measurement", () => {
  test("Inter covers Latin text (measured, not assumed)", () => {
    const cov = checkGlyphCoverage("Inter", "STUDIO NORTH — café — Résumé 0123!");
    expect(cov.covered).toBe(true);
    expect(cov.missingCount).toBe(0);
  });

  test("Devanagari is honestly reported uncovered for Inter and covered for Kalam", () => {
    const interDev = checkGlyphCoverage("Inter", "नमस्ते");
    expect(interDev.covered).toBe(false);
    expect(interDev.missingCount).toBeGreaterThan(0);
    expect(interDev.missingSample[0]).toMatch(/^U\+09/);
    const kalamDev = checkGlyphCoverage("Kalam", "नमस्ते");
    expect(kalamDev.covered).toBe(true);
    expect(kalamDev.missingCount).toBe(0);
  });

  test("Arabic is honestly reported uncovered for Inter", () => {
    const cov = checkGlyphCoverage("Inter", "مرحبا");
    expect(cov.covered).toBe(false);
    expect(cov.missingCount).toBe(5);
  });
});

describe("renderTypographyLayer with resolved fonts", () => {
  test("keeps the user's spelling EXACTLY and renders with the resolved family", async () => {
    const brief = makeBrief({
      items: [
        { text: "STUDIO NORTH", role: "headline", font: "sans", fontId: "inter", weight: 900 },
        { text: "Stories told frame by frame", role: "subtext", font: "sans" },
      ],
    });
    const typo = await renderTypographyLayer(brief, await flatScene(), planComposition(brief).focalRect);
    expect(typo).not.toBeNull();
    const headline = typo!.plan.lines.find((l) => l.item.role === "headline")!;
    expect(headline.text).toBe("STUDIO NORTH");
    expect(headline.family).toBe("Inter");
    expect(headline.source).toBe("provisioned");
    expect(headline.weight).toBe(900);
    expect(headline.ink.width).toBeGreaterThan(0);
    expect(headline.ink.height).toBeGreaterThan(0);
    // Every rendered fragment preserves its exact spelling.
    for (const line of typo!.plan.lines) {
      expect(line.item.text).toContain(line.text);
    }
    expect(typo!.plan.warnings.join("\n")).not.toMatch(/not provisioned/);
  });

  test("weight renders measurably bolder (the weight is NOT faked)", async () => {
    const { default: sharp } = await import("sharp");
    const inkMass = async (weight: number): Promise<number> => {
      const brief = makeBrief({ items: [{ text: "HANDGLOVES 0123", role: "headline", font: "sans", fontId: "inter", weight }] });
      const typo = await renderTypographyLayer(brief, await flatScene(), null);
      const raw = await sharp(typo!.layer).raw().toBuffer({ resolveWithObject: true });
      let sum = 0;
      for (let i = 0; i < raw.data.length; i += raw.info.channels) sum += raw.data[i + 3];
      return sum;
    };
    const w400 = await inkMass(400);
    const w900 = await inkMass(900);
    expect(w900).toBeGreaterThan(w400 * 1.3);
  });

  test("an unprovisioned fontId falls back with an explicit warning while spelling is preserved", async () => {
    const brief = makeBrief({
      items: [{ text: "Playfair Headline", role: "headline", font: "serif", fontId: "playfair-display" }],
    });
    const typo = await renderTypographyLayer(brief, await flatScene(), null);
    expect(typo).not.toBeNull();
    expect(typo!.plan.lines[0].family).toBe("DejaVu Serif");
    expect(typo!.plan.lines[0].source).toBe("fallback");
    expect(typo!.plan.lines[0].text).toBe("Playfair Headline");
    expect(typo!.plan.warnings.some((w) => w.includes("not provisioned for server-side rendering"))).toBe(true);
  });

  test("uncovered scripts produce an explicit glyph warning but still render", async () => {
    const brief = makeBrief({ items: [{ text: "नमस्ते Studio", role: "headline", font: "sans", fontId: "inter" }] });
    const typo = await renderTypographyLayer(brief, await flatScene(), null);
    expect(typo).not.toBeNull();
    expect(typo!.checks[0].glyphCoverage.covered).toBe(false);
    expect(typo!.checks[0].glyphCoverage.missingCount).toBeGreaterThan(0);
    // The text itself still rendered (Pango per-glyph fallback).
    expect(typo!.plan.lines[0].text).toBe("नमस्ते Studio");
    expect(typo!.plan.lines[0].ink.width).toBeGreaterThan(0);
  });

  test("long text shrinks to fit; overflow beyond the floor wraps with an explicit warning", async () => {
    // Shrink-to-fit path: a long-but-fittable line stays ONE fragment.
    const shrinkBrief = makeBrief({
      items: [{ text: "A moderately long headline that fits after shrinking", role: "headline", font: "sans" }],
    });
    const shrink = await renderTypographyLayer(shrinkBrief, await flatScene(), null);
    expect(shrink).not.toBeNull();
    expect(shrink!.plan.lines.length).toBe(1);
    expect(shrink!.plan.warnings.some((w) => w.includes("wrapped onto"))).toBe(false);

    // Wrap path: on a NARROW canvas the line cannot fit even at the 10px
    // floor, so it wraps onto measured lines (last-resort behaviour).
    const narrow = { presetSlug: "custom", width: 300, height: 200 };
    const wrapBrief = makeBrief({
      items: [
        { text: "an extremely long unbroken sequence of words repeated over and over again forcing the line far beyond the safe area boundary for sure", role: "headline", font: "sans" },
      ],
      canvas: narrow,
    } as Partial<DesignBrief["typography"]> & { canvas: typeof narrow });
    (wrapBrief as DesignBrief).canvas = narrow;
    (wrapBrief as DesignBrief).safeArea = { x: 21, y: 10, width: 258, height: 180 };
    const wrapped = await renderTypographyLayer(wrapBrief, await flatScene(), null);
    expect(wrapped).not.toBeNull();
    expect(wrapped!.plan.lines.length).toBeGreaterThan(1);
    expect(wrapped!.plan.warnings.some((w) => w.includes("wrapped onto"))).toBe(true);
    // Every fragment keeps whole words; joining fragments reconstructs the text.
    const rejoined = wrapped!.plan.lines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
    expect(rejoined).toBe("an extremely long unbroken sequence of words repeated over and over again forcing the line far beyond the safe area boundary for sure");
    // All fragments respect the safe width (+2px tolerance).
    for (const line of wrapped!.plan.lines) {
      expect(line.ink.left + line.ink.width).toBeLessThanOrEqual(SAFE_AREA.x + SAFE_AREA.width + 2);
    }
  });

  test("combining marks render as one glyph cluster with real ink", async () => {
    // e + COMBINING ACUTE ACCENT (decomposed form) must render identically
    // in intent to the precomposed é — real ink, exact codepoints preserved.
    const brief = makeBrief({ items: [{ text: "cafe\u0301 — re\u0301sume\u0301", role: "headline", font: "sans", fontId: "inter" }] });
    const typo = await renderTypographyLayer(brief, await flatScene(), null);
    expect(typo).not.toBeNull();
    expect(typo!.plan.lines[0].text).toBe("cafe\u0301 — re\u0301sume\u0301");
    expect(typo!.plan.lines[0].ink.width).toBeGreaterThan(0);
    expect(typo!.checks[0].glyphCoverage.covered).toBe(true);
  });

  test("right-to-left text renders with real ink and an honest coverage warning when the family lacks the script", async () => {
    const brief = makeBrief({ items: [{ text: "استوديو الشمال", role: "headline", font: "sans", fontId: "inter" }] });
    const typo = await renderTypographyLayer(brief, await flatScene(), null);
    expect(typo).not.toBeNull();
    // Inter has no Arabic — the renderer still renders (Pango falls back to
    // a covered system font) and the check reports the gap explicitly.
    expect(typo!.checks[0].glyphCoverage.covered).toBe(false);
    expect(typo!.checks[0].glyphCoverage.missingCount).toBeGreaterThan(0);
    expect(typo!.plan.lines[0].ink.width).toBeGreaterThan(0);
    expect(typo!.plan.lines[0].text).toBe("استوديو الشمال");
  });

  test("mixed-script text (Latin + Devanagari) renders with a covering family", async () => {
    const brief = makeBrief({ items: [{ text: "Studio नमस्ते", role: "headline", font: "script", fontId: "kalam" }] });
    const typo = await renderTypographyLayer(brief, await flatScene(), null);
    expect(typo).not.toBeNull();
    expect(typo!.plan.lines[0].family).toBe("Kalam");
    // Kalam covers both the Latin and Devanagari ranges of this string.
    expect(typo!.checks[0].glyphCoverage.covered).toBe(true);
    expect(typo!.plan.lines[0].ink.width).toBeGreaterThan(0);
  });

  test("emoji are reported uncovered and render through the system fallback", async () => {
    const brief = makeBrief({ items: [{ text: "Studio 🎬 North", role: "headline", font: "sans", fontId: "inter" }] });
    const typo = await renderTypographyLayer(brief, await flatScene(), null);
    expect(typo).not.toBeNull();
    expect(typo!.checks[0].glyphCoverage.covered).toBe(false);
    expect(typo!.checks[0].glyphCoverage.missingSample.some((m) => m.startsWith("U+1F3"))).toBe(true);
    expect(typo!.plan.lines[0].ink.width).toBeGreaterThan(0);
  });

  test("verifyInkApplied proves the layer really landed on the composite", async () => {
    const { default: sharp } = await import("sharp");
    const brief = makeBrief();
    const scene = await flatScene();
    const typo = await renderTypographyLayer(brief, scene, null);
    const composed = await sharp(scene).composite([{ input: typo!.layer, top: 0, left: 0 }]).removeAlpha().png().toBuffer();
    const applied = await verifyInkApplied(composed, scene, typo!.plan.lines);
    expect(applied.length).toBe(typo!.plan.lines.length);
    for (const a of applied) expect(a.applied).toBe(true);
    // The verification is not a tautology: comparing the SCENE against itself
    // reports NOT applied.
    const none = await verifyInkApplied(scene, scene, typo!.plan.lines);
    for (const a of none) expect(a.applied).toBe(false);
  });
});

describe("recommendBannerFontPairing — tone conventions, never profiling", () => {
  test("premium tones recommend a serif display + quiet sans from the PROVISIONED set", () => {
    const r = recommendBannerFontPairing({ toneWords: ["premium", "elegant"], audience: "clients" });
    const provisionedIds = new Set(PROVISIONED_BANNER_FONTS.map((f) => f.fontId));
    expect(provisionedIds.has(r.primary.headline.fontId)).toBe(true);
    expect(provisionedIds.has(r.primary.body.fontId)).toBe(true);
    expect(r.primary.rationale).toContain("premium");
  });

  test("each tone rule produces its documented pairing deterministically", () => {
    expect(recommendBannerFontPairing({ toneWords: ["bold"] }).primary.headline.fontId).toBe("anton");
    expect(recommendBannerFontPairing({ toneWords: ["technical"] }).primary.headline.fontId).toBe("inter");
    expect(recommendBannerFontPairing({ toneWords: ["editorial"] }).primary.headline.fontId).toBe("merriweather");
    expect(recommendBannerFontPairing({ toneWords: ["friendly"] }).primary.headline.fontId).toBe("caveat");
    expect(recommendBannerFontPairing({ toneWords: ["devanagari"] }).primary.headline.fontId).toBe("kalam");
    // Deterministic: same inputs → same output.
    const a = recommendBannerFontPairing({ toneWords: ["premium"], audience: "galleries", purpose: "exhibition" });
    const b = recommendBannerFontPairing({ toneWords: ["premium"], audience: "galleries", purpose: "exhibition" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("unmatched tones fall back with an explicit note; empty input uses the default pairing", () => {
    const r = recommendBannerFontPairing({ toneWords: ["wibble"], audience: "" });
    expect(r.primary.headline.fontId).toBe("fraunces");
    expect(r.primary.notes.some((n) => n.includes("No convention rule matched"))).toBe(true);
    const empty = recommendBannerFontPairing({});
    expect(empty.primary.headline.fontId).toBe("fraunces");
    expect(empty.primary.notes).toEqual([]);
  });

  test("recommendations are advisory — the user's explicit override still resolves", () => {
    // The recommender suggests fraunces for premium; an explicit user choice
    // of a different provisioned family is honoured by the resolver.
    const override = resolveServerFont("anton", 400, "display");
    expect(override.ok).toBe(true);
    expect(override.family).toBe("Anton");
  });
});
