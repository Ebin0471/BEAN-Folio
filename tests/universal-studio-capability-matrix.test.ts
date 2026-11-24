/// <reference types="bun-types" />
/**
 * Universal studio capability matrix — doc-truth pin (M33.0).
 *
 * Contract under test (docs/GIFTZ_UNIVERSAL_CREATIVE_STUDIO_GUIDE.md M33.0):
 * "Add/update tests that prevent the docs/UI capability matrix from claiming
 * nonexistent functionality."
 *
 * This suite mechanically pins docs/UNIVERSAL_STUDIO_CAPABILITY_MATRIX.md to
 * the LIVE code:
 *   a) every registry count printed in the matrix equals the length of the
 *      imported registry (docs may never claim a count the source disproves);
 *   b) every src/docs/tests evidence path cited in the matrix exists on disk;
 *   c) the "Unsupported (today)" claims about RIISHE tool families are true
 *      against the live RIISHE_TOOLS keys;
 *   d) the canonical LAXII banner preset is exactly the registered one
 *      (2048×687) and no expanded registry exists;
 *   e) the schema's 17th section types (featured/reel) omitted by the old
 *      stale prompt text are present, and the stale strings are gone;
 *   f) the guide + matrix + historical LAXII banner + README index links
 *      exist.
 *
 * Pure test — no DB required.
 * Run: bun test tests/universal-studio-capability-matrix.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { SITE_FONTS } from "@/lib/site-fonts";
import { SECTION_TYPES } from "@/lib/site-config";
import { PALETTES } from "@/lib/site-palettes";
import { MOTION_PRESET_IDS } from "@/lib/site-motion";
import { DESIGN_LANGUAGES } from "@/lib/ai-design/design-languages";
import { playbookForFamily } from "@/lib/professions/playbooks";
import { PROFESSION_FAMILIES } from "@/lib/professions/taxonomy";
import { COMPONENT_REGISTRY } from "@/lib/giftz/component-intelligence";
import { GSAP_MOTION_PRESETS, VANTA_EFFECTS } from "@/lib/giftz/motion-engine";
import { STEP_TOOLS } from "@/lib/ai-design/tools";
import { RIISHE_TOOLS } from "@/lib/riishe/tools";
import { SPECIALIST_TOOLS } from "@/lib/riishe/specialist-tools";
import { SPECIALISTS } from "@/lib/riishe/specialists";
import { RIISHE_MODES } from "@/lib/riishe/modes";
import { BANNER_PRESETS } from "@/lib/laxii/banner-presets";
import { AVATAR_PRESETS } from "@/lib/laxii/avatar-presets";
import { STYLE_PRESETS } from "@/lib/laxii/styles";
import { RESUME_TYPES } from "@/lib/laxii/resume-schema";
import { RESUME_PROFESSION_FAMILIES } from "@/lib/laxii/resume-professions";

const ROOT = process.cwd();
const MATRIX = readFileSync(join(ROOT, "docs/UNIVERSAL_STUDIO_CAPABILITY_MATRIX.md"), "utf8");

/** Extract the count printed in a matrix table row identified by its label prefix. */
function docCount(labelPrefix: string): number {
  const escaped = labelPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = MATRIX.match(new RegExp(`\\|\\s*${escaped}[^|]*\\|\\s*(\\d+)[^|]*\\|`));
  expect(match).not.toBeNull();
  return match ? Number(match[1]) : -1;
}

/** Recursively count route.ts files under a directory. */
function countRouteFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) count += countRouteFiles(full);
    else if (entry === "route.ts") count += 1;
  }
  return count;
}

describe("capability matrix — registry counts match the live code", () => {
  test("GIFTZ §1.1 counts", () => {
    expect(docCount("Site font families")).toBe(SITE_FONTS.length);
    expect(docCount("Section types")).toBe(SECTION_TYPES.length);
    expect(docCount("Curated color palettes")).toBe(PALETTES.length);
    expect(docCount("CSS motion preset ids")).toBe(MOTION_PRESET_IDS.length);
    expect(docCount("Design languages")).toBe(DESIGN_LANGUAGES.length);
    const resolvedPlaybooks = PROFESSION_FAMILIES.filter(
      (f) => playbookForFamily(f.slug) !== null,
    ).length;
    expect(docCount("Profession playbooks")).toBe(resolvedPlaybooks);
    expect(docCount("Component registry entries")).toBe(COMPONENT_REGISTRY.length);
    expect(docCount("GSAP motion presets")).toBe(GSAP_MOTION_PRESETS.length);
    expect(docCount("Vanta background effects")).toBe(VANTA_EFFECTS.length);
    expect(docCount("Config-mode step tools")).toBe(STEP_TOOLS.length);
    expect(docCount("GIFTZ API route files under")).toBe(countRouteFiles(join(ROOT, "src/app/api/giftz")));
  });

  test("LAXII §2.1 counts", () => {
    expect(docCount("Banner canvas presets")).toBe(BANNER_PRESETS.length);
    expect(docCount("Avatar style presets")).toBe(AVATAR_PRESETS.length);
    expect(docCount("Style-registry presets")).toBe(STYLE_PRESETS.length);
    expect(docCount("Resume formats")).toBe(RESUME_TYPES.length);
    expect(docCount("Resume profession families")).toBe(RESUME_PROFESSION_FAMILIES.length);
    expect(docCount("LAXII API route files under")).toBe(countRouteFiles(join(ROOT, "src/app/api/laxii")));
  });

  test("RIISHE §3.1 counts", () => {
    expect(docCount("Registered tools")).toBe(Object.keys(RIISHE_TOOLS).length);
    expect(docCount("Specialists")).toBe(SPECIALISTS.length);
    expect(docCount("Response modes")).toBe(RIISHE_MODES.length);
    expect(docCount("RIISHE API route files under")).toBe(countRouteFiles(join(ROOT, "src/app/api/riishe")));

    // The intent-kind union is type-only — count it from the source text.
    const intentsSource = readFileSync(join(ROOT, "src/lib/riishe/intents.ts"), "utf8");
    const union = intentsSource.match(/export type RiisheIntentKind\s*=\s*([\s\S]*?);/);
    expect(union).not.toBeNull();
    const kinds = union![1].match(/"[A-Z_]+"/g) ?? [];
    expect(docCount("Automation intent kinds")).toBe(kinds.length);
  });

  test("the '9 specialist tools' claim matches the live specialist registry", () => {
    expect(docCount("Registered tools")).toBeGreaterThanOrEqual(Object.keys(SPECIALIST_TOOLS).length);
    expect(Object.keys(SPECIALIST_TOOLS).length).toBe(9);
    for (const id of Object.keys(SPECIALIST_TOOLS)) {
      expect(RIISHE_TOOLS[id]).toBeDefined();
    }
  });
});

describe("capability matrix — evidence paths exist", () => {
  test("every cited src/tests/docs/prisma/script file path exists on disk", () => {
    const pathRe = /`((?:src|tests|docs|prisma|scripts)\/[A-Za-z0-9._/\[\]{}@-]+\.(?:ts|tsx|md|prisma|sh))`/g;
    const paths = new Set<string>();
    for (const match of MATRIX.matchAll(pathRe)) paths.add(match[1]);
    expect(paths.size).toBeGreaterThan(30);
    const missing: string[] = [];
    for (const p of paths) {
      if (!existsSync(join(ROOT, p))) missing.push(p);
    }
    expect(missing).toEqual([]);
  });
});

describe("capability matrix — negative claims are true", () => {
  test("no giftz.* or laxii.* tools are registered in RIISHE_TOOLS (the matrix says 'Unsupported (today)')", () => {
    const keys = Object.keys(RIISHE_TOOLS);
    expect(keys.filter((k) => k.startsWith("giftz.") || k.startsWith("laxii."))).toEqual([]);
    expect(MATRIX).toMatch(/giftz\.\*.*Unsupported \(today\)|Registered `giftz\.\*` tools/);
    expect(MATRIX).toMatch(/Registered `laxii\.\*` tools/);
  });

  test("exactly ONE banner preset exists and it is the canonical 2048×687", () => {
    expect(BANNER_PRESETS.length).toBe(1);
    expect(BANNER_PRESETS[0].width).toBe(2048);
    expect(BANNER_PRESETS[0].height).toBe(687);
  });

  test("SECTION_TYPES includes featured and reel (the types the old stale prompt omitted)", () => {
    expect(SECTION_TYPES).toContain("featured");
    expect(SECTION_TYPES).toContain("reel");
    expect(SECTION_TYPES.length).toBe(17);
  });

  test("preserve-pixel compositing is labelled Removed, never Existing", () => {
    expect(MATRIX).toMatch(/\*\*Removed\*\*/);
    expect(MATRIX).toMatch(/zero.*code|referenced by \*\*zero\*\*/);
  });
});

describe("capability truth fixes — stale strings are gone from source", () => {
  test("ai-design/tools.ts derives its section-type list from SECTION_TYPES", () => {
    const source = readFileSync(join(ROOT, "src/lib/ai-design/tools.ts"), "utf8");
    expect(source).toMatch(/SECTION_TYPES\.join/);
    expect(source).not.toMatch(/15 section types/);
    expect(source).not.toMatch(/11 section types/);
  });

  test("professions/playbooks.ts no longer claims 'the 11 valid SiteSectionTypes'", () => {
    const source = readFileSync(join(ROOT, "src/lib/professions/playbooks.ts"), "utf8");
    expect(source).not.toMatch(/11 valid SiteSectionTypes/);
    expect(source).toMatch(/see SECTION_TYPES in site-config\.ts/);
  });

  test("site-export.ts no longer claims 'all 11 section types'", () => {
    const source = readFileSync(join(ROOT, "src/lib/site-export.ts"), "utf8");
    expect(source).not.toMatch(/all 11 section types/);
    expect(source).toMatch(/see SECTION_TYPES in site-config\.ts/);
  });
});

describe("capability matrix — documentation home and index", () => {
  test("the guide is in the repository at its documented home", () => {
    expect(existsSync(join(ROOT, "docs/GIFTZ_UNIVERSAL_CREATIVE_STUDIO_GUIDE.md"))).toBe(true);
  });

  test("the historical LAXII README carries the HISTORICAL banner", () => {
    const laxiiReadme = readFileSync(join(ROOT, "docs/laxii/README.md"), "utf8");
    expect(laxiiReadme).toMatch(/HISTORICAL DOCUMENT/);
    expect(laxiiReadme).toMatch(/docs\/UNIVERSAL_STUDIO_CAPABILITY_MATRIX\.md/);
  });

  test("the README index links the guide and the matrix", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/docs\/GIFTZ_UNIVERSAL_CREATIVE_STUDIO_GUIDE\.md/);
    expect(readme).toMatch(/docs\/UNIVERSAL_STUDIO_CAPABILITY_MATRIX\.md/);
  });

  test("the matrix references this pinning test", () => {
    expect(MATRIX).toMatch(/tests\/universal-studio-capability-matrix\.test\.ts/);
  });
});
