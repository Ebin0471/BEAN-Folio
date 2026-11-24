/**
 * LAXII — professional art-direction compiler.
 *
 * Plain generations used to reach the engine VERBATIM, which is why vague
 * requests drifted into the generic "AI look" (dark gradients, glowing
 * lines, floating objects, plastic surfaces). This module interprets the
 * user's request into one of seven professional visual directions and
 * compiles a compact, model-appropriate directive block:
 *
 *   photorealistic-photography · cinematic · commercial-advertising ·
 *   luxury-editorial · graphic-design · 3d-render · illustration-concept-art
 *
 * Honesty rules:
 *  - classification is DETERMINISTIC (keyword scoring, no model call);
 *  - the user's own words are always included verbatim and remain the
 *    authoritative request — directives are appended guidance, never a
 *    replacement;
 *  - edits and other image-conditioned operations never receive these
 *    directives (callers decide); only fresh creations do.
 */

/** The seven professional directions LAXII can recognise. */
export type ArtDirectionId =
  | "photorealistic-photography"
  | "cinematic"
  | "commercial-advertising"
  | "luxury-editorial"
  | "graphic-design"
  | "3d-render"
  | "illustration-concept-art";

export interface ArtDirection {
  id: ArtDirectionId;
  label: string;
  /** Professional directives appended to the user's request. */
  directive: string;
  /** Keyword/phrase triggers with their weights (deterministic scoring). */
  triggers: string[];
}

const DIRECTIONS: ArtDirection[] = [
  {
    id: "photorealistic-photography",
    label: "Photorealistic photography",
    triggers: [
      "photo", "photograph", "photography", "photorealistic", "photo-realistic", "realistic", "realism",
      "portrait", "headshot", "lifestyle", "documentary", "natural light", "window light", "studio light",
      "35mm", "50mm", "85mm", "bokeh", "depth of field", "skin texture",
    ],
    directive: [
      "Art direction — photorealistic photography:",
      "- Physically plausible lighting with one dominant direction; natural falloff and believable contact shadows.",
      "- Real material textures (skin, fabric, metal, stone) with visible micro-detail; accurate perspective and proportions.",
      "- Professional camera composition: deliberate framing, natural depth of field, no artificial-looking compositing.",
      "- Avoid plastic or waxy surfaces, warped objects, extra limbs or fingers, and obviously pasted elements.",
    ].join("\n"),
  },
  {
    id: "cinematic",
    label: "Cinematic cinematography",
    triggers: [
      "cinematic", "cinematography", "movie", "film still", "filmstill", "filmic", "anamorphic", "blockbuster",
      "key art", "poster", "trailer", "dramatic lighting", "moody", "noir", "epic scene", "wide shot",
    ],
    directive: [
      "Art direction — cinematic cinematography:",
      "- Frame like a film still: motivated key light, atmosphere (haze, particles, volumetric depth), deliberate negative space.",
      "- Lens character (anamorphic flare, shallow or deep focus as the scene demands) and a filmic colour grade.",
      "- Coherent single scene with a clear focal subject; dramatic but physically plausible shadows.",
      "- Avoid neon-glow clichés, random floating objects and oversaturated gradient skies.",
    ].join("\n"),
  },
  {
    id: "commercial-advertising",
    label: "Premium commercial advertising",
    triggers: [
      "advertisement", "advert", "commercial", "product photography", "product photo", "packshot", "pack shot",
      "hero shot", "hero image", "ad campaign", "marketing", "catalog", "e-commerce", "promotional",
    ],
    directive: [
      "Art direction — premium commercial advertising:",
      "- Controlled studio setup: clean key/fill/rim lighting, seamless or purposeful set, immaculate product presentation.",
      "- Hero subject prominently placed with professional hierarchy and generous, intentional breathing room.",
      "- Crisp material rendering (reflections, refractions, labels) with faithful colours and finish.",
      "- Avoid cluttered layouts, cheap gradient backdrops and mismatched shadow directions.",
    ].join("\n"),
  },
  {
    id: "luxury-editorial",
    label: "Luxury editorial design",
    triggers: [
      "luxury", "luxurious", "premium", "editorial", "high-end", "high end", "upscale", "sophisticated",
      "elegant", "exclusive", "opulent", "refined", "marble", "champagne",
    ],
    directive: [
      "Art direction — luxury editorial:",
      "- Restrained, deliberate palette with rich, physically plausible materials (stone, brushed metal, glass, textile).",
      "- Soft dramatic lighting with long, elegant shadows; generous negative space and balanced asymmetry.",
      "- Magazine-quality polish: crisp detail where the eye lands, calm depth elsewhere; nothing loud or busy.",
      "- Avoid gaudy glow effects, rainbow gradients and cluttered ornamentation.",
    ].join("\n"),
  },
  {
    id: "graphic-design",
    label: "Professional graphic design",
    triggers: [
      "graphic design", "flat design", "vector", "brand identity", "logo design", "poster design", "layout",
      "typography poster", "geometric", "social media graphic", "social media campaign", "infographic", "banner design", "graphic",
    ],
    directive: [
      "Art direction — professional graphic design:",
      "- Deliberate composition with clear visual hierarchy: one primary element, structured supporting elements, professional alignment grid.",
      "- Controlled palette (2–4 hues) with confident flat shapes or clean gradients; consistent corner radii and stroke weights.",
      "- Calm designated space where messaging can sit; nothing competing for attention.",
      "- Avoid random clip-art objects, inconsistent styles and busy backgrounds under content areas.",
    ].join("\n"),
  },
  {
    id: "3d-render",
    label: "3D product visualization",
    triggers: [
      "3d", "3-d", "render", "rendering", "blender", "cgi", "octane", "unreal", "vray", "isometric",
      "product render", "visualization", "visualisation", "clay render", "studio render",
    ],
    directive: [
      "Art direction — 3D product visualization:",
      "- Physically-based materials with accurate reflections and refraction; crisp geometry, clean edge highlights.",
      "- Studio HDRI-style lighting with soft area shadows and subtle ambient occlusion where surfaces meet.",
      "- Believable scale and proportion; camera at a deliberate product-photography angle.",
      "- Avoid melted geometry, floating parts without support and inconsistent shadow direction.",
    ].join("\n"),
  },
  {
    id: "illustration-concept-art",
    label: "Illustration & concept art",
    triggers: [
      "illustration", "illustrated", "concept art", "conceptart", "painted", "painting", "drawing", "sketch",
      "watercolor", "watercolour", "cartoon", "anime", "manga", "storybook", "hand-drawn", "ink",
    ],
    directive: [
      "Art direction — illustration & concept art:",
      "- One consistent, confident style across the whole frame: coherent linework or brushwork, deliberate palette.",
      "- Clear silhouette and readable shapes; professional composition with a focal point and supporting detail.",
      "- Intentional texture and mark-making — the style should feel authored, not averaged.",
      "- Avoid style mixing (half photo, half cartoon), muddy colours and uneven anatomy.",
    ].join("\n"),
  },
];

/** Words whose presence must NOT steer direction on their own (too generic / brand-specific). */
const NOISE_WORDS = new Set(["photo", "render", "graphic", "light"]);

/**
 * Deterministically classify the request into one professional direction.
 * Returns null when the signal is too weak — callers then apply the
 * universal professional default instead of guessing a style.
 */
export function detectArtDirection(prompt: string): ArtDirection | null {
  const haystack = ` ${prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ")} `;
  let best: { direction: ArtDirection; score: number } | null = null;
  for (const direction of DIRECTIONS) {
    let score = 0;
    for (const trigger of direction.triggers) {
      const t = trigger.toLowerCase();
      if (!haystack.includes(` ${t} `) && !haystack.includes(` ${t}-`) && !haystack.includes(` ${t}s `)) continue;
      // Multi-word phrases are strong signals; bare words are weak ones and
      // generic tokens ("photo", "render", "graphic", "light") never steer alone.
      score += t.includes(" ") ? 3 : NOISE_WORDS.has(t) ? 0 : 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { direction, score };
  }
  // Require a real signal — a single weak keyword must not hijack the look.
  return best && best.score >= 2 ? best.direction : null;
}

/** All direction descriptors (exposed for tests/documentation). */
export function artDirections(): ArtDirection[] {
  return DIRECTIONS;
}

const UNIVERSAL_DEFAULT = [
  "Art direction — professional creative standard:",
  "- Treat this as a professional art-directed piece: one coherent scene, a clear focal subject, deliberate composition and controlled palette.",
  "- Physically plausible lighting with consistent shadow direction; real material textures; accurate perspective.",
  "- Avoid the generic AI look: no random glowing lines, no objects floating without cause, no artificial gradient soup, no plastic surfaces, no warped geometry.",
].join("\n");

const EXACT_TEXT_GUIDANCE = [
  "The request contains exact wording in quotes — render that wording EXACTLY as written, spelled correctly, in clean professional typography with readable contrast.",
  "Never invent additional words, letters, numbers, logos or watermarks beyond the quoted text.",
].join("\n");

const NO_TEXT_GUIDANCE =
  "No text was requested — do not paint letters, words, numbers, logos or watermarks into the image.";

/**
 * Compile the final engine prompt for a FRESH creation: the user's request
 * verbatim (authoritative) plus the matching professional directive block
 * and the honest text rule (exact-text guidance when the request quotes
 * wording, an explicit no-text rule otherwise).
 */
export function compileArtDirection(prompt: string): string {
  const trimmed = prompt.trim();
  const direction = detectArtDirection(trimmed);
  const hasQuotedText = extractQuotedTypography(trimmed).items.length > 0;
  return [
    trimmed,
    direction?.directive ?? UNIVERSAL_DEFAULT,
    hasQuotedText ? EXACT_TEXT_GUIDANCE : NO_TEXT_GUIDANCE,
  ].filter(Boolean).join("\n\n");
}

/**
 * Extract EXACT quoted wording from a free-form request (deterministic).
 * Recognises straight and typographic double quotes. Used to route banner
 * text through the deterministic typography layer instead of hoping the
 * image model spells correctly.
 */
export function extractQuotedTypography(prompt: string): {
  items: { text: string; role: "headline" | "subtext" | "tagline" | "cta"; font: "sans" | "serif" | "mono" }[];
  subject: string;
} {
  const matches: string[] = [];
  // Straight double quotes, then typographic double quotes (each exact).
  const patterns = [/"([^"]{1,120})"/g, /[\u201C]([^\u201D]{1,120})[\u201D]/g];
  for (const pattern of patterns) {
    for (const m of prompt.matchAll(pattern)) {
      const text = m[1].trim();
      if (text) matches.push(text);
    }
  }
  // Dedupe (case-sensitive exact) and cap at 4 items (brief schema limit).
  const seen = new Set<string>();
  const unique = matches.filter((m) => (seen.has(m) ? false : (seen.add(m), true))).slice(0, 4);
  const roles: ("headline" | "subtext" | "tagline" | "cta")[] = ["headline", "subtext", "tagline", "cta"];
  const items = unique.map((text, i) => ({ text, role: roles[i], font: "sans" as const }));

  // Subject description = the request with the quoted segments removed so the
  // scene guidance does not double-count the text as scene content.
  const subject = prompt
    .replace(/"[^"]{1,120}"/g, " ")
    .replace(/[“"][^”"]{1,120}[”"]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return { items, subject };
}
