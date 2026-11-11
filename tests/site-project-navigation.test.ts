/// <reference types="bun-types" />
/**
 * Website-native project navigation — regression tests.
 *
 * The standalone website (/site/<username>) must behave as the creator's OWN
 * independent website: every project link stays INSIDE the website and opens
 * the website-native project detail page (/site/<username>/projects/<id>) —
 * NEVER the platform's /p/<id> experience, and never a platform redirect.
 *
 * Pinned here:
 *  1. The URL builders (lib/site-url) produce the bounded route shapes.
 *  2. The proxy boot-route parser serves the SPA document at the deep path
 *     (direct URL access / refresh / pasted links) while rejecting anything
 *     outside the public shapes.
 *  3. The hash router resolves the deep path-form boot route.
 *  4. The site renderer builds ONLY website-native project links — a source
 *     audit pins the single defensive /p/ fallback inside the link helper.
 *  5. The static export generates real project detail pages and every card
 *     links to them (no dead in-page anchors).
 *
 * Run: bun test tests/site-project-navigation.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { bootRouteFromPathname } from "../src/proxy";
import { currentPath } from "../src/lib/hash-router";
import {
  publicSiteProjectAbsoluteUrl,
  publicSiteProjectHashUrl,
  publicSiteProjectPath,
} from "../src/lib/site-url";
import { buildSiteExport, type MediaLoader, type SiteExportInput } from "../src/lib/site-export";
import type { ExportProfile, ExportProject } from "../src/lib/site-export";

// ------------------------------------------------------------- 1. URL builders

describe("site project URL builders", () => {
  test("path form: /site/<username>/projects/<projectId>", () => {
    expect(publicSiteProjectPath("ebin", "proj1")).toBe("/site/ebin/projects/proj1");
    expect(publicSiteProjectPath("  Ebin  ", "proj1")).toBe("/site/ebin/projects/proj1");
    expect(publicSiteProjectPath(null, "proj1")).toBeNull();
    expect(publicSiteProjectPath("ebin", null)).toBeNull();
    expect(publicSiteProjectPath("ebin", "  ")).toBeNull();
  });

  test("hash form keeps the # prefix for in-app anchors", () => {
    expect(publicSiteProjectHashUrl("ebin", "proj1")).toBe("#/site/ebin/projects/proj1");
    expect(publicSiteProjectHashUrl("ebin", "a b/c")).toBe("#/site/ebin/projects/a%20b%2Fc");
  });

  test("absolute URL requires an explicit verified origin", () => {
    expect(publicSiteProjectAbsoluteUrl("ebin", "proj1", "https://beanfolio.com")).toBe(
      "https://beanfolio.com/site/ebin/projects/proj1"
    );
    expect(publicSiteProjectAbsoluteUrl("ebin", "proj1", null)).toBeNull();
    expect(publicSiteProjectAbsoluteUrl("ebin", "proj1", "https://beanfolio.com/")).toBe(
      "https://beanfolio.com/site/ebin/projects/proj1"
    );
  });
});

// --------------------------------------------------- 2. proxy boot-route parser

describe("proxy boot route for /site/<username>/projects/<projectId>", () => {
  test("deep project path boots the SPA document at that route", () => {
    expect(bootRouteFromPathname("/site/ebin/projects/proj1")).toBe("/site/ebin/projects/proj1");
    expect(bootRouteFromPathname("/site/ebin")).toBe("/site/ebin");
    expect(bootRouteFromPathname("/u/ada")).toBe("/u/ada");
    expect(bootRouteFromPathname("/p/proj1")).toBe("/p/proj1");
  });

  test("percent-encoded segments pass through untouched (client decodes)", () => {
    expect(bootRouteFromPathname("/site/eb%69n/projects/pr%6Fj1")).toBe("/site/eb%69n/projects/pr%6Fj1");
  });

  test("anything outside the public shapes is rejected", () => {
    expect(bootRouteFromPathname("/site/ebin/projects/proj1/extra")).toBeNull();
    expect(bootRouteFromPathname("/site/ebin/anything-else")).toBeNull();
    expect(bootRouteFromPathname("/site/ebin/projects/")).toBeNull();
    expect(bootRouteFromPathname("/site/")).toBeNull();
    expect(bootRouteFromPathname("/u/ada/extra")).toBeNull();
    expect(bootRouteFromPathname("/p/proj1/extra")).toBeNull();
    expect(bootRouteFromPathname("/api/site/ebin")).toBeNull();
    expect(bootRouteFromPathname("/")).toBeNull();
  });
});

// ------------------------------------------------------- 3. hash router boot

describe("hash router path-form boot for deep site routes", () => {
  test("a deep public pathname IS the route (direct visits, refreshes)", () => {
    // The module was imported while no window existed, so its module-scope
    // boot canonicalization was skipped; stubbing the minimum window surface
    // now lets currentPath() resolve the real pathname branch.
    const win = globalThis as unknown as { window?: unknown };
    win.window = {
      location: { hash: "", pathname: "/site/ebin/projects/proj1", search: "" },
      history: { replaceState() {}, pushState() {} },
      dispatchEvent() {},
      addEventListener() {},
      removeEventListener() {},
    };
    try {
      expect(currentPath()).toBe("/site/ebin/projects/proj1");
      win.window = {
        location: { hash: "", pathname: "/site/eb%69n/projects/pr%6Fj1", search: "" },
        history: { replaceState() {}, pushState() {} },
        dispatchEvent() {},
        addEventListener() {},
        removeEventListener() {},
      };
      expect(currentPath()).toBe("/site/ebin/projects/proj1");
      win.window = {
        location: { hash: "", pathname: "/definitely/not/public", search: "" },
        history: { replaceState() {}, pushState() {} },
        dispatchEvent() {},
        addEventListener() {},
        removeEventListener() {},
      };
      expect(currentPath()).toBe("/");
    } finally {
      delete win.window;
    }
  });
});

// --------------------------------------------- 4. renderer link-target audit

describe("site renderer builds only website-native project links", () => {
  const rendererSource = readFileSync("src/components/bean/site/SiteRenderer.tsx", "utf8");

  test("exactly ONE /p/ reference remains — the defensive fallback in the link helper", () => {
    const occurrences = rendererSource.split("#/p/").length - 1;
    expect(occurrences).toBe(1);
    expect(rendererSource).toContain("publicSiteProjectHashUrl(profile.username, projectId) ?? `#/p/");
  });

  test("every project link site goes through siteProjectHref", () => {
    // definition + card + list + editorial + gallery strip/masonry/grid
    const callSites = (rendererSource.match(/siteProjectHref\(/g) ?? []).length;
    expect(callSites).toBeGreaterThanOrEqual(7);
    expect(rendererSource).not.toContain('href={`#/p/');
  });

  test("the router mounts the website-native project detail view", () => {
    const shellSource = readFileSync("src/components/bean/SiteShell.tsx", "utf8");
    expect(shellSource).toContain('SiteProjectDetailView');
    expect(shellSource).toContain('c === "projects"');
  });
});

// --------------------------------------------------- 5. static export pages

const profile: ExportProfile = {
  name: "Ada Lovelace",
  username: "ada",
  headline: "Analytical engines",
  location: "London",
  bio: "First programmer.",
  availability: null,
  avatarUrl: null,
  coverUrl: null,
  coverPositionY: 50,
  skills: ["Mathematics"],
  websiteUrl: null,
  contactEmail: null,
  stats: { followers: 3, following: 4, projects: 1 },
};

const detailProject: ExportProject = {
  id: "proj1",
  title: "Notes on the Engine",
  summary: "A study of the Analytical Engine.",
  category: "writing",
  coverUrl: "/api/media/covermedia456/raw",
  description: "Full description of the engine notes.",
  role: "Author",
  tools: ["Pen", "Paper"],
  skills: ["Mathematics"],
  brief: "Explain the engine.",
  process: "Wrote it down.",
  externalUrl: "https://example.com/engine",
  repoUrl: null,
  publishedAt: "2026-11-01T00:00:00.000Z",
  media: [
    { url: "/api/media/gallerymedia1/raw", kind: "IMAGE", caption: "Diagram one" },
    { url: "/api/media/clipvideo1/raw", kind: "VIDEO", caption: null },
  ],
};

const config = {
  version: 2 as const,
  template: "atelier" as const,
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
    accent2: "#e8c66f",
    focus: "#6fd3e8",
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
        { id: "hero-1", type: "hero", visible: true, title: "Hi, I'm {name}", subtitle: "{tagline}", variant: "classic", ctaLabel: "", ctaHref: "" },
      ],
    },
    {
      id: "work",
      name: "Work",
      visible: true,
      sections: [{ id: "projects-1", type: "projects", visible: true, title: "Selected work", layout: "grid", limit: 9, category: "" }],
    },
  ],
} as unknown as Parameters<typeof buildSiteExport>[0]["config"];

function makeLoader(owned: Record<string, { mime: string; bytes: Buffer }>): MediaLoader {
  return async (id) => owned[id] ?? null;
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8DwnwEJMDCgIQcAeIcEX3LxG6oAAAAASUVORK5CYII=",
  "base64"
);

describe("static export project detail pages", () => {
  test("every project gets a real detail page and every card links to it", async () => {
    const input: SiteExportInput = {
      config,
      profile,
      projects: [detailProject],
      collections: [],
      watermark: true,
      source: "draft",
      loadMedia: makeLoader({
        gallerymedia1: { mime: "image/png", bytes: png },
        covermedia456: { mime: "image/png", bytes: png },
      }),
    };
    const result = await buildSiteExport(input);
    const byPath = new Map(result.files.map((f) => [f.path, f.data.toString("utf8")]));

    // The detail page exists and carries the project's real content.
    const detail = byPath.get("project-proj1.html");
    expect(detail).toBeDefined();
    expect(detail!).toContain("Notes on the Engine");
    expect(detail!).toContain("A study of the Analytical Engine.");
    expect(detail!).toContain("Full description of the engine notes.");
    expect(detail!).toContain("Back to Ada&#39;s Folio");
    expect(detail!).toContain("Gallery");
    expect(detail!).toContain("Diagram one");
    expect(detail!).toContain("./assets/styles.css");
    // external links preserved; repo link absent (null in fixture)
    expect(detail!).toContain('href="https://example.com/engine"');

    // Only the IMAGE gallery item is bundled — VIDEO media is not exported.
    expect(byPath.has("project-proj1.html")).toBe(true);
    const assetNames = result.files.filter((f) => f.path.startsWith("assets/images/")).map((f) => f.path);
    expect(assetNames.some((p) => p.includes("gallerymedia1"))).toBe(true);
    expect(assetNames.some((p) => p.includes("clipvideo1"))).toBe(false);

    // Cards link to the detail page — no dead in-page anchors anywhere.
    const work = byPath.get("work.html") ?? "";
    expect(work).toContain('href="./project-proj1.html"');
    expect(work).not.toContain("#project-proj1");
    const index = byPath.get("index.html") ?? "";
    expect(index).not.toContain("#project-proj1");

    // Manifest inventories the new pages.
    const manifest = JSON.parse(byPath.get("manifest.json") ?? "{}") as { files: { path: string }[] };
    expect(manifest.files.some((f) => f.path === "project-proj1.html")).toBe(true);
  });

  test("card-only projects (no detail fields) still get a valid detail page", async () => {
    const input: SiteExportInput = {
      config,
      profile,
      projects: [{ id: "proj2", title: "Card only", summary: null, category: null, coverUrl: null }],
      collections: [],
      watermark: false,
      source: "draft",
      loadMedia: makeLoader({}),
    };
    const result = await buildSiteExport(input);
    const byPath = new Map(result.files.map((f) => [f.path, f.data.toString("utf8")]));
    const detail = byPath.get("project-proj2.html");
    expect(detail).toBeDefined();
    expect(detail!).toContain("Card only");
    expect(detail!).not.toContain("Gallery");
  });
});
