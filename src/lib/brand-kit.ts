/**
 * BEAN Folio — Brand Kit intelligence (M33.1).
 *
 * Shared, deterministic brand-attribute → validated brand-kit proposal engine
 * for GIFTZ (website design) and LAXII (banner/campaign typography). This
 * module owns the explicit-attributes contract from
 * `docs/GIFTZ_UNIVERSAL_CREATIVE_STUDIO_GUIDE.md` §Stage 5 / M33.1 and is
 * machine-pinned by `tests/giftz-brand-kit.test.ts` and
 * `tests/universal-studio-capability-matrix.test.ts`.
 *
 * Truth rules (non-negotiable, Guide §0):
 *  - Inputs are EXPLICIT user-supplied attributes only. Nothing here infers
 *    sensitive personal traits or psychographic characteristics; the strict
 *    input schema rejects such fields outright.
 *  - Every font id, palette id, design-language id and motion preset id in a
 *    proposal is resolved against the LIVE registries at proposal time.
 *    Unknown ids are REJECTED with the nearest valid alternatives — never
 *    silently substituted (Guide §0.9 no silent fallback).
 *  - Only weights that genuinely ship for the selected family are proposed;
 *    a requested weight the family does not ship fails the proposal.
 *  - The font registry carries no per-family glyph/script metadata, so any
 *    requested language whose primary script is not Latin produces pairings
 *    explicitly marked glyphCoverage "unverified" with an honest note and a
 *    verification requirement — never a claim of coverage.
 *  - Output is a PROPOSAL. Applying it to a site/banner remains an explicit
 *    user action through the existing save/consent flows.
 */

import { z } from "zod";

import {
  SITE_FONTS,
  resolveFont,
  googleFontsHref,
  type SiteFontDef,
} from "@/lib/site-fonts";
import { PALETTES, contrastRatio, getPalette } from "@/lib/site-palettes";
import { getMotionPreset } from "@/lib/site-motion";
import {
  DESIGN_LANGUAGES,
  matchDesignLanguages,
} from "@/lib/ai-design/design-languages";

// ---------------------------------------------------------------------------
// Input contract — explicit attributes only
// ---------------------------------------------------------------------------

const FREE_TEXT_MAX = 120;

/** Languages whose PRIMARY script is not Latin. The font registry stores no
 * per-family script metadata, so these can never be "confirmed" from source. */
const NON_LATIN_PRIMARY_SCRIPT = [
  "ar", "he", "fa", "ur", "hi", "bn", "pa", "ta", "te", "ml", "kn", "mr",
  "gu", "si", "ne", "th", "lo", "km", "my", "zh", "ja", "ko", "el", "ru",
  "uk", "bg", "sr", "mk", "ka", "hy", "am", "ii", "kmr",
] as const;

export const brandKitInputSchema = z
  .object({
    brandName: z.string().max(80).optional(),
    sector: z.string().max(FREE_TEXT_MAX).optional(),
    audience: z.string().max(FREE_TEXT_MAX).optional(),
    /** Explicit brand adjectives supplied by the user ("warm", "editorial", "premium"…). */
    toneAdjectives: z.array(z.string().min(1).max(40)).max(8).default([]),
    /** Requested content languages (BCP-47-ish primary tags, lowercase). */
    languages: z.array(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)).max(6).default([]),
    /** User-selected font override. Unknown ids are rejected, not substituted. */
    fontOverride: z
      .object({
        heading: z.string().max(48),
        body: z.string().max(48),
        accent: z.string().max(48).optional(),
        /** Requested weights are validated against the family's real weights. */
        weights: z.array(z.number().int().min(100).max(900)).max(6).optional(),
      })
      .optional(),
    /** Preferred palette id from the curated registry, or "auto". */
    paletteDirection: z.string().max(48).default("auto"),
    motionPersonality: z.enum(["calm", "balanced", "expressive"]).default("balanced"),
    notes: z.string().max(500).optional(),
  })
  .strict();

export type BrandKitInput = z.infer<typeof brandKitInputSchema>;

/** Fields the strict schema deliberately rejects — visible for tests/docs. */
export const REJECTED_PSYCHOMETRIC_FIELDS = [
  "personality",
  "personalityTraits",
  "psychographic",
  "mentalHealth",
  "mbti",
  "bigFive",
  "diagnosis",
] as const;

// ---------------------------------------------------------------------------
// Proposal shapes
// ---------------------------------------------------------------------------

export interface BrandFontRef {
  id: string;
  family: string;
  category: string;
  kind: string;
  weights: number[];
}

export interface FontPairing {
  heading: BrandFontRef;
  body: BrandFontRef;
  accent?: BrandFontRef;
  rationale: string;
  glyphCoverage: "confirmed" | "unverified";
  glyphCoverageNote?: string;
  previewHref: string | null;
}

export interface BrandKitProposal {
  brandName: string | null;
  designLanguage: { id: string; label: string; tagline: string };
  pairings: FontPairing[];
  palettes: { id: string; label: string; category: string; dark: boolean }[];
  motion: { personality: "calm" | "balanced" | "expressive"; presets: string[] };
  assumptions: string[];
  warnings: string[];
}

export interface BrandKitRejection {
  ok: false;
  field: string;
  reason: string;
  suggestions: string[];
}

export type BrandKitResult =
  | { ok: true; proposal: BrandKitProposal }
  | BrandKitRejection;

// ---------------------------------------------------------------------------
// Registry-backed helpers
// ---------------------------------------------------------------------------

function toFontRef(def: SiteFontDef): BrandFontRef {
  return {
    id: def.id,
    family: def.family,
    category: def.category,
    kind: def.kind,
    weights: [...def.weights].sort((a, b) => a - b),
  };
}

/** Reject unknown font ids with nearest same-kind alternatives (no silent substitution). */
function requireFont(id: string, role: "heading" | "body" | "accent"): SiteFontDef {
  const def = resolveFont(id);
  // resolveFont falls back to a default family for unknown ids — that is the
  // config-mode lenient path. The brand kit is the strict path: an unknown
  // explicit id must fail loudly instead of silently swapping the family.
  const exact = SITE_FONTS.find((f) => f.id === id);
  if (!exact) {
    const suggestions = SITE_FONTS.filter((f) => f.kind === (def?.kind ?? "sans"))
      .slice(0, 5)
      .map((f) => f.id);
    throw new BrandKitFieldError(
      `fontOverride.${role}`,
      `Unknown font id "${id}" — the brand kit never silently substitutes a different family.`,
      suggestions,
    );
  }
  return exact;
}

export class BrandKitFieldError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
    public readonly suggestions: string[],
  ) {
    super(`${field}: ${reason}`);
    this.name = "BrandKitFieldError";
  }
}

function fontPreviewHref(fonts: BrandFontRef[]): string | null {
  const requests = fonts
    .filter((f) => !f.id.startsWith("geist"))
    .map((f) => ({ id: f.id, weights: f.weights.slice(0, 4) }));
  if (requests.length === 0) return null;
  return googleFontsHref(requests, { includeBundled: false });
}

/** Deterministic category affinity for explicit tone adjectives / sector words. */
const TONE_CATEGORY_AFFINITY: Record<string, string[]> = {
  editorial: ["Editorial serif"],
  literary: ["Editorial serif"],
  premium: ["Elegant luxury"],
  luxury: ["Elegant luxury"],
  refined: ["Elegant luxury"],
  corporate: ["Minimal & neutral", "Grotesk"],
  trustworthy: ["Minimal & neutral", "Grotesk"],
  operational: ["Minimal & neutral", "Modern sans"],
  technical: ["Modern sans", "Grotesk", "Monospace"],
  engineering: ["Modern sans", "Grotesk"],
  data: ["Modern sans", "Monospace"],
  modern: ["Modern sans", "Geometric sans"],
  minimal: ["Minimal & neutral", "Modern sans"],
  geometric: ["Geometric sans"],
  playful: ["Display & expressive", "Creative & experimental"],
  youthful: ["Display & expressive", "Creative & experimental"],
  expressive: ["Display & expressive"],
  creative: ["Creative & experimental", "Display & expressive"],
  experimental: ["Creative & experimental"],
  warm: ["Editorial serif", "Modern sans"],
  community: ["Modern sans", "Editorial serif"],
  elegant: ["Elegant luxury", "Editorial serif"],
  cinematic: ["Editorial serif", "Display & expressive"],
};

function scoreHeadingCandidate(def: SiteFontDef, words: string[]): number {
  let score = 0;
  if (def.kind === "serif" || def.kind === "display" || def.kind === "sans") score += 2;
  if (def.weights.length >= 3) score += 1;
  for (const word of words) {
    const categories = TONE_CATEGORY_AFFINITY[word];
    if (categories && categories.includes(def.category)) score += 3;
    if (def.blurb.toLowerCase().includes(word)) score += 1;
    if (def.family.toLowerCase().includes(word)) score += 1;
  }
  if (def.category === "Script & handwriting") score -= 6;
  return score;
}

function scoreBodyCandidate(def: SiteFontDef, words: string[]): number {
  let score = 0;
  if (def.kind === "sans" || def.kind === "serif") score += 3;
  if (!def.weights.includes(400)) score -= 4; // long-form body needs a 400
  if (def.weights.includes(700)) score += 1;
  if (def.category === "Minimal & neutral" || def.category === "Modern sans") score += 2;
  for (const word of words) {
    const categories = TONE_CATEGORY_AFFINITY[word];
    if (categories && categories.includes(def.category)) score += 2;
    if (def.blurb.toLowerCase().includes(word)) score += 1;
  }
  if (def.kind === "script" || def.kind === "display") score -= 8;
  if (def.kind === "mono") score -= 5;
  return score;
}

function pickCandidates(
  words: string[],
  scorer: (def: SiteFontDef, words: string[]) => number,
  excludeIds: string[] = [],
): SiteFontDef[] {
  return [...SITE_FONTS]
    .filter((f) => !excludeIds.includes(f.id))
    .map((def) => ({ def, score: scorer(def, words) }))
    .sort((a, b) => b.score - a.score || a.def.id.localeCompare(b.def.id))
    .map((e) => e.def);
}

function languageCoverage(languages: string[]): {
  glyphCoverage: "confirmed" | "unverified";
  glyphCoverageNote?: string;
} {
  const nonLatin = languages.filter((lang) =>
    (NON_LATIN_PRIMARY_SCRIPT as readonly string[]).includes(lang.split("-")[0]),
  );
  if (nonLatin.length === 0) {
    return { glyphCoverage: "confirmed" };
  }
  return {
    glyphCoverage: "unverified",
    glyphCoverageNote:
      `The font registry carries no per-family glyph metadata, so coverage for the requested ` +
      `non-Latin language(s) (${nonLatin.join(", ")}) is NOT confirmed. Verify rendering for every ` +
      `requested language, punctuation and numeral set before publishing; consider a dedicated ` +
      `multilingual family for affected copy.`,
  };
}

// ---------------------------------------------------------------------------
// Proposal builder
// ---------------------------------------------------------------------------

const CONTRAST_MIN_BODY = 4.5;

function paletteCandidates(
  designLanguageId: string,
  paletteDirection: string,
  warnings: string[],
): BrandKitProposal["palettes"] {
  const language = DESIGN_LANGUAGES.find((l) => l.id === designLanguageId);
  const curated = (language?.palettes ?? [])
    .map((id) => getPalette(id))
    .filter((p): p is NonNullable<ReturnType<typeof getPalette>> => p !== null);

  let ordered = curated;
  if (paletteDirection !== "auto") {
    const explicit = getPalette(paletteDirection);
    if (!explicit) {
      throw new BrandKitFieldError(
        "paletteDirection",
        `Unknown palette id "${paletteDirection}".`,
        curated.slice(0, 5).map((p) => p.id),
      );
    }
    ordered = [explicit, ...curated.filter((p) => p.id !== explicit.id)];
  }

  // Contrast gate: body text must stay readable on every proposed palette.
  const passing = ordered.filter((p) => {
    const ratio = contrastRatio(p.tokens.foreground, p.tokens.background);
    if (ratio < CONTRAST_MIN_BODY) {
      warnings.push(
        `Palette "${p.id}" dropped from the proposal: foreground/background contrast ${ratio.toFixed(2)} is below ${CONTRAST_MIN_BODY}.`,
      );
      return false;
    }
    return true;
  });

  return passing.slice(0, 3).map((p) => ({
    id: p.id,
    label: p.label,
    category: p.category,
    dark: p.dark,
  }));
}

const MOTION_PERSONALITY_PRESETS: Record<
  BrandKitProposal["motion"]["personality"],
  string[]
> = {
  calm: ["fade-in", "fade-up", "scale-in", "blur-reveal"],
  balanced: ["fade-up", "stagger-entrance", "slide-left", "scroll-reveal"],
  expressive: ["stagger-cards", "split-clip", "word-reveal", "parallax-image"],
};

function motionForPersonality(personality: BrandKitProposal["motion"]["personality"]): string[] {
  return MOTION_PERSONALITY_PRESETS[personality].filter((id) => getMotionPreset(id) !== null);
}

function buildPairings(input: BrandKitInput, words: string[]): FontPairing[] {
  const override = input.fontOverride;
  const coverage = languageCoverage(input.languages);
  const pairings: FontPairing[] = [];

  if (override) {
    // User override path — exact ids required, unsupported weights rejected.
    const headingDef = requireFont(override.heading, "heading");
    const bodyDef = requireFont(override.body, "body");
    const accentDef = override.accent ? requireFont(override.accent, "accent") : undefined;

    if (override.weights) {
      for (const role of [
        { def: headingDef, role: "heading" as const },
        { def: bodyDef, role: "body" as const },
        ...(accentDef ? [{ def: accentDef, role: "accent" as const }] : []),
      ]) {
        const missing = override.weights.filter((w) => !role.def.weights.includes(w));
        if (missing.length > 0) {
          throw new BrandKitFieldError(
            `fontOverride.weights`,
            `Family "${role.def.family}" (${role.role}) does not ship weight(s) ${missing.join(", ")} — it ships [${role.def.weights.join(", ")}]. The brand kit never proposes nonexistent weights.`,
            role.def.weights.map(String),
          );
        }
      }
    }

    const weights = override.weights;
    const ref = (def: SiteFontDef) => ({
      ...toFontRef(def),
      weights: weights ? weights.filter((w) => def.weights.includes(w)) : toFontRef(def).weights,
    });
    pairings.push({
      heading: ref(headingDef),
      body: ref(bodyDef),
      ...(accentDef ? { accent: ref(accentDef) } : {}),
      rationale:
        "User-selected override — the exact families you chose, validated against the live font registry (weights limited to what each family actually ships).",
      ...coverage,
      previewHref: fontPreviewHref(
        accentDef ? [ref(headingDef), ref(bodyDef), ref(accentDef)] : [ref(headingDef), ref(bodyDef)],
      ),
    });
  }

  // Deterministic registry pairings (always at least one alternative).
  const headingPool = pickCandidates(words, scoreHeadingCandidate, override ? [override.heading] : []);
  const bodyPool = pickCandidates(words, scoreBodyCandidate, override ? [override.body] : []);
  const monoPool = SITE_FONTS.filter(
    (f) => f.kind === "mono" && f.weights.includes(400),
  );

  const target = override ? 3 : 2;
  const usedHeadings = new Set<string>(override ? [override.heading] : []);
  const usedBodies = new Set<string>(override ? [override.body] : []);
  for (const headingDef of headingPool) {
    if (pairings.length >= target) break;
    if (usedHeadings.has(headingDef.id)) continue;
    const bodyDef = bodyPool.find((b) => b.id !== headingDef.id && !usedBodies.has(b.id));
    if (!bodyDef) continue;
    usedHeadings.add(headingDef.id);
    usedBodies.add(bodyDef.id);
    const useMono = input.fontOverride === undefined && monoPool.length > 0;
    const accentDef = useMono ? monoPool[0] : undefined;
    pairings.push({
      heading: toFontRef(headingDef),
      body: toFontRef(bodyDef),
      ...(accentDef ? { accent: toFontRef(accentDef) } : {}),
      rationale:
        `Registry pairing: "${headingDef.family}" (${headingDef.category}) for display/heading and ` +
        `"${bodyDef.family}" (${bodyDef.category}) for body — weights restricted to the families' real ` +
        `Google Fonts weights${accentDef ? `, with "${accentDef.family}" reserved for code/data labels` : ""}.`,
      ...coverage,
      previewHref: fontPreviewHref(
        accentDef
          ? [toFontRef(headingDef), toFontRef(bodyDef), toFontRef(accentDef)]
          : [toFontRef(headingDef), toFontRef(bodyDef)],
      ),
    });
  }

  return pairings;
}

/**
 * Build a validated brand-kit proposal from explicit user attributes.
 * Pure and deterministic: same input → same proposal. Throws
 * `BrandKitFieldError` on unknown explicit ids (callers convert it to a
 * rejection response — the API route does exactly that).
 */
export function buildBrandKitProposal(rawInput: BrandKitInput): BrandKitProposal {
  // Normalize schema defaults for direct (non-parsed) calls so the pure
  // builder behaves identically whether or not zod applied its defaults.
  const input: Required<Pick<BrandKitInput, "toneAdjectives" | "languages" | "paletteDirection" | "motionPersonality">> &
    BrandKitInput = {
    ...rawInput,
    toneAdjectives: rawInput.toneAdjectives ?? [],
    languages: rawInput.languages ?? [],
    paletteDirection: rawInput.paletteDirection ?? "auto",
    motionPersonality: rawInput.motionPersonality ?? "balanced",
  };

  const words = [
    ...input.toneAdjectives.map((a) => a.toLowerCase().trim()),
    ...(input.sector ? input.sector.toLowerCase().split(/[^a-z]+/) : []),
    ...(input.audience ? input.audience.toLowerCase().split(/[^a-z]+/) : []),
  ].filter((w) => w.length > 2);

  const directionQuery =
    `${input.sector ?? ""} ${input.audience ?? ""} ${input.toneAdjectives.join(" ")} ${input.notes ?? ""}`.trim();
  const [language] =
    directionQuery.length > 0
      ? matchDesignLanguages(directionQuery, 1)
      : [DESIGN_LANGUAGES.find((l) => l.id === "modern-minimal") ?? DESIGN_LANGUAGES[0]];

  const warnings: string[] = [];
  const assumptions: string[] = [];

  const pairings = buildPairings(input, words);
  const palettes = paletteCandidates(language.id, input.paletteDirection, warnings);
  const motion = {
    personality: input.motionPersonality,
    presets: motionForPersonality(input.motionPersonality),
  };

  if ((input.languages ?? []).length === 0) {
    assumptions.push(
      "No content language was specified — the pairing assumes Latin-script copy. State the intended languages to get an honest coverage verdict.",
    );
  }
  assumptions.push(
    "This proposal is generated from your explicit attributes only — no personality or psychographic inference is performed.",
  );
  if (palettes.length === 0) {
    assumptions.push(
      "No palette candidate passed the body-contrast gate; choose an explicit paletteDirection so the proposal can carry a vetted palette.",
    );
  }

  return {
    brandName: input.brandName ?? null,
    designLanguage: { id: language.id, label: language.label, tagline: language.tagline },
    pairings,
    palettes,
    motion,
    assumptions,
    warnings,
  };
}

/** Convert a `BrandKitFieldError` into the typed rejection shape. */
export function brandKitRejection(error: BrandKitFieldError): BrandKitRejection {
  return { ok: false, field: error.field, reason: error.reason, suggestions: error.suggestions };
}
