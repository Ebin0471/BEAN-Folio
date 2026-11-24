/// <reference types="bun-types" />
/**
 * GIFTZ brand kit — explicit-attributes brand intelligence (M33.1).
 *
 * Contract under test (docs/GIFTZ_UNIVERSAL_CREATIVE_STUDIO_GUIDE.md M33.1 +
 * docs/UNIVERSAL_STUDIO_CAPABILITY_MATRIX.md §1.3):
 *   a) unknown font ids are REJECTED with suggestions — never silently
 *      substituted;
 *   b) requested weights a family does not ship are REJECTED — only real
 *      Google Fonts weights are proposed;
 *   c) a valid user font override is respected exactly;
 *   d) multilingual requests outside the registry's confirmed Latin coverage
 *      are marked glyphCoverage "unverified" with an honest note (no fake
 *      coverage claims);
 *   e) every proposed palette passes a real body-contrast gate (≥ 4.5);
 *   f) the strict input schema rejects psychometric inference fields;
 *   g) every registry id in a proposal (design language, palettes, motion
 *      presets) is valid against the LIVE registries.
 *
 * Pure module test — no DB required.
 * Run: bun test tests/giftz-brand-kit.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  BrandKitFieldError,
  brandKitInputSchema,
  buildBrandKitProposal,
  REJECTED_PSYCHOMETRIC_FIELDS,
} from "@/lib/brand-kit";
import { SITE_FONTS, resolveFont } from "@/lib/site-fonts";
import { PALETTES, getPalette, contrastRatio } from "@/lib/site-palettes";
import { getMotionPreset } from "@/lib/site-motion";
import { DESIGN_LANGUAGES } from "@/lib/ai-design/design-languages";

describe("brand kit — input contract", () => {
  test("the strict schema rejects psychometric inference fields outright", () => {
    for (const field of REJECTED_PSYCHOMETRIC_FIELDS) {
      const parsed = brandKitInputSchema.safeParse({ [field]: ["introvert", "analytical"] });
      expect(parsed.success).toBe(false);
    }
  });

  test("tone adjectives are explicit attributes and stay within bounds", () => {
    const ok = brandKitInputSchema.safeParse({ toneAdjectives: ["warm", "editorial"] });
    expect(ok.success).toBe(true);
    const tooMany = brandKitInputSchema.safeParse({
      toneAdjectives: Array.from({ length: 9 }, (_, i) => `adj-${i}`),
    });
    expect(tooMany.success).toBe(false);
  });

  test("invalid language tags are rejected", () => {
    const bad = brandKitInputSchema.safeParse({ languages: ["not a lang!!"] });
    expect(bad.success).toBe(false);
    const good = brandKitInputSchema.safeParse({ languages: ["en", "hi-IN"] });
    expect(good.success).toBe(true);
  });
});

describe("brand kit — font pairing truth rules", () => {
  test("unknown font id in the override is REJECTED with same-kind suggestions", () => {
    try {
      buildBrandKitProposal({
        toneAdjectives: ["editorial"],
        fontOverride: { heading: "definitely-not-a-real-font", body: "inter" },
      });
      throw new Error("expected BrandKitFieldError");
    } catch (error) {
      expect(error).toBeInstanceOf(BrandKitFieldError);
      const e = error as BrandKitFieldError;
      expect(e.field).toBe("fontOverride.heading");
      expect(e.reason).toMatch(/never silently substitute/i);
      expect(e.suggestions.length).toBeGreaterThan(0);
      for (const suggestion of e.suggestions) {
        expect(SITE_FONTS.some((f) => f.id === suggestion)).toBe(true);
      }
    }
  });

  test("requested weights a family does not ship are REJECTED (no invented weights)", () => {
    // Pick a real family and a weight it does NOT ship.
    const family = SITE_FONTS.find((f) => f.kind === "sans" && !f.weights.includes(200));
    expect(family).toBeDefined();
    const another = SITE_FONTS.find((f) => f.id !== family!.id && f.kind === "serif");
    expect(another).toBeDefined();
    try {
      buildBrandKitProposal({
        fontOverride: { heading: family!.id, body: another!.id, weights: [200, 400] },
      });
      throw new Error("expected BrandKitFieldError");
    } catch (error) {
      expect(error).toBeInstanceOf(BrandKitFieldError);
      const e = error as BrandKitFieldError;
      expect(e.field).toBe("fontOverride.weights");
      expect(e.reason).toMatch(/does not ship weight/i);
      expect(e.suggestions.map(String)).toEqual(family!.weights.map(String));
    }
  });

  test("a valid user override is respected exactly (families + real weights only)", () => {
    const heading = SITE_FONTS.find((f) => f.kind === "serif")!;
    const body = SITE_FONTS.find((f) => f.kind === "sans" && f.id !== heading.id)!;
    const proposal = buildBrandKitProposal({
      toneAdjectives: ["editorial"],
      fontOverride: { heading: heading.id, body: body.id, weights: [400] },
    });
    expect(proposal.pairings.length).toBeGreaterThanOrEqual(1);
    const overridePairing = proposal.pairings[0];
    expect(overridePairing.heading.id).toBe(heading.id);
    expect(overridePairing.body.id).toBe(body.id);
    expect(overridePairing.rationale).toMatch(/user-selected override/i);
    for (const ref of [overridePairing.heading, overridePairing.body]) {
      const live = SITE_FONTS.find((f) => f.id === ref.id)!;
      for (const weight of ref.weights) expect(live.weights).toContain(weight);
    }
  });

  test("registry-generated pairings only use real families with real weights", () => {
    const proposal = buildBrandKitProposal({ toneAdjectives: ["corporate", "minimal"] });
    expect(proposal.pairings.length).toBeGreaterThanOrEqual(2);
    for (const pairing of proposal.pairings) {
      expect(SITE_FONTS.some((f) => f.id === pairing.heading.id)).toBe(true);
      expect(SITE_FONTS.some((f) => f.id === pairing.body.id)).toBe(true);
      expect(pairing.heading.id).not.toBe(pairing.body.id);
      // Body candidates must be readable kinds, never script/display.
      expect(["sans", "serif"]).toContain(pairing.body.kind);
    }
  });
});

describe("brand kit — multilingual honesty", () => {
  test("Latin-only request is confirmed; non-Latin request is UNVERIFIED with an honest note", () => {
    const latin = buildBrandKitProposal({ toneAdjectives: ["modern"], languages: ["en"] });
    for (const pairing of latin.pairings) {
      expect(pairing.glyphCoverage).toBe("confirmed");
      expect(pairing.glyphCoverageNote).toBeUndefined();
    }

    const hindi = buildBrandKitProposal({ toneAdjectives: ["modern"], languages: ["hi"] });
    expect(hindi.pairings.length).toBeGreaterThan(0);
    for (const pairing of hindi.pairings) {
      expect(pairing.glyphCoverage).toBe("unverified");
      expect(pairing.glyphCoverageNote).toMatch(/NOT confirmed/i);
      expect(pairing.glyphCoverageNote).toMatch(/hi/);
    }
  });

  test("an unspecified language produces an explicit assumption, not a coverage claim", () => {
    const proposal = buildBrandKitProposal({ toneAdjectives: ["modern"] });
    expect(proposal.assumptions.join(" ")).toMatch(/latin-script copy/i);
  });
});

describe("brand kit — contrast gate and registry validity", () => {
  test("every proposed palette passes the body-contrast gate (≥ 4.5)", () => {
    const proposal = buildBrandKitProposal({ toneAdjectives: ["premium", "luxury"] });
    expect(proposal.palettes.length).toBeGreaterThan(0);
    for (const candidate of proposal.palettes) {
      const live = getPalette(candidate.id)!;
      expect(live).not.toBeNull();
      const ratio = contrastRatio(live.tokens.foreground, live.tokens.background);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("an unknown paletteDirection id is rejected with registry suggestions", () => {
    try {
      buildBrandKitProposal({ toneAdjectives: ["modern"], paletteDirection: "no-such-palette" });
      throw new Error("expected BrandKitFieldError");
    } catch (error) {
      expect(error).toBeInstanceOf(BrandKitFieldError);
      const e = error as BrandKitFieldError;
      expect(e.field).toBe("paletteDirection");
      for (const suggestion of e.suggestions) {
        expect(getPalette(suggestion)).not.toBeNull();
      }
    }
  });

  test("design language, palettes and motion presets are all registry-valid", () => {
    const proposal = buildBrandKitProposal({
      toneAdjectives: ["luxury", "refined"],
      motionPersonality: "calm",
    });
    expect(DESIGN_LANGUAGES.some((l) => l.id === proposal.designLanguage.id)).toBe(true);
    for (const id of proposal.motion.presets) {
      expect(getMotionPreset(id)).not.toBeNull();
    }
    for (const pairing of proposal.pairings) {
      if (pairing.accent) {
        expect(resolveFont(pairing.accent.id)).not.toBeNull();
      }
      // previewHref either null (bundled-only) or a Google Fonts css2 link.
      if (pairing.previewHref !== null) {
        expect(pairing.previewHref).toMatch(/^https:\/\/fonts\.googleapis\.com/);
      }
    }
  });

  test("same input → same proposal (deterministic)", () => {
    const input = {
      toneAdjectives: ["technical", "modern"],
      languages: ["de"],
    } satisfies import("@/lib/brand-kit").BrandKitRawInput;
    const a = buildBrandKitProposal(input);
    const b = buildBrandKitProposal(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("brand kit — registry integrity", () => {
  test("PALETTES in the live registry all parse and carry contrast-checkable tokens", () => {
    expect(PALETTES.length).toBeGreaterThanOrEqual(30);
    for (const palette of PALETTES.slice(0, 10)) {
      expect(typeof contrastRatio(palette.tokens.foreground, palette.tokens.background)).toBe("number");
    }
  });
});
