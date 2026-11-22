/**
 * GZ-BENCH-1 regression: pre-schema config shape heal (normalizeConfig).
 *
 * Baseline benchmark evidence (run 2026-11-22-baseline) recorded three
 * model-written shapes that failed the strict site schema TWICE per design
 * step and thereby killed whole turns:
 *   - B turn1: scene3d block with invented keys ("preset", "intensity")
 *   - D turn1: section layout outside the per-type enum
 *   - B turn2: section without the required title string
 * The heal fixes exactly these three shapes before the strict schema runs;
 * everything else must still be rejected unchanged.
 */

import { describe, expect, test } from "bun:test";

import { defaultConfig, normalizeConfig } from "../src/lib/site-config";

/** A JSON-round-tripped default config — the raw-shape fixture. */
const baseDefault: Record<string, unknown> = JSON.parse(JSON.stringify(defaultConfig()));

function rawWithSections(sections: unknown[]): Record<string, unknown> {
  return {
    ...JSON.parse(JSON.stringify(baseDefault)),
    pages: [
      { id: "home", name: "Home", visible: true, sections },
    ],
  };
}

describe("normalizeConfig shape heal — unknown scene3d keys are stripped, not fatal", () => {
  test("a model-written scene3d block with invented keys survives with only the known keys", () => {
    // The live B-turn1 failure: the model wrote scene3d as if it were a
    // generic effect block — the strict block schema rejects ANY unknown key.
    const raw = {
      ...JSON.parse(JSON.stringify(baseDefault)),
      scene3d: { enabled: true, preset: "cinematic-orbit", intensity: 0.8 },
    };
    const normalized = normalizeConfig(raw);
    expect(normalized).not.toBeNull();
    expect(normalized!.scene3d?.enabled).toBe(true);
    // No invented keys remain (the parsed block only knows enabled /
    // respectReducedMotion / scenes).
    expect(Object.keys(normalized!.scene3d ?? {}).sort()).toEqual(["enabled", "respectReducedMotion", "scenes"]);
  });

  test("a valid scene3d block is untouched by the heal", () => {
    const raw = {
      ...JSON.parse(JSON.stringify(baseDefault)),
      scene3d: { enabled: false, respectReducedMotion: true, scenes: [] },
    };
    const normalized = normalizeConfig(raw);
    expect(normalized).not.toBeNull();
    expect(normalized!.scene3d?.enabled).toBe(false);
  });
});

describe("normalizeConfig shape heal — invalid section layout falls back to the schema default", () => {
  test("a services section with an out-of-enum layout is healed to the default", () => {
    // The live D-turn1 failure: layout "…expected one of \"cards\"|\"rows\"".
    const raw = rawWithSections([
      { id: "svc-1", type: "services", title: "Services", layout: "bento" },
    ]);
    const normalized = normalizeConfig(raw);
    expect(normalized).not.toBeNull();
    const services = normalized!.pages[0]!.sections.find((s) => s.type === "services");
    expect(services).toBeDefined();
    expect((services as { layout?: string }).layout).toBe("cards");
  });

  test("a valid layout value passes through unchanged", () => {
    const raw = rawWithSections([
      { id: "svc-1", type: "services", title: "Services", layout: "rows", items: [] },
    ]);
    const normalized = normalizeConfig(raw);
    expect(normalized).not.toBeNull();
    const services = normalized!.pages[0]!.sections.find((s) => s.type === "services");
    expect((services as { layout?: string }).layout).toBe("rows");
  });

  test("an unknown section type is still rejected (the heal never masks real errors)", () => {
    const raw = rawWithSections([
      { id: "x-1", type: "showreel", title: "Reel" },
    ]);
    expect(normalizeConfig(raw)).toBeNull();
  });
});

describe("normalizeConfig shape heal — missing section title falls back to the factory title", () => {
  test("an about section without a title is healed with the factory default", () => {
    // The live B-turn2 failure: "pages.1.sections.0.title: expected string,
    // received undefined".
    const raw = rawWithSections([
      { id: "about-1", type: "about", body: "Studio story." },
    ]);
    const normalized = normalizeConfig(raw);
    expect(normalized).not.toBeNull();
    const about = normalized!.pages[0]!.sections.find((s) => s.type === "about");
    expect(about).toBeDefined();
    expect((about as { title?: string }).title).toBe("About");
  });

  test("a section that already has a title keeps it verbatim", () => {
    const raw = rawWithSections([
      { id: "about-1", type: "about", title: "Our story", body: "" },
    ]);
    const normalized = normalizeConfig(raw);
    expect(normalized).not.toBeNull();
    const about = normalized!.pages[0]!.sections.find((s) => s.type === "about");
    expect((about as { title?: string }).title).toBe("Our story");
  });
});

describe("normalizeConfig shape heal — scene-level 3D specs (benchmark E failure)", () => {
  /** The live E-turn2 failure shape: invented camera key, invented primitive kind, invented pointer/scroll modes, broken fallback. */
  const brokenScene = {
    id: "vela-hero",
    target: { kind: "hero" },
    camera: { fov: 42, controls: "orbit-drag" },
    objects: [
      { id: "shell", kind: "headphone-shell", position: { x: 0, y: 0, z: 0 } },
      { id: "core", kind: "torusKnot", position: { x: 0, y: 0, z: 0 }, material: { kind: "standard", metalness: 0.6 } },
    ],
    lights: [{ kind: "spotlight", color: "#ffffff" }, { kind: "ambient" }],
    interactions: { pointer: "drag-orbit", hover: "scale" },
    scroll: { mode: "rotateWithScroll", strength: 0.6 },
    fallback: { kind: "image", value: "/hero.png" },
  };

  test("invented scene keys/values are dropped and the renderable parts survive", () => {
    const raw = {
      ...JSON.parse(JSON.stringify(baseDefault)),
      scene3d: { enabled: true, scenes: [brokenScene] },
    };
    const normalized = normalizeConfig(raw);
    expect(normalized).not.toBeNull();
    const block = normalized!.scene3d!;
    expect(block.enabled).toBe(true);
    expect(block.scenes.length).toBe(1);
    const scene = block.scenes[0]! as unknown as Record<string, unknown>;
    // unknown camera key stripped, valid fov kept:
    expect((scene.camera as Record<string, unknown>).controls).toBeUndefined();
    expect((scene.camera as Record<string, unknown>).fov).toBe(42);
    // unrenderable object dropped, valid one kept:
    const objects = scene.objects as { id: string }[];
    expect(objects.map((o) => o.id)).toEqual(["core"]);
    // invalid light dropped, valid one kept:
    const lights = scene.lights as { kind: string }[];
    expect(lights.map((l) => l.kind)).toEqual(["ambient"]);
    // invalid optional enum values dropped (valid hover kept):
    expect((scene.interactions as Record<string, unknown>).pointer).toBeUndefined();
    expect((scene.interactions as Record<string, unknown>).hover).toBe("scale");
    expect((scene.scroll as Record<string, unknown>).mode).toBeUndefined();
    expect((scene.scroll as Record<string, unknown>).strength).toBe(0.6);
    // unusable fallback dropped entirely (optional — the engine has its own):
    expect(scene.fallback).toBeUndefined();
  });

  test("a scene with no renderable object is dropped (pre-existing block semantics: zero scenes stay enabled but render nothing)", () => {
    const raw = {
      ...JSON.parse(JSON.stringify(baseDefault)),
      scene3d: {
        enabled: true,
        scenes: [{ id: "only", target: { kind: "hero" }, objects: [{ id: "x", kind: "headphone" }] }],
      },
    };
    const normalized = normalizeConfig(raw);
    expect(normalized).not.toBeNull();
    // The unrenderable scene did not survive the heal — the block has no scenes.
    expect(normalized!.scene3d?.scenes.length ?? 0).toBe(0);
  });

  test("a fully valid scene passes through unchanged", () => {
    const scene = {
      id: "clean",
      target: { kind: "hero" },
      camera: { fov: 50 },
      objects: [{ id: "shape", kind: "icosahedron", material: { kind: "standard", metalness: 0.4 } }],
      interactions: { pointer: "rotate" },
      scroll: { mode: "cameraOrbit", strength: 0.5 },
      fallback: { kind: "color", value: "#101014" },
    };
    const raw = {
      ...JSON.parse(JSON.stringify(baseDefault)),
      scene3d: { enabled: true, scenes: [scene] },
    };
    const normalized = normalizeConfig(raw);
    expect(normalized).not.toBeNull();
    expect(normalized!.scene3d?.scenes.length).toBe(1);
    expect(normalized!.scene3d?.scenes[0]?.objects[0]?.kind).toBe("icosahedron");
    expect(normalized!.scene3d?.scenes[0]?.fallback).toEqual({ kind: "color", value: "#101014" });
  });
});

describe("normalizeConfig shape heal — safety properties", () => {
  test("the caller's input object is never mutated by the heal", () => {
    const raw = {
      ...JSON.parse(JSON.stringify(baseDefault)),
      scene3d: { enabled: true, preset: "orbit" },
    };
    const before = JSON.stringify(raw);
    normalizeConfig(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(Object.keys((raw.scene3d as Record<string, unknown>))).toContain("preset");
  });

  test("a non-object config is still rejected", () => {
    expect(normalizeConfig(42)).toBeNull();
    expect(normalizeConfig("not json")).toBeNull();
    expect(normalizeConfig([1, 2, 3])).toBeNull();
  });
});
