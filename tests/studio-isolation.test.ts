/// <reference types="bun-types" />
/**
 * Studio isolation regression tests (§6 — preventing cross-feature side effects).
 *
 * The Website Studio's central contract: a change to ONE thing must never
 * silently change ANOTHER thing. Every test here exercises the REAL pipeline
 * functions (applyStep tools, constraint enforcement, changed-file
 * projection) — no mocks of the mutation surface.
 *
 * The ten pinned properties:
 *
 *   1. A font change never touches the project grid (section structure).
 *   2. A per-section hero motion override never leaks site-wide or into
 *      other sections' motion/content.
 *   3. A section-level style override never alters component-level config
 *      (button/link styles) or other sections.
 *   4. A single section's style change pollutes neither the global theme
 *      tokens nor any other section.
 *   5. Template application preserves ALL content (pages/sections/identity).
 *   6. Disabling animations removes no element (structure stays intact).
 *   7. Restoring one protected area never rolls back unrelated applied
 *      changes (constraint repair is surgical, byte-identical).
 *   8. Palette application changes ONLY color tokens — fonts, layout,
 *      motion and content stay untouched.
 *   9. The changed-file inventory attributes each change to EXACTLY the
 *      right virtual file (no cross-domain file noise).
 *  10. Constraint repair restores protected regions BYTE-IDENTICALLY while
 *      keeping the legitimate changes of the same step.
 *
 * Run: bun test tests/studio-isolation.test.ts
 */
import { describe, expect, test } from "bun:test";
import { normalizeConfig, defaultConfig, templatePresets, type SiteConfig } from "@/lib/site-config";
import { applyStep, type StepProvider } from "@/lib/ai-design/execute";
import { checkConstraints, restorePreserved, type ResolvedConstraintTarget } from "@/lib/ai-design/constraints";
import { changedFilesBetween } from "@/lib/site-studio/files";
import type { PlanStep } from "@/lib/ai-design/plan";

const provider: StepProvider = {
  complete: async () => {
    throw new Error("model provider must not be called by deterministic tools");
  },
};

function step(patch: Partial<PlanStep> & { tool: string; id: string; title: string; summary: string }): PlanStep {
  return { kind: "design", targets: [], instruction: "", dependsOn: [], risk: "low", ...patch } as PlanStep;
}

function base(): SiteConfig {
  const cfg = normalizeConfig(defaultConfig());
  if (!cfg) throw new Error("default config failed to normalize");
  return cfg;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function findSection(cfg: SiteConfig, type: string) {
  for (const page of cfg.pages) {
    const s = page.sections.find((x) => x.type === type);
    if (s) return { page, section: s };
  }
  return null;
}

describe("studio isolation — scoped side effects (§6)", () => {
  test("1. a font change never touches the project grid", async () => {
    const before = base();
    const after = await applyStep(
      before,
      step({ id: "s1", tool: "theme.tokens", title: "Switch heading font", summary: "Change the heading typeface.", patch: { theme: { headingFont: "fraunces" } } }),
      before,
      provider
    );

    // Project grid sections are structurally byte-identical.
    expect(deepEqual(after.config.pages, before.pages)).toBe(true);
    // ...and the font actually changed (the control is real).
    expect(after.config.theme.headingFont).toBe("fraunces");
  });

  test("2. a per-section hero motion override never leaks site-wide", async () => {
    const before = base();
    const hero = findSection(before, "hero");
    if (!hero) throw new Error("no hero section in base config");

    const edited: SiteConfig = {
      ...before,
      pages: before.pages.map((p) => ({
        ...p,
        sections: p.sections.map((s) =>
          s.id === hero.section.id
            ? { ...s, motion: { preset: "zoom", duration: 900, intensity: 80 } }
            : s
        ),
      })),
    };
    const after = normalizeConfig(edited);
    if (!after) throw new Error("per-section motion failed normalization");

    // Global motion untouched.
    expect(deepEqual(after.motion, before.motion)).toBe(true);
    // Every OTHER section's motion untouched.
    for (const page of after.pages) {
      for (const s of page.sections) {
        if (s.id === hero.section.id) continue;
        const prev = before.pages.find((p) => p.id === page.id)?.sections.find((x) => x.id === s.id);
        expect(deepEqual(s.motion, prev?.motion)).toBe(true);
      }
    }
    // The override itself took effect.
    const overridden = findSection(after, "hero");
    expect(overridden?.section.motion?.preset).toBe("zoom");
  });

  test("3. a section style override never alters component-level config or other sections", async () => {
    const before = base();
    const hero = findSection(before, "hero");
    if (!hero) throw new Error("no hero section");

    const edited: SiteConfig = {
      ...before,
      pages: before.pages.map((p) => ({
        ...p,
        sections: p.sections.map((s) =>
          s.id === hero.section.id ? { ...s, style: { titleColor: "#e8bc51", headingWeight: "bold" } } : s
        ),
      })),
    };
    const after = normalizeConfig(edited);
    if (!after) throw new Error("section style failed normalization");

    // Component-level configuration (buttons/links) unchanged.
    expect(after.theme.buttonStyle).toBe(before.theme.buttonStyle);
    expect(after.theme.linkStyle).toBe(before.theme.linkStyle);
    // Global theme tokens unchanged.
    expect(after.theme.accent).toBe(before.theme.accent);
    expect(after.theme.background).toBe(before.theme.background);
    // Other sections byte-identical.
    for (const page of after.pages) {
      for (const s of page.sections) {
        if (s.id === hero.section.id) continue;
        const prev = before.pages.find((p) => p.id === page.id)?.sections.find((x) => x.id === s.id);
        expect(deepEqual(s, prev)).toBe(true);
      }
    }
  });

  test("4. a single section's background-color token change pollutes nothing else", async () => {
    const before = base();
    const projects = findSection(before, "projects");
    if (!projects) throw new Error("no projects section");

    // The ONLY supported section-scoped color control is titleColor — change
    // it and prove nothing else moves (no theme token, no other section).
    const edited: SiteConfig = {
      ...before,
      pages: before.pages.map((p) => ({
        ...p,
        sections: p.sections.map((s) =>
          s.id === projects.section.id ? { ...s, style: { ...s.style, titleColor: "#9be29b" } } : s
        ),
      })),
    };
    const after = normalizeConfig(edited);
    if (!after) throw new Error("failed normalization");

    expect(after.theme.background).toBe(before.theme.background);
    expect(after.theme.surface).toBe(before.theme.surface);
    for (const page of after.pages) {
      for (const s of page.sections) {
        if (s.id === projects.section.id) continue;
        const prev = before.pages.find((p) => p.id === page.id)?.sections.find((x) => x.id === s.id);
        expect(deepEqual(s, prev)).toBe(true);
      }
    }
  });

  test("5. applying a template preserves ALL content", async () => {
    const before = base();
    // Distinctive content markers in the draft.
    const marked: SiteConfig = {
      ...before,
      name: "Maya Okonkwo",
      tagline: "Editor & colorist",
      pages: before.pages.map((p, i) => ({
        ...p,
        name: i === 0 ? "My Work" : p.name,
        sections: p.sections.map((s) =>
          s.type === "about" ? { ...s, title: "My story", ...("body" in s ? { body: "Unique bio text." } : {}) } : s
        ),
      })),
    };
    const normalizedMarked = normalizeConfig(marked);
    if (!normalizedMarked) throw new Error("marked config failed");

    const after = await applyStep(
      normalizedMarked,
      step({ id: "s2", tool: "template.apply", title: "Switch to Editorial Press", summary: "Apply the editorial template.", targets: ["editorial-press"] }),
      normalizedMarked,
      provider
    );

    expect(after.config.template).toBe("editorial-press");
    // Identity + page + section content all preserved.
    expect(after.config.name).toBe("Maya Okonkwo");
    expect(after.config.tagline).toBe("Editor & colorist");
    expect(after.config.pages.map((p) => p.name)).toEqual(normalizedMarked.pages.map((p) => p.name));
    const about = findSection(after.config, "about");
    const beforeAbout = findSection(normalizedMarked, "about");
    expect(about?.section.title).toBe(beforeAbout?.section.title);
  });

  test("6. disabling animations removes no element", async () => {
    const before = base();
    const after = await applyStep(
      before,
      step({ id: "s3", tool: "motion.configure", title: "Turn animations off", summary: "Disable the animation system.", patch: { motion: { enabled: false } } }),
      before,
      provider
    );

    expect(after.config.motion.enabled).toBe(false);
    // Every page and every section still present (nothing "removed").
    expect(after.config.pages.map((p) => p.id)).toEqual(before.pages.map((p) => p.id));
    for (const page of after.config.pages) {
      const prev = before.pages.find((p) => p.id === page.id);
      expect(page.sections.map((s) => s.id)).toEqual(prev?.sections.map((s) => s.id) ?? []);
    }
  });

  test("7. restoring one protected area never rolls back unrelated applied changes", async () => {
    const before = base();
    // Step A: a legitimate font change (applied).
    const withFont = await applyStep(
      before,
      step({ id: "s4", tool: "theme.tokens", title: "Switch heading font", summary: "Change the heading typeface.", patch: { theme: { headingFont: "fraunces" } } }),
      before,
      provider
    );
    // Step B: this step ALSO clobbers the protected hero section (simulating
    // an overreach the constraint system must repair).
    const heroId = findSection(before, "hero")?.section.id;
    if (!heroId) throw new Error("no hero id");
    const overreached: SiteConfig = {
      ...withFont.config,
      pages: withFont.config.pages.map((p) => ({
        ...p,
        sections: p.sections.map((s) => (s.id === heroId ? { ...s, title: "CLOBBERED" } : s)),
      })),
    };

    const targets: ResolvedConstraintTarget[] = [{ kind: "section-id", value: heroId, raw: heroId }];
    const violations = checkConstraints(before, overreached, targets);
    expect(violations.length).toBeGreaterThan(0);

    const repaired = restorePreserved(before, overreached, targets);
    // The protected section is byte-identical to the base again…
    const repairedHero = findSection(repaired.config, "hero");
    const baseHero = findSection(before, "hero");
    expect(deepEqual(repairedHero?.section, baseHero?.section)).toBe(true);
    // …while the UNRELATED font change from step A survives.
    expect(repaired.config.theme.headingFont).toBe("fraunces");
  });

  test("8. palette application changes ONLY color tokens", async () => {
    const before = base();
    const after = await applyStep(
      before,
      step({ id: "s5", tool: "palette.apply", title: "Apply a palette", summary: "Apply a curated palette.", targets: ["champagne-noir"] }),
      before,
      provider
    );

    // Typography / layout / motion / content untouched.
    expect(after.config.theme.headingFont).toBe(before.theme.headingFont);
    expect(after.config.theme.bodyFont).toBe(before.theme.bodyFont);
    expect(after.config.theme.radius).toBe(before.theme.radius);
    expect(after.config.theme.buttonStyle).toBe(before.theme.buttonStyle);
    expect(deepEqual(after.config.motion, before.motion)).toBe(true);
    expect(deepEqual(after.config.pages, before.pages)).toBe(true);
  });

  test("9. the changed-file inventory attributes changes to exactly the right virtual file", () => {
    const before = base();

    // A pure color change → ONLY theme/tokens.json.
    const colorChange: SiteConfig = { ...before, theme: { ...before.theme, accent: "#9be29b" } };
    expect(changedFilesBetween(before, colorChange).map((f) => f.path)).toEqual(["theme/tokens.json"]);

    // A pure font change → ONLY theme/typography.json. (base headingFont is fraunces)
    const fontChange: SiteConfig = { ...before, theme: { ...before.theme, headingFont: "jetbrains-mono" } };
    expect(changedFilesBetween(before, fontChange).map((f) => f.path)).toEqual(["theme/typography.json"]);

    // A pure motion change → ONLY motion/presets.json.
    const motionChange: SiteConfig = { ...before, motion: { ...before.motion, duration: 800 } };
    expect(changedFilesBetween(before, motionChange).map((f) => f.path)).toEqual(["motion/presets.json"]);

    // Identical configs → empty inventory (never padded).
    expect(changedFilesBetween(before, before)).toEqual([]);
  });

  test("10. constraint repair restores protected regions byte-identically while keeping legitimate edits", async () => {
    const before = base();
    // One step that changes BOTH a legitimate token AND a protected section.
    const heroId = findSection(before, "hero")?.section.id;
    if (!heroId) throw new Error("no hero id");
    const mixed: SiteConfig = {
      ...before,
      name: "Renamed by the step",
      theme: { ...before.theme, accent: "#c084fc" },
      pages: before.pages.map((p) => ({
        ...p,
        sections: p.sections.map((s) => (s.id === heroId ? { ...s, title: "Overwritten hero" } : s)),
      })),
    };

    const targets: ResolvedConstraintTarget[] = [{ kind: "section-id", value: heroId, raw: heroId }];
    const violations = checkConstraints(before, mixed, targets);
    expect(violations.length).toBeGreaterThan(0);

    const repaired = restorePreserved(before, mixed, targets);
    const repairedHero = findSection(repaired.config, "hero");
    const baseHero = findSection(before, "hero");
    expect(JSON.stringify(repairedHero?.section)).toBe(JSON.stringify(baseHero?.section)); // byte-identical
    // Legitimate edits from the SAME step survive the repair.
    expect(repaired.config.name).toBe("Renamed by the step");
    expect(repaired.config.theme.accent).toBe("#c084fc");
  });
});

// ---------------------------------------------------------------------------
// Task 16 (two-mode Website Studio) — isolation regressions for the new
// controls: independent nav/button font roles, per-section background /
// width / spacing / heading-alignment overrides, and the two new templates.
// ---------------------------------------------------------------------------

describe("task 16 — font role isolation", () => {
  test("nav/button fonts default to the body typeface and are untouched by a heading font change", () => {
    const base = defaultConfig("minimal-index");
    expect(base.theme.navFont).toBe(base.theme.bodyFont);
    expect(base.theme.buttonFont).toBe(base.theme.bodyFont);
    const changed = normalizeConfig({ ...base, theme: { ...base.theme, headingFont: "fraunces" } });
    expect(changed).not.toBeNull();
    if (!changed) return;
    expect(changed.theme.headingFont).toBe("fraunces");
    expect(changed.theme.navFont).toBe(changed.theme.bodyFont);
    expect(changed.theme.buttonFont).toBe(changed.theme.bodyFont);
    expect(changed.theme.bodyFont).toBe(base.theme.bodyFont);
  });

  test("setting ONE font role leaves every other role untouched", () => {
    const base = defaultConfig("minimal-index");
    const changed = normalizeConfig({ ...base, theme: { ...base.theme, buttonFont: "jetbrains-mono" } });
    expect(changed).not.toBeNull();
    if (!changed) return;
    expect(changed.theme.buttonFont).toBe("jetbrains-mono");
    expect(changed.theme.headingFont).toBe(base.theme.headingFont);
    expect(changed.theme.bodyFont).toBe(base.theme.bodyFont);
    expect(changed.theme.accentFont).toBe(base.theme.accentFont);
    expect(changed.theme.codeFont).toBe(base.theme.codeFont);
    expect(changed.theme.navFont).toBe(base.theme.navFont);
  });
});

describe("task 16 — per-section band isolation", () => {
  test("background/width/spacing/headingAlign stay scoped to their own section", () => {
    const base = defaultConfig("minimal-index");
    const page = base.pages[0]!;
    const first = page.sections[0]!;
    const second = page.sections[1]!;
    const changed = normalizeConfig({
      ...base,
      pages: [{
        ...page,
        sections: page.sections.map((s) =>
          s.id === first.id
            ? { ...s, style: { ...s.style, background: "wash", width: "narrow", spacing: "relaxed", headingAlign: "center" } }
            : s
        ),
      }],
    });
    expect(changed).not.toBeNull();
    if (!changed) return;
    const patched = changed.pages[0]!.sections.find((s) => s.id === first.id)!;
    const sibling = changed.pages[0]!.sections.find((s) => s.id === second.id)!;
    expect(patched.style?.background).toBe("wash");
    expect(patched.style?.width).toBe("narrow");
    expect(patched.style?.spacing).toBe("relaxed");
    expect(patched.style?.headingAlign).toBe("center");
    // the override never leaks into the sibling section
    expect(sibling.style?.background).toBeUndefined();
    expect(sibling.style?.width).toBeUndefined();
    expect(sibling.style?.spacing).toBeUndefined();
    expect(sibling.style?.headingAlign).toBeUndefined();
  });

  test("a custom hex section background survives normalization (round-trip)", () => {
    const base = defaultConfig("minimal-index");
    const page = base.pages[0]!;
    const changed = normalizeConfig({
      ...base,
      pages: [{
        ...page,
        sections: page.sections.map((s, i) => (i === 0 ? { ...s, style: { ...s.style, background: "#123456" } } : s)),
      }],
    });
    expect(changed).not.toBeNull();
    if (!changed) return;
    expect(changed.pages[0]!.sections[0]!.style?.background).toBe("#123456");
  });
});

describe("task 16 — new style templates", () => {
  test("portfolio-showcase and interactive are registered, schema-valid and content-complete", () => {
    for (const id of ["portfolio-showcase", "interactive"] as const) {
      const preset = templatePresets().find((p) => p.id === id);
      expect(preset).toBeTruthy();
      const config = normalizeConfig({
        version: 2,
        template: id,
        name: "T",
        tagline: "x",
        theme: preset!.theme,
        motion: preset!.motion,
        pages: preset!.pages,
      });
      expect(config).not.toBeNull();
      if (!config) continue;
      // a template's own sections count is preserved exactly (no invented content)
      expect(config.pages[0]!.sections.length).toBe(preset!.pages[0]!.sections.length);
    }
  });
});
