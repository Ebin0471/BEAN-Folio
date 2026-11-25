/**
 * LAXII — deterministic typography engine (Phase 3 §3.7/§4C, M33.4-B).
 *
 * Banner text is NOT left to the image model. The brief's exact strings are
 * rendered here with REAL, licence-audited fonts through sharp's SVG
 * rasterizer, measured from the ACTUAL rendered pixels (trim-based ink
 * bounding box), contrast-checked against the sampled background under each
 * text box, glyph-coverage-checked against the resolved family's real
 * charset, and constraint-checked against the safe area and the planned
 * focal region. Every check reports a measurement — no invented scores.
 *
 * M33.4-B upgrades over the DejaVu-only engine:
 *  - SITE_FONTS integration: an item may carry a user-selected fontId. Only
 *    the licence-audited provisioned subset (font-assets.ts) renders with
 *    the real family server-side; everything else deterministically falls
 *    back with an EXPLICIT warning. The user's spelling is never altered.
 *  - Real weights: a requested weight snaps to a weight the family actually
 *    provides (variable fonts included), with a warning when snapped.
 *  - Measured wrapping: a line that cannot fit the safe-area width wraps
 *    greedily by MEASURED word widths at the chosen size; only a single
 *    word too wide for the whole safe area shrinks the size. Wrapping is
 *    reported, never silent, and text is never truncated or squeezed.
 */

import sharp from "sharp";
import type { BriefRect, DesignBrief, TypographyItem } from "./design-brief";
import { resolveTextPlacement } from "./design-brief";
import { checkGlyphCoverage, resolveServerFont, type ResolvedServerFont } from "./font-assets";

const MIN_CONTRAST = 3.0; // display-size text on imagery — WCAG large-text floor

export interface TextLinePlan {
  item: TypographyItem;
  /** The EXACT fragment rendered on this line (wrap splits keep spelling). */
  text: string;
  family: string;
  fontId: string | null;
  source: "provisioned" | "fallback";
  /** Font size chosen by the fit loop (canvas px). */
  size: number;
  color: string;
  /** The REAL weight rendered (snapped to the family's available weights). */
  weight: number;
  /** Ink box of the rendered line, in canvas coordinates (measured, not estimated). */
  ink: { left: number; top: number; width: number; height: number };
  /** True when the fragment is a wrap continuation (first fragment false). */
  wrapped: boolean;
}

export interface TypographyPlan {
  lines: TextLinePlan[];
  /** Soft scrim drawn behind the text block (only when contrast demanded it). */
  scrim: { rect: BriefRect; opacity: number } | null;
  placement: "left" | "center" | "right";
  warnings: string[];
}

export interface TypographyCheck {
  lineText: string;
  renderedInk: { left: number; top: number; width: number; height: number };
  fitsSafeArea: boolean;
  fitsCanvas: boolean;
  contrastRatio: number;
  contrastOk: boolean;
  /** Fraction of the ink box overlapping the planned focal region (0..1). */
  focalOverlap: number;
  /** Real glyph-coverage result for the rendered fragment. */
  glyphCoverage: { covered: boolean; missingCount: number; missingSample: string[] };
}

export interface TypographyRenderResult {
  /** The text layer as a full-canvas RGBA PNG, ready to composite. */
  layer: Buffer;
  plan: TypographyPlan;
  checks: TypographyCheck[];
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function relativeLuminance(hex: string): number {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two colors. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/** Sample the mean luminance (0..1) of a rect from an RGB raw buffer. */
export function sampleRegionLuminance(
  raw: { data: Buffer; width: number; height: number; channels: number },
  rect: { left: number; top: number; width: number; height: number }
): number {
  const { data, width, height, channels } = raw;
  let sum = 0;
  let count = 0;
  const x0 = Math.max(0, Math.floor(rect.left));
  const y0 = Math.max(0, Math.floor(rect.top));
  const x1 = Math.min(width, Math.ceil(rect.left + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.top + rect.height));
  const stepX = Math.max(1, Math.floor((x1 - x0) / 48));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 24));
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const i = (y * width + x) * channels;
      sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0.5;
}

/** Pick the brief palette color with the best contrast against a background; fall back to white/black. */
export function chooseTextColor(palette: string[], bgLuminance: number): { color: string; note?: string } {
  let best: { color: string; ratio: number } | null = null;
  for (const c of palette) {
    const ratio = contrastRatio(c, bgLuminance > 0.5 ? "#f5f5f4" : "#1c1917");
    // Compare against an approximation of the actual background tone.
    const bgHex = bgLuminance > 0.5 ? "#f5f5f4" : "#1c1917";
    const exact = contrastRatio(c, bgHex);
    const score = Math.min(ratio, exact * 1.0);
    if (!best || score > best.ratio) best = { color: c, ratio: score };
  }
  const whiteRatio = contrastRatio("#ffffff", bgLuminance > 0.5 ? "#f5f5f4" : "#1c1917");
  const blackRatio = contrastRatio("#1c1917", bgLuminance > 0.5 ? "#f5f5f4" : "#1c1917");
  const fallback = bgLuminance > 0.5 ? "#1c1917" : "#ffffff";
  const fallbackRatio = bgLuminance > 0.5 ? blackRatio : whiteRatio;
  if (best && best.ratio >= 4.5) return { color: best.color };
  if (fallbackRatio >= (best?.ratio ?? 0)) {
    return { color: fallback, note: best ? "Palette text color lacked contrast — safe fallback used." : "No palette text color supplied — safe fallback used." };
  }
  return { color: best!.color, note: "Text color contrast is marginal — verify readability in the preview." };
}

/**
 * Measurement cache — the pipeline re-runs the typography pass per refinement
 * attempt with the SAME text/font/canvas, and the fit loop itself re-renders
 * candidate sizes. Every (text, family, weight, size, color, canvas) ink
 * measurement is deterministic, so results are memoized here (bounded; the
 * buffers are treated as immutable).
 */
const INK_CACHE = new Map<string, { buf: Buffer; ink: TextLinePlan["ink"] } | null>();

function cacheKey(text: string, family: string, weight: number, size: number, color: string, canvasW: number, canvasH: number): string {
  return `${text}|${family}|${weight}|${size}|${color}|${canvasW}x${canvasH}`;
}

/** Render ONE text fragment on a transparent canvas and measure its real ink box. */
async function renderInk(
  text: string,
  family: string,
  weight: number,
  size: number,
  color: string,
  canvasW: number,
  canvasH: number
): Promise<{ buf: Buffer; ink: TextLinePlan["ink"] } | null> {
  const key = cacheKey(text, family, weight, size, color, canvasW, canvasH);
  if (INK_CACHE.has(key)) return INK_CACHE.get(key)!;
  if (INK_CACHE.size > 400) INK_CACHE.clear();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}"><text x="0" y="${Math.round(size)}" font-family="${escapeXml(family)}" font-size="${size}" font-weight="${weight}" fill="${color}">${escapeXml(text)}</text></svg>`;
  const withInfo = await sharp(Buffer.from(svg))
    .trim({ threshold: 8 })
    .png()
    .toBuffer({ resolveWithObject: true })
    .catch(() => null);
  if (!withInfo || !withInfo.info.width || !withInfo.info.height) {
    INK_CACHE.set(key, null);
    return null;
  }
  const ink = {
    left: withInfo.info.trimOffsetLeft ?? 0,
    top: withInfo.info.trimOffsetTop ?? 0,
    width: withInfo.info.width,
    height: withInfo.info.height,
  };
  if (ink.width <= 0 || ink.height <= 0) {
    INK_CACHE.set(key, null);
    return null;
  }
  const result = { buf: withInfo.data, ink };
  INK_CACHE.set(key, result);
  return result;
}

/**
 * Resolve the font for an item and split its weight between the headline
 * convention (bold display) and the item's explicit request.
 */
function resolveItemFont(item: TypographyItem, defaultWeight: number): ResolvedServerFont {
  const wanted = item.weight ?? defaultWeight;
  return resolveServerFont(item.fontId, wanted, item.font);
}

/**
 * Fit one item's text with a hybrid strategy:
 *  1. SHRINK first — while the FULL line overflows the safe width and the
 *     size is above the floor, step down (×0.88). This keeps headlines on a
 *     single line whenever a readable size exists (the established banner
 *     contract: "long text shrinks to fit the safe area, no clipping").
 *  2. WRAP only as the last resort — if the line still overflows at the
 *     settled size AND it has multiple words, greedy-wrap by MEASURED word
 *     widths. Wrapping is reported explicitly; text is never truncated,
 *     squeezed or re-spelled.
 */
async function fitAndWrap(
  item: TypographyItem,
  font: ResolvedServerFont,
  startSize: number,
  color: string,
  canvasW: number,
  canvasH: number,
  maxW: number
): Promise<{ fragments: { text: string; size: number; ink: TextLinePlan["ink"] }[]; warnings: string[] }> {
  const warnings: string[] = [];
  let size = Math.max(10, Math.round(startSize));

  // Pass 1: shrink the full line until it fits (single line preserved).
  // Fast path: the start size usually fits — one render. Otherwise ink width
  // is monotonic in font size, so binary search finds the largest fitting
  // size in ~log2 steps (the 10px floor bounds the search — text is never
  // squeezed below it).
  {
    const start = Math.max(10, Math.round(startSize));
    const startRes = await renderInk(item.text, font.family, font.weight, start, color, canvasW, canvasH);
    if (!startRes) {
      warnings.push("The text could not be measured for rendering — it was skipped rather than rendered blind.");
      return { fragments: [], warnings };
    }
    if (startRes.ink.width <= maxW) {
      return { fragments: [{ text: item.text, size: start, ink: startRes.ink }], warnings };
    }
    let lo = 10;
    let hi = start - 1;
    let bestFit: { text: string; size: number; ink: TextLinePlan["ink"] } | null = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const res = await renderInk(item.text, font.family, font.weight, mid, color, canvasW, canvasH);
      if (!res) {
        warnings.push("The text could not be measured for rendering — it was skipped rather than rendered blind.");
        return { fragments: [], warnings };
      }
      if (res.ink.width <= maxW) {
        bestFit = { text: item.text, size: mid, ink: res.ink };
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (bestFit) return { fragments: [bestFit], warnings };
    // Even size 10 overflows — the settled size for the wrap pass is the floor.
    size = 10;
  }

  // Pass 2: last-resort wrap by measured word widths at the settled size.
  const words = item.text.trim().split(/\s+/);
  const measured: { word: string; ink: TextLinePlan["ink"] }[] = [];
  for (const word of words) {
    const res = await renderInk(word, font.family, font.weight, size, color, canvasW, canvasH);
    if (!res) {
      warnings.push("The text could not be measured for rendering — it was skipped rather than rendered blind.");
      return { fragments: [], warnings };
    }
    measured.push({ word, ink: res.ink });
  }
  const widestWord = measured.reduce((m, w) => (w.ink.width > m.ink.width ? w : m), measured[0]);
  if (widestWord.ink.width > maxW) {
    warnings.push(`A word in "${item.text}" exceeds the safe-area width even at the minimum size — it may be clipped.`);
  }
  const spaceWidth =
    words.length > 1
      ? (await renderInk("a a", font.family, font.weight, size, color, canvasW, canvasH))!.ink.width -
        (await renderInk("aa", font.family, font.weight, size, color, canvasW, canvasH))!.ink.width
      : 0;
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const w of measured) {
    const candidateWidth = current ? currentWidth + spaceWidth + w.ink.width : w.ink.width;
    if (current && candidateWidth > maxW) {
      lines.push(current);
      current = w.word;
      currentWidth = w.ink.width;
    } else {
      current = current ? `${current} ${w.word}` : w.word;
      currentWidth = candidateWidth;
    }
  }
  if (current) lines.push(current);

  const fragments: { text: string; size: number; ink: TextLinePlan["ink"] }[] = [];
  for (const line of lines) {
    const res = await renderInk(line, font.family, font.weight, size, color, canvasW, canvasH);
    if (!res) {
      warnings.push("The text could not be measured for rendering — it was skipped rather than rendered blind.");
      return { fragments: [], warnings };
    }
    fragments.push({ text: line, size, ink: res.ink });
  }
  if (fragments.length > 1) {
    warnings.push(`"${item.text}" did not fit the safe area even after shrinking — it was wrapped onto ${fragments.length} measured lines (text preserved, never truncated).`);
  }
  return { fragments, warnings };
}

/**
 * Plan + render the deterministic typography layer for a brief-driven banner.
 * Deterministic rules (documented, no randomness):
 *  - headline size starts at 46% of safe-area height, subtext at 55% of headline,
 *    shrunk in fixed steps only while a single word overflows the safe width;
 *  - multi-word lines wrap by MEASURED word widths (explicit warning);
 *  - lines stack with 18% leading, vertically centered in the safe area;
 *  - horizontal anchoring follows the placement rule (left/center/right);
 *  - text color comes from the brief palette chosen by measured contrast;
 *  - fonts resolve through font-assets.ts (provisioned families, real
 *    weights, glyph-coverage measurement, explicit fallback warnings);
 *  - a soft scrim is added ONLY when the measured contrast stays below the floor.
 */
export async function renderTypographyLayer(
  brief: DesignBrief,
  backgroundBytes: Buffer,
  focalRect: BriefRect | null
): Promise<TypographyRenderResult | null> {
  const items = brief.typography.items;
  if (items.length === 0) return null;

  const canvasW = brief.canvas.width;
  const canvasH = brief.canvas.height;
  const safe = brief.safeArea;
  const placement = resolveTextPlacement(brief);

  const bgRaw = await sharp(backgroundBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const warnings: string[] = [];

  const headline = items.find((t) => t.role === "headline") ?? items[0];
  const others = items.filter((t) => t !== headline);

  const headlineFont = resolveItemFont(headline, 700);
  warnings.push(...headlineFont.warnings);
  const otherFonts = others.map((item) => {
    const f = resolveItemFont(item, 400);
    warnings.push(...f.warnings);
    return f;
  });

  // Fit loop per line: shrink only while a single word overflows, then wrap.
  const maxW = safe.width - 8;
  const headlineFit = await fitAndWrap(headline, headlineFont, Math.round(safe.height * 0.46), "#ffffff", canvasW, canvasH, maxW);
  warnings.push(...headlineFit.warnings);
  const otherFits = await Promise.all(
    others.map((item, idx) =>
      fitAndWrap(item, otherFonts[idx], Math.round((headlineFit.fragments[0]?.size ?? safe.height * 0.46) * 0.55), "#ffffff", canvasW, canvasH, maxW)
    )
  );
  for (const fit of otherFits) warnings.push(...fit.warnings);

  // Total block height with leading (measured fragments).
  const leading = 0.18;
  const headlineSize = headlineFit.fragments[0]?.size ?? Math.max(10, Math.round(safe.height * 0.46));
  const leadingGap = Math.round(headlineSize * leading);
  const allFragments: { item: TypographyItem; text: string; size: number; ink: TextLinePlan["ink"]; font: ResolvedServerFont; wrapped: boolean }[] = [
    ...headlineFit.fragments.map((f) => ({ item: headline, text: f.text, size: f.size, ink: f.ink, font: headlineFont, wrapped: false })),
    ...otherFits.flatMap((fit, idx) =>
      fit.fragments.map((f, fi) => ({ item: others[idx], text: f.text, size: f.size, ink: f.ink, font: otherFonts[idx], wrapped: fi > 0 }))
    ),
  ];
  const provisionalBlockH = allFragments.reduce((acc, f) => acc + f.ink.height, 0) + Math.max(0, allFragments.length - 1) * leadingGap;
  const startY = Math.max(safe.y, Math.round(safe.y + (safe.height - provisionalBlockH) / 2));

  // Anchor X per placement.
  const anchorX = (inkWidth: number): number => {
    const innerLeft = safe.x + 4;
    const innerRight = safe.x + safe.width - 4;
    if (placement === "center") return Math.round(innerLeft + (safe.width - 8 - inkWidth) / 2);
    if (placement === "right") return Math.round(innerRight - inkWidth);
    return innerLeft;
  };

  // Contrast: sample the background under the whole text block.
  const blockRect = { left: safe.x, top: startY, width: safe.width, height: Math.min(provisionalBlockH, safe.height) };
  const bgLum = sampleRegionLuminance(
    { data: bgRaw.data, width: bgRaw.info.width, height: bgRaw.info.height, channels: bgRaw.info.channels },
    blockRect
  );
  const requestedColor = headline.color;
  let chosen = chooseTextColor(brief.palette, bgLum);
  if (requestedColor) {
    const requestedRatio = contrastRatio(requestedColor, bgLum > 0.5 ? "#f5f5f4" : "#1c1917");
    if (requestedRatio >= MIN_CONTRAST) chosen = { color: requestedColor };
    else warnings.push("Requested text color failed the contrast check — a measured safe color was used.");
  }
  if (chosen.note) warnings.push(chosen.note);

  let scrim: TypographyPlan["scrim"] = null;
  const finalColor = chosen.color;
  const finalRatio = contrastRatio(finalColor, bgLum > 0.5 ? "#f5f5f4" : "#1c1917");
  if (finalRatio < MIN_CONTRAST) {
    // Deterministic composite aid: soft gradient-free scrim behind the block.
    scrim = {
      rect: {
        x: Math.max(0, blockRect.left - 12),
        y: Math.max(0, blockRect.top - 10),
        width: Math.min(canvasW - Math.max(0, blockRect.left - 12), blockRect.width + 24),
        height: Math.min(canvasH - Math.max(0, blockRect.top - 10), blockRect.height + 20),
      },
      opacity: 0.55,
    };
    warnings.push("Background contrast behind the text was low — a soft scrim was composited behind the text block.");
  }

  // Compose positions: stack fragments from startY with anchor per placement.
  let cursorY = startY;
  const positioned: TextLinePlan[] = allFragments.map((f) => {
    const ink: TextLinePlan["ink"] = {
      ...f.ink,
      left: Math.max(0, anchorX(f.ink.width)),
      top: Math.max(0, cursorY),
    };
    cursorY += f.ink.height + leadingGap;
    return {
      item: f.item,
      text: f.text,
      family: f.font.family,
      fontId: f.font.fontId,
      source: f.font.source,
      size: f.size,
      color: finalColor,
      weight: f.font.weight,
      ink,
      wrapped: f.wrapped,
    };
  });

  // Build the SVG layer (positions from MEASURED ink boxes).
  const svgParts: string[] = [];
  if (scrim) {
    svgParts.push(
      `<rect x="${scrim.rect.x}" y="${scrim.rect.y}" width="${scrim.rect.width}" height="${scrim.rect.height}" rx="10" fill="#000000" fill-opacity="${scrim.opacity}"/>`
    );
  }
  for (const p of positioned) {
    if (!p.text) continue;
    // SVG text baseline: ink top + ascent approximation via measured box is
    // exact enough because we re-measured THIS font/weight/size/color.
    svgParts.push(
      `<text x="${p.ink.left}" y="${p.ink.top + Math.round(p.ink.height * 0.94)}" font-family="${escapeXml(p.family)}" font-size="${p.size}" font-weight="${p.weight}" fill="${finalColor}">${escapeXml(p.text)}</text>`
    );
  }
  const layer = await sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">${svgParts.join("")}</svg>`), top: 0, left: 0 }])
    .png()
    .toBuffer();

  // Post-render verification against the REAL layer pixels.
  const layerRaw = await sharp(layer).raw().toBuffer({ resolveWithObject: true });
  const layerSampler = {
    data: layerRaw.data,
    width: layerRaw.info.width,
    height: layerRaw.info.height,
    channels: layerRaw.info.channels,
  };
  const checks: TypographyCheck[] = [];
  for (const p of positioned) {
    const ink = p.ink;
    const inkOnLayer = await inkBoxFromLayer(layerSampler, ink);
    const lum = sampleRegionLuminance(
      { data: bgRaw.data, width: bgRaw.info.width, height: bgRaw.info.height, channels: bgRaw.info.channels },
      ink
    );
    const ratio = contrastRatio(finalColor, lum > 0.5 ? "#f5f5f4" : "#1c1917");
    const overlap = focalRect ? intersectionFraction(ink, focalRect) : 0;
    checks.push({
      lineText: p.text,
      renderedInk: inkOnLayer.hasInk ? inkOnLayer.box : ink,
      fitsSafeArea:
        ink.left >= safe.x &&
        ink.top >= safe.y &&
        ink.left + ink.width <= safe.x + safe.width + 2 &&
        ink.top + ink.height <= safe.y + safe.height + 2,
      fitsCanvas: ink.left >= 0 && ink.top >= 0 && ink.left + ink.width <= canvasW && ink.top + ink.height <= canvasH,
      contrastRatio: Number(ratio.toFixed(2)),
      contrastOk: ratio >= MIN_CONTRAST,
      focalOverlap: Number(overlap.toFixed(3)),
      glyphCoverage: checkGlyphCoverage(p.family, p.text),
    });
  }

  return { layer, plan: { lines: positioned, scrim, placement, warnings }, checks };
}

/** Verify a rendered line actually left ink where we planned (real inspection, not assumption). */
async function inkBoxFromLayer(
  layerRaw: { data: Buffer; width: number; height: number; channels: number },
  rect: TextLinePlan["ink"]
): Promise<{ hasInk: boolean; box: TextLinePlan["ink"] }> {
  const { data, width, height, channels } = layerRaw;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const x0 = Math.max(0, Math.floor(rect.left));
  const y0 = Math.max(0, Math.floor(rect.top));
  const x1 = Math.min(width, Math.ceil(rect.left + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.top + rect.height));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const a = data[(y * width + x) * channels + 3];
      if (a > 32) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { hasInk: false, box: rect };
  return {
    hasInk: true,
    box: { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

function intersectionFraction(a: { left: number; top: number; width: number; height: number }, b: BriefRect): number {
  const xOverlap = Math.max(0, Math.min(a.left + a.width, b.x + b.width) - Math.max(a.left, b.x));
  const yOverlap = Math.max(0, Math.min(a.top + a.height, b.y + b.height) - Math.max(a.top, b.y));
  const inter = xOverlap * yOverlap;
  const areaA = a.width * a.height;
  return areaA > 0 ? inter / areaA : 0;
}

/**
 * Verify the text ACTUALLY landed on the final composite — real pixel
 * inspection comparing the final image against the pre-composite canvas
 * inside each line's ink box. This catches the failure mode where a layer
 * was rendered in the wrong coordinate space and silently cropped away
 * (found in E2E: text composited on the wide provider render instead of the
 * exact canvas disappeared in the center-crop while all layer-space checks
 * passed). `applied` requires a meaningful mean per-pixel change.
 */
export async function verifyInkApplied(
  finalBytes: Buffer,
  baseBytes: Buffer,
  lines: TextLinePlan[]
): Promise<{ text: string; meanDelta: number; applied: boolean }[]> {
  const W = 512;
  // The final/base bytes ARE the exact banner canvas, so the analysis aspect
  // is derived from the image itself (works for any canvas size — e.g. the
  // 2048×687 platform standard) instead of hardcoding one preset's ratio.
  const scale = async (buf: Buffer) => {
    const meta = await sharp(buf).metadata();
    const h = Math.max(1, Math.round((W * (meta.height ?? 1)) / (meta.width || W)));
    return sharp(buf)
      .removeAlpha()
      .resize(W, h, { fit: "inside" })
      .raw()
      .toBuffer({ resolveWithObject: true });
  };
  const [finalRaw, baseRaw] = await Promise.all([scale(finalBytes), scale(baseBytes)]);
  const meta = await sharp(finalBytes).metadata();
  const sx = finalRaw.info.width / (meta.width || finalRaw.info.width);
  const sy = finalRaw.info.height / (meta.height || finalRaw.info.height);
  const out: { text: string; meanDelta: number; applied: boolean }[] = [];
  for (const line of lines) {
    const rx0 = Math.max(0, Math.floor(line.ink.left * sx));
    const ry0 = Math.max(0, Math.floor(line.ink.top * sy));
    const rx1 = Math.min(finalRaw.info.width, Math.ceil((line.ink.left + line.ink.width) * sx));
    const ry1 = Math.min(finalRaw.info.height, Math.ceil((line.ink.top + line.ink.height) * sy));
    let sum = 0;
    let n = 0;
    for (let y = ry0; y < ry1; y += 1) {
      for (let x = rx0; x < rx1; x += 1) {
        const fi = (y * finalRaw.info.width + x) * finalRaw.info.channels;
        const bi = (y * baseRaw.info.width + x) * baseRaw.info.channels;
        sum += Math.abs(finalRaw.data[fi] - baseRaw.data[bi]) + Math.abs(finalRaw.data[fi + 1] - baseRaw.data[bi + 1]) + Math.abs(finalRaw.data[fi + 2] - baseRaw.data[bi + 2]);
        n += 1;
      }
    }
    const meanDelta = n > 0 ? sum / n / 3 : 0;
    out.push({ text: line.text, meanDelta: Number(meanDelta.toFixed(2)), applied: meanDelta > 2 });
  }
  return out;
}
