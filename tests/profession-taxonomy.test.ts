/// <reference types="bun-types" />
/**
 * Universal Profession Taxonomy — data-level tests (no DB required).
 *
 * Contract under test (docs/PROFESSION_TAXONOMY.md):
 *   a) every legacy slug survives with its UNCHANGED label + group;
 *   b) the tree is a real expansion: >= 130 professions across >= 13 families;
 *   c) slugs are unique and slug-formatted everywhere (families, professions,
 *      specialisms);
 *   d) specialisms reference existing professions;
 *   e) the journalism-media family contains the mandated anchors of the craft;
 *   f) labels are unique within a family (dropdown/grouping sanity);
 *   + legacy order block stays 1..18 and new professions start at 20.
 *
 * Run: bun test tests/profession-taxonomy.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  PROFESSION_FAMILIES,
  LEGACY_PROFESSIONS,
  flattenTaxonomy,
} from "@/lib/professions/taxonomy";

/** Frozen legacy truth — copied byte-for-byte from the pre-expansion seed. */
const LEGACY_EXPECTATIONS: { slug: string; label: string; group: string }[] = [
  { slug: "film-video", label: "Film & Video", group: "Film & Motion" },
  { slug: "motion-design", label: "Motion Design", group: "Film & Motion" },
  { slug: "photography", label: "Photography", group: "Visual Arts" },
  { slug: "graphic-design", label: "Graphic Design", group: "Design" },
  { slug: "ui-ux", label: "UI/UX Design", group: "Design" },
  { slug: "product-design", label: "Product Design", group: "Design" },
  { slug: "illustration", label: "Illustration", group: "Visual Arts" },
  { slug: "art", label: "Fine Art", group: "Visual Arts" },
  { slug: "software-dev", label: "Software Development", group: "Technology" },
  { slug: "architecture", label: "Architecture", group: "Built Environment" },
  { slug: "civil-engineering", label: "Civil Engineering", group: "Built Environment" },
  { slug: "writing", label: "Writing & Journalism", group: "Media" },
  { slug: "education", label: "Education & Research", group: "Media" },
  { slug: "culinary", label: "Culinary & Hospitality", group: "Hospitality" },
  { slug: "marketing", label: "Marketing & Business", group: "Business" },
  { slug: "music", label: "Music & Audio", group: "Film & Motion" },
  { slug: "fashion", label: "Fashion", group: "Design" },
  { slug: "other", label: "Other", group: "Multi-discipline" },
];

const SLUG_RE = /^[a-z0-9-]+$/;

const flatFamilies = () => flattenTaxonomy();

describe("profession taxonomy — legacy backward compatibility", () => {
  test("every legacy slug is present with unchanged label and group", () => {
    const bySlug = new Map(LEGACY_PROFESSIONS.map((l) => [l.slug, l]));
    expect(LEGACY_PROFESSIONS).toHaveLength(18);
    for (const expected of LEGACY_EXPECTATIONS) {
      const row = bySlug.get(expected.slug);
      expect({ slug: expected.slug, found: !!row }).toEqual({ slug: expected.slug, found: true });
      expect(row?.label).toBe(expected.label);
      expect(row?.group).toBe(expected.group);
    }
  });

  test("each legacy slug lives in exactly one family with the same label", () => {
    for (const expected of LEGACY_EXPECTATIONS) {
      const homes = PROFESSION_FAMILIES.filter((f) =>
        f.professions.some((p) => p.slug === expected.slug)
      );
      expect({ slug: expected.slug, homes: homes.length }).toEqual({ slug: expected.slug, homes: 1 });
      const seed = homes[0]?.professions.find((p) => p.slug === expected.slug);
      expect(seed?.label).toBe(expected.label);
    }
  });

  test("legacy order block stays 1..18 and groups are preserved by flattenTaxonomy", () => {
    const flat = new Map(flatFamilies().map((p) => [p.slug, p]));
    LEGACY_EXPECTATIONS.forEach((expected, i) => {
      const row = flat.get(expected.slug);
      expect(row?.order).toBe(i + 1);
      expect(row?.group).toBe(expected.group);
    });
  });

  test("new professions never collide with the legacy order block (>= 20)", () => {
    const legacySlugs = new Set(LEGACY_EXPECTATIONS.map((l) => l.slug));
    for (const row of flatFamilies()) {
      if (legacySlugs.has(row.slug)) continue;
      expect(row.order).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("profession taxonomy — shape and scale", () => {
  test(">= 13 families and >= 130 professions", () => {
    expect(PROFESSION_FAMILIES.length).toBeGreaterThanOrEqual(13);
    const total = PROFESSION_FAMILIES.reduce((n, f) => n + f.professions.length, 0);
    expect(total).toBeGreaterThanOrEqual(130);
  });

  test("family + profession + specialism slugs are unique and slug-formatted", () => {
    const familySlugs: string[] = [];
    const professionSlugs: string[] = [];
    const specialismSlugs: string[] = [];

    for (const family of PROFESSION_FAMILIES) {
      familySlugs.push(family.slug);
      expect(family.slug).toMatch(SLUG_RE);
      for (const profession of family.professions) {
        professionSlugs.push(profession.slug);
        expect(profession.slug).toMatch(SLUG_RE);
        for (const spec of profession.specialisms ?? []) {
          specialismSlugs.push(spec.slug);
          expect(spec.slug).toMatch(SLUG_RE);
        }
      }
    }

    expect(new Set(familySlugs).size).toBe(familySlugs.length);
    expect(new Set(professionSlugs).size).toBe(professionSlugs.length);
    expect(new Set(specialismSlugs).size).toBe(specialismSlugs.length);
  });

  test("every profession has a non-empty label and description; aliases are strings", () => {
    for (const family of PROFESSION_FAMILIES) {
      expect(family.label.length).toBeGreaterThan(0);
      for (const profession of family.professions) {
        expect({ slug: profession.slug, label: profession.label.length > 0 }).toEqual({
          slug: profession.slug,
          label: true,
        });
        expect({ slug: profession.slug, hasDescription: (profession.description ?? "").length > 0 }).toEqual({
          slug: profession.slug,
          hasDescription: true,
        });
        for (const alias of profession.aliases ?? []) {
          expect(typeof alias).toBe("string");
          expect(alias.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("no duplicate labels within a family", () => {
    for (const family of PROFESSION_FAMILIES) {
      const labels = family.professions.map((p) => p.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  test("every family is non-trivial (>= 6 professions)", () => {
    for (const family of PROFESSION_FAMILIES) {
      expect(family.professions.length).toBeGreaterThanOrEqual(6);
    }
  });
});

describe("profession taxonomy — specialisms", () => {
  test("every specialism references an existing profession (globally unique slugs)", () => {
    const knownProfessions = new Set(flatFamilies().map((p) => p.slug));
    for (const family of PROFESSION_FAMILIES) {
      for (const profession of family.professions) {
        for (const spec of profession.specialisms ?? []) {
          expect(knownProfessions.has(profession.slug)).toBe(true);
          expect(spec.label.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("key professions carry 2-6 specialisms", () => {
    const specialismCount = new Map<string, number>();
    for (const row of flatFamilies()) {
      if (row.specialisms && row.specialisms.length > 0) {
        specialismCount.set(row.slug, row.specialisms.length);
      }
    }
    const required = [
      "news-anchor",
      "reporter",
      "photojournalist",
      "doctor",
      "software-engineer",
      "fullstack-dev",
      "photographer",
      "chef",
      "legal-professional",
      "teacher",
      "architect",
    ];
    for (const slug of required) {
      const n = specialismCount.get(slug) ?? 0;
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(6);
    }
  });
});

describe("profession taxonomy — journalism-media family", () => {
  const journalism = PROFESSION_FAMILIES.find((f) => f.slug === "journalism-media");
  const journalismSlugs = new Set(journalism?.professions.map((p) => p.slug) ?? []);

  test("family exists and is the richest", () => {
    expect(journalism).toBeDefined();
    const counts = PROFESSION_FAMILIES.map((f) => f.professions.length);
    expect(journalism!.professions.length).toBe(Math.max(...counts));
  });

  test("contains the mandated newsroom core", () => {
    for (const slug of [
      "news-anchor",
      "investigative-journalist",
      "photojournalist",
      "fact-checker",
      "broadcast-journalist",
      "correspondent",
      "news-editor",
      "podcast-host",
      "freelance-journalist",
    ]) {
      expect({ slug, inJournalism: journalismSlugs.has(slug) }).toEqual({ slug, inJournalism: true });
    }
  });

  test("all journalism professions carry descriptions (mandated)", () => {
    for (const profession of journalism!.professions) {
      expect(profession.description.length).toBeGreaterThan(10);
    }
  });
});
