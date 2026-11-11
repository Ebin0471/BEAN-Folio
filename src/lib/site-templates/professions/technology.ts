/**
 * BEAN Folio — profession template family: TECHNOLOGY PROFESSIONS (11 presets).
 *
 * Real, complete-website designs for builders: frontend, backend, mobile,
 * games, AI/ML, data, security, infrastructure, product, and research.
 * Each entry is a full token set (theme + motion + page structure) — never a
 * single font/color/animation preset.
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

export function technologyTemplates(): TemplatePreset[] {
  const entries: PresetDraft[] = [
    // 1. frontend-craft
    {
      id: "frontend-craft",
      label: "Frontend Craft",
      description: "Warm dark workshop with peach highlights — interfaces, components and shipped UI work up front.",
      professions: ["frontend-dev"],
      theme: {
        background: "#171310", foreground: "#f5ede3", accent: "#f2a56b",
        surface: "#211a15", border: "#362b21", muted: "#a99a8a",
        font: "geist-sans", headingFont: "space-grotesk", bodyFont: "geist-sans",
        radius: "md", density: "regular", typeScale: "balanced",
        lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold",
        contentWidth: "regular", columns: 0,
        buttonStyle: "rounded", linkStyle: "accent", imageRatio: "16/9",
        divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "stagger", duration: 400 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "split" }),
        tpl("projects", { title: "Interface work", limit: 6, layout: "featured" }),
        tpl("skills", { title: "Toolkit" }),
        tpl("experience", { title: "Experience", layout: "timeline" }),
        tpl("contact", { title: "Contact", body: "Open to frontend roles and collaborations. {availability}" }),
      ]}],
    },

    // 2. backend-forge
    {
      id: "backend-forge",
      label: "Backend Forge",
      description: "Near-black systems bench with a teal-green signal — services, APIs and reliability work, mono headings.",
      professions: ["backend-dev", "software-engineer"],
      theme: {
        background: "#0a0c0b", foreground: "#e9edea", accent: "#36c793",
        surface: "#111413", border: "#202624", muted: "#8f9a93",
        font: "jetbrains-mono", headingFont: "jetbrains-mono", bodyFont: "geist-sans",
        radius: "none", density: "regular", typeScale: "balanced",
        lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold",
        contentWidth: "regular", columns: 0,
        buttonStyle: "outline", linkStyle: "accent", imageRatio: "16/9",
        divider: "accent", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "line-mask", duration: 450 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "classic" }),
        tpl("projects", { title: "Systems & services", limit: 6, layout: "grid" }),
        tpl("stats", { title: "By the numbers" }),
        tpl("skills", { title: "Stack & tooling" }),
        tpl("experience", { title: "Experience", layout: "rows" }),
        tpl("contact", { title: "Contact", body: "Open to backend and platform work. {availability}" }),
      ]}],
    },

    // 3. mobile-launchpad
    {
      id: "mobile-launchpad",
      label: "Mobile Launchpad",
      description: "Soft graphite launchpad with coral energy — app releases framed like store listings, pill buttons.",
      professions: ["mobile-dev"],
      theme: {
        background: "#1b1e22", foreground: "#f2f1ee", accent: "#ef7a5a",
        surface: "#25282e", border: "#3a3e45", muted: "#a3a6ac",
        font: "manrope", headingFont: "manrope", bodyFont: "geist-sans",
        radius: "md", density: "compact", typeScale: "balanced",
        lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold",
        contentWidth: "regular", columns: 2,
        buttonStyle: "pill", linkStyle: "accent", imageRatio: "1/1",
        divider: "none", pageTransition: "slide", navLayout: "inline", headingAlign: "center",
      },
      motion: { preset: "pop", duration: 380 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered" }),
        tpl("projects", { title: "App releases", limit: 6, layout: "grid" }),
        tpl("skills", { title: "Skills & tools" }),
        tpl("collections", { title: "Case studies", limit: 3 }),
        tpl("contact", { title: "Contact", body: "Available for mobile projects. {availability}" }),
      ]}],
    },

    // 4. game-dev-arcade
    {
      id: "game-dev-arcade",
      label: "Game Dev Arcade",
      description: "Pure-black arcade cabinet with red-pink neon — shipped titles and in-game captures on a big screen.",
      professions: ["game-dev"],
      theme: {
        background: "#000000", foreground: "#f4f1ec", accent: "#ff2f5e",
        surface: "#0e0e10", border: "#242428", muted: "#8e8a85",
        font: "geist-sans", headingFont: "unbounded", bodyFont: "geist-sans",
        radius: "none", density: "regular", typeScale: "grand",
        lineHeight: "tight", letterSpacing: "normal", headingWeight: "bold",
        contentWidth: "wide", columns: 0,
        buttonStyle: "rounded", linkStyle: "plain", imageRatio: "16/9",
        divider: "accent", pageTransition: "slide", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "cinematic", duration: 550 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "cover" }),
        tpl("projects", { title: "Games", limit: 6, layout: "featured" }),
        tpl("gallery", { title: "In-game captures", source: "projects", limit: 8, layout: "grid" }),
        tpl("skills", { title: "Engines & tools" }),
        tpl("contact", { title: "Contact", body: "Open to game dev collaborations. {availability}" }),
      ]}],
    },

    // 5. ai-ml-lab
    {
      id: "ai-ml-lab",
      label: "AI/ML Lab",
      description: "Deep forest lab with lime instrumentation — research write-ups, models and evaluation work, editorial layout.",
      professions: ["ai-engineer", "ml-engineer"],
      theme: {
        background: "#0e1a12", foreground: "#edf3e9", accent: "#a8d84a",
        surface: "#15251b", border: "#273a2b", muted: "#92a68e",
        font: "sora", headingFont: "sora", bodyFont: "geist-sans",
        radius: "md", density: "regular", typeScale: "balanced",
        lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold",
        contentWidth: "regular", columns: 0,
        buttonStyle: "rounded", linkStyle: "accent", imageRatio: "3/2",
        divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "stagger-blur", duration: 480 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "split" }),
        tpl("projects", { title: "Research & models", limit: 5, layout: "editorial" }),
        tpl("stats", { title: "Lab in numbers" }),
        tpl("skills", { title: "Methods & stack" }),
        tpl("experience", { title: "Experience", layout: "timeline" }),
        tpl("contact", { title: "Contact", body: "Open to ML research and engineering work. {availability}" }),
      ]}],
    },

    // 6. data-notebook
    {
      id: "data-notebook",
      label: "Data Notebook",
      description: "Paper notebook with pine-green ink — analyses and notebooks read like a tidy research journal, narrow column.",
      professions: ["data-scientist"],
      theme: {
        background: "#f7f5ee", foreground: "#20261f", accent: "#2f6e50",
        surface: "#ffffff", border: "#e1ddd0", muted: "#6e756a",
        font: "ibm-plex-mono", headingFont: "ibm-plex-mono", bodyFont: "geist-sans",
        radius: "none", density: "regular", typeScale: "intimate",
        lineHeight: "relaxed", letterSpacing: "normal", headingWeight: "semibold",
        contentWidth: "narrow", columns: 0,
        buttonStyle: "sharp", linkStyle: "underline", imageRatio: "4/3",
        divider: "line", pageTransition: "fade", navLayout: "stacked", headingAlign: "left",
      },
      motion: { preset: "subtle-rise", duration: 420 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "classic" }),
        tpl("projects", { title: "Analyses & notebooks", limit: 8, layout: "list" }),
        tpl("skills", { title: "Toolbox" }),
        tpl("experience", { title: "Experience", layout: "rows" }),
        tpl("contact", { title: "Contact", body: "Available for data work and collaborations. {availability}" }),
      ]}],
    },

    // 7. analyst-report
    {
      id: "analyst-report",
      label: "Analyst Report",
      description: "Light grey briefing deck with slate-olive accents — dashboards and reports presented wide, like slides.",
      professions: ["data-analyst", "data-engineer"],
      theme: {
        background: "#f1f2f0", foreground: "#262a25", accent: "#6a7452",
        surface: "#ffffff", border: "#dee0da", muted: "#747a70",
        font: "manrope", headingFont: "manrope", bodyFont: "manrope",
        radius: "md", density: "regular", typeScale: "balanced",
        lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold",
        contentWidth: "regular", columns: 0,
        buttonStyle: "rounded", linkStyle: "accent", imageRatio: "16/9",
        divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "fade-up-soft", duration: 420 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "classic" }),
        tpl("projects", { title: "Dashboards & reports", limit: 6, layout: "featured" }),
        tpl("stats", { title: "At a glance" }),
        tpl("skills", { title: "Tooling" }),
        tpl("contact", { title: "Contact", body: "Open to analytics roles and projects. {availability}" }),
      ]}],
    },

    // 8. cyber-shield
    {
      id: "cyber-shield",
      label: "Cyber Shield",
      description: "Black terminal with alert-red markers — security services and engagement history in mono type, sharp edges.",
      professions: ["cybersecurity"],
      theme: {
        background: "#070808", foreground: "#e9ebea", accent: "#e5484d",
        surface: "#111313", border: "#222626", muted: "#8b9290",
        font: "geist-mono", headingFont: "geist-mono", bodyFont: "geist-sans",
        radius: "none", density: "compact", typeScale: "balanced",
        lineHeight: "normal", letterSpacing: "normal", headingWeight: "semibold",
        contentWidth: "regular", columns: 0,
        buttonStyle: "sharp", linkStyle: "accent", imageRatio: "16/9",
        divider: "accent", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "type-steps", duration: 380 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "classic" }),
        tpl("services", { title: "Security services", layout: "rows" }),
        tpl("projects", { title: "Engagements", limit: 6, layout: "list" }),
        tpl("experience", { title: "Experience", layout: "timeline" }),
        tpl("contact", { title: "Contact", body: "Available for security assessments. {availability}" }),
      ]}],
    },

    // 9. devops-pipeline
    {
      id: "devops-pipeline",
      label: "DevOps Pipeline",
      description: "Dark slate control room with signal orange — infrastructure projects in a three-up grid, sequential reveals.",
      professions: ["devops", "sre", "cloud-architect", "network-engineer"],
      theme: {
        background: "#12171d", foreground: "#edeff1", accent: "#f2803c",
        surface: "#1a2027", border: "#2b333c", muted: "#96a0a8",
        font: "barlow", headingFont: "barlow", bodyFont: "geist-sans",
        radius: "md", density: "regular", typeScale: "balanced",
        lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold",
        contentWidth: "wide", columns: 3,
        buttonStyle: "rounded", linkStyle: "accent", imageRatio: "16/9",
        divider: "line", pageTransition: "rise", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "domino", duration: 450 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "classic" }),
        tpl("projects", { title: "Infrastructure projects", limit: 6, layout: "grid" }),
        tpl("skills", { title: "Platforms & tools" }),
        tpl("experience", { title: "Experience", layout: "timeline" }),
        tpl("contact", { title: "Contact", body: "Open to infrastructure and platform roles. {availability}" }),
      ]}],
    },

    // 10. product-roadmap
    {
      id: "product-roadmap",
      label: "Product Roadmap",
      description: "Bright paper with terracotta milestones — product case studies, a shipped-it journey and stakeholder voices.",
      professions: ["product-manager", "business-analyst"],
      theme: {
        background: "#fbf8f3", foreground: "#2c251f", accent: "#bd6144",
        surface: "#ffffff", border: "#ecdfd2", muted: "#84786c",
        font: "plus-jakarta-sans", headingFont: "plus-jakarta-sans", bodyFont: "plus-jakarta-sans",
        radius: "md", density: "relaxed", typeScale: "balanced",
        lineHeight: "normal", letterSpacing: "normal", headingWeight: "bold",
        contentWidth: "regular", columns: 0,
        buttonStyle: "rounded", linkStyle: "accent", imageRatio: "3/2",
        divider: "line", pageTransition: "fade", navLayout: "stacked", headingAlign: "center",
      },
      motion: { preset: "gentle-appear", duration: 460 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered" }),
        tpl("projects", { title: "Product case studies", limit: 4, layout: "featured" }),
        tpl("experience", { title: "Product journey", layout: "timeline" }),
        tpl("skills", { title: "What I bring" }),
        tpl("testimonials", { title: "Kind words", layout: "cards" }),
        tpl("contact", { title: "Contact", body: "Open to product roles. {availability}" }),
      ]}],
    },

    // 11. ux-research-lab
    {
      id: "ux-research-lab",
      label: "UX Research Lab",
      description: "Calm ivory lab with clay annotations — research reports and study services in a readable, unhurried layout.",
      professions: ["ux-researcher", "qa-engineer", "automation-tester"],
      theme: {
        background: "#f6f2e9", foreground: "#2f2b24", accent: "#b06b45",
        surface: "#ffffff", border: "#e7dfcf", muted: "#867d6e",
        font: "work-sans", headingFont: "work-sans", bodyFont: "work-sans",
        radius: "md", density: "relaxed", typeScale: "balanced",
        lineHeight: "relaxed", letterSpacing: "normal", headingWeight: "semibold",
        contentWidth: "regular", columns: 0,
        buttonStyle: "outline", linkStyle: "accent", imageRatio: "4/3",
        divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "editorial-stagger", duration: 500 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "split" }),
        tpl("projects", { title: "Research reports", limit: 5, layout: "editorial" }),
        tpl("services", { title: "Research services", layout: "cards" }),
        tpl("skills", { title: "Methods & tools" }),
        tpl("contact", { title: "Contact", body: "Available for research and QA engagements. {availability}" }),
      ]}],
    },
  ];

  // ids are plain strings here; registered as TemplateId members by the
  // site-config integrator. Shape was fully checked as PresetDraft above.
  return entries as TemplatePreset[];
}
