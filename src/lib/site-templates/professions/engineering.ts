/**
 * BEAN Folio — profession template family: ENGINEERING DISCIPLINES (3 presets).
 *
 * Real, complete-website designs for built-world and hardware engineers:
 * civil/structural/surveying, mechanical/biomedical/chemical, and electronics/
 * electrical bench work. Each entry is a full token set (theme + motion +
 * page structure) — never a single font/color/animation preset.
 *
 * Structure lives here (not in site-config.ts) so the template registry stays
 * a factory call: ids are registered in TEMPLATE_IDS by the site-config
 * integrator, which also spreads these factories into templatePresets().
 */

import { makeSection } from "../../site-config";
import type { TemplatePreset, SiteSection } from "../../site-config";

function tpl(type: Parameters<typeof makeSection>[0], overrides: Record<string, unknown> = {}): SiteSection {
  return { ...makeSection(type), ...overrides } as SiteSection;
}

/**
 * TemplatePreset with the id widened to string. Every other field (theme
 * tokens, motion, pages/sections) is still fully type-checked; the id itself
 * is validated by scripts/tmp/check-sigs-t2.ts at authoring time and becomes
 * a TemplateId member once registered in site-config.ts.
 */
type PresetDraft = Omit<TemplatePreset, "id"> & { id: string };

export function engineeringTemplates(): TemplatePreset[] {
  const entries: PresetDraft[] = [
    // 12. civil-works
    {
      id: "civil-works",
      label: "Civil Works",
      description: "Concrete-light drawing office with safety-amber markup — built works full-bleed, deliveries on a timeline.",
      professions: ["civil-engineer", "structural-engineer", "surveyor"],
      theme: {
        background: "#eeeeea", foreground: "#262622", accent: "#d68f1f",
        surface: "#f8f8f5", border: "#dcdcd4", muted: "#7a7970",
        font: "archivo", headingFont: "archivo", bodyFont: "archivo",
        radius: "none", density: "regular", typeScale: "grand",
        lineHeight: "normal", letterSpacing: "wide", headingWeight: "bold",
        contentWidth: "wide", columns: 0,
        buttonStyle: "sharp", linkStyle: "underline", imageRatio: "3/2",
        divider: "line", pageTransition: "none", navLayout: "stacked", headingAlign: "left",
      },
      motion: { preset: "steady-fade-up", duration: 500 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "cover" }),
        tpl("projects", { title: "Built works", limit: 5, layout: "featured" }),
        tpl("experience", { title: "Projects delivered", layout: "timeline" }),
        tpl("skills", { title: "Capabilities" }),
        tpl("contact", { title: "Contact", body: "Available for engineering consultations. {availability}" }),
      ]}],
    },

    // 13. mechanical-forge
    {
      id: "mechanical-forge",
      label: "Mechanical Forge",
      description: "Steel-grey shop floor with copper fittings — design projects on a drafting grid, specifications in rows.",
      professions: ["mechanical-engineer", "biomedical-engineer", "chemical-engineer"],
      theme: {
        background: "#22262a", foreground: "#edeff1", accent: "#c8804a",
        surface: "#2b3036", border: "#3d444c", muted: "#9aa2aa",
        font: "hanken-grotesk", headingFont: "hanken-grotesk", bodyFont: "geist-sans",
        radius: "md", density: "regular", typeScale: "balanced",
        lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold",
        contentWidth: "regular", columns: 2,
        buttonStyle: "rounded", linkStyle: "accent", imageRatio: "4/3",
        divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "stagger-scale", duration: 420 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "split" }),
        tpl("projects", { title: "Design projects", limit: 6, layout: "grid" }),
        tpl("skills", { title: "Tools & standards" }),
        tpl("experience", { title: "Experience", layout: "rows" }),
        tpl("contact", { title: "Contact", body: "Open to design and manufacturing work. {availability}" }),
      ]}],
    },

    // 14. electronics-bench
    {
      id: "electronics-bench",
      label: "Electronics Bench",
      description: "Dark solder-mask board with a green trace accent — builds and circuits up top, bench photos in a square grid.",
      professions: ["electronics-engineer", "electrical-engineer"],
      theme: {
        background: "#101512", foreground: "#e7ede7", accent: "#43a05e",
        surface: "#161d18", border: "#27312a", muted: "#8ca291",
        font: "space-mono", headingFont: "space-mono", bodyFont: "geist-sans",
        radius: "none", density: "compact", typeScale: "balanced",
        lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold",
        contentWidth: "regular", columns: 2,
        buttonStyle: "rounded", linkStyle: "accent", imageRatio: "1/1",
        divider: "accent", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "cascade", duration: 420 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "classic" }),
        tpl("projects", { title: "Builds & circuits", limit: 6, layout: "grid" }),
        tpl("gallery", { title: "Bench photos", source: "projects", limit: 6, layout: "grid" }),
        tpl("skills", { title: "Bench & tools" }),
        tpl("contact", { title: "Contact", body: "Available for electronics work. {availability}" }),
      ]}],
    },
  ];

  // ids are plain strings here; registered as TemplateId members by the
  // site-config integrator. Shape was fully checked as PresetDraft above.
  return entries as TemplatePreset[];
}
