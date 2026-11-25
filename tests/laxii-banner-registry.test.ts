/// <reference types="bun-types" />
/**
 * M33.4-A — versioned universal banner canvas registry (regression suite).
 *
 * Pins the expanded registry contract:
 *  - the canonical 2048×687 BEAN Folio preset stays FIRST and byte-identical;
 *  - every registry entry is internally consistent (unique slugs, safe area
 *    inside the canvas, bounded dimensions);
 *  - official platform entries carry checkedAt/sourceUrl provenance and the
 *    unverified X/Twitter surface is absent;
 *  - resolveCustomBannerCanvas enforces the documented limits and NEVER
 *    silently clamps;
 *  - canvasMatchesPreset accepts registry presets, bounded custom canvases,
 *    and keeps legacy slugs on the direct path;
 *  - buildPlainBannerBrief compiles the pipeline brief for a NON-canonical
 *    preset end-to-end (multi-preset pipeline support).
 *
 * Pure test — no DB, no network.
 * Run: bun test tests/laxii-banner-registry.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  BANNER_PRESETS,
  BANNER_SPEC_CHECKED_AT,
  CUSTOM_BANNER_SLUG,
  CUSTOM_CANVAS_LIMITS,
  bannerPreset,
  bannerPresetsForClient,
  canonicalBannerPreset,
  findBannerPreset,
  resolveCustomBannerCanvas,
} from "@/lib/laxii/banner-presets";
import { buildPlainBannerBrief, canvasMatchesPreset } from "@/lib/laxii/banner-request";
import { compileBriefPrompt } from "@/lib/laxii/design-brief";

describe("banner registry — canonical contract", () => {
  test("the canonical BEAN Folio preset is registry entry 0 and unchanged", () => {
    const canonical = canonicalBannerPreset();
    expect(canonical.slug).toBe("bean-folio-banner");
    expect(canonical.width).toBe(2048);
    expect(canonical.height).toBe(687);
    expect(canonical.safeArea).toEqual({ x: 143, y: 34, width: 1761, height: 618 });
    expect(BANNER_PRESETS[0]).toBe(canonical);
    // The canonical composition hint must keep its frozen wording (existing
    // prompts/tests depend on the "ONE horizontal band" guidance).
    expect(canonical.compositionHint).toContain("ONE horizontal band");
    expect(canonical.compositionHint).toContain("2048×687");
  });

  test("the canonical preset is also reachable by slug and helper lookups", () => {
    expect(findBannerPreset("bean-folio-banner")).toBe(canonicalBannerPreset());
    expect(bannerPreset("bean-folio-banner")).toBe(canonicalBannerPreset());
    expect(bannerPreset(null)).toBeNull();
    expect(bannerPreset("no-such-slug")).toBeNull();
  });
});

describe("banner registry — registry integrity", () => {
  test("the registry holds the versioned M33.4 set with unique slugs", () => {
    expect(BANNER_PRESETS.length).toBe(11);
    const slugs = BANNER_PRESETS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toEqual([
      "bean-folio-banner",
      "website-hero",
      "open-graph-card",
      "youtube-channel-banner",
      "youtube-thumbnail",
      "linkedin-profile-cover",
      "linkedin-page-cover",
      "facebook-page-cover",
      "square-campaign",
      "portrait-post",
      "story-reel",
    ]);
  });

  test("every preset is dimension-bounded and its safe area fits the canvas", () => {
    for (const p of BANNER_PRESETS) {
      expect(p.width).toBeGreaterThanOrEqual(CUSTOM_CANVAS_LIMITS.minSide);
      expect(p.height).toBeGreaterThanOrEqual(CUSTOM_CANVAS_LIMITS.minSide);
      expect(p.width).toBeLessThanOrEqual(CUSTOM_CANVAS_LIMITS.maxSide);
      expect(p.height).toBeLessThanOrEqual(CUSTOM_CANVAS_LIMITS.maxSide);
      expect(p.width * p.height).toBeLessThanOrEqual(CUSTOM_CANVAS_LIMITS.maxAreaPx);
      expect(p.safeArea.x).toBeGreaterThanOrEqual(0);
      expect(p.safeArea.y).toBeGreaterThanOrEqual(0);
      expect(p.safeArea.x + p.safeArea.width).toBeLessThanOrEqual(p.width);
      expect(p.safeArea.y + p.safeArea.height).toBeLessThanOrEqual(p.height);
      expect(p.safeArea.width).toBeGreaterThan(0);
      expect(p.safeArea.height).toBeGreaterThan(0);
      expect(p.compositionHint.length).toBeGreaterThan(20);
      expect(["site", "platform", "campaign"]).toContain(p.family);
    }
  });

  test("official platform presets carry spec provenance; non-platform ones do not", () => {
    for (const p of BANNER_PRESETS) {
      if (p.official) {
        expect(p.checkedAt).toBe(BANNER_SPEC_CHECKED_AT);
        expect(p.sourceUrl).toMatch(/^https:\/\//);
      } else {
        expect(p.checkedAt).toBeNull();
        expect(p.sourceUrl).toBeNull();
      }
    }
    // Verified official platform surfaces present.
    for (const slug of ["open-graph-card", "youtube-channel-banner", "youtube-thumbnail", "linkedin-profile-cover", "linkedin-page-cover", "facebook-page-cover", "square-campaign", "portrait-post", "story-reel"]) {
      expect(findBannerPreset(slug)?.official).toBe(true);
    }
    // Non-platform site canvases are NOT labelled official.
    expect(findBannerPreset("website-hero")?.official).toBe(false);
    expect(findBannerPreset("bean-folio-banner")?.official).toBe(false);
  });

  test("platform byte caps exist exactly where the platform documents one", () => {
    expect(findBannerPreset("open-graph-card")?.maxBytes).toBe(8_000_000);
    expect(findBannerPreset("youtube-channel-banner")?.maxBytes).toBe(6_000_000);
    expect(findBannerPreset("linkedin-profile-cover")?.maxBytes).toBe(8_000_000);
    expect(findBannerPreset("linkedin-page-cover")?.maxBytes).toBe(3_000_000);
    expect(findBannerPreset("story-reel")?.maxBytes).toBe(30_000_000);
    expect(findBannerPreset("youtube-thumbnail")?.maxBytes).toBeNull();
    expect(findBannerPreset("facebook-page-cover")?.maxBytes).toBeNull();
    expect(findBannerPreset("bean-folio-banner")?.maxBytes).toBeNull();
  });

  test("the unverified X/Twitter header surface is absent from the registry", () => {
    expect(findBannerPreset("x-header")).toBeNull();
    expect(findBannerPreset("twitter-header")).toBeNull();
  });

  test("the client projection mirrors every preset with its real byte cap", () => {
    const client = bannerPresetsForClient();
    expect(client.length).toBe(BANNER_PRESETS.length);
    for (const [i, c] of client.entries()) {
      expect(c.id).toBe(BANNER_PRESETS[i].slug);
      expect(c.maxBytes).toBe(BANNER_PRESETS[i].maxBytes);
      expect(c.formats).toEqual(["PNG", "JPEG", "WEBP"]);
      expect(c.safeArea?.w).toBe(BANNER_PRESETS[i].safeArea.width);
    }
    // The server-side compositionHint never leaves the server.
    expect(JSON.stringify(client)).not.toContain("compositionHint");
  });
});

describe("custom canvas — strict limits, never silent clamping", () => {
  test("in-bounds dimensions resolve a bounded custom canvas with a computed safe area", () => {
    const c = resolveCustomBannerCanvas(1600, 900);
    expect(c).not.toBeNull();
    expect(c!.slug).toBe(CUSTOM_BANNER_SLUG);
    expect(c!.width).toBe(1600);
    expect(c!.height).toBe(900);
    expect(c!.safeArea.width).toBe(Math.round(1600 * 0.86));
    expect(c!.safeArea.height).toBe(Math.round(900 * 0.9));
    expect(c!.official).toBe(false);
    expect(c!.family).toBe("campaign");
  });

  test("out-of-bounds dimensions are rejected, not clamped", () => {
    expect(resolveCustomBannerCanvas(CUSTOM_CANVAS_LIMITS.minSide - 1, 500)).toBeNull();
    expect(resolveCustomBannerCanvas(500, CUSTOM_CANVAS_LIMITS.minSide - 1)).toBeNull();
    expect(resolveCustomBannerCanvas(CUSTOM_CANVAS_LIMITS.maxSide + 1, 500)).toBeNull();
    expect(resolveCustomBannerCanvas(500, CUSTOM_CANVAS_LIMITS.maxSide + 1)).toBeNull();
    // Area budget: 4096×1024 fits (4,194,304 = exactly the cap); one pixel more is rejected.
    expect(resolveCustomBannerCanvas(4096, 1024)).not.toBeNull();
    expect(resolveCustomBannerCanvas(4097, 1024)).toBeNull();
    expect(resolveCustomBannerCanvas(2400, 1800)).toBeNull(); // 4.32MP > 2^22
  });

  test("partial, fractional, zero and negative inputs are rejected", () => {
    expect(resolveCustomBannerCanvas(1600, null)).toBeNull();
    expect(resolveCustomBannerCanvas(null, 900)).toBeNull();
    expect(resolveCustomBannerCanvas(undefined, undefined)).toBeNull();
    expect(resolveCustomBannerCanvas(1600.5, 900)).toBeNull();
    expect(resolveCustomBannerCanvas(0, 900)).toBeNull();
    expect(resolveCustomBannerCanvas(-800, 900)).toBeNull();
    expect(resolveCustomBannerCanvas(Number.NaN, 900)).toBeNull();
    expect(resolveCustomBannerCanvas(Number.POSITIVE_INFINITY, 900)).toBeNull();
  });
});

describe("canvasMatchesPreset — pipeline eligibility", () => {
  test("registry presets match only at their authoritative dimensions", () => {
    expect(canvasMatchesPreset({ presetSlug: "bean-folio-banner", width: 2048, height: 687 })).toBe(true);
    expect(canvasMatchesPreset({ presetSlug: "youtube-channel-banner", width: 2560, height: 1440 })).toBe(true);
    expect(canvasMatchesPreset({ presetSlug: "youtube-channel-banner", width: 2560, height: 1441 })).toBe(false);
    expect(canvasMatchesPreset({ presetSlug: "story-reel", width: 1080, height: 1920 })).toBe(true);
    expect(canvasMatchesPreset({ presetSlug: "story-reel", width: 1080, height: 687 })).toBe(false);
  });

  test("bounded custom canvases are pipeline-eligible; unbounded ones are not", () => {
    expect(canvasMatchesPreset({ presetSlug: "custom", width: 1600, height: 900 })).toBe(true);
    expect(canvasMatchesPreset({ presetSlug: "custom", width: 4096, height: 1024 })).toBe(true);
    expect(canvasMatchesPreset({ presetSlug: "custom", width: 16, height: 16 })).toBe(false);
    expect(canvasMatchesPreset({ presetSlug: "custom", width: 5000, height: 500 })).toBe(false);
    expect(canvasMatchesPreset({ presetSlug: "custom", width: 2400, height: 1800 })).toBe(false);
  });

  test("legacy/unknown slugs keep the direct path", () => {
    expect(canvasMatchesPreset({ presetSlug: "website-promo", width: 2048, height: 687 })).toBe(false);
    expect(canvasMatchesPreset({ presetSlug: "", width: 2048, height: 687 })).toBe(false);
  });
});

describe("plain banner brief — multi-preset pipeline support", () => {
  test("compiles the full pipeline brief for a non-canonical platform preset", () => {
    const brief = buildPlainBannerBrief('A launch banner for "Studio North"', "youtube-channel-banner");
    expect(brief.canvas).toEqual({
      presetSlug: "youtube-channel-banner",
      width: 2560,
      height: 1440,
    });
    expect(brief.safeArea).toEqual({ x: 663, y: 551, width: 1235, height: 338 });
    // The exact quoted wording is preserved for deterministic typography.
    expect(brief.typography.items.map((t) => t.text)).toContain("Studio North");
    expect(brief.source).toBe("USER");
  });

  test("the compiled prompt is orientation-aware for non-wide canvases", () => {
    const square = compileBriefPrompt(
      buildPlainBannerBrief("tile", "square-campaign")
    );
    expect(square).toContain("1080×1080 px (square banner)");
    const story = compileBriefPrompt(buildPlainBannerBrief("story", "story-reel"));
    expect(story).toContain("1080×1920 px (portrait banner)");
    const canonical = compileBriefPrompt(buildPlainBannerBrief("band", "bean-folio-banner"));
    expect(canonical).toContain("2048×687 px (ultra-wide banner)");
  });

  test("compiles a strictly-bounded custom canvas brief when the caller supplies real dimensions", () => {
    const brief = buildPlainBannerBrief("wide layout", "custom", { width: 1600, height: 900 });
    expect(brief.canvas).toEqual({ presetSlug: "custom", width: 1600, height: 900 });
    expect(brief.safeArea).toEqual({
      x: Math.round((1600 * (1 - 0.86)) / 2),
      y: Math.round((900 * (1 - 0.9)) / 2),
      width: Math.round(1600 * 0.86),
      height: Math.round(900 * 0.9),
    });
  });

  test("refuses unknown presets and out-of-limits custom canvases", () => {
    expect(() => buildPlainBannerBrief("x", "no-such-preset")).toThrow(/Unknown banner preset/);
    expect(() => buildPlainBannerBrief("x", "custom")).toThrow(/require explicit width and height/);
    expect(() => buildPlainBannerBrief("x", "custom", { width: 16, height: 16 })).toThrow(/dimension limits/);
    expect(() => buildPlainBannerBrief("x", "custom", { width: 2400, height: 1800 })).toThrow(/dimension limits/);
    // A canvas override disagreeing with a registry preset is refused.
    expect(() => buildPlainBannerBrief("x", "bean-folio-banner", { width: 1500, height: 300 })).toThrow(
      /override disagrees/
    );
  });
});
