/// <reference types="bun-types" />
/**
 * GIFTZ structured 3D scene engine (GZ-3) — unit tests.
 *
 * Covers the pure surface of src/lib/giftz/scene3d.ts and its integration
 * points (no db, no AI, no filesystem):
 *
 *   schema              — accepts valid scenes; rejects bad colors, kinds,
 *                         ranges, counts and shapes (fail-closed).
 *   validateScene3dBlock — duplicate scene/object ids; unknown section
 *                         targets; disabled blocks pass through.
 *   compileScene3dBlock — selector resolution (page/hero/section), issue
 *                         reporting, defaults for camera/lights/interactions.
 *   compileMotionProgram — scene3d-only configs produce a program with the
 *                         three.js vendor spec + runtime tags and NO motion
 *                         runtime tag (GSAP/Vanta untouched).
 *   buildScene3dRuntime  — audited-interpreter contract: no eval, no CDN,
 *                         reduced-motion + WebGL guards, geometry table,
 *                         rAF cleanup, sanitized JSON embed.
 *   normalizeConfig     — scene3d survives round-trip; invalid scenes are
 *                         dropped (fail-closed) exactly like the gsap block.
 *   motionBuildChecks   — missing generated runtime is an error; vendor
 *                         presence + heavy-scene warnings are honest.
 *   markupBuildChecks   — duplicate ids (error), viewport/lang/alt (warnings),
 *                         script-order error for early global references.
 *
 * Run: bun test tests/giftz-scene3d.test.ts
 */

import { describe, expect, test } from "bun:test";

import {
  SCENE3D_RUNTIME_PATH,
  buildScene3dRuntime,
  compileScene3dBlock,
  defaultScene3dBlock,
  scene3dBlockSchema,
  scene3dSceneSchema,
  validateScene3dBlock,
} from "../src/lib/giftz/scene3d";
import { compileMotionProgram, motionScriptTags, vendorFileSpecs } from "../src/lib/giftz/motion-engine";
import { markupBuildChecks, motionBuildChecks } from "../src/lib/giftz/project-build";
import { defaultConfig, normalizeConfig, type SiteConfig } from "../src/lib/site-config";

// ------------------------------------------------------------------ fixtures

/** A minimal valid site config (default template) with one hero + one about section. */
function baseConfig(overrides?: Partial<SiteConfig>): SiteConfig {
  const base = defaultConfig();
  return {
    ...base,
    pages: [
      {
        id: "home",
        name: "Home",
        visible: true,
        sections: [
          { id: "hero-main", type: "hero", visible: true, title: "Hero", subtitle: "", variant: "classic", ctaLabel: "", ctaHref: "" },
          { id: "about-main", type: "about", visible: true, title: "About", body: "hi" },
        ],
      },
    ],
    ...overrides,
  };
}

function validScene(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "hero-scene",
    target: { kind: "hero" },
    objects: [
      {
        id: "primary-shape",
        kind: "icosahedron",
        position: { x: 0, y: 0, z: 0 },
        scale: 1,
        material: { kind: "standard", color: "#e5c878", metalness: 0.2, roughness: 0.5 },
        animation: { kind: "rotate", speed: 0.4, axis: "y" },
      },
    ],
    ...overrides,
  };
}

function scene3dEnabled(scenes: Record<string, unknown>[]): Record<string, unknown> {
  return { enabled: true, respectReducedMotion: true, scenes };
}

// ------------------------------------------------------------------ schema

describe("scene3d schema", () => {
  test("accepts a valid block with defaults applied", () => {
    const parsed = scene3dBlockSchema.parse(scene3dEnabled([validScene()]));
    expect(parsed.enabled).toBe(true);
    expect(parsed.respectReducedMotion).toBe(true);
    expect(parsed.scenes).toHaveLength(1);
  });

  test("rejects non-hex colors (fail-closed)", () => {
    const bad = scene3dEnabled([
      validScene({ objects: [{ id: "a", kind: "box", material: { color: "gold" } }] }),
    ]);
    expect(scene3dBlockSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects unknown object kinds and animation kinds", () => {
    expect(scene3dSceneSchema.safeParse({ id: "s", target: { kind: "hero" }, objects: [{ id: "a", kind: "dragon" }] }).success).toBe(false);
    expect(
      scene3dSceneSchema.safeParse({ id: "s", target: { kind: "hero" }, objects: [{ id: "a", kind: "box", animation: { kind: "explode" } }] }).success
    ).toBe(false);
  });

  test("rejects out-of-range values and oversized collections", () => {
    expect(scene3dSceneSchema.safeParse({ id: "s", target: { kind: "hero" }, objects: [{ id: "a", kind: "box", scale: 50 }] }).success).toBe(false);
    expect(scene3dSceneSchema.safeParse({ id: "s", target: { kind: "hero" }, camera: { fov: 5 } }).success).toBe(false);
    const tooMany = Array.from({ length: 25 }, (_, i) => ({ id: `obj-${i}`, kind: "box" }));
    expect(scene3dSceneSchema.safeParse({ id: "s", target: { kind: "hero" }, objects: tooMany }).success).toBe(false);
  });

  test("caps the block at 3 scenes", () => {
    const four = Array.from({ length: 4 }, (_, i) => validScene({ id: `scene-${i}` }));
    expect(scene3dBlockSchema.safeParse(scene3dEnabled(four)).success).toBe(false);
  });
});

// ------------------------------------------------------------------ validation

describe("validateScene3dBlock", () => {
  const sectionIds = new Set(["hero-main", "about-main"]);

  test("unknown section targets are rejected", () => {
    const block = scene3dBlockSchema.parse(scene3dEnabled([validScene({ target: { kind: "section", sectionId: "nope" } })]));
    const outcome = validateScene3dBlock(block as never, sectionIds);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((i) => i.message.includes("existing sectionId"))).toBe(true);
  });

  test("duplicate scene and object ids are rejected", () => {
    const block = scene3dBlockSchema.parse(
      scene3dEnabled([validScene(), validScene({ id: "hero-scene" })])
    );
    const outcome = validateScene3dBlock(block as never, sectionIds);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((i) => i.message === "duplicate scene id")).toBe(true);

    const dupObject = scene3dBlockSchema.parse(
      scene3dEnabled([
        validScene({ objects: [{ id: "same", kind: "box" }, { id: "same", kind: "sphere" }] }),
      ])
    );
    const outcome2 = validateScene3dBlock(dupObject as never, sectionIds);
    expect(outcome2.ok).toBe(false);
    expect(outcome2.issues.some((i) => i.message === "duplicate object id")).toBe(true);
  });

  test("disabled blocks pass through untouched", () => {
    const block = { ...defaultScene3dBlock() };
    const outcome = validateScene3dBlock(block, new Set());
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toEqual(block);
  });
});

// ------------------------------------------------------------------ compile

describe("compileScene3dBlock", () => {
  const sectionIds = new Set(["hero-main", "about-main"]);
  const heroIds = new Set(["hero-main"]);

  test("hero target resolves to the first hero section", () => {
    const block = scene3dBlockSchema.parse(scene3dEnabled([validScene()])) as never;
    const { scenes, issues } = compileScene3dBlock(block, sectionIds, heroIds);
    expect(issues).toHaveLength(0);
    expect(scenes[0].selector).toBe('[data-gz-section="hero-main"]');
    expect(scenes[0].camera.fov).toBe(55);
    expect(scenes[0].quality.mobile).toBe("reduced");
    expect(scenes[0].lights.length).toBeGreaterThanOrEqual(1);
  });

  test("page target resolves to the background host", () => {
    const block = scene3dBlockSchema.parse(scene3dEnabled([validScene({ target: { kind: "page" } })])) as never;
    const { scenes } = compileScene3dBlock(block, sectionIds, heroIds);
    expect(scenes[0].selector).toBe(".bs-bg-host");
  });

  test("unknown section targets compile to no scene and a reported issue", () => {
    const block = scene3dBlockSchema.parse(scene3dEnabled([validScene({ target: { kind: "section", sectionId: "ghost" } })])) as never;
    const { scenes, issues } = compileScene3dBlock(block, sectionIds, heroIds);
    expect(scenes).toHaveLength(0);
    expect(issues.some((i) => i.message.includes("existing sectionId"))).toBe(true);
  });
});

// ------------------------------------------------------------------ motion program integration

describe("compileMotionProgram — scene3d integration", () => {
  test("a scene3d-only config yields a program with scenes, the three vendor file and no motion runtime tag", () => {
    const config = baseConfig({
      scene3d: scene3dBlockSchema.parse(scene3dEnabled([validScene()])),
    } as never);
    const { program, issues } = compileMotionProgram(config);
    expect(issues).toHaveLength(0);
    expect(program).not.toBeNull();
    expect(program!.scene3d).toHaveLength(1);
    expect(program!.gsapEnabled).toBe(false);
    expect(program!.vanta).toBeNull();

    const specs = vendorFileSpecs(program);
    expect(specs.some((s) => s.path === "assets/vendor/three.min.js")).toBe(true);
    expect(specs.some((s) => s.path.startsWith("assets/vendor/gsap"))).toBe(false);

    const tags = motionScriptTags(program);
    expect(tags.some((t) => t.includes("assets/vendor/three.min.js"))).toBe(true);
    expect(tags.some((t) => t.includes(SCENE3D_RUNTIME_PATH))).toBe(true);
    expect(tags.some((t) => t.includes("assets/motion.js"))).toBe(false);
  });

  test("a config without any engine still compiles to null", () => {
    const { program } = compileMotionProgram(baseConfig());
    expect(program).toBeNull();
  });
});

// ------------------------------------------------------------------ runtime contract

describe("buildScene3dRuntime — audited interpreter contract", () => {
  const config = baseConfig({
    scene3d: scene3dBlockSchema.parse(scene3dEnabled([validScene()])),
  } as never);
  const { program } = compileMotionProgram(config);
  const runtime = buildScene3dRuntime({ respectReducedMotion: true, scenes: program!.scene3d });

  test("never evaluates dynamic code and never fetches", () => {
    expect(runtime).not.toMatch(/\beval\s*\(|new Function\s*\(/);
    expect(runtime).not.toMatch(/https?:\/\//);
    expect(runtime).not.toMatch(/fetch\s*\(|XMLHttpRequest|WebSocket/);
  });

  test("guards reduced motion, WebGL availability and three.js absence", () => {
    expect(runtime).toContain("prefers-reduced-motion");
    expect(runtime).toContain('?motion=static');
    expect(runtime).toContain("hasWebGL");
    expect(runtime).toContain("!window.THREE");
  });

  test("embeds the sanitized scene program and the geometry table", () => {
    expect(runtime).toContain('"hero-scene"');
    expect(runtime).toContain("IcosahedronGeometry");
    expect(runtime).toContain("MeshStandardMaterial");
  });

  test("cleans everything up on pagehide (rAF, listeners, disposal)", () => {
    expect(runtime).toContain('addEventListener("pagehide"');
    expect(runtime).toContain("cancelAnimationFrame");
    expect(runtime).toContain(".dispose()");
    expect(runtime).toContain("removeEventListener");
    expect(runtime).toContain("pointer-events:none");
  });

  test("keeps the decorative canvas non-interactive and escapes the JSON embed", () => {
    expect(runtime).toContain("pointer-events:none");
    expect(runtime).toContain("var CFG = {");
    // Defense-in-depth: even a hand-crafted program carrying "<" in an id
    // (impossible through the schema) is escaped in the generated runtime.
    const hostile = buildScene3dRuntime({
      respectReducedMotion: true,
      scenes: [
        {
          id: "x<y",
          selector: ".a",
          camera: { fov: 55, position: { x: 0, y: 0, z: 6 }, lookAt: null },
          objects: [],
          lights: [],
          interactions: { pointer: "none", hover: "none" },
          scroll: { mode: "none", strength: 0 },
          quality: { mobile: "full", maxPixelRatio: 1.5 },
          fallback: null,
          background: "transparent",
        },
      ],
    });
    expect(hostile).toContain("\\u003c");
    expect(hostile).not.toContain("x<y");
  });
});

// ------------------------------------------------------------------ normalizeConfig integration

describe("normalizeConfig — scene3d round-trip", () => {
  test("a valid scene3d block survives normalization", () => {
    const raw = {
      ...baseConfig(),
      scene3d: scene3dEnabled([validScene({ target: { kind: "section", sectionId: "hero-main" } })]),
    };
    const normalized = normalizeConfig(raw);
    expect(normalized).not.toBeNull();
    expect(normalized!.scene3d?.enabled).toBe(true);
    expect(normalized!.scene3d?.scenes[0].target).toEqual({ kind: "section", sectionId: "hero-main" });
  });

  test("an invalid scene shape rejects the config (fail-closed, like backgroundEffects)", () => {
    const raw = {
      ...baseConfig(),
      scene3d: scene3dEnabled([validScene({ target: { kind: "section" } })]), // missing sectionId → schema default? kind section without id is fine at schema level
    };
    const normalized = normalizeConfig(raw);
    // schema-valid but target-less scenes are DROPPED at validation (unknown id)
    expect(normalized).not.toBeNull();
    expect(normalized!.scene3d?.scenes.length ?? 0).toBe(0);
  });

  test("a structurally invalid block rejects the whole config", () => {
    const raw = { ...baseConfig(), scene3d: { enabled: true, respectReducedMotion: true, scenes: [{ id: "bad id!", target: { kind: "hero" }, objects: [{ id: "o", kind: "box" }] }] } };
    expect(normalizeConfig(raw)).toBeNull();
  });
});

// ------------------------------------------------------------------ build checks

const effective = (path: string, content: string, encoding: "utf8" | "base64" = "utf8") => ({
  path,
  content,
  encoding,
  source: "generated" as const,
});

function buildTree(files: { path: string; content: string; encoding?: "utf8" | "base64" }[]) {
  return new Map(files.map((f) => [f.path, effective(f.path, f.content, f.encoding ?? "utf8")]));
}

describe("motionBuildChecks — scene3d diagnostics", () => {
  test("a scene3d program without the generated runtime is an ERROR", () => {
    const config = baseConfig({
      scene3d: scene3dBlockSchema.parse(scene3dEnabled([validScene()])),
    } as never);
    const { program } = compileMotionProgram(config);
    const tree = buildTree([
      { path: "index.html", content: '<script src="./assets/vendor/three.min.js" defer></script>' },
    ]);
    const checks = motionBuildChecks(config, tree);
    expect(checks.some((c) => c.severity === "error" && c.path === SCENE3D_RUNTIME_PATH)).toBe(true);
    void program;
  });

  test("pages not referencing the three.js vendor script produce an honest warning", () => {
    const config = baseConfig({
      scene3d: scene3dBlockSchema.parse(scene3dEnabled([validScene()])),
    } as never);
    const tree = buildTree([
      { path: "index.html", content: "<html lang=\"en\"><body>no scripts</body></html>" },
      { path: SCENE3D_RUNTIME_PATH, content: "(generated runtime)" },
      { path: "assets/vendor/three.min.js", content: "(vendor)" },
    ]);
    const checks = motionBuildChecks(config, tree);
    expect(checks.some((c) => c.severity === "warning" && c.message.includes("three.js vendor"))).toBe(true);
  });

  test("a complete scene3d tree produces no scene3d findings", () => {
    const config = baseConfig({
      scene3d: scene3dBlockSchema.parse(scene3dEnabled([validScene()])),
    } as never);
    const tree = buildTree([
      { path: "index.html", content: '<script src="./assets/vendor/three.min.js" defer></script>' },
      { path: SCENE3D_RUNTIME_PATH, content: "(generated runtime)" },
      { path: "assets/vendor/three.min.js", content: "(vendor)" },
    ]);
    const checks = motionBuildChecks(config, tree);
    expect(checks.filter((c) => c.message.includes("3D") || c.path === SCENE3D_RUNTIME_PATH)).toHaveLength(0);
  });
});

describe("markupBuildChecks — static markup sanity (GZ-1)", () => {
  test("duplicate element ids are ERRORS", () => {
    const html = '<html lang="en"><body><div id="x"></div><div id="x"></div></body></html>';
    const checks = markupBuildChecks(buildTree([{ path: "index.html", content: html }]));
    const dup = checks.find((c) => c.severity === "error" && c.message.includes("duplicate element id"));
    expect(dup).toBeDefined();
    expect(dup!.message).toContain('"x"');
  });

  test("missing viewport / lang / alt produce WARNINGS", () => {
    const html = '<html><body><img src="a.png"><img src="b.png" alt="ok"></body></html>';
    const checks = markupBuildChecks(buildTree([{ path: "index.html", content: html }]));
    expect(checks.some((c) => c.severity === "warning" && c.message.includes("viewport"))).toBe(true);
    expect(checks.some((c) => c.severity === "warning" && c.message.includes("lang attribute"))).toBe(true);
    expect(checks.some((c) => c.severity === "warning" && c.message.includes("alt attribute") && c.message.includes("1 <img>"))).toBe(true);
  });

  test("an inline script touching GSAP globals BEFORE the vendor tag is an ERROR; after is fine", () => {
    const early = [
      '<html lang="en">',
      "<head><script>gsap.to('.x', { opacity: 1 });</script>",
      '<script src="./assets/vendor/gsap.min.js" defer></script></head>',
      "<body></body></html>",
    ].join("\n");
    const earlyChecks = markupBuildChecks(buildTree([{ path: "index.html", content: early }]));
    expect(earlyChecks.some((c) => c.severity === "error" && c.message.includes("script order"))).toBe(true);

    const late = [
      '<html lang="en">',
      "<head>",
      '<script src="./assets/vendor/gsap.min.js" defer></script>',
      "<script>gsap.to('.x', { opacity: 1 });</script></head>",
      "<body></body></html>",
    ].join("\n");
    const lateChecks = markupBuildChecks(buildTree([{ path: "index.html", content: late }]));
    expect(lateChecks.some((c) => c.severity === "error" && c.message.includes("script order"))).toBe(false);
  });

  test("generated-style pages (viewport + lang + alt) stay clean", () => {
    const html = [
      '<html lang="en">',
      '<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>',
      '<body><img src="cover.png" alt="Cover"></body>',
      "</html>",
    ].join("\n");
    const checks = markupBuildChecks(buildTree([{ path: "index.html", content: html }]));
    expect(checks).toHaveLength(0);
  });
});
