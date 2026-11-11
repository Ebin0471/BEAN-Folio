/// <reference types="bun-types" />
/**
 * Website font regression tests (lib/site-fonts + the export's font wiring).
 *
 * These pin the fixes for the "controls do not affect the preview/export"
 * bug class found in the studio audit:
 *
 *  BUG A (preview): the studio preview iframe did not carry next/font's
 *  `--font-*` CSS variables, so the bundled stacks (`var(--font-fraunces), …`)
 *  were INVALID at computed-value time — selecting Fraunces/Geist looked like
 *  nothing happened in the live preview. Fix: the frame mirrors the variable
 *  classes; the app-document stack contract below must stay var()-based.
 *
 *  BUG B (export): the static-site export used the same var() stacks but never
 *  loaded the bundled families, so exported sites silently lost Fraunces/Geist.
 *  Fix: external contexts resolve REAL family names and the export requests
 *  bundled families from the Google Fonts CDN.
 *
 * Run: bun test tests/site-fonts.test.ts
 */
import { describe, expect, test } from "bun:test";

import { fontStack, googleFontsHref } from "../src/lib/site-fonts";
import { themeFontStacks, deriveTheme, defaultConfig } from "../src/lib/site-config";
import { buildSiteExport, type SiteExportInput } from "../src/lib/site-export";

describe("fontStack — app document context (default)", () => {
  test("bundled families resolve through the next/font CSS variables", () => {
    expect(fontStack("fraunces")).toContain("var(--font-fraunces)");
    expect(fontStack("geist-sans")).toContain("var(--font-geist-sans)");
    expect(fontStack("geist-mono")).toContain("var(--font-geist-mono)");
  });

  test("non-bundled families resolve to real family names", () => {
    expect(fontStack("lora")).toContain("'Lora'");
    expect(fontStack("jetbrains-mono")).toContain("'JetBrains Mono'");
  });

  test("unknown ids fall back safely (never throw, never empty)", () => {
    const stack = fontStack("not-a-real-font");
    expect(stack.length).toBeGreaterThan(0);
    expect(stack).not.toContain("undefined");
  });
});

describe("fontStack — external document context (static export)", () => {
  test("bundled families resolve to their real Google Fonts names, never var()", () => {
    for (const id of ["fraunces", "geist-sans", "geist-mono"]) {
      const stack = fontStack(id, { external: true });
      expect(stack).not.toContain("var(--font-");
      expect(stack.startsWith("'")).toBe(true);
    }
    expect(fontStack("fraunces", { external: true })).toContain("'Fraunces'");
    expect(fontStack("geist-sans", { external: true })).toContain("'Geist'");
    expect(fontStack("geist-mono", { external: true })).toContain("'Geist Mono'");
  });

  test("non-bundled stacks are identical in both contexts", () => {
    expect(fontStack("lora", { external: true })).toBe(fontStack("lora"));
  });

  test("themeFontStacks passes the external flag through", () => {
    const theme = deriveTheme({ background: "#0a0a0c", foreground: "#f5f2ea", accent: "#d4af6a", headingFont: "fraunces", bodyFont: "geist-sans" });
    const app = themeFontStacks(theme);
    const external = themeFontStacks(theme, { external: true });
    expect(app.heading).toContain("var(--font-fraunces)");
    expect(external.heading).toContain("'Fraunces'");
    expect(external.body).toContain("'Geist'");
    expect(external.heading).not.toContain("var(--font-");
  });
});

describe("googleFontsHref — bundled family inclusion", () => {
  test("default skips bundled families (app document loads them via next/font)", () => {
    const href = googleFontsHref([
      { id: "fraunces", weights: [600, 700] },
      { id: "lora", weights: [400, 500] },
    ]);
    expect(href).toContain("family=Lora");
    expect(href).not.toContain("Fraunces");
  });

  test("includeBundled requests bundled families with their real weights", () => {
    const href = googleFontsHref(
      [
        { id: "fraunces", weights: [300, 600, 700] },
        { id: "geist-sans", weights: [400, 500, 600] },
        { id: "geist-mono", weights: [400, 600] },
      ],
      { includeBundled: true }
    );
    expect(href).toContain("https://fonts.googleapis.com/css2?");
    expect(href).toContain("family=Fraunces");
    expect(href).toContain("family=Geist");
    expect(href).toContain("family=Geist+Mono");
    // weights are real (nearest existing) and sorted per the css2 contract
    expect(href).toMatch(/family=Fraunces:wght@\d+(;\d+)+/);
  });

  test("returns null when only bundled families are requested without includeBundled", () => {
    expect(googleFontsHref([{ id: "fraunces", weights: [400] }])).toBeNull();
  });
});

describe("static export consumes external stacks (regression for BUG B)", () => {
  const config = defaultConfig("atelier"); // atelier theme = fraunces headings + geist body
  config.theme.headingFont = "fraunces";
  config.theme.bodyFont = "geist-sans";
  config.theme.accentFont = "fraunces";
  config.theme.codeFont = "geist-mono";

  const input: SiteExportInput = {
    config,
    profile: {
      name: "Ada Lovelace",
      username: "ada",
      headline: null,
      location: null,
      bio: "First programmer.",
      availability: null,
      avatarUrl: null,
      coverUrl: null,
      coverPositionY: 50,
      skills: [],
      websiteUrl: null,
      contactEmail: "ada@example.com",
      stats: { followers: 0, following: 0, projects: 0 },
    },
    projects: [],
    collections: [],
    watermark: true,
    source: "draft",
    loadMedia: async () => null,
  };

  test("exported stylesheet never references next/font variables", async () => {
    const result = await buildSiteExport(input);
    const css = result.files.find((f) => f.path === "assets/styles.css")!.data.toString("utf8");
    const html = result.files.find((f) => f.path === "index.html")!.data.toString("utf8");
    expect(css).not.toContain("var(--font-");
    expect(html).not.toContain("var(--font-");
    // and the real families ARE named where the config uses them
    expect(css).toContain("'Fraunces'");
    expect(css).toContain("'Geist'");
  });

  test("export fonts stylesheet includes the bundled families", async () => {
    const result = await buildSiteExport(input);
    const html = result.files.find((f) => f.path === "index.html")!.data.toString("utf8");
    expect(html).toContain("family=Fraunces");
    expect(html).toContain("family=Geist");
  });
});
