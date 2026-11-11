/**
 * Code Giftz — the design-language registry (design intelligence).
 *
 * A design language is a complete, professional VISUAL GRAMMAR: composition
 * principles, a palette family, a typography pairing, a motion language and a
 * media direction — the way an award-winning studio would internally frame a
 * brief ("this is a cinematic piece", "this is corporate premium"). GIFTZ
 * selects one (or blends two) during creative-direction generation and every
 * generated section then follows the SAME grammar, so a website stops being a
 * checklist of sections and becomes a designed artifact.
 *
 * Every id referenced here (fonts, palettes, motion presets) is validated
 * against the REAL libraries at module scope — a language can never suggest a
 * token the schema would reject. Pure data + pure matching — safe from client
 * and server code.
 */

import { SITE_FONTS } from "@/lib/site-fonts";
import { PALETTES } from "@/lib/site-palettes";
import { MOTION_PRESET_IDS } from "@/lib/site-motion";
import { GLASS_PRESET_IDS } from "@/lib/site-config";

export const DESIGN_LANGUAGE_IDS = [
  "luxury-premium",
  "cinematic",
  "modern-minimal",
  "futuristic",
  "editorial",
  "corporate-premium",
  "creative-experimental",
  "portfolio-personal",
] as const;
export type DesignLanguageId = (typeof DESIGN_LANGUAGE_IDS)[number];

export interface DesignLanguage {
  id: DesignLanguageId;
  label: string;
  tagline: string;
  /** Words/phrases (lowercase) whose presence in a request signals this language. */
  signals: string[];
  /** Curated palette ids from lib/site-palettes that carry this language's color psychology. */
  palettes: string[];
  /** Typography pairing from the real 129-family library. */
  fonts: { heading: string; body: string; accent: string; code: string; note: string };
  /** Motion language — real preset ids + restrained values. */
  motion: {
    reveal: string;
    duration: number;
    intensity: number;
    easing: string;
    hover: string;
    background: string;
    pageTransition: "none" | "fade" | "slide" | "rise" | "zoom";
    scrollProgress: boolean;
    note: string;
  };
  /** Token direction that makes layouts feel like this language. */
  tokens: {
    typeScale: "intimate" | "balanced" | "grand";
    radius: "none" | "md" | "full";
    density: "compact" | "regular" | "relaxed";
    letterSpacing: "tight" | "normal" | "wide";
    lineHeight: "tight" | "normal" | "relaxed";
    headingWeight: "light" | "semibold" | "bold";
    contentWidth: "narrow" | "regular" | "wide";
    buttonStyle: "sharp" | "rounded" | "pill" | "outline";
    linkStyle: "underline" | "accent" | "plain";
    imageRatio: "4/3" | "3/2" | "1/1" | "16/9";
    divider: "none" | "line" | "accent";
    surfaceOpacity: number;
    glass: (typeof GLASS_PRESET_IDS)[number] | null;
  };
  /** Composition principles injected into planning + step prompts. */
  composition: string[];
  /** Which sections suit this language and HOW they should be composed. */
  sectionDirection: string;
  /** Image/media direction. */
  media: string;
  /** Responsive strategy. */
  responsive: string;
}

// --- module-scope validation: a registry referencing an unknown library id is
// --- a programming error — fail loudly instead of prompting the model with a
// --- token the schema would reject.
function assertLibraryIntegrity(langs: DesignLanguage[]): void {
  const fontIds = new Set(SITE_FONTS.map((f) => f.id));
  const paletteIds = new Set(PALETTES.map((p) => p.id));
  const presetIds = new Set(MOTION_PRESET_IDS);
  for (const lang of langs) {
    for (const [role, id] of Object.entries(lang.fonts)) {
      if (role === "note") continue;
      if (!fontIds.has(id as string)) throw new Error(`design-language "${lang.id}": unknown font id "${id}"`);
    }
    for (const pid of lang.palettes) {
      if (!paletteIds.has(pid)) throw new Error(`design-language "${lang.id}": unknown palette id "${pid}"`);
    }
    for (const preset of [lang.motion.reveal, lang.motion.hover, lang.motion.background]) {
      if (!presetIds.has(preset)) throw new Error(`design-language "${lang.id}": unknown motion preset "${preset}"`);
    }
  }
}

export const DESIGN_LANGUAGES: readonly DesignLanguage[] = [
  {
    id: "luxury-premium",
    label: "Luxury & Premium",
    tagline: "Obsidian black, champagne gold, elegant serif typography, minimal editorial composition.",
    signals: ["luxury", "premium", "elegant", "high-end", "upscale", "champagne", "obsidian", "gold", "bespoke", "exclusive", "atelier", "couture", "jewelry", "fine art", "five-star"],
    palettes: ["dark-luxury", "champagne-noir", "obsidian-silk", "metallic-luxury"],
    fonts: { heading: "fraunces", body: "geist-sans", accent: "marcellus", code: "geist-mono", note: "Elegant editorial serif for display; quiet neutral sans for body; spaced uppercase accent face for meta labels." },
    motion: { reveal: "mask-up", duration: 700, intensity: 45, easing: "smooth", hover: "hover-lift", background: "bg-float-soft", pageTransition: "fade", scrollProgress: false, note: "Restrained, deliberate reveals — masks and slow fades; motion whispers, never performs." },
    tokens: { typeScale: "grand", radius: "none", density: "relaxed", letterSpacing: "wide", lineHeight: "normal", headingWeight: "light", contentWidth: "regular", buttonStyle: "outline", linkStyle: "accent", imageRatio: "3/2", divider: "line", surfaceOpacity: 100, glass: "dark" },
    composition: [
      "Center every composition on generous negative space — luxury is proven by what the layout dares to leave empty.",
      "Use asymmetric editorial pairings (large image left, narrow text column right) rather than uniform card grids.",
      "Hairline borders and thin gold rules separate content; never boxes-with-shadows.",
      "One idea per viewport; sequence sections like chapters of a lookbook.",
    ],
    sectionDirection: "Hero is a quiet full-bleed cover or a classic banner strip with a grand serif headline. Projects render editorial (alternating image/text rows) or featured (one hero piece + quiet grid). Services render as a numbered index, never pill cards. Experience reads as a refined timeline with gold dots.",
    media: "Full-width editorial imagery with 3:2 ratio; faces and products centered with breathing room; dark imagery preferred so champagne accents stay the brightest element on the page.",
    responsive: "Mobile keeps the generous spacing but collapses to a single column; the grand serif steps down via fluid type; navigation stacks; imagery stays full-bleed with conservative cropping.",
  },
  {
    id: "cinematic",
    label: "Cinematic",
    tagline: "Immersive heroes, dramatic typography, widescreen imagery, scroll-based storytelling.",
    signals: ["cinematic", "film", "movie", "video", "reel", "showreel", "director", "editor", "motion graphics", "filmmaker", "dramatic", "immersive", "storytelling", "trailer", "screening"],
    palettes: ["cinematic-portfolio", "neo-noir", "sunset-editorial", "midnight-blue"],
    fonts: { heading: "fraunces", body: "inter", accent: "oswald", code: "geist-mono", note: "Dramatic light-weight display serif for headlines; clean sans body; condensed uppercase accent face for scene labels and timecodes." },
    motion: { reveal: "cinematic", duration: 850, intensity: 65, easing: "drift", hover: "hover-glow", background: "bg-spotlight-breathe", pageTransition: "fade", scrollProgress: true, note: "Letterbox image reveals, slow zooms and scroll-linked storytelling; a reading-progress bar tracks the film." },
    tokens: { typeScale: "grand", radius: "none", density: "relaxed", letterSpacing: "wide", lineHeight: "normal", headingWeight: "light", contentWidth: "wide", buttonStyle: "outline", linkStyle: "accent", imageRatio: "16/9", divider: "line", surfaceOpacity: 100, glass: "dark" },
    composition: [
      "Open with an immersive hero: full-bleed widescreen imagery (cover variant), gradient scrim, oversized light-weight headline — the site's title sequence.",
      "Compose each section as a scene: one dominant visual, one line of supporting text, deliberate pacing between sections.",
      "Use the strip gallery as a horizontal showreel; feature one project large, then supporting frames.",
      "High contrast: imagery darker than the page, text brighter than everything; gold reserved for moments, not surfaces.",
    ],
    sectionDirection: "Hero is the cover variant (full-bleed + parallax). Gallery renders as a strip (the showreel). Projects use featured or editorial layouts with 16:9 frames. Process/experience read as scene sequences with numbered beats. Stats render as title-card figures.",
    media: "Widescreen 16:9 hero and project imagery, cover-cropped with controlled focal points; imagery must survive the gradient scrim (darkened lower third) so overlaid text stays legible.",
    responsive: "Mobile is a vertical film: imagery full-bleed and taller-cropped, headlines step down but keep their drama, the horizontal showreel stays swipeable, parallax and background motion degrade to stills.",
  },
  {
    id: "modern-minimal",
    label: "Modern Minimal",
    tagline: "Generous whitespace, precise typography, restrained palette, strong hierarchy.",
    signals: ["minimal", "minimalist", "clean", "simple", "modern", "swiss", "understated", "quiet", "product designer", "studio", "precise", "clutter-free"],
    palettes: ["editorial-minimal", "soft-minimal", "minimalist-gallery", "high-contrast"],
    fonts: { heading: "space-grotesk", body: "inter", accent: "inter", code: "jetbrains-mono", note: "One geometric sans family doing the heavy lifting; a second neutral sans for body; mono only for meta." },
    motion: { reveal: "fadeUp", duration: 450, intensity: 35, easing: "smooth", hover: "hover-underline", background: "bg-none", pageTransition: "none", scrollProgress: false, note: "Motion exists only to confirm interaction — short fades, no decoration." },
    tokens: { typeScale: "balanced", radius: "none", density: "regular", letterSpacing: "normal", lineHeight: "relaxed", headingWeight: "semibold", contentWidth: "narrow", buttonStyle: "sharp", linkStyle: "underline", imageRatio: "4/3", divider: "line", surfaceOpacity: 100, glass: null },
    composition: [
      "Whitespace is the primary material: wide margins, tall section gaps, one focal element per viewport.",
      "Strict alignment to a single column grid; hierarchy comes from size and weight, never decoration.",
      "A single accent color, used sparingly for links and one moment per section.",
      "List and index layouts beat card grids; typography does the design work.",
    ],
    sectionDirection: "Hero is classic or centered with a large statement headline. Projects render as a list or quiet grid; about is a single well-set column; skills are plain text chips. No glass, no gradients, no bands.",
    media: "Few, deliberate images in 4:3; consistent cropping; if imagery is not essential, typography-only sections are preferred over filler images.",
    responsive: "Mobile-first single column with the same strict alignment; tap targets generous; typography scales down fluidly without losing hierarchy.",
  },
  {
    id: "futuristic",
    label: "Futuristic",
    tagline: "Dark interfaces, atmospheric gradients, layered glass, advanced motion.",
    signals: ["futuristic", "future", "tech", "ai", "developer", "engineer", "software", "sci-fi", "cyber", "neon", "glow", "space", "innovation", "robotics", "data", "3d", "webgl"],
    palettes: ["cybernetic-neon", "ultraviolet", "aurora", "liquid-glass"],
    fonts: { heading: "space-grotesk", body: "inter", accent: "unbounded", code: "geist-mono", note: "Technical grotesk display; neutral body; expressive display face reserved for one accent moment; mono for data." },
    motion: { reveal: "blurIn", duration: 550, intensity: 50, easing: "swift", hover: "hover-glow", background: "bg-aurora-soft", pageTransition: "zoom", scrollProgress: true, note: "Atmosphere over spectacle: blurred reveals, one ambient background layer, glowing hover states." },
    tokens: { typeScale: "balanced", radius: "full", density: "regular", letterSpacing: "normal", lineHeight: "normal", headingWeight: "semibold", contentWidth: "regular", buttonStyle: "rounded", linkStyle: "accent", imageRatio: "16/9", divider: "none", surfaceOpacity: 72, glass: "aurora" },
    composition: [
      "Layer depth: glass surfaces over atmospheric gradient fields, content floating above the background.",
      "Data-forward layouts — stats and skills read as instrument panels (mono figures, uppercase labels).",
      "Asymmetric split heroes with one glowing focal element; grids stay calm and technical.",
      "Accent gradients define light sources; borders are luminous edges, not boxes.",
    ],
    sectionDirection: "Hero is split or cover with atmospheric backdrop. Projects render as glass cards in a grid; skills/stats read as technical readouts; experience as a glowing timeline. Process works as a numbered system diagram.",
    media: "16:9 imagery with dark, high-tech subjects; glass cards must keep text on solid-enough tints (opacity ≥60%) for readability.",
    responsive: "Mobile drops heavy background layers, keeps glass cards solid enough for contrast, stacks the split hero, and reduces blur radius for GPU cost.",
  },
  {
    id: "editorial",
    label: "Editorial",
    tagline: "Magazine-inspired layouts, oversized typography, asymmetric compositions, rich imagery.",
    signals: ["editorial", "magazine", "journal", "writer", "author", "journalist", "publication", "press", "article", "essay", "typography", "newspaper", "byline", "story"],
    palettes: ["neo-editorial", "byline-press", "warm-paper", "swiss-grid"],
    fonts: { heading: "playfair-display", body: "source-serif-4", accent: "oswald", code: "ibm-plex-mono", note: "High-contrast display serif for headlines; readable serif body; condensed sans for kickers and bylines." },
    motion: { reveal: "editorial-stagger", duration: 550, intensity: 45, easing: "drift", hover: "hover-underline-center", background: "bg-none", pageTransition: "slide", scrollProgress: true, note: "Staggered text reveals like headlines flowing onto the page; images wipe in; motion never upstages the words." },
    tokens: { typeScale: "grand", radius: "none", density: "regular", letterSpacing: "normal", lineHeight: "relaxed", headingWeight: "semibold", contentWidth: "regular", buttonStyle: "sharp", linkStyle: "underline", imageRatio: "3/2", divider: "line", surfaceOpacity: 100, glass: null },
    composition: [
      "Oversized display headlines with kickers (small uppercase labels above); body copy in comfortable serif columns.",
      "Asymmetric two-column spreads: text column offset against a tall image column.",
      "Numbered indexes and rules (hairlines) structure content like a contents page.",
      "Pull-quote moments from testimonials rendered as large serif quotations, not cards.",
    ],
    sectionDirection: "Hero is classic with a magazine-scale headline and kicker. Projects render editorial (alternating rows) or list (article index). Experience reads as a published timeline; testimonials as serif pull quotes; process as a numbered feature spread.",
    media: "Photography treated editorially: consistent 3:2 or portrait crops, captions in accent face, generous surrounding white space.",
    responsive: "Mobile reflows spreads into a single reading column, headlines scale fluidly, the article index stays a list; bylines and rules keep the print feel.",
  },
  {
    id: "corporate-premium",
    label: "Corporate Premium",
    tagline: "Strong grids, refined typography, trust-oriented layouts, clear conversion paths.",
    signals: ["corporate", "business", "consultant", "consulting", "agency", "enterprise", "professional", "b2b", "finance", "legal", "insurance", "startup", "saas", "company", "firm", "services"],
    palettes: ["digital-product-studio", "cool-concrete", "monochrome-studio", "midnight-blue"],
    fonts: { heading: "manrope", body: "inter", accent: "manrope", code: "ibm-plex-mono", note: "Confident modern sans pairing; consistent weights; mono only for figures and labels." },
    motion: { reveal: "fadeUp", duration: 400, intensity: 30, easing: "smooth", hover: "hover-press", background: "bg-none", pageTransition: "fade", scrollProgress: false, note: "Fast, quiet, consistent — motion builds trust through responsiveness, not spectacle." },
    tokens: { typeScale: "balanced", radius: "md", density: "compact", letterSpacing: "normal", lineHeight: "normal", headingWeight: "semibold", contentWidth: "regular", buttonStyle: "rounded", linkStyle: "accent", imageRatio: "4/3", divider: "line", surfaceOpacity: 100, glass: null },
    composition: [
      "Strong consistent grid: every section answers the same column system; cards align edge-to-edge.",
      "Clear conversion path: hero states the offer, services detail it, testimonials prove it, contact closes it — CTA visible in the hero.",
      "Hierarchy through weight and spacing; statistics rendered large and exact.",
      "Restrained color: one accent carries every interactive element.",
    ],
    sectionDirection: "Hero states the value proposition with a prominent CTA. Services render as cards with crisp descriptions; process as numbered steps; testimonials as named quotes; pricing as a clean tier comparison; stats as proof figures.",
    media: "Professional imagery in 4:3, consistent tone; charts/figures preferred over decorative imagery; nothing playful in the conversion path.",
    responsive: "Mobile keeps the conversion path intact — CTA reachable without scrolling past the hero, grids collapse to single column, pricing tiers stack in comparison order.",
  },
  {
    id: "creative-experimental",
    label: "Creative Experimental",
    tagline: "Expressive typography, unusual compositions, interactive visual storytelling.",
    signals: ["creative", "experimental", "art", "artist", "playful", "bold", "brutalist", "expressive", "unusual", "collage", "pop", "colorful", "vibrant", "illustrator", "graphic design"],
    palettes: ["vibrant-creative", "experimental-art", "studio-pop", "creative-brutalist"],
    fonts: { heading: "syne", body: "dm-sans", accent: "oswald", code: "space-mono", note: "Expressive display face with character; friendly geometric body; mono for labels and marginalia." },
    motion: { reveal: "pop", duration: 500, intensity: 55, easing: "snap", hover: "hover-invert", background: "bg-particles-drift", pageTransition: "rise", scrollProgress: false, note: "Playful but bounded: springy entrances, invert hovers, one ambient layer — never motion for its own sake." },
    tokens: { typeScale: "grand", radius: "md", density: "compact", letterSpacing: "tight", lineHeight: "tight", headingWeight: "bold", contentWidth: "wide", buttonStyle: "pill", linkStyle: "underline", imageRatio: "1/1", divider: "accent", surfaceOpacity: 100, glass: null },
    composition: [
      "Composition carries personality: oversized type moments, offset elements, controlled asymmetry.",
      "Square-format imagery in dense but aligned collages; color blocks section the page.",
      "One expressive device per section (giant numeral, rotated label, marquee-like strip) — not five at once.",
      "Grid stays readable underneath the expression; experiment inside structure.",
    ],
    sectionDirection: "Hero makes a typographic statement (centered or classic with oversized headline). Gallery as masonry collage; projects as bold cards; process as numbered pop steps; skills as colorful chips.",
    media: "Square and portrait crops, high-saturation work featured at full strength; consistent edges (radius token) keep the chaos composed.",
    responsive: "Mobile keeps the energy but simplifies: single-column collage, type moments scale fluidly, hover devices swap to tap feedback.",
  },
  {
    id: "portfolio-personal",
    label: "Portfolio & Personal Branding",
    tagline: "Distinctive hero, personal identity, strong project showcases, professional storytelling.",
    signals: ["portfolio", "personal", "personal brand", "freelance", "freelancer", "about me", "my work", "creator", "maker", "coach", "teacher", "doctor", "architect", "researcher", "founder", "entrepreneur", "consultant profile"],
    palettes: ["warm-modern", "editorial-minimal", "dark-luxury", "pastel-modern"],
    fonts: { heading: "fraunces", body: "figtree", accent: "figtree", code: "geist-mono", note: "A serif display that feels personal and crafted; warm humanist body; mono only for handles and figures." },
    motion: { reveal: "stagger", duration: 600, intensity: 45, easing: "gentle", hover: "hover-lift", background: "bg-float-soft", pageTransition: "rise", scrollProgress: false, note: "Warm staggered entrances that feel like introduction, not performance." },
    tokens: { typeScale: "balanced", radius: "md", density: "regular", letterSpacing: "normal", lineHeight: "normal", headingWeight: "semibold", contentWidth: "regular", buttonStyle: "rounded", linkStyle: "accent", imageRatio: "4/3", divider: "line", surfaceOpacity: 100, glass: null },
    composition: [
      "The person is the brand: hero pairs a real avatar with a confident headline and one line of positioning.",
      "Storytelling order — who I am (about), what I have made (projects), how I work (process), what people say (testimonials), how to reach me (contact).",
      "Balanced warmth and professionalism: soft surfaces, real names, honest numbers.",
      "One accent used for identity moments (name, links, highlights) — the palette stays quiet.",
    ],
    sectionDirection: "Hero centers identity (avatar + name + positioning line + CTA). About carries the personal story; projects show featured work first; process explains the working method; faq answers real client questions.",
    media: "Real portrait photography for the avatar; project covers in 4:3 with consistent treatment; imagery of the person working beats stock decoration.",
    responsive: "Mobile keeps the personal introduction above the fold, projects stack large enough to read covers, contact is one thumb-tap away.",
  },
];

assertLibraryIntegrity([...DESIGN_LANGUAGES]);

const BY_ID = new Map<string, DesignLanguage>(DESIGN_LANGUAGES.map((l) => [l.id, l]));

export function getDesignLanguage(id: string): DesignLanguage | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Deterministic signal matching — ranks design languages by how strongly the
 * user's request echoes their vocabulary. This SHORTLISTS candidates for the
 * direction model; the model (grounded in the full registry) makes the final
 * binding choice. A request that matches nothing returns every language
 * (unranked) so the model is never forced into a wrong grammar.
 */
export function matchDesignLanguages(request: string, max = 3): DesignLanguage[] {
  const text = request.toLowerCase();
  if (!text.trim()) return [...DESIGN_LANGUAGES];
  const scored = DESIGN_LANGUAGES.map((lang) => {
    let score = 0;
    for (const signal of lang.signals) {
      if (text.includes(signal)) score += signal.includes(" ") ? 3 : 2;
    }
    // Multi-word signals are strong evidence; exact label mention is decisive.
    if (text.includes(lang.label.toLowerCase())) score += 6;
    return { lang, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return [...DESIGN_LANGUAGES];
  return scored.slice(0, max).map((s) => s.lang);
}

/** Compact registry doc for prompts — ids, taglines and the grammar each one imposes. */
export function designLanguagesDoc(): string {
  return DESIGN_LANGUAGES.map(
    (l) =>
      `- ${l.id} (${l.label}) — ${l.tagline}\n` +
      `  composition: ${l.composition[0]} ${l.composition[1] ?? ""}\n` +
      `  motion: ${l.motion.note}`
  ).join("\n");
}

/** Full grammar block for ONE selected language (injected into prompts). */
export function designLanguageGrammarDoc(id: string): string {
  const l = getDesignLanguage(id);
  if (!l) return "";
  return [
    `Design language: ${l.label} (${l.id}) — ${l.tagline}`,
    `Composition principles:`,
    ...l.composition.map((c) => `- ${c}`),
    `Typography: ${l.fonts.note}`,
    `Motion language: ${l.motion.note}`,
    `Section composition: ${l.sectionDirection}`,
    `Media direction: ${l.media}`,
    `Responsive strategy: ${l.responsive}`,
  ].join("\n");
}
