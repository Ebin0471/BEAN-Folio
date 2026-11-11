/**
 * BEAN Folio — profession template family: Business & Finance (task 4-d).
 *
 * Seven complete, genuinely distinct website presets for business-side
 * professions. Family rules:
 *  - placeholder tokens only ({name} {tagline} {headline} {bio} {availability});
 *    no invented clients, fees, results or credentials anywhere
 *  - accents are warm/neutral (ivory/bronze, brick, ledger green, forest,
 *    oxblood, gold-rose, persimmon) — never blue-dominant
 *  - structural signatures (ordered section chain + layout tokens) are
 *    mutually unique and deliberately steer clear of the corporate-ledger /
 *    growth-consult / corner-office families already in site-config.ts
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
  // ------------------------------------------------ 1. consultant-suite
  {
    id: "consultant-suite",
    label: "Consultant Suite",
    description: "Ivory and bronze advisory suite — services up front, featured engagements, a timeline and client references.",
    professions: ["consultant", "business-strategist", "coach"],
    theme: {
      background: "#faf8f4", foreground: "#1c1a16", accent: "#8c6d3f",
      surface: "#f1ede5", border: "#ddd6c8", muted: "#8a8478",
      font: "libre-baskerville", headingFont: "libre-baskerville", bodyFont: "public-sans",
      radius: "md", density: "relaxed", typeScale: "balanced", lineHeight: "normal",
      letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular",
      columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "3/2",
      divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
    },
    motion: { preset: "executive-fade", duration: 450 },
    pages: [{ id: "home", name: "Home", visible: true, sections: [
      tpl("hero", { title: "{name}", subtitle: "{headline} — {location}", variant: "split", ctaLabel: "Book an intro call" }),
      tpl("services", { title: "How I help", layout: "cards" }),
      tpl("projects", { title: "Selected engagements", limit: 4, layout: "featured" }),
      tpl("experience", { title: "Career path", layout: "timeline" }),
      tpl("testimonials", { title: "References", layout: "cards" }),
      tpl("contact", { title: "Get in touch", body: "{availability}" }),
    ]}],
  },

  // ------------------------------------------------ 2. founder-ventures
  {
    id: "founder-ventures",
    label: "Founder Ventures",
    description: "Bold paper with a brick-red voice — a centered manifesto, the story first, then ventures and milestones.",
    professions: ["founder", "entrepreneur"],
    theme: {
      background: "#faf1e6", foreground: "#221a14", accent: "#b3402a",
      surface: "#fffaf3", border: "#ecdccb", muted: "#8c7a68",
      font: "bricolage-grotesque", headingFont: "bricolage-grotesque", bodyFont: "inter",
      radius: "md", density: "regular", typeScale: "grand", lineHeight: "tight",
      letterSpacing: "normal", headingWeight: "bold", contentWidth: "regular",
      columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "3/2",
      divider: "none", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
    },
    motion: { preset: "editorial-stagger", duration: 500 },
    pages: [{ id: "home", name: "Home", visible: true, sections: [
      tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "centered", ctaLabel: "Read the story" }),
      tpl("about", { title: "Why I build", body: "{bio}" }),
      tpl("projects", { title: "Ventures", limit: 6, layout: "editorial" }),
      tpl("stats", { title: "Milestones" }),
      tpl("contact", { title: "Say hello", body: "{availability}" }),
    ]}],
  },

  // ------------------------------------------------ 3. finance-ledger
  {
    id: "finance-ledger",
    label: "Finance Ledger",
    description: "A ledger-light practice page in deep green — ruled rows for practice areas, a career record and advisory work.",
    professions: ["financial-professional", "accountant"],
    theme: {
      background: "#f6f7f3", foreground: "#1e251f", accent: "#1f5c3d",
      surface: "#fcfdfb", border: "#dbe0d6", muted: "#6e776e",
      font: "ibm-plex-sans", headingFont: "ibm-plex-sans", bodyFont: "ibm-plex-sans",
      radius: "none", density: "regular", typeScale: "balanced", lineHeight: "normal",
      letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular",
      columns: 0, buttonStyle: "rounded", linkStyle: "underline", imageRatio: "3/2",
      divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
    },
    motion: { preset: "steady-fade-up", duration: 450 },
    pages: [{ id: "home", name: "Home", visible: true, sections: [
      tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "classic" }),
      tpl("services", { title: "Practice areas", layout: "rows" }),
      tpl("experience", { title: "Career record", layout: "timeline" }),
      tpl("projects", { title: "Advisory work", limit: 6, layout: "list" }),
      tpl("contact", { title: "Contact", body: "{availability}" }),
    ]}],
  },

  // ------------------------------------------------ 4. realestate-listing
  {
    id: "realestate-listing",
    label: "Estate Listing",
    description: "Estate cream with forest accents under a full-bleed cover — featured listings, a property gallery and services.",
    professions: ["real-estate-professional"],
    theme: {
      background: "#f7f3ea", foreground: "#2a2620", accent: "#34543f",
      surface: "#fdfbf5", border: "#e0d8c6", muted: "#847b68",
      font: "marcellus", headingFont: "marcellus", bodyFont: "public-sans",
      radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal",
      letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular",
      columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "4/3",
      divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
    },
    motion: { preset: "gallery-reveal", duration: 500 },
    pages: [{ id: "home", name: "Home", visible: true, sections: [
      tpl("hero", { title: "{name}", subtitle: "{tagline} — {location}", variant: "cover", ctaLabel: "View listings" }),
      tpl("projects", { title: "Listings & sales", limit: 6, layout: "featured" }),
      tpl("gallery", { title: "Property gallery", source: "projects", limit: 8, layout: "grid" }),
      tpl("services", { title: "Buying & selling support", layout: "rows" }),
      tpl("contact", { title: "Enquire", body: "{availability}" }),
    ]}],
  },

  // ------------------------------------------------ 5. legal-chambers
  {
    id: "legal-chambers",
    label: "Legal Chambers",
    description: "Parchment and oxblood chambers — serif practice areas, a chambers record and a quiet docket of case work.",
    professions: ["legal-professional"],
    theme: {
      background: "#f5efe3", foreground: "#2b1d1a", accent: "#722f37",
      surface: "#fbf7ec", border: "#e0d5bd", muted: "#8a7a68",
      font: "cormorant-garamond", headingFont: "cormorant-garamond", bodyFont: "eb-garamond",
      radius: "none", density: "compact", typeScale: "balanced", lineHeight: "normal",
      letterSpacing: "normal", headingWeight: "semibold", contentWidth: "narrow",
      columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "1/1",
      divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
    },
    motion: { preset: "subtle-rise", duration: 450 },
    pages: [{ id: "home", name: "Home", visible: true, sections: [
      tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "classic" }),
      tpl("services", { title: "Areas of practice", layout: "rows" }),
      tpl("experience", { title: "Chambers record", layout: "timeline" }),
      tpl("projects", { title: "Case work", limit: 6, layout: "list" }),
      tpl("contact", { title: "Enquiries", body: "{availability}" }),
    ]}],
  },

  // ------------------------------------------------ 6. event-atelier
  {
    id: "event-atelier",
    label: "Event Atelier",
    description: "Celebration ivory with gold-rose light — a cover opening onto a masonry wall of events, services and collections.",
    professions: ["event-planner"],
    theme: {
      background: "#fbf5ee", foreground: "#2e2118", accent: "#c2825c",
      surface: "#fffaf4", border: "#eeddc8", muted: "#96826c",
      font: "josefin-sans", headingFont: "josefin-sans", bodyFont: "nunito-sans",
      radius: "full", density: "regular", typeScale: "balanced", lineHeight: "normal",
      letterSpacing: "wide", headingWeight: "semibold", contentWidth: "regular",
      columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "4/3",
      divider: "none", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
    },
    motion: { preset: "stagger", duration: 450 },
    pages: [{ id: "home", name: "Home", visible: true, sections: [
      tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "cover" }),
      tpl("gallery", { title: "Events produced", source: "projects", limit: 12, layout: "masonry" }),
      tpl("services", { title: "Ways we help you celebrate", layout: "cards" }),
      tpl("collections", { title: "Signature collections", limit: 3 }),
      tpl("contact", { title: "Start planning", body: "{availability}" }),
    ]}],
  },

  // ------------------------------------------------ 7. marketer-funnel
  {
    id: "marketer-funnel",
    label: "Marketer Funnel",
    description: "Daylight white with persimmon punch — campaigns first, a highlights strip and capability rows for funnel work.",
    professions: ["marketer", "digital-marketer", "sales-professional", "recruiter"],
    theme: {
      background: "#fdfcf8", foreground: "#241d18", accent: "#e2622f",
      surface: "#ffffff", border: "#ecdfd2", muted: "#8a7c6e",
      font: "poppins", headingFont: "poppins", bodyFont: "inter",
      radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal",
      letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular",
      columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "16/9",
      divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
    },
    motion: { preset: "crisp-pop", duration: 400 },
    pages: [{ id: "home", name: "Home", visible: true, sections: [
      tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "split", ctaLabel: "See the work" }),
      tpl("projects", { title: "Campaigns", limit: 6, layout: "featured" }),
      tpl("stats", { title: "Highlights" }),
      tpl("services", { title: "Capabilities", layout: "rows" }),
      tpl("contact", { title: "Let's talk", body: "{availability}" }),
    ]}],
  },
  ];
  return draftsCache;
}

export function businessTemplates(): TemplatePreset[] {
  return buildDrafts() as TemplatePreset[];
}
