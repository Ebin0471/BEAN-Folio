/**
 * BEAN Folio — curated website font library.
 *
 * 100+ genuinely distinct font families for creator websites, grouped by
 * style. Every entry carries the family's real Google Fonts name, the weights
 * that actually exist for it (the loader NEVER requests a nonexistent weight —
 * that would 400 the whole css2 request), a fallback stack and a category.
 *
 * Loading strategy (efficient, graceful):
 *  - Three workhorse faces (Fraunces, Geist Sans, Geist Mono) are bundled at
 *    build time by next/font in app/layout.tsx and referenced through CSS
 *    variables — they never trigger a network font load.
 *  - Every other family is loaded on demand through a per-family Google Fonts
 *    <link> injected only when that family is actually selected (editor panel
 *    specimen, website preview or published site). Unselected fonts are never
 *    downloaded; each family gets its own link so one failed load never breaks
 *    the others, and the fallback stack keeps text readable meanwhile.
 *
 * The ids "editorial" / "clean" / "mono" from the legacy v1 config schema are
 * migrated to real families by normalizeConfig (see site-config.ts) — they are
 * NOT part of this library and must not be shown as separate choices.
 */

export type FontCategory =
  | "Editorial serif"
  | "Modern sans"
  | "Geometric sans"
  | "Grotesk"
  | "Display & expressive"
  | "Monospace"
  | "Elegant luxury"
  | "Minimal & neutral"
  | "Creative & experimental"
  | "Script & handwriting"
  | "Multilingual";

export type FontKind = "serif" | "sans" | "mono" | "display" | "script";

export interface SiteFontDef {
  /** Stable id persisted in the website config. */
  id: string;
  /** Real family name (Google Fonts), also the css2 family parameter. */
  family: string;
  category: FontCategory;
  kind: FontKind;
  /** Weights that genuinely exist on Google Fonts for this family. */
  weights: number[];
  /** True when the family is bundled via next/font (no network request). */
  bundled?: boolean;
  /** One line on the personality / best use. */
  blurb: string;
}

const w = (...weights: number[]) => weights;

const LIB: SiteFontDef[] = [
  // ---------------------------------------------------------- editorial serif
  { id: "fraunces", family: "Fraunces", category: "Editorial serif", kind: "serif", weights: w(300, 400, 500, 600, 700, 800, 900), bundled: true, blurb: "The BEAN Folio signature serif — warm, wonky, characterful." },
  { id: "playfair-display", family: "Playfair Display", category: "Editorial serif", kind: "serif", weights: w(400, 500, 600, 700, 800, 900), blurb: "High-contrast Didone for magazine-style headlines." },
  { id: "lora", family: "Lora", category: "Editorial serif", kind: "serif", weights: w(400, 500, 600, 700), blurb: "Balanced contemporary serif, comfortable at body size." },
  { id: "cormorant", family: "Cormorant", category: "Editorial serif", kind: "serif", weights: w(300, 400, 500, 600, 700), blurb: "Delicate display Garamond with old-style grace." },
  { id: "cormorant-garamond", family: "Cormorant Garamond", category: "Editorial serif", kind: "serif", weights: w(300, 400, 500, 600, 700), blurb: "Softer Garamond cut, luxury fashion editorial." },
  { id: "eb-garamond", family: "EB Garamond", category: "Editorial serif", kind: "serif", weights: w(400, 500, 600, 700, 800), blurb: "Faithful renaissance Garamond for long-form text." },
  { id: "crimson-pro", family: "Crimson Pro", category: "Editorial serif", kind: "serif", weights: w(200, 300, 400, 500, 600, 700, 800, 900), blurb: "Bookish serif tuned for screens and essays." },
  { id: "source-serif-4", family: "Source Serif 4", category: "Editorial serif", kind: "serif", weights: w(200, 300, 400, 500, 600, 700, 800, 900), blurb: "Adobe's reading serif — sturdy, modern, clear." },
  { id: "libre-caslon-text", family: "Libre Caslon Text", category: "Editorial serif", kind: "serif", weights: w(400, 700), blurb: "Classic Caslon body text with old-world authority." },
  { id: "libre-baskerville", family: "Libre Baskerville", category: "Editorial serif", kind: "serif", weights: w(400, 700), blurb: "Screen-optimized Baskerville, timeless and literary." },
  { id: "spectral", family: "Spectral", category: "Editorial serif", kind: "serif", weights: w(200, 300, 400, 500, 600, 700, 800), blurb: "Reserved serif designed for digital long-form." },
  { id: "newsreader", family: "Newsreader", category: "Editorial serif", kind: "serif", weights: w(200, 300, 400, 500, 600, 700, 800), blurb: "Journalistic serif with a strong editorial voice." },
  { id: "vollkorn", family: "Vollkorn", category: "Editorial serif", kind: "serif", weights: w(400, 500, 600, 700, 800, 900), blurb: "Dark, friendly antique serif with real presence." },
  { id: "cardo", family: "Cardo", category: "Editorial serif", kind: "serif", weights: w(400, 700), blurb: "Scholarly serif for humanities and classics." },
  { id: "neuton", family: "Neuton", category: "Editorial serif", kind: "serif", weights: w(200, 300, 400, 700, 800), blurb: "Compact newspaper serif, economical and tidy." },
  { id: "gelasio", family: "Gelasio", category: "Editorial serif", kind: "serif", weights: w(400, 500, 600, 700), blurb: "Metric-compatible Georgia alternative." },
  { id: "pt-serif", family: "PT Serif", category: "Editorial serif", kind: "serif", weights: w(400, 700), blurb: "Practical humanist serif for public-facing text." },
  { id: "noto-serif", family: "Noto Serif", category: "Editorial serif", kind: "serif", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Neutral world-serif with huge weight range." },
  { id: "merriweather", family: "Merriweather", category: "Editorial serif", kind: "serif", weights: w(300, 400, 500, 600, 700, 800, 900), blurb: "Sturdy text serif built for comfortable reading." },
  { id: "petrona", family: "Petrona", category: "Editorial serif", kind: "serif", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Variable serif mixing bookish warmth and crispness." },

  // ------------------------------------------------------------- modern sans
  { id: "geist-sans", family: "Geist", category: "Modern sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), bundled: true, blurb: "The BEAN Folio interface sans — neutral and precise." },
  { id: "inter", family: "Inter", category: "Modern sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "The product-design standard — superbly legible." },
  { id: "manrope", family: "Manrope", category: "Modern sans", kind: "sans", weights: w(200, 300, 400, 500, 600, 700, 800), blurb: "Semi-geometric sans with a technical polish." },
  { id: "public-sans", family: "Public Sans", category: "Modern sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "USWDS sans — trustworthy, institutional clarity." },
  { id: "work-sans", family: "Work Sans", category: "Modern sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Friendly grotesque for text and display alike." },
  { id: "outfit", family: "Outfit", category: "Modern sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Clean geometric sans with a youthful finish." },
  { id: "plus-jakarta-sans", family: "Plus Jakarta Sans", category: "Modern sans", kind: "sans", weights: w(200, 300, 400, 500, 600, 700, 800), blurb: "Startup-brand sans, rounded and confident." },
  { id: "figtree", family: "Figtree", category: "Modern sans", kind: "sans", weights: w(300, 400, 500, 600, 700, 800, 900), blurb: "Warm geometric sans, great for friendly brands." },
  { id: "sora", family: "Sora", category: "Modern sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800), blurb: "Tech-forward sans with an ethereum heritage." },
  { id: "urbanist", family: "Urbanist", category: "Modern sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Low-contrast geometric sans, elegant at large sizes." },
  { id: "albert-sans", family: "Albert Sans", category: "Modern sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Nordic-inspired neo-grotesque, quiet confidence." },
  { id: "onest", family: "Onest", category: "Modern sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Balanced everyday sans with open apertures." },
  { id: "geologica", family: "Geologica", category: "Modern sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Variable sans spanning many scripts and moods." },
  { id: "schibsted-grotesk", family: "Schibsted Grotesk", category: "Modern sans", kind: "sans", weights: w(400, 500, 600, 700, 800, 900), blurb: "Newsroom grotesque with editorial bite." },
  { id: "instrument-sans", family: "Instrument Sans", category: "Modern sans", kind: "sans", weights: w(400, 500, 600, 700), blurb: "Contemporary grotesque tuned for interfaces." },
  { id: "bricolage-grotesque", family: "Bricolage Grotesque", category: "Modern sans", kind: "sans", weights: w(200, 300, 400, 500, 600, 700, 800), blurb: "Expressive anti-neutral grotesque for statements." },

  // ---------------------------------------------------------- geometric sans
  { id: "poppins", family: "Poppins", category: "Geometric sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Classic geometric sans with monolinear circles." },
  { id: "montserrat", family: "Montserrat", category: "Geometric sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Urban signage sans, versatile brand favorite." },
  { id: "raleway", family: "Raleway", category: "Geometric sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Elegant thin-capable sans with distinctive W." },
  { id: "nunito-sans", family: "Nunito Sans", category: "Geometric sans", kind: "sans", weights: w(200, 300, 400, 500, 600, 700, 800, 900, 1000), blurb: "Rounded-terminal sans, approachable and clean." },
  { id: "jost", family: "Jost", category: "Geometric sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Futura-style geometric with a modern voice." },
  { id: "dm-sans", family: "DM Sans", category: "Geometric sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900, 1000), blurb: "Low-contrast geometric sans for product sites." },
  { id: "lexend", family: "Lexend", category: "Geometric sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Reading-performance sans designed for fluency." },
  { id: "red-hat-display", family: "Red Hat Display", category: "Geometric sans", kind: "sans", weights: w(300, 400, 500, 600, 700, 800, 900), blurb: "Corporate-friendly geometric with open forms." },
  { id: "questrial", family: "Questrial", category: "Geometric sans", kind: "sans", weights: w(400), blurb: "Single-weight display geometric, airy and even." },
  { id: "josefin-sans", family: "Josefin Sans", category: "Geometric sans", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700), blurb: "Vintage geometric with art-deco proportions." },

  // ------------------------------------------------------------------ grotesk
  { id: "space-grotesk", family: "Space Grotesk", category: "Grotesk", kind: "sans", weights: w(300, 400, 500, 600, 700), blurb: "Quirky tech grotesque, distinctive at headings." },
  { id: "archivo", family: "Archivo", category: "Grotesk", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Grotesque built for headlines, huge weight span." },
  { id: "roboto-flex", family: "Roboto Flex", category: "Grotesk", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900, 1000), blurb: "The adaptive grotesque with an enormous range." },
  { id: "inter-tight", family: "Inter Tight", category: "Grotesk", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Display-spaced Inter for tight headlines." },
  { id: "hanken-grotesk", family: "Hanken Grotesk", category: "Grotesk", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Nordic grotesque, humane and functional." },
  { id: "be-vietnam-pro", family: "Be Vietnam Pro", category: "Grotesk", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Grotesque with Southeast Asian design roots." },
  { id: "familjen-grotesk", family: "Familjen Grotesk", category: "Grotesk", kind: "sans", weights: w(400, 500, 600, 700), blurb: "Swedish grotesque with warmth in the details." },
  { id: "gantari", family: "Gantari", category: "Grotesk", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Multilingual grotesque, even and contemporary." },
  { id: "anek-latin", family: "Anek Latin", category: "Grotesk", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800), blurb: "Internationalist grotesque family, crisp text." },

  // ----------------------------------------------------- display & expressive
  { id: "abril-fatface", family: "Abril Fatface", category: "Display & expressive", kind: "display", weights: w(400), blurb: "Ultra-fat Didone poster face, instant drama." },
  { id: "bodoni-moda", family: "Bodoni Moda", category: "Display & expressive", kind: "display", weights: w(400, 500, 600, 700, 800, 900), blurb: "Fashion Didone with optical-size axis." },
  { id: "dm-serif-display", family: "DM Serif Display", category: "Display & expressive", kind: "display", weights: w(400), blurb: "High-contrast serif for striking hero type." },
  { id: "syne", family: "Syne", category: "Display & expressive", kind: "display", weights: w(400, 500, 600, 700, 800), blurb: "Art-institution sans, wide and experimental." },
  { id: "unbounded", family: "Unbounded", category: "Display & expressive", kind: "display", weights: w(200, 300, 400, 500, 600, 700, 800, 900), blurb: "Polkadot-derived display face, futuristic width." },
  { id: "anton", family: "Anton", category: "Display & expressive", kind: "display", weights: w(400), blurb: "Condensed impact headline, poster energy." },
  { id: "bebas-neue", family: "Bebas Neue", category: "Display & expressive", kind: "display", weights: w(400), blurb: "All-caps condensed classic for bold headers." },
  { id: "oswald", family: "Oswald", category: "Display & expressive", kind: "display", weights: w(200, 300, 400, 500, 600, 700), blurb: "Gothic condensed sans, editorial headlines." },
  { id: "archivo-black", family: "Archivo Black", category: "Display & expressive", kind: "display", weights: w(400), blurb: "Heavy grotesque poster weight." },
  { id: "big-shoulders-display", family: "Big Shoulders Display", category: "Display & expressive", kind: "display", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Chicago-inspired condensed display family." },
  { id: "italiana", family: "Italiana", category: "Display & expressive", kind: "display", weights: w(400), blurb: "Calligraphic high-fashion display serif." },
  { id: "cinzel", family: "Cinzel", category: "Display & expressive", kind: "display", weights: w(400, 500, 600, 700, 800, 900), blurb: "Roman-inscription caps, monumental elegance." },
  { id: "marcellus", family: "Marcellus", category: "Display & expressive", kind: "display", weights: w(400), blurb: "Trajan-like lapidary serif, quiet luxury." },
  { id: "prata", family: "Prata", category: "Display & expressive", kind: "display", weights: w(400), blurb: "Didone with Cyrillic roots, refined contrast." },
  { id: "young-serif", family: "Young Serif", category: "Display & expressive", kind: "display", weights: w(400), blurb: "Heavy old-style serif with a soft heart." },
  { id: "instrument-serif", family: "Instrument Serif", category: "Display & expressive", kind: "display", weights: w(400), blurb: "Editorial display serif with sharp details." },

  // ----------------------------------------------------------------- monospace
  { id: "geist-mono", family: "Geist Mono", category: "Monospace", kind: "mono", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), bundled: true, blurb: "The BEAN Folio technical mono." },
  { id: "jetbrains-mono", family: "JetBrains Mono", category: "Monospace", kind: "mono", weights: w(100, 200, 300, 400, 500, 600, 700, 800), blurb: "Developer favorite with tall x-height." },
  { id: "ibm-plex-mono", family: "IBM Plex Mono", category: "Monospace", kind: "mono", weights: w(100, 200, 300, 400, 500, 600, 700), blurb: "Engineered mono with corporate precision." },
  { id: "space-mono", family: "Space Mono", category: "Monospace", kind: "mono", weights: w(400, 700), blurb: "Retro-futurist mono with quirky details." },
  { id: "roboto-mono", family: "Roboto Mono", category: "Monospace", kind: "mono", weights: w(100, 200, 300, 400, 500, 600, 700), blurb: "The dependable default terminal mono." },
  { id: "source-code-pro", family: "Source Code Pro", category: "Monospace", kind: "mono", weights: w(200, 300, 400, 500, 600, 700, 800, 900), blurb: "Adobe's coding mono, quiet and even." },
  { id: "fira-code", family: "Fira Code", category: "Monospace", kind: "mono", weights: w(300, 400, 500, 600, 700), blurb: "Ligature-rich programmer mono." },
  { id: "courier-prime", family: "Courier Prime", category: "Monospace", kind: "mono", weights: w(400, 700), blurb: "Screenplay-grade Courier, typewriter soul." },
  { id: "martian-mono", family: "Martian Mono", category: "Monospace", kind: "mono", weights: w(100, 200, 300, 400, 500, 600, 700, 800), blurb: "Wide, sturdy mono with variable width axis." },
  { id: "red-hat-mono", family: "Red Hat Mono", category: "Monospace", kind: "mono", weights: w(300, 400, 500, 600, 700), blurb: "Friendly engineering mono." },
  { id: "anonymous-pro", family: "Anonymous Pro", category: "Monospace", kind: "mono", weights: w(400, 700), blurb: "Classic coder mono with Mac terminal roots." },
  { id: "major-mono-display", family: "Major Mono Display", category: "Monospace", kind: "mono", weights: w(400), blurb: "Mixed-case mono experiment for statements." },

  // ----------------------------------------------------------- elegant luxury
  { id: "cormorant-infant", family: "Cormorant Infant", category: "Elegant luxury", kind: "serif", weights: w(300, 400, 500, 600, 700), blurb: "Softer infant-serif cut of Cormorant." },
  { id: "gilda-display", family: "Gilda Display", category: "Elegant luxury", kind: "display", weights: w(400), blurb: "Jewelry-window serif with fine hairlines." },
  { id: "tenor-sans", family: "Tenor Sans", category: "Elegant luxury", kind: "sans", weights: w(400), blurb: "Museum-wordmark sans, understated grace." },
  { id: "didact-gothic", family: "Didact Gothic", category: "Elegant luxury", kind: "sans", weights: w(400), blurb: "Classroom-clean geometric sans." },
  { id: "julius-sans-one", family: "Julius Sans One", category: "Elegant luxury", kind: "sans", weights: w(400), blurb: "Light inscription caps for luxury headers." },
  { id: "philosopher", family: "Philosopher", category: "Elegant luxury", kind: "sans", weights: w(400, 700), blurb: "Euclidean sans with calligraphic corners." },
  { id: "forum", family: "Forum", category: "Elegant luxury", kind: "display", weights: w(400), blurb: "Roman-capital display serif, antique soul." },
  { id: "alice", family: "Alice", category: "Elegant luxury", kind: "serif", weights: w(400), blurb: "Fairy-tale Cyrillic serif, storybook warmth." },
  { id: "cormorant-sc", family: "Cormorant SC", category: "Elegant luxury", kind: "serif", weights: w(300, 400, 500, 600, 700), blurb: "Small-caps Cormorant for refined labels." },

  // -------------------------------------------------------- minimal & neutral
  { id: "karla", family: "Karla", category: "Minimal & neutral", kind: "sans", weights: w(200, 300, 400, 500, 600, 700, 800), blurb: "Grotesque with quirky humanist details." },
  { id: "mulish", family: "Mulish", category: "Minimal & neutral", kind: "sans", weights: w(200, 300, 400, 500, 600, 700, 800, 900, 1000), blurb: "Minimalist rounded sans, frictionless." },
  { id: "rubik", family: "Rubik", category: "Minimal & neutral", kind: "sans", weights: w(300, 400, 500, 600, 700, 800, 900), blurb: "Rounded-corner sans, soft neutrality." },
  { id: "barlow", family: "Barlow", category: "Minimal & neutral", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "California public-signage grotesque." },
  { id: "roboto", family: "Roboto", category: "Minimal & neutral", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "The everyday neutral with mechanical warmth." },
  { id: "open-sans", family: "Open Sans", category: "Minimal & neutral", kind: "sans", weights: w(300, 400, 500, 600, 700, 800), blurb: "The humanist web workhorse." },
  { id: "lato", family: "Lato", category: "Minimal & neutral", kind: "sans", weights: w(100, 300, 400, 700, 900), blurb: "Warm corporate sans, sandwich structure." },
  { id: "nunito", family: "Nunito", category: "Minimal & neutral", kind: "sans", weights: w(200, 300, 400, 500, 600, 700, 800, 900, 1000), blurb: "Well-rounded sans, gentle and complete." },
  { id: "ibm-plex-sans", family: "IBM Plex Sans", category: "Minimal & neutral", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700), blurb: "Engineered humanist sans with Superia DNA." },
  { id: "noto-sans", family: "Noto Sans", category: "Minimal & neutral", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "The world's neutral sans, huge coverage." },
  { id: "source-sans-3", family: "Source Sans 3", category: "Minimal & neutral", kind: "sans", weights: w(200, 300, 400, 500, 600, 700, 800, 900), blurb: "Adobe's UI sans, clean and unobtrusive." },

  // ------------------------------------------------ creative & experimental
  { id: "monoton", family: "Monoton", category: "Creative & experimental", kind: "display", weights: w(400), blurb: "Neon multiline display, retro signage." },
  { id: "gruppo", family: "Gruppo", category: "Creative & experimental", kind: "display", weights: w(400), blurb: "Hairline techno sans, sci-fi restraint." },
  { id: "syncopate", family: "Syncopate", category: "Creative & experimental", kind: "display", weights: w(400, 700), blurb: "Ultra-wide caps for experimental headers." },
  { id: "megrim", family: "Megrim", category: "Creative & experimental", kind: "display", weights: w(400), blurb: "Wireframe geometric display, blueprint feel." },
  { id: "wire-one", family: "Wire One", category: "Creative & experimental", kind: "display", weights: w(400), blurb: "Condensed hairline caps, kinetic type." },
  { id: "vt323", family: "VT323", category: "Creative & experimental", kind: "mono", weights: w(400), blurb: "Terminal bitmap aesthetic, CRT nostalgia." },
  { id: "silkscreen", family: "Silkscreen", category: "Creative & experimental", kind: "mono", weights: w(400, 700), blurb: "Pixel-perfect bitmap sans." },
  { id: "krona-one", family: "Krona One", category: "Creative & experimental", kind: "display", weights: w(400), blurb: "Heavy wide sans with techno bravado." },
  { id: "unica-one", family: "Unica One", category: "Creative & experimental", kind: "display", weights: w(400), blurb: "Condensed caps with industrial rhythm." },
  { id: "poiret-one", family: "Poiret One", category: "Creative & experimental", kind: "display", weights: w(400), blurb: "Art-deco hairline geometric, decorative." },

  // -------------------------------------------------- script & handwriting
  { id: "caveat", family: "Caveat", category: "Script & handwriting", kind: "script", weights: w(300, 400, 500, 600, 700), blurb: "Casual marker handwriting, friendly notes." },
  { id: "dancing-script", family: "Dancing Script", category: "Script & handwriting", kind: "script", weights: w(400, 500, 600, 700), blurb: "Bouncy formal script for signatures." },
  { id: "pacifico", family: "Pacifico", category: "Script & handwriting", kind: "script", weights: w(400), blurb: "Surf-brush brush script, warm roundness." },
  { id: "sacramento", family: "Sacramento", category: "Script & handwriting", kind: "script", weights: w(400), blurb: "Monoline retro script, thin and airy." },
  { id: "parisienne", family: "Parisienne", category: "Script & handwriting", kind: "script", weights: w(400), blurb: "French café script with soft connections." },
  { id: "kalam", family: "Kalam", category: "Script & handwriting", kind: "script", weights: w(300, 400, 700), blurb: "Devanagari-friendly handwriting, casual pen." },
  { id: "shadows-into-light", family: "Shadows Into Light", category: "Script & handwriting", kind: "script", weights: w(400), blurb: "Pencil-thin handwritten notes." },
  { id: "architects-daughter", family: "Architects Daughter", category: "Script & handwriting", kind: "script", weights: w(400), blurb: "Draftsman's hand-lettering, precise but human." },
  { id: "homemade-apple", family: "Homemade Apple", category: "Script & handwriting", kind: "script", weights: w(400), blurb: "Authentic ballpoint journal writing." },
  { id: "la-belle-aurore", family: "La Belle Aurore", category: "Script & handwriting", kind: "script", weights: w(400), blurb: "Loose fountain-pen correspondence script." },

  // ------------------------------------------------------------- multilingual
  { id: "noto-sans-jp", family: "Noto Sans JP", category: "Multilingual", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Japanese + Latin sans, full weight range." },
  { id: "noto-serif-jp", family: "Noto Serif JP", category: "Multilingual", kind: "serif", weights: w(200, 300, 400, 500, 600, 700, 800, 900), blurb: "Japanese Mincho-style serif with Latin support." },
  { id: "noto-sans-kr", family: "Noto Sans KR", category: "Multilingual", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Korean + Latin sans for Hangul layouts." },
  { id: "noto-sans-arabic", family: "Noto Sans Arabic", category: "Multilingual", kind: "sans", weights: w(100, 200, 300, 400, 500, 600, 700, 800, 900), blurb: "Modern Arabic + Latin companion sans." },
  { id: "hind", family: "Hind", category: "Multilingual", kind: "sans", weights: w(300, 400, 500, 600, 700), blurb: "Devanagari + Latin sans, newsroom clarity." },
  { id: "baloo-2", family: "Baloo 2", category: "Multilingual", kind: "display", weights: w(400, 500, 600, 700, 800), blurb: "Heavy rounded display for Devanagari + Latin." },
];

/** Frozen registry — indexable by id. */
export const SITE_FONTS: readonly SiteFontDef[] = LIB;

const BY_ID: Map<string, SiteFontDef> = new Map(LIB.map((f) => [f.id, f]));

export function getFont(id: string | null | undefined): SiteFontDef | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

export function fontCategoryList(): FontCategory[] {
  const seen = new Set<FontCategory>();
  for (const f of LIB) seen.add(f.category);
  return Array.from(seen);
}

/** Legacy v1 font ids → canonical library ids. */
export const LEGACY_FONT_ALIASES: Record<string, string> = {
  editorial: "fraunces",
  clean: "geist-sans",
  mono: "geist-mono",
};

/** Resolve any stored font id (legacy or current) to a library entry. */
export function resolveFont(id: string | null | undefined, fallback = "fraunces"): SiteFontDef {
  return getFont(id) ?? getFont(LEGACY_FONT_ALIASES[id ?? ""] ?? "") ?? getFont(fallback) ?? LIB[0];
}

// ---------------------------------------------------------------- stacks

const FALLBACK_TAILS: Record<FontKind, string> = {
  serif: "Georgia, 'Times New Roman', serif",
  sans: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
  display: "Georgia, 'Times New Roman', serif",
  script: "'Segoe Script', 'Comic Sans MS', cursive",
};

/** CSS font-family stack for a library id.
 *
 * Two contexts, one library:
 *  - app document (default): bundled faces resolve through the next/font CSS
 *    variables (`--font-fraunces` …) that layout.tsx installs on <body> — no
 *    network font load, exact same files the app already ships.
 *  - external documents (`external: true` — the static-site export, and any
 *    context that does NOT carry the next/font variable classes, such as an
 *    about:srcdoc preview frame without them): the variables are undefined
 *    there, and `var(--font-x), Georgia, serif` would become INVALID at
 *    computed-value time (inheriting a random ancestor font instead of even
 *    reaching the fallback). Bundled families therefore resolve to their REAL
 *    Google Fonts family names, which the external context loads via the
 *    css2 stylesheet (see googleFontsHref includeBundled).
 */
export function fontStack(id: string | null | undefined, opts: { external?: boolean } = {}): string {
  const f = resolveFont(id);
  if (f.bundled && !opts.external) {
    if (f.id === "fraunces") return "var(--font-fraunces), Georgia, serif";
    if (f.id === "geist-sans") return "var(--font-geist-sans), system-ui, sans-serif";
    if (f.id === "geist-mono") return "var(--font-geist-mono), ui-monospace, monospace";
  }
  return `'${f.family.replace(/'/g, "")}', ${FALLBACK_TAILS[f.kind]}`;
}

/**
 * Nearest weight a family actually offers (never request/assume a missing one;
 * the browser will otherwise synthesize a fake weight).
 */
export function nearestWeight(id: string | null | undefined, wanted: number): number {
  const f = resolveFont(id);
  if (f.weights.includes(wanted)) return wanted;
  let best = f.weights[0];
  for (const candidate of f.weights) {
    if (Math.abs(candidate - wanted) < Math.abs(best - wanted)) best = candidate;
  }
  return best;
}

// ---------------------------------------------------------------- loading

/** Fonts already injected into this document (per-document, survives rerenders). */
declare global {
  interface Window {
    __beanInjectedFontHrefs?: Set<string>;
  }
}

function injectedSet(doc: Document): Set<string> {
  const w = doc.defaultView ?? window;
  w.__beanInjectedFontHrefs ??= new Set();
  return w.__beanInjectedFontHrefs;
}

/**
 * Google Fonts css2 URL for a set of (family, weights). Weights are
 * intersected with each family's real weights and sorted ascending, per the
 * css2 API contract. Returns null when nothing needs a network load.
 *
 * `includeBundled` extends the request to the three bundled families
 * (Fraunces, Geist, Geist Mono — all real, OFL-licensed Google Fonts). Used
 * by the static-site export, which has no next/font variables and must load
 * every family the configuration names from the CDN instead.
 */
export function googleFontsHref(
  requests: { id: string; weights: number[] }[],
  opts: { includeBundled?: boolean } = {}
): string | null {
  const params: string[] = [];
  for (const req of requests) {
    const f = resolveFont(req.id);
    if (f.bundled && !opts.includeBundled) continue;
    const weights = Array.from(new Set(req.weights.map((wt) => nearestWeight(f.id, wt)))).sort((a, b) => a - b);
    if (weights.length === 0) continue;
    params.push(`family=${encodeURIComponent(f.family).replace(/%20/g, "+")}:wght@${weights.join(";")}`);
  }
  if (params.length === 0) return null;
  return `https://fonts.googleapis.com/css2?${params.join("&")}&display=swap`;
}

/**
 * Inject (idempotently) the font links required by a font id + weight set into
 * the given document. Safe to call during render effects from both the main
 * document and the studio's preview iframe. Each family gets its own <link>,
 * so a single unreachable family cannot break the others.
 */
export function ensureFontLoaded(doc: Document, id: string | null | undefined, weights: number[]): void {
  const f = resolveFont(id);
  if (f.bundled) return;
  const href = googleFontsHref([{ id: f.id, weights }]);
  if (!href) return;
  const seen = injectedSet(doc);
  if (seen.has(href)) return;
  seen.add(href);
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.crossOrigin = "anonymous";
  // Failed font loads fall back silently to the stack — no error surfaces.
  link.onerror = () => {
    /* graceful degradation: fallback stack applies */
  };
  doc.head.appendChild(link);
}
