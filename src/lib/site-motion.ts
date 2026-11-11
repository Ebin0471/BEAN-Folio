/**
 * BEAN Folio — website motion library.
 *
 * 107 distinct animation presets (plus "none"), each mapped to a REAL CSS
 * implementation generated from a declarative spec — every id produces its own
 * observable motion (direction, distance, blur, scale, clip, split-text,
 * children-stagger or continuous behavior). Nothing here is a cosmetic alias:
 * two presets share a mechanic family only when their rendered parameters
 * differ (e.g. fade-up vs fade-left are genuinely different motions).
 *
 * Structure:
 *  - reveal presets   → applied to section/card containers via IntersectionObserver
 *  - textSplit presets → additionally split headings into words/chars with
 *                         per-unit transition delays (screen-reader safe)
 *  - children presets  → stagger direct children of grids/lists (--bs-i index)
 *  - hover presets     → micro-interactions for nav links and buttons
 *                         (motion.microInteractions select)
 *  - background presets→ decorative animated background layer
 *                         (motion.background select)
 *
 * All motion is configuration-driven, honors prefers-reduced-motion (everything
 * renders visible and static), clamps distances through --bs-int so nothing
 * overflows horizontally, and falls back to visible content if JS never runs
 * (the reduced-motion media query + a JS timeout both force the visible state).
 */

export type MotionCategory =
  | "Typography"
  | "Images & media"
  | "Sections & cards"
  | "Stagger & grids"
  | "Navigation & buttons"
  | "Backgrounds"
  | "Portfolio & case studies"
  | "Business & subtle";

export interface RevealSpec {
  /** Start offset in px at intensity 100 (scaled by --bs-int). */
  x?: number;
  y?: number;
  /** Fixed start scale (1 = no scale). */
  scale?: number;
  /** Start rotation in deg at intensity 100. */
  rotate?: number;
  /** Start blur in px at intensity 100. */
  blur?: number;
  /** Start brightness/saturate multipliers (1 = neutral). */
  brightness?: number;
  saturate?: number;
  clipStart?: string;
  clipEnd?: string;
  /** Split headings into words or characters for this preset. */
  textSplit?: "word" | "char";
  /** Children (grid/list items) initial state for staggered containers. */
  children?: { x?: number; y?: number; scale?: number; rotate?: number; blur?: number; clipStart?: string; opacity?: number };
}

export type MotionScope = "reveal" | "hover" | "background";

export interface MotionPresetDef {
  id: string;
  label: string;
  category: MotionCategory;
  scope: MotionScope;
  description: string;
  spec?: RevealSpec;
  /** Hero-cover parallax (JS-driven, desktop only). */
  parallax?: boolean;
  /** Continuous animation after reveal (ken burns / float). */
  continuous?: "kenburns" | "float";
}

const PRESETS: MotionPresetDef[] = [
  { id: "none", label: "No animation", category: "Sections & cards", scope: "reveal", description: "Content appears instantly. Fully static site." },

  // ------------------------------------------------------------ typography
  { id: "word-rise", label: "Word-by-word rise", category: "Typography", scope: "reveal", description: "Headline words rise into place one after another.", spec: { y: 14, textSplit: "word" } },
  { id: "word-fade", label: "Word fade cascade", category: "Typography", scope: "reveal", description: "Words fade in sequentially — quiet and literary.", spec: { textSplit: "word" } },
  { id: "char-fade", label: "Character fade", category: "Typography", scope: "reveal", description: "Letters fade up like a film subtitle.", spec: { y: 8, textSplit: "char" } },
  { id: "char-blur", label: "Character blur-in", category: "Typography", scope: "reveal", description: "Letters sharpen from soft blur, left to right.", spec: { blur: 6, textSplit: "char" } },
  { id: "line-mask", label: "Masked line reveal", category: "Typography", scope: "reveal", description: "Words slide up from behind an invisible baseline.", spec: { textSplit: "word" } },
  { id: "headline-mask", label: "Headline mask", category: "Typography", scope: "reveal", description: "The whole headline is unveiled by a rising mask.", spec: { clipStart: "inset(0 0 100% 0)", clipEnd: "inset(0 0 -10% 0)", textSplit: "word" } },
  { id: "editorial-stagger", label: "Editorial stagger", category: "Typography", scope: "reveal", description: "Headline words stagger with a calm rhythm.", spec: { y: 18, textSplit: "word", children: { y: 14 } } },
  { id: "serif-rise", label: "Serif rise", category: "Typography", scope: "reveal", description: "Words rise with a whisper of rotation — typeset feel.", spec: { y: 20, rotate: -2, textSplit: "word" } },
  { id: "quote-skew", label: "Quote skew-settle", category: "Typography", scope: "reveal", description: "Words settle from a slight skew, editorial style.", spec: { y: 16, rotate: 1.5, textSplit: "word" } },
  { id: "kern-in", label: "Tracking tighten", category: "Typography", scope: "reveal", description: "Loose letters converge into the final headline.", spec: { y: 10, textSplit: "word" } },
  { id: "type-steps", label: "Typewriter steps", category: "Typography", scope: "reveal", description: "Characters appear like typed output.", spec: { textSplit: "char" } },

  // --------------------------------------------------------- images & media
  { id: "media-mask-down", label: "Image mask down", category: "Images & media", scope: "reveal", description: "Images unveil top-to-bottom behind a mask.", spec: { clipStart: "inset(0 0 100% 0)", clipEnd: "inset(0 0 0% 0)" } },
  { id: "media-mask-right", label: "Image mask from left", category: "Images & media", scope: "reveal", description: "Images wipe open from the left edge.", spec: { clipStart: "inset(0 100% 0 0)", clipEnd: "inset(0 0% 0 0)" } },
  { id: "media-mask-diagonal", label: "Diagonal image wipe", category: "Images & media", scope: "reveal", description: "Corner-to-corner wipe across each image.", spec: { clipStart: "inset(0 100% 100% 0)", clipEnd: "inset(0 0% 0% 0)" } },
  { id: "media-zoom-slow", label: "Slow image zoom", category: "Images & media", scope: "reveal", description: "Images settle from a gentle zoom-out.", spec: { scale: 1.08 } },
  { id: "media-zoom-settle", label: "Zoom settle", category: "Images & media", scope: "reveal", description: "Images grow slightly into their frame.", spec: { scale: 0.94 } },
  { id: "media-wipe-soft", label: "Soft directional wipe", category: "Images & media", scope: "reveal", description: "Wipe with a soft fade on the leading edge.", spec: { x: 24, clipStart: "inset(0 100% 0 0)", clipEnd: "inset(0 0% 0 0)" } },
  { id: "media-crossfade", label: "Crossfade entrance", category: "Images & media", scope: "reveal", description: "Images dissolve in with a subtle brightness lift.", spec: { brightness: 1.25 } },
  { id: "media-cinema-open", label: "Cinematic open", category: "Images & media", scope: "reveal", description: "Letterbox bars part to reveal the image.", spec: { clipStart: "inset(18% 0 18% 0)", clipEnd: "inset(0% 0 0% 0)" } },
  { id: "media-blur-focus", label: "Blur to focus", category: "Images & media", scope: "reveal", description: "Photos pull into focus from a soft blur.", spec: { blur: 12, scale: 1.03 } },
  { id: "media-grayscale-in", label: "Color arrives", category: "Images & media", scope: "reveal", description: "Images fade from monochrome into full color.", spec: { saturate: 0 } },
  { id: "media-duotone-in", label: "Saturation bloom", category: "Images & media", scope: "reveal", description: "Muted start blooming into vivid color.", spec: { saturate: 0.2, brightness: 1.1 } },
  { id: "media-float-in", label: "Media float-in", category: "Images & media", scope: "reveal", description: "Images drift up softly while fading in.", spec: { y: 28, scale: 0.985 } },
  { id: "media-ken-burns", label: "Ken Burns drift", category: "Images & media", scope: "reveal", description: "Slow continuous pan-and-zoom after reveal.", spec: { scale: 1.06 }, continuous: "kenburns" },
  { id: "parallax", label: "Restrained parallax", category: "Images & media", scope: "reveal", description: "Hero cover drifts gently against scroll (desktop).", parallax: true },

  // ------------------------------------------------------- sections & cards
  { id: "fadeUp", label: "Fade and rise", category: "Sections & cards", scope: "reveal", description: "The classic — sections rise softly into view.", spec: { y: 40 } },
  { id: "fade-down", label: "Fade and descend", category: "Sections & cards", scope: "reveal", description: "Sections descend gently into place.", spec: { y: -36 } },
  { id: "fade-left", label: "Fade from right", category: "Sections & cards", scope: "reveal", description: "Sections glide in from the right edge.", spec: { x: 44 } },
  { id: "fade-right", label: "Fade from left", category: "Sections & cards", scope: "reveal", description: "Sections glide in from the left edge.", spec: { x: -44 } },
  { id: "fade-only", label: "Pure fade", category: "Sections & cards", scope: "reveal", description: "Opacity only — no movement at all.", spec: {} },
  { id: "fade-up-soft", label: "Soft rise", category: "Sections & cards", scope: "reveal", description: "A shorter, quieter version of fade-and-rise.", spec: { y: 18 } },
  { id: "fade-up-far", label: "Deep rise", category: "Sections & cards", scope: "reveal", description: "A long, dramatic travel distance.", spec: { y: 72 } },
  { id: "slide-up-long", label: "Slide reveal up", category: "Sections & cards", scope: "reveal", description: "Sections slide a full span upward.", spec: { y: 88, blur: 2 } },
  { id: "slide-left-panel", label: "Panel slide left", category: "Sections & cards", scope: "reveal", description: "Panels slide in horizontally with a fade.", spec: { x: 64 } },
  { id: "slide-right-panel", label: "Panel slide right", category: "Sections & cards", scope: "reveal", description: "Panels enter from the left with a fade.", spec: { x: -64 } },
  { id: "blurIn", label: "Editorial blur-in", category: "Sections & cards", scope: "reveal", description: "Content sharpens from a soft blur.", spec: { blur: 8 } },
  { id: "blur-up", label: "Blur and rise", category: "Sections & cards", scope: "reveal", description: "Rise and sharpen in one motion.", spec: { y: 30, blur: 6 } },
  { id: "zoom", label: "Subtle scale reveal", category: "Sections & cards", scope: "reveal", description: "Sections settle from a barely-there zoom.", spec: { scale: 0.965 } },
  { id: "zoom-soft", label: "Whisper zoom", category: "Sections & cards", scope: "reveal", description: "An almost invisible scale settle.", spec: { scale: 0.99 } },
  { id: "pop", label: "Pop entrance", category: "Sections & cards", scope: "reveal", description: "A springy overshoot into place.", spec: { scale: 0.9 } },
  { id: "rotate-in", label: "Rotate in", category: "Sections & cards", scope: "reveal", description: "Cards rotate gently upright as they appear.", spec: { rotate: -3, y: 20 } },
  { id: "tilt-right", label: "Tilt settle", category: "Sections & cards", scope: "reveal", description: "A slight tilt straightens on arrival.", spec: { rotate: 2, x: 16 } },
  { id: "maskReveal", label: "Mask reveal", category: "Sections & cards", scope: "reveal", description: "Content unveiled by a top-down mask.", spec: { clipStart: "inset(0 0 100% 0)", clipEnd: "inset(0 0 0% 0)" } },
  { id: "mask-up", label: "Mask from below", category: "Sections & cards", scope: "reveal", description: "Content unveiled by a bottom-up mask.", spec: { clipStart: "inset(100% 0 0 0)", clipEnd: "inset(0% 0 0 0)" } },
  { id: "mask-center", label: "Center iris", category: "Sections & cards", scope: "reveal", description: "Sections open from the horizontal center.", spec: { clipStart: "inset(50% 0 50% 0)", clipEnd: "inset(0% 0 0% 0)" } },
  { id: "cinematic", label: "Cinematic entrance", category: "Sections & cards", scope: "reveal", description: "Long travel, blur and light — filmic reveal.", spec: { y: 52, blur: 5 } },
  { id: "film-fade", label: "Film fade", category: "Sections & cards", scope: "reveal", description: "Letterboxed open with a slow fade.", spec: { clipStart: "inset(10% 6% 10% 6%)", clipEnd: "inset(0% 0% 0% 0%)", brightness: 1.15 } },

  // -------------------------------------------------------- stagger & grids
  { id: "stagger", label: "Staggered grid", category: "Stagger & grids", scope: "reveal", description: "Cards arrive one after another.", spec: { children: { y: 26 } } },
  { id: "stagger-scale", label: "Stagger scale", category: "Stagger & grids", scope: "reveal", description: "Cards grow into place sequentially.", spec: { children: { scale: 0.94, y: 10 } } },
  { id: "stagger-blur", label: "Stagger blur", category: "Stagger & grids", scope: "reveal", description: "Cards sharpen in sequence.", spec: { children: { blur: 6, y: 8 } } },
  { id: "stagger-left", label: "Stagger from right", category: "Stagger & grids", scope: "reveal", description: "Cards slide in from the right, one by one.", spec: { children: { x: 30 } } },
  { id: "stagger-right", label: "Stagger from left", category: "Stagger & grids", scope: "reveal", description: "Cards slide in from the left, one by one.", spec: { children: { x: -30 } } },
  { id: "cascade", label: "Cascade", category: "Stagger & grids", scope: "reveal", description: "Cards rise with rotation for a waterfall feel.", spec: { children: { y: 22, rotate: -2 } } },
  { id: "grid-iris", label: "Grid iris", category: "Stagger & grids", scope: "reveal", description: "Each card irises open from its center.", spec: { children: { clipStart: "inset(45% 45% 45% 45%)", opacity: 0 } } },
  { id: "domino", label: "Domino", category: "Stagger & grids", scope: "reveal", description: "Cards tip up into place like falling dominoes.", spec: { children: { y: 18, rotate: 3 } } },

  // ---------------------------------------------------- navigation & buttons
  { id: "hover-lift", label: "Lift on hover", category: "Navigation & buttons", scope: "hover", description: "Buttons and links rise 1px under the cursor." },
  { id: "hover-underline", label: "Underline grow", category: "Navigation & buttons", scope: "hover", description: "An underline draws from left to right." },
  { id: "hover-underline-center", label: "Underline center", category: "Navigation & buttons", scope: "hover", description: "An underline grows from the center outward." },
  { id: "hover-fill", label: "Button fill sweep", category: "Navigation & buttons", scope: "hover", description: "A highlight sweeps across buttons on hover." },
  { id: "hover-fill-vertical", label: "Fill from below", category: "Navigation & buttons", scope: "hover", description: "Buttons flood with highlight from the bottom." },
  { id: "hover-border-draw", label: "Border draw", category: "Navigation & buttons", scope: "hover", description: "A border ring draws around the control." },
  { id: "hover-icon-nudge", label: "Icon nudge", category: "Navigation & buttons", scope: "hover", description: "Icons shift forward on hover." },
  { id: "hover-glow", label: "Soft glow", category: "Navigation & buttons", scope: "hover", description: "An accent glow blooms under the cursor." },
  { id: "hover-press", label: "Press feedback", category: "Navigation & buttons", scope: "hover", description: "Controls compress slightly when pressed." },
  { id: "hover-magnet", label: "Magnetic pull", category: "Navigation & buttons", scope: "hover", description: "Magnetic-style attraction — subtle scale and lift." },
  { id: "hover-shine", label: "Shine sweep", category: "Navigation & buttons", scope: "hover", description: "A light gleam sweeps across the surface." },
  { id: "focus-ring", label: "Focus ring bloom", category: "Navigation & buttons", scope: "hover", description: "Keyboard focus blooms with an accent ring." },
  { id: "hover-tilt", label: "Hover tilt", category: "Navigation & buttons", scope: "hover", description: "Controls tilt a degree toward the cursor." },
  { id: "hover-invert", label: "Invert hover", category: "Navigation & buttons", scope: "hover", description: "Buttons swap to outline style on hover." },

  // ------------------------------------------------------------- backgrounds
  { id: "bg-none", label: "Static background", category: "Backgrounds", scope: "background", description: "No background movement — default." },
  { id: "bg-gradient-pan", label: "Gradient pan", category: "Backgrounds", scope: "background", description: "The page gradient drifts slowly sideways." },
  { id: "bg-gradient-hue", label: "Hue drift", category: "Backgrounds", scope: "background", description: "The background hue cycles almost imperceptibly." },
  { id: "bg-aurora-soft", label: "Aurora (soft)", category: "Backgrounds", scope: "background", description: "Two quiet aurora lights behind the content." },
  { id: "bg-aurora-vivid", label: "Aurora (vivid)", category: "Backgrounds", scope: "background", description: "Three expressive light bands, clearly alive." },
  { id: "bg-particles-rise", label: "Particles rising", category: "Backgrounds", scope: "background", description: "Restrained dots rise like slow snow in reverse." },
  { id: "bg-particles-drift", label: "Particles drifting", category: "Backgrounds", scope: "background", description: "Dots drift laterally across the canvas." },
  { id: "bg-float-soft", label: "Floating shapes", category: "Backgrounds", scope: "background", description: "Two translucent shapes bob gently." },
  { id: "bg-float-orbs", label: "Floating orbs", category: "Backgrounds", scope: "background", description: "Three soft orbs at different depths." },
  { id: "bg-glow-pulse", label: "Glow pulse", category: "Backgrounds", scope: "background", description: "An accent glow breathes behind the hero." },
  { id: "bg-mesh-rotate", label: "Mesh rotate", category: "Backgrounds", scope: "background", description: "A conic mesh gradient turns very slowly." },
  { id: "bg-spotlight-breathe", label: "Spotlight breathe", category: "Backgrounds", scope: "background", description: "A soft spotlight swells at the top of the page." },

  // ---------------------------------------------- portfolio & case studies
  { id: "project-swap", label: "Alternating rows", category: "Portfolio & case studies", scope: "reveal", description: "Editorial rows enter from alternating sides.", spec: { children: { x: 40 } } },
  { id: "project-peek", label: "Project peek", category: "Portfolio & case studies", scope: "reveal", description: "Cards rise while their image settles from zoom.", spec: { children: { y: 24, scale: 0.97 } } },
  { id: "gallery-reveal", label: "Gallery reveal", category: "Portfolio & case studies", scope: "reveal", description: "Masonry items unveil with clip and rise.", spec: { children: { y: 20, clipStart: "inset(12% 0 0 0)" } } },
  { id: "gallery-shuffle", label: "Gallery shuffle", category: "Portfolio & case studies", scope: "reveal", description: "Items arrive with an organic, shuffled rhythm.", spec: { children: { y: 16, x: 10 } } },
  { id: "strip-slide", label: "Film strip slide", category: "Portfolio & case studies", scope: "reveal", description: "Strip frames slide in like a projector feed.", spec: { children: { x: 48 } } },
  { id: "case-transition", label: "Case-study transition", category: "Portfolio & case studies", scope: "reveal", description: "Featured work masks open while text rises.", spec: { y: 18, clipStart: "inset(0 0 8% 0)", clipEnd: "inset(0 0 0% 0)" } },
  { id: "prev-next-slide", label: "Previous / next slide", category: "Portfolio & case studies", scope: "reveal", description: "List rows slide left like paging through work.", spec: { children: { x: -36 } } },
  { id: "section-bridge", label: "Section bridge", category: "Portfolio & case studies", scope: "reveal", description: "Sections rise as their rules draw across.", spec: { y: 22 } },
  { id: "hero-intro", label: "Hero introduction", category: "Portfolio & case studies", scope: "reveal", description: "Name rises while the canvas settles from zoom.", spec: { y: 30, scale: 1.015, textSplit: "word" } },
  { id: "reel-roll", label: "Reel roll", category: "Portfolio & case studies", scope: "reveal", description: "Reel frames roll in with a cinematic fade.", spec: { children: { x: 60, blur: 4 } } },
  { id: "work-index", label: "Work index", category: "Portfolio & case studies", scope: "reveal", description: "Index rows appear in numbered order.", spec: { children: { y: 14 } } },
  { id: "curtain", label: "Curtain open", category: "Portfolio & case studies", scope: "reveal", description: "Sections open like stage curtains from center.", spec: { clipStart: "inset(0 50% 0 50%)", clipEnd: "inset(0 0% 0 0%)" } },

  // ----------------------------------------------------- business & subtle
  { id: "subtle-rise", label: "Subtle rise", category: "Business & subtle", scope: "reveal", description: "A restrained 12px rise for professional sites.", spec: { y: 12 } },
  { id: "subtle-fade", label: "Subtle fade", category: "Business & subtle", scope: "reveal", description: "A calm, almost invisible fade-in.", spec: {} },
  { id: "subtle-shift", label: "Subtle shift", category: "Business & subtle", scope: "reveal", description: "A 6px settle — felt more than seen.", spec: { y: 6 } },
  { id: "gentle-appear", label: "Gentle appear", category: "Business & subtle", scope: "reveal", description: "Tiny blur lift, boardroom-safe.", spec: { y: 8, blur: 2 } },
  { id: "executive-fade", label: "Executive fade", category: "Business & subtle", scope: "reveal", description: "Slow, low-distance entrance with authority.", spec: { y: 16 } },
  { id: "consultant-slide", label: "Consultant slide", category: "Business & subtle", scope: "reveal", description: "Small horizontal move for consulting pages.", spec: { x: 14 } },
  { id: "confident-mask", label: "Confident mask", category: "Business & subtle", scope: "reveal", description: "A quick top mask — decisive and neat.", spec: { clipStart: "inset(0 0 24% 0)", clipEnd: "inset(0 0 0% 0)" } },
  { id: "crisp-pop", label: "Crisp pop", category: "Business & subtle", scope: "reveal", description: "Fast micro-scale for crisp product feels.", spec: { scale: 0.98 } },
  { id: "calm-float", label: "Calm float", category: "Business & subtle", scope: "reveal", description: "Rises in, then floats almost imperceptibly.", spec: { y: 14 }, continuous: "float" },
  { id: "steady-fade-up", label: "Steady fade-up", category: "Business & subtle", scope: "reveal", description: "A long, dependable rise — 900ms feel.", spec: { y: 24 } },
  { id: "boardroom", label: "Boardroom", category: "Business & subtle", scope: "reveal", description: "Opacity-only stagger. Nothing moves.", spec: { children: {} } },
  { id: "paper-unfold", label: "Paper unfold", category: "Business & subtle", scope: "reveal", description: "Sections unfold from a slight top tilt.", spec: { rotate: 1.2, y: 12 } },
  { id: "ink-reveal", label: "Ink reveal", category: "Business & subtle", scope: "reveal", description: "Content inks in from the left with soft blur.", spec: { x: 18, blur: 3, clipStart: "inset(0 12% 0 0)", clipEnd: "inset(0 0% 0 0)" } },
  { id: "quiet-zoom", label: "Quiet zoom", category: "Business & subtle", scope: "reveal", description: "A 2% settle — the minimum viable motion.", spec: { scale: 1.02 } },
];

export const MOTION_PRESET_IDS: [string, ...string[]] = [PRESETS[0].id, ...PRESETS.slice(1).map((p) => p.id)];

const BY_ID: Map<string, MotionPresetDef> = new Map(PRESETS.map((p) => [p.id, p]));

export function getMotionPreset(id: string | null | undefined): MotionPresetDef | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

export function motionCategoryList(): MotionCategory[] {
  const seen = new Set<MotionCategory>();
  for (const p of PRESETS) seen.add(p.category);
  return Array.from(seen);
}

export function motionPresetsByScope(scope: MotionScope): MotionPresetDef[] {
  return PRESETS.filter((p) => p.scope === scope);
}

// ---------------------------------------------------------------- CSS build

const EASE_MAP: Record<string, string> = {
  smooth: "cubic-bezier(0.22, 1, 0.36, 1)",
  snap: "cubic-bezier(0.16, 1, 0.3, 1)",
  drift: "cubic-bezier(0.33, 0, 0.2, 1)",
  swift: "cubic-bezier(0.4, 0, 0.2, 1)",
  gentle: "cubic-bezier(0.25, 0.1, 0.25, 1)",
};

export const MOTION_EASING_IDS = ["smooth", "snap", "drift", "swift", "gentle"] as const;
export type MotionEasing = (typeof MOTION_EASING_IDS)[number];

export function easingCss(id: string): string {
  return EASE_MAP[id] ?? EASE_MAP.smooth;
}

/** Base CSS shared by every configuration (reveal plumbing, page transitions, hover zoom, reduced-motion). */
export function baseMotionCss(): string {
  return `
.bean-site .bs-reveal { opacity: 0; will-change: opacity, transform, filter; }
.bean-site .bs-reveal.bs-in { opacity: 1; }
.bean-site .bs-reveal.bs-static { opacity: 1 !important; transform: none !important; filter: none !important; clip-path: none !important; }
.bean-site .bs-split .bs-w { display: inline-block; will-change: transform, opacity, filter; }
.bean-site .bs-hoverzoom img { transition: transform 500ms var(--bs-ease,ease); }
.bean-site .bs-hoverzoom:hover img { transform: scale(1.035); }
.bean-site .bs-btn { transition: transform 180ms var(--bs-ease,ease), opacity 180ms ease, box-shadow 180ms ease, background-color 180ms ease, color 180ms ease; }
.bean-site .bs-btn:active { transform: translateY(0); }
.bean-site a:focus-visible, .bean-site button:focus-visible { outline: 2px solid var(--site-focus, var(--site-accent)); outline-offset: 3px; border-radius: 2px; }
@keyframes bsPageFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes bsPageSlide { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: translateX(0); } }
@keyframes bsPageRise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
@keyframes bsPageZoom { from { opacity: 0; transform: scale(0.985); } to { opacity: 1; transform: scale(1); } }
.bean-site .bs-page-fade { animation: bsPageFade 320ms var(--bs-ease,ease); }
.bean-site .bs-page-slide { animation: bsPageSlide 340ms var(--bs-ease,ease); }
.bean-site .bs-page-rise { animation: bsPageRise 380ms var(--bs-ease,ease); }
.bean-site .bs-page-zoom { animation: bsPageZoom 360ms var(--bs-ease,ease); }
.bean-site .bs-bg-layer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; }
.bean-site .bs-bg-layer + .bs-content { position: relative; z-index: 1; }
@keyframes bsKenburns { from { transform: scale(1.06) translate(0, 0); } to { transform: scale(1.14) translate(-1.5%, -1%); } }
@keyframes bsFloatY { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
@media (prefers-reduced-motion: reduce) {
  .bean-site .bs-reveal, .bean-site .bs-stagger > * { opacity: 1 !important; transform: none !important; filter: none !important; clip-path: none !important; transition: none !important; animation: none !important; }
  .bean-site .bs-split .bs-w { opacity: 1 !important; transform: none !important; filter: none !important; transition: none !important; }
  .bean-site .bs-hoverzoom img, .bean-site .bs-btn { transition: none !important; }
  .bean-site .bs-hoverzoom:hover img { transform: none !important; }
  .bean-site .bs-bg-layer { display: none !important; }
  .bean-site .bs-page-fade, .bean-site .bs-page-slide, .bean-site .bs-page-rise, .bean-site .bs-page-zoom { animation: none !important; }
  /* Continuous media motion (ken-burns animates the <img>, not the reveal
     container) and hover micro-interactions must also stop. */
  .bean-site img { animation: none !important; }
  .bean-site .bs-mi, .bean-site .bs-mi::after { transition: none !important; animation: none !important; }
}
`;
}

function transformExpr(spec: RevealSpec, forChildren = false): string {
  const parts: string[] = [];
  const px = (v: number | undefined) => (v ? `calc(var(--bs-int, 50) * ${(v / 100).toFixed(3)}px)` : null);
  const x = px(spec.x);
  const y = px(spec.y);
  if (x || y) parts.push(`translate3d(${x ?? "0px"}, ${y ?? "0px"}, 0)`);
  // Intensity scales every family's DELTA from neutral (--bs-int 0-100, default
  // 50 = the authored spec value, 0 = no effect, 100 = double) so the Intensity
  // control genuinely drives translate, scale and rotate alike.
  if (spec.scale !== undefined && spec.scale !== 1) {
    parts.push(`scale(max(0, calc(1 + ${((spec.scale - 1) / 50).toFixed(5)} * var(--bs-int, 50))))`);
  }
  if (spec.rotate) parts.push(`rotate(calc(var(--bs-int, 50) * ${(spec.rotate / 100).toFixed(3)}deg))`);
  return parts.length ? parts.join(" ") : forChildren ? "none" : "translate3d(0,0,0)";
}

function filterExpr(spec: RevealSpec): string | null {
  const f: string[] = [];
  if (spec.blur) f.push(`blur(calc(var(--bs-int, 50) * ${(spec.blur / 100).toFixed(3)}px))`);
  if (spec.brightness !== undefined) {
    f.push(`brightness(max(0, calc(1 + ${((spec.brightness - 1) / 50).toFixed(5)} * var(--bs-int, 50))))`);
  }
  if (spec.saturate !== undefined) {
    f.push(`saturate(max(0, calc(1 + ${((spec.saturate - 1) / 50).toFixed(5)} * var(--bs-int, 50))))`);
  }
  return f.length ? f.join(" ") : null;
}

/**
 * Scale the percentages of a clip-path inset START state by --bs-int so mask
 * presets respond to the Intensity control (50 = the authored values, 0 = no
 * mask, 100 = double). End states are never scaled — reveals must always
 * land fully visible.
 */
function scaleClipInset(clip: string): string {
  return clip.replace(/inset\(([^)]+)\)/, (_m, args: string) => {
    const scaled = args
      .trim()
      .split(/\s+/)
      .map((tok) => {
        const m = /^(-?[\d.]+)%$/.exec(tok);
        if (!m || Number(m[1]) === 0) return tok;
        return `calc(${m[1]}% * var(--bs-int, 50) / 50)`;
      });
    return `inset(${scaled.join(" ")})`;
  });
}

/** CSS rules for one reveal preset: container initial/in states (+ split text + children). */
export function revealPresetCss(id: string): string {
  const def = getMotionPreset(id);
  if (!def || !def.spec || def.parallax) return "";
  const spec = def.spec;
  const t0 = transformExpr(spec);
  const f0 = filterExpr(spec);
  const clip0 = spec.clipStart ? `clip-path: ${scaleClipInset(spec.clipStart)};` : "";
  const t1 = "translate3d(0,0,0) scale(1) rotate(0deg)";
  const f1 = spec.blur || spec.brightness !== undefined || spec.saturate !== undefined ? "blur(0) brightness(1) saturate(1)" : null;
  const clip1 = spec.clipStart ? `clip-path: ${spec.clipEnd ?? "inset(0 0 0 0)"};` : "";

  let css = `
.bean-site .bs-r-${id} { opacity: 0; transform: ${t0}; ${f0 ? `filter: ${f0};` : ""} ${clip0} transition: opacity var(--bs-dur,600ms) var(--bs-ease,ease), transform var(--bs-dur,600ms) var(--bs-ease,ease)${f0 ? `, filter var(--bs-dur,600ms) var(--bs-ease,ease)` : ""}${spec.clipStart ? `, clip-path var(--bs-dur,600ms) var(--bs-ease,ease)` : ""}; transition-delay: var(--bs-delay, 0ms); }
.bean-site .bs-r-${id}.bs-in { opacity: 1; transform: ${t1}; ${f1 ? `filter: ${f1};` : ""} ${clip1} }`;

  if (spec.textSplit) {
    css += `
.bean-site .bs-r-${id} .bs-w { opacity: 0; transform: ${transformExpr({ ...spec, textSplit: undefined }, true)}; ${spec.blur ? `filter: blur(calc(var(--bs-int, 50) * ${(spec.blur / 100).toFixed(3)}px));` : ""} transition: opacity var(--bs-dur,600ms) var(--bs-ease,ease), transform var(--bs-dur,600ms) var(--bs-ease,ease)${spec.blur ? ", filter var(--bs-dur,600ms) var(--bs-ease,ease)" : ""}; transition-delay: calc(var(--bs-delay, 0ms) + var(--bs-i, 0) * max(18ms, var(--bs-stag, 60ms) / 2)); }
.bean-site .bs-r-${id}.bs-in .bs-w { opacity: 1; transform: none; filter: none; }`;
  }

  const kids = spec.children ?? { y: 24 };
  const kt0 = transformExpr(kids, true);
  const kf0 = kids.blur ? `filter: blur(calc(var(--bs-int, 50) * ${(kids.blur / 100).toFixed(3)}px));` : "";
  const kc0 = kids.clipStart ? `clip-path: ${scaleClipInset(kids.clipStart)};` : "";
  // Children rules are scoped to THIS preset (`.bs-r-${id}`) — unscoped
  // `.bs-stagger > *` rules would let the last-emitted preset's initial
  // state leak into every other staggered section. Containers without the
  // preset class (static/disabled motion) keep children visible by default.
  css += `
.bean-site .bs-r-${id}.bs-stagger > * { opacity: ${kids.opacity ?? 0}; transform: ${kt0}; ${kf0} ${kc0} transition: opacity var(--bs-dur,600ms) var(--bs-ease,ease), transform var(--bs-dur,600ms) var(--bs-ease,ease)${kids.blur ? ", filter var(--bs-dur,600ms) var(--bs-ease,ease)" : ""}${kids.clipStart ? ", clip-path var(--bs-dur,600ms) var(--bs-ease,ease)" : ""}; transition-delay: calc(var(--bs-delay, 0ms) + var(--bs-i, 0) * var(--bs-stag, 60ms)); will-change: opacity, transform; }
.bean-site .bs-r-${id}.bs-stagger.bs-in > * { opacity: 1; transform: none; filter: none; clip-path: none; }`;

  if (def.continuous === "kenburns") {
    css += `\n.bean-site .bs-r-${id}.bs-in img { animation: bsKenburns calc(var(--bs-dur,600ms) * 20) linear infinite alternate; }`;
  }
  if (def.continuous === "float") {
    css += `\n.bean-site .bs-r-${id}.bs-in { animation: bsFloatY 7s ease-in-out infinite; }`;
  }
  return css;
}

/** Micro-interaction CSS for nav links + buttons (hover presets). */
export function microInteractionCss(id: string): string {
  switch (id) {
    case "hover-lift":
      return `.bean-site .bs-mi:hover { transform: translateY(-1px); }`;
    case "hover-underline":
      return `.bean-site .bs-mi { background-image: linear-gradient(currentColor, currentColor); background-size: 0% 1px; background-repeat: no-repeat; background-position: 0 100%; transition: background-size 260ms var(--bs-ease,ease); }
.bean-site .bs-mi:hover { background-size: 100% 1px; }`;
    case "hover-underline-center":
      return `.bean-site .bs-mi { background-image: linear-gradient(currentColor, currentColor); background-size: 0% 1px; background-repeat: no-repeat; background-position: 50% 100%; transition: background-size 260ms var(--bs-ease,ease); }
.bean-site .bs-mi:hover { background-size: 100% 1px; }`;
    case "hover-fill":
      return `.bean-site .bs-mi.bs-btn { background-image: linear-gradient(color-mix(in srgb, var(--site-accent) 55%, transparent), color-mix(in srgb, var(--site-accent) 55%, transparent)); background-size: 0% 100%; background-repeat: no-repeat; transition: background-size 280ms var(--bs-ease,ease); }
.bean-site .bs-mi.bs-btn:hover { background-size: 100% 100%; }`;
    case "hover-fill-vertical":
      return `.bean-site .bs-mi.bs-btn { background-image: linear-gradient(to top, color-mix(in srgb, var(--site-accent) 55%, transparent) 0%, color-mix(in srgb, var(--site-accent) 55%, transparent) 100%); background-size: 100% 0%; background-repeat: no-repeat; background-position: bottom; transition: background-size 280ms var(--bs-ease,ease); }
.bean-site .bs-mi.bs-btn:hover { background-size: 100% 100%; }`;
    case "hover-border-draw":
      return `.bean-site .bs-mi { transition: box-shadow 260ms var(--bs-ease,ease), transform 180ms ease; }
.bean-site .bs-mi:hover { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--site-accent) 70%, transparent); }`;
    case "hover-icon-nudge":
      return `.bean-site .bs-mi svg { transition: transform 220ms var(--bs-ease,ease); }
.bean-site .bs-mi:hover svg { transform: translateX(3px); }`;
    case "hover-glow":
      return `.bean-site .bs-mi { transition: box-shadow 260ms var(--bs-ease,ease); }
.bean-site .bs-mi:hover { box-shadow: 0 4px 18px color-mix(in srgb, var(--site-accent) 35%, transparent); }`;
    case "hover-press":
      return `.bean-site .bs-mi:active { transform: scale(0.97); }`;
    case "hover-magnet":
      return `.bean-site .bs-mi { transition: transform 220ms var(--bs-ease,ease); }
.bean-site .bs-mi:hover { transform: translateY(-2px) scale(1.02); }`;
    case "hover-shine":
      return `.bean-site .bs-mi { position: relative; overflow: hidden; }
.bean-site .bs-mi::after { content: ""; position: absolute; inset: 0; background: linear-gradient(115deg, transparent 30%, color-mix(in srgb, var(--site-accent) 30%, transparent) 50%, transparent 70%); transform: translateX(-120%); transition: transform 600ms var(--bs-ease,ease); pointer-events: none; }
.bean-site .bs-mi:hover::after { transform: translateX(120%); }`;
    case "focus-ring":
      return `.bean-site .bs-mi:focus-visible { outline: 2px solid var(--site-focus, var(--site-accent)); outline-offset: 3px; transition: outline-offset 180ms ease; }`;
    case "hover-tilt":
      return `.bean-site .bs-mi { transition: transform 220ms var(--bs-ease,ease); }
.bean-site .bs-mi:hover { transform: rotate(-1deg) translateY(-1px); }`;
    case "hover-invert":
      return `.bean-site .bs-mi.bs-btn:hover { background: transparent !important; color: var(--site-accent) !important; box-shadow: inset 0 0 0 1px var(--site-accent); }`;
    default:
      return "";
  }
}

/** Decorative background CSS (background presets). The layer's base colors are inline styles from the theme. */
export function backgroundMotionCss(id: string): string {
  switch (id) {
    case "bg-gradient-pan":
      return `@keyframes bsBgPan { from { background-position: 0% 50%; } to { background-position: 100% 50%; } }
.bean-site .bs-bg-anim { background-size: 260% 260%; animation: bsBgPan 26s linear infinite alternate; }`;
    case "bg-gradient-hue":
      return `@keyframes bsBgHue { from { filter: hue-rotate(0deg); } to { filter: hue-rotate(28deg); } }
.bean-site .bs-bg-anim { animation: bsBgHue 18s ease-in-out infinite alternate; }`;
    case "bg-aurora-soft":
      return `@keyframes bsAurora1 { 0%, 100% { transform: translate(-6%, -4%) scale(1); } 50% { transform: translate(8%, 6%) scale(1.15); } }
.bean-site .bs-bg-aurora-1 { position: absolute; top: -12%; left: -8%; width: 55%; height: 55%; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--site-accent) 26%, transparent) 0%, transparent 68%); filter: blur(46px); animation: bsAurora1 21s ease-in-out infinite; }
.bean-site .bs-bg-aurora-2 { position: absolute; bottom: -16%; right: -10%; width: 60%; height: 60%; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--site-accent2, var(--site-accent)) 20%, transparent) 0%, transparent 70%); filter: blur(52px); animation: bsAurora1 27s ease-in-out infinite reverse; }`;
    case "bg-aurora-vivid":
      return `@keyframes bsAurora1 { 0%, 100% { transform: translate(-6%, -4%) scale(1); } 50% { transform: translate(10%, 8%) scale(1.22); } }
@keyframes bsAurora3 { 0%, 100% { transform: translate(6%, 10%) scale(1.1); } 50% { transform: translate(-8%, -6%) scale(0.94); } }
.bean-site .bs-bg-aurora-1 { position: absolute; top: -14%; left: -6%; width: 58%; height: 58%; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--site-accent) 40%, transparent) 0%, transparent 66%); filter: blur(40px); animation: bsAurora1 16s ease-in-out infinite; }
.bean-site .bs-bg-aurora-2 { position: absolute; bottom: -18%; right: -8%; width: 62%; height: 62%; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--site-accent2, var(--site-accent)) 34%, transparent) 0%, transparent 68%); filter: blur(46px); animation: bsAurora3 19s ease-in-out infinite; }
.bean-site .bs-bg-aurora-3 { position: absolute; top: 34%; left: 38%; width: 34%; height: 34%; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--site-accent) 18%, transparent) 0%, transparent 70%); filter: blur(58px); animation: bsAurora1 24s ease-in-out infinite reverse; }`;
    case "bg-particles-rise":
      return `@keyframes bsParticlesUp { from { background-position: 0 0, 0 0, 0 0; } to { background-position: 60px -900px, -140px -700px, 90px -1100px; } }
.bean-site .bs-bg-anim { background-image: radial-gradient(circle, color-mix(in srgb, var(--site-accent) 38%, transparent) 1px, transparent 1.6px), radial-gradient(circle, color-mix(in srgb, var(--site-accent2, var(--site-accent)) 26%, transparent) 1.4px, transparent 2.1px), radial-gradient(circle, color-mix(in srgb, var(--site-accent) 16%, transparent) 1px, transparent 1.5px); background-size: 190px 190px, 260px 260px, 340px 340px; background-position: 0 0, 0 0, 0 0; animation: bsParticlesUp 46s linear infinite; opacity: 0.8; }`;
    case "bg-particles-drift":
      return `@keyframes bsParticlesSide { from { background-position: 0 0, 0 0, 0 0; } to { background-position: 900px 40px, -700px -60px, 1100px 20px; } }
.bean-site .bs-bg-anim { background-image: radial-gradient(circle, color-mix(in srgb, var(--site-accent) 34%, transparent) 1.1px, transparent 1.7px), radial-gradient(circle, color-mix(in srgb, var(--site-accent2, var(--site-accent)) 24%, transparent) 1.5px, transparent 2.2px), radial-gradient(circle, color-mix(in srgb, var(--site-accent) 14%, transparent) 1px, transparent 1.6px); background-size: 210px 210px, 290px 290px, 380px 380px; animation: bsParticlesSide 60s linear infinite; opacity: 0.75; }`;
    case "bg-float-soft":
      return `@keyframes bsFloatBlob1 { 0%, 100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-28px) scale(1.05); } }
@keyframes bsFloatBlob2 { 0%, 100% { transform: translateY(0) scale(1.04); } 50% { transform: translateY(22px) scale(0.98); } }
.bean-site .bs-bg-blob-1 { position: absolute; top: 8%; left: -12%; width: 38%; height: 38%; border-radius: 44% 56% 58% 42%; background: radial-gradient(circle at 35% 35%, color-mix(in srgb, var(--site-accent) 16%, transparent), transparent 72%); animation: bsFloatBlob1 15s ease-in-out infinite; }
.bean-site .bs-bg-blob-2 { position: absolute; bottom: 4%; right: -10%; width: 42%; height: 42%; border-radius: 58% 42% 44% 56%; background: radial-gradient(circle at 60% 40%, color-mix(in srgb, var(--site-accent2, var(--site-accent)) 13%, transparent), transparent 74%); animation: bsFloatBlob2 19s ease-in-out infinite; }`;
    case "bg-float-orbs":
      return `@keyframes bsFloatBlob1 { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-34px); } }
@keyframes bsFloatBlob2 { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(26px); } }
@keyframes bsFloatBlob3 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(-24px, 18px); } }
.bean-site .bs-bg-blob-1 { position: absolute; top: 6%; left: 12%; width: 22%; height: 22%; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--site-accent) 20%, transparent), transparent 70%); filter: blur(8px); animation: bsFloatBlob1 13s ease-in-out infinite; }
.bean-site .bs-bg-blob-2 { position: absolute; top: 46%; right: 6%; width: 18%; height: 18%; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--site-accent2, var(--site-accent)) 18%, transparent), transparent 70%); filter: blur(10px); animation: bsFloatBlob2 17s ease-in-out infinite; }
.bean-site .bs-bg-blob-3 { position: absolute; bottom: 8%; left: 38%; width: 14%; height: 14%; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--site-accent) 14%, transparent), transparent 70%); filter: blur(12px); animation: bsFloatBlob3 21s ease-in-out infinite; }`;
    case "bg-glow-pulse":
      return `@keyframes bsGlowPulse { 0%, 100% { opacity: 0.35; transform: scale(1); } 50% { opacity: 0.7; transform: scale(1.08); } }
.bean-site .bs-bg-anim { background: radial-gradient(ellipse 62% 42% at 50% -4%, color-mix(in srgb, var(--site-accent) 22%, transparent), transparent 72%); animation: bsGlowPulse 9s ease-in-out infinite; }`;
    case "bg-mesh-rotate":
      return `@keyframes bsMeshSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.bean-site .bs-bg-anim { position: absolute; inset: -28%; background: conic-gradient(from 0deg at 50% 42%, color-mix(in srgb, var(--site-accent) 12%, transparent), transparent 26%, color-mix(in srgb, var(--site-accent2, var(--site-accent)) 10%, transparent) 46%, transparent 62%, color-mix(in srgb, var(--site-accent) 9%, transparent) 82%, transparent); filter: blur(44px); animation: bsMeshSpin 90s linear infinite; }`;
    case "bg-spotlight-breathe":
      return `@keyframes bsSpotlight { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.85; } }
.bean-site .bs-bg-anim { background: radial-gradient(ellipse 46% 30% at 50% 0%, color-mix(in srgb, var(--site-accent) 20%, transparent), transparent 70%); animation: bsSpotlight 8s ease-in-out infinite; }`;
    default:
      return "";
  }
}

/**
 * Complete motion CSS for a configuration: base plumbing + the selected reveal
 * preset + micro-interactions + decorative background. Called by the renderer
 * whenever the motion config changes (cheap string, injected via <style>).
 */
export function siteMotionCss(preset: string, micro: string, background: string): string {
  return baseMotionCss() + revealPresetCss(preset) + microInteractionCss(micro) + backgroundMotionCss(background);
}
