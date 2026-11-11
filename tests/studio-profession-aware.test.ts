/// <reference types="bun-types" />
/**
 * Universal Studio — profession-aware schema, templates and envelope tests
 * (pure data, no DB required).
 *
 * Contract under test (spec §2, §4, §5, §10, §11):
 *   a) every profession in the taxonomy resolves to its family work profile —
 *      the 8 spec professions (video editor, developer, doctor, architect,
 *      journalist, teacher, entrepreneur, researcher) each get the RIGHT
 *      family schema with non-empty kinds;
 *   b) profession-specific field rules: a doctor's profile hides repoUrl,
 *      a developer's keeps it; a field with existing data is NEVER hidden;
 *   c) customFields envelope: parse is defensive (null/corrupt/overflow →
 *      bounded), stringify round-trips, empty input → null;
 *   d) templates: unique ids, every family has ≥1 non-universal template,
 *      kinds reference real family kinds, templateMerges only flags fields
 *      that already hold content (the no-overwrite-without-confirmation rule);
 *   e) search: by family keeps family templates in front, universal templates
 *      always remain reachable; multi-term query filters;
 *   f) profession switching never loses data: parse keeps unknown field keys
 *      and stringify preserves them.
 *
 * Run: bun test tests/studio-profession-aware.test.ts
 */
import { describe, expect, test } from "bun:test";

import { PROFESSION_FAMILIES, flattenTaxonomy } from "@/lib/professions/taxonomy";
import {
  DEFAULT_WORK_PROFILE,
  FAMILY_WORK_PROFILES,
  UNIVERSAL_PROJECT_KINDS,
  familyForProfession,
  fieldIsRelevant,
  kindLabel,
  parseStudioCustomFields,
  stringifyStudioCustomFields,
  workProfileForFamily,
  workProfileForProfessions,
} from "@/lib/studio-schema";
import {
  PROJECT_TEMPLATES,
  familyIndustryLabel,
  searchTemplates,
  templateById,
  templateMerges,
  templatesForFamily,
  templatesForKind,
} from "@/lib/studio-templates";

// ---------------------------------------------------------------- a) profiles

describe("work profiles — the 8 required professions", () => {
  const CASES: { profession: string; family: string; kindIncludes: string[] }[] = [
    { profession: "video-editor", family: "film-audio-entertainment", kindIncludes: ["showreel", "video-project", "color-grading", "film-project"] },
    { profession: "software-dev", family: "technology", kindIncludes: ["web-app", "mobile-app", "api-backend", "open-source", "ai-ml-project", "technical-case-study"] },
    { profession: "doctor", family: "health-wellness", kindIncludes: ["qualification", "clinical-experience", "research-publication", "certification"] },
    { profession: "architect", family: "architecture-engineering", kindIncludes: ["architectural-project", "building-design", "floor-plans", "3d-renders", "interior-design"] },
    { profession: "reporter", family: "journalism-media", kindIncludes: ["news-report", "investigative-report", "publication", "documentary"] },
    { profession: "teacher", family: "education-research", kindIncludes: ["teaching-record", "course", "educational-resource", "research"] },
    { profession: "entrepreneur", family: "business-practice", kindIncludes: ["venture", "product-launch", "client-engagement", "campaign"] },
    { profession: "lab-scientist", family: "education-research", kindIncludes: ["research"] },
  ];

  for (const c of CASES) {
    test(`${c.profession} → family ${c.family} with its work kinds`, () => {
      expect(familyForProfession(c.profession)).toBe(c.family);
      const profile = workProfileForProfessions([c.profession]);
      expect(profile.familySlug).toBe(c.family);
      const slugs = profile.projectKinds.map((k) => k.slug);
      for (const kind of c.kindIncludes) expect(slugs).toContain(kind);
      // universal kinds always close the list
      for (const u of UNIVERSAL_PROJECT_KINDS) expect(slugs).toContain(u.slug);
    });
  }

  test("science-environment-agriculture researcher gets the field-study schema", () => {
    const profile = workProfileForProfessions(["environmental-scientist"]);
    expect(profile.familySlug).toBe("science-environment-agriculture");
    expect(profile.projectKinds.map((k) => k.slug)).toContain("field-study");
  });

  test("entrepreneur + developer multi-profession merge: first family leads kinds, both present", () => {
    const profile = workProfileForProfessions(["entrepreneur", "software-dev"]);
    const slugs = profile.projectKinds.map((k) => k.slug);
    expect(slugs.indexOf("venture")).toBeLessThan(slugs.indexOf("web-app")); // first profession leads
    expect(slugs).toContain("venture");
    expect(slugs).toContain("web-app");
  });

  test("no profession → generic profile with universal kinds and no hidden fields", () => {
    const profile = workProfileForProfessions([]);
    expect(profile.familySlug).toBe(DEFAULT_WORK_PROFILE.familySlug);
    expect(profile.hiddenFields).toEqual([]);
    expect(profile.suggestedFields).toEqual([]);
    expect(profile.projectKinds.length).toBeGreaterThan(0);
  });

  test("unknown profession slug degrades to the generic profile", () => {
    expect(workProfileForProfessions(["definitely-not-a-slug"]).familySlug).toBe("*");
  });
});

describe("taxonomy completeness — every family has a profile", () => {
  test("all 13 families have a work profile with kinds + labels resolve", () => {
    expect(FAMILY_WORK_PROFILES["*"]).toBeUndefined(); // no wildcard family row
    for (const family of PROFESSION_FAMILIES) {
      const profile = FAMILY_WORK_PROFILES[family.slug];
      expect(profile, `missing profile for ${family.slug}`).toBeDefined();
      expect(profile!.projectKinds.length).toBeGreaterThan(0);
      for (const kind of profile!.projectKinds) {
        expect(kind.label.length).toBeGreaterThan(0);
        expect(kind.description.length).toBeGreaterThan(0);
      }
    }
  });

  test("every taxonomy profession maps to a family profile via helpers", () => {
    for (const p of flattenTaxonomy()) {
      const fam = familyForProfession(p.slug);
      expect(fam, `${p.slug} has no family`).not.toBeNull();
      const profile = workProfileForFamily(fam);
      expect(profile.familySlug).toBe(fam);
    }
  });

  test("kindLabel resolves within a profile and falls back to the slug", () => {
    const tech = workProfileForFamily("technology");
    expect(kindLabel(tech, "web-app")).toBe("Web application");
    expect(kindLabel(tech, "not-a-kind")).toBe("not-a-kind");
    expect(kindLabel(tech, null)).toBe("");
  });
});

// ------------------------------------------------------- b) field visibility

describe("field visibility rules", () => {
  test("doctor (health-wellness) never sees an empty GitHub repository field", () => {
    const doctor = workProfileForProfessions(["doctor"]);
    expect(doctor.hiddenFields).toContain("repoUrl");
    expect(fieldIsRelevant(doctor, "repoUrl", false)).toBe(false);
  });

  test("a developer keeps the repository field", () => {
    const dev = workProfileForProfessions(["software-dev"]);
    expect(dev.hiddenFields).not.toContain("repoUrl");
    expect(fieldIsRelevant(dev, "repoUrl", false)).toBe(true);
  });

  test("existing data is NEVER hidden — old projects keep their values editable", () => {
    const doctor = workProfileForProfessions(["doctor"]);
    expect(fieldIsRelevant(doctor, "repoUrl", true)).toBe(true);
  });

  test("health profile strips tools suggestions (no 'recommended tools' for clinics)", () => {
    const doctor = workProfileForProfessions(["doctor"]);
    expect(doctor.tools).toEqual([]);
  });

  test("schemas are suggestions — every profile keeps brief/process/etc. renderable", () => {
    for (const family of PROFESSION_FAMILIES) {
      const profile = FAMILY_WORK_PROFILES[family.slug]!;
      // hiddenFields may only contain OPTIONAL metadata columns, never the
      // core narrative fields every profession needs.
      for (const key of profile.hiddenFields) {
        expect(["repoUrl", "tools"]).toContain(key);
      }
    }
  });
});

// --------------------------------------------------- c) customFields envelope

describe("customFields envelope", () => {
  test("null / empty / corrupt input → null (never a crash)", () => {
    expect(parseStudioCustomFields(null)).toBeNull();
    expect(parseStudioCustomFields(undefined)).toBeNull();
    expect(parseStudioCustomFields("")).toBeNull();
    expect(parseStudioCustomFields("not json at all {{{")).toBeNull();
    expect(parseStudioCustomFields("[1,2,3]")).toBeNull(); // arrays rejected
    expect(parseStudioCustomFields('{"fields": 42}')).toBeNull();
  });

  test("parse bounds values and counts (12 fields, 8 custom, 600 chars)", () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < 20; i++) fields[`f${i}`] = "x".repeat(1000);
    const custom = Array.from({ length: 20 }, (_, i) => ({ label: `L${i}`, value: "v" }));
    const parsed = parseStudioCustomFields(JSON.stringify({ kind: "web-app", fields, custom }))!;
    expect(parsed.kind).toBe("web-app");
    expect(Object.keys(parsed.fields!).length).toBe(12);
    expect(Object.values(parsed.fields!)[0].length).toBe(600);
    expect(parsed.custom!.length).toBe(8);
  });

  test("empty entries are dropped; blank strings never stored", () => {
    const parsed = parseStudioCustomFields(
      JSON.stringify({
        kind: "  ",
        fields: { a: "", b: "real" },
        custom: [{ label: "", value: "" }, { label: "Venue", value: "Kochi" }],
      })
    )!;
    expect(parsed.kind).toBeUndefined();
    expect(parsed.fields).toEqual({ b: "real" });
    expect(parsed.custom).toEqual([{ label: "Venue", value: "Kochi" }]);
  });

  test("stringify round-trips and empty envelope → null", () => {
    const input = { kind: "showreel", templateId: "film-showreel", fields: { runtime: "4:32" }, custom: [{ label: "Year", value: "2025" }] };
    const round = parseStudioCustomFields(stringifyStudioCustomFields(input));
    expect(round).toEqual(input);
    expect(stringifyStudioCustomFields({})).toBeNull();
    expect(stringifyStudioCustomFields({ kind: "" })).toBeNull();
  });

  test("profession switching keeps unknown structured keys (no data loss)", () => {
    const saved = JSON.stringify({ kind: "web-app", fields: { stack: "Rust", totallyCustom: "keep me" } });
    const parsed = parseStudioCustomFields(saved)!;
    expect(parsed.fields!.totallyCustom).toBe("keep me");
  });
});

// ------------------------------------------------------------------ d) templates

describe("project templates", () => {
  test("ids are unique", () => {
    const ids = PROJECT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every template targets at least one kind that exists in its family schema (or is universal)", () => {
    const allKindSlugs = new Set<string>([
      ...Object.values(FAMILY_WORK_PROFILES).flatMap((p) => p.projectKinds.map((k) => k.slug)),
      ...UNIVERSAL_PROJECT_KINDS.map((k) => k.slug),
    ]);
    for (const t of PROJECT_TEMPLATES) {
      expect(t.kinds.length, `${t.id} has no kinds`).toBeGreaterThan(0);
      for (const kind of t.kinds) {
        expect(allKindSlugs.has(kind), `${t.id} targets unknown kind ${kind}`).toBe(true);
      }
    }
  });

  test("every family has at least one NON-universal template (universals never mask a field)", () => {
    for (const family of PROFESSION_FAMILIES) {
      const own = PROJECT_TEMPLATES.filter((t) => !t.families.includes("*") && t.families.includes(family.slug));
      expect(own.length, `family ${family.slug} has no dedicated template`).toBeGreaterThan(0);
    }
  });

  test("templates resolve by id and kind", () => {
    expect(templateById("tech-product-build")?.name).toBe("Product build");
    expect(templatesForKind("showreel").map((t) => t.id)).toContain("film-showreel");
    expect(templateById("does-not-exist")).toBeNull();
  });

  test("templatesForFamily always includes the universal set, plus the family's own", () => {
    const health = templatesForFamily("health-wellness");
    expect(health.some((t) => t.id === "health-qualification")).toBe(true);
    expect(health.some((t) => t.id === "universal-case-study")).toBe(true);
    expect(templatesForFamily(null).every((t) => t.families.includes("*"))).toBe(true);
  });

  test("templateMerges: empty project → no confirmation needed; filled tags → confirmation required", () => {
    const t = templateById("tech-product-build")!;
    expect(templateMerges(t, {})).toEqual([]);
    expect(templateMerges(t, { skills: [], tools: [] })).toEqual([]);
    expect(templateMerges(t, { skills: ["Rust"], tools: [] })).toContain("skills");
    expect(templateMerges(t, { skills: ["Rust"], tools: ["Docker"] })).toEqual(["skills", "tools"]);
  });

  test("search: multi-term filtering across name/style/industry", () => {
    const hit = searchTemplates("product engineering case study");
    expect(hit.some((t) => t.id === "tech-product-build")).toBe(true);
    expect(searchTemplates("zzzz-no-match-qqqq")).toEqual([]);
    const familyScoped = searchTemplates("", { familySlug: "film-audio-entertainment" });
    expect(familyScoped.some((t) => t.id === "film-showreel")).toBe(true);
    // family scoping keeps universal templates reachable
    expect(familyScoped.some((t) => t.families.includes("*"))).toBe(true);
  });

  test("industry labels resolve for template cards", () => {
    expect(familyIndustryLabel("film-audio-entertainment")).toBe("Film, Audio & Entertainment");
  });
});
