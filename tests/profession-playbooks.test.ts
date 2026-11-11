/// <reference types="bun-types" />
/**
 * Profession-aware CODE GIFTZ playbooks — data-level tests (no DB required).
 *
 * Contract under test (docs/PROFESSION_AWARE_GENERATION.md):
 *   a) the journalism-media playbook exists, is hero-first (reel/reporting
 *      early) and its anti-fabrication text names publications + bylines;
 *   b) playbooksForProfessions dedupes families and caps at 3, preserving
 *      the user's profession order;
 *   c) mergedPlaybookGuidance: [] → null; a journalist+developer mix unions
 *      BOTH families' content types, lists each section type once, and has
 *      exactly ONE "Never fabricate" line;
 *   d) completeness: every family slug in taxonomy.ts resolves to a valid
 *      playbook (section types ⊆ the 11 valid SiteSectionTypes, all fields
 *      non-empty);
 *   e) templateIds are real: every recommended id exists in templatePresets().
 *
 * Run: bun test tests/profession-playbooks.test.ts
 */
import { describe, expect, test } from "bun:test";

import { PROFESSION_FAMILIES } from "@/lib/professions/taxonomy";
import {
  playbookForFamily,
  playbooksForProfessions,
  mergedPlaybookGuidance,
} from "@/lib/professions/playbooks";
import { SECTION_TYPES, templatePresets } from "@/lib/site-config";

describe("profession playbooks — journalism-media anchor", () => {
  const journalism = playbookForFamily("journalism-media");

  test("playbook exists with the exact family slug", () => {
    expect(journalism).not.toBeNull();
    expect(journalism?.familySlug).toBe("journalism-media");
  });

  test("section order is hero-first with reporting/reel (gallery or projects) immediately after", () => {
    const order = journalism?.sectionOrderPreference ?? [];
    expect(order[0]).toBe("hero");
    expect(["gallery", "projects"]).toContain(order[1]);
  });

  test("anti-fabrication text mentions publications and bylines", () => {
    const text = journalism?.antiFabrication ?? "";
    expect(text).toMatch(/publications/);
    expect(text).toMatch(/bylines/);
  });

  test("project types cover reporting, investigation and showreel formats", () => {
    const types = journalism?.projectTypes ?? [];
    expect(types).toContain("News report");
    expect(types).toContain("Investigation");
    expect(types).toContain("Showreel segment");
  });
});

describe("profession playbooks — multi-profession resolution", () => {
  test("professions of the same family dedupe to ONE playbook", () => {
    const out = playbooksForProfessions(["reporter", "news-anchor", "fact-checker", "copy-editor"]);
    expect(out).toHaveLength(1);
    expect(out[0].familySlug).toBe("journalism-media");
  });

  test("distinct families keep the user's profession order and cap at 3", () => {
    const out = playbooksForProfessions(["reporter", "frontend-dev", "author", "chef"]);
    expect(out).toHaveLength(3);
    expect(out.map((p) => p.familySlug)).toEqual([
      "journalism-media",
      "technology",
      "writing-publishing",
    ]);
  });

  test("unknown slugs are skipped; an empty list yields no playbooks", () => {
    expect(playbooksForProfessions(["definitely-not-a-slug"])).toHaveLength(0);
    expect(playbooksForProfessions([])).toHaveLength(0);
  });
});

describe("mergedPlaybookGuidance — prompt grounding block", () => {
  test("empty/unknown professions → null (current grounding behavior preserved)", () => {
    expect(mergedPlaybookGuidance([])).toBeNull();
    expect(mergedPlaybookGuidance(["not-a-slug"])).toBeNull();
  });

  test("journalist + developer mix unions both families' content types", () => {
    const block = mergedPlaybookGuidance(["reporter", "software-dev"]) ?? "";
    expect(block).toContain("News report"); // journalism-media
    expect(block).toContain("Case study"); // technology
  });

  test("merged section order lists each section type exactly once", () => {
    const block = mergedPlaybookGuidance(["reporter", "software-dev"]) ?? "";
    const orderLine = block
      .split("\n")
      .find((line) => line.includes("Suggested section order:"));
    expect(orderLine).toBeDefined();
    const names = (orderLine ?? "").split(":")[1]?.split(",").map((s) => s.trim()) ?? [];
    expect(new Set(names).size).toBe(names.length);
    const validTypes = SECTION_TYPES as readonly string[];
    for (const name of names) expect(validTypes).toContain(name);
  });

  test("the anti-fabrication statement appears exactly once and unions families", () => {
    const block = mergedPlaybookGuidance(["reporter", "software-dev"]) ?? "";
    expect(block.split("Never fabricate:").length - 1).toBe(1);
    expect(block).toMatch(/publications/); // journalism-media prohibition
    expect(block).toMatch(/employment history/); // technology prohibition
  });

  test("single-family user gets a bounded, labeled block", () => {
    const block = mergedPlaybookGuidance(["photojournalist"]) ?? "";
    const lines = block.split("\n");
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(lines[0]).toContain("Profession guidance");
    expect(block).toContain("suggestions, not requirements");
  });
});

describe("profession playbooks — completeness across the taxonomy", () => {
  test("every family slug resolves to a playbook", () => {
    expect(PROFESSION_FAMILIES).toHaveLength(13);
    for (const family of PROFESSION_FAMILIES) {
      const playbook = playbookForFamily(family.slug);
      expect({ slug: family.slug, found: playbook !== null }).toEqual({
        slug: family.slug,
        found: true,
      });
    }
  });

  test("every playbook is well-formed and schema-valid", () => {
    for (const family of PROFESSION_FAMILIES) {
      const playbook = playbookForFamily(family.slug);
      if (!playbook) continue;
      expect(playbook.familySlug).toBe(family.slug);
      expect(playbook.sectionOrderPreference.length).toBeGreaterThan(0);
      expect(playbook.sectionOrderPreference[0]).toBe("hero");
      for (const type of playbook.sectionOrderPreference) {
        expect(SECTION_TYPES).toContain(type);
      }
      expect(new Set(playbook.sectionOrderPreference).size).toBe(
        playbook.sectionOrderPreference.length
      );
      expect(playbook.projectTypes.length).toBeGreaterThan(0);
      expect(playbook.mediaGuidance.length).toBeGreaterThan(0);
      expect(playbook.evidenceGuidance.length).toBeGreaterThan(0);
      expect(playbook.antiFabrication.length).toBeGreaterThan(0);
    }
  });

  test("unknown family slug → null", () => {
    expect(playbookForFamily("definitely-not-a-family")).toBeNull();
  });
});

describe("profession playbooks — template recommendations", () => {
  test("every recommended template id exists in templatePresets()", () => {
    const allIds = new Set<string>(templatePresets().map((t) => t.id as string));
    for (const family of PROFESSION_FAMILIES) {
      const playbook = playbookForFamily(family.slug);
      if (!playbook) continue;
      for (const id of playbook.templateIds) {
        expect({ family: family.slug, id, exists: allIds.has(id) }).toEqual({
          family: family.slug,
          id,
          exists: true,
        });
      }
    }
  });

  test("template ids are derived, not invented — journalism family picks up newsroom presets", () => {
    const ids = playbookForFamily("journalism-media")?.templateIds ?? [];
    expect(ids.length).toBeGreaterThan(0);
    const presetProfessions = templatePresets().filter((t) => ids.includes(t.id));
    expect(presetProfessions.length).toBe(ids.length);
  });
});
