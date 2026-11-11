/**
 * BEAN Folio — v4 profession-family templates: Newsroom & Broadcast
 * (template category "newsroom-broadcast").
 *
 * Eleven complete, production-ready site designs for on-air and
 * behind-the-desk news professionals — anchors, correspondents,
 * photojournalists, producers and editors. Each entry is a whole-website
 * preset (theme tokens, motion, and a full home-page section arrangement)
 * that renders through the standard SiteRenderer. Sample sections are
 * placeholders for the creator's own material: titles describe slot purpose
 * only and every copy string uses the {name} {tagline} {headline} {bio}
 * {availability} tokens — no invented outlets, clients, awards or metrics.
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

export function newsroomTemplates(): TemplatePreset[] {
  const templates: TemplateDraft[] = [
    // ------------------------------------------------------------ 1
    {
      id: "news-anchor-desk",
      label: "News Anchor Desk",
      description:
        "Authority desk for anchors: near-black charcoal, warm gold and a full-bleed cover hero that opens on the showreel.",
      professions: ["news-anchor", "news-presenter", "television-presenter"],
      theme: {
        background: "#0d0f12",
        foreground: "#f2efe8",
        accent: "#d4a94e",
        surface: "#14171c",
        border: "#242830",
        muted: "#97928a",
        font: "newsreader",
        headingFont: "newsreader",
        bodyFont: "geist-sans",
        radius: "md",
        density: "regular",
        typeScale: "grand",
        lineHeight: "normal",
        letterSpacing: "normal",
        headingWeight: "semibold",
        contentWidth: "regular",
        columns: 0,
        buttonStyle: "rounded",
        linkStyle: "accent",
        imageRatio: "16/9",
        divider: "line",
        pageTransition: "fade",
        navLayout: "inline",
        headingAlign: "left",
      },
      motion: { preset: "editorial-stagger", duration: 500 },
      pages: [
        homePage([
          tpl("hero", {
            variant: "cover",
            title: "{name}",
            subtitle: "{headline} — {location}",
            ctaLabel: "Watch the showreel",
          }),
          tpl("gallery", { title: "Showreel & studio clips", source: "projects", limit: 8, layout: "strip" }),
          tpl("stats", { title: "Broadcast reach" }),
          tpl("experience", { title: "Broadcast experience", layout: "timeline" }),
          tpl("skills", { title: "Languages & presentation" }),
          tpl("contact", {
            title: "Booking & appearances",
            body: "{availability} — for anchoring, hosting and panel moderation.",
          }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 2
    {
      id: "broadcast-studio",
      label: "Broadcast Studio",
      description:
        "Deep red-brown studio look with a split hero and featured segments first — for broadcast journalists who live on air.",
      professions: ["broadcast-journalist", "news-presenter"],
      theme: {
        background: "#201311",
        foreground: "#f5ede6",
        accent: "#b85c38",
        surface: "#2b1a16",
        border: "#42291f",
        muted: "#a08b80",
        font: "prata",
        headingFont: "prata",
        bodyFont: "geist-sans",
        radius: "md",
        density: "relaxed",
        typeScale: "grand",
        lineHeight: "normal",
        letterSpacing: "normal",
        headingWeight: "semibold",
        contentWidth: "regular",
        columns: 0,
        buttonStyle: "rounded",
        linkStyle: "accent",
        imageRatio: "16/9",
        divider: "line",
        pageTransition: "fade",
        navLayout: "stacked",
        headingAlign: "left",
      },
      motion: { preset: "serif-rise", duration: 600 },
      pages: [
        homePage([
          tpl("hero", {
            variant: "split",
            title: "{name}",
            subtitle: "{headline} — {location}",
            ctaLabel: "Featured segments",
          }),
          tpl("projects", { title: "Featured segments", limit: 6, layout: "featured" }),
          tpl("about", { title: "About", body: "{bio}" }),
          tpl("gallery", { title: "Live broadcast moments", source: "projects", limit: 8, layout: "strip" }),
          tpl("experience", { title: "On the record", layout: "rows" }),
          tpl("contact", { title: "Get in touch", body: "{availability}" }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 3
    {
      id: "field-report-kit",
      label: "Field Report Kit",
      description:
        "Utilitarian khaki field kit — list-style reporting, an assignments timeline and plain, durable typography.",
      professions: ["reporter", "field-reporter", "correspondent"],
      theme: {
        background: "#f2ede0",
        foreground: "#2c2a22",
        accent: "#91713f",
        surface: "#faf7ee",
        border: "#ddd4bc",
        muted: "#7d7666",
        font: "barlow",
        headingFont: "barlow",
        bodyFont: "barlow",
        radius: "none",
        density: "compact",
        typeScale: "balanced",
        lineHeight: "normal",
        letterSpacing: "wide",
        headingWeight: "bold",
        contentWidth: "regular",
        columns: 0,
        buttonStyle: "sharp",
        linkStyle: "underline",
        imageRatio: "4/3",
        divider: "accent",
        pageTransition: "fade",
        navLayout: "inline",
        headingAlign: "left",
      },
      motion: { preset: "fade-down", duration: 400 },
      pages: [
        homePage([
          tpl("hero", { title: "Dispatches from {name}", subtitle: "{headline} — {location}" }),
          tpl("projects", { title: "Field reporting", limit: 6, layout: "list" }),
          tpl("experience", { title: "Assignments", layout: "timeline" }),
          tpl("skills", { title: "Kit & craft" }),
          tpl("contact", { title: "Commissions & assignments", body: "{availability}" }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 4
    {
      id: "investigative-dossier",
      label: "Investigative Dossier",
      description:
        "A paper-and-ink dossier for investigative and political journalists: editorial investigation index, track record and recognition.",
      professions: ["investigative-journalist", "political-journalist"],
      theme: {
        background: "#f7f3ea",
        foreground: "#1c1a16",
        accent: "#7a2e2a",
        surface: "#fffdf6",
        border: "#e0d8c6",
        muted: "#6e6759",
        font: "spectral",
        headingFont: "spectral",
        bodyFont: "crimson-pro",
        radius: "none",
        density: "relaxed",
        typeScale: "grand",
        lineHeight: "relaxed",
        letterSpacing: "normal",
        headingWeight: "semibold",
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
      motion: { preset: "ink-reveal", duration: 650 },
      pages: [
        homePage([
          tpl("hero", { title: "{name}", subtitle: "{headline}" }),
          tpl("projects", { title: "Investigations", limit: 6, layout: "editorial" }),
          tpl("about", { title: "The byline", body: "{bio}" }),
          tpl("experience", { title: "Track record", layout: "rows" }),
          tpl("testimonials", { title: "Recognition", layout: "stack" }),
          tpl("contact", {
            title: "Secure tips & contact",
            body: "{availability} — sensitive material can be directed securely.",
          }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 5
    {
      id: "press-photographer",
      label: "Press Photographer",
      description:
        "Near-black and silver frame that leads with a masonry wall of photo stories — built for photojournalists.",
      professions: ["photojournalist"],
      theme: {
        background: "#0b0b0c",
        foreground: "#e9e9ea",
        accent: "#c8c6c2",
        surface: "#141416",
        border: "#26262a",
        muted: "#8f8f94",
        font: "tenor-sans",
        headingFont: "tenor-sans",
        bodyFont: "geist-sans",
        radius: "none",
        density: "regular",
        typeScale: "grand",
        lineHeight: "normal",
        letterSpacing: "wide",
        headingWeight: "light",
        contentWidth: "wide",
        columns: 0,
        buttonStyle: "outline",
        linkStyle: "accent",
        imageRatio: "3/2",
        divider: "none",
        pageTransition: "fade",
        navLayout: "centered",
        headingAlign: "left",
      },
      motion: { preset: "media-zoom-slow", duration: 700 },
      pages: [
        homePage([
          tpl("hero", { variant: "cover", title: "{name}", subtitle: "{tagline}" }),
          tpl("gallery", { title: "Photo stories", source: "projects", limit: 12, layout: "masonry" }),
          tpl("projects", { title: "Photo essays", limit: 4, layout: "featured" }),
          tpl("about", { title: "About", body: "{bio}" }),
          tpl("contact", { title: "Prints & assignments", body: "{availability}" }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 6
    {
      id: "video-journal-cut",
      label: "Video Journal Cut",
      description:
        "Slate-and-amber cut for video journalists: featured reports up front, a film-strip gallery and production history.",
      professions: ["video-journalist", "documentary-journalist"],
      theme: {
        background: "#161a1e",
        foreground: "#eef1f4",
        accent: "#e3a243",
        surface: "#1d2228",
        border: "#2b323a",
        muted: "#97a1ab",
        font: "archivo",
        headingFont: "archivo",
        bodyFont: "geist-sans",
        radius: "md",
        density: "compact",
        typeScale: "balanced",
        lineHeight: "normal",
        letterSpacing: "normal",
        headingWeight: "bold",
        contentWidth: "wide",
        columns: 0,
        buttonStyle: "rounded",
        linkStyle: "accent",
        imageRatio: "16/9",
        divider: "accent",
        pageTransition: "slide",
        navLayout: "inline",
        headingAlign: "left",
      },
      motion: { preset: "media-mask-down", duration: 550 },
      pages: [
        homePage([
          tpl("hero", {
            variant: "split",
            title: "{name}",
            subtitle: "{headline} — {location}",
            ctaLabel: "Watch the latest",
          }),
          tpl("projects", { title: "Video reports", limit: 6, layout: "featured" }),
          tpl("gallery", { title: "From the raw cuts", source: "projects", limit: 8, layout: "strip" }),
          tpl("experience", { title: "Field production", layout: "rows" }),
          tpl("contact", { title: "Story tips & commissions", body: "{availability}" }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 7
    {
      id: "radio-airwave",
      label: "Radio Airwave",
      description:
        "Warm cream and burnt orange with a centered hero and pill buttons — segments, show numbers and broadcast history.",
      professions: ["radio-presenter", "radio-host"],
      theme: {
        background: "#f8f1e4",
        foreground: "#33241a",
        accent: "#c05a2e",
        surface: "#fffaf0",
        border: "#e7d9c2",
        muted: "#8a7a68",
        font: "jost",
        headingFont: "jost",
        bodyFont: "jost",
        radius: "full",
        density: "regular",
        typeScale: "balanced",
        lineHeight: "normal",
        letterSpacing: "normal",
        headingWeight: "bold",
        contentWidth: "regular",
        columns: 0,
        buttonStyle: "pill",
        linkStyle: "accent",
        imageRatio: "1/1",
        divider: "none",
        pageTransition: "fade",
        navLayout: "centered",
        headingAlign: "center",
      },
      motion: { preset: "pop", duration: 450 },
      pages: [
        homePage([
          tpl("hero", {
            variant: "centered",
            title: "{name}",
            subtitle: "{tagline}",
            ctaLabel: "Listen to the latest",
          }),
          tpl("projects", { title: "On-air segments", limit: 6, layout: "list" }),
          tpl("stats", { title: "The show in numbers" }),
          tpl("experience", { title: "Broadcast history", layout: "rows" }),
          tpl("skills", { title: "On-air skills" }),
          tpl("contact", { title: "Say hello to the show", body: "{availability}" }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 8
    {
      id: "podcast-atlas",
      label: "Podcast Atlas",
      description:
        "Deep espresso and coral episode atlas: featured episodes, series collections and listener notes for podcasters.",
      professions: ["podcast-host", "digital-news-creator"],
      theme: {
        background: "#191110",
        foreground: "#f4ebe4",
        accent: "#e5715a",
        surface: "#221715",
        border: "#33241f",
        muted: "#a4918a",
        font: "sora",
        headingFont: "sora",
        bodyFont: "geist-sans",
        radius: "full",
        density: "relaxed",
        typeScale: "balanced",
        lineHeight: "normal",
        letterSpacing: "normal",
        headingWeight: "bold",
        contentWidth: "regular",
        columns: 0,
        buttonStyle: "rounded",
        linkStyle: "accent",
        imageRatio: "1/1",
        divider: "none",
        pageTransition: "rise",
        navLayout: "inline",
        headingAlign: "left",
      },
      motion: { preset: "stagger-scale", duration: 500 },
      pages: [
        homePage([
          tpl("hero", {
            variant: "centered",
            title: "{name}",
            subtitle: "{tagline}",
            ctaLabel: "Start with episode one",
          }),
          tpl("projects", { title: "Episodes", limit: 8, layout: "featured" }),
          tpl("collections", { title: "Series", limit: 3 }),
          tpl("skills", { title: "Studio & craft" }),
          tpl("testimonials", { title: "Listener notes", layout: "stack" }),
          tpl("contact", { title: "Guest pitches & sponsorships", body: "{availability}" }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 9
    {
      id: "newsroom-desk",
      label: "Newsroom Desk",
      description:
        "Graphite and brass newsroom desk — a roles timeline and produced programmes for editors and producers.",
      professions: ["news-editor", "assignment-editor", "news-producer", "executive-producer"],
      theme: {
        background: "#191a1c",
        foreground: "#eceae4",
        accent: "#b08d4a",
        surface: "#212225",
        border: "#303236",
        muted: "#93918b",
        font: "libre-baskerville",
        headingFont: "libre-baskerville",
        bodyFont: "geist-sans",
        radius: "none",
        density: "compact",
        typeScale: "balanced",
        lineHeight: "normal",
        letterSpacing: "normal",
        headingWeight: "bold",
        contentWidth: "regular",
        columns: 0,
        buttonStyle: "sharp",
        linkStyle: "underline",
        imageRatio: "16/9",
        divider: "line",
        pageTransition: "none",
        navLayout: "stacked",
        headingAlign: "left",
      },
      motion: { preset: "headline-mask", duration: 550 },
      pages: [
        homePage([
          tpl("hero", { title: "The desk of {name}", subtitle: "{headline}" }),
          tpl("experience", { title: "Newsroom roles", layout: "timeline" }),
          tpl("projects", { title: "Produced programmes", limit: 6, layout: "editorial" }),
          tpl("skills", { title: "Editorial command" }),
          tpl("contact", { title: "Story meetings & pitches", body: "{availability}" }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 10
    {
      id: "explainer-brief",
      label: "Explainer Brief",
      description:
        "Bright paper with a forest-green accent and a narrow reading column of explainers — for analysts and beat specialists.",
      professions: [
        "fact-checker",
        "newsroom-researcher",
        "news-analyst",
        "science-journalist",
        "technology-journalist",
      ],
      theme: {
        background: "#f6f8f2",
        foreground: "#1d241c",
        accent: "#2f6b46",
        surface: "#ffffff",
        border: "#d9e2d5",
        muted: "#6c7a6b",
        font: "public-sans",
        headingFont: "public-sans",
        bodyFont: "source-serif-4",
        radius: "md",
        density: "regular",
        typeScale: "balanced",
        lineHeight: "relaxed",
        letterSpacing: "normal",
        headingWeight: "bold",
        contentWidth: "narrow",
        columns: 0,
        buttonStyle: "rounded",
        linkStyle: "accent",
        imageRatio: "3/2",
        divider: "line",
        pageTransition: "fade",
        navLayout: "inline",
        headingAlign: "left",
      },
      motion: { preset: "word-rise", duration: 450 },
      pages: [
        homePage([
          tpl("hero", { title: "{name}", subtitle: "{headline}" }),
          tpl("projects", { title: "Explainers & analysis", limit: 6, layout: "editorial" }),
          tpl("about", { title: "The brief", body: "{bio}" }),
          tpl("skills", { title: "Beats & methods" }),
          tpl("contact", { title: "Questions & tips", body: "{availability}" }),
        ]),
      ],
    },

    // ------------------------------------------------------------ 11
    {
      id: "byline-media",
      label: "Byline Media",
      description:
        "Bold poster style with condensed ink headlines, a cover hero and a formats rate-card for freelancers and commentators.",
      professions: ["freelance-journalist", "social-media-journalist", "media-commentator", "scriptwriter"],
      theme: {
        background: "#f4f1ea",
        foreground: "#141310",
        accent: "#d8432f",
        surface: "#ffffff",
        border: "#d8d4c8",
        muted: "#6f6a5e",
        font: "anton",
        headingFont: "anton",
        bodyFont: "geist-sans",
        radius: "none",
        density: "compact",
        typeScale: "grand",
        lineHeight: "tight",
        letterSpacing: "normal",
        headingWeight: "bold",
        contentWidth: "wide",
        columns: 0,
        buttonStyle: "sharp",
        linkStyle: "underline",
        imageRatio: "3/2",
        divider: "accent",
        pageTransition: "slide",
        navLayout: "stacked",
        headingAlign: "left",
      },
      motion: { preset: "mask-up", duration: 450 },
      pages: [
        homePage([
          tpl("hero", {
            variant: "cover",
            title: "{name}",
            subtitle: "{headline} — {tagline}",
            ctaLabel: "Recent stories",
          }),
          tpl("projects", { title: "Stories", limit: 9, layout: "grid" }),
          tpl("gallery", { title: "From the field", source: "projects", limit: 8, layout: "grid" }),
          tpl("services", { title: "Formats", layout: "rows" }),
          tpl("contact", { title: "Pitches & commissions", body: "{availability}" }),
        ]),
      ],
    },
  ];

  return templates as TemplatePreset[];
}
