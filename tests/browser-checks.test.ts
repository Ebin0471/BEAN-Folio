/// <reference types="bun-types" />
/**
 * Code Giftz — REAL browser preview checks (pure evaluators).
 *
 * The builders' iframe gathering is DOM-bound; the evaluation logic is pure
 * and proven here: overflow thresholds and severity, broken-asset detection,
 * runtime-error reporting and render-sanity comparison — the same shape the
 * panel renders next to the server verification report.
 *
 * Run: bun test tests/browser-checks.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  evaluateOverflow,
  evaluateAssets,
  evaluateRuntime,
  evaluateStructure,
  type OverflowMeasurement,
} from "../src/lib/ai-design/browser-checks";

function overflow(partial: Partial<OverflowMeasurement>): OverflowMeasurement {
  return { viewportW: 390, docScrollW: 390, clientW: 390, offending: [], ...partial };
}

describe("evaluateOverflow", () => {
  test("passes when content fits the viewport", () => {
    const c = evaluateOverflow(overflow({}));
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("390px");
  });

  test("sub-pixel rounding is tolerated", () => {
    const c = evaluateOverflow(overflow({ docScrollW: 390.5 }));
    expect(c.status).toBe("pass");
  });

  test("a single offending element is reported with evidence", () => {
    const c = evaluateOverflow(
      overflow({ offending: [{ tag: "div", id: "hero-art", className: "absolute w-[500px]", text: "", overflowPx: 110 }] })
    );
    expect(c.status).toBe("fail"); // 110px is a large, visible overflow
    expect(c.detail).toContain("hero-art");
  });

  test("large overflow (>24px) fails", () => {
    const c = evaluateOverflow(
      overflow({ offending: [{ tag: "img", id: "", className: "", text: "", overflowPx: 220 }] })
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("<img>");
  });

  test("small overflow warns with the sample element", () => {
    const c = evaluateOverflow(
      overflow({ offending: [{ tag: "p", id: "", className: "long-word", text: "Supercalifragilistic", overflowPx: 12 }] })
    );
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("long-word");
    expect(c.detail).toContain("12px");
  });

  test("takes the maximum of document and element overflow", () => {
    const c = evaluateOverflow(overflow({ docScrollW: 460, clientW: 390, offending: [] }));
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("70px");
  });
});

describe("evaluateAssets", () => {
  test("passes with no images", () => {
    expect(evaluateAssets([]).status).toBe("pass");
  });

  test("all decoded images pass", () => {
    const c = evaluateAssets([
      { src: "/api/media/abc/raw", complete: true, naturalWidth: 800 },
      { src: "/x.png", complete: true, naturalWidth: 32 },
    ]);
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("2");
  });

  test("a still-loading image gets the benefit of the doubt", () => {
    const c = evaluateAssets([{ src: "/slow.png", complete: false, naturalWidth: 0 }]);
    expect(c.status).toBe("pass");
  });

  test("a broken image fails with its file name", () => {
    const c = evaluateAssets([
      { src: "https://cdn.example.com/media/cover-v2.jpg", complete: true, naturalWidth: 0 },
      { src: "/ok.png", complete: true, naturalWidth: 10 },
    ]);
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("cover-v2.jpg");
    expect(c.detail).toContain("1 of 2");
  });
});

describe("evaluateRuntime", () => {
  test("no errors passes", () => {
    expect(evaluateRuntime([]).status).toBe("pass");
  });

  test("errors fail and are quoted", () => {
    const c = evaluateRuntime(["Cannot read properties of undefined (reading 'map')"]);
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("Cannot read properties");
  });
});

describe("evaluateStructure", () => {
  test("rendered >= expected passes", () => {
    expect(evaluateStructure(7, 7).status).toBe("pass");
    expect(evaluateStructure(8, 7).status).toBe("pass");
  });

  test("partial render warns with counts", () => {
    const c = evaluateStructure(5, 7);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("5 of 7");
  });

  test("nothing rendered fails", () => {
    expect(evaluateStructure(0, 4).status).toBe("fail");
  });
});
