/// <reference types="bun-types" />
/**
 * Static website code exporter tests (lib/site-export).
 *
 * These pin the export CONTRACT the "Download Website Code" feature promises:
 *  1. a complete, self-contained file set (HTML pages, stylesheet, behavior,
 *     README, manifest) generated from the actual saved configuration;
 *  2. media assets are copied to RELATIVE paths under assets/images/ — the
 *     exported site must never reference the BEAN Folio runtime, an API
 *     route, or any preview hostname;
 *  3. only the caller's OWN media can enter the archive — a loader that
 *     refuses (not owned / missing) yields the themed fallback, and the site
 *     still exports (with a warning);
 *  4. unknown app-relative references are never emitted into the HTML;
 *  5. secrets hygiene: the archive contains no credentials/tokens/env data —
 *     by construction it only carries the passed-in public content;
 *  6. the footer attribution renders exactly once, per the platform setting,
 *     and republish-independent (it is generated, not stored);
 *  7. external absolute URLs are preserved (documented in the manifest);
 *  8. multi-page configs produce one HTML file per page with real <a> nav.
 *
 * Run: bun test tests/site-export.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  buildSiteExport,
  mediaIdFromUrl,
  sanitizePageFile,
  type ExportCollection,
  type ExportProfile,
  type ExportProject,
  type MediaLoader,
  type SiteExportInput,
} from "../src/lib/site-export";
import type { SiteConfig } from "../src/lib/site-config";

// ------------------------------------------------------------------ fixtures

const profile: ExportProfile = {
  name: "Ada Lovelace",
  username: "ada",
  headline: "Analytical engines",
  location: "London",
  bio: "First programmer.",
  availability: "Open to opportunities",
  avatarUrl: "/api/media/avatarmedia123/raw",
  coverUrl: null,
  coverPositionY: 50,
  skills: ["Mathematics", "Writing"],
  websiteUrl: null,
  contactEmail: "ada@example.com",
  stats: { followers: 3, following: 4, projects: 1 },
};

const projects: ExportProject[] = [
  {
    id: "proj1",
    title: "Notes on the Engine",
    summary: "A study of the Analytical Engine.",
    category: "writing",
    coverUrl: "/api/media/covermedia456/raw",
  },
];

const collections: ExportCollection[] = [];

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
    gradient: { from: "#101521", to: "#1a1426", angle: 155 },
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
        { id: "about-1", type: "about", visible: true, title: "About", body: "{bio}" },
        { id: "contact-1", type: "contact", visible: true, title: "Contact", body: "Write to me." },
      ],
    },
    {
      id: "work",
      name: "Work",
      visible: true,
      sections: [{ id: "projects-1", type: "projects", visible: true, title: "Selected work", layout: "grid", limit: 9, category: "" }],
    },
  ],
};

function makeLoader(owned: Record<string, { mime: string; bytes: Buffer }>): MediaLoader {
  return async (id) => owned[id] ?? null;
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8DwnwEJMDCgIQcAeIcEX3LxG6oAAAAASUVORK5CYII=",
  "base64"
);

async function exportWith(overrides: Partial<SiteExportInput> = {}) {
  const input: SiteExportInput = {
    config,
    profile,
    projects,
    collections,
    watermark: true,
    source: "draft",
    loadMedia: makeLoader({
      avatarmedia123: { mime: "image/png", bytes: png },
      covermedia456: { mime: "image/png", bytes: png },
    }),
    ...overrides,
  };
  const result = await buildSiteExport(input);
  const byPath = new Map(result.files.map((f) => [f.path, f]));
  const text = (p: string) => byPath.get(p)?.data.toString("utf8") ?? "";
  return { result, byPath, text };
}

// ------------------------------------------------------------------ helpers under test

describe("export helpers", () => {
  test("mediaIdFromUrl extracts ids from app media URLs only", () => {
    expect(mediaIdFromUrl("/api/media/abc123/raw")).toBe("abc123");
    expect(mediaIdFromUrl("/api/media/abc123")).toBe("abc123");
    expect(mediaIdFromUrl("https://evil.example/api/media/abc123/raw")).toBeNull();
    expect(mediaIdFromUrl("/api/media/../../etc/passwd/raw")).toBeNull();
    expect(mediaIdFromUrl(null)).toBeNull();
  });

  test("sanitizePageFile blocks reserved names and unsafe characters", () => {
    expect(sanitizePageFile("work")).toBe("work");
    expect(sanitizePageFile("Hello World!")).toBe("hello-world");
    expect(sanitizePageFile("index")).toBe("page-index");
    expect(sanitizePageFile("assets")).toBe("page-assets");
    expect(sanitizePageFile("../../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizePageFile("")).toBe("page");
  });
});

// ------------------------------------------------------------------ file set

describe("buildSiteExport", () => {
  test("produces the complete standalone file set", async () => {
    const { result, byPath } = await exportWith();
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("index.html");
    expect(paths).toContain("work.html");
    expect(paths).toContain("assets/styles.css");
    expect(paths).toContain("assets/site.js");
    expect(paths).toContain("README.md");
    expect(paths).toContain("manifest.json");
    expect(byPath.get("index.html")!.data.length).toBeGreaterThan(500);
  });

  test("multi-page configs emit one HTML per page with real relative nav links", async () => {
    const { text } = await exportWith();
    const home = text("index.html");
    const work = text("work.html");
    expect(home).toContain('href="./work.html"');
    expect(work).toContain('href="./index.html"');
    expect(work).toContain('aria-current="page"');
    expect(home).not.toContain("href=\"#/${''}\"");
  });

  test("template fill uses the real profile data", async () => {
    const { text } = await exportWith();
    expect(text("index.html")).toContain("Hi, I&#39;m Ada Lovelace");
    expect(text("index.html")).toContain("First programmer.");
  });
});

// ------------------------------------------------------------------ media handling

describe("media handling", () => {
  test("owned media is copied to relative asset paths and referenced relatively", async () => {
    const { result, text } = await exportWith();
    const cover = result.files.find((f) => f.path.includes("covermedia456"));
    expect(cover).toBeDefined();
    expect(cover!.path).toMatch(/^assets\/images\/img-\d+-[A-Za-z0-9_-]+\.png$/);
    // the project card references the LOCAL copy, never the API route
    expect(text("work.html")).toContain(cover!.path);
    expect(text("work.html")).not.toContain("/api/media/");
    // REFERENCED assets are exported — including the hero avatar: the site
    // hero renders the creator's profile picture (SiteAvatar), so the offline
    // archive must carry its local copy too.
    const avatar = result.files.find((f) => f.path.includes("avatarmedia123"));
    expect(avatar).toBeDefined();
    expect(avatar!.path).toMatch(/^assets\/images\//);
    expect(text("index.html")).toContain(avatar!.path);
  });

  test("unavailable media falls back to the monogram tile with a warning — export still succeeds", async () => {
    const { result, text } = await exportWith({ loadMedia: makeLoader({}) });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(text("work.html")).toContain("bs-monogram");
    expect(text("work.html")).not.toContain("/api/media/");
  });

  test("a loader that serves OTHER users' data cannot be exploited by path tricks in ids", async () => {
    // The id is extracted by mediaIdFromUrl — traversal shapes never match it,
    // so the loader is only ever called with bare app ids.
    let called: string[] = [];
    const { text } = await exportWith({
      loadMedia: async (id) => {
        called.push(id);
        return null;
      },
      projects: [{ ...projects[0], coverUrl: "/api/media/..%2F..%2F.env/raw" }],
    });
    expect(called.every((id) => /^[A-Za-z0-9]+$/.test(id))).toBe(true);
    expect(text("work.html")).not.toContain(".env");
  });
});

// ------------------------------------------------------------------ security & honesty

describe("security & honesty", () => {
  test("no secrets, credentials or env content in any file", async () => {
    const { result } = await exportWith({
      loadMedia: makeLoader({
        avatarmedia123: { mime: "image/png", bytes: png },
        covermedia456: { mime: "image/png", bytes: png },
      }),
    });
    const banned = [/password/i, /api[_-]?key/i, /secret/i, /bearer\s/i, /BEGIN [A-Z]+ PRIVATE KEY/, /postgres:\/\//, /session cookie/i];
    for (const f of result.files) {
      const content = f.data.toString("utf8");
      for (const re of banned) {
        expect(content).not.toMatch(re);
      }
    }
  });

  test("no BEAN Folio runtime or API-host references in generated HTML/CSS/JS", async () => {
    const { text } = await exportWith();
    for (const p of ["index.html", "work.html", "assets/styles.css", "assets/site.js"]) {
      expect(text(p)).not.toContain("localhost:3000");
      expect(text(p)).not.toContain("space-z.ai");
      expect(text(p)).not.toContain("fcapp.run");
      expect(text(p)).not.toContain('/api/');
    }
  });

  test("contact CTA becomes a plain mailto link — never a platform sign-in", async () => {
    const { text } = await exportWith();
    expect(text("index.html")).toContain('href="mailto:ada@example.com"');
    expect(text("index.html")).not.toContain("#/auth");
    expect(text("index.html")).not.toContain("Sign in");
  });

  test("footer attribution renders exactly once when the setting is on", async () => {
    const { text } = await exportWith({ watermark: true });
    const home = text("index.html");
    // count the visible text node (the aria-label echoes the same string)
    expect(home.match(/>Made with BEAN Folio · GIFTZ</g)?.length ?? 0).toBe(1);
    expect(home.match(/<footer class="bs-footer">/g)?.length ?? 0).toBe(1);
    const { text: t2 } = await exportWith({ watermark: false });
    expect(t2("index.html")).not.toContain("Made with BEAN Folio");
  });

  test("external absolute URLs are preserved and recorded in the manifest", async () => {
    const { text, result } = await exportWith({
      profile: { ...profile, websiteUrl: "https://example.com/ada" },
      projects: [{ ...projects[0], coverUrl: "https://cdn.example.com/cover.jpg" }],
    });
    expect(text("work.html")).toContain("https://cdn.example.com/cover.jpg");
    const manifest = JSON.parse(text("manifest.json"));
    expect(manifest.externalResources).toContain("https://cdn.example.com/cover.jpg");
    expect(manifest.unsupportedFeatures.join(" ")).toContain("mailto");
    expect(manifest.source).toBe("draft");
  });

  test("manifest inventories every file with its role", async () => {
    const { result, text } = await exportWith();
    const manifest = JSON.parse(text("manifest.json"));
    const listed = new Set<string>(manifest.files.map((f: { path: string }) => f.path));
    for (const f of result.files) expect(listed.has(f.path)).toBe(true);
  });
});
