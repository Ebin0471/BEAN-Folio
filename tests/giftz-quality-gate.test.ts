/// <reference types="bun-types" />
/**
 * GIFTZ consolidated quality gate — static report truth tests (M33.3).
 *
 * Contract under test (docs/GIFTZ_UNIVERSAL_CREATIVE_STUDIO_GUIDE.md M33.3 +
 * docs/UNIVERSAL_STUDIO_CAPABILITY_MATRIX.md §1.3):
 *   a) accessibility: missing img alt / missing lang / heading jumps /
 *      unlabeled form fields are found with capped evidence; decorated
 *      images (alt="") and properly labelled fields PASS;
 *   b) SEO: title / meta description / Open Graph presence is checked per
 *      page with honest pass/warn/fail detail;
 *   c) links: javascript: URLs FAIL, placeholder destinations WARN, internal
 *      links must resolve to a page shipped in the artifact (404 prevention);
 *   d) local assets: every src/href/url() reference must exist in the
 *      artifact file list — missing files FAIL with evidence;
 *   e) responsive: viewport meta required; media queries and fixed-width
 *      heuristics report honestly;
 *   f) performance: img dimensions, lazy loading on image-heavy pages,
 *      inline block budgets, stylesheet count;
 *   g) honesty: the report ALWAYS carries the explicit `untested` list;
 *      contrast with no palette context reports `not-run` (never guessed);
 *      same input → same report (deterministic); bounded input is enforced.
 *
 * Pure module test — no DB required.
 * Run: bun test tests/giftz-quality-gate.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  runQualityGate,
  untestedAreas,
  type QualityGateInput,
} from "@/lib/giftz/quality-gate";

const BASE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Studio Portfolio</title>
<meta name="description" content="Selected work of an independent studio.">
<meta property="og:title" content="Studio Portfolio">
<meta property="og:description" content="Selected work.">
</head>
<body>
<h1>Studio</h1>
<p>Hello.</p>
</body>
</html>`;

function gate(input: Partial<QualityGateInput>): ReturnType<typeof runQualityGate> {
  return runQualityGate({
    pages: [{ path: "index.html", html: BASE_HTML }],
    stylesheets: [],
    localFiles: ["index.html"],
    ...input,
  });
}

function find(report: ReturnType<typeof runQualityGate>, id: string) {
  const check = report.checks.find((c) => c.id === id);
  expect(check).toBeDefined();
  return check!;
}

describe("quality gate — accessibility", () => {
  test("missing alt attributes FAIL with evidence; alt=\"\" decorative images pass", () => {
    const bad = gate({
      pages: [
        {
          path: "index.html",
          html: BASE_HTML.replace("<h1>Studio</h1>", '<h1>Studio</h1><img src="hero.jpg"><img src="deco.png" alt="">'),
        },
      ],
      localFiles: ["index.html", "hero.jpg", "deco.png"],
    });
    const check = find(bad, "a11y-img-alt");
    expect(check.status).toBe("fail");
    expect(check.evidence.length).toBeGreaterThan(0);
    expect(check.evidence[0].page).toBe("index.html");
    expect(check.detail).toContain("1 of 2");

    const ok = gate({
      pages: [
        {
          path: "index.html",
          html: BASE_HTML.replace("<h1>Studio</h1>", '<img src="deco.png" alt="">'),
        },
      ],
      localFiles: ["index.html", "deco.png"],
    });
    expect(find(ok, "a11y-img-alt").status).toBe("pass");
  });

  test("pages without <html lang> are warned", () => {
    const report = gate({
      pages: [{ path: "index.html", html: BASE_HTML.replace('<html lang="en">', "<html>") }],
    });
    const check = find(report, "a11y-html-lang");
    expect(check.status).toBe("warn");
    expect(check.evidence[0].sample).toContain("no lang");
  });

  test("heading-level jumps warn; multiple h1 fails", () => {
    const jumped = gate({
      pages: [
        {
          path: "index.html",
          html: BASE_HTML.replace("<p>Hello.</p>", "<h2>Work</h2><h4>Detail</h4>"),
        },
      ],
    });
    expect(find(jumped, "a11y-heading-order").status).toBe("warn");

    const multiH1 = gate({
      pages: [
        {
          path: "index.html",
          html: BASE_HTML.replace("<p>Hello.</p>", "<h1>Second</h1>"),
        },
      ],
    });
    const check = find(multiH1, "a11y-heading-order");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("multiple <h1>");
  });

  test("unlabeled form fields FAIL; label-wrapped and aria-labelled fields pass", () => {
    const bad = gate({
      pages: [
        {
          path: "index.html",
          html: BASE_HTML.replace("<p>Hello.</p>", '<input type="email" id="mail">'),
        },
      ],
    });
    const check = find(bad, "a11y-form-labels");
    expect(check.status).toBe("fail");
    expect(check.evidence[0].sample).toContain("type=\"email\"");

    const ok = gate({
      pages: [
        {
          path: "index.html",
          html: BASE_HTML.replace(
            "<p>Hello.</p>",
            '<label for="mail">Email</label><input type="email" id="mail"><input type="search" aria-label="Search">',
          ),
        },
      ],
    });
    expect(find(ok, "a11y-form-labels").status).toBe("pass");
  });

  test("contrast without palette context is honestly not-run — never guessed", () => {
    const report = gate({});
    const check = find(report, "a11y-contrast");
    expect(check.status).toBe("not-run");
    expect(check.detail).toMatch(/NOT evaluated|cannot/i);
    expect(report.untested.join(" ")).toMatch(/contrast/i);
  });

  test("contrast with a failing palette context fails with the real ratio", () => {
    const report = gate({ palette: { foreground: "#777777", background: "#8a8a8a" } });
    const check = find(report, "a11y-contrast");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/below the 4\.5:1/);
  });
});

describe("quality gate — SEO", () => {
  test("missing title fails; missing description and OG tags warn per page", () => {
    const bare = gate({
      pages: [{ path: "index.html", html: "<html><head><meta charset=\"utf-8\"></head><body></body></html>" }],
    });
    expect(find(bare, "seo-title").status).toBe("fail");
    expect(find(bare, "seo-meta-description").status).toBe("warn");
    expect(find(bare, "seo-open-graph").status).toBe("warn");

    const good = gate({});
    expect(find(good, "seo-title").status).toBe("pass");
    expect(find(good, "seo-meta-description").status).toBe("pass");
    expect(find(good, "seo-open-graph").status).toBe("pass");
  });
});

describe("quality gate — links", () => {
  test("javascript: URLs fail; placeholder hrefs warn", () => {
    const report = gate({
      pages: [
        {
          path: "index.html",
          html: BASE_HTML.replace("<p>Hello.</p>", '<a href="javascript:void(0)">Run</a> <a href="#">Placeholder</a>'),
        },
      ],
    });
    expect(find(report, "links-safety").status).toBe("fail");
    expect(find(report, "links-safety").detail).toContain("javascript:");
  });

  test("internal links must resolve to shipped pages — broken targets fail", () => {
    const ok = gate({
      pages: [
        { path: "index.html", html: BASE_HTML.replace("<p>Hello.</p>", '<a href="about.html">About</a>') },
        { path: "about.html", html: BASE_HTML },
      ],
      localFiles: ["index.html", "about.html"],
    });
    expect(find(ok, "links-internal").status).toBe("pass");

    const broken = gate({
      pages: [
        { path: "index.html", html: BASE_HTML.replace("<p>Hello.</p>", '<a href="missing.html">Gone</a>') },
      ],
      localFiles: ["index.html"],
    });
    const check = find(broken, "links-internal");
    expect(check.status).toBe("fail");
    expect(check.evidence[0].sample).toContain("missing.html");
  });

  test("anchors without accessible text warn", () => {
    const report = gate({
      pages: [
        { path: "index.html", html: BASE_HTML.replace("<p>Hello.</p>", '<a href="about.html"></a>') },
        { path: "about.html", html: BASE_HTML },
      ],
      localFiles: ["index.html", "about.html"],
    });
    expect(find(report, "links-text").status).toBe("warn");
  });
});

describe("quality gate — local assets", () => {
  test("references to files not shipped in the artifact fail", () => {
    const report = gate({
      pages: [
        {
          path: "index.html",
          html: BASE_HTML.replace("<p>Hello.</p>", '<img src="assets/hero.jpg"><script src="app.js"></script>'),
        },
      ],
      localFiles: ["index.html", "assets/hero.jpg"],
    });
    const check = find(report, "links-local-assets");
    expect(check.status).toBe("fail");
    expect(check.evidence.some((e) => e.sample.includes("app.js"))).toBe(true);
  });

  test("shipped assets and external URLs resolve cleanly", () => {
    const report = gate({
      pages: [
        {
          path: "index.html",
          html: BASE_HTML.replace(
            "<p>Hello.</p>",
            '<img src="assets/hero.jpg"><script src="https://cdn.example.com/x.js"></script>',
          ),
        },
      ],
      localFiles: ["index.html", "assets/hero.jpg"],
    });
    expect(find(report, "links-local-assets").status).toBe("pass");
  });
});

describe("quality gate — responsive", () => {
  test("missing viewport meta fails", () => {
    const report = gate({
      pages: [{ path: "index.html", html: BASE_HTML.replace(/<meta name="viewport"[^>]*>/, "") }],
    });
    expect(find(report, "resp-viewport-meta").status).toBe("fail");
  });

  test("no media queries warn; media queries pass; no stylesheets is not-run", () => {
    const none = gate({ stylesheets: [{ path: "styles.css", css: "body{color:#222}" }] });
    expect(find(none, "resp-media-queries").status).toBe("warn");

    const adaptive = gate({
      stylesheets: [{ path: "styles.css", css: "@media (max-width: 768px) { body{font-size:15px} }" }],
    });
    expect(find(adaptive, "resp-media-queries").status).toBe("pass");

    const noCss = gate({ stylesheets: [] });
    expect(find(noCss, "resp-media-queries").status).toBe("not-run");
  });

  test("desktop-locked fixed widths warn with evidence", () => {
    const report = gate({
      stylesheets: [{ path: "styles.css", css: ".shell{width:1200px}" }],
    });
    const check = find(report, "resp-fixed-width");
    expect(check.status).toBe("warn");
    expect(check.evidence[0].sample).toContain("1200px");
  });
});

describe("quality gate — performance", () => {
  test("images without width/height warn; declared dimensions pass", () => {
    const warn = gate({
      pages: [
        { path: "index.html", html: BASE_HTML.replace("<p>Hello.</p>", '<img src="a.jpg" alt="A">') },
      ],
      localFiles: ["index.html", "a.jpg"],
    });
    expect(find(warn, "perf-img-dimensions").status).toBe("warn");

    const ok = gate({
      pages: [
        { path: "index.html", html: BASE_HTML.replace("<p>Hello.</p>", '<img src="a.jpg" alt="A" width="800" height="600">') },
      ],
      localFiles: ["index.html", "a.jpg"],
    });
    expect(find(ok, "perf-img-dimensions").status).toBe("pass");
  });

  test("image-heavy pages without lazy loading warn", () => {
    const imgs = Array.from({ length: 12 }, (_, i) => `<img src="p${i}.jpg" alt="P${i}" width="80" height="80">`).join("");
    const report = gate({
      pages: [{ path: "index.html", html: BASE_HTML.replace("<p>Hello.</p>", imgs) }],
      localFiles: ["index.html", ...Array.from({ length: 12 }, (_, i) => `p${i}.jpg`)],
    });
    const check = find(report, "perf-img-lazy");
    expect(check.status).toBe("warn");
    expect(check.evidence[0].sample).toContain("12 images");
  });

  test("oversized inline blocks warn", () => {
    const big = "x".repeat(101 * 1024);
    const report = gate({
      pages: [{ path: "index.html", html: BASE_HTML.replace("<p>Hello.</p>", `<style>${big}</style>`) }],
    });
    expect(find(report, "perf-inline-budget").status).toBe("warn");
  });
});

describe("quality gate — report honesty and bounds", () => {
  test("every report carries the explicit untested list", () => {
    const report = gate({});
    expect(report.untested.length).toBeGreaterThanOrEqual(5);
    expect(untestedAreas().join(" ")).toContain("real browser");
    expect(untestedAreas().join(" ")).toContain("reduced-motion");
  });

  test("blocking findings drive the overall verdict", () => {
    const clean = gate({});
    expect(clean.overall).toBe("strong");
    expect(clean.summary).toMatch(/passed/i);

    const failing = gate({
      pages: [
        {
          path: "index.html",
          html: BASE_HTML.replace("<p>Hello.</p>", '<a href="nowhere.html">X</a>'),
        },
      ],
      localFiles: ["index.html"],
    });
    expect(failing.overall).toBe("needs-work");
    expect(failing.summary).toMatch(/blocking/);
  });

  test("same artifacts → identical report (deterministic)", () => {
    const pages = [
      { path: "index.html", html: BASE_HTML.replace("<p>Hello.</p>", '<img src="a.jpg" alt="A">') },
      { path: "about.html", html: BASE_HTML },
    ];
    const a = runQualityGate({ pages, stylesheets: [], localFiles: ["index.html", "about.html", "a.jpg"] });
    const b = runQualityGate({ pages, stylesheets: [], localFiles: ["index.html", "about.html", "a.jpg"] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("input is bounded: oversized HTML is skipped, page count is capped", () => {
    const huge = { path: "huge.html", html: `<!DOCTYPE html><html><head><title>T</title></head><body>${"y".repeat(600 * 1024)}</body></html>` };
    const report = gate({ pages: [huge, { path: "index.html", html: BASE_HTML }] });
    expect(report.pagesChecked).toBe(1);
    expect(report.checks.length).toBeGreaterThan(0);
  });
});
