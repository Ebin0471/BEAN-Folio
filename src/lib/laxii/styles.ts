/**
 * LAXII — Style Registry + Creative Recipe Compiler (Phase 5).
 *
 * Goal: professional results WITHOUT prompt writing. Each style carries
 * structured creative settings (composition, lighting, camera, colour
 * grading, treatment, background) that the Creative Recipe Compiler turns
 * into a provider-agnostic creative brief. The exact wording of the compiled
 * directive (`promptFragment`) stays server-side — the client only ever sees
 * the public metadata, exactly like the avatar presets.
 *
 * Providers receive ONE compiled brief; the user's own words (when any) are
 * appended as "Additional direction from the user" — advanced prompt editing
 * stays optional, never required.
 */

import type { LaxiiAspect, LaxiiProviderId } from "./types";

export interface LaxiiStyleSettings {
  composition: string;
  lighting: string;
  camera: string;
  colorGrading: string;
  treatment: string;
  background: string;
}

export interface LaxiiStylePreset {
  slug: string;
  label: string;
  blurb: string;
  settings: LaxiiStyleSettings;
  defaultAspect: LaxiiAspect;
  /** How attached reference images are treated in the compiled recipe. */
  referenceBehavior: "subject" | "style" | "compose" | "optional";
  /** What genuinely varies across multi-variant runs (Phase 7 honesty). */
  variationStrategy: "composition" | "lighting" | "mood" | "angle";
  /** Advisory provider fit; the router stays capability-based. */
  providerPreference: LaxiiProviderId[];
  /** Server-only compiled creative directive — never shipped to the client. */
  promptFragment: string;
}

export const STYLE_PRESETS: LaxiiStylePreset[] = [
  {
    slug: "cinematic-portrait",
    label: "Cinematic Portrait",
    blurb: "Film-still mood with dramatic key light and shallow depth of field.",
    settings: {
      composition: "Tight chest-up portrait, subject slightly off-center, shallow depth of field",
      lighting: "Single dramatic key light from 45°, deep falloff, gentle rim light separating subject from background",
      camera: "85mm portrait lens look, f/1.8, subtle anamorphic flare",
      colorGrading: "Warm highlights, teal-leaning shadows, filmic contrast curve",
      treatment: "Fine 35mm film grain, no digital over-sharpening",
      background: "Dark, softly out-of-focus environment",
    },
    defaultAspect: "2:3",
    referenceBehavior: "subject",
    variationStrategy: "lighting",
    providerPreference: ["gemini", "managed"],
    promptFragment:
      "Cinematic portrait: tight chest-up framing with the subject slightly off-center and shallow depth of field. Single dramatic key light from 45° with deep falloff and a gentle rim light separating the subject from a dark, softly defocused background. 85mm f/1.8 portrait look with subtle anamorphic flare. Warm highlights over teal-leaning shadows with a filmic contrast curve and fine 35mm grain — no digital over-sharpening.",
  },
  {
    slug: "editorial-fashion",
    label: "Editorial Fashion",
    blurb: "Magazine-spread fashion story with bold styling and confident posing.",
    settings: {
      composition: "Full-body or three-quarter fashion pose, deliberate negative space for magazine layout",
      lighting: "Crisp studio strobes or hard directional sunlight, defined shadows",
      camera: "50–85mm, sharp focus edge to edge on the subject",
      colorGrading: "High-saturation accent colours over a controlled neutral base",
      treatment: "Polished retouch with retained skin texture",
      background: "Seamless studio sweep or bold architectural backdrop",
    },
    defaultAspect: "4:5",
    referenceBehavior: "subject",
    variationStrategy: "composition",
    providerPreference: ["gemini", "openai"],
    promptFragment:
      "Editorial fashion photograph for a magazine spread: full-body or three-quarter pose with deliberate negative space for layout. Crisp studio strobes or hard directional sunlight with defined shadows. 50–85mm lens, sharp edge to edge on the subject. High-saturation accent colours over a controlled neutral base, polished retouch that keeps real skin texture, against a seamless studio sweep or bold architectural backdrop.",
  },
  {
    slug: "corporate-headshot",
    label: "Corporate Headshot",
    blurb: "Clean, trustworthy business portrait suitable for LinkedIn and team pages.",
    settings: {
      composition: "Head-and-shoulders, eyes to upper third, square-on or slight turn",
      lighting: "Soft even key with large source, gentle fill, low shadow contrast",
      camera: "85–105mm equivalent, tack-sharp eyes",
      colorGrading: "Neutral, true-to-life skin tones",
      treatment: "Natural grooming, no plastic retouching",
      background: "Neutral grey-to-white gradient or softly blurred office",
    },
    defaultAspect: "4:5",
    referenceBehavior: "subject",
    variationStrategy: "lighting",
    providerPreference: ["gemini", "managed"],
    promptFragment:
      "Professional corporate headshot: head-and-shoulders framing, eyes on the upper third, square-on or with a slight turn. Soft, even key light from a large source with gentle fill and low shadow contrast. 85–105mm equivalent lens with tack-sharp eyes. Neutral true-to-life skin tones, natural grooming without plastic retouching, against a neutral grey-to-white gradient or a softly blurred office.",
  },
  {
    slug: "professional-photography",
    label: "Professional Photography",
    blurb: "Versatile modern photo look for portfolios, profiles and content.",
    settings: {
      composition: "Balanced, natural framing with clean leading lines",
      lighting: "Realistic ambient light with soft, believable fill",
      camera: "35–50mm documentary-style clarity",
      colorGrading: "Subtle contrast lift, honest whites, gentle warmth",
      treatment: "Light, invisible retouching",
      background: "Real environment, softly prioritized behind the subject",
    },
    defaultAspect: "3:2",
    referenceBehavior: "optional",
    variationStrategy: "angle",
    providerPreference: ["managed", "gemini"],
    promptFragment:
      "Versatile professional photograph: balanced natural framing with clean leading lines, realistic ambient light with soft believable fill, 35–50mm documentary-style clarity, subtle contrast lift with honest whites and gentle warmth, light invisible retouching, set in a real environment that stays softly prioritized behind the subject.",
  },
  {
    slug: "anime",
    label: "Anime",
    blurb: "Modern anime illustration with clean linework and expressive eyes.",
    settings: {
      composition: "Character-focused framing with dynamic, readable silhouette",
      lighting: "Stylized cel lighting with clear two-tone shadows",
      camera: "Illustrated perspective, slight dutch energy where it helps motion",
      colorGrading: "Vivid harmonized palette with crisp cel shading",
      treatment: "Clean lineart, flat-to-soft shading, sparkle accents where fitting",
      background: "Painted anime environment or dramatic gradient sky",
    },
    defaultAspect: "1:1",
    referenceBehavior: "subject",
    variationStrategy: "mood",
    providerPreference: ["gemini", "managed"],
    promptFragment:
      "Modern anime illustration: character-focused framing with a dynamic, readable silhouette, stylized cel lighting with clear two-tone shadows, vivid harmonized palette with crisp cel shading and clean lineart, set against a painted anime environment or dramatic gradient sky.",
  },
  {
    slug: "3d-character",
    label: "3D Character",
    blurb: "Stylized Pixar-grade 3D character render with appealing materials.",
    settings: {
      composition: "Character hero pose, centered or rule-of-thirds",
      lighting: "Three-point studio HDRI with soft bounce and contact shadows",
      camera: "Virtual 50mm, slight tilt-shift charm",
      colorGrading: "Saturated, friendly palette with global illumination warmth",
      treatment: "Subsurface-scattered skin, clean topology silhouette, soft DOF",
      background: "Simple studio set or pastel gradient environment",
    },
    defaultAspect: "1:1",
    referenceBehavior: "subject",
    variationStrategy: "mood",
    providerPreference: ["openai", "gemini"],
    promptFragment:
      "Stylized 3D character render of Pixar-grade appeal: hero pose centered or on the rule of thirds, three-point studio HDRI lighting with soft bounce and contact shadows, virtual 50mm with slight tilt-shift charm, saturated friendly palette with global-illumination warmth, subsurface-scattered skin and a clean silhouette, on a simple studio set or pastel gradient backdrop.",
  },
  {
    slug: "fantasy-art",
    label: "Fantasy Art",
    blurb: "Epic illustrated fantasy with painterly light and grand scale.",
    settings: {
      composition: "Epic hero composition with layered depth and atmospheric perspective",
      lighting: "God rays, magical emissive accents, dramatic chiaroscuro",
      camera: "Wide painted vista or heroic low angle",
      colorGrading: "Rich jewel tones with glowing highlights",
      treatment: "Painterly brushwork with illustrated detail density",
      background: "Sweeping fantasy landscape or arcane interior",
    },
    defaultAspect: "3:2",
    referenceBehavior: "compose",
    variationStrategy: "composition",
    providerPreference: ["gemini", "managed"],
    promptFragment:
      "Epic fantasy illustration: heroic composition with layered depth and atmospheric perspective, god rays and magical emissive accents over dramatic chiaroscuro, rich jewel tones with glowing highlights, painterly brushwork, set in a sweeping fantasy landscape or arcane interior.",
  },
  {
    slug: "cyberpunk",
    label: "Cyberpunk",
    blurb: "Neon-drenched night city with rain, reflections and attitude.",
    settings: {
      composition: "Street-level frame dense with signage depth and reflections",
      lighting: "Magenta/cyan neon spill, wet-surface reflections, volumetric haze",
      camera: "24–35mm night look with practical-light flares",
      colorGrading: "Deep shadows, neon highlights, slight chromatic aberration",
      treatment: "Cinematic sci-fi grit with holographic accents",
      background: "Rain-slick megacity street or neon alley",
    },
    defaultAspect: "16:9",
    referenceBehavior: "compose",
    variationStrategy: "mood",
    providerPreference: ["gemini", "openai"],
    promptFragment:
      "Cyberpunk scene: street-level frame dense with signage depth, magenta and cyan neon spill over wet-surface reflections and volumetric haze, 24–35mm night look with practical-light flares, deep shadows with neon highlights and slight chromatic aberration, in a rain-slick megacity street or neon alley.",
  },
  {
    slug: "luxury-minimal",
    label: "Luxury Minimal",
    blurb: "Premium minimalist aesthetic with generous negative space.",
    settings: {
      composition: "Strict minimal arrangement, generous negative space, one clear focal element",
      lighting: "Soft directional studio light with elegant long shadows",
      camera: "Medium-format look, immaculate sharpness",
      colorGrading: "Muted premium palette — warm greys, cream, one metallic accent",
      treatment: "Flawless clean surfaces, nothing accidental",
      background: "Seamless minimal backdrop in a warm neutral tone",
    },
    defaultAspect: "4:5",
    referenceBehavior: "optional",
    variationStrategy: "lighting",
    providerPreference: ["openai", "gemini"],
    promptFragment:
      "Luxury minimalist composition: strict arrangement with generous negative space and one clear focal element, soft directional studio light casting elegant long shadows, medium-format immaculate sharpness, muted premium palette of warm greys and cream with a single metallic accent, flawless surfaces on a seamless warm-neutral backdrop.",
  },
  {
    slug: "product-photography",
    label: "Product Photography",
    blurb: "Commercial product shot with studio control and honest materials.",
    settings: {
      composition: "Product hero angle on seamless set, label fully readable",
      lighting: "Softbox key plus gradient falloff, controlled speculars",
      camera: "90mm macro-equivalent, everything important in focus",
      colorGrading: "Accurate product colour with premium contrast",
      treatment: "Clean composite quality, true materials — no fake logos",
      background: "Seamless white or branded gradient sweep",
    },
    defaultAspect: "1:1",
    referenceBehavior: "subject",
    variationStrategy: "angle",
    providerPreference: ["openai", "gemini"],
    promptFragment:
      "Commercial product photograph: hero angle on a seamless set with the label fully readable, softbox key with gradient falloff and controlled speculars, 90mm macro-equivalent clarity on everything important, accurate product colour with premium contrast, true materials and no fabricated logos, on a seamless white or branded gradient sweep.",
  },
  {
    slug: "movie-poster",
    label: "Movie Poster",
    blurb: "One-sheet key art with dramatic hierarchy and title space.",
    settings: {
      composition: "Key-art hierarchy — hero subject low-center, clear title zone on top",
      lighting: "High-contrast genre lighting with silhouette energy",
      camera: "Telephoto compression for poster depth",
      colorGrading: "Blockbuster teal-orange or genre-specific grade",
      treatment: "Polished composite with grain and vignette",
      background: "Atmospheric dramatic environment, softly exhausted at edges",
    },
    defaultAspect: "2:3",
    referenceBehavior: "subject",
    variationStrategy: "composition",
    providerPreference: ["gemini", "openai"],
    promptFragment:
      "Movie-poster key art: one-sheet hierarchy with the hero subject low-center and a clear title zone on top, high-contrast genre lighting with silhouette energy, telephoto compression for depth, blockbuster teal-orange grade, polished composite with film grain and vignette, over an atmospheric environment that exhausts softly at the edges. Leave the title zone free of text.",
  },
  {
    slug: "gaming-artwork",
    label: "Gaming Artwork",
    blurb: "Key-art game splash with dynamic action and rich VFX.",
    settings: {
      composition: "Dynamic action pose with motion energy and readable focal hero",
      lighting: "Rim-lit hero with emissive ability effects and sparks",
      camera: "Wide heroic angle with mild motion blur on extremities",
      colorGrading: "Saturated game palette with glowing accent hues",
      treatment: "Crisp digital painting with VFX overlays",
      background: "Game arena, battlefield or stylized environment",
    },
    defaultAspect: "16:9",
    referenceBehavior: "subject",
    variationStrategy: "mood",
    providerPreference: ["gemini", "openai"],
    promptFragment:
      "Game key-art splash: dynamic action pose with motion energy and a readable focal hero, rim lighting with emissive ability effects and sparks, wide heroic angle with mild motion blur on extremities, saturated palette with glowing accent hues, crisp digital painting with VFX overlays, set in a game arena or stylized battlefield.",
  },
  {
    slug: "portfolio-cover",
    label: "Portfolio Cover",
    blurb: "Statement cover image for BEAN Folio projects and profiles.",
    settings: {
      composition: "Bold centered statement with breathing room for overlay UI",
      lighting: "Confident directional light with clean shadow shape",
      camera: "Medium-format presence, crisp subject",
      colorGrading: "Sophisticated palette aligned with champagne-gold brand accents",
      treatment: "Refined finish, professional polish",
      background: "Elegant gradient or textured backdrop that never fights text overlays",
    },
    defaultAspect: "4:5",
    referenceBehavior: "optional",
    variationStrategy: "mood",
    providerPreference: ["managed", "gemini"],
    promptFragment:
      "Statement portfolio cover: bold centered composition with breathing room for overlay UI, confident directional light with a clean shadow shape, medium-format presence and crisp subject, sophisticated palette that harmonizes with champagne-gold accents, refined professional finish over an elegant gradient or textured backdrop that never fights text overlays.",
  },
  {
    slug: "website-hero",
    label: "Website Hero",
    blurb: "Wide hero banner with a calm zone reserved for headlines.",
    settings: {
      composition: "Wide 16:9 hero with the visual weight on one side and a calm headline zone on the other",
      lighting: "Clean, optimistic, evenly lit",
      camera: "Wide-angle environment depth without distortion",
      colorGrading: "Bright premium grade matching a modern brand site",
      treatment: "Crisp, uncluttered, production-ready",
      background: "Ambient brand environment or abstract premium gradient",
    },
    defaultAspect: "16:9",
    referenceBehavior: "optional",
    variationStrategy: "composition",
    providerPreference: ["openai", "managed"],
    promptFragment:
      "Website hero image: wide cinematic banner with visual weight on one side and a calm uncluttered headline zone on the other, clean optimistic even lighting, wide-angle environmental depth without distortion, bright premium grade for a modern brand site, production-ready crispness over an ambient brand environment or abstract premium gradient. Keep the headline zone free of any text.",
  },
  {
    slug: "business-banner",
    label: "Business Banner",
    blurb: "Ultra-wide professional banner band for covers and headers.",
    settings: {
      composition: "One thin horizontal band composed as a single wide scene; keep all key content within the central safe zone",
      lighting: "Even, professional, no harsh hotspots",
      camera: "Panoramic sensibility with stable perspective",
      colorGrading: "Trustworthy corporate grade with one warm accent",
      treatment: "Clean vector-like clarity where graphic, photo-real where photographic",
      background: "Abstract premium gradient or subtle architectural texture",
    },
    defaultAspect: "21:9",
    referenceBehavior: "optional",
    variationStrategy: "composition",
    providerPreference: ["openai", "gemini"],
    promptFragment:
      "Professional business banner composed as ONE thin horizontal band: a single wide panoramic scene with stable perspective and all key content inside the central safe zone, even professional lighting without hotspots, trustworthy corporate grade with one warm accent, clean clarity over an abstract premium gradient or subtle architectural texture. Avoid placing critical detail near the extreme left or right edges.",
  },
];

export function findStylePreset(slug: string): LaxiiStylePreset | undefined {
  return STYLE_PRESETS.find((s) => s.slug === slug);
}

/** Public shape for the capabilities endpoint — compiled fragments stay server-side. */
export function publicStylePresets(): Omit<LaxiiStylePreset, "promptFragment">[] {
  return STYLE_PRESETS.map(({ promptFragment: _fragment, ...pub }) => {
    void _fragment;
    return pub;
  });
}

/**
 * Creative Recipe Compiler — turn a selected style (+ aspect/count choices)
 * into the provider-agnostic creative brief. Returns null when the slug is
 * unknown so callers can fail honestly.
 */
export interface CompiledStyleRecipe {
  slug: string;
  label: string;
  /** Full compiled directive block (server-side only). */
  promptBlock: string;
  aspect: LaxiiAspect;
  count: number;
  warnings: string[];
}

export function compileStyleRecipe(
  slug: string,
  opts: { aspect?: LaxiiAspect; count?: number; referenceCount?: number; prompt?: string } = {}
): CompiledStyleRecipe | null {
  const style = findStylePreset(slug);
  if (!style) return null;

  const warnings: string[] = [];
  const aspect = opts.aspect ?? style.defaultAspect;
  if (!opts.aspect && aspect !== style.defaultAspect) {
    // Only reachable when a caller passes an aspect equal to a non-default —
    // defensive; the normal override path is explicit.
  }
  if (opts.aspect && opts.aspect !== style.defaultAspect) {
    warnings.push(`Rendered in ${opts.aspect} (the ${style.label} style is designed for ${style.defaultAspect}).`);
  }
  const count = Math.min(Math.max(opts.count ?? 1, 1), 4);

  const lines: string[] = [style.promptFragment];

  if ((opts.referenceCount ?? 0) > 0) {
    switch (style.referenceBehavior) {
      case "subject":
        lines.push(
          "Use the supplied reference photo(s) strictly as the subject's appearance guide — render THIS person/product with best-effort likeness while applying the style. Identity preservation is approximate, not guaranteed."
        );
        warnings.push(`${style.label} applies its look on top of your reference subject — review the likeness before use.`);
        break;
      case "style":
        lines.push("Match the colour, mood and texture of the supplied reference image(s) while following the composition above.");
        break;
      case "compose":
        lines.push("Use the supplied reference image(s) as composition/scene guidance and re-render them in the style above.");
        break;
      case "optional":
        lines.push("The supplied reference image(s) are context — incorporate them naturally if they help the brief.");
        break;
    }
  }

  if (count > 1) {
    const strategy =
      style.variationStrategy === "lighting"
        ? "Vary the LIGHTING direction and mood across the versions while keeping the subject and framing consistent."
        : style.variationStrategy === "composition"
          ? "Vary the COMPOSITION and framing across the versions while keeping the subject and style consistent."
          : style.variationStrategy === "angle"
            ? "Vary the CAMERA ANGLE across the versions while keeping the subject and style consistent."
            : "Vary the MOOD and atmosphere across the versions while keeping the subject and composition consistent.";
    lines.push(`The ${count} versions must be genuinely different takes: ${strategy}`);
  }

  return { slug: style.slug, label: style.label, promptBlock: lines.join("\n\n"), aspect, count, warnings };
}
