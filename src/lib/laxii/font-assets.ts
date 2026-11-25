/**
 * LAXII — server-side font resolution for deterministic typography (M33.4-B).
 *
 * The banner typography engine (typography.ts) renders the user's EXACT
 * strings through sharp's SVG rasterizer (librsvg + Pango + fontconfig).
 * This module is the single place that decides WHICH font that renderer
 * actually uses:
 *
 *  1. `PROVISIONED_BANNER_FONTS` — a small, licence-audited subset of the
 *     SITE_FONTS registry whose real font files are pinned (sha256), tracked
 *     in `data/laxii-fonts/` with their own OFL licence text, and installed
 *     into the per-user fontconfig directory by `ensureBannerFontsInstalled`.
 *     Only families whose files exist AND whose fontconfig match succeeds
 *     are offered as provisioned.
 *  2. Everything else in SITE_FONTS (129 families) is NOT available as a
 *     server-side file. Requests for those ids resolve to a deterministic
 *     kind-based fallback (DejaVu Sans/Serif/Mono — free license, shipped
 *     with the rendering stack) with an EXPLICIT warning. The product never
 *     silently pretends a family rendered.
 *
 * Weights are real: a provisioned family exposes only the weights its pinned
 * files actually provide (variable fonts expose their full axis; static
 * files expose their own weight). A requested weight outside that set snaps
 * to the nearest available one with a warning — the browser-side
 * nearestWeight contract (site-fonts.ts) mirrored server-side.
 *
 * Glyph coverage is measured, not assumed: the matched font's charset (from
 * fontconfig) is parsed into ranges and every codepoint of the requested
 * text is checked against it. Uncovered text produces an explicit warning
 * and never aborts the render (Pango falls back to a system font that does
 * cover the script — the warning says exactly that).
 *
 * Server-only: shells out to fc-match; never import from client components.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getFont, type FontKind } from "@/lib/site-fonts";

export interface ProvisionedFontFile {
  /** Tracked file under data/laxii-fonts/<fontId>/font.ttf */
  file: string;
  sha256: string;
  /** Weights this exact file provides (variable fonts: full axis). */
  weights: number[];
}

export interface ProvisionedFontDef {
  /** SITE_FONTS registry id. */
  fontId: string;
  /** Real family name (what fontconfig/librsvg resolves). */
  family: string;
  kind: FontKind;
  licence: "OFL-1.1";
  /** Exact upstream source path (google/fonts repo). */
  upstreamUrl: string;
  files: ProvisionedFontFile[];
}

/**
 * The provisioned set (M33.4-B). Every entry's binary is sha256-pinned by
 * scripts/laxii/prefetch-banner-fonts.ts and ships with its own OFL.txt.
 * Google Fonts families are individually OFL-licensed; the licence text of
 * record sits next to the file in data/laxii-fonts/<id>/OFL.txt.
 */
export const PROVISIONED_BANNER_FONTS: ProvisionedFontDef[] = [
  {
    fontId: "fraunces",
    family: "Fraunces",
    kind: "serif",
    licence: "OFL-1.1",
    upstreamUrl: "https://github.com/google/fonts/tree/main/ofl/fraunces",
    files: [{ file: "font.ttf", sha256: "177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb", weights: [300, 400, 500, 600, 700, 800, 900] }],
  },
  {
    fontId: "inter",
    family: "Inter",
    kind: "sans",
    licence: "OFL-1.1",
    upstreamUrl: "https://github.com/google/fonts/tree/main/ofl/inter",
    files: [{ file: "font.ttf", sha256: "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] }],
  },
  {
    fontId: "anton",
    family: "Anton",
    kind: "display",
    licence: "OFL-1.1",
    upstreamUrl: "https://github.com/google/fonts/tree/main/ofl/anton",
    files: [{ file: "font.ttf", sha256: "a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab", weights: [400] }],
  },
  {
    fontId: "oswald",
    family: "Oswald",
    kind: "display",
    licence: "OFL-1.1",
    upstreamUrl: "https://github.com/google/fonts/tree/main/ofl/oswald",
    files: [{ file: "font.ttf", sha256: "5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817", weights: [200, 300, 400, 500, 600, 700] }],
  },
  {
    fontId: "lato",
    family: "Lato",
    kind: "sans",
    licence: "OFL-1.1",
    upstreamUrl: "https://github.com/google/fonts/tree/main/ofl/lato",
    files: [
      { file: "font.ttf", sha256: "d636e4683231f931eda222d588e944d082bfd3bdba02f928bee461c0f185b251", weights: [400] },
      { file: "bold.ttf", sha256: "8a0aace75d33794eece4b28187bfc1df0bbd2888b5d8a56e01788c8d65d16be1", weights: [700] },
      { file: "black.ttf", sha256: "808c62839c62dbce7de689af7603666fc7f8b81e0df537d8a5212c87580d4337", weights: [900] },
    ],
  },
  {
    fontId: "merriweather",
    family: "Merriweather",
    kind: "serif",
    licence: "OFL-1.1",
    upstreamUrl: "https://github.com/google/fonts/tree/main/ofl/merriweather",
    files: [{ file: "font.ttf", sha256: "d0ed0e359e396af7ad05e73dffd11a3a4c326ea0d0283c56bd9361cb2cc86a96", weights: [300, 400, 500, 600, 700, 800, 900] }],
  },
  {
    fontId: "caveat",
    family: "Caveat",
    kind: "script",
    licence: "OFL-1.1",
    upstreamUrl: "https://github.com/google/fonts/tree/main/ofl/caveat",
    files: [{ file: "font.ttf", sha256: "0bdb6b660482d31531b3945849fba5916b3ef8695da7024a9e6b9ee3c4157988", weights: [300, 400, 500, 600, 700] }],
  },
  {
    fontId: "pacifico",
    family: "Pacifico",
    kind: "script",
    licence: "OFL-1.1",
    upstreamUrl: "https://github.com/google/fonts/tree/main/ofl/pacifico",
    files: [{ file: "font.ttf", sha256: "5b6c0d5334a7bf77dea52b975c5a0c408878c0f7115ed5b6fb151f634b7bf701", weights: [400] }],
  },
  {
    fontId: "kalam",
    family: "Kalam",
    kind: "script",
    licence: "OFL-1.1",
    upstreamUrl: "https://github.com/google/fonts/tree/main/ofl/kalam",
    files: [{ file: "font.ttf", sha256: "57cecb63d4608019371954274ae1d8c397764debd5b19d4a33c1efa4dc923c0b", weights: [400] }],
  },
];

/** Deterministic kind-based fallbacks (system DejaVu family, free licence). */
const FALLBACK_BY_KIND: Record<FontKind, { family: string; weights: number[]; note: string }> = {
  sans: { family: "DejaVu Sans", weights: [400, 700], note: "system sans" },
  serif: { family: "DejaVu Serif", weights: [400, 700], note: "system serif" },
  mono: { family: "DejaVu Sans Mono", weights: [400, 700], note: "system mono" },
  display: { family: "DejaVu Serif", weights: [400, 700], note: "system serif (display fallback)" },
  script: { family: "DejaVu Sans", weights: [400, 700], note: "system sans (script fallback)" },
};

const FONTS_ROOT = path.join(process.cwd(), "data", "laxii-fonts");
const USER_FONT_DIR = path.join(os.homedir(), ".local", "share", "fonts", "bean-laxii");

export interface ResolvedServerFont {
  ok: boolean;
  /** Family name to embed in the SVG (what Pango resolves). */
  family: string;
  /** SITE_FONTS id actually used (the fallback is id-less → null). */
  fontId: string | null;
  /** Weights the resolved font actually provides. */
  weights: number[];
  weight: number;
  source: "provisioned" | "fallback";
  warnings: string[];
}

interface FcMatchResult {
  matchedFamily: string;
  file: string;
}

let fcAvailable: boolean | null = null;
const matchCache = new Map<string, FcMatchResult | null>();
const charsetCache = new Map<string, string | null>();
let installAttempted = false;

function runFc(args: string[]): string | null {
  try {
    return execFileSync("fc-match", args, { encoding: "utf8", timeout: 10_000 });
  } catch {
    return null;
  }
}

function fcMatch(pattern: string): FcMatchResult | null {
  if (fcAvailable === null) {
    fcAvailable = runFc(["--version"]) !== null;
    if (!fcAvailable) console.warn("fc-match unavailable — server-side font resolution degrades to kind fallbacks.");
  }
  if (!fcAvailable) return null;
  const cached = matchCache.get(pattern);
  if (cached !== undefined) return cached;
  const out = runFc(["--format=%{family}\t%{file}", pattern]);
  let result: FcMatchResult | null = null;
  if (out) {
    const [family, file] = out.split("\t");
    if (family && file) result = { matchedFamily: family.trim(), file: file.trim() };
  }
  matchCache.set(pattern, result);
  return result;
}

function fcCharset(family: string): string | null {
  if (fcAvailable === null) fcMatch(family); // probes availability + sets the flag
  if (!fcAvailable) return null;
  const cached = charsetCache.get(family);
  if (cached !== undefined) return cached;
  const out = runFc(["--format=%{charset}", family]);
  charsetCache.set(family, out ?? null);
  return out ?? null;
}

function parseCharsetRanges(charset: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const token of charset.split(/\s+/)) {
    if (!token) continue;
    const [a, b] = token.split("-");
    const start = parseInt(a, 16);
    const end = b != null ? parseInt(b, 16) : start;
    if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ start, end });
  }
  return ranges;
}

/**
 * Copy the tracked font files into the per-user fontconfig directory (once
 * per process) and refresh the cache. Best-effort: every failure degrades to
 * the documented kind fallback with a warning — it never throws into a
 * generation flow.
 */
export function ensureBannerFontsInstalled(): { installed: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (installAttempted) return { installed: true, warnings };
  installAttempted = true;
  try {
    if (!existsSync(USER_FONT_DIR)) mkdirSync(USER_FONT_DIR, { recursive: true });
    let copied = 0;
    let present = 0;
    for (const def of PROVISIONED_BANNER_FONTS) {
      def.files.forEach((file, index) => {
        // Multiple static files per family (e.g. Lato Regular/Bold/Black) each
        // install under their own name — fontconfig resolves the correct file
        // for a weight query via each file's own OS/2 weight metadata.
        const suffix = def.files.length > 1 ? `-${index}` : "";
        const source = path.join(FONTS_ROOT, def.fontId, file.file);
        const target = path.join(USER_FONT_DIR, `${def.fontId}${suffix}.ttf`);
        if (existsSync(target)) {
          present += 1;
          return;
        }
        if (!existsSync(source)) {
          warnings.push(`Provisioned font file missing from the repository: ${def.fontId} (run scripts/laxii/prefetch-banner-fonts.ts).`);
          return;
        }
        copyFileSync(source, target);
        copied += 1;
      });
    }
    const totalFiles = PROVISIONED_BANNER_FONTS.reduce((n, d) => n + d.files.length, 0);
    if (copied > 0 || present !== totalFiles) {
      try {
        execFileSync("fc-cache", ["-f", USER_FONT_DIR], { encoding: "utf8", timeout: 30_000, stdio: "ignore" });
      } catch {
        warnings.push("fc-cache could not refresh the font index — newly installed families may not resolve until the next process start.");
      }
    }
    if (copied > 0) matchCache.clear();
    return { installed: true, warnings };
  } catch (e) {
    return { installed: false, warnings: [`Font installation failed: ${e instanceof Error ? e.message : "unknown error"} — kind fallbacks will be used.`] };
  }
}

/**
 * Resolve the ACTUAL server-side font for a requested family/weight.
 * `fontId` is a SITE_FONTS id (or null for the kind fallback directly).
 * Never throws; never silently claims a family it did not resolve.
 */
export function resolveServerFont(
  fontId: string | null | undefined,
  wantedWeight: number | undefined,
  kind: FontKind = "sans"
): ResolvedServerFont {
  ensureBannerFontsInstalled();
  const def = fontId ? PROVISIONED_BANNER_FONTS.find((p) => p.fontId === fontId) ?? null : null;
  const warnings: string[] = [];
  const requestedWeight = Math.round(wantedWeight ?? 400);

  if (def) {
    const match = fcMatch(def.family);
    if (match && match.matchedFamily.toLowerCase().includes(def.family.toLowerCase())) {
      const weights = Array.from(new Set(def.files.flatMap((f) => f.weights))).sort((a, b) => a - b);
      let weight = requestedWeight;
      if (!weights.includes(weight)) {
        weight = weights.reduce((best, w) => (Math.abs(w - requestedWeight) < Math.abs(best - requestedWeight) ? w : best), weights[0]);
        warnings.push(`Weight ${requestedWeight} is not available for ${def.family} server-side — the nearest real weight (${weight}) was used.`);
      }
      return { ok: true, family: def.family, fontId: def.fontId, weights, weight, source: "provisioned", warnings };
    }
    warnings.push(`The provisioned family "${def.family}" did not resolve in the server font index — falling back to ${FALLBACK_BY_KIND[def.kind].family}.`);
  } else if (fontId && getFont(fontId)) {
    warnings.push(`The requested font family "${getFont(fontId)!.family}" is not provisioned for server-side rendering (only ${PROVISIONED_BANNER_FONTS.length} licence-audited families ship font files). Falling back to ${FALLBACK_BY_KIND[kind].family}.`);
  } else if (fontId) {
    warnings.push(`Unknown font id "${fontId}" — falling back to ${FALLBACK_BY_KIND[kind].family}.`);
  }

  const fallback = FALLBACK_BY_KIND[kind];
  const match = fcMatch(fallback.family);
  const ok = Boolean(match && match.matchedFamily.toLowerCase().includes(fallback.family.split(" ")[0].toLowerCase()));
  const weights = fallback.weights;
  let weight = requestedWeight;
  if (!weights.includes(weight)) {
    weight = weights.reduce((best, w) => (Math.abs(w - requestedWeight) < Math.abs(best - requestedWeight) ? w : best), weights[0]);
    warnings.push(`Weight ${requestedWeight} is not available for the fallback ${fallback.family} — ${weight} was used.`);
  }
  if (!ok) warnings.push(`Even the ${fallback.family} fallback did not resolve in the server font index; the renderer will use its default family.`);
  return {
    ok,
    family: ok ? fallback.family : "sans-serif",
    fontId: null,
    weights,
    weight,
    source: "fallback",
    warnings,
  };
}

export interface GlyphCoverage {
  /** True when EVERY codepoint of the text is covered by the family's charset. */
  covered: boolean;
  /** Number of uncovered codepoints (capped report below). */
  missingCount: number;
  /** Up to 8 uncovered codepoints as U+XXXX literals. */
  missingSample: string[];
}

/** Measure the requested text against the family's REAL charset. */
export function checkGlyphCoverage(family: string, text: string): GlyphCoverage {
  const charset = fcCharset(family);
  if (charset === null) {
    return { covered: true, missingCount: 0, missingSample: [] }; // unknown → do not claim a failure; renderer fallback warning covers it
  }
  const ranges = parseCharsetRanges(charset);
  const missing: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 10 || cp === 13 || cp === 9) continue;
    const hit = ranges.some((r) => cp >= r.start && cp <= r.end);
    if (!hit && missing.length < 8) missing.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  return { covered: missing.length === 0, missingCount: missing.length, missingSample: missing };
}

/** How many families are provisioned (for honest docs/UI claims). */
export function provisionedFontCount(): number {
  return PROVISIONED_BANNER_FONTS.length;
}
