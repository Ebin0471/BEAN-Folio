/**
 * BEAN Folio — profession template family: Performing Arts & Screen.
 *
 * Eight complete-website presets for musicians, actors, voice and dance
 * artists, film crews, editors, sound studios, and casting desks. Every entry
 * is a full design (structure, palette, typography, motion) authored against
 * the shared `makeSection` factory so presets pass `normalizeConfig` unchanged.
 *
 * Content rules: section bodies carry placeholder tokens only ({name}
 * {tagline} {headline} {bio} {availability}); titles describe the slot's
 * purpose. No invented productions, venues, clients, awards or prices.
 */
import { makeSection } from "../../site-config";
import type { TemplatePreset, SiteSection } from "../../site-config";

function tpl(type: Parameters<typeof makeSection>[0], overrides: Record<string, unknown> = {}): SiteSection {
  return { ...makeSection(type), ...overrides } as SiteSection;
}

/**
 * Authoring input — profession-template ids are registered by the template
 * registry rather than the classic `TemplateId` union, so the id is authored
 * as a free kebab-case string here.
 */
type PresetAuthor = Omit<TemplatePreset, "id"> & { id: string };

function preset(p: PresetAuthor): TemplatePreset {
  return p as TemplatePreset;
}

export function performingArtsTemplates(): TemplatePreset[] {
  return [
    preset({
      id: "musician-stage",
      label: "Musician Stage",
      description:
        "Stage-black press kit with brass accents — a live-and-studio filmstrip, a releases list, and a numbers row.",
      professions: ["musician", "singer", "composer"],
      theme: {
        background: "#0c0b09", foreground: "#f4efe6", accent: "#c9963f",
        surface: "#16140f", border: "#2b2619", muted: "#99917f",
        font: "bebas-neue", headingFont: "bebas-neue", bodyFont: "geist-sans",
        radius: "none", density: "regular", typeScale: "grand", lineHeight: "tight",
        letterSpacing: "normal", headingWeight: "bold", contentWidth: "wide",
        columns: 0, buttonStyle: "sharp", linkStyle: "accent", imageRatio: "16/9",
        divider: "accent", pageTransition: "slide", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "domino", duration: 500 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline} — {location}", variant: "cover", ctaLabel: "Hear the latest" }),
        tpl("gallery", { title: "Live & studio", source: "projects", limit: 10, layout: "strip" }),
        tpl("projects", { title: "Releases & scores", limit: 6, layout: "list" }),
        tpl("stats", { title: "At a glance" }),
        tpl("contact", { title: "Bookings", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "actor-callboard",
      label: "Actor Callboard",
      description:
        "Deep maroon and cream callboard — featured roles up front, a theatre-and-screen timeline, and production stills.",
      professions: ["actor", "theatre-performer"],
      theme: {
        background: "#331619", foreground: "#f3e9d6", accent: "#d8a048",
        surface: "#3f1d21", border: "#57302f", muted: "#b39a86",
        font: "playfair-display", headingFont: "playfair-display", bodyFont: "geist-sans",
        radius: "md", density: "relaxed", typeScale: "grand", lineHeight: "relaxed",
        letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular",
        columns: 0, buttonStyle: "rounded", linkStyle: "underline", imageRatio: "3/2",
        divider: "accent", pageTransition: "fade", navLayout: "stacked", headingAlign: "center",
      },
      motion: { preset: "serif-rise", duration: 700 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "centered" }),
        tpl("projects", { title: "Roles & productions", limit: 6, layout: "featured" }),
        tpl("experience", { title: "Theatre & screen", layout: "timeline" }),
        tpl("gallery", { title: "Production stills", source: "projects", limit: 8, layout: "strip" }),
        tpl("contact", { title: "Representation & auditions", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "voice-booth",
      label: "Voice Booth",
      description:
        "Booth-dark page with electric-lime accents — a clips grid, service rows, and studio kit for voice and DJ work.",
      professions: ["voice-artist", "dj"],
      theme: {
        background: "#17181a", foreground: "#eef0ea", accent: "#a8d426",
        surface: "#1f2124", border: "#2e3136", muted: "#8f948c",
        font: "archivo-black", headingFont: "archivo-black", bodyFont: "geist-sans",
        radius: "none", density: "compact", typeScale: "grand", lineHeight: "tight",
        letterSpacing: "normal", headingWeight: "bold", contentWidth: "regular",
        columns: 0, buttonStyle: "sharp", linkStyle: "plain", imageRatio: "16/9",
        divider: "none", pageTransition: "slide", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "line-mask", duration: 500 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "split", ctaLabel: "Book a session" }),
        tpl("projects", { title: "Voice work", limit: 8, layout: "grid" }),
        tpl("services", { title: "Services", layout: "rows" }),
        tpl("skills", { title: "Studio kit" }),
        tpl("contact", { title: "Book a session", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "dancer-stage",
      label: "Dancer Stage",
      description:
        "Motion-white stage with crimson accents — performance photography masonry, featured pieces, and a stage history.",
      professions: ["dancer", "choreographer"],
      theme: {
        background: "#f7f5f0", foreground: "#1c1917", accent: "#b3282d",
        surface: "#efece4", border: "#ddd8cc", muted: "#8b857a",
        font: "italiana", headingFont: "italiana", bodyFont: "geist-sans",
        radius: "md", density: "relaxed", typeScale: "grand", lineHeight: "relaxed",
        letterSpacing: "wide", headingWeight: "light", contentWidth: "wide",
        columns: 0, buttonStyle: "outline", linkStyle: "underline", imageRatio: "3/2",
        divider: "accent", pageTransition: "rise", navLayout: "centered", headingAlign: "center",
      },
      motion: { preset: "media-float-in", duration: 700 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline} — {location}", variant: "cover" }),
        tpl("gallery", { title: "Performance photography", source: "projects", limit: 12, layout: "masonry" }),
        tpl("projects", { title: "Featured performances", limit: 4, layout: "featured" }),
        tpl("experience", { title: "Stage history", layout: "rows" }),
        tpl("contact", { title: "Bookings", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "filmmaker-cut",
      label: "Filmmaker Cut",
      description:
        "Cinema-dark director's page with warm amber — films up front, a frames strip, and a festivals-and-crews timeline.",
      professions: ["film-director", "cinematographer", "videographer"],
      theme: {
        background: "#101012", foreground: "#ece7dd", accent: "#d19a3d",
        surface: "#17171a", border: "#282829", muted: "#94908a",
        font: "tenor-sans", headingFont: "tenor-sans", bodyFont: "geist-sans",
        radius: "none", density: "relaxed", typeScale: "grand", lineHeight: "relaxed",
        letterSpacing: "wide", headingWeight: "light", contentWidth: "wide",
        columns: 0, buttonStyle: "outline", linkStyle: "accent", imageRatio: "16/9",
        divider: "accent", pageTransition: "fade", navLayout: "stacked", headingAlign: "left",
      },
      motion: { preset: "film-fade", duration: 750 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline} — {location}", variant: "cover", ctaLabel: "Watch the reel" }),
        tpl("projects", { title: "Films", limit: 5, layout: "featured" }),
        tpl("gallery", { title: "Frames", source: "projects", limit: 10, layout: "strip" }),
        tpl("experience", { title: "Festivals & crews", layout: "timeline" }),
        tpl("contact", { title: "Contact", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "video-editor-suite",
      label: "Video Editor Suite",
      description:
        "Edit-bay charcoal with signal-green accents in mono type — an edits-and-grades grid, suite skills, and service rows.",
      professions: ["video-editor", "colorist", "animator"],
      theme: {
        background: "#1d1f1e", foreground: "#e8ebe6", accent: "#58c470",
        surface: "#242725", border: "#333735", muted: "#8a928c",
        font: "geist-mono", headingFont: "geist-mono", bodyFont: "geist-sans",
        radius: "none", density: "compact", typeScale: "balanced", lineHeight: "tight",
        letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular",
        columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "16/9",
        divider: "line", pageTransition: "none", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "strip-slide", duration: 450 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "split", ctaLabel: "See recent edits" }),
        tpl("projects", { title: "Edits & grades", limit: 8, layout: "grid" }),
        tpl("skills", { title: "Suite & skills" }),
        tpl("services", { title: "Services", layout: "rows" }),
        tpl("contact", { title: "Available for work", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "sound-booth",
      label: "Sound Booth",
      description:
        "Foam-dark studio page with warm-orange accents — session lists, a signal-chain skill board, and bodies of work.",
      professions: ["sound-designer", "audio-engineer", "music-producer"],
      theme: {
        background: "#211d1a", foreground: "#efe8df", accent: "#e07a3f",
        surface: "#2a2521", border: "#3a332c", muted: "#a29385",
        font: "space-grotesk", headingFont: "space-grotesk", bodyFont: "geist-sans",
        radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal",
        letterSpacing: "wide", headingWeight: "semibold", contentWidth: "regular",
        columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "4/3",
        divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "cascade", duration: 550 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "classic" }),
        tpl("projects", { title: "Sessions", limit: 6, layout: "list" }),
        tpl("skills", { title: "Signal chain" }),
        tpl("collections", { title: "Bodies of work", limit: 3 }),
        tpl("contact", { title: "Get in touch", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "casting-desk",
      label: "Casting Desk",
      description:
        "Agency-light desk with cognac accents — casting services, a casting-projects grid, and a credits ledger.",
      professions: ["casting-professional"],
      theme: {
        background: "#f6f4ef", foreground: "#24211c", accent: "#9c5b2e",
        surface: "#efece4", border: "#ded8ca", muted: "#857f72",
        font: "libre-baskerville", headingFont: "libre-baskerville", bodyFont: "geist-sans",
        radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal",
        letterSpacing: "normal", headingWeight: "bold", contentWidth: "regular",
        columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "4/3",
        divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "confident-mask", duration: 600 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline} — {location}", variant: "classic", ctaLabel: "Submit for casting" }),
        tpl("services", { title: "Casting services", layout: "cards" }),
        tpl("projects", { title: "Casting projects", limit: 8, layout: "grid" }),
        tpl("experience", { title: "Experience", layout: "rows" }),
        tpl("contact", { title: "Contact", body: "{availability}" }),
      ]}],
    }),
  ];
}
