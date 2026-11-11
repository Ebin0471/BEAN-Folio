/// <reference types="bun-types" />
/**
 * Regression tests for the Website Studio audit fixes (worklog: audit-fix pass).
 *
 * Each test pins a REAL bug that was fixed — if one of these fails, a user-
 * visible regression is back:
 *
 *  D6  revealPresetCss children rules are scoped per preset (no cross-section
 *      leak of stagger initial states)
 *  D8  normalizeHexColor: 3/4/6/8-digit hex normalize to 6-digit (derivation,
 *      contrast math and color pickers assume 6-digit)
 *  V2  storage byte-range reads (HTTP 206 seeking) — getObjectSize +
 *      getObjectRange roundtrip on the local driver
 *  S1  rate-limit client key uses the RIGHTMOST X-Forwarded-For hop (the
 *      client-controlled leftmost value allowed unlimited bucket rotation)
 *  D5  export stagger emits React-parity indexed .bs-sh wrappers (cards no
 *      longer enter as one unit)
 *  D7  export HTML carries a <noscript> reveal reset (no permanently
 *      invisible content without JS)
 *  D4  export collections honor the grid-columns token
 *  M2  export handles video covers (<video> + .mp4 asset, not a broken
 *      <img>/*.bin) and non-image covers (themed tile + honest warning)
 *  M2b export project cards carry id="project-<id>" so card anchors resolve
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { normalizeHexColor, mixHex, normalizeMotion, defaultMotion, sectionMotion } from "../src/lib/site-config";
import { revealPresetCss, MOTION_PRESET_IDS } from "../src/lib/site-motion";
import { getClientKey } from "../src/lib/api-helpers";
import { putObject, getObjectSize, getObjectRange, deleteObject, uploadDir } from "../src/lib/storage";
import {
  buildSiteExport,
  type ExportProfile,
  type ExportProject,
  type ExportCollection,
  type MediaLoader,
  type SiteExportInput,
} from "../src/lib/site-export";
import type { SiteConfig } from "../src/lib/site-config";

// ------------------------------------------------------------------ D8 colors

describe("normalizeHexColor (color token normalization)", () => {
  test("expands 3-digit hex", () => {
    expect(normalizeHexColor("#abc")).toBe("#aabbcc");
    expect(normalizeHexColor("#ABC")).toBe("#aabbcc");
  });
  test("expands 4-digit hex by dropping alpha", () => {
    expect(normalizeHexColor("#abcd")).toBe("#aabbcc");
  });
  test("keeps 6-digit hex (lowercased)", () => {
    expect(normalizeHexColor("#FF8E5E")).toBe("#ff8e5e");
  });
  test("strips alpha from 8-digit hex", () => {
    expect(normalizeHexColor("#ff8e5e80")).toBe("#ff8e5e");
    expect(normalizeHexColor("#FF8E5E80")).toBe("#ff8e5e");
  });
  test("bare CSS words pass through unchanged", () => {
    expect(normalizeHexColor("white")).toBe("white");
  });
  test("derived tokens work with normalized input (mixHex no longer falls back)", () => {
    // a missing surface derived from a 3-digit background used to return the
    // raw 3-digit accent (or #888888); with normalization it derives a real mix
    const mixed = mixHex(normalizeHexColor("#fff"), normalizeHexColor("#000"), 0.06);
    expect(mixed).toMatch(/^#[0-9a-f]{6}$/);
    expect(mixed).not.toBe("#888888");
  });
});

// ------------------------------------------------------------------ D6 motion scoping

describe("revealPresetCss stagger scoping", () => {
  test("children rules are scoped to the preset container class", () => {
    const presetWithChildren = MOTION_PRESET_IDS.find((id) => {
      const css = revealPresetCss(id);
      return css.includes(".bs-stagger");
    });
    expect(presetWithChildren).toBeDefined();
    const css = revealPresetCss(presetWithChildren!);
    // scoped form present…
    expect(css).toContain(`.bs-r-${presetWithChildren}.bs-stagger > *`);
    // …and the unscoped leak form is gone
    expect(css).not.toContain(".bean-site .bs-stagger > *");
    expect(css).not.toContain(".bean-site .bs-stagger.bs-in > *");
  });
});

describe("motion delay control (site-wide, stagger-aware)", () => {
  test("schema defaults delay to 0 and rejects out-of-range (fail-closed, like every motion field)", () => {
    const m = defaultMotion();
    expect(m.delay).toBe(0);
    expect(normalizeMotion({ delay: 300 }).delay).toBe(300);
    // out-of-range values are rejected by the schema — same convention as duration/stagger
    expect(() => normalizeMotion({ delay: -50 })).toThrow();
    expect(() => normalizeMotion({ delay: 9999 })).toThrow();
    // legacy configs without the field keep working
    expect(normalizeMotion({}).delay).toBe(0);
  });

  test("delay is plumbed into reveal CSS as a container var, ON TOP of stagger (never instead of it)", () => {
    const presetWithChildren = MOTION_PRESET_IDS.find((id) => revealPresetCss(id).includes(".bs-stagger"));
    expect(presetWithChildren).toBeDefined();
    const css = revealPresetCss(presetWithChildren!);
    // container transition honours the base delay…
    expect(css).toContain("transition-delay: var(--bs-delay, 0ms)");
    // …staggered children still stagger, offset by the base delay
    expect(css).toContain("calc(var(--bs-delay, 0ms) + var(--bs-i, 0) * var(--bs-stag, 60ms))");
    // and the old stagger-only delay form is gone
    expect(css).not.toContain("transition-delay: calc(var(--bs-i, 0) * var(--bs-stag");
  });

  test("site-wide delay survives per-section motion overrides (isolation)", () => {
    // sectionMotion spreads the site motion, so a section that overrides only
    // preset/duration must still inherit the site-wide delay
    const site = normalizeMotion({ delay: 250 });
    const section = { id: "s1", type: "hero", visible: true, title: "", motion: { preset: "zoom", duration: 400 } } as never;
    const effective = sectionMotion(site, section);
    expect(effective.delay).toBe(250);
    expect(effective.preset).toBe("zoom");
  });
});

// ------------------------------------------------------------------ S1 rate-limit key

describe("getClientKey (X-Forwarded-For hardening)", () => {
  const reqWith = (xff: string | null) =>
    ({ headers: { get: (k: string) => (k.toLowerCase() === "x-forwarded-for" ? xff : null) } }) as never;

  test("uses the RIGHTMOST proxy hop, not the client-controlled leftmost", () => {
    expect(getClientKey(reqWith("1.2.3.4, 10.0.0.9, 10.0.0.1"))).toBe("10.0.0.1");
  });
  test("single hop passes through", () => {
    expect(getClientKey(reqWith("1.2.3.4"))).toBe("1.2.3.4");
  });
  test("no header → local", () => {
    expect(getClientKey(reqWith(null))).toBe("local");
  });
});

// ------------------------------------------------------------------ V2 storage ranges

describe("storage byte-range reads (video seeking)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bean-range-"));
  const KEY = "uploads/test-user/range-test.mp4";
  const DATA = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));

  beforeAll(async () => {
    process.env.MEDIA_LOCAL_ROOT = root;
    process.env.MEDIA_STORAGE_DRIVER = "local";
    await putObject(KEY, DATA, "video/mp4");
  });
  afterAll(() => {
    deleteObject(KEY).catch(() => undefined);
    delete process.env.MEDIA_LOCAL_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  test("getObjectSize returns the full length without reading content", async () => {
    expect(await getObjectSize(KEY)).toBe(4096);
  });

  test("getObjectRange reads an inclusive slice", async () => {
    const chunk = await getObjectRange(KEY, 100, 199);
    expect(chunk.length).toBe(100);
    expect(Buffer.compare(chunk, DATA.subarray(100, 200))).toBe(0);
  });

  test("suffix range at the end of the file", async () => {
    const chunk = await getObjectRange(KEY, 4090, 4095);
    expect(chunk.length).toBe(6);
    expect(Buffer.compare(chunk, DATA.subarray(4090))).toBe(0);
  });

  test("uploadDir still resolves under the temp root", () => {
    expect(uploadDir().startsWith(root)).toBe(true);
  });
});

// ------------------------------------------------------------------ export fixes

const profile: ExportProfile = {
  name: "Ada Lovelace",
  username: "ada",
  headline: "Analytical engines",
  location: "London",
  bio: "First programmer.",
  availability: "Open to opportunities",
  avatarUrl: null,
  coverUrl: null,
  coverPositionY: 50,
  skills: ["Mathematics", "Writing"],
  websiteUrl: null,
  contactEmail: "ada@example.com",
  stats: { followers: 3, following: 4, projects: 1 },
};

const projects: ExportProject[] = [
  { id: "proj1", title: "Notes on the Engine", summary: "A study.", category: "writing", coverUrl: "/api/media/vid1/raw" },
  { id: "proj2", title: "Second Note", summary: null, category: "writing", coverUrl: "/api/media/vid2/raw" },
  { id: "proj3", title: "Third Note", summary: null, category: "writing", coverUrl: null },
];

const collections: ExportCollection[] = [
  { id: "col1", name: "Engines", description: null, items: [projects[0]] },
];

const config: SiteConfig = {
  version: 2,
  template: "atelier",
  name: "Ada's Folio",
  tagline: "Compute everything",
  coverMediaId: null,
  theme: {
    background: "#0d1017",
    foreground: "#eef2f8",
    accent: "#6fd3e8",
    surface: "#151a24",
    border: "#252d3d",
    muted: "#93a0b4",
    gradient: null,
    surfaceOpacity: 100,
    font: "figtree",
    headingFont: "figtree",
    bodyFont: "figtree",
    radius: "md",
    density: "regular",
    typeScale: "balanced",
    lineHeight: "normal",
    letterSpacing: "normal",
    headingWeight: "semibold",
    contentWidth: "regular",
    columns: 0,
    buttonStyle: "rounded",
    linkStyle: "accent",
    imageRatio: "4/3",
    divider: "line",
    pageTransition: "fade",
    navLayout: "inline",
    headingAlign: "left",
  },
  motion: {
    enabled: true,
    preset: "fadeUp",
    duration: 600,
    stagger: 60,
    delay: 0,
    easing: "smooth",
    intensity: 50,
    hoverEffects: true,
    scrollReveal: true,
    once: true,
    background: "bg-none",
    microInteractions: "hover-lift",
    scrollProgress: false,
  },
  pages: [
    {
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        { id: "hero-1", type: "hero", visible: true, title: "Hi, I'm {name}", subtitle: "{tagline}", variant: "classic", ctaLabel: "Say hello", ctaHref: "" },
        { id: "projects-1", type: "projects", visible: true, title: "Selected work", layout: "grid", limit: 9, category: "" },
        { id: "collections-1", type: "collections", visible: true, title: "Collections", limit: 6 },
        { id: "contact-1", type: "contact", visible: true, title: "Contact", body: "Write to me." },
      ],
    },
  ],
};

// Minimal valid video/mp4 buffer (ftyp box) and a PDF header.
const mp4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(64, 7)]);
const pdf = Buffer.concat([Buffer.from("%PDF-1.4"), Buffer.alloc(32, 32)]);

function makeLoader(owned: Record<string, { mime: string; bytes: Buffer }>): MediaLoader {
  return async (id) => owned[id] ?? null;
}

async function exportWith(overrides: Partial<SiteExportInput> = {}) {
  const input: SiteExportInput = {
    config,
    profile,
    projects,
    collections,
    watermark: true,
    source: "draft",
    loadMedia: makeLoader({
      vid1: { mime: "video/mp4", bytes: mp4 },
      vid2: { mime: "application/pdf", bytes: pdf },
    }),
    ...overrides,
  };
  const result = await buildSiteExport(input);
  const byPath = new Map(result.files.map((f) => [f.path, f]));
  const text = (p: string) => byPath.get(p)?.data.toString("utf8") ?? "";
  return { result, byPath, text };
}

describe("site export audit fixes", () => {
  test("D7: pages carry a <noscript> reveal reset", async () => {
    const { text } = await exportWith();
    const html = text("index.html");
    expect(html).toContain("<noscript>");
    expect(html).toContain(".bean-site .bs-reveal,.bean-site .bs-reveal .bs-sh,.bean-site .bs-reveal .bs-w{opacity:1 !important");
  });

  test("D5: staggered project grid emits React-parity indexed .bs-sh children", async () => {
    const { text } = await exportWith();
    const html = text("index.html");
    // the reveal container itself carries the grid classes…
    expect(html).toMatch(/class="bs-reveal-host bs-reveal bs-r-fadeUp bs-stagger bs-grid cols-3"/);
    // …and every card is wrapped with an index carrier
    expect(html).toContain('<div class="bs-sh" style="--bs-i:0">');
    expect(html).toContain('<div class="bs-sh" style="--bs-i:1">');
    expect(html).toContain('<div class="bs-sh" style="--bs-i:2">');
  });

  test("D4: collections section honors the grid-columns token", async () => {
    const twoCols = await exportWith({ config: { ...config, theme: { ...config.theme, columns: 2 } } });
    expect(twoCols.text("index.html")).toMatch(/bs-stagger bs-grid cols-2/);
    const threeCols = await exportWith();
    expect(threeCols.text("index.html")).toMatch(/bs-stagger bs-grid cols-3/);
  });

  test("M2: video covers export as <video> with a real .mp4 asset", async () => {
    const { byPath, text } = await exportWith();
    const html = text("index.html");
    expect(html).toContain("<video");
    expect(html).toMatch(/<video class="bs-img-cover" src="assets\/images\/img-\d+-vid1\.mp4"/);
    const videoAsset = Array.from(byPath.keys()).find((p) => p.endsWith("vid1.mp4"));
    expect(videoAsset).toBeDefined();
    const bytes = byPath.get(videoAsset!)!.data;
    expect(bytes.subarray(4, 8).toString("ascii")).toBe("ftyp");
  });

  test("M2: non-image covers fall back to the themed tile with an honest warning", async () => {
    const { text, result } = await exportWith();
    // proj2's cover is a PDF — no broken <img>/*.bin, monogram tile instead
    expect(text("index.html")).not.toMatch(/img-\d+-vid2\.bin/);
    expect(result.warnings.some((w) => w.includes("pdf") || w.toLowerCase().includes("themed tile"))).toBe(true);
  });

  test("M2b: project cards carry resolvable id anchors", async () => {
    const { text } = await exportWith();
    const html = text("index.html");
    expect(html).toContain('id="project-proj1"');
    expect(html).toContain('id="project-proj2"');
  });
});

// ---------------------------------------------------------------------------
// Logo & direct-editing pass (worklog: settings-fix pass)
// ---------------------------------------------------------------------------

import { normalizeConfig, safeCtaHref, siteLogoSrc, makeSection, BEAN_FOLIO_LOGO_PATH, type SiteSection } from "@/lib/site-config";

describe("branding logo config fields", () => {
  const base = {
    version: 2 as const,
    template: "atelier" as const,
    name: "Logo site",
    tagline: "",
    theme: { background: "#090a0c", foreground: "#f7f5ef", accent: "#e8bc51", font: "fraunces" },
    sections: [{ id: "hero-1", type: "hero" as const, visible: true, title: "Hi", subtitle: "", variant: "classic" as const, ctaLabel: "", ctaHref: "" }],
  };

  test("normalizeConfig preserves logoMediaId / logoPreset", () => {
    const withMedia = normalizeConfig({ ...base, logoMediaId: "media123" });
    expect(withMedia).not.toBeNull();
    expect(withMedia!.logoMediaId).toBe("media123");
    expect(withMedia!.logoPreset).toBeNull();

    const withPreset = normalizeConfig({ ...base, logoPreset: "bean-folio" });
    expect(withPreset).not.toBeNull();
    expect(withPreset!.logoPreset).toBe("bean-folio");
    expect(withPreset!.logoMediaId).toBeNull();
  });

  test("normalizeConfig defaults absent logo fields to null (legacy configs stay valid)", () => {
    const legacy = normalizeConfig(base);
    expect(legacy).not.toBeNull();
    expect(legacy!.logoMediaId).toBeNull();
    expect(legacy!.logoPreset).toBeNull();
  });

  test("siteLogoSrc resolves the built-in mark, uploaded media and rejects junk ids", () => {
    expect(siteLogoSrc({ logoPreset: "bean-folio", logoMediaId: null })).toBe(BEAN_FOLIO_LOGO_PATH);
    expect(siteLogoSrc({ logoPreset: null, logoMediaId: "abc123" })).toBe("/api/media/abc123/raw");
    // path-traversal / injection-style ids never reach an <img src>
    expect(siteLogoSrc({ logoPreset: null, logoMediaId: "../../etc/passwd" })).toBeNull();
    expect(siteLogoSrc({ logoPreset: null, logoMediaId: "x/y?z" })).toBeNull();
    expect(siteLogoSrc({ logoPreset: null, logoMediaId: null })).toBeNull();
    expect(siteLogoSrc(null)).toBeNull();
  });
});

describe("safeCtaHref (CTA destination sanitization)", () => {
  test("allows in-page anchors and absolute http(s) URLs", () => {
    expect(safeCtaHref("#bs-contact")).toBe("#bs-contact");
    expect(safeCtaHref("https://example.com/work")).toBe("https://example.com/work");
    expect(safeCtaHref("http://example.com")).toBe("http://example.com");
  });

  test("drops javascript:, data:, vbscript: and protocol-relative URLs", () => {
    expect(safeCtaHref("javascript:alert(1)")).toBeNull();
    expect(safeCtaHref("JAVASCRIPT:alert(1)")).toBeNull();
    expect(safeCtaHref("data:text/html,<script>1</script>")).toBeNull();
    expect(safeCtaHref("vbscript:x")).toBeNull();
    expect(safeCtaHref("//evil.example")).toBeNull();
  });

  test("empty/undefined falls back to null (renderer uses the contact anchor)", () => {
    expect(safeCtaHref("")).toBeNull();
    expect(safeCtaHref(undefined)).toBeNull();
    expect(safeCtaHref(null)).toBeNull();
  });
});

describe("per-section style overrides (direct editing)", () => {
  test("section style survives normalizeConfig and migrates into pages", () => {
    const cfg = normalizeConfig({
      version: 2,
      template: "atelier",
      name: "Styled",
      tagline: "",
      theme: { background: "#090a0c", foreground: "#f7f5ef", accent: "#e8bc51", font: "fraunces" },
      sections: [
        {
          id: "about-1",
          type: "about" as const,
          visible: true,
          title: "About",
          body: "x",
          style: { headingFont: "lora", headingWeight: "bold" as const, titleColor: "#00ff88" },
        },
      ],
    });
    expect(cfg).not.toBeNull();
    const s = cfg!.pages[0].sections[0];
    expect(s.style).toEqual({ headingFont: "lora", headingWeight: "bold", titleColor: "#00ff88" });
  });

  test("an invalid style headingWeight is rejected by the schema (config invalid, never rendered broken)", () => {
    const cfg = normalizeConfig({
      version: 2,
      template: "atelier",
      name: "Bad",
      tagline: "",
      theme: { background: "#090a0c", foreground: "#f7f5ef", accent: "#e8bc51", font: "fraunces" },
      sections: [
        { id: "about-1", type: "about" as const, visible: true, title: "About", body: "x", style: { headingWeight: "ultra" } },
      ],
    });
    expect(cfg).toBeNull();
  });

  test("makeSection('hero') carries the ctaHref field", () => {
    const hero = makeSection("hero");
    // makeSection returns the SiteSection union; narrow to the hero member
    // for the field access (runtime behavior unchanged).
    expect((hero as Extract<SiteSection, { type: "hero" }>).ctaHref).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Motion intensity / split-text / reduced-motion fixes (audit round 2)
// ---------------------------------------------------------------------------

import { baseMotionCss } from "../src/lib/site-motion";
import { siteCoverSrc } from "../src/lib/site-config";

describe("intensity drives every motion family", () => {
  test("scale presets expose the intensity variable (zoom family is no longer a no-op)", () => {
    const css = revealPresetCss("zoom");
    expect(css).toContain("scale(max(0, calc(1 +");
    expect(css).toContain("var(--bs-int, 50)");
  });

  test("mask/clip presets scale their inset START (end state stays fully revealed)", () => {
    const css = revealPresetCss("maskReveal");
    expect(css).toContain("clip-path: inset(0 0 calc(100% * var(--bs-int, 50) / 50) 0);");
    // End state unscaled — the reveal always lands fully visible.
    expect(css).toContain("clip-path: inset(0 0 0% 0)");
  });

  test("color filter presets (grayscale/duotone/brightness) expose intensity", () => {
    expect(revealPresetCss("media-grayscale-in")).toContain("saturate(max(0, calc(1 +");
    expect(revealPresetCss("media-crossfade")).toContain("brightness(max(0, calc(1 +");
  });

  test("blur has no 2px floor — intensity 0 starts at 0 blur", () => {
    expect(revealPresetCss("blurIn")).toContain("blur(calc(var(--bs-int, 50) * 0.080px))");
    expect(revealPresetCss("blurIn")).not.toContain("blur(calc(2px");
  });

  test("at the default intensity 50 the authored values are preserved (no visual regression)", () => {
    // scale 0.9 at int=50 → 1 + (-0.002 * 50) = 0.9
    expect(revealPresetCss("pop")).toContain("scale(max(0, calc(1 + -0.00200 * var(--bs-int, 50))))");
  });
});

describe("reduced-motion coverage is complete", () => {
  test("ken-burns (animated <img>) stops under reduced motion", () => {
    expect(baseMotionCss()).toContain(".bean-site img { animation: none !important; }");
  });

  test("hover micro-interaction transitions stop under reduced motion", () => {
    expect(baseMotionCss()).toContain(".bean-site .bs-mi, .bean-site .bs-mi::after { transition: none !important; animation: none !important; }");
  });

  test("split-text word spans keep their inline-block + reduced-motion resets", () => {
    const css = baseMotionCss();
    expect(css).toContain(".bean-site .bs-split .bs-w { display: inline-block;");
    expect(css).toContain(".bean-site .bs-split .bs-w { opacity: 1 !important;");
  });
});

describe("legacy category slug healing", () => {
  const base = {
    version: 2 as const,
    template: "byline-journal" as const,
    name: "Journal",
    tagline: "",
    theme: { background: "#fbfaf7", foreground: "#1a1a1a", accent: "#9b2c2c", font: "newsreader" },
    sections: [
      {
        id: "p1",
        type: "projects" as const,
        visible: true,
        title: "Selected writing",
        limit: 8,
        layout: "list" as const,
        category: "writing-journalism",
      },
    ],
  };

  test("normalizeConfig maps dead slugs to the live taxonomy (sections stopped rendering empty)", () => {
    const cfg = normalizeConfig(base);
    expect(cfg).not.toBeNull();
    const s = cfg!.pages[0].sections[0];
    if (s.type !== "projects") throw new Error("wrong section");
    expect(s.category).toBe("writing");
  });

  test("current slugs pass through untouched", () => {
    const cfg = normalizeConfig({ ...base, sections: [{ ...base.sections[0], category: "writing" }] });
    expect(cfg).not.toBeNull();
    const s = cfg!.pages[0].sections[0];
    if (s.type !== "projects") throw new Error("wrong section");
    expect(s.category).toBe("writing");
  });
});

describe("empty section titles and schema-valid new items save cleanly", () => {
  const base = {
    version: 2 as const,
    template: "atelier" as const,
    name: "Titles",
    tagline: "",
    theme: { background: "#090a0c", foreground: "#f7f5ef", accent: "#e8bc51", font: "fraunces" },
    sections: [] as unknown[],
  };

  test("an untitled section is valid (clearing the Title input no longer blocks saving)", () => {
    const cfg = normalizeConfig({
      ...base,
      sections: [{ id: "about-1", type: "about", visible: true, title: "", body: "x" }],
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.pages[0].sections[0].title).toBe("");
  });

  test("the Add service / Add entry / Add quote defaults are schema-valid", () => {
    const cfg = normalizeConfig({
      ...base,
      sections: [
        { id: "s1", type: "services", visible: true, title: "Services", layout: "cards" as const, items: [{ title: "New service", description: "" }] },
        { id: "e1", type: "experience", visible: true, title: "Experience", layout: "timeline" as const, entries: [{ role: "New role", org: "", period: "", description: "" }] },
        { id: "t1", type: "testimonials", visible: true, title: "Quotes", layout: "cards" as const, items: [{ quote: "Their words about working with you.", name: "Client name", role: "" }] },
      ],
    });
    expect(cfg).not.toBeNull();
  });

  test("the old empty-item payloads stay invalid (validation unchanged for hand-crafted configs)", () => {
    const cfg = normalizeConfig({
      ...base,
      sections: [{ id: "s1", type: "services", visible: true, title: "Services", layout: "cards" as const, items: [{ title: "", description: "" }] }],
    });
    expect(cfg).toBeNull();
  });
});

describe("siteCoverSrc (hero cover override)", () => {
  test("resolves owned-media ids and rejects junk", () => {
    expect(siteCoverSrc({ coverMediaId: "abc_123" })).toBe("/api/media/abc_123/raw");
    expect(siteCoverSrc({ coverMediaId: "../../etc/passwd" })).toBeNull();
    expect(siteCoverSrc({ coverMediaId: null })).toBeNull();
    expect(siteCoverSrc(null)).toBeNull();
  });
});

describe("export parity: hover micro-motion, split text and hidden pages", () => {
  const exportProfile: ExportProfile = {
    name: "Ada Lovelace",
    username: "ada",
    headline: "Analytical engines",
    location: "London",
    bio: "First programmer.",
    availability: "Open",
    avatarUrl: null,
    coverUrl: null,
    coverPositionY: 50,
    skills: ["Math"],
    websiteUrl: null,
    contactEmail: "ada@example.com",
    stats: { followers: 1, following: 1, projects: 1 },
  };
  const exportProjects: ExportProject[] = [
    { id: "proj1", title: "Notes", summary: "", category: "writing", coverUrl: null },
  ];
  const loader: MediaLoader = async () => null;

  const heroSplitConfig: SiteConfig = {
    version: 2,
    template: "atelier",
    name: "Ada",
    tagline: "",
    coverMediaId: null,
    logoMediaId: null,
    logoPreset: null,
    theme: {
      background: "#090a0c", foreground: "#f7f5ef", accent: "#e8bc51", surface: "#131318", border: "#2a2a33",
      muted: "#a5a3a0", focus: "#e8c886", gradient: null, surfaceOpacity: 100, font: "fraunces",
      headingFont: "fraunces", bodyFont: "geist-sans", accentFont: "fraunces", codeFont: "geist-mono",
      radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal", letterSpacing: "normal",
      headingWeight: "semibold", contentWidth: "regular", columns: 0, buttonStyle: "rounded", linkStyle: "accent",
      imageRatio: "4/3", divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
      glass: null,
    },
    motion: {
      enabled: true, preset: "word-rise", duration: 600, stagger: 60, delay: 0, easing: "smooth", intensity: 50,
      hoverEffects: true, scrollReveal: true, once: true, background: "bg-none", microInteractions: "hover-lift", scrollProgress: false,
    },
    pages: [
      {
        id: "home", name: "Home", visible: true,
        sections: [
          { id: "hero-1", type: "hero", visible: true, title: "Selected work", subtitle: "", variant: "classic", ctaLabel: "See work", ctaHref: "" },
          { id: "proj-1", type: "projects", visible: true, title: "Work", limit: 6, layout: "grid", category: "" },
        ],
      },
      // Second visible page — nav links render only for multi-page sites.
      { id: "work", name: "Work", visible: true, sections: [{ id: "hero-2", type: "hero", visible: true, title: "Work", subtitle: "", variant: "classic", ctaLabel: "", ctaHref: "" }] },
      // HIDDEN page — must not be emitted as a reachable orphan file.
      { id: "draft-page", name: "Draft page", visible: false, sections: [{ id: "hero-3", type: "hero", visible: true, title: "Hidden", subtitle: "", variant: "classic", ctaLabel: "", ctaHref: "" }] },
    ],
  };

  async function exportMini(cfg: SiteConfig) {
    const input: SiteExportInput = {
      config: cfg,
      profile: exportProfile,
      projects: exportProjects,
      collections: [],
      watermark: true,
      source: "draft" as const,
      loadMedia: loader,
    };
    const result = await buildSiteExport(input);
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    const text = (p: string) => byPath.get(p)?.data.toString("utf8") ?? "";
    return { result, text };
  }

  test("split-text headings carry bs-split so word transforms actually apply", async () => {
    const { text } = await exportMini(heroSplitConfig);
    expect(text("index.html")).toContain('class="bs-split"');
  });

  test("nav links, hero CTA and project cards carry the micro-interaction classes", async () => {
    const { text } = await exportMini(heroSplitConfig);
    expect(text("index.html")).toContain('class="bs-nav-link bs-mi"');
    expect(text("index.html")).toContain("bs-btn bs-mi");
    expect(text("index.html")).toContain("bs-hoverzoom");
    // The stylesheet still ships the rules these classes consume.
    expect(text("assets/styles.css")).toContain(".bs-hoverzoom img");
  });

  test("hidden pages are not exported as reachable files", async () => {
    const { result } = await exportMini(heroSplitConfig);
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("index.html");
    expect(paths.some((p) => p.includes("draft-page"))).toBe(false);
  });
});
