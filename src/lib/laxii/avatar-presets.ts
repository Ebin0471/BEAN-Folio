/**
 * LAXII Avatar Studio — no-prompt style presets.
 *
 * Each preset carries a full style directive so a user can pick a look and
 * generate without writing a prompt. The fragment is appended SERVER-side
 * (generate route) so the prompt text stays under product control and the
 * exact wording that reached the provider is stored in the message history.
 *
 * Identity note (honesty rule): when reference photos are supplied, engines
 * re-render the subject with best-effort likeness. NO preset or provider
 * promises perfect identity preservation — the UI states this explicitly.
 */

export interface LaxiiAvatarPreset {
  slug: string;
  label: string;
  blurb: string;
  /** Full style directive appended to the generation prompt. */
  promptFragment: string;
  /** Default aspect for this style (user-overridable). */
  defaultAspect: string;
}

export const AVATAR_PRESETS: LaxiiAvatarPreset[] = [
  {
    slug: "professional-headshot",
    label: "Professional Headshot",
    blurb: "Clean corporate headshot, neutral background, recruiter-ready.",
    promptFragment:
      "Professional corporate headshot photograph of the subject: sharp business attire, confident relaxed expression, clean neutral studio background, soft even key light with gentle fill, crisp focus on the eyes, natural skin tones, true-to-life color, 85mm portrait lens look, shoulders-up framing, LinkedIn-ready finish.",
    defaultAspect: "4:5",
  },
  {
    slug: "cinematic-portrait",
    label: "Cinematic Portrait",
    blurb: "Dramatic movie-poster mood with film-grade lighting.",
    promptFragment:
      "Cinematic portrait photograph of the subject: moody film-grade lighting with strong key-to-fill contrast, atmospheric background bokeh, teal-and-amber cinematic grade, shallow depth of field, anamorphic lens character, subtle film grain, emotional and composed expression, movie-still quality.",
    defaultAspect: "2:3",
  },
  {
    slug: "corporate-executive",
    label: "Corporate Executive",
    blurb: "Boardroom presence — power lighting, executive wardrobe.",
    promptFragment:
      "Executive boardroom portrait of the subject: tailored dark suit, composed authoritative posture, modern office glass backdrop softly out of focus, directional Rembrandt lighting, polished editorial-retouch finish, premium magazine business photography style, chest-up framing.",
    defaultAspect: "4:5",
  },
  {
    slug: "editorial-fashion",
    label: "Editorial Fashion",
    blurb: "Magazine-cover styling with bold art direction.",
    promptFragment:
      "High-fashion editorial portrait of the subject: bold styling and wardrobe, expressive pose, studio backdrop with a saturated accent color, dramatic sculpted lighting, glossy magazine retouch, Vogue-style art direction, striking and modern.",
    defaultAspect: "4:5",
  },
  {
    slug: "studio-portrait",
    label: "Studio Portrait",
    blurb: "Timeless classic studio lighting on seamless backdrop.",
    promptFragment:
      "Classic studio portrait of the subject: seamless grey backdrop, large softbox key with subtle rim light, natural posing, accurate skin tones, fine detail from lashes to fabric texture, timeless neutral color grade, medium-format camera look.",
    defaultAspect: "4:5",
  },
  {
    slug: "outdoor-portrait",
    label: "Outdoor Portrait",
    blurb: "Golden-hour natural light with environmental depth.",
    promptFragment:
      "Outdoor environmental portrait of the subject: golden-hour sunlight, warm natural rim light, softly blurred greenery or urban background, airy and candid mood, authentic skin texture, 135mm telephoto compression, natural color palette.",
    defaultAspect: "3:4",
  },
  {
    slug: "black-and-white",
    label: "Black and White",
    blurb: "Fine-art monochrome with deep tonal range.",
    promptFragment:
      "Fine-art black-and-white portrait of the subject: deep rich blacks, luminous highlights, full monochrome tonal range, dramatic side lighting sculpting the features, subtle film-grain texture, gallery-print quality, timeless and dignified.",
    defaultAspect: "4:5",
  },
  {
    slug: "anime-avatar",
    label: "Anime Avatar",
    blurb: "Clean modern anime illustration, profile-ready.",
    promptFragment:
      "Modern anime-style illustrated avatar of the subject: clean confident linework, cel shading with soft light accents, expressive stylized eyes, tasteful color palette, simple gradient or patterned background, high-quality digital illustration, profile-picture composition, head-and-shoulders framing.",
    defaultAspect: "1:1",
  },
  {
    slug: "3d-character",
    label: "3D Character",
    blurb: "Pixar-style stylized 3D character render.",
    promptFragment:
      "Stylized 3D character avatar of the subject: Pixar-grade character design, soft global illumination, appealing exaggerated-but-recognizable features, subsurface-scattering skin, cinematic depth of field, clean studio backdrop, premium animation-studio render quality.",
    defaultAspect: "1:1",
  },
  {
    slug: "gaming-avatar",
    label: "Gaming Avatar",
    blurb: "Esports-ready avatar with neon edge and attitude.",
    promptFragment:
      "Esports gaming avatar of the subject: bold stylized illustration, neon rim lighting with electric accents, dynamic confident pose, dark futuristic background with subtle holographic elements, crisp competitive-team profile aesthetic, head-and-shoulders framing.",
    defaultAspect: "1:1",
  },
];

export function findAvatarPreset(slug: string): LaxiiAvatarPreset | null {
  return AVATAR_PRESETS.find((p) => p.slug === slug) ?? null;
}

/** Honest disclaimer shown wherever reference-photo likeness matters. */
export const AVATAR_IDENTITY_NOTE =
  "Reference photos guide the result, but no engine guarantees perfect identity preservation — review every avatar before using it.";
