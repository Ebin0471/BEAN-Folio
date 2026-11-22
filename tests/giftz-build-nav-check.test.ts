/**
 * GZ-BENCH-1 regression: deterministic multi-page navigation build check.
 *
 * Baseline evidence (run 2026-11-22-baseline, benchmark D): the model created
 * features.html / pricing.html / faq.html but the landing page linked to NONE
 * of them — the GZ-1 plan rule ("every page shares the same masthead nav with
 * working relative links") existed only as a prompt rule with no enforcement
 * point, so the build succeeded on a 4-page site no visitor could navigate.
 *
 * The check is now deterministic in the build gate: the ENTRY page of a
 * multi-page tree without sibling links is an ERROR (blocks the build and
 * feeds the existing AI repair round); secondary pages without sibling links
 * are WARNINGS (surfaced, never blocking).
 */

import { describe, expect, test } from "bun:test";

import { multiPageNavDiagnostics, resolveLocalRef } from "../src/lib/giftz/project-build";

function page(path: string, links: string[]): { path: string; content: string } {
  return { path, content: links.map((l) => `<a href="${l}">x</a>`).join("\n") };
}

describe("multiPageNavDiagnostics — the benchmark D failure is now a build error", () => {
  test("an orphan entry page in a multi-page tree is an ERROR with an actionable message", () => {
    const files = [
      page("index.html", []), // the live failure: landing with zero page links
      page("features.html", []),
      page("pricing.html", []),
      page("faq.html", []),
    ];
    const diagnostics = multiPageNavDiagnostics(files);
    const entry = diagnostics.find((d) => d.path === "index.html");
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe("error");
    expect(entry!.message).toContain("3 pages");
    expect(entry!.message).toContain("masthead nav");
  });

  test("a well-navigated entry page produces no diagnostics (A/B/C case)", () => {
    const files = [
      page("index.html", ["./about.html", "./services.html", "./contact.html"]),
      page("about.html", ["./index.html"]),
      page("services.html", ["./index.html"]),
      page("contact.html", ["./index.html"]),
    ];
    expect(multiPageNavDiagnostics(files)).toEqual([]);
  });

  test("secondary pages without sibling links are WARNINGS, never blocking", () => {
    const files = [
      page("index.html", ["./shop.html"]),
      page("shop.html", []), // deliberately standalone secondary page
    ];
    const diagnostics = multiPageNavDiagnostics(files);
    const shop = diagnostics.find((d) => d.path === "shop.html");
    expect(shop).toBeDefined();
    expect(shop!.severity).toBe("warning");
    const entry = diagnostics.find((d) => d.path === "index.html");
    expect(entry).toBeUndefined();
  });

  test("a single-page tree is never flagged (benchmark E case)", () => {
    expect(multiPageNavDiagnostics([page("index.html", [])])).toEqual([]);
  });

  test("a self-link only (index → index) still counts as unnavigable", () => {
    const files = [page("index.html", ["./index.html"]), page("about.html", [])];
    const diagnostics = multiPageNavDiagnostics(files);
    expect(diagnostics.find((d) => d.path === "index.html")?.severity).toBe("error");
  });

  test("root-absolute and ./ refs resolve to sibling detection at root level", () => {
    // The resolver's established semantics (shared with the broken-ref check):
    // a leading / is stripped and the ref resolves from the file's directory —
    // for root-level pages that is exactly the project root.
    const files = [
      { path: "index.html", content: '<a href="/about.html">a</a><a href="./about.html">b</a>' },
      { path: "about.html", content: '<a href="/index.html">home</a>' },
    ];
    expect(multiPageNavDiagnostics(files)).toEqual([]);
  });

  test("external and anchor-only hrefs do not satisfy navigation", () => {
    const files = [
      { path: "index.html", content: '<a href="https://example.com">x</a><a href="#section">y</a>' },
      page("about.html", []),
    ];
    const diagnostics = multiPageNavDiagnostics(files);
    expect(diagnostics.find((d) => d.path === "index.html")?.severity).toBe("error");
  });
});

describe("resolveLocalRef — used by the nav check (reference behavior pins)", () => {
  test("./ and ../ and bare refs resolve from the referencing file's directory", () => {
    expect(resolveLocalRef("./about.html", "index.html")).toBe("about.html");
    expect(resolveLocalRef("about.html", "docs/index.html")).toBe("docs/about.html");
    expect(resolveLocalRef("../index.html", "docs/guide.html")).toBe("index.html");
    // Leading-slash refs resolve dir-relative (the scanner's shared semantics),
    // which equals project-root-relative for root-level pages.
    expect(resolveLocalRef("/about.html", "index.html")).toBe("about.html");
  });

  test("external/anchor refs return null", () => {
    expect(resolveLocalRef("https://example.com/x.html", "index.html")).toBeNull();
    expect(resolveLocalRef("#top", "index.html")).toBeNull();
    expect(resolveLocalRef("mailto:a@b.c", "index.html")).toBeNull();
  });
});
