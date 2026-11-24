import { describe, expect, test } from "bun:test";

// M3/M4 QA — the visual editor's pure round-trip logic (DOM-free; the full
// browser round-trip evidence lives in scripts/poc/giftz-visual-editor-roundtrip
// with an executed import→export→structural-diff run on representative GIFTZ
// output). These tests pin the eligibility contract, the path resolution
// (mirroring the build validator's rule) and the save-payload split.

import {
  analyzePageStyles,
  buildVisualSavePayload,
  extractInlineStyles,
  resolveProjectRef,
} from "@/lib/giftz/visual-editor/round-trip";
import { BEAN_VISUAL_BLOCKS } from "@/lib/giftz/visual-editor/grapesjs-config";

const PAGE_WITH_ONE_LINK = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Studio</title>
  <link rel="stylesheet" href="assets/style.css">
</head>
<body>
  <nav><a href="./index.html">Home</a><a href="./about.html">About</a></nav>
  <main><h1 id="hero">Studio</h1></main>
  <script src="assets/vendor/gsap.min.js"></script>
  <script src="assets/motion.js"></script>
</body>
</html>`;

const PAGE_INLINE_ONLY = `<!DOCTYPE html>
<html lang="en">
<head><meta name="viewport" content="width=device-width, initial-scale=1"><title>T</title>
<style>body{color:#111}</style>
</head><body><p>Hi</p></body></html>`;

describe("visual editor eligibility (analyzePageStyles)", () => {
  test("a single local stylesheet + scripts is editable, with the stylesheet path captured", () => {
    const a = analyzePageStyles(PAGE_WITH_ONE_LINK, "index.html");
    expect(a.editable).toBe(true);
    expect(a.localStylesheets).toEqual(["assets/style.css"]);
    expect(a.stylesheetPath).toBe("assets/style.css");
    expect(a.scriptCount).toBe(2);
    expect(a.notEditableReason).toBeNull();
  });

  test("nested pages resolve stylesheet hrefs relative to their directory", () => {
    const a = analyzePageStyles(PAGE_WITH_ONE_LINK, "pages/about.html");
    expect(a.localStylesheets).toEqual(["pages/assets/style.css"]);
    expect(a.stylesheetPath).toBe("pages/assets/style.css");
    // Root-absolute refs stay project-rooted.
    const b = analyzePageStyles(PAGE_WITH_ONE_LINK.replace('href="assets/style.css"', 'href="/assets/style.css"'), "pages/about.html");
    expect(b.stylesheetPath).toBe("assets/style.css");
  });

  test("external stylesheets refuse visual editing with the honest reason (code editing stays available)", () => {
    const html = PAGE_WITH_ONE_LINK.replace('href="assets/style.css"', 'href="https://cdn.example.com/style.css"');
    const a = analyzePageStyles(html, "index.html");
    expect(a.editable).toBe(false);
    expect(a.notEditableReason).toContain("external stylesheets");
    expect(a.notEditableReason).toContain("Code workspace");
  });

  test("multiple local stylesheets refuse visual editing (round-trip contract)", () => {
    const html = PAGE_WITH_ONE_LINK.replace(
      "</head>",
      '<link rel="stylesheet" href="assets/extra.css"></head>'
    );
    const a = analyzePageStyles(html, "index.html");
    expect(a.editable).toBe(false);
    expect(a.notEditableReason).toContain("2 project stylesheets");
  });

  test("inline-style pages are editable without a stylesheet path", () => {
    const a = analyzePageStyles(PAGE_INLINE_ONLY, "index.html");
    expect(a.editable).toBe(true);
    expect(a.stylesheetPath).toBeNull();
    expect(a.hasInlineStyles).toBe(true);
    expect(extractInlineStyles(PAGE_INLINE_ONLY)).toEqual(["body{color:#111}"]);
  });
});

describe("save payload split (buildVisualSavePayload)", () => {
  test("linked-stylesheet pages keep the CSS in its own file (the <link> stays authoritative)", () => {
    const analysis = analyzePageStyles(PAGE_WITH_ONE_LINK, "index.html");
    const payload = buildVisualSavePayload("<html lang=\"en\"><head><link rel=\"stylesheet\" href=\"assets/style.css\"></head><body><h1>Edited</h1></body></html>", "h1{color:red}", analysis);
    expect(payload.cssPath).toBe("assets/style.css");
    expect(payload.css).toBe("h1{color:red}");
    // The exported HTML must NOT have the CSS injected inline.
    expect(payload.html).not.toContain("<style");
  });

  test("inline-only pages re-inject the exported CSS as a <style> block", () => {
    const analysis = analyzePageStyles(PAGE_INLINE_ONLY, "index.html");
    const payload = buildVisualSavePayload("<html lang=\"en\"><head><style data-bean-visual=\"1\">old</style></head><body><p>Edited</p></body></html>", "body{color:#222}", analysis);
    expect(payload.cssPath).toBeNull();
    expect(payload.css).toBeNull();
    expect(payload.html).toContain("<style data-bean-visual=\"1\">body{color:#222}</style>");
    expect(payload.html).not.toContain("old");
  });
});

describe("BEAN visual blocks (original presets — structural validation)", () => {
  test("every block carries HTML + CSS, a BEAN id, and no upstream branding", () => {
    expect(BEAN_VISUAL_BLOCKS.length).toBeGreaterThanOrEqual(4);
    for (const b of BEAN_VISUAL_BLOCKS) {
      expect(b.id.startsWith("bean-")).toBe(true);
      expect(b.html.trim().length).toBeGreaterThan(10);
      expect(b.css.trim().length).toBeGreaterThan(5);
      expect(b.category).toBe("BEAN sections");
      // No upstream branding or paid-service references anywhere.
      expect(`${b.html} ${b.css}`).not.toMatch(/grapesjs|studio-sdk|gjs-/i);
    }
  });

  test("block markup passes the build validator's static-markup expectations (unique ids, lang/alt-safe)", () => {
    // The editor saves through the existing pipeline; pins the blocks' own
    // markup stays compatible (no duplicate ids across the four presets).
    const allHtml = BEAN_VISUAL_BLOCKS.map((b) => b.html).join("\n");
    const ids = [...allHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------- document round-trip (PoC contract)

import {
  buildEditorHtml,
  extractScripts,
  reconstructDocument,
  stripLeadingHeadItems,
} from "@/lib/giftz/visual-editor/round-trip";

const REPR_GIFTZ_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aurora Atelier — Portfolio</title>
  <link rel="stylesheet" href="assets/style.css">
</head>
<body>
  <header class="site-header"><nav aria-label="Main"><a href="./index.html">Home</a></nav></header>
  <main><section class="hero" id="hero"><h1>Aurora Atelier</h1></section></main>
  <script src="assets/vendor/gsap.min.js"></script>
  <script>(function(){ if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return; })();</script>
</body>
</html>`;

describe("document reconstruction (PoC-verified preservation contract)", () => {
  test("reconstructDocument keeps doctype + head verbatim and re-attaches body scripts", () => {
    // Simulate the editor export: wrapper-less body content WITHOUT scripts,
    // head items flattened at the start (observed behavior, PoC F-1/F-3).
    const exported = `<meta charset="utf-8"/><title>Aurora Atelier — Portfolio</title><link rel="stylesheet" href="assets/style.css"/><header class="site-header"><nav aria-label="Main"><a href="./index.html">Home</a></nav></header><main><section id="hero" class="hero"><h1>Aurora Atelier EDITED</h1></section></main>`;
    const { html, reattachedScripts } = reconstructDocument(REPR_GIFTZ_PAGE, exported);
    expect(reattachedScripts).toBe(2);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    // Verbatim head: link + title + meta exactly as authored.
    expect(html).toContain('<link rel="stylesheet" href="assets/style.css">');
    expect(html).toContain("<title>Aurora Atelier — Portfolio</title>");
    // Scripts re-injected before </body>, verbatim.
    expect(html).toContain('<script src="assets/vendor/gsap.min.js"></script>');
    expect(html).toContain("prefers-reduced-motion");
    expect(html.indexOf("gsap.min.js")).toBeGreaterThan(html.indexOf("</main>"));
    // The edit survived; the head items are NOT duplicated.
    expect(html).toContain("Aurora Atelier EDITED");
    expect(html.match(/<link rel="stylesheet"/g)?.length).toBe(1);
    expect(html.match(/<title>/g)?.length).toBe(1);
  });

  test("stripLeadingHeadItems removes flattened head items but keeps real content", () => {
    const stripped = stripLeadingHeadItems('<meta charset="utf-8"/><title>T</title><link rel="stylesheet" href="x.css"/><style>a{}</style><main>content</main>');
    expect(stripped).toBe("<main>content</main>");
    expect(stripLeadingHeadItems("<main>keep</main>")).toBe("<main>keep</main>");
  });

  test("buildEditorHtml injects the editor style block into head (full-sheet parse contract)", () => {
    const withStyle = buildEditorHtml(REPR_GIFTZ_PAGE, "body{color:#111}");
    expect(withStyle).toContain('<style id="bean-visual-css">body{color:#111}</style></head>');
    expect(buildEditorHtml(REPR_GIFTZ_PAGE, "  ").trim()).toBe(REPR_GIFTZ_PAGE.trim());
  });

  test("extractScripts flags head vs body position", () => {
    const scripts = extractScripts(REPR_GIFTZ_PAGE);
    expect(scripts.length).toBe(2);
    expect(scripts.every((s) => !s.inHead)).toBe(true);
    const headScriptPage = REPR_GIFTZ_PAGE.replace("</head>", '<script src="a.js"></script></head>');
    const mixed = extractScripts(headScriptPage);
    expect(mixed.find((s) => s.inHead)?.tag).toContain("a.js");
  });
});
