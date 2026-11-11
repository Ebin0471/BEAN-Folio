/**
 * BEAN Folio — Education & Academia template family (task 4-e).
 *
 * Four REAL, mutually distinct website templates for teaching and research
 * professions. Every entry is a complete design: theme tokens, motion, and a
 * full page plan whose sections render through the standard SiteRenderer.
 *
 * Design rules honored here:
 *  - placeholder tokens only ({name} {tagline} {headline} {bio} {availability})
 *    — no invented institutions, students, or credentials
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
  // ---------------------------------------------------------------- 1
  {
    id: "teacher-classroom",
    label: "Teacher Classroom",
    description: "Chalkboard-and-chalk classroom home for teaching projects, offerings, and family notes.",
    professions: ["teacher", "tutor", "instructional-designer", "curriculum-developer", "education-consultant"],
    theme: {
      background: "#1e3528", // chalkboard green-dark
      foreground: "#f2efe3",
      accent: "#f0dfae", // chalk cream
      accent2: "#b5793a", // cork board
      surface: "#264434",
      border: "#3c5a4a",
      muted: "#a9b8a8",
      focus: "#f0dfae",
      font: "neuton",
      headingFont: "neuton",
      bodyFont: "karla",
      radius: "md",
      density: "regular",
      typeScale: "balanced",
      lineHeight: "relaxed",
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
    motion: { preset: "gentle-appear", duration: 480 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline} — {location}", variant: "centered", ctaLabel: "Plan a lesson" }),
        tpl("about", { title: "About my classroom", body: "{bio}" }),
        tpl("projects", { title: "Teaching projects", limit: 6, layout: "featured" }),
        tpl("services", { title: "What I offer", layout: "rows", items: [] }),
        tpl("testimonials", { title: "Student & parent notes", layout: "cards", items: [] }),
        tpl("contact", { title: "Get in touch", body: "{availability}" }),
      ],
    }],
  },

  // ---------------------------------------------------------------- 2
  {
    id: "professor-lecture",
    label: "Professor Lecture",
    description: "Oxblood-on-parchment academic site for publications, appointments, and teaching areas.",
    professions: ["professor", "academic"],
    theme: {
      background: "#f4eddd", // parchment
      foreground: "#2b211b",
      accent: "#6e2027", // university oxblood
      accent2: "#8a6b3f",
      surface: "#fdf9ef",
      border: "#ddcfb6",
      muted: "#7f7263",
      focus: "#6e2027",
      font: "libre-baskerville",
      headingFont: "libre-baskerville",
      bodyFont: "newsreader",
      radius: "md",
      density: "regular",
      typeScale: "grand",
      lineHeight: "normal",
      letterSpacing: "wide",
      headingWeight: "semibold",
      contentWidth: "narrow",
      columns: 0,
      buttonStyle: "rounded",
      linkStyle: "underline",
      imageRatio: "3/2",
      divider: "line",
      pageTransition: "fade",
      navLayout: "stacked",
      headingAlign: "left",
    },
    motion: { preset: "serif-rise", duration: 550 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline} — {location}", variant: "classic" }),
        tpl("projects", { title: "Publications & talks", limit: 8, layout: "editorial" }),
        tpl("experience", { title: "Appointments", layout: "timeline", entries: [] }),
        tpl("skills", { title: "Research & teaching areas" }),
        tpl("contact", { title: "Correspondence", body: "{availability}" }),
      ],
    }],
  },

  // ---------------------------------------------------------------- 3
  {
    id: "scholar-thesis",
    label: "Scholar Thesis",
    description: "Quiet paper-and-ink thesis page listing preprints, research figures, and academic history.",
    professions: ["phd-scholar", "researcher", "lab-scientist"],
    theme: {
      background: "#faf8f3", // quiet paper
      foreground: "#201d26", // ink
      accent: "#7a2432", // burgundy
      accent2: "#55505e",
      surface: "#ffffff",
      border: "#e3dfd6",
      muted: "#7b766d",
      focus: "#7a2432",
      font: "crimson-pro",
      headingFont: "crimson-pro",
      bodyFont: "crimson-pro",
      radius: "none",
      density: "regular",
      typeScale: "intimate",
      lineHeight: "relaxed",
      letterSpacing: "normal",
      headingWeight: "light",
      contentWidth: "narrow",
      columns: 0,
      buttonStyle: "sharp",
      linkStyle: "underline",
      imageRatio: "3/2",
      divider: "line",
      pageTransition: "none",
      navLayout: "centered",
      headingAlign: "left",
    },
    motion: { preset: "fade-up-soft", duration: 450 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "classic" }),
        tpl("projects", { title: "Papers & preprints", limit: 12, layout: "list" }),
        tpl("stats", { title: "Research at a glance" }),
        tpl("experience", { title: "Academic history", layout: "rows", entries: [] }),
        tpl("contact", { title: "Contact", body: "{availability}" }),
      ],
    }],
  },

  // ---------------------------------------------------------------- 4
  {
    id: "student-launch",
    label: "Student Launchpad",
    description: "Bright, optimistic starter site for coursework projects, growing skills, and first outreach.",
    professions: ["student", "fresher", "intern"],
    theme: {
      background: "#fffdf4", // optimistic light
      foreground: "#2b2a24",
      accent: "#e2a52c", // sunflower
      accent2: "#6f9c5d",
      surface: "#fff6dd",
      border: "#eee3c4",
      muted: "#918a72",
      focus: "#e2a52c",
      font: "jost",
      headingFont: "jost",
      bodyFont: "jost",
      radius: "md",
      density: "regular",
      typeScale: "balanced",
      lineHeight: "normal",
      letterSpacing: "normal",
      headingWeight: "bold",
      contentWidth: "regular",
      columns: 0,
      buttonStyle: "pill",
      linkStyle: "accent",
      imageRatio: "4/3",
      divider: "line",
      pageTransition: "slide",
      navLayout: "centered",
      headingAlign: "center",
    },
    motion: { preset: "crisp-pop", duration: 420 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "Hi, I'm {name}", subtitle: "{tagline}", variant: "centered", ctaLabel: "Say hello" }),
        tpl("about", { title: "About me", body: "{bio}" }),
        tpl("projects", { title: "Course & personal projects", limit: 6, layout: "grid" }),
        tpl("skills", { title: "Tools I'm learning" }),
        tpl("contact", { title: "Let's connect", body: "{availability}" }),
      ],
    }],
  },
  ];
  return templatesCache;
}

export function educationTemplates(): TemplatePreset[] {
  return buildTemplates() as TemplatePreset[];
}
