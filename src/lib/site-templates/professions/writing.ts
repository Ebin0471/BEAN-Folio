/**
 * BEAN Folio — v4 profession-family templates: Writing & Publishing
 * (template category "writing-publishing").
 *
 * Five complete, production-ready site designs for the written craft —
 * authors, poets, commercial copywriters, technical writers and language
 * professionals. Each entry is a whole-website preset (theme tokens, motion,
 * and a full home-page section arrangement) that renders through the
 * standard SiteRenderer. Sample sections are placeholders for the creator's
 * own material: titles describe slot purpose only and every copy string uses
 * the {name} {tagline} {headline} {bio} {availability} tokens — no invented
 * publishers, awards, sales figures or fabricated bio text.
 *
 * Exported as a factory (not a top-level array) so `makeSection()` runs at
 * call time — fresh section ids on every call and no circular-import
 * init-order coupling with site-config.
 */
import { makeSection } from "../../site-config";
import type { TemplatePreset, SitePage, SiteSection } from "../../site-config";

/**
 * Local stand-in for the `tplSection` helper in site-config.ts (which is not
 * exported yet): mint a fresh default section of `type`, then apply
 * overrides. `makeSection` guarantees a unique id per call.
 */
function tpl(
  type: Parameters<typeof makeSection>[0],
  overrides: Record<string, unknown> = {},
): SiteSection {
  return { ...makeSection(type), ...overrides } as SiteSection;
}

/** Every family template ships a single visible home page. */
function homePage(sections: SiteSection[]): SitePage {
  return { id: "home", name: "Home", visible: true, sections };
}

/**
 * Draft entries keep `id` as a free string: the v4 profession-family ids sit
 * outside the legacy `TEMPLATE_IDS` union in site-config.ts until the
 * registry change lands. The factory narrows once at the boundary so callers
 * always receive genuine `TemplatePreset`s.
 */
type TemplateDraft = Omit<TemplatePreset, "id"> & { id: string };

export function writingTemplates(): TemplatePreset[] {
  const templates: TemplateDraft[] = [
    // ------------------------------------------------------------ 12
    {
      id: "author-folio",
      label: "Author Folio",
      description:
        "Library-warm brown and parchment folio that opens on the books — for authors and novelists.",
      professions: ["author", "novelist"],
      theme: {
        background: "#221712",
        foreground: "#f1e7d8",
        accent: "#c99a5b",
        surface: "#2c1f18",
        border: "#3f2d22",
        muted: "#a8968a",
        font: "playfair-display",
        headingFont: "playfair-display",
        bodyFont: "lora",
        radius: "md",
        density: "relaxed",
        typeScale: "grand",
        lineHeight: "relaxed",
        letterSpacing: "normal",
        headingWeight: "semibold",
        contentWidth: "narrow",
        columns: 0,
        buttonStyle: "rounded",
        linkStyle: "accent",
        imageRatio: "3/2",
        divider: "line",
        pageTransition: "fade",
        navLayout: "centered",
        headingAlign: "left",
      },
      motion: { preset: "paper-unfold", duration: 650 },
      pages: [
        homePage([
          tpl("hero", {
            variant: "centered",
            title: "{name}",
            subtitle: "{tagline}",
            ctaLabel: "See the books",
          }),
          tpl("projects", { title: "Books", limit: 6, layout: "featured" }),
          tpl("about", { title: "About the author", body: "{bio}" }),
          tpl("testimonials", { title: "Reader & critic notes", layout: "cards" }),
          tpl("contact", { title: "Events, rights & press", body: "{availability}" }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 13
    {
      id: "poet-pages",
      label: "Poet Pages",
      description:
        "A minimal white page set in delicate Cormorant — narrow collections column and readings gallery for poets.",
      professions: ["poet"],
      theme: {
        background: "#fbfbf9",
        foreground: "#1a1a16",
        accent: "#201f1b",
        surface: "#ffffff",
        border: "#e4e2da",
        muted: "#77756c",
        font: "cormorant",
        headingFont: "cormorant",
        bodyFont: "eb-garamond",
        radius: "none",
        density: "relaxed",
        typeScale: "intimate",
        lineHeight: "relaxed",
        letterSpacing: "wide",
        headingWeight: "light",
        contentWidth: "narrow",
        columns: 0,
        buttonStyle: "outline",
        linkStyle: "underline",
        imageRatio: "3/2",
        divider: "line",
        pageTransition: "fade",
        navLayout: "inline",
        headingAlign: "left",
      },
      motion: { preset: "word-fade", duration: 700 },
      pages: [
        homePage([
          tpl("hero", { title: "{name}", subtitle: "{tagline}" }),
          tpl("projects", { title: "Collections", limit: 6, layout: "list" }),
          tpl("gallery", { title: "Readings & press", source: "projects", limit: 9, layout: "masonry" }),
          tpl("about", { title: "A note", body: "{bio}" }),
          tpl("contact", { title: "Commissions & readings", body: "{availability}" }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 14
    {
      id: "copywriter-desk",
      label: "Copywriter Desk",
      description:
        "Crisp office light with an oxblood accent: campaign work, a what-I-write card grid and desk numbers for commercial writers.",
      professions: ["copywriter", "content-writer", "ghostwriter"],
      theme: {
        background: "#f7f6f3",
        foreground: "#201d1a",
        accent: "#7d2a33",
        surface: "#ffffff",
        border: "#e3e0da",
        muted: "#77726a",
        font: "dm-serif-display",
        headingFont: "dm-serif-display",
        bodyFont: "manrope",
        radius: "md",
        density: "compact",
        typeScale: "balanced",
        lineHeight: "normal",
        letterSpacing: "normal",
        headingWeight: "bold",
        contentWidth: "regular",
        columns: 0,
        buttonStyle: "rounded",
        linkStyle: "accent",
        imageRatio: "3/2",
        divider: "none",
        pageTransition: "fade",
        navLayout: "inline",
        headingAlign: "left",
      },
      motion: { preset: "crisp-pop", duration: 400 },
      pages: [
        homePage([
          tpl("hero", {
            variant: "split",
            title: "{name}",
            subtitle: "{headline}",
            ctaLabel: "See campaign work",
          }),
          tpl("projects", { title: "Campaign work", limit: 6, layout: "editorial" }),
          tpl("services", { title: "What I write", layout: "cards" }),
          tpl("stats", { title: "The desk in numbers" }),
          tpl("contact", { title: "Start a brief", body: "{availability}" }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 15
    {
      id: "tech-doc-hub",
      label: "Tech Doc Hub",
      description:
        "Terminal-adjacent light theme with mono headings and zero radius — documentation sets and a toolchain for technical writers.",
      professions: ["technical-writer"],
      theme: {
        background: "#f3f6f2",
        foreground: "#17201a",
        accent: "#12805c",
        surface: "#ffffff",
        border: "#d6e0d6",
        muted: "#5f7265",
        font: "geist-mono",
        headingFont: "geist-mono",
        bodyFont: "geist-sans",
        radius: "none",
        density: "compact",
        typeScale: "balanced",
        lineHeight: "normal",
        letterSpacing: "normal",
        headingWeight: "semibold",
        contentWidth: "regular",
        columns: 0,
        buttonStyle: "sharp",
        linkStyle: "underline",
        imageRatio: "4/3",
        divider: "line",
        pageTransition: "none",
        navLayout: "inline",
        headingAlign: "left",
      },
      motion: { preset: "type-steps", duration: 320 },
      pages: [
        homePage([
          tpl("hero", { title: "{name}", subtitle: "{headline}" }),
          tpl("projects", { title: "Documentation sets", limit: 9, layout: "list" }),
          tpl("skills", { title: "Toolchain" }),
          tpl("experience", { title: "Contract history", layout: "rows" }),
          tpl("contact", { title: "Documentation work", body: "{availability}" }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 16
    {
      id: "translator-bridge",
      label: "Translator Bridge",
      description:
        "Two-tone slate and sand bridge: language pairs and services first, then translated work and assignments.",
      professions: ["translator", "interpreter", "editor", "proofreader"],
      theme: {
        background: "#f1ede4",
        foreground: "#2a3036",
        accent: "#9c6a44",
        surface: "#faf7f0",
        border: "#ddd6c8",
        muted: "#707680",
        font: "marcellus",
        headingFont: "marcellus",
        bodyFont: "geist-sans",
        radius: "md",
        density: "regular",
        typeScale: "balanced",
        lineHeight: "relaxed",
        letterSpacing: "normal",
        headingWeight: "semibold",
        contentWidth: "narrow",
        columns: 0,
        buttonStyle: "outline",
        linkStyle: "accent",
        imageRatio: "3/2",
        divider: "line",
        pageTransition: "fade",
        navLayout: "inline",
        headingAlign: "left",
      },
      motion: { preset: "gentle-appear", duration: 550 },
      pages: [
        homePage([
          tpl("hero", { title: "{name}", subtitle: "{headline} — {location}" }),
          tpl("services", { title: "Language pairs & services", layout: "rows" }),
          tpl("projects", { title: "Selected translations", limit: 6, layout: "grid" }),
          tpl("experience", { title: "Assignments", layout: "rows" }),
          tpl("contact", { title: "Availability & rates", body: "{availability}" }),
        ]),
      ],
    },
  ];

  return templates as TemplatePreset[];
}
