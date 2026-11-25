/**
 * LAXII banner canvas preset registry (BEAN Folio).
 *
 * The FIRST entry is and stays the canonical BEAN Folio portfolio banner —
 * the 2048×687 platform-standard ratio shared by every banner surface (see
 * lib/banner.ts). Its slug, dimensions, safe area and composition hint are
 * frozen contracts: profile covers, site heroes and existing conversations
 * depend on them byte-for-byte.
 *
 * The registry around it is versioned (M33.4): every additional entry is a
 * named canvas family with a documented safe area. Platform-specific presets
 * are added ONLY with the dimensions verified against the platform's own
 * official documentation — each entry records `checkedAt` (UTC date of the
 * verification) and `sourceUrl` so the refresh process is explicit.
 * Non-platform (site) presets carry `official: false` and no source claim.
 *
 * Custom dimensions are supported through `resolveCustomBannerCanvas` with
 * strict, documented limits — a custom canvas never masquerades as a named
 * platform preset. Nothing is ever silently stretched or cropped: the
 * pipeline cover-fits only the generated SCENE and keeps text inside the
 * recorded safe area (see banner-pipeline.ts).
 */

import { BANNER_PRESET_SLUG, BANNER_WIDTH, BANNER_HEIGHT } from "@/lib/banner";

/** Re-exported for consumers that resolve the canonical canvas by slug. */
export { BANNER_PRESET_SLUG };

export interface NamedSafeArea {
  /** Device/context label (e.g. "desktop crop", "mobile crop", "TV safe"). */
  label: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface LaxiiBannerPreset {
  slug: string;
  /** Registry schema version of THIS entry (bump when its geometry changes so saved projects can migrate knowingly). */
  version: 1;
  label: string;
  description: string;
  width: number;
  height: number;
  /** Fully-visible guide rectangle in canvas pixels (the primary/default safe area). */
  safeArea: { x: number; y: number; width: number; height: number };
  /** Additional device/context safe areas where a platform documents distinct crops. */
  namedSafeAreas: NamedSafeArea[];
  /** Extra composition guidance appended to banner prompts. */
  compositionHint: string;
  /** Canvas family this preset belongs to (drives grouping in the UI). */
  family: "site" | "platform" | "campaign";
  /** True only when the dimensions were verified against the platform's own official documentation. */
  official: boolean;
  /** UTC date (YYYY-MM-DD) the official specification was last checked; null for non-platform presets. */
  checkedAt: string | null;
  /** Exact official source page the numbers were verified against; null for non-platform presets. */
  sourceUrl: string | null;
  /** Platform file-size cap in bytes when the platform documents one; null = no documented cap. */
  maxBytes: number | null;
  /** Export formats the export pipeline actually supports for this canvas. */
  formats: ("PNG" | "JPEG" | "WEBP")[];
  /** Whether the pipeline can emit transparency for this canvas (banners are opaque compositions). */
  transparency: false;
}

/** Derived aspect ratio (never stored — always consistent with width/height). */
export function bannerAspectRatio(p: { width: number; height: number }): number {
  return p.width / p.height;
}

const centerSafe = (w: number, h: number, fx: number, fy: number) => ({
  x: Math.round((w * (1 - fx)) / 2),
  y: Math.round((h * (1 - fy)) / 2),
  width: Math.round(w * fx),
  height: Math.round(h * fy),
});

/**
 * Official platform-spec verification: 2026-11-25 UTC, from each platform's
 * own help/developer pages (live-scraped, no third-party aggregators).
 * The X/Twitter header preset is deliberately ABSENT: its official help page
 * was unreachable (Cloudflare) at check time, and unverified dimensions must
 * not ship under an "official" label.
 */
export const BANNER_SPEC_CHECKED_AT = "2026-11-25";

export const BANNER_PRESETS: LaxiiBannerPreset[] = [
  {
    slug: BANNER_PRESET_SLUG,
    version: 1,
    label: "BEAN Folio banner",
    description: `2048×687 platform-standard portfolio banner (≈3:1) for BEAN Folio profiles, covers and published sites.`,
    width: BANNER_WIDTH,
    height: BANNER_HEIGHT,
    safeArea: centerSafe(BANNER_WIDTH, BANNER_HEIGHT, 0.86, 0.9), // ≈1761×618 centered text-safe zone
    compositionHint:
      "Ultra-wide 2048×687 portfolio banner (about 3:1) composed as ONE horizontal band: place the subject, headline, logo and all key elements in the vertical center half of the frame, with calm margin above and below. Keep all text and logos inside the central safe area; nothing critical near any edge of the frame.",
    family: "site",
    official: false,
    checkedAt: null,
    sourceUrl: null,
    maxBytes: null,
    namedSafeAreas: [],
    formats: ["PNG", "JPEG", "WEBP"],
    transparency: false,
  },
  {
    slug: "website-hero",
    version: 1,
    label: "Website hero",
    description: "1920×1080 (16:9) full-width hero/cover canvas for website headers and page tops.",
    width: 1920,
    height: 1080,
    safeArea: centerSafe(1920, 1080, 0.84, 0.82), // ≈1613×886 — room for overlaid headline blocks
    compositionHint:
      "Wide 16:9 website hero: one dominant subject on one side, generous calm space where a headline block will be composited, all key content inside the central safe area.",
    family: "site",
    official: false,
    checkedAt: null,
    sourceUrl: null,
    maxBytes: null,
    namedSafeAreas: [],
    formats: ["PNG", "JPEG", "WEBP"],
    transparency: false,
  },
  {
    slug: "open-graph-card",
    version: 1,
    label: "Link preview (Open Graph)",
    description:
      "1200×630 (≈1.91:1) social/link-preview card. Official spec (Meta Sharing): ≥1200×630 recommended, 8MB max, 200×200 hard minimum.",
    width: 1200,
    height: 630,
    safeArea: centerSafe(1200, 630, 0.88, 0.88),
    compositionHint:
      "Open Graph link-preview card (1200×630): bold single focal subject, uncluttered center, all text and logos inside the central safe area — the card is cropped by some platforms.",
    family: "platform",
    official: true,
    checkedAt: BANNER_SPEC_CHECKED_AT,
    sourceUrl: "https://developers.facebook.com/docs/sharing/webmasters/images/",
    maxBytes: 8_000_000,
    namedSafeAreas: [],
    formats: ["PNG", "JPEG", "WEBP"],
    transparency: false,
  },
  {
    slug: "youtube-channel-banner",
    version: 1,
    label: "YouTube channel banner",
    description:
      "2560×1440 channel art with the official 1235×338 TV/desktop text-safe area centered; 6MB max. Verified against Google's current channel-art guidance.",
    width: 2560,
    height: 1440,
    // Official safe area at the documented minimum dimension, centered on the 2560×1440 canvas.
    safeArea: { x: Math.round((2560 - 1235) / 2), y: Math.round((1440 - 338) / 2), width: 1235, height: 338 },
    compositionHint:
      "YouTube channel art 2560×1440: compose so ALL text, logos and the subject sit inside the small centered 1235×338 safe area — every other region is cropped on at least one device (TV, desktop, mobile). Keep the wide field visually calm.",
    family: "platform",
    official: true,
    checkedAt: BANNER_SPEC_CHECKED_AT,
    sourceUrl: "https://support.google.com/youtube/answer/10456525",
    maxBytes: 6_000_000,
    namedSafeAreas: [],
    formats: ["PNG", "JPEG", "WEBP"],
    transparency: false,
  },
  {
    slug: "youtube-thumbnail",
    version: 1,
    label: "YouTube thumbnail",
    description:
      "1280×720 (16:9) video thumbnail — meets the official 16:9 rule and 640px minimum width (uploads up to 50MB accepted; Google now recommends up to 3840×2160 for maximum quality, which exceeds the managed engine's render bound).",
    width: 1280,
    height: 720,
    safeArea: centerSafe(1280, 720, 0.88, 0.88),
    compositionHint:
      "YouTube video thumbnail 1280×720 (16:9): one bold readable focal subject, high contrast, minimal text inside the safe area — thumbnails render very small.",
    family: "platform",
    official: true,
    checkedAt: BANNER_SPEC_CHECKED_AT,
    sourceUrl: "https://support.google.com/youtube/answer/72431",
    maxBytes: null,
    namedSafeAreas: [],
    formats: ["PNG", "JPEG", "WEBP"],
    transparency: false,
  },
  {
    slug: "linkedin-profile-cover",
    version: 1,
    label: "LinkedIn profile cover",
    description: "1584×396 (4:1) profile background/cover image; official recommended size, under 8MB.",
    width: 1584,
    height: 396,
    safeArea: centerSafe(1584, 396, 0.9, 0.86),
    compositionHint:
      "LinkedIn profile cover 1584×396: ultra-wide professional strip, subject and text inside the central safe area, calm premium tone suitable for a professional profile header.",
    family: "platform",
    official: true,
    checkedAt: BANNER_SPEC_CHECKED_AT,
    sourceUrl: "https://www.linkedin.com/help/linkedin/answer/a568217",
    maxBytes: 8_000_000,
    namedSafeAreas: [],
    formats: ["PNG", "JPEG", "WEBP"],
    transparency: false,
  },
  {
    slug: "linkedin-page-cover",
    version: 1,
    label: "LinkedIn page cover",
    description: "1512×256 company/page cover banner; official minimum-equals-recommended size, 3MB cap for page images.",
    width: 1512,
    height: 256,
    safeArea: centerSafe(1512, 256, 0.9, 0.84),
    compositionHint:
      "LinkedIn company page cover 1512×256: very slim corporate strip, logo/wordmark and subject inside the central safe area; expect slight edge trim on some screens, so keep margins.",
    family: "platform",
    official: true,
    checkedAt: BANNER_SPEC_CHECKED_AT,
    sourceUrl: "https://www.linkedin.com/help/linkedin/answer/a563309",
    maxBytes: 3_000_000,
    namedSafeAreas: [],
    formats: ["PNG", "JPEG", "WEBP"],
    transparency: false,
  },
  {
    slug: "facebook-page-cover",
    version: 1,
    label: "Facebook page cover",
    description:
      "851×315 page cover photo (official recommended size; minimum 400×150; 16:9 on desktop, 2.4:1 on mobile — the safe area protects the shared center band).",
    width: 851,
    height: 315,
    // Conservative centered zone that survives BOTH documented crops (16:9 desktop window vs 2.4:1 mobile).
    safeArea: { x: Math.round((851 - 680) / 2), y: Math.round((315 - 240) / 2), width: 680, height: 240 },
    namedSafeAreas: [
      // Desktop shows the cover in a 16:9 window: the centered full-height slice.
      { label: "desktop crop (16:9)", rect: { x: Math.round((851 - Math.round(315 * (16 / 9))) / 2), y: 0, width: Math.round(315 * (16 / 9)), height: 315 } },
      // Mobile shows a 2.4:1 band: the centered full-height slice.
      { label: "mobile crop (2.4:1)", rect: { x: Math.round((851 - Math.round(315 * 2.4)) / 2), y: 0, width: Math.round(315 * 2.4), height: 315 } },
    ],
    compositionHint:
      "Facebook page cover 851×315: the frame is cropped differently on desktop (16:9) and mobile (2.4:1) — keep all text, logos and the subject inside the central safe area so nothing critical is cut.",
    family: "platform",
    official: true,
    checkedAt: BANNER_SPEC_CHECKED_AT,
    sourceUrl: "https://www.facebook.com/help/125379114252045",
    maxBytes: null,
    formats: ["PNG", "JPEG", "WEBP"],
    transparency: false,
  },
  {
    slug: "square-campaign",
    version: 1,
    label: "Square campaign tile",
    description:
      "1080×1080 square campaign/product tile — inside Instagram's officially documented 1080px-width range (1.91:1 to 3:4 height bounds).",
    width: 1080,
    height: 1080,
    safeArea: centerSafe(1080, 1080, 0.86, 0.86),
    compositionHint:
      "Square 1080×1080 campaign tile: centered bold composition, subject dominant, text block inside the central safe area, strong readable contrast at small sizes.",
    family: "campaign",
    official: true,
    checkedAt: BANNER_SPEC_CHECKED_AT,
    sourceUrl: "https://help.instagram.com/1631821640426723",
    maxBytes: null,
    namedSafeAreas: [],
    formats: ["PNG", "JPEG", "WEBP"],
    transparency: false,
  },
  {
    slug: "portrait-post",
    version: 1,
    label: "Portrait post (4:5)",
    description:
      "1080×1350 (4:5) portrait feed post — the 4:5 ratio is explicitly documented in Instagram's official placement guidance within the 1080px-width range.",
    width: 1080,
    height: 1350,
    safeArea: centerSafe(1080, 1350, 0.86, 0.88),
    compositionHint:
      "Portrait 1080×1350 (4:5) post: vertical composition with the subject in the upper-middle band and a calm lower band where a caption block can be composited; everything critical inside the central safe area.",
    family: "campaign",
    official: true,
    checkedAt: BANNER_SPEC_CHECKED_AT,
    sourceUrl: "https://help.instagram.com/1631821640426723",
    maxBytes: null,
    namedSafeAreas: [],
    formats: ["PNG", "JPEG", "WEBP"],
    transparency: false,
  },
  {
    slug: "story-reel",
    version: 1,
    label: "Story / Reel cover",
    description:
      "1080×1920 (9:16) full-screen vertical story/reel cover; official recommended size, 30MB photo cap documented for Stories placements.",
    width: 1080,
    height: 1920,
    // Stories UI overlaps the top ~250px and bottom ~310px on phones — keep the middle band safe.
    safeArea: { x: Math.round((1080 - 950) / 2), y: 260, width: 950, height: 1050 },
    compositionHint:
      "Vertical 1080×1920 story/reel cover: full-bleed scene with the subject centered; keep all text and logos in the middle safe band — phone UI and captions overlap the top and bottom edges.",
    family: "campaign",
    official: true,
    checkedAt: BANNER_SPEC_CHECKED_AT,
    sourceUrl: "https://www.facebook.com/business/help/2222978001316177",
    maxBytes: 30_000_000,
    namedSafeAreas: [],
    formats: ["PNG", "JPEG", "WEBP"],
    transparency: false,
  },
];

/** Strict bounds for user-supplied custom canvases (documented, enforced). */
export const CUSTOM_CANVAS_LIMITS = {
  minSide: 64,
  maxSide: 4096,
  /** Total pixel budget (2^22) — bounds decode/composite memory. */
  maxAreaPx: 4_194_304,
} as const;

/** Human-readable rendering of the custom-canvas limits for API/UI messages. */
export function customCanvasLimitsText(): string {
  return `width and height must be whole numbers between ${CUSTOM_CANVAS_LIMITS.minSide} and ${CUSTOM_CANVAS_LIMITS.maxSide}px with a total of at most ${CUSTOM_CANVAS_LIMITS.maxAreaPx.toLocaleString("en-US")} pixels`;
}

export const CUSTOM_BANNER_SLUG = "custom";

/**
 * Resolve a strictly-bounded custom canvas. Returns null when the requested
 * dimensions are invalid — the caller must surface an honest error, never
 * clamp silently into a fake match.
 */
export function resolveCustomBannerCanvas(
  width: number | null | undefined,
  height: number | null | undefined
): LaxiiBannerPreset | null {
  if (width == null || height == null) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  const { minSide, maxSide, maxAreaPx } = CUSTOM_CANVAS_LIMITS;
  if (width < minSide || height < minSide || width > maxSide || height > maxSide) return null;
  if (width * height > maxAreaPx) return null;
  return {
    slug: CUSTOM_BANNER_SLUG,
    version: 1,
    label: "Custom canvas",
    description: `Custom ${width}×${height} canvas (within the ${minSide}–${maxSide}px per-side and ${maxAreaPx.toLocaleString("en-US")}-pixel limits).`,
    width,
    height,
    safeArea: centerSafe(width, height, 0.86, 0.9),
    compositionHint:
      "Custom canvas: compose the subject and all critical content inside the central safe area; nothing critical near any edge of the frame.",
    family: "campaign",
    official: false,
    checkedAt: null,
    sourceUrl: null,
    maxBytes: null,
    namedSafeAreas: [],
    formats: ["PNG", "JPEG", "WEBP"],
    transparency: false,
  };
}

export function findBannerPreset(slug: string): LaxiiBannerPreset | null {
  return BANNER_PRESETS.find((p) => p.slug === slug) ?? null;
}

/** The canonical BEAN Folio canvas — always registry entry 0, never an index guess. */
export function canonicalBannerPreset(): LaxiiBannerPreset {
  const preset = findBannerPreset(BANNER_PRESET_SLUG);
  if (!preset) throw new Error("The canonical BEAN Folio banner preset is missing from the registry.");
  return preset;
}

/**
 * Conversational-studio helper: resolve a banner preset by slug — null when
 * the slug is absent or unknown (callers fall back to the site preset).
 * Restored alongside `LaxiiError`: consumers import it; its earlier removal
 * from this module left those imports unresolvable at runtime.
 */
export function bannerPreset(slug?: string | null): LaxiiBannerPreset | null {
  return slug ? findBannerPreset(slug) : null;
}

/**
 * Client-safe preset projection for the banner studio (the server-side
 * compositionHint never leaves the server, mirroring publicStylePresets).
 * Reconstructed against the studio's BannerPresetInfo contract: id/format
 * fields follow the registry; export constraints (formats/maxBytes) are
 * enforced server-side by the export pipeline.
 */
export function bannerPresetsForClient(): {
  id: string;
  label: string;
  description: string;
  version: number;
  width: number;
  height: number;
  aspectRatio: number;
  safeArea: { x: number; y: number; w: number; h: number } | null;
  namedSafeAreas: { label: string; rect: { x: number; y: number; width: number; height: number } }[];
  formats: ("PNG" | "JPEG" | "WEBP")[];
  transparency: boolean;
  official: boolean;
  checkedAt: string | null;
  maxBytes: number | null;
}[] {
  return BANNER_PRESETS.map((p) => ({
    id: p.slug,
    label: p.label,
    description: p.description,
    version: p.version,
    width: p.width,
    height: p.height,
    aspectRatio: bannerAspectRatio(p),
    safeArea: { x: p.safeArea.x, y: p.safeArea.y, w: p.safeArea.width, h: p.safeArea.height },
    namedSafeAreas: p.namedSafeAreas,
    formats: p.formats,
    transparency: p.transparency,
    official: p.official,
    checkedAt: p.checkedAt,
    maxBytes: p.maxBytes,
  }));
}
