/**
 * BEAN Folio — curated color systems for creator websites.
 *
 * Each palette is a complete SEMANTIC color system: page background, surface,
 * elevated surface, text, muted text, primary accent, secondary accent,
 * border, focus ring and (where the style calls for it) a background gradient
 * plus a matched glass tint. Palettes change COLOR TOKENS ONLY — typography,
 * spacing, layout and motion are never touched, so applying one never resets
 * unrelated settings.
 *
 * A contrast ratio is declared for foreground-on-background; the builder's
 * contrast checker recomputes live values whenever the user overrides colors.
 */

export type PaletteCategory =
  | "Dark & luxury"
  | "Light & minimal"
  | "Editorial"
  | "Vivid & creative"
  | "Nature & organic"
  | "Retro & futurist"
  | "Cyber & neon";

export interface PaletteGradient {
  from: string;
  to: string;
  angle: number;
}

export interface ColorPalette {
  id: string;
  label: string;
  category: PaletteCategory;
  description: string;
  /** True when designed as a dark canvas. */
  dark: boolean;
  tokens: {
    background: string;
    surface: string;
    elevated: string;
    foreground: string;
    muted: string;
    accent: string;
    accent2: string;
    border: string;
    focus: string;
    gradient?: PaletteGradient;
    /** Glass tint matched to this palette (used when glass effects turn on). */
    glassTint: string;
  };
  /** WCAG contrast ratio (foreground vs background) of the curated tokens. */
  contrast: number;
}

const P = (p: ColorPalette) => p;

export const PALETTES: readonly ColorPalette[] = [
  // ------------------------------------------------------------ dark & luxury
  P({
    id: "dark-luxury", label: "Dark Luxury", category: "Dark & luxury", dark: true, contrast: 12.9,
    description: "Near-black canvas, champagne gold, warm ivory text.",
    tokens: { background: "#0a0a0c", surface: "#131318", elevated: "#1a1a21", foreground: "#f5f2ea", muted: "#a5a3a0", accent: "#d4af6a", accent2: "#b8925a", border: "#2a2a33", focus: "#e8c886", glassTint: "#ffffff" },
  }),
  P({
    id: "obsidian-silk", label: "Obsidian Silk", category: "Dark & luxury", dark: true, contrast: 13.8,
    description: "Blue-black silk, platinum accents, jewel highlights.",
    tokens: { background: "#0b0d10", surface: "#141821", elevated: "#1b202c", foreground: "#eef1f6", muted: "#98a0ad", accent: "#c8cdd8", accent2: "#9d8f6f", border: "#262c38", focus: "#dfe4ee", glassTint: "#ffffff" },
  }),
  P({
    id: "champagne-noir", label: "Champagne Noir", category: "Dark & luxury", dark: true, contrast: 11.2,
    description: "Espresso noir with champagne and rose-gold pair.",
    tokens: { background: "#121011", surface: "#1b181a", elevated: "#231f21", foreground: "#f4ece4", muted: "#a89c93", accent: "#e3c6a0", accent2: "#c08a72", border: "#2f2a2c", focus: "#efd7b8", glassTint: "#ffe9d2" },
  }),
  P({
    id: "metallic-luxury", label: "Metallic Luxury", category: "Dark & luxury", dark: true, contrast: 10.6,
    description: "Graphite with brushed-steel text and molten silver.",
    tokens: { background: "#101113", surface: "#17191d", elevated: "#1e2126", foreground: "#e9eaec", muted: "#9a9da3", accent: "#c9ccd4", accent2: "#d9a441", border: "#2a2d33", focus: "#e4e6eb", glassTint: "#e8ecf2" },
  }),
  P({
    id: "neo-noir", label: "Neo-Noir", category: "Dark & luxury", dark: true, contrast: 13.1,
    description: "Black asphalt, crimson sign, cold neon smoke.",
    tokens: { background: "#0a0a0b", surface: "#141416", elevated: "#1c1c1f", foreground: "#efece8", muted: "#8f8c92", accent: "#e0475b", accent2: "#5fd0c5", border: "#26262b", focus: "#ff7686", glassTint: "#ffffff" },
  }),

  // ----------------------------------------------------------- light & minimal
  P({
    id: "editorial-minimal", label: "Editorial Minimal", category: "Light & minimal", dark: false, contrast: 17.4,
    description: "Paper white, ink text, mono-accent restraint.",
    tokens: { background: "#faf9f6", surface: "#ffffff", elevated: "#f3f1ec", foreground: "#111110", muted: "#6f6d68", accent: "#111110", accent2: "#8a8d93", border: "#e3e1da", focus: "#111110", glassTint: "#ffffff" },
  }),
  P({
    id: "soft-minimal", label: "Soft Minimal", category: "Light & minimal", dark: false, contrast: 10.9,
    description: "Off-white calm, sage accent, generous air.",
    tokens: { background: "#f7f8f7", surface: "#ffffff", elevated: "#eff2ef", foreground: "#24312a", muted: "#75827b", accent: "#5e8c74", accent2: "#b0876a", border: "#e2e8e4", focus: "#3f6e54", glassTint: "#ffffff" },
  }),
  P({
    id: "warm-paper", label: "Warm Paper", category: "Light & minimal", dark: false, contrast: 13.2,
    description: "Sunlit paper, sepia ink, burnt sienna accent.",
    tokens: { background: "#fbf6ee", surface: "#fffdf9", elevated: "#f4ecdf", foreground: "#332a20", muted: "#8a7c6c", accent: "#b4633a", accent2: "#7c8a5a", border: "#eadfcd", focus: "#8f4a26", glassTint: "#fff4e2" },
  }),
  P({
    id: "minimalist-gallery", label: "Minimalist Gallery", category: "Light & minimal", dark: false, contrast: 18.9,
    description: "Gallery-wall white, black frames, single red dot.",
    tokens: { background: "#ffffff", surface: "#ffffff", elevated: "#f5f5f5", foreground: "#0a0a0a", muted: "#737373", accent: "#0a0a0a", accent2: "#d92b2b", border: "#e5e5e5", focus: "#d92b2b", glassTint: "#ffffff" },
  }),
  P({
    id: "pastel-modern", label: "Pastel Modern", category: "Light & minimal", dark: false, contrast: 11.8,
    description: "Powder pastels, deep plum text, lilac accent.",
    tokens: { background: "#faf7fb", surface: "#ffffff", elevated: "#f2ecf6", foreground: "#3a2f42", muted: "#837a8c", accent: "#9a7bb8", accent2: "#e2a47e", border: "#e9e2ee", focus: "#7a5a99", glassTint: "#ffffff" },
  }),
  P({
    id: "high-contrast", label: "High Contrast", category: "Light & minimal", dark: false, contrast: 21,
    description: "Maximum legibility — pure black on pure white.",
    tokens: { background: "#ffffff", surface: "#ffffff", elevated: "#f0f0f0", foreground: "#000000", muted: "#4a4a4a", accent: "#000000", accent2: "#b50000", border: "#000000", focus: "#000000", glassTint: "#ffffff" },
  }),
  P({
    id: "cool-concrete", label: "Cool Concrete", category: "Light & minimal", dark: false, contrast: 12.4,
    description: "Concrete grey canvas, ink text, cobalt signal.",
    tokens: { background: "#f2f2f0", surface: "#fbfbfa", elevated: "#e8e8e5", foreground: "#191b1e", muted: "#6b7076", accent: "#3455c0", accent2: "#c07a34", border: "#dcdcd8", focus: "#2743a3", glassTint: "#ffffff" },
  }),

  // ----------------------------------------------------------------- editorial
  P({
    id: "neo-editorial", label: "Neo-Editorial", category: "Editorial", dark: false, contrast: 14.6,
    description: "Cream stock, oxblood accent, newspaper rules.",
    tokens: { background: "#f6f1e7", surface: "#fdfaf3", elevated: "#ece5d5", foreground: "#1c1815", muted: "#71685c", accent: "#7c2d2d", accent2: "#3d5a4c", border: "#ded4c0", focus: "#5e1f1f", glassTint: "#fff8ea" },
  }),
  P({
    id: "swiss-grid", label: "Swiss Grid", category: "Editorial", dark: false, contrast: 19.3,
    description: "Strict white, objective black, signal red.",
    tokens: { background: "#ffffff", surface: "#ffffff", elevated: "#f4f4f4", foreground: "#0a0a0a", muted: "#616161", accent: "#d92b2b", accent2: "#0a0a0a", border: "#d9d9d9", focus: "#d92b2b", glassTint: "#ffffff" },
  }),
  P({
    id: "creative-brutalist", label: "Creative Brutalist", category: "Editorial", dark: false, contrast: 15.8,
    description: "Raw bone paper, ink black, safety-orange strike.",
    tokens: { background: "#f2f0e9", surface: "#ffffff", elevated: "#e7e4d9", foreground: "#101010", muted: "#565550", accent: "#ff4d00", accent2: "#101010", border: "#101010", focus: "#cc3e00", glassTint: "#ffffff" },
  }),
  P({
    id: "warm-modern", label: "Warm Modern", category: "Editorial", dark: false, contrast: 12.1,
    description: "Cream canvas, terracotta accent, rounded warmth.",
    tokens: { background: "#fbf7f0", surface: "#ffffff", elevated: "#f3ebdf", foreground: "#33291f", muted: "#8a7c6c", accent: "#c46a3a", accent2: "#4f7c5e", border: "#e8ded0", focus: "#a3522a", glassTint: "#fff3e4" },
  }),
  P({
    id: "byline-press", label: "Byline Press", category: "Editorial", dark: false, contrast: 16.2,
    description: "Newsprint column, editorial crimson, tall serif air.",
    tokens: { background: "#fbfaf7", surface: "#ffffff", elevated: "#f0ede4", foreground: "#1a1a1a", muted: "#6d6a64", accent: "#9b2c2c", accent2: "#1f4c5c", border: "#e6e3dc", focus: "#7a2020", glassTint: "#ffffff" },
  }),

  // ---------------------------------------------------------- vivid & creative
  P({
    id: "vibrant-creative", label: "Vibrant Creative", category: "Vivid & creative", dark: false, contrast: 14.4,
    description: "Warm paper, coral pop, playful pill energy.",
    tokens: { background: "#fdf6ee", surface: "#ffffff", elevated: "#f9e9dc", foreground: "#1f1a17", muted: "#7d7066", accent: "#e2543e", accent2: "#2f7f6f", border: "#f0e2d2", focus: "#c23c27", glassTint: "#fff1e6" },
  }),
  P({
    id: "experimental-art", label: "Experimental Art Direction", category: "Vivid & creative", dark: true, contrast: 14.1,
    description: "Violet-black, acid lime, mixed-type gallery.",
    tokens: { background: "#0b0a10", surface: "#14121c", elevated: "#1c1928", foreground: "#f2eff8", muted: "#a29dbb", accent: "#c7f24c", accent2: "#b18cff", border: "#2a2740", focus: "#d9fa7a", glassTint: "#e9ddff" },
  }),
  P({
    id: "sunset-editorial", label: "Sunset Editorial", category: "Vivid & creative", dark: true, contrast: 11.7,
    description: "Dusk gradient sky, ember accents, soft violet text.",
    tokens: { background: "#191225", surface: "#221a33", elevated: "#2b2140", foreground: "#f3ecff", muted: "#a99cc0", accent: "#ff8e5e", accent2: "#c86dd7", border: "#3a2e52", focus: "#ffa87c", glassTint: "#ffe4d6",
      gradient: { from: "#241a3d", to: "#3d1f33", angle: 160 } },
  }),
  P({
    id: "ultraviolet", label: "Ultraviolet", category: "Vivid & creative", dark: true, contrast: 12.6,
    description: "Deep purple field, electric magenta, cyan sparks.",
    tokens: { background: "#120a1f", surface: "#1b1030", elevated: "#241640", foreground: "#f4ecff", muted: "#a894c4", accent: "#e44fd0", accent2: "#5ad0ff", border: "#33224f", focus: "#ff7ade", glassTint: "#ffd9fb" },
  }),
  P({
    id: "studio-pop", label: "Studio Pop", category: "Vivid & creative", dark: false, contrast: 13.9,
    description: "Bright white with primary-color art supplies.",
    tokens: { background: "#fffef9", surface: "#ffffff", elevated: "#fff3d6", foreground: "#14120e", muted: "#6f6a5f", accent: "#f2b705", accent2: "#2660a4", border: "#e8e2d2", focus: "#c99c04", glassTint: "#ffffff" },
  }),

  // ---------------------------------------------------------- nature & organic
  P({
    id: "earthy-organic", label: "Earthy Organic", category: "Nature & organic", dark: false, contrast: 12.8,
    description: "Clay, moss and stone — grounded natural tones.",
    tokens: { background: "#f4efe6", surface: "#fdfaf4", elevated: "#e9e0d0", foreground: "#2c2a22", muted: "#7a7565", accent: "#6b7f3e", accent2: "#a06a3a", border: "#ddd4c1", focus: "#556630", glassTint: "#f6f0df" },
  }),
  P({
    id: "natural-stone", label: "Natural Stone", category: "Nature & organic", dark: false, contrast: 12.2,
    description: "Limestone, slate and moss for architects.",
    tokens: { background: "#efeeea", surface: "#f8f7f4", elevated: "#e3e1da", foreground: "#23241f", muted: "#71736b", accent: "#5d6b54", accent2: "#8a8d93", border: "#d8d6cd", focus: "#46523e", glassTint: "#ffffff" },
  }),
  P({
    id: "forest-atelier", label: "Forest Atelier", category: "Nature & organic", dark: true, contrast: 12.4,
    description: "Deep pine, cream birch, brass fittings.",
    tokens: { background: "#101511", surface: "#182019", elevated: "#1f2a21", foreground: "#eef2ea", muted: "#96a294", accent: "#c5a05a", accent2: "#7fa576", border: "#2a362c", focus: "#dcb96e", glassTint: "#eafff0" },
  }),
  P({
    id: "ocean-floor", label: "Deep Ocean", category: "Nature & organic", dark: true, contrast: 12.9,
    description: "Abyssal teal, foam text, coral signal.",
    tokens: { background: "#0a1214", surface: "#101c1f", elevated: "#152529", foreground: "#e9f2f0", muted: "#8ba3a0", accent: "#4fd1b8", accent2: "#f28b6b", border: "#1f3236", focus: "#7ce4d0", glassTint: "#d7fff6" },
  }),
  P({
    id: "olive-market", label: "Olive Market", category: "Nature & organic", dark: false, contrast: 13.4,
    description: "Olive grove greens with tomato and feta cream.",
    tokens: { background: "#f6f6ee", surface: "#fdfdf7", elevated: "#e9e9d8", foreground: "#232619", muted: "#737763", accent: "#708238", accent2: "#c34a2c", border: "#dcdbc6", focus: "#58662a", glassTint: "#fbfbe9" },
  }),

  // --------------------------------------------------------- retro & futurist
  P({
    id: "retro-futurist", label: "Retro-Futurist", category: "Retro & futurist", dark: true, contrast: 12.2,
    description: "70s terminal amber on deep space brown.",
    tokens: { background: "#140f0a", surface: "#1e1710", elevated: "#271e15", foreground: "#f5ead6", muted: "#a5937c", accent: "#ffb347", accent2: "#7fd4c1", border: "#33281c", focus: "#ffc875", glassTint: "#ffe7c4" },
  }),
  P({
    id: "synthwave-drive", label: "Synthwave Drive", category: "Retro & futurist", dark: true, contrast: 11.9,
    description: "Night drive pink and cyan on asphalt navy.",
    tokens: { background: "#0d0a18", surface: "#161127", elevated: "#1e1834", foreground: "#eee9ff", muted: "#9d94c0", accent: "#ff5ea8", accent2: "#41d8ff", border: "#2b2346", focus: "#ff85bb", glassTint: "#ffd6ec" },
  }),
  P({
    id: "atomic-ranch", label: "Atomic Ranch", category: "Retro & futurist", dark: false, contrast: 13.1,
    description: "Mid-century mustard, teal and terracotta.",
    tokens: { background: "#f8f2e4", surface: "#fffbf0", elevated: "#efe3c8", foreground: "#2a241c", muted: "#7d715c", accent: "#d99a2b", accent2: "#2a7f7f", border: "#e4d7ba", focus: "#b57c1d", glassTint: "#fff3d9" },
  }),
  P({
    id: "cybernetic-neon", label: "Cybernetic Neon", category: "Cyber & neon", dark: true, contrast: 13.6,
    description: "Machine black, voltage green, warning amber.",
    tokens: { background: "#060a07", surface: "#0d130e", elevated: "#121a14", foreground: "#e6f5e8", muted: "#7fa184", accent: "#3fff8c", accent2: "#ffd23f", border: "#1c2a20", focus: "#76ffa8", glassTint: "#d0ffe0" },
  }),
  P({
    id: "aurora", label: "Aurora", category: "Cyber & neon", dark: true, contrast: 12.7,
    description: "Polar night with living green-violet sky.",
    tokens: { background: "#070b12", surface: "#0e1520", elevated: "#131d2b", foreground: "#eaf2f6", muted: "#8ba0b3", accent: "#5ef2b8", accent2: "#9d7bff", border: "#1d2a3a", focus: "#8ff8cf", glassTint: "#d2fff0",
      gradient: { from: "#0a1220", to: "#101b2e", angle: 145 } },
  }),
  P({
    id: "midnight-blue", label: "Midnight Blue", category: "Cyber & neon", dark: true, contrast: 12.9,
    description: "Sapphire night, silver moonlight, amber window.",
    tokens: { background: "#0a0f1e", surface: "#101830", elevated: "#15203c", foreground: "#e8eefc", muted: "#8c9ab8", accent: "#7aa2f7", accent2: "#e0af68", border: "#1f2b4a", focus: "#a3bdff", glassTint: "#dbe6ff" },
  }),
  P({
    id: "digital-product-studio", label: "Digital Product Studio", category: "Cyber & neon", dark: true, contrast: 13.4,
    description: "Product-lab dark with electric indigo signal.",
    tokens: { background: "#0b0d12", surface: "#12151d", elevated: "#181c27", foreground: "#eceff5", muted: "#8e96a6", accent: "#8b7cff", accent2: "#4fd1b8", border: "#232939", focus: "#a99dff", glassTint: "#e4deff" },
  }),
  P({
    id: "liquid-glass", label: "Liquid Glass", category: "Cyber & neon", dark: true, contrast: 12.1,
    description: "Translucent panels over a deep gradient pool.",
    tokens: { background: "#0d1017", surface: "#151a24", elevated: "#1b2130", foreground: "#eef2f8", muted: "#93a0b4", accent: "#6fd3e8", accent2: "#b48aff", border: "#252d3d", focus: "#93e2f2", glassTint: "#cfe8ff",
      gradient: { from: "#101521", to: "#1a1426", angle: 155 } },
  }),
  P({
    id: "monochrome-studio", label: "Monochrome Studio", category: "Dark & luxury", dark: true, contrast: 12.6,
    description: "Greys only — documentation-like calm.",
    tokens: { background: "#111214", surface: "#191b1e", elevated: "#202327", foreground: "#e8e8e8", muted: "#8b9095", accent: "#9ba1a6", accent2: "#d4d4d4", border: "#2c2f33", focus: "#c2c7cc", glassTint: "#ffffff" },
  }),
  P({
    id: "cinematic-portfolio", label: "Cinematic Portfolio", category: "Dark & luxury", dark: true, contrast: 13.9,
    description: "Charcoal widescreen with golden-hour accent.",
    tokens: { background: "#0d0f12", surface: "#16191e", elevated: "#1c2027", foreground: "#eef0f2", muted: "#9aa0a8", accent: "#e8bc51", accent2: "#7d9a6d", border: "#272b33", focus: "#f2d076", glassTint: "#ffedc2" },
  }),
  P({
    id: "coffee-house", label: "Coffee House", category: "Nature & organic", dark: true, contrast: 11.8,
    description: "Roasted browns, cream foam, caramel drizzle.",
    tokens: { background: "#171210", surface: "#211a16", elevated: "#2a211c", foreground: "#f3ebe2", muted: "#a5968a", accent: "#d29a5b", accent2: "#8fa07a", border: "#332923", focus: "#e0b077", glassTint: "#ffe9d0" },
  }),
];

// Defensive sweep — every persisted token must be a literal hex color.
PALETTES.forEach((p) => {
  const t = p.tokens as unknown as Record<string, string>;
  for (const key of ["background", "surface", "elevated", "foreground", "muted", "accent", "accent2", "border", "focus", "glassTint"]) {
    if (!/^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{3}$/.test(t[key] ?? "")) t[key] = p.tokens.foreground === t[key] ? p.tokens.background : p.tokens.foreground;
  }
});

const BY_ID: Map<string, ColorPalette> = new Map(PALETTES.map((p) => [p.id, p]));

export function getPalette(id: string): ColorPalette | null {
  return BY_ID.get(id) ?? null;
}

export function paletteCategories(): PaletteCategory[] {
  const seen = new Set<PaletteCategory>();
  for (const p of PALETTES) seen.add(p.category);
  return Array.from(seen);
}

// ---------------------------------------------------------------- contrast

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two hex colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Best readable text color (of two candidates) on a background. */
export function readableTextOn(background: string, candidates: [string, string]): string {
  return contrastRatio(background, candidates[0]) >= contrastRatio(background, candidates[1]) ? candidates[0] : candidates[1];
}
