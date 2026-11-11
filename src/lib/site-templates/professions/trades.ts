/**
 * BEAN Folio — Skilled Trades & Services template family (task 4-e).
 *
 * Seven REAL, mutually distinct website templates for hands-on trades and
 * personal services. Every entry is a complete design: theme tokens, motion,
 * and a full page plan whose sections render through the standard SiteRenderer.
 *
 * Design rules honored here:
 *  - placeholder tokens only ({name} {tagline} {headline} {bio} {availability})
 *    — no invented clients, jobs, prices, or credentials
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
  // ---------------------------------------------------------------- 8
  {
    id: "chef-table",
    label: "Chef's Table",
    description: "Charcoal menu-card site for signature dishes, private dining, and plating photography.",
    professions: ["chef"],
    theme: {
      background: "#1a1713", // menu charcoal
      foreground: "#f2e9d6",
      accent: "#d99a2f", // saffron
      accent2: "#a34e35", // paprika
      surface: "#242018",
      border: "#3b3427",
      muted: "#a89d86",
      focus: "#d99a2f",
      font: "playfair-display",
      headingFont: "playfair-display",
      bodyFont: "karla",
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
      imageRatio: "4/3",
      divider: "accent",
      pageTransition: "fade",
      navLayout: "stacked",
      headingAlign: "left",
    },
    motion: { preset: "media-zoom-settle", duration: 600 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline} — {location}", variant: "cover", ctaLabel: "Book the table" }),
        tpl("projects", { title: "Signature dishes", limit: 6, layout: "featured" }),
        tpl("services", { title: "Private dining & events", layout: "rows", items: [] }),
        tpl("gallery", { title: "Plating", source: "projects", limit: 12, layout: "masonry" }),
        tpl("contact", { title: "Reservations", body: "{availability}" }),
      ],
    }],
  },

  // ---------------------------------------------------------------- 9
  {
    id: "baker-oven",
    label: "Baker's Oven",
    description: "Flour-warm bakery page for bakes, order options, and notes from the regulars.",
    professions: ["baker"],
    theme: {
      background: "#f8f1e4", // warm flour
      foreground: "#3b2d22",
      accent: "#a55f38", // cinnamon
      accent2: "#8a6f4e", // crust
      surface: "#fffbf2",
      border: "#ebdcc8",
      muted: "#97826c",
      focus: "#a55f38",
      font: "young-serif",
      headingFont: "young-serif",
      bodyFont: "nunito-sans",
      radius: "full",
      density: "regular",
      typeScale: "balanced",
      lineHeight: "normal",
      letterSpacing: "normal",
      headingWeight: "semibold",
      contentWidth: "regular",
      columns: 0,
      buttonStyle: "pill",
      linkStyle: "accent",
      imageRatio: "1/1",
      divider: "line",
      pageTransition: "fade",
      navLayout: "inline",
      headingAlign: "left",
    },
    motion: { preset: "subtle-fade", duration: 460 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline} — {location}", variant: "split", ctaLabel: "Order a bake" }),
        tpl("projects", { title: "Bakes", limit: 9, layout: "grid" }),
        tpl("services", { title: "Orders", layout: "cards", items: [] }),
        tpl("testimonials", { title: "From the regulars", layout: "cards", items: [] }),
        tpl("contact", { title: "Find the oven", body: "{availability}" }),
      ],
    }],
  },

  // ---------------------------------------------------------------- 10
  {
    id: "tailor-atelier",
    label: "Tailor Atelier",
    description: "Navy-cloth and brass atelier with a garment gallery, bespoke services, and bench history.",
    professions: ["tailor", "fashion-designer"],
    theme: {
      background: "#161c2a", // deep navy cloth
      foreground: "#e9e5d8",
      accent: "#c8a25a", // brass
      accent2: "#96694e", // lining
      surface: "#1e2637",
      border: "#343f58",
      muted: "#97a0b2",
      focus: "#c8a25a",
      font: "cormorant",
      headingFont: "cormorant",
      bodyFont: "cormorant-garamond",
      radius: "none",
      density: "regular",
      typeScale: "grand",
      lineHeight: "normal",
      letterSpacing: "wide",
      headingWeight: "semibold",
      contentWidth: "narrow",
      columns: 0,
      buttonStyle: "outline",
      linkStyle: "underline",
      imageRatio: "3/2",
      divider: "accent",
      pageTransition: "none",
      navLayout: "inline",
      headingAlign: "left",
    },
    motion: { preset: "curtain", duration: 550 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "{name}", subtitle: "{headline} — {location}", variant: "classic" }),
        tpl("gallery", { title: "Garments", source: "projects", limit: 12, layout: "grid" }),
        tpl("services", { title: "Bespoke services", layout: "rows", items: [] }),
        tpl("experience", { title: "At the bench", layout: "rows", entries: [] }),
        tpl("contact", { title: "Book a fitting", body: "{availability}" }),
      ],
    }],
  },

  // ---------------------------------------------------------------- 11
  {
    id: "barber-chair",
    label: "Barber Chair",
    description: "Dark shop-front with copper signage: a service board, cut gallery, and client notes.",
    professions: ["barber", "beautician"],
    theme: {
      background: "#1b1713", // shop dark
      foreground: "#f0ebe1",
      accent: "#c17c47", // copper
      accent2: "#8c5a3c",
      surface: "#262019",
      border: "#3d352a",
      muted: "#a39787",
      focus: "#c17c47",
      font: "oswald",
      headingFont: "oswald",
      bodyFont: "barlow",
      radius: "none",
      density: "compact",
      typeScale: "balanced",
      lineHeight: "tight",
      letterSpacing: "wide",
      headingWeight: "bold",
      contentWidth: "regular",
      columns: 0,
      buttonStyle: "sharp",
      linkStyle: "accent",
      imageRatio: "1/1",
      divider: "accent",
      pageTransition: "slide",
      navLayout: "inline",
      headingAlign: "left",
    },
    motion: { preset: "confident-mask", duration: 420 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline} — {location}", variant: "split", ctaLabel: "Book a chair" }),
        tpl("services", { title: "Services", layout: "cards", items: [] }),
        tpl("gallery", { title: "Cuts & styles", source: "projects", limit: 9, layout: "grid" }),
        tpl("testimonials", { title: "Client notes", layout: "cards", items: [] }),
        tpl("contact", { title: "Walk-ins & bookings", body: "{availability}" }),
      ],
    }],
  },

  // ---------------------------------------------------------------- 12
  {
    id: "tattoo-ink",
    label: "Tattoo Ink",
    description: "Studio-black showcase of flash sheets and large custom pieces with booking contact.",
    professions: ["tattoo-artist"],
    theme: {
      background: "#0d0d10", // studio black
      foreground: "#ebebea",
      accent: "#b3222c", // blood red
      accent2: "#6f6f76",
      surface: "#17171b",
      border: "#2c2c33",
      muted: "#8f8f96",
      focus: "#b3222c",
      font: "unbounded",
      headingFont: "unbounded",
      bodyFont: "space-grotesk",
      radius: "none",
      density: "regular",
      typeScale: "grand",
      lineHeight: "tight",
      letterSpacing: "wide",
      headingWeight: "bold",
      contentWidth: "wide",
      columns: 0,
      buttonStyle: "sharp",
      linkStyle: "underline",
      imageRatio: "1/1",
      divider: "accent",
      pageTransition: "zoom",
      navLayout: "centered",
      headingAlign: "center",
    },
    motion: { preset: "ink-reveal", duration: 600 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline}", variant: "cover", ctaLabel: "Book a session" }),
        tpl("gallery", { title: "Flash & custom", source: "projects", limit: 12, layout: "masonry" }),
        tpl("projects", { title: "Large work", limit: 4, layout: "featured" }),
        tpl("contact", { title: "Booking", body: "{availability}" }),
      ],
    }],
  },

  // ---------------------------------------------------------------- 13
  {
    id: "florist-bloom",
    label: "Florist Bloom",
    description: "Botanical cream shopfront with an arrangement gallery, occasion services, and collections.",
    professions: ["florist", "gardener"],
    theme: {
      background: "#f7f3e8", // botanical cream
      foreground: "#2f3428",
      accent: "#5d7c4c", // leaf green
      accent2: "#b46e86", // bloom pink
      surface: "#fdfbf3",
      border: "#e1ddc8",
      muted: "#8b907a",
      focus: "#5d7c4c",
      font: "forum",
      headingFont: "forum",
      bodyFont: "mulish",
      radius: "full",
      density: "regular",
      typeScale: "balanced",
      lineHeight: "normal",
      letterSpacing: "normal",
      headingWeight: "semibold",
      contentWidth: "regular",
      columns: 0,
      buttonStyle: "pill",
      linkStyle: "accent",
      imageRatio: "4/3",
      divider: "accent",
      pageTransition: "fade",
      navLayout: "centered",
      headingAlign: "center",
    },
    motion: { preset: "gallery-reveal", duration: 520 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline} — {location}", variant: "split" }),
        tpl("gallery", { title: "Arrangements", source: "projects", limit: 12, layout: "masonry" }),
        tpl("services", { title: "Occasions", layout: "rows", items: [] }),
        tpl("collections", { title: "Seasonal collections", limit: 3 }),
        tpl("contact", { title: "Order flowers", body: "{availability}" }),
      ],
    }],
  },

  // ---------------------------------------------------------------- 14
  {
    id: "trades-guild",
    label: "Trades Guild",
    description: "Workwear-navy callout board: services, recent jobs, and customer sign-offs for trade pros.",
    professions: ["electrician", "plumber", "mechanic", "carpenter"],
    theme: {
      background: "#1c2530", // workwear navy
      foreground: "#edf0ec",
      accent: "#e9bd35", // hi-vis yellow
      accent2: "#cf7434", // safety orange
      surface: "#25313f",
      border: "#3a4859",
      muted: "#9ba6b2",
      focus: "#e9bd35",
      font: "archivo",
      headingFont: "archivo",
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
      linkStyle: "accent",
      imageRatio: "16/9",
      divider: "accent",
      pageTransition: "fade",
      navLayout: "inline",
      headingAlign: "left",
    },
    motion: { preset: "work-index", duration: 400 },
    pages: [{
      id: "home",
      name: "Home",
      visible: true,
      sections: [
        tpl("hero", { title: "{name}", subtitle: "{tagline} — {location}", variant: "classic", ctaLabel: "Request a callout" }),
        tpl("services", { title: "Callout services", layout: "cards", items: [] }),
        tpl("projects", { title: "Recent jobs", limit: 6, layout: "list" }),
        tpl("testimonials", { title: "Sign-offs", layout: "cards", items: [] }),
        tpl("contact", { title: "Get a quote", body: "{availability}" }),
      ],
    }],
  },
  ];
  return templatesCache;
}

export function tradesTemplates(): TemplatePreset[] {
  return buildTemplates() as TemplatePreset[];
}
