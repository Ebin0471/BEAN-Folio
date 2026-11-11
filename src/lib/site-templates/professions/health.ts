/**
 * BEAN Folio — profession template family: Health & Wellness (task 4-d).
 *
 * Five complete, genuinely distinct website presets for health-side
 * professions. Family rules:
 *  - PROFESSIONAL-PRACTICE PRESENTATION ONLY: no patient data, no clinical
 *    records, no testimonial sections that imply identifiable care, and no
 *    imagery slots that suggest case files — portfolios here show the
 *    practice (spaces, programs, credentials), never its patients
 *  - placeholder tokens only ({name} {tagline} {headline} {bio}
 *    {availability}); no invented clients, outcomes or credentials
 *  - accents are calm or warm (teal with green ≥ blue, sand, orange, olive,
 *    russet) — never blue-dominant; structural signatures are mutually unique
 *
 * Ids are registered in TEMPLATE_IDS (site-config.ts) by the template-library
 * aggregator; the single PresetDraft→TemplatePreset narrowing lives at the
 * bottom of this file.
 */
import { makeSection } from "../../site-config";
import type { TemplatePreset, SiteSection } from "../../site-config";

function tpl(type: Parameters<typeof makeSection>[0], overrides: Record<string, unknown> = {}): SiteSection {
  return { ...makeSection(type), ...overrides } as SiteSection;
}

/** TemplatePreset with the id widened to string until TEMPLATE_IDS registers it. */
type PresetDraft = Omit<TemplatePreset, "id"> & { id: string };

let draftsCache: PresetDraft[] | null = null;

// Built lazily (never at module init): this module participates in a circular
// import with site-config.ts, whose section factory must finish initializing
// before makeSection()/tpl() run.
function buildDrafts(): PresetDraft[] {
  if (draftsCache) return draftsCache;
  draftsCache = [
  // ------------------------------------------------ 8. doctor-clinic
  {
    id: "doctor-clinic",
    label: "Doctor Clinic",
    description: "Clinical white with calm teal — a split-hello, the practice, consultation areas, credentials and appointments.",
    professions: ["doctor", "dentist", "pharmacist"],
    theme: {
      background: "#fbfdfc", foreground: "#17302b", accent: "#0f766e",
      surface: "#ffffff", border: "#dce7e3", muted: "#6d7f79",
      font: "public-sans", headingFont: "public-sans", bodyFont: "public-sans",
      radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal",
      letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular",
      columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "1/1",
      divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
    },
    motion: { preset: "calm-float", duration: 500 },
    pages: [{ id: "home", name: "Home", visible: true, sections: [
      tpl("hero", { title: "{name}", subtitle: "{tagline} — {location}", variant: "split", ctaLabel: "Request an appointment" }),
      tpl("about", { title: "The practice", body: "{bio}" }),
      tpl("services", { title: "Consultation areas", layout: "cards" }),
      tpl("experience", { title: "Credentials & roles", layout: "timeline" }),
      tpl("contact", { title: "Appointments", body: "{availability}" }),
    ]}],
  },

  // ------------------------------------------------ 9. nurse-care
  {
    id: "nurse-care",
    label: "Nurse Care",
    description: "Soft sage and warm sand — a centered welcome, career journey in rows and cards describing day-to-day support.",
    professions: ["nurse", "occupational-therapist"],
    theme: {
      background: "#f4f6f1", foreground: "#2c3229", accent: "#b0895c",
      surface: "#fbfcf8", border: "#dfe3d7", muted: "#79806f",
      font: "lora", headingFont: "lora", bodyFont: "karla",
      radius: "full", density: "relaxed", typeScale: "intimate", lineHeight: "relaxed",
      letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow",
      columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "3/2",
      divider: "none", pageTransition: "fade", navLayout: "centered", headingAlign: "center",
    },
    motion: { preset: "gentle-appear", duration: 500 },
    pages: [{ id: "home", name: "Home", visible: true, sections: [
      tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered" }),
      tpl("about", { title: "About my practice", body: "{bio}" }),
      tpl("experience", { title: "Where I've worked", layout: "rows" }),
      tpl("services", { title: "How I support", layout: "cards" }),
      tpl("contact", { title: "Get in touch", body: "{availability}" }),
    ]}],
  },

  // ------------------------------------------------ 10. physio-motion
  {
    id: "physio-motion",
    label: "Physio Motion",
    description: "Energetic light with vivid orange — a cover hero, program cards, transformation stories and a method kit.",
    professions: ["physiotherapist", "fitness-trainer"],
    theme: {
      background: "#fdfaf5", foreground: "#241d16", accent: "#e05a1e",
      surface: "#ffffff", border: "#eee0d2", muted: "#877a6c",
      font: "montserrat", headingFont: "montserrat", bodyFont: "work-sans",
      radius: "md", density: "compact", typeScale: "balanced", lineHeight: "normal",
      letterSpacing: "normal", headingWeight: "bold", contentWidth: "regular",
      columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "16/9",
      divider: "accent", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
    },
    motion: { preset: "pop", duration: 400 },
    pages: [{ id: "home", name: "Home", visible: true, sections: [
      tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "cover", ctaLabel: "Book a session" }),
      tpl("services", { title: "Programs", layout: "cards" }),
      // sample sections — add your own client work with consent
      tpl("projects", { title: "Client transformations", limit: 6, layout: "grid" }),
      tpl("skills", { title: "Methods & equipment" }),
      tpl("contact", { title: "Get started", body: "{availability}" }),
    ]}],
  },

  // ------------------------------------------------ 11. dietitian-plate
  {
    id: "dietitian-plate",
    label: "Dietitian Plate",
    description: "Fresh linen with olive warmth — program rows up front, featured nutrition programs, then the philosophy.",
    professions: ["dietitian", "wellness-practitioner"],
    theme: {
      background: "#f9faf1", foreground: "#252a1d", accent: "#6b7c3a",
      surface: "#fdfef8", border: "#e2e6d2", muted: "#79816a",
      font: "figtree", headingFont: "figtree", bodyFont: "figtree",
      radius: "md", density: "relaxed", typeScale: "balanced", lineHeight: "normal",
      letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular",
      columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "3/2",
      divider: "none", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
    },
    motion: { preset: "fade-up-soft", duration: 480 },
    pages: [{ id: "home", name: "Home", visible: true, sections: [
      tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "split" }),
      tpl("services", { title: "Programs", layout: "rows" }),
      tpl("projects", { title: "Nutrition programs", limit: 4, layout: "featured" }),
      tpl("about", { title: "Philosophy", body: "{bio}" }),
      tpl("contact", { title: "Say hello", body: "{availability}" }),
    ]}],
  },

  // ------------------------------------------------ 12. therapy-practice
  // (No veterinarian slug exists in the taxonomy — verified — so the fifth
  // slot presents a talk-therapy practice instead: counselor + psychologist,
  // split away from nurse-care which covers nurse + occupational-therapist.)
  {
    id: "therapy-practice",
    label: "Therapy Practice",
    description: "Warm light and russet — a quiet classic welcome, the practice, ways of working and the room itself.",
    professions: ["counselor", "psychologist"],
    theme: {
      background: "#f8f2ea", foreground: "#2f241c", accent: "#9c5230",
      surface: "#fdfaf4", border: "#e7dac8", muted: "#8b7a68",
      font: "source-serif-4", headingFont: "source-serif-4", bodyFont: "source-sans-3",
      radius: "md", density: "relaxed", typeScale: "balanced", lineHeight: "relaxed",
      letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow",
      columns: 0, buttonStyle: "outline", linkStyle: "underline", imageRatio: "3/2",
      divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
    },
    motion: { preset: "subtle-fade", duration: 500 },
    pages: [{ id: "home", name: "Home", visible: true, sections: [
      tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "classic" }),
      tpl("about", { title: "A bit about the practice", body: "{bio}" }),
      tpl("services", { title: "Ways of working", layout: "rows" }),
      // the room and materials only — never client imagery
      tpl("gallery", { title: "Inside the practice", source: "projects", limit: 6, layout: "grid" }),
      tpl("contact", { title: "Book an intro call", body: "{availability}" }),
    ]}],
  },
  ];
  return draftsCache;
}

export function healthTemplates(): TemplatePreset[] {
  return buildDrafts() as TemplatePreset[];
}
