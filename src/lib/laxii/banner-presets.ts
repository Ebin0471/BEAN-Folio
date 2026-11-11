/**
 * LAXII banner preset (BEAN Folio).
 *
 * One fixed canvas only: the 2048×687 BEAN Folio portfolio banner — the
 * platform-standard banner ratio shared by every banner surface (see
 * lib/banner.ts). The safe area is the centered zone kept clear of critical
 * text/subjects; the studio renders its guide from these numbers and export
 * validates the exact size.
 */

import { BANNER_PRESET_SLUG, BANNER_WIDTH, BANNER_HEIGHT } from "@/lib/banner";

export interface LaxiiBannerPreset {
  slug: string;
  label: string;
  description: string;
  width: number;
  height: number;
  /** Fully-visible guide rectangle in canvas pixels. */
  safeArea: { x: number; y: number; width: number; height: number };
  /** Extra composition guidance appended to banner prompts. */
  compositionHint: string;
}

const centerSafe = (w: number, h: number, fx: number, fy: number) => ({
  x: Math.round((w * (1 - fx)) / 2),
  y: Math.round((h * (1 - fy)) / 2),
  width: Math.round(w * fx),
  height: Math.round(h * fy),
});

export const BANNER_PRESETS: LaxiiBannerPreset[] = [
  {
    slug: BANNER_PRESET_SLUG,
    label: "BEAN Folio banner",
    description: `2048×687 platform-standard portfolio banner (≈3:1) for BEAN Folio profiles, covers and published sites.`,
    width: BANNER_WIDTH,
    height: BANNER_HEIGHT,
    safeArea: centerSafe(BANNER_WIDTH, BANNER_HEIGHT, 0.86, 0.9), // ≈1761×618 centered text-safe zone
    compositionHint:
      "Ultra-wide 2048×687 portfolio banner (about 3:1) composed as ONE horizontal band: place the subject, headline, logo and all key elements in the vertical center half of the frame, with calm margin above and below. Keep all text and logos inside the central safe area; nothing critical near any edge of the frame.",
  },
];

export function findBannerPreset(slug: string): LaxiiBannerPreset | null {
  return BANNER_PRESETS.find((p) => p.slug === slug) ?? null;
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
 * fields follow the current single-preset registry; export constraints
 * (formats/maxBytes) are enforced server-side by the export pipeline.
 */
export function bannerPresetsForClient(): {
  id: string;
  label: string;
  description: string;
  width: number;
  height: number;
  safeArea: { x: number; y: number; w: number; h: number } | null;
  formats: ("PNG" | "JPEG" | "WEBP")[];
  maxBytes: number | null;
}[] {
  return BANNER_PRESETS.map((p) => ({
    id: p.slug,
    label: p.label,
    description: p.description,
    width: p.width,
    height: p.height,
    safeArea: { x: p.safeArea.x, y: p.safeArea.y, w: p.safeArea.width, h: p.safeArea.height },
    formats: ["PNG", "JPEG", "WEBP"],
    maxBytes: null,
  }));
}
