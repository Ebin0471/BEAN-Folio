/**
 * Platform-standard banner dimensions (BEAN Folio).
 *
 * Single source of truth for every banner/cover surface: the profile cover,
 * the published-site hero strip, and the LAXII banner canvas all derive from
 * these numbers. Aspect 2048:687 ≈ 2.981:1 — displayed with width:100% and
 * object-fit:cover so any source image fills the band without stretching,
 * while the frame's height stays proportional to its width.
 *
 * NOT for avatars, thumbnails or content images — those keep their own
 * geometry (avatars stay square/circular; project covers keep their card
 * ratios).
 */

export const BANNER_WIDTH = 2048;
export const BANNER_HEIGHT = 687;

/** CSS aspect-ratio value, e.g. `aspectRatio: BANNER_ASPECT_RATIO`. */
export const BANNER_ASPECT_RATIO = `${BANNER_WIDTH} / ${BANNER_HEIGHT}`;

/** Tailwind arbitrary aspect class for className-based use. */
export const BANNER_ASPECT_CLASS = "aspect-[2048/687]";

/** LAXII banner preset slug — the one authoritative banner canvas. */
export const BANNER_PRESET_SLUG = "bean-folio-banner";
