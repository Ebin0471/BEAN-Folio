/**
 * BEAN Folio — Science, Environment & Agriculture template family (task 4-e).
 *
 * Three REAL, mutually distinct website templates for lab, field, and land
 * professions. Every entry is a complete design: theme tokens, motion, and a
 * full page plan whose sections render through the standard SiteRenderer.
 *
 * Design rules honored here:
 *  - placeholder tokens only ({name} {tagline} {headline} {bio} {availability})
 *    — no invented studies, sites, yields, or findings
 *  - every profession slug is verbatim from src/lib/professions/taxonomy.ts
 *  - accents are never bluish (brand rule) and all font ids exist in
 *    lib/site-fonts.ts; all motion ids exist in lib/site-motion.ts
 *
 * NOTE on `id`: TemplatePreset.id is the closed TemplateId union registered in
 * site-config.ts. The ids below are registered there by the aggregator task;
 * this module stays decoupled and widens the id via a single documented cast
 * at the factory boundary.
 */
import { makeSection } from "../../site-config";
import type { TemplatePreset, SiteSection } from "../../site-config";

function tpl(type: Parameters<typeof makeSection>[0], overrides: Record<string, unknown> = {}): SiteSection {
  return { ...makeSection(type), ...overrides } as SiteSection;
}

/** TemplatePreset with the id widened to string (registered centrally later). */
type PresetSeed = Omit<TemplatePreset, "id"> & { id: string };

let templatesCache: PresetSeed[] | null = null;

// Built lazily (never at module init): this module participates in a circular
// import with site-config.ts, whose section factory must finish initializing
// before makeSection()/tpl() run.
function buildTemplates(): PresetSeed[] {
  if (templatesCache) return templatesCache;
  templatesCache = [
  // ---------------------------------------------------------------- 5
  {
    id: "scientist-lab",
    label: "Scientist Lab",
    description: "Lab-white field-science site pairing studies and stats with photographs from the field.",
    professions: ["scientist", "marine-biologist", "geologist", "ecologist", "field-researcher"],
    theme: {
      background: "#f6faf7", // lab white
      foreground: "#17231d",
      accent: "#2f8a67", // seafoam green
      accent2: "#6d8a70",
      surface: "#ffffff",
      border: "#dce6de",
      muted: "#6f8078",
      focus: "#2f8a67",
      font: "source-serif-4",
      headingFont: "source-serif-4",
      bodyFont: "geist-sans",
      radius: "md",
      density: "regular",
      typeScale: "balanced",
      lineHeight: "normal",
      letterSpacing: "normal",
      headingWeight: "semibold",
      contentWidth: "regular",
      columns: 0,
      buttonStyle: "rounded",
      linkStyle: "accent",
      imageRatio: "4/3",
      divider: "line",
      pageTransition: "fade",
      navLayout: "inline",
      headingAlign: "left",
    },
    motion: { preset: "steady-fade-up", duration: 480 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline} — {location}", variant: "split" }),
        tpl("projects", { title: "Studies & fieldwork", limit: 8, layout: "editorial" }),
        tpl("gallery", { title: "From the field", source: "projects", limit: 8, layout: "grid" }),
        tpl("stats", { title: "At a glance" }),
        tpl("contact", { title: "Collaborate", body: "{availability}" }),
      ],
    }],
  },

  // ---------------------------------------------------------------- 6
  {
    id: "eco-field",
    label: "Eco Field Notes",
    description: "Moss-and-soil conservation portfolio with consulting services and a field-season timeline.",
    professions: ["environmental-scientist", "conservationist", "sustainability-consultant"],
    theme: {
      background: "#22301d", // forest moss
      foreground: "#efeee1",
      accent: "#ab7440", // soil
      accent2: "#7d9464", // moss green
      surface: "#2c3f26",
      border: "#475a40",
      muted: "#a6b096",
      focus: "#ab7440",
      font: "schibsted-grotesk",
      headingFont: "schibsted-grotesk",
      bodyFont: "schibsted-grotesk",
      radius: "md",
      density: "relaxed",
      typeScale: "balanced",
      lineHeight: "relaxed",
      letterSpacing: "normal",
      headingWeight: "semibold",
      contentWidth: "wide",
      columns: 0,
      buttonStyle: "rounded",
      linkStyle: "underline",
      imageRatio: "16/9",
      divider: "none",
      pageTransition: "fade",
      navLayout: "inline",
      headingAlign: "left",
    },
    motion: { preset: "media-ken-burns", duration: 700 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline} — {location}", variant: "cover", ctaLabel: "See the work" }),
        tpl("projects", { title: "Conservation work", limit: 4, layout: "featured" }),
        tpl("services", { title: "Consulting", layout: "rows", items: [] }),
        tpl("experience", { title: "Field seasons", layout: "timeline", entries: [] }),
        tpl("contact", { title: "Work together", body: "{availability}" }),
      ],
    }],
  },

  // ---------------------------------------------------------------- 7
  {
    id: "agro-harvest",
    label: "Agro Harvest",
    description: "Wheat-and-terracotta agronomy journal of trial plots, a harvest gallery, and farm notes.",
    professions: ["agronomist", "agricultural-researcher", "farmer"],
    theme: {
      background: "#f5eeda", // harvest wheat
      foreground: "#34301f",
      accent: "#b25b2c", // terracotta
      accent2: "#8f8745", // wheat olive
      surface: "#fdf8ea",
      border: "#e2d6b8",
      muted: "#8b8266",
      focus: "#b25b2c",
      font: "archivo",
      headingFont: "archivo",
      bodyFont: "archivo",
      radius: "md",
      density: "regular",
      typeScale: "balanced",
      lineHeight: "normal",
      letterSpacing: "normal",
      headingWeight: "semibold",
      contentWidth: "regular",
      columns: 0,
      buttonStyle: "rounded",
      linkStyle: "accent",
      imageRatio: "3/2",
      divider: "accent",
      pageTransition: "none",
      navLayout: "inline",
      headingAlign: "left",
    },
    motion: { preset: "calm-float", duration: 520 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline} — {location}", variant: "classic" }),
        tpl("projects", { title: "Seasons & trials", limit: 9, layout: "grid" }),
        tpl("gallery", { title: "Harvest gallery", source: "projects", limit: 12, layout: "masonry" }),
        tpl("about", { title: "About the farm", body: "{bio}" }),
        tpl("contact", { title: "Visit or write", body: "{availability}" }),
      ],
    }],
  },
  ];
  return templatesCache;
}

export function scienceTemplates(): TemplatePreset[] {
  return buildTemplates() as TemplatePreset[];
}
