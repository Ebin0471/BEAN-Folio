/**
 * LAXII quality upgrade — deterministic art-direction + plain-banner brief
 * compiler unit tests (pure functions, no DB, no provider).
 *
 * Run: bun test tests/laxii-art-direction.test.ts
 */

import { describe, expect, test } from "bun:test";

import {
  artDirections,
  compileArtDirection,
  detectArtDirection,
  extractQuotedTypography,
} from "@/lib/laxii/art-direction";
import { buildPlainBannerBrief, canvasMatchesPreset } from "@/lib/laxii/banner-request";
import { compileBriefPrompt } from "@/lib/laxii/design-brief";
import { BANNER_PRESETS } from "@/lib/laxii/banner-presets";

describe("art direction detection (deterministic)", () => {
  test("all seven professional directions are registered", () => {
    expect(artDirections().map((d) => d.id)).toEqual([
      "photorealistic-photography",
      "cinematic",
      "commercial-advertising",
      "luxury-editorial",
      "graphic-design",
      "3d-render",
      "illustration-concept-art",
    ]);
  });

  test("photorealistic portrait request classifies as photography", () => {
    const d = detectArtDirection("Realistic professional portrait photograph of a woman journalist, natural skin texture, soft window light, 85mm lens");
    expect(d?.id).toBe("photorealistic-photography");
  });

  test("commercial product advertisement classifies as commercial", () => {
    const d = detectArtDirection("Photorealistic commercial advertisement photograph of a matte black coffee mug, professional product photography");
    expect(d?.id).toBe("commercial-advertising");
  });

  test("luxury brand campaign classifies as luxury editorial", () => {
    const d = detectArtDirection("Luxury brand campaign photograph: gold wristwatch on dark marble, ultra premium");
    expect(d?.id).toBe("luxury-editorial");
  });

  test("3D product render classifies as 3d-render", () => {
    const d = detectArtDirection("High-quality 3D render of wireless earbuds, studio render, soft gradient lighting");
    expect(d?.id).toBe("3d-render");
  });

  test("illustration request classifies as concept art", () => {
    const d = detectArtDirection("Watercolor illustration of a coastal town, storybook style, painted");
    expect(d?.id).toBe("illustration-concept-art");
  });

  test("weak single-word signal does NOT hijack the direction", () => {
    // "photo" is a noise word (weight 0); nothing else steers — null expected.
    expect(detectArtDirection("a photo of my desk")).toBeNull();
  });

  test("every direction carries a professional directive", () => {
    for (const d of artDirections()) {
      expect(d.directive.length).toBeGreaterThan(80);
    }
  });
});

describe("compileArtDirection (prompt compiler)", () => {
  test("user request stays verbatim and authoritative", () => {
    const request = "Photorealistic product photograph of a ceramic mug on wet slate";
    const compiled = compileArtDirection(request);
    expect(compiled.startsWith(request)).toBe(true);
    expect(compiled).toContain("Art direction");
  });

  test("generic requests get the universal professional default", () => {
    const compiled = compileArtDirection("something nice for my website");
    expect(compiled).toContain("professional art-directed piece");
    expect(compiled).toContain("generic AI look");
  });

  test("quoted wording gets exact-text guidance; unquoted gets the no-text rule", () => {
    const withText = compileArtDirection('Poster with "NIGHT FREIGHT" headline');
    expect(withText).toContain("render that wording EXACTLY as written");
    expect(withText).toContain("Never invent additional words");

    const noText = compileArtDirection("A cinematic rain-soaked platform at night");
    expect(noText).toContain("do not paint letters");
  });

  test("compiled prompt stays bounded even for long requests", () => {
    const compiled = compileArtDirection(`Detailed brief. ${"Description ".repeat(600)}`);
    expect(compiled.length).toBeLessThan(16000 + 4000); // request + directive block
    expect(compiled.startsWith("Detailed brief.")).toBe(true);
  });
});

describe("extractQuotedTypography (deterministic exact-text extraction)", () => {
  test("straight and typographic quotes are recognised", () => {
    const a = extractQuotedTypography('Banner for "ARJUN MEHTA" with "Product Designer" subtext');
    expect(a.items.map((t) => t.text)).toEqual(["ARJUN MEHTA", "Product Designer"]);
    expect(a.items[0].role).toBe("headline");
    expect(a.items[1].role).toBe("subtext");

    const b = extractQuotedTypography("Banner for “STUDIO NOIR”");
    expect(b.items.map((t) => t.text)).toEqual(["STUDIO NOIR"]);
  });

  test("quoted segments are removed from the subject description", () => {
    const r = extractQuotedTypography('Premium banner for "ACME CORP" with dark marble background');
    expect(r.subject).not.toContain("ACME CORP");
    expect(r.subject).toContain("Premium banner for");
    expect(r.subject).toContain("dark marble background");
  });

  test("caps at four items and 120 characters per item", () => {
    const r = extractQuotedTypography('"a" "b" "c" "d" "e" "f"');
    expect(r.items.length).toBe(4);
    const long = extractQuotedTypography(`"${"x".repeat(300)}"`);
    expect(r.items.every((t) => t.text.length <= 120)).toBe(true);
    expect(long.items.length).toBe(0); // over-length quote is not extracted
  });

  test("no quotes → no items, subject keeps the full request", () => {
    const r = extractQuotedTypography("A cinematic poster without any quoted text");
    expect(r.items).toHaveLength(0);
    expect(r.subject).toBe("A cinematic poster without any quoted text");
  });
});

describe("buildPlainBannerBrief (synthetic USER brief)", () => {
  const presetSlug = BANNER_PRESETS[0].slug;

  test("compiles a schema-valid USER brief with the exact request", () => {
    const brief = buildPlainBannerBrief(
      'Premium portfolio banner for a designer. Headline "ARJUN MEHTA", subtext "Product Designer".',
      presetSlug
    );
    expect(brief.request).toContain("Premium portfolio banner for a designer.");
    expect(brief.source).toBe("USER");
    expect(brief.canvas).toEqual({ presetSlug, width: 2048, height: 687 });
    expect(brief.safeArea.width).toBeGreaterThan(0);
    expect(brief.typography.items.map((t) => t.text)).toEqual(["ARJUN MEHTA", "Product Designer"]);
    expect(brief.referenceMediaIds).toEqual([]);
  });

  test("compiled prompt forbids model-painted text when typography exists", () => {
    const brief = buildPlainBannerBrief('Banner with "NIGHT FREIGHT" title', presetSlug);
    const compiled = compileBriefPrompt(brief);
    expect(compiled).toContain("deterministic pass");
    expect(compiled).toContain("NIGHT FREIGHT");
    expect(compiled).toContain("2048×687");
  });

  test("banner without quoted text compiles freely (no typography pass)", () => {
    const brief = buildPlainBannerBrief("A cinematic charcoal banner with brass accents, no wording", presetSlug);
    expect(brief.typography.items).toHaveLength(0);
    const compiled = compileBriefPrompt(brief);
    expect(compiled).toContain("cinematic");
  });

  test("unknown preset is refused", () => {
    expect(() => buildPlainBannerBrief("x", "no-such-preset")).toThrow(/Unknown banner preset/);
  });

  test("canvasMatchesPreset accepts the authoritative canvas and rejects legacy drift", () => {
    expect(canvasMatchesPreset({ width: 2048, height: 687, presetSlug })).toBe(true);
    expect(canvasMatchesPreset({ width: 2560, height: 1440, presetSlug })).toBe(false);
  });
});

describe("fitEnginePrompt (managed gateway boundary)", () => {
  test("short prompts pass through untouched", async () => {
    const { fitEnginePrompt } = await import("@/lib/laxii/providers/managed");
    const warnings: string[] = [];
    const p = "A precise 100-character brief for the engine. ".repeat(2);
    expect(fitEnginePrompt(p, warnings)).toBe(p);
    expect(warnings).toHaveLength(0);
  });

  test("over-ceiling prompts are cut at a sentence boundary with an honest warning", async () => {
    const { fitEnginePrompt } = await import("@/lib/laxii/providers/managed");
    const warnings: string[] = [];
    const long = ("First sentence about the scene. " + "Second sentence with more art direction detail. ").repeat(60);
    const fitted = fitEnginePrompt(long, warnings);
    expect(fitted.length).toBeLessThanOrEqual(2400);
    expect(fitted.endsWith(".")).toBe(true);
    expect(warnings[0]).toContain("preserved verbatim in the conversation");
    expect(warnings[0]).toContain(long.length.toLocaleString());
  });

  test("the user's words come first in compiled prompts (truncation keeps them)", async () => {
    const { compileArtDirection } = await import("@/lib/laxii/art-direction");
    const request = "Photorealistic portrait of a ceramicist shaping clay, raku kiln glow, honest hands, natural studio light";
    const compiled = compileArtDirection(request);
    expect(compiled.startsWith(request)).toBe(true);
  });
});
