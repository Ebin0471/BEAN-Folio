/**
 * BEAN Folio — profession template family: Creative Arts & Design.
 *
 * Nine complete-website presets for painters, sculptors, digital artists,
 * fashion and interior work, and craft trades. Every entry is a full design
 * (structure, palette, typography, motion) authored against the shared
 * `makeSection` factory so presets pass `normalizeConfig` unchanged.
 *
 * Content rules: section bodies carry placeholder tokens only ({name}
 * {tagline} {headline} {bio} {availability}); titles describe the slot's
 * purpose. No invented clients, galleries, awards or prices.
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

export function creativeArtsTemplates(): TemplatePreset[] {
  return [
    preset({
      id: "fine-artist-canvas",
      label: "Fine Artist Canvas",
      description:
        "Gallery-white canvas with charcoal type and a vermilion accent — a masonry wall of paintings behind a full-bleed cover.",
      professions: ["painter", "sculptor"],
      theme: {
        background: "#f6f3ec", foreground: "#1a1814", accent: "#b3542e",
        surface: "#eee9df", border: "#d9d2c4", muted: "#8d8578",
        font: "fraunces", headingFont: "fraunces", bodyFont: "geist-sans",
        radius: "md", density: "relaxed", typeScale: "grand", lineHeight: "relaxed",
        letterSpacing: "normal", headingWeight: "semibold", contentWidth: "wide",
        columns: 0, buttonStyle: "outline", linkStyle: "underline", imageRatio: "4/3",
        divider: "accent", pageTransition: "fade", navLayout: "stacked", headingAlign: "left",
      },
      motion: { preset: "gallery-reveal", duration: 600 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "Studio of {name}", subtitle: "{tagline} — {location}", variant: "cover", ctaLabel: "View selected works" }),
        tpl("gallery", { title: "Selected works", source: "projects", limit: 12, layout: "masonry" }),
        tpl("about", { title: "Artist statement", body: "{bio}" }),
        tpl("collections", { title: "Series", limit: 3 }),
        tpl("contact", { title: "Enquiries", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "sculptor-atelier",
      label: "Sculptor Atelier",
      description:
        "Stone-grey atelier with a moss accent — a square-format work grid beside commissions and an exhibitions ledger.",
      professions: ["sculptor", "artisan", "craftsperson"],
      theme: {
        background: "#e9e7e2", foreground: "#26251f", accent: "#6d7758",
        surface: "#f4f2ee", border: "#d6d2c8", muted: "#7d7a6f",
        font: "cinzel", headingFont: "cinzel", bodyFont: "geist-sans",
        radius: "md", density: "regular", typeScale: "balanced", lineHeight: "normal",
        letterSpacing: "wide", headingWeight: "semibold", contentWidth: "regular",
        columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "1/1",
        divider: "line", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "serif-rise", duration: 650 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "The atelier of {name}", subtitle: "{headline} — {location}", variant: "split" }),
        tpl("gallery", { title: "Recent work", source: "projects", limit: 9, layout: "grid" }),
        tpl("projects", { title: "Commissions", limit: 6, layout: "list" }),
        tpl("experience", { title: "Exhibitions", layout: "rows" }),
        tpl("contact", { title: "Enquiries", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "digital-artist-lab",
      label: "Digital Artist Lab",
      description:
        "Deep violet-brown lab with neon-peach accents — featured hero frames, process breakdowns, and a toolkit strip.",
      professions: ["digital-artist", "vfx-artist", "3d-artist"],
      theme: {
        background: "#2a2026", foreground: "#f4ece5", accent: "#ff9e6d",
        surface: "#342831", border: "#453641", muted: "#a8928d",
        font: "syne", headingFont: "syne", bodyFont: "geist-sans",
        radius: "md", density: "compact", typeScale: "grand", lineHeight: "tight",
        letterSpacing: "normal", headingWeight: "bold", contentWidth: "wide",
        columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "16/9",
        divider: "accent", pageTransition: "zoom", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "media-mask-diagonal", duration: 600 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "cover", ctaLabel: "See selected frames" }),
        tpl("projects", { title: "Selected frames", limit: 6, layout: "featured" }),
        tpl("gallery", { title: "Process & breakdowns", source: "projects", limit: 8, layout: "grid" }),
        tpl("skills", { title: "Toolkit" }),
        tpl("contact", { title: "Book a brief", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "fashion-lookbook",
      label: "Fashion Lookbook",
      description:
        "Ivory-and-gold couture lookbook — a filmstrip gallery, seasons filed as collections, and editorial features.",
      professions: ["fashion-designer", "stylist"],
      theme: {
        background: "#faf7f0", foreground: "#16130f", accent: "#a8842c",
        surface: "#f1ece1", border: "#ddd5c5", muted: "#8f887a",
        font: "bodoni-moda", headingFont: "bodoni-moda", bodyFont: "jost",
        radius: "none", density: "relaxed", typeScale: "grand", lineHeight: "relaxed",
        letterSpacing: "wide", headingWeight: "light", contentWidth: "wide",
        columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "3/2",
        divider: "line", pageTransition: "slide", navLayout: "centered", headingAlign: "center",
      },
      motion: { preset: "curtain", duration: 700 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "cover" }),
        tpl("gallery", { title: "Lookbook", source: "projects", limit: 10, layout: "strip" }),
        tpl("collections", { title: "Seasons", limit: 3 }),
        tpl("projects", { title: "Editorial features", limit: 6, layout: "editorial" }),
        tpl("contact", { title: "Press & enquiries", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "interior-designer-muse",
      label: "Interior Designer Muse",
      description:
        "Warm neutrals with a walnut accent — featured rooms first, then a detail gallery and a scope-of-work menu.",
      professions: ["interior-designer"],
      theme: {
        background: "#f4efe7", foreground: "#2b241c", accent: "#7a5230",
        surface: "#ece5d9", border: "#d8cdbc", muted: "#8a7f6e",
        font: "marcellus", headingFont: "marcellus", bodyFont: "geist-sans",
        radius: "md", density: "relaxed", typeScale: "balanced", lineHeight: "relaxed",
        letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular",
        columns: 0, buttonStyle: "rounded", linkStyle: "accent", imageRatio: "4/3",
        divider: "accent", pageTransition: "fade", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "fade-up-soft", duration: 650 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "The studio of {name}", subtitle: "{headline} — {location}", variant: "split", ctaLabel: "Start a project" }),
        tpl("projects", { title: "Rooms & spaces", limit: 6, layout: "featured" }),
        tpl("gallery", { title: "Detail gallery", source: "projects", limit: 9, layout: "masonry" }),
        tpl("services", { title: "Scope of work", layout: "rows" }),
        tpl("contact", { title: "Start a project", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "industrial-design-lab",
      label: "Industrial Design Lab",
      description:
        "Lab-light surface with graphite ink and an orange accent — a squared product grid, capabilities, and a build timeline.",
      professions: ["industrial-designer"],
      theme: {
        background: "#f5f5f2", foreground: "#23252a", accent: "#e05e1f",
        surface: "#ffffff", border: "#dcddd8", muted: "#74767b",
        font: "space-grotesk", headingFont: "space-grotesk", bodyFont: "geist-sans",
        radius: "none", density: "compact", typeScale: "balanced", lineHeight: "tight",
        letterSpacing: "wide", headingWeight: "bold", contentWidth: "regular",
        columns: 0, buttonStyle: "sharp", linkStyle: "underline", imageRatio: "3/2",
        divider: "line", pageTransition: "none", navLayout: "inline", headingAlign: "left",
      },
      motion: { preset: "crisp-pop", duration: 450 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline} — {location}", variant: "classic" }),
        tpl("projects", { title: "Product designs", limit: 8, layout: "grid" }),
        tpl("skills", { title: "Capabilities" }),
        tpl("experience", { title: "Selected roles", layout: "timeline" }),
        tpl("contact", { title: "Contact", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "stylist-editorial",
      label: "Stylist Editorial",
      description:
        "Blush editorial board with espresso accents — masonry editorial work, service cards, and shot-list collections.",
      professions: ["stylist", "makeup-artist", "hair-artist"],
      theme: {
        background: "#f7e9e3", foreground: "#34231c", accent: "#a14e35",
        surface: "#fdf4ef", border: "#e4cdc2", muted: "#97796c",
        font: "josefin-sans", headingFont: "josefin-sans", bodyFont: "geist-sans",
        radius: "full", density: "regular", typeScale: "balanced", lineHeight: "relaxed",
        letterSpacing: "wide", headingWeight: "light", contentWidth: "regular",
        columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "3/2",
        divider: "accent", pageTransition: "rise", navLayout: "inline", headingAlign: "center",
      },
      motion: { preset: "stagger-blur", duration: 550 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "centered", ctaLabel: "View bookings" }),
        tpl("gallery", { title: "Editorial work", source: "projects", limit: 12, layout: "masonry" }),
        tpl("services", { title: "Services", layout: "cards" }),
        tpl("collections", { title: "Shot lists", limit: 3 }),
        tpl("contact", { title: "Bookings", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "beauty-bar",
      label: "Beauty Bar",
      description:
        "Warm rose with a deep plum-brown accent — service cards, a recent-work grid, and client words for salons and barbers.",
      professions: ["beautician", "barber"],
      theme: {
        background: "#f3e2db", foreground: "#3a2430", accent: "#7c4250",
        surface: "#faf0ea", border: "#e2c9c0", muted: "#9a7a80",
        font: "playfair-display", headingFont: "playfair-display", bodyFont: "geist-sans",
        radius: "full", density: "regular", typeScale: "balanced", lineHeight: "relaxed",
        letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular",
        columns: 0, buttonStyle: "pill", linkStyle: "accent", imageRatio: "4/3",
        divider: "line", pageTransition: "fade", navLayout: "centered", headingAlign: "center",
      },
      motion: { preset: "gentle-appear", duration: 550 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline} — {location}", variant: "split", ctaLabel: "Book an appointment" }),
        tpl("services", { title: "Services", layout: "cards" }),
        tpl("gallery", { title: "Recent work", source: "projects", limit: 9, layout: "grid" }),
        tpl("testimonials", { title: "Kind words", layout: "cards" }),
        tpl("contact", { title: "Book an appointment", body: "{availability}" }),
      ]}],
    }),

    preset({
      id: "pattern-maker-textile",
      label: "Pattern-Maker Textile",
      description:
        "Indigo-dyed cotton ground with terracotta accents and hand-drawn type — a pieces grid, maker's note, and cloth collections.",
      professions: ["tailor", "craftsperson"],
      theme: {
        background: "#202b3d", foreground: "#ece4d2", accent: "#c26a4a",
        surface: "#2a374d", border: "#3b4a63", muted: "#9aa4b4",
        font: "caveat", headingFont: "caveat", bodyFont: "kalam",
        radius: "md", density: "relaxed", typeScale: "grand", lineHeight: "relaxed",
        letterSpacing: "normal", headingWeight: "semibold", contentWidth: "regular",
        columns: 0, buttonStyle: "rounded", linkStyle: "underline", imageRatio: "4/3",
        divider: "accent", pageTransition: "rise", navLayout: "stacked", headingAlign: "left",
      },
      motion: { preset: "paper-unfold", duration: 650 },
      pages: [{ id: "home", name: "Home", visible: true, sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline}", variant: "classic" }),
        tpl("projects", { title: "Pieces", limit: 6, layout: "grid" }),
        tpl("about", { title: "The maker", body: "{bio}" }),
        tpl("collections", { title: "Collections", limit: 3 }),
        tpl("contact", { title: "Commissions", body: "{availability}" }),
      ]}],
    }),
  ];
}
