/**
 * BEAN Folio — static website code exporter.
 *
 * Generates the files for the "Download Website Code" ZIP: a standalone,
 * host-anywhere static site built from the creator's ACTUAL saved website
 * configuration and public profile data — the same design tokens, sections,
 * content and motion system the live renderer (components/bean/site) uses.
 *
 * Fidelity contract (mirrors SiteRenderer):
 *  - identical theme tokens (colors, gradient, glass, fonts, radius, density,
 *    type scale, spacing, buttons, links, dividers) via the SAME deriveTheme /
 *    themeFontStacks / motion CSS generators from lib/site-config & site-motion
 *  - all 11 section types incl. hero variants, list/grid/editorial/featured
 *    project layouts, gallery strip/masonry, timeline experience rows
 *  - multi-page sites → one HTML file per page, real <a> navigation
 *  - scroll reveals with the same IntersectionObserver semantics (once/repeat,
 *    failsafe, prefers-reduced-motion) shipped as a small vanilla site.js
 *  - images are copied into assets/images/ with RELATIVE references so the
 *    site never depends on the BEAN Folio runtime or any preview hostname
 *  - fonts load from Google Fonts' CDN (OFL-licensed families, same ids as the
 *    builder library) with the stacks' system fallbacks — documented in the
 *    README/manifest, never fetched from BEAN Folio
 *
 * Deliberately NOT reproducible statically (declared in the manifest and
 * README, never silently pretended): platform inquiries (the contact CTA
 * becomes a mailto link), follow/stat counters, RIISHE AI, and any live data
 * — the export is a snapshot of the moment it was generated.
 *
 * Security posture: the route only ever exports the SESSION OWNER's site and
 * the owner's own media (DB-checked); asset names are generated here (never
 * taken from user input); the storage layer's path validation (lib/storage)
 * is reused for every file read; no env files, cookies, tokens, database
 * content beyond the site's public data, or other users' data can enter the
 * archive — the unit tests in tests/site-export.test.ts pin this.
 */
import type { SiteConfig, SiteMotion, SitePage, SiteSection, ResolvedTheme } from "@/lib/site-config";
import {
  BEAN_FOLIO_LOGO_PATH,
  deriveTheme,
  safeCtaHref,
  sectionMotion,
  siteCoverSrc,
  siteLogoSrc,
  themeFontStacks,
} from "@/lib/site-config";
import {
  backgroundMotionCss,
  baseMotionCss,
  easingCss,
  getMotionPreset,
  microInteractionCss,
  revealPresetCss,
} from "@/lib/site-motion";
import { googleFontsHref, fontStack } from "@/lib/site-fonts";
import { categoryLabel } from "@/lib/categories";
import { join } from "node:path";

// ------------------------------------------------------------------ types

export interface ExportProfile {
  name: string;
  username: string | null;
  headline: string | null;
  location: string | null;
  bio: string | null;
  availability: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  coverPositionY: number;
  skills: string[];
  websiteUrl: string | null;
  contactEmail: string | null;
  stats: { followers: number; following: number; projects: number };
}

export interface ExportProject {
  id: string;
  title: string;
  summary: string | null;
  category: string | null;
  coverUrl: string | null;
  /** Platform-level star (featuredAt) — powers the featured section fallback. */
  featured?: boolean;
  /**
   * Detail-page fields — top-level projects carry them (the export route
   * loads the same public fields the live project page shows); collection
   * items carry cards only. All optional so older callers stay valid.
   */
  description?: string | null;
  role?: string | null;
  tools?: string[];
  skills?: string[];
  brief?: string | null;
  process?: string | null;
  challenges?: string | null;
  outcome?: string | null;
  externalUrl?: string | null;
  repoUrl?: string | null;
  publishedAt?: string | null;
  media?: { url: string | null; kind: string; caption: string | null }[];
}

export interface ExportCollection {
  id: string;
  name: string;
  description: string | null;
  items: ExportProject[];
}

/**
 * Loads ONE owned media asset's bytes. Implemented by the route with an
 * owner-scoped DB lookup (MediaAsset.ownerId === session user id) + the
 * storage layer — the generator itself never touches the DB or filesystem.
 * Return null for missing / not-owned / failed media (export continues).
 */
export type MediaLoader = (mediaId: string) => Promise<{ mime: string; bytes: Buffer } | null>;

export interface SiteExportInput {
  config: SiteConfig;
  profile: ExportProfile;
  projects: ExportProject[];
  collections: ExportCollection[];
  /** Platform footer attribution setting (SiteDesign.watermark). */
  watermark: boolean;
  /** Which saved slot the export came from — recorded in the README/manifest. */
  source: "draft" | "published";
  loadMedia: MediaLoader;
}

export interface ExportFile {
  path: string;
  data: Buffer;
}

export interface SiteExportResult {
  files: ExportFile[];
  warnings: string[];
}

// ------------------------------------------------------------------ constants (mirrors of the renderer's)

const HEADING_WEIGHT_NUM = { light: 300, semibold: 600, bold: 800 } as const;

const DENSITY_GAP = { compact: "3.25rem", regular: "5rem", relaxed: "7rem" } as const;
const SECTION_GAP = { compact: "2.75rem", regular: "4rem", relaxed: "6rem" } as const;
const GRID_GAP = { compact: "0.9rem", regular: "1.25rem", relaxed: "1.6rem" } as const;
const RADIUS = { none: "0px", md: "12px", full: "16px" } as const;
/** Fluid clamp() headline sizing — the SAME expressions the React renderer
 * applies inline (SiteRenderer FLUID_HERO / FLUID_H2), so exported pages
 * scale continuously with viewport width exactly like the live site. */
const FLUID_TYPE = {
  intimate: {
    hero: "clamp(1.9rem, 1.2rem + 3.2vw, 2.6rem)",
    h2: "clamp(1.15rem, 1.05rem + 0.8vw, 1.5rem)",
  },
  balanced: {
    hero: "clamp(2.25rem, 1.3rem + 4.6vw, 3.9rem)",
    h2: "clamp(1.5rem, 1.15rem + 1.9vw, 2.1rem)",
  },
  grand: {
    hero: "clamp(2.75rem, 1.6rem + 6.2vw, 5.2rem)",
    h2: "clamp(1.85rem, 1.3rem + 2.9vw, 2.75rem)",
  },
} as const;
const LINE_HEIGHT = { tight: "1.15", normal: "1.4", relaxed: "1.7" } as const;
const TRACKING = { tight: "-0.02em", normal: "0em", wide: "0.06em" } as const;
const CONTENT_WIDTH = { narrow: "56rem", regular: "72rem", wide: "80rem" } as const;
const IMAGE_RATIO = { "4/3": "4 / 3", "3/2": "3 / 2", "1/1": "1 / 1", "16/9": "16 / 9" } as const;

// Soft per-asset cap — keeps exports bounded. Matched to the largest upload
// rule (VIDEO: 64MB in lib/media.ts) so any media a creator legitimately
// uploaded can also be exported; the route is rate-limited and reads through
// the storage layer, so the worst case stays one 64MB buffer per asset.
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

// ------------------------------------------------------------------ small utilities

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Safe lowercase file fragment from a page id (defensive — ids are schema-bound already). */
export function sanitizePageFile(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const safe = cleaned || "page";
  // never collide with the archive's own reserved names
  return safe === "index" || safe === "assets" || safe === "readme" ? `page-${safe}` : safe;
}

function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("jpeg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("avif")) return "avif";
  if (m.includes("svg")) return "svg";
  if (m === "video/mp4" || m === "audio/mp4") return "mp4";
  if (m === "video/webm") return "webm";
  if (m === "video/quicktime") return "mov";
  if (m === "audio/mpeg") return "mp3";
  if (m === "audio/wav") return "wav";
  if (m === "audio/ogg") return "ogg";
  if (m === "application/pdf") return "pdf";
  return "bin";
}

function isVideoMime(mime: string): boolean {
  return mime === "video/mp4" || mime === "video/webm" || mime === "video/quicktime";
}

/** Extracts the media id from an app media URL (`/api/media/<id>/raw`). */
export function mediaIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^\/api\/media\/([A-Za-z0-9]+)(?:\/raw)?$/.exec(url.trim());
  return m ? m[1] : null;
}

function fill(text: string, profile: ExportProfile, config: SiteConfig, extra: Record<string, string> = {}): string {
  const map: Record<string, string> = {
    name: profile.name,
    headline: profile.headline ?? "",
    location: profile.location ?? "",
    bio: profile.bio ?? "",
    availability: profile.availability ?? "",
    tagline: config.tagline,
    ...extra,
  };
  return text.replace(/\{(name|headline|location|bio|availability|tagline)\}/g, (_, key: string) => map[key] ?? "");
}

/** Lucide icon paths (mail / globe / map-pin) as inline SVG — no runtime dependency. */
const ICONS = {
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="14" height="14"><path d="M20 6 9 17l-5-5"/></svg>',
};

// ------------------------------------------------------------------ asset mapping

class AssetMapper {
  private byMediaId = new Map<string, string>(); // mediaId → relative path
  private buffers = new Map<string, { mime: string; bytes: Buffer }>(); // relative path → data
  private external = new Set<string>();
  private seq = 0;
  warnings: string[] = [];

  async resolve(url: string | null | undefined): Promise<{ kind: "media"; path: string; mime: string } | { kind: "external"; url: string } | { kind: "none" }> {
    if (!url || !url.trim()) return { kind: "none" };
    const trimmed = url.trim();
    const id = mediaIdFromUrl(trimmed);
    if (id) {
      const known = this.byMediaId.get(id);
      if (known) return { kind: "media", path: known, mime: this.buffers.get(known)?.mime ?? "" };
      let media: { mime: string; bytes: Buffer } | null = null;
      try {
        media = await this.loader(id);
      } catch {
        media = null;
      }
      if (!media || !media.bytes || media.bytes.length === 0) {
        this.warnings.push(`Skipped missing or inaccessible media asset (${id}) — a themed fallback tile is used instead.`);
        return { kind: "none" };
      }
      if (media.bytes.length > MAX_MEDIA_BYTES) {
        this.warnings.push(`Skipped media asset (${id}) — larger than the ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB per-file export cap.`);
        return { kind: "none" };
      }
      this.seq += 1;
      const rel = `assets/images/img-${this.seq}-${id.replace(/[^a-zA-Z0-9_-]/g, "")}.${extForMime(media.mime)}`;
      this.byMediaId.set(id, rel);
      this.buffers.set(rel, media);
      return { kind: "media", path: rel, mime: media.mime };
    }
    if (/^https?:\/\//i.test(trimmed)) {
      this.external.add(trimmed);
      return { kind: "external", url: trimmed };
    }
    // Any other app-relative URL cannot resolve in a static export.
    this.warnings.push(`Skipped an app-relative reference that has no static equivalent (${trimmed.slice(0, 64)}).`);
    return { kind: "none" };
  }

  constructor(private loader: MediaLoader) {}

  get files(): { path: string; data: Buffer }[] {
    return Array.from(this.buffers, ([path, { bytes }]) => ({ path, data: bytes }));
  }
  get externalUrls(): string[] {
    return Array.from(this.external);
  }
}

// ------------------------------------------------------------------ style generation

function rootVars(theme: ResolvedTheme, motion: SiteMotion): string {
  return `background: ${theme.gradient ? `linear-gradient(${theme.gradient.angle}deg, ${theme.gradient.from}, ${theme.gradient.to})` : theme.background}; color: ${theme.foreground}; line-height: ${LINE_HEIGHT[theme.lineHeight]}; --bs-ease: ${easingCss(motion.easing)}; --site-accent: ${theme.accent}; --site-accent2: ${theme.accent2}; --site-focus: ${theme.focus}; --site-radius: ${RADIUS[theme.radius]};`;
}

function glassCss(theme: ResolvedTheme, target: "nav" | "cards" | "buttons", selector: string): string {
  const g = theme.glass;
  if (!g || !g.enabled || !g.targets[target]) return "";
  const border = g.borderWidth > 0 ? `border: ${g.borderWidth}px solid color-mix(in srgb, ${g.tint} ${Math.min(100, g.borderOpacity + 22)}%, transparent);` : "";
  const shadows: string[] = [];
  if (g.shadow > 0) shadows.push(`0 ${Math.round(g.shadow * 0.16)}px ${Math.round(g.shadow * 0.42)}px rgba(0,0,0,${((g.shadow / 100) * 0.42).toFixed(2)})`);
  if (g.highlight > 0) shadows.push(`inset 0 1px 0 color-mix(in srgb, ${g.tint} ${Math.round(g.highlight * 0.55)}%, transparent)`);
  return `${selector} { background-color: color-mix(in srgb, ${g.tint} ${g.opacity}%, transparent); backdrop-filter: blur(${g.blur}px) saturate(1.35); -webkit-backdrop-filter: blur(${g.blur}px) saturate(1.35); ${border} ${shadows.length ? `box-shadow: ${shadows.join(", ")};` : ""} }`;
}

function cardCssBlock(theme: ResolvedTheme, selector: string, elevated: boolean): string {
  const base = elevated ? `color-mix(in srgb, ${theme.surface} 95%, ${theme.foreground})` : theme.surface;
  const bg = theme.surfaceOpacity < 100 ? `color-mix(in srgb, ${base} ${theme.surfaceOpacity}%, transparent)` : base;
  return `${selector} { background: ${bg}; border-color: ${theme.border}; }`;
}

function buttonCss(theme: ResolvedTheme): string {
  const radius = { sharp: "0px", rounded: RADIUS[theme.radius], pill: "9999px", outline: RADIUS[theme.radius] }[theme.buttonStyle];
  const glassOn = Boolean(theme.glass?.enabled && theme.glass.targets.buttons);
  if (glassOn) {
    return `.bs-btn { color: ${theme.buttonStyle === "outline" ? theme.accent : theme.foreground}; border-radius: ${radius}; ${theme.buttonStyle === "outline" ? `border: 1px solid ${theme.accent}; background: transparent;` : ""} }`;
  }
  if (theme.buttonStyle === "outline") {
    return `.bs-btn { border: 1px solid ${theme.accent}; color: ${theme.accent}; background: transparent; border-radius: ${radius}; }`;
  }
  return `.bs-btn { background: ${theme.accent}; color: ${theme.background}; border-radius: ${radius}; border: 1px solid transparent; }`;
}

function linkCss(theme: ResolvedTheme): string {
  switch (theme.linkStyle) {
    case "underline":
      return `.bs-link { text-decoration: underline; text-underline-offset: 3px; }`;
    case "accent":
      return `.bs-link { color: ${theme.accent}; }`;
    default:
      return `.bs-link { }`;
  }
}

/**
 * The full stylesheet for one site. Deliberately hand-rolled (not Tailwind):
 * the exported site must render with ZERO build tooling and zero requests to
 * any app host. Values mirror the renderer's utility classes 1:1.
 */
function buildStylesheet(theme: ResolvedTheme, motion: SiteMotion, config: SiteConfig): string {
  // external: true — the exported stylesheet runs OUTSIDE the BEAN Folio app
  // document, so bundled families must resolve to real family names (loaded
  // via the fonts stylesheet below), never the app's next/font CSS variables.
  const stacks = themeFontStacks(theme, { external: true });
  const fluid = FLUID_TYPE[theme.typeScale];
  const hoverZoom = motion.enabled && motion.hoverEffects;
  const presets = new Set<string>([motion.preset]);
  for (const page of config.pages) {
    for (const s of page.sections) {
      const o = s.motion;
      if (o?.preset && getMotionPreset(o.preset)) presets.add(o.preset);
    }
  }

  let css = `
/* ==== reset & base ==== */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; }
img { display: block; max-width: 100%; }
a { color: inherit; text-decoration: none; }
button { font: inherit; background: none; border: 0; cursor: pointer; color: inherit; padding: 0; }
h1, h2, h3, p, ul, ol, figure, blockquote { margin: 0; }
ul, ol { padding: 0; list-style: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

/* ==== site root ==== */
.bean-site { min-height: 100vh; width: 100%; overflow-x: hidden; font-family: ${stacks.body}; font-size: 16px; }
.bean-site a:focus-visible, .bean-site button:focus-visible { outline: 2px solid var(--site-focus, var(--site-accent)); outline-offset: 3px; border-radius: 2px; }
.bs-content-wrap { margin: 0 auto; width: 100%; max-width: ${CONTENT_WIDTH[theme.contentWidth]}; padding: 2.5rem 1.25rem ${DENSITY_GAP[theme.density]}; }
@media (min-width: 640px) { .bs-content-wrap { padding-left: 2rem; padding-right: 2rem; } }

/* ==== masthead ==== */
.bs-masthead { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.75rem; padding-bottom: 1.5rem; border-bottom: ${theme.divider === "accent" ? `2px solid ${theme.accent}` : theme.divider === "line" ? `1px solid color-mix(in srgb, ${theme.foreground} 16%, transparent)` : "none"}; }
.bs-masthead.stacked { flex-direction: column; align-items: stretch; gap: 0.5rem; }
.bs-masthead.centered { flex-direction: column; align-items: center; text-align: center; }
.bs-site-name { font-family: ${stacks.heading}; font-size: 1.125rem; font-weight: 600; letter-spacing: -0.025em; }
.bs-site-logo { display: block; height: 40px; width: auto; max-width: 180px; object-fit: contain; border-radius: 4px; }
.bs-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.bs-site-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem; }
.bs-masthead.stacked .bs-site-nav { justify-content: flex-start; }
.bs-masthead.centered .bs-site-nav { justify-content: center; }
.bs-nav-link { font-size: 0.875rem; opacity: 0.65; transition: opacity 160ms ease, color 160ms ease; }
.bs-nav-link:hover { opacity: 0.85; }
.bs-nav-link[aria-current="page"] { opacity: 1; ${theme.linkStyle === "accent" ? `color: ${theme.accent};` : ""} ${theme.linkStyle === "underline" ? "text-decoration: underline; text-underline-offset: 4px;" : ""} }
.bs-handle { font-size: 0.875rem; opacity: 0.7; font-family: ${stacks.code}; }
${glassCss(theme, "nav", ".bs-masthead.bs-glass")}
.bs-masthead.bs-glass { margin: 0.5rem -0.5rem 1.25rem; padding: 0.75rem 1rem; border-radius: 14px; border-bottom: none; }
@media (min-width: 640px) { .bs-masthead.bs-glass { margin-left: -1rem; margin-right: -1rem; padding-left: 1.25rem; padding-right: 1.25rem; } }

/* ==== typography (fluid clamp sizing — mirrors the live renderer) ==== */
.bs-h1 { font-family: ${stacks.heading}; font-weight: ${HEADING_WEIGHT_NUM[theme.headingWeight]}; letter-spacing: ${TRACKING[theme.letterSpacing]}; line-height: 1.05; max-width: 48rem; font-size: ${fluid.hero}; }
.bs-h2 { font-family: ${stacks.heading}; font-weight: ${HEADING_WEIGHT_NUM[theme.headingWeight]}; letter-spacing: ${TRACKING[theme.letterSpacing]}; font-size: ${fluid.h2}; ${theme.headingAlign === "center" ? "text-align: center;" : ""} }
.bs-hero-center .bs-h1, .bs-hero-center .bs-h2 { margin-left: auto; margin-right: auto; text-align: center; }
.bs-subtitle { margin-top: 1rem; max-width: 42rem; font-size: 1rem; opacity: 0.75; }
@media (min-width: 640px) { .bs-subtitle { font-size: 1.125rem; } }
.bs-tagline { margin-top: 0.75rem; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.2em; opacity: 0.6; }
.bs-cta-row { margin-top: 1.5rem; }

/* ==== buttons & links ==== */
.bs-btn { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.625rem 1.25rem; font-size: 0.875rem; font-weight: 600; transition: transform 180ms var(--bs-ease,ease), opacity 180ms ease, box-shadow 180ms ease, background-color 180ms ease, color 180ms ease; }
.bs-link { transition: opacity 160ms ease; }
.bs-link:hover { opacity: 0.8; text-decoration: underline; text-underline-offset: 4px; }
${buttonCss(theme)}
${glassCss(theme, "buttons", ".bs-btn.bs-glass-btn")}

/* ==== sections ==== */
.bs-section { padding-top: ${SECTION_GAP[theme.density]}; }
.bs-gap { margin-top: ${theme.density === "compact" ? "1.25rem" : theme.density === "relaxed" ? "2rem" : "1.75rem"}; }
.bs-about-body { margin-top: 1rem; max-width: 48rem; white-space: pre-wrap; font-size: 15px; opacity: 0.85; }
@media (min-width: 640px) { .bs-about-body { font-size: 1rem; } }
.bs-muted { color: ${theme.muted}; }
.bs-meta-label { font-family: ${stacks.accent}; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.025em; color: ${theme.muted}; }
.bs-cat-label { font-family: ${stacks.accent}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.14em; color: ${theme.muted}; }

/* ==== cards ==== */
${cardCssBlock(theme, ".bs-card", false)}
${cardCssBlock(theme, ".bs-card.elevated", true)}
.bs-card { border: 1px solid ${theme.border}; border-radius: ${RADIUS[theme.radius]}; overflow: hidden; display: block; height: 100%; transition: opacity 160ms ease; }
.bs-card.padded { padding: 1rem; overflow: visible; }
.bs-card.padded-lg { padding: 1.25rem; overflow: visible; }
${glassCss(theme, "cards", ".bs-card.bs-glass-card")}
.bs-card:hover { opacity: 0.92; }
${hoverZoom ? ".bs-hoverzoom img { transition: transform 500ms var(--bs-ease,ease); } .bs-hoverzoom:hover img { transform: scale(1.035); }" : ""}

/* ==== grids & lists ==== */
.bs-grid { display: grid; grid-template-columns: 1fr; gap: ${GRID_GAP[theme.density]}; }
@media (min-width: 640px) { .bs-grid.cols-2 { grid-template-columns: repeat(2, minmax(0,1fr)); } .bs-grid.cols-3 { grid-template-columns: repeat(2, minmax(0,1fr)); } }
@media (min-width: 1024px) { .bs-grid.cols-3 { grid-template-columns: repeat(3, minmax(0,1fr)); } }
.bs-rows { margin-top: 1.25rem; }
.bs-rows > li { border-bottom: 1px solid ${theme.divider === "none" ? "transparent" : theme.border}; }
.bs-row-link { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: 0.75rem 0; transition: opacity 160ms ease; }
.bs-row-link:hover { opacity: 0.8; }
.bs-row-title { font-weight: 600; color: ${theme.accent}; }
.bs-row-cat { flex-shrink: 0; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.025em; color: ${theme.muted}; }

/* ==== hero ==== */
.bs-hero { padding-top: 3.5rem; }
@media (min-width: 640px) { .bs-hero { padding-top: 5rem; } }
/* Hero avatar — the creator's real profile picture (initials fallback underneath). */
.bs-avatar { position: relative; width: 96px; height: 96px; margin-bottom: 1.5rem; flex-shrink: 0; }
.bs-avatar .bs-avatar-fallback { position: absolute; inset: 0; display: grid; place-items: center; overflow: hidden; border-radius: ${theme.radius === "none" ? "18px" : "9999px"}; background: color-mix(in srgb, ${theme.accent} 16%, ${theme.background}); color: ${theme.foreground}; font-family: ${stacks.heading}; font-weight: 600; font-size: 2rem; letter-spacing: 0.02em; }
.bs-avatar img { position: absolute; inset: 0; height: 100%; width: 100%; object-fit: cover; border-radius: ${theme.radius === "none" ? "18px" : "9999px"}; }
@media (max-width: 639px) { .bs-avatar { width: 64px; height: 64px; margin-bottom: 1rem; } .bs-avatar .bs-avatar-fallback { font-size: 1.375rem; } }
.bs-hero-cover-strip { margin-bottom: 2rem; aspect-ratio: 2048 / 687; width: 100%; overflow: hidden; border-radius: ${theme.radius === "none" ? "0px" : "18px"}; }
.bs-hero-cover-strip img { height: 100%; width: 100%; object-fit: cover; }
.bs-hero-split { display: grid; align-items: end; gap: 2rem; padding-top: 3.5rem; }
@media (min-width: 640px) { .bs-hero-split { grid-template-columns: 1.2fr 1fr; padding-top: 5rem; } .bs-hero-split .bs-split-side { padding-bottom: 0.5rem; } }
.bs-cover-hero { position: relative; overflow: hidden; margin: 0 -1.25rem 1rem; min-height: min(72vh, 560px); }
@media (min-width: 640px) { .bs-cover-hero { margin-left: -2rem; margin-right: -2rem; } }
.bs-cover-hero img { position: absolute; inset: 0; height: 100%; width: 100%; object-fit: cover; transform: scale(1.12); }
.bs-cover-hero .bs-cover-scrim { position: absolute; inset: 0; background: linear-gradient(to top, ${theme.background} 8%, color-mix(in srgb, ${theme.background} 55%, transparent) 55%, transparent); }
.bs-cover-hero .bs-cover-inner { position: relative; margin: 0 auto; width: 100%; max-width: 72rem; display: flex; flex-direction: column; justify-content: flex-end; padding: 10rem 1.25rem 3.5rem; }
@media (min-width: 640px) { .bs-cover-hero .bs-cover-inner { padding-left: 2rem; padding-right: 2rem; } }

/* ==== skills / chips ==== */
.bs-chips { margin-top: 1rem; display: flex; flex-wrap: wrap; gap: 0.5rem; }
.bs-chip { border: 1px solid ${theme.border}; border-radius: ${RADIUS[theme.radius]}; padding: 0.25rem 0.75rem; font-size: 0.875rem; }

/* ==== stats ==== */
.bs-stats { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: ${GRID_GAP[theme.density]}; }
.bs-stat-label { font-family: ${stacks.accent}; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.025em; color: ${theme.muted}; }
.bs-stat-value { margin-top: 0.25rem; font-size: 1.5rem; font-weight: 600; color: ${theme.accent}; font-family: ${stacks.code}; }

/* ==== editorial rows ==== */
.bs-editorial { margin-top: 1.25rem; display: flex; flex-direction: column; gap: 2.5rem; }
.bs-editorial-row { display: grid; align-items: center; gap: 1.5rem; }
@media (min-width: 640px) { .bs-editorial-row { grid-template-columns: repeat(2, minmax(0,1fr)); } .bs-editorial-row.odd .bs-editorial-media { order: 2; } }
.bs-editorial-title { margin-top: 0.25rem; font-size: 1.5rem; font-weight: 600; color: ${theme.accent}; font-family: ${stacks.heading}; }
.bs-editorial-summary { margin-top: 0.5rem; font-size: 0.875rem; color: ${theme.muted}; }

/* ==== featured ==== */
.bs-featured { margin-top: 1.25rem; display: flex; flex-direction: column; gap: 1.5rem; }
.bs-featured .bs-card-body { padding: 1.25rem; }
.bs-featured .bs-card-title { font-size: 1.25rem; }

/* ==== video reel ==== */
.bs-reel-strip { scroll-snap-type: x mandatory; }
.bs-reel-item { position: relative; overflow: hidden; border-radius: ${RADIUS[theme.radius]}; }
.bs-reel-strip .bs-reel-item { flex: 0 0 auto; width: 16rem; scroll-snap-align: start; }
@media (min-width: 640px) { .bs-reel-strip .bs-reel-item { width: 20rem; } }
.bs-reel-video { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #000; }
.bs-reel-caption { display: block; padding: 0.5rem 0.75rem; font-size: 0.75rem; color: ${theme.muted}; }
.bs-reel-unavailable { display: flex; align-items: center; justify-content: center; min-height: 9rem; padding: 1rem; aspect-ratio: 16 / 9; font-size: 0.75rem; text-align: center; color: ${theme.muted}; background: ${theme.surface}; border: 1px dashed ${theme.border}; }

/* ==== gallery ==== */
.bs-strip { margin-top: 1.25rem; display: flex; gap: 1rem; overflow-x: auto; scroll-snap-type: x mandatory; padding-bottom: 0.5rem; scrollbar-width: thin; }
.bs-strip > li { width: 16rem; flex-shrink: 0; scroll-snap-align: start; overflow: hidden; border-radius: ${RADIUS[theme.radius]}; }
@media (min-width: 640px) { .bs-strip > li { width: 20rem; } }
.bs-masonry { margin-top: 1.25rem; columns: 2; column-gap: 1rem; }
.bs-masonry > a { display: block; break-inside: avoid; margin-bottom: 1rem; overflow: hidden; border-radius: ${RADIUS[theme.radius]}; }
@media (min-width: 640px) { .bs-masonry { columns: 3; } }

/* ==== experience timeline ==== */
.bs-timeline { margin-top: 1.5rem; padding-left: 1.5rem; border-left: 2px solid ${theme.border}; display: flex; flex-direction: column; gap: 1.5rem; }
.bs-timeline > li { position: relative; }
.bs-timeline > li::before { content: ""; position: absolute; left: -1.9rem; top: 0.4rem; width: 0.625rem; height: 0.625rem; border-radius: 9999px; background: ${theme.accent2 ?? theme.accent}; }
.bs-entry-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
.bs-entry-role { font-weight: 600; }
.bs-entry-period { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.025em; color: ${theme.muted}; font-family: ${stacks.code}; }
.bs-entry-desc { margin-top: 0.25rem; font-size: 0.875rem; color: ${theme.muted}; }

/* ==== testimonials ==== */
.bs-quotes { margin-top: 1.5rem; display: flex; flex-direction: column; gap: 2rem; }
.bs-quote-text { font-family: ${stacks.heading}; font-size: 1.25rem; line-height: 1.625; }
.bs-quote-by { margin-top: 0.5rem; font-size: 0.875rem; color: ${theme.muted}; font-family: ${stacks.accent}; }
.bs-quote-mark { color: ${theme.accent2 ?? theme.accent}; }

/* ==== contact ==== */
.bs-contact-body { margin-top: 0.75rem; max-width: 42rem; font-size: 15px; opacity: 0.85; }
.bs-contact-row { margin-top: 1.25rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; }
.bs-contact-meta { display: inline-flex; align-items: center; gap: 0.375rem; font-size: 0.875rem; }
.bs-contact-meta.loc { opacity: 0.7; }

/* ==== footer ==== */
.bs-footer { margin-top: 5rem; padding-top: 1.5rem; font-size: 0.75rem; opacity: 0.7; border-top: ${theme.divider === "none" ? "none" : `1px solid ${theme.border}`}; }
.bs-footer-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; }

/* ==== collections ==== */
.bs-collection-name { font-weight: 600; font-family: ${stacks.heading}; }
.bs-collection-desc { margin-top: 0.25rem; font-size: 0.875rem; color: ${theme.muted}; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.bs-collection-count { margin-top: 0.75rem; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.025em; color: ${theme.muted}; font-family: ${stacks.code}; }

/* ==== services cards ==== */
.bs-service-title { font-weight: 600; font-family: ${stacks.heading}; color: ${theme.accent}; }
.bs-service-desc { margin-top: 0.5rem; font-size: 0.875rem; color: ${theme.muted}; }
.bs-service-index { font-size: 0.875rem; font-weight: 600; color: ${theme.accent2 ?? theme.accent}; }

/* ==== process ==== */
.bs-process-badge { position: absolute; left: -2.3125rem; top: 0; display: flex; width: 1.5rem; height: 1.5rem; align-items: center; justify-content: center; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
.bs-timeline.bs-rail > li::before { display: none; }
.bs-process-index { font-size: 1.5rem; font-weight: 600; line-height: 1; color: ${theme.accent}; font-family: ${stacks.code}; }
.bs-process-title { font-weight: 600; font-family: ${stacks.heading}; }

/* ==== faq (native <details> disclosure) ==== */
.bs-faq { margin-top: 1.25rem; }
.bs-faq-item { padding: 1rem 0; }
.bs-faq-item + .bs-faq-item { border-top: 1px solid ${theme.divider === "none" ? "transparent" : theme.border}; }
.bs-faq-q { display: flex; cursor: pointer; list-style: none; align-items: center; justify-content: space-between; gap: 1rem; font-weight: 600; }
.bs-faq-q::-webkit-details-marker { display: none; }
.bs-faq-chevron { flex-shrink: 0; font-size: 0.875rem; line-height: 1; transition: transform 200ms var(--bs-ease, ease); }
.bs-faq-item[open] .bs-faq-chevron { transform: rotate(180deg); }
.bs-faq-a { margin-top: 0.75rem; font-size: 0.875rem; color: ${theme.muted}; }

/* ==== pricing ==== */
.bs-price-card { position: relative; }
.bs-price-name { font-weight: 600; font-family: ${stacks.heading}; }
.bs-price-value { margin-top: 0.5rem; font-size: 1.875rem; font-weight: 600; line-height: 1.1; color: ${theme.accent}; font-family: ${stacks.heading}; }
.bs-price-period { margin-top: 0.25rem; font-size: 0.875rem; color: ${theme.muted}; font-family: ${stacks.code}; }
.bs-price-features { margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.375rem; }
.bs-price-feature { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.875rem; }
.bs-price-feature svg { flex-shrink: 0; margin-top: 0.125rem; color: ${theme.accent}; }
.bs-price-flag { position: absolute; top: 0.75rem; right: 0.75rem; width: 0.5rem; height: 0.5rem; border-radius: 9999px; background: ${theme.accent}; }

/* ==== client logos ==== */
.bs-logo-chip { border: 1px solid ${theme.border}; border-radius: ${RADIUS[theme.radius]}; padding: 0.5rem 1rem; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.14em; color: ${theme.muted}; font-family: ${stacks.accent}; }
.bs-logo-placeholder { border-style: dashed; opacity: 0.6; }

/* ==== scroll progress bar (motion.scrollProgress) ==== */
.bs-progress { position: fixed; top: 0; left: 0; right: 0; height: 2px; background: ${theme.accent}; transform: scaleX(0); transform-origin: 0 50%; z-index: 40; pointer-events: none; }

/* ==== images & placeholders ==== */
.bs-img-cover { width: 100%; height: 100%; object-fit: cover; }
.bs-monogram { display: flex; height: 100%; width: 100%; align-items: center; justify-content: center; background: linear-gradient(145deg, color-mix(in srgb, ${theme.accent} 14%, ${theme.background}) 0%, ${theme.surface} 58%, ${theme.background} 100%); }
.bs-monogram span { color: ${theme.accent}; opacity: 0.55; font-family: ${stacks.heading}; font-weight: ${HEADING_WEIGHT_NUM[theme.headingWeight]}; letter-spacing: ${TRACKING[theme.letterSpacing]}; font-size: clamp(1.75rem, 5vw, 3.5rem); user-select: none; line-height: 1; }

/* ==== background layer (decorative, preset-driven) ==== */
.bs-bg-host { position: relative; }
${glassCss(theme, "nav", ".bs-masthead.bs-glass-never") /* placeholder never emitted; keeps helper usage uniform */}

/* ==== motion (same generators the live renderer uses) ==== */
${baseMotionCss()}
${Array.from(presets).map((p) => revealPresetCss(p)).join("\n")}
${microInteractionCss(motion.enabled && motion.hoverEffects ? motion.microInteractions : "none")}
${backgroundMotionCss(motion.enabled ? motion.background : "bg-none")}
`;

  const g = theme.glass;
  if (g && g.enabled) {
    css += `
@supports not ((backdrop-filter: blur(2px)) or (-webkit-backdrop-filter: blur(2px))) {
  .bean-site .bs-glass, .bean-site .bs-glass-card, .bean-site .bs-glass-btn { background-color: color-mix(in srgb, ${g.tint} ${Math.min(94, g.opacity + 42)}%, ${theme.background}) !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
}`;
  }
  return css;
}

// ------------------------------------------------------------------ site.js

function buildSiteJs(motion: SiteMotion): string {
  const revealOn = motion.enabled && motion.scrollReveal && motion.preset !== "none";
  // Reduced-motion is evaluated at RUNTIME in the generated JS (same contract
  // as the live renderer): content always ends up visible.
  return `/* Generated by BEAN Folio Website Studio — site behaviour (vanilla, no dependencies). */
(function () {
  "use strict";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var reveals = Array.prototype.slice.call(document.querySelectorAll(".bs-reveal"));

  ${revealOn ? `
  var failsafeMs = ${Math.max(1200, motion.duration + 1600)};
  reveals.forEach(function (el) {
    if (reduced) { el.classList.add("bs-static", "bs-in"); return; }
    var done = false;
    var show = function () { if (done) return; done = true; el.classList.add("bs-in"); };
    window.setTimeout(show, failsafeMs); // content must never stay invisible
    if (!("IntersectionObserver" in window)) { show(); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { ${motion.once ? "show(); io.disconnect();" : `el.classList.toggle("bs-in", e.isIntersecting);`} }
        ${motion.once ? "" : 'else { el.classList.toggle("bs-in", e.isIntersecting); }'}
      });
    }, { threshold: ${motion.once ? 0.12 : 0.08} });
    io.observe(el);
  });` : `
  reveals.forEach(function (el) { el.classList.add("bs-static", "bs-in"); });`}

  // Restrained hero-cover parallax (desktop widths only) — mirrors the live renderer.
  var cover = document.querySelector(".bs-cover-hero img.bs-parallax");
  if (cover && !reduced && window.innerWidth >= 768) {
    var raf = 0;
    var amount = Math.min(28, Math.max(6, (${motion.intensity} / 100) * 28));
    var update = function () {
      raf = 0;
      var host = cover.parentElement;
      if (!host) return;
      var rect = host.getBoundingClientRect();
      var progress = Math.min(1, Math.max(0, 1 - rect.top / Math.max(1, window.innerHeight)));
      cover.style.transform = "translateY(" + ((progress - 0.5) * amount * 2).toFixed(1) + "px) scale(1.12)";
    };
    window.addEventListener("scroll", function () { if (!raf) raf = requestAnimationFrame(update); }, { passive: true });
    update();
  }

  ${motion.enabled && motion.scrollProgress ? `
  // Reading-progress bar — mirrors the live renderer's ScrollProgress component.
  var bar = document.querySelector(".bs-progress");
  if (bar && !reduced) {
    var barRaf = 0;
    var updateBar = function () {
      barRaf = 0;
      var de = document.documentElement;
      var max = de.scrollHeight - window.innerHeight;
      var p = max > 0 ? Math.min(1, Math.max(0, (window.scrollY || de.scrollTop || 0) / max)) : 0;
      bar.style.transform = "scaleX(" + p + ")";
    };
    var onScroll = function () { if (!barRaf) barRaf = requestAnimationFrame(updateBar); };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    updateBar();
  }` : ""}
})();
`;
}

// ------------------------------------------------------------------ HTML generation

interface Ctx {
  theme: ResolvedTheme;
  siteMotion: SiteMotion;
  motionFor: (s: SiteSection) => SiteMotion;
  assets: AssetMapper;
  config: SiteConfig;
  profile: ExportProfile;
  projects: ExportProject[];
  collections: ExportCollection[];
  splitText: (text: string, m: SiteMotion) => string;
}

function splitTextHtml(text: string, m: SiteMotion): string {
  const preset = getMotionPreset(m.preset);
  const split = preset?.spec?.textSplit ?? null;
  if (!split) return esc(text);
  const parts = split === "word" ? text.split(/(\s+)/) : Array.from(text);
  const body = parts
    .map((p, i) => (/^\s+$/.test(p) ? p : `<span class="bs-w" style="--bs-i:${i}">${esc(p)}</span>`))
    .join("");
  return `<span class="sr-only">${esc(text)}</span><span aria-hidden="true" class="bs-split">${body}</span>`;
}

/** Same reveal-container markup the React Reveal component emits. */
function revealWrap(m: SiteMotion, inner: string, opts: { stagger?: boolean; className?: string; style?: string } = {}): string {
  const presetDef = getMotionPreset(m.preset);
  const animClass = !m.enabled || m.preset === "none" || presetDef?.parallax ? "bs-static" : `bs-reveal bs-r-${m.preset}`;
  const cls = ["bs-reveal-host", animClass, opts.stagger ? "bs-stagger" : "", opts.className ?? ""].filter(Boolean).join(" ");
  const style = `--bs-dur:${m.duration}ms; --bs-ease:${easingCss(m.easing)}; --bs-int:${m.intensity}; --bs-stag:${m.stagger}ms;${opts.style ? ` ${opts.style}` : ""}`;
  return `<div class="${cls}" style="${esc(style)}">${inner}</div>`;
}

/**
 * Stagger wrapper with React-parity DOM: the reveal container ITSELF carries
 * the grid/classes and every child is wrapped in an indexed .bs-sh carrier
 * (like the Reveal component's Children.map). Without this, a staggered
 * grid collapsed to ONE child (the inner wrapper) with no --bs-i — cards
 * entered as a single unit in exported sites.
 */
function staggerWrap(m: SiteMotion, items: string[], opts: { className?: string; style?: string } = {}): string {
  return revealWrap(
    m,
    items.map((h, i) => `<div class="bs-sh" style="--bs-i:${i}">${h}</div>`).join(""),
    { stagger: true, className: opts.className, style: opts.style }
  );
}

/**
 * Hero avatar for the static export — mirrors the live renderer's SiteAvatar:
 * the creator's real profile picture with an initials tile underneath, so a
 * missing photo degrades gracefully instead of showing a broken image.
 */
async function avatarHtml(ctx: Ctx): Promise<string> {
  const profile = ctx.profile;
  const initials =
    profile.name
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "@";
  let img = "";
  if (profile.avatarUrl && profile.avatarUrl.trim()) {
    const resolved = await ctx.assets.resolve(profile.avatarUrl);
    if (resolved.kind === "external") {
      img = `<img src="${esc(resolved.url)}" alt="${esc(profile.name)} — profile photo" loading="lazy" onerror="this.style.display='none'">`;
    } else if (resolved.kind === "media" && resolved.mime.startsWith("image/")) {
      img = `<img src="${esc(resolved.path)}" alt="${esc(profile.name)} — profile photo" loading="lazy" onerror="this.style.display='none'">`;
    }
  }
  return `<div class="bs-avatar"><span class="bs-avatar-fallback" aria-hidden="true">${esc(initials)}</span>${img}</div>`;
}

async function coverImgHtml(ctx: Ctx, src: string | null | undefined, alt: string, title: string): Promise<string> {
  const resolved = await ctx.assets.resolve(src);
  const theme = ctx.theme;
  if (resolved.kind === "none") {
    const monogram = title.trim().charAt(0).toUpperCase() || "•";
    return `<div class="bs-monogram" aria-hidden="true"><span>${esc(monogram)}</span></div>`;
  }
  if (resolved.kind === "external" || !resolved.mime) {
    const url = resolved.kind === "external" ? resolved.url : resolved.path;
    return `<img class="bs-img-cover" src="${esc(url)}" alt="${esc(alt)}" loading="lazy">`;
  }
  if (isVideoMime(resolved.mime)) {
    // Video covers render their first frame — the same treatment the app's
    // SiteCoverImage gives video covers (playback happens on the project page).
    return `<video class="bs-img-cover" src="${esc(resolved.path)}" muted playsinline preload="metadata" aria-label="${esc(alt)}"></video>`;
  }
  if (!resolved.mime.startsWith("image/")) {
    // Audio/PDF covers have no static image — use the themed tile + a warning.
    ctx.assets.warnings.push(`Cover for "${title.slice(0, 48)}" is a ${resolved.mime.split("/")[0]} file — the export renders a themed tile instead.`);
    const monogram = title.trim().charAt(0).toUpperCase() || "•";
    return `<div class="bs-monogram" aria-hidden="true"><span>${esc(monogram)}</span></div>`;
  }
  return `<img class="bs-img-cover" src="${esc(resolved.path)}" alt="${esc(alt)}" loading="lazy">`;
}

function sectionHeadingHtml(ctx: Ctx, section: SiteSection, m: SiteMotion): string {
  // Per-section style overrides (direct editing) — same rules as the app renderer.
  const style = section.style;
  const styleAttr = style?.headingFont
    ? ` style="font-family:${esc(fontStack(style.headingFont, { external: true }))};${style?.headingWeight ? ` font-weight:${HEADING_WEIGHT_NUM[style.headingWeight]};` : ""}${style?.titleColor ? ` color:${esc(style.titleColor)};` : ""}"`
    : style?.headingWeight || style?.titleColor
      ? ` style="${style.headingWeight ? `font-weight:${HEADING_WEIGHT_NUM[style.headingWeight]};` : ""}${style.titleColor ? `color:${esc(style.titleColor)};` : ""}"`
      : "";
  return `<h2 class="bs-h2"${styleAttr}>${ctx.splitText(section.title, m)}</h2>`;
}

async function projectCardHtml(ctx: Ctx, p: ExportProject, large: boolean): Promise<string> {
  const theme = ctx.theme;
  const body = `<div class="bs-card-body" style="padding:${large ? "1.25rem" : "1rem"}; display:grid; gap:0.25rem;">
    <p class="bs-cat-label">${esc(categoryLabel(p.category))}</p>
    <h3 style="font-weight:600; line-height:1.375; color:${theme.accent}; font-family:${themeFontStacks(theme, { external: true }).heading}; font-size:${large ? "1.25rem" : "1rem"};">${esc(p.title)}</h3>
    ${p.summary ? `<p class="bs-muted" style="font-size:0.875rem; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${esc(p.summary)}</p>` : ""}
  </div>`;
  const img = `<div style="width:100%; overflow:hidden; aspect-ratio:${IMAGE_RATIO[theme.imageRatio]};">${await coverImgHtml(ctx, p.coverUrl, p.title, p.title)}</div>`;
  // bs-hoverzoom mirrors the React renderer's card image-zoom micro-motion.
  return `<a id="project-${esc(p.id)}" class="bs-card${ctx.siteMotion.hoverEffects ? " bs-hoverzoom" : ""}${ctx.theme.glass?.enabled && ctx.theme.glass.targets.cards ? " bs-glass-card" : ""}" href="./project-${esc(p.id)}.html">${img}${body}</a>`;
}

async function sectionHtml(ctx: Ctx, section: SiteSection): Promise<string> {
  const { theme, profile, projects, collections } = ctx;
  const m = ctx.motionFor(section);
  const head = sectionHeadingHtml(ctx, section, m);
  const stacks = themeFontStacks(theme, { external: true });

  switch (section.type) {
    case "hero": {
      const variant = section.variant ?? "classic";
      const subtitle = fill(section.subtitle, profile, ctx.config, { tagline: ctx.config.tagline });
      const showTagline = Boolean(ctx.config.tagline) && !section.subtitle.includes("{tagline}");
      const heroStyle = section.style;
      const headlineStyle = heroStyle?.headingFont
        ? ` style="font-family:${esc(fontStack(heroStyle.headingFont, { external: true }))};${heroStyle.headingWeight ? ` font-weight:${HEADING_WEIGHT_NUM[heroStyle.headingWeight]};` : ""}${heroStyle.titleColor ? ` color:${esc(heroStyle.titleColor)};` : ""}"`
        : heroStyle?.headingWeight || heroStyle?.titleColor
          ? ` style="${heroStyle.headingWeight ? `font-weight:${HEADING_WEIGHT_NUM[heroStyle.headingWeight]};` : ""}${heroStyle.titleColor ? `color:${esc(heroStyle.titleColor)};` : ""}"`
          : "";
      const headline = `<h1 class="bs-h1"${headlineStyle}>${ctx.splitText(fill(section.title, profile, ctx.config, { tagline: ctx.config.tagline }), m)}</h1>`;
      // CTA destination — sanitized exactly like the app renderer.
      const ctaHref = safeCtaHref(section.ctaHref) ?? "#bs-contact";
      const cta = section.ctaLabel
        ? `<a href="${esc(ctaHref)}" class="bs-btn bs-mi${theme.glass?.enabled && theme.glass.targets.buttons ? " bs-glass-btn" : ""}">${esc(section.ctaLabel)}</a>`
        : "";
      const subHtml = subtitle ? `<p class="bs-subtitle">${esc(subtitle)}</p>` : "";
      const tagHtml = showTagline ? `<p class="bs-tagline">${esc(ctx.config.tagline)}</p>` : "";

      const isParallax = getMotionPreset(m.preset)?.parallax === true;
      // Hero cover: config-level override (coverMediaId) wins over the profile
      // cover — same precedence as the React renderer.
      const heroCoverUrl = siteCoverSrc(ctx.config) ?? profile.coverUrl;
      // The creator's real profile picture — same treatment as the live renderer.
      const heroAvatar = await avatarHtml(ctx);
      if (variant === "cover") {
        const resolved = await ctx.assets.resolve(heroCoverUrl);
        if (resolved.kind !== "none") {
          const url = resolved.kind === "media" ? resolved.path : resolved.url;
          return `<section class="bs-cover-hero">
            <img src="${esc(url)}" alt="${esc(profile.name)} cover" class="${isParallax && m.enabled ? "bs-parallax" : ""}" style="object-position: 50% ${profile.coverPositionY}%;">
            <div class="bs-cover-scrim" aria-hidden="true"></div>
            <div class="bs-cover-inner">${heroAvatar}${headline}${subHtml}${tagHtml}${cta ? `<div class="bs-cta-row">${cta}</div>` : ""}</div>
          </section>`;
        }
        // cover variant without an image falls through to classic (mirrors the renderer)
      }
      if (variant === "split") {
        return `<section class="bs-hero-split"><div>${heroAvatar}${headline}</div><div class="bs-split-side" style="display:grid; gap:1rem;">${subHtml}${tagHtml}${cta}</div></section>`;
      }
      const coverStrip =
        heroCoverUrl && variant !== "cover"
          ? `<div class="bs-hero-cover-strip">${await coverImgHtml(ctx, heroCoverUrl, `${profile.name} cover`, profile.name)}</div>`
          : "";
      return `<section class="bs-hero${variant === "centered" ? " bs-hero-center" : ""}"${variant === "centered" ? ' style="text-align:center;"' : ""}>${coverStrip}${heroAvatar}${revealWrap(m, headline + subHtml + tagHtml + (cta ? `<div class="bs-cta-row">${cta}</div>` : ""))}</section>`;
    }

    case "about": {
      const body = fill(section.body, profile, ctx.config) || "This creator hasn't written an about section yet.";
      return `<section class="bs-section">${revealWrap(m, head + `<p class="bs-about-body">${esc(body)}</p>`)}</section>`;
    }

    case "stats": {
      const statCards = [
        { label: "Projects", value: profile.stats.projects },
        { label: "Followers", value: profile.stats.followers },
        { label: "Following", value: profile.stats.following },
      ].map(
        (s) => `<div class="bs-card elevated padded${theme.glass?.enabled && theme.glass.targets.cards ? " bs-glass-card" : ""}">
            <p class="bs-stat-label">${s.label}</p>
            <p class="bs-stat-value">${s.value}</p>
          </div>`
      );
      return `<section class="bs-stats-host bs-section">${revealWrap(
        m,
        head +
          staggerWrap(m, statCards, {
            style: `display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:${GRID_GAP[theme.density]};`,
          })
      )}</section>`;
    }

    case "projects": {
      const filtered = section.category ? projects.filter((p) => (p.category ?? "") === section.category) : projects;
      const list = filtered.slice(0, section.limit);
      const empty = `<p class="bs-muted" style="margin-top:1rem; font-size:0.875rem;">No published projects yet — check back soon.</p>`;
      let inner: string;
      if (list.length === 0) inner = empty;
      else if (section.layout === "list") {
        inner = `<ul class="bs-rows">${list
          .map(
            (p) => `<li><a class="bs-row-link" href="./project-${esc(p.id)}.html"><span class="bs-row-title">${esc(p.title)}</span><span class="bs-row-cat">${esc(categoryLabel(p.category))}</span></a></li>`
          )
          .join("")}</ul>`;
      } else if (section.layout === "editorial") {
        inner = `<div class="bs-editorial">${(
          await Promise.all(
            list.map(async (p, i) => {
              const media = `<div class="bs-editorial-media" style="overflow:hidden; aspect-ratio:${IMAGE_RATIO[theme.imageRatio]}; border-radius:${RADIUS[theme.radius]};">${await coverImgHtml(ctx, p.coverUrl, p.title, p.title)}</div>`;
              const text = `<div><p class="bs-cat-label">${esc(categoryLabel(p.category))}</p><h3 class="bs-editorial-title">${esc(p.title)}</h3>${p.summary ? `<p class="bs-editorial-summary">${esc(p.summary)}</p>` : ""}</div>`;
              return revealWrap(m, `<a class="bs-editorial-row${i % 2 === 1 ? " odd" : ""}${ctx.siteMotion.hoverEffects ? " bs-hoverzoom" : ""}" href="./project-${esc(p.id)}.html">${media}${text}</a>`);
            })
          )
        ).join("")}</div>`;
      } else if (section.layout === "featured" && list.length > 0) {
        const rest = list.slice(1);
        inner = `<div class="bs-featured">${revealWrap(m, await projectCardHtml(ctx, list[0], true))}${
          rest.length
            ? staggerWrap(m, await Promise.all(rest.map((p) => projectCardHtml(ctx, p, false))), { className: "bs-grid cols-3" })
            : ""
        }</div>`;
      } else {
        const cols = theme.columns === 2 ? "cols-2" : "cols-3";
        inner = staggerWrap(m, await Promise.all(list.map((p) => projectCardHtml(ctx, p, false))), { className: `bs-grid ${cols}` });
      }
      return `<section class="bs-section">${revealWrap(m, head + inner)}</section>`;
    }

    case "featured": {
      // FEATURED WORK — the editorial showcase, independent from the projects
      // (All Projects) case above. Explicit curation wins; otherwise ONLY
      // platform-starred projects render — never the whole collection.
      const byId = new Map(projects.map((p) => [p.id, p] as const));
      const curated = section.projectIds
        .map((id) => byId.get(id))
        .filter((p): p is ExportProject => Boolean(p));
      const list = (curated.length > 0 ? curated : projects.filter((p) => p.featured === true)).slice(0, 6);
      const subtitleHtml = section.subtitle
        ? `<p class="bs-muted" style="margin-top:0.5rem; font-size:0.875rem;">${esc(section.subtitle)}</p>`
        : "";
      const empty = `<p class="bs-muted" style="margin-top:1rem; font-size:0.875rem;">No featured projects yet — check back soon.</p>`;
      let inner: string;
      if (list.length === 0) inner = empty;
      else if (section.layout === "editorial") {
        inner = `<div class="bs-editorial">${(
          await Promise.all(
            list.map(async (p, i) => {
              const media = `<div class="bs-editorial-media" style="overflow:hidden; aspect-ratio:${IMAGE_RATIO[theme.imageRatio]}; border-radius:${RADIUS[theme.radius]};">${await coverImgHtml(ctx, p.coverUrl, p.title, p.title)}</div>`;
              const text = `<div><p class="bs-cat-label">${esc(categoryLabel(p.category))}</p><h3 class="bs-editorial-title">${esc(p.title)}</h3>${p.summary ? `<p class="bs-editorial-summary">${esc(p.summary)}</p>` : ""}</div>`;
              return revealWrap(m, `<a class="bs-editorial-row${i % 2 === 1 ? " odd" : ""}${ctx.siteMotion.hoverEffects ? " bs-hoverzoom" : ""}" href="./project-${esc(p.id)}.html">${media}${text}</a>`);
            })
          )
        ).join("")}</div>`;
      } else if (section.layout === "grid") {
        const cols = theme.columns === 2 ? "cols-2" : "cols-3";
        inner = staggerWrap(m, await Promise.all(list.map((p) => projectCardHtml(ctx, p, false))), { className: `bs-grid ${cols}` });
      } else {
        const rest = list.slice(1);
        inner = `<div class="bs-featured">${revealWrap(m, await projectCardHtml(ctx, list[0], true))}${
          rest.length
            ? staggerWrap(m, await Promise.all(rest.map((p) => projectCardHtml(ctx, p, false))), { className: "bs-grid cols-3" })
            : ""
        }</div>`;
      }
      return `<section class="bs-section">${revealWrap(m, head + subtitleHtml + inner)}</section>`;
    }

    case "reel": {
      // VIDEO REEL — up to five real, playable videos. Bundled video files
      // play from the archive's own assets; anything unresolvable (missing,
      // oversized, non-video) degrades to an honest unavailable tile.
      const items = section.videos;
      const subtitleHtml = section.subtitle
        ? `<p class="bs-muted" style="margin-top:0.5rem; font-size:0.875rem;">${esc(section.subtitle)}</p>`
        : "";
      const cols = theme.columns === 2 ? "cols-2" : "cols-3";
      const inner =
        items.length === 0
          ? `<p class="bs-muted" style="margin-top:1rem; font-size:0.875rem;">No videos in the reel yet — check back soon.</p>`
          : staggerWrap(
              m,
              await Promise.all(
                items.map(async (v) => {
                  const resolved = await ctx.assets.resolve(`/api/media/${v.mediaId}/raw`);
                  const caption = v.caption ? `<span class="bs-reel-caption">${esc(v.caption)}</span>` : "";
                  if (resolved.kind === "media" && isVideoMime(resolved.mime)) {
                    return `<li class="bs-reel-item"><video class="bs-reel-video" src="${esc(resolved.path)}" controls playsinline preload="metadata"${v.caption ? ` aria-label="${esc(v.caption)}"` : ""}></video>${caption}</li>`;
                  }
                  if (resolved.kind === "external") {
                    return `<li class="bs-reel-item"><video class="bs-reel-video" src="${esc(resolved.url)}" controls playsinline preload="metadata"></video>${caption}</li>`;
                  }
                  return `<li class="bs-reel-item"><span class="bs-reel-unavailable">Video unavailable in this archive — open the live website to watch it.</span>${caption}</li>`;
                })
              ),
              { className: section.layout === "strip" ? "bs-strip bs-reel-strip" : `bs-grid ${cols}` }
            );
      return `<section class="bs-section">${revealWrap(m, head + subtitleHtml + inner)}</section>`;
    }

    case "skills": {
      const chips = profile.skills.length
        ? staggerWrap(m, profile.skills.map((s) => `<span class="bs-chip">${esc(s)}</span>`), { className: "bs-chips" })
        : `<p class="bs-muted" style="margin-top:1rem; font-size:0.875rem;">No skills listed yet.</p>`;
      return `<section class="bs-section">${revealWrap(m, head + chips)}</section>`;
    }

    case "collections": {
      const list = collections.slice(0, section.limit);
      const inner = list.length
        ? staggerWrap(
            m,
            list.map(
              (c) => `<div class="bs-card padded${theme.glass?.enabled && theme.glass.targets.cards ? " bs-glass-card" : ""}">
                  <p class="bs-collection-name">${esc(c.name)}</p>
                  ${c.description ? `<p class="bs-collection-desc">${esc(c.description)}</p>` : ""}
                  <p class="bs-collection-count">${c.items.length} ${c.items.length === 1 ? "project" : "projects"}</p>
                </div>`
            ),
            // Collections honor the same grid-columns token as the renderer.
            { className: `bs-grid ${theme.columns === 2 ? "cols-2" : "cols-3"}` }
          )
        : `<p class="bs-muted" style="margin-top:1rem; font-size:0.875rem;">No public collections yet.</p>`;
      return `<section class="bs-section">${revealWrap(m, head + inner)}</section>`;
    }

    case "services": {
      const items = section.items.filter((i) => i.title.trim());
      const grid = theme.columns === 2 ? "cols-2" : "cols-3";
      const inner = items.length
        ? section.layout === "rows"
          ? `<ul class="bs-rows">${items
              .map(
                (it, i) => `<li style="display:flex; align-items:baseline; gap:1rem; padding:1rem 0;"><span class="bs-service-index">${String(i + 1).padStart(2, "0")}</span><div><p class="bs-entry-role">${esc(it.title)}</p>${it.description ? `<p class="bs-service-desc">${esc(it.description)}</p>` : ""}</div></li>`
              )
              .join("")}</ul>`
          : staggerWrap(
              m,
              items.map(
                (it) => `<div class="bs-card padded-lg${theme.glass?.enabled && theme.glass.targets.cards ? " bs-glass-card" : ""}" style="padding:1.25rem;">
                    <p class="bs-service-title">${esc(it.title)}</p>
                    ${it.description ? `<p class="bs-service-desc">${esc(it.description)}</p>` : ""}
                  </div>`
              ),
              { className: `bs-grid ${grid}` }
            )
        : `<p class="bs-muted" style="margin-top:1rem; font-size:0.875rem;">Services will appear here once added.</p>`;
      return `<section class="bs-section">${revealWrap(m, head + inner)}</section>`;
    }

    case "experience": {
      const entries = section.entries.filter((e) => e.role.trim());
      const entryHtml = (e: (typeof entries)[number]) =>
        `<div class="bs-entry-head"><p class="bs-entry-role">${esc(e.role)}${e.org ? ` · ${esc(e.org)}` : ""}</p>${e.period ? `<p class="bs-entry-period">${esc(e.period)}</p>` : ""}</div>${e.description ? `<p class="bs-entry-desc">${esc(e.description)}</p>` : ""}`;
      const inner = entries.length
        ? section.layout === "rows"
          ? `<ul class="bs-rows">${entries.map((e) => `<li style="padding:1rem 0;">${entryHtml(e)}</li>`).join("")}</ul>`
          : `<ol class="bs-timeline">${entries.map((e) => `<li>${entryHtml(e)}</li>`).join("")}</ol>`
        : `<p class="bs-muted" style="margin-top:1rem; font-size:0.875rem;">Experience entries will appear here once added.</p>`;
      return `<section class="bs-section">${revealWrap(m, head + inner)}</section>`;
    }

    case "gallery": {
      const src = section.source === "collections" ? collections.flatMap((c) => c.items) : projects;
      const shots = src.filter((p) => p.coverUrl && p.coverUrl.trim()).slice(0, section.limit);
      const cols = theme.columns === 2 ? "cols-2" : "cols-3";
      const inner =
        shots.length === 0
          ? `<p class="bs-muted" style="margin-top:1rem; font-size:0.875rem;">No images to show yet.</p>`
          : section.layout === "strip"
            ? revealWrap(m, `<ul class="bs-strip">${(await Promise.all(shots.map(async (p) => `<li><a href="./project-${esc(p.id)}.html" class="${ctx.siteMotion.hoverEffects ? "bs-hoverzoom" : ""}" style="display:block; aspect-ratio:${IMAGE_RATIO[theme.imageRatio]}; overflow:hidden; border-radius:${RADIUS[theme.radius]};">${await coverImgHtml(ctx, p.coverUrl, p.title, p.title)}</a></li>`))).join("")}</ul>`)
            : section.layout === "masonry"
              ? staggerWrap(m, await Promise.all(shots.map(async (p) => `<a href="./project-${esc(p.id)}.html" class="${ctx.siteMotion.hoverEffects ? "bs-hoverzoom" : ""}">${await coverImgHtml(ctx, p.coverUrl, p.title, p.title)}</a>`)), { className: "bs-masonry" })
              : staggerWrap(m, await Promise.all(shots.map(async (p) => `<a href="./project-${esc(p.id)}.html" class="${ctx.siteMotion.hoverEffects ? "bs-hoverzoom" : ""}" style="display:block; overflow:hidden; aspect-ratio:${IMAGE_RATIO[theme.imageRatio]}; border-radius:${RADIUS[theme.radius]};">${await coverImgHtml(ctx, p.coverUrl, p.title, p.title)}</a>`)), { className: `bs-grid ${cols}` });
      return `<section class="bs-section">${revealWrap(m, head + inner)}</section>`;
    }

    case "testimonials": {
      const items = section.items.filter((i) => i.quote.trim() && i.name.trim());
      const grid = theme.columns === 2 ? "cols-2" : "cols-3";
      const inner = items.length
        ? section.layout === "stack"
          ? `<div class="bs-quotes">${items
              .map(
                (t, i) =>
                  revealWrap(m, `<blockquote><p class="bs-quote-text"><span class="bs-quote-mark" aria-hidden="true">“</span>${esc(t.quote)}<span class="bs-quote-mark" aria-hidden="true">”</span></p><footer class="bs-quote-by">— ${esc(t.name)}${t.role ? `, ${esc(t.role)}` : ""}</footer></blockquote>`)
              )
              .join("")}</div>`
          : revealWrap(
              m,
              `<div class="bs-grid ${grid}">${items
                .map(
                  (t) => `<figure class="bs-card padded-lg${theme.glass?.enabled && theme.glass.targets.cards ? " bs-glass-card" : ""}" style="padding:1.25rem;">
                    <blockquote style="font-size:0.875rem; line-height:1.625;">“${esc(t.quote)}”</blockquote>
                    <figcaption class="bs-meta-label" style="margin-top:0.75rem;">${esc(t.name)}${t.role ? ` · ${esc(t.role)}` : ""}</figcaption>
                  </figure>`
                )
                .join("")}</div>`,
              { stagger: true }
            )
        : `<p class="bs-muted" style="margin-top:1rem; font-size:0.875rem;">Genuine client quotes will appear here once added.</p>`;
      return `<section class="bs-section">${revealWrap(m, head + inner)}</section>`;
    }

    case "process": {
      const steps = section.items.filter((it) => it.title.trim());
      const grid = theme.columns === 2 ? "cols-2" : "cols-3";
      const glassCard = theme.glass?.enabled && theme.glass.targets.cards ? " bs-glass-card" : "";
      const inner = steps.length
        ? section.layout === "steps"
          ? `<ol class="bs-timeline bs-rail">${steps
              .map(
                (it, i) => `<li><span class="bs-process-badge" style="background:${theme.accent}; color:${theme.background};">${i + 1}</span><p class="bs-entry-role">${esc(it.title)}</p>${it.description ? `<p class="bs-entry-desc">${esc(it.description)}</p>` : ""}</li>`
              )
              .join("")}</ol>`
          : staggerWrap(
              m,
              steps.map((it, i) =>
                section.layout === "numbers"
                  ? `<div class="bs-card padded-lg${glassCard}" style="padding:1.25rem;">
                      <p class="bs-process-index">${String(i + 1).padStart(2, "0")}</p>
                      <p class="bs-process-title">${esc(it.title)}</p>
                      ${it.description ? `<p class="bs-service-desc">${esc(it.description)}</p>` : ""}
                    </div>`
                  : `<div class="bs-card padded-lg${glassCard}" style="padding:1.25rem;">
                      <p class="bs-service-title">${esc(it.title)}</p>
                      ${it.description ? `<p class="bs-service-desc">${esc(it.description)}</p>` : ""}
                    </div>`
              ),
              { className: `bs-grid ${grid}` }
            )
        : `<p class="bs-muted" style="margin-top:1rem; font-size:0.875rem;">Process steps will appear here once added.</p>`;
      return `<section class="bs-section">${revealWrap(m, head + inner)}</section>`;
    }

    case "faq": {
      const items = section.items.filter((it) => it.question.trim());
      const inner = items.length
        ? `<div class="bs-faq">${items
            .map(
              (it) => `<details class="bs-faq-item"><summary class="bs-faq-q"><span>${esc(it.question)}</span><span class="bs-faq-chevron" aria-hidden="true">▾</span></summary>${it.answer ? `<p class="bs-faq-a">${esc(it.answer)}</p>` : ""}</details>`
            )
            .join("")}</div>`
        : `<p class="bs-muted" style="margin-top:1rem; font-size:0.875rem;">Questions will appear here once added.</p>`;
      return `<section class="bs-section">${revealWrap(m, head + inner)}</section>`;
    }

    case "pricing": {
      const tiers = section.tiers.filter((t) => t.name.trim());
      const glassCard = theme.glass?.enabled && theme.glass.targets.cards ? " bs-glass-card" : "";
      const glassBtn = theme.glass?.enabled && theme.glass.targets.buttons ? " bs-glass-btn" : "";
      const featureListHtml = (tier: (typeof tiers)[number]) =>
        tier.features.some((f) => f.trim())
          ? `<ul class="bs-price-features">${tier.features
              .filter((f) => f.trim())
              .map((f) => `<li class="bs-price-feature">${ICONS.check}<span>${esc(f)}</span></li>`)
              .join("")}</ul>`
          : "";
      const inner = tiers.length
        ? section.layout === "rows"
          ? `<ul class="bs-rows">${tiers
              .map(
                (tier) => `<li style="padding:1rem 0;">
                  <div style="display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:0.5rem;">
                    <p class="bs-entry-role">${esc(tier.name)}</p>
                    ${tier.price || tier.period ? `<p class="bs-muted" style="font-size:0.875rem; font-family:${stacks.code};">${esc(tier.price)}${tier.period ? ` ${esc(tier.period)}` : ""}</p>` : ""}
                  </div>
                  ${tier.description ? `<p class="bs-entry-desc">${esc(tier.description)}</p>` : ""}
                  ${featureListHtml(tier)}
                </li>`
              )
              .join("")}</ul>`
          : staggerWrap(
              m,
              tiers.map(
                (tier) => `<div class="bs-card bs-price-card padded-lg${glassCard}" style="padding:1.25rem;${tier.highlighted ? ` border-color:${theme.accent}; background:color-mix(in srgb, ${theme.accent} 7%, transparent);` : ""}">
                  ${tier.highlighted ? `<span class="bs-price-flag" role="img" aria-label="Highlighted tier"></span>` : ""}
                  <p class="bs-price-name">${esc(tier.name)}</p>
                  ${tier.price ? `<p class="bs-price-value">${esc(tier.price)}</p>` : ""}
                  ${tier.period ? `<p class="bs-price-period">${esc(tier.period)}</p>` : ""}
                  ${tier.description ? `<p class="bs-service-desc">${esc(tier.description)}</p>` : ""}
                  ${featureListHtml(tier)}
                  ${tier.ctaLabel ? `<div class="bs-cta-row"><a class="bs-btn bs-mi${glassBtn}" href="#bs-contact">${esc(tier.ctaLabel)}</a></div>` : ""}
                </div>`
              ),
              // Static column classes only — 1 tier = single column, 2 = two-up,
              // 3+ = the standard responsive 3-col grid (mirrors the renderer).
              { className: `bs-grid${tiers.length === 1 ? "" : tiers.length === 2 ? " cols-2" : " cols-3"}` }
            )
        : `<p class="bs-muted" style="margin-top:1rem; font-size:0.875rem;">Pricing tiers will appear here once added.</p>`;
      return `<section class="bs-section">${revealWrap(m, head + inner)}</section>`;
    }

    case "logos": {
      const names = section.items.map((it) => it.name.trim()).filter(Boolean);
      // Empty = clearly-labelled placeholder tiles — the export NEVER invents
      // client names (same honesty rule as the live renderer).
      const chips = names.length
        ? names.map((n) => `<span class="bs-logo-chip">${esc(n)}</span>`)
        : [0, 1, 2, 3].map(() => `<span class="bs-logo-chip bs-logo-placeholder" role="img" aria-label="Placeholder — add real client names">Client logo</span>`);
      const inner =
        (section.note ? `<p class="bs-muted" style="margin-top:0.5rem; font-size:0.875rem;">${esc(section.note)}</p>` : "") +
        staggerWrap(m, chips, { style: "display:flex; flex-wrap:wrap; gap:0.75rem; margin-top:1.25rem;" }) +
        (names.length === 0 ? `<p class="bs-muted" style="margin-top:0.75rem; font-size:0.75rem;">Placeholder tiles — the real client names will replace these. GIFTZ never invents clients.</p>` : "");
      return `<section class="bs-section">${revealWrap(m, head + inner)}</section>`;
    }

    case "contact": {
      const body = fill(section.body, profile, ctx.config);
      const firstName = profile.name.split(" ")[0] ?? profile.name;
      const mailto = profile.contactEmail ? `mailto:${esc(profile.contactEmail)}` : null;
      const cta = mailto
        ? `<a href="${mailto}" class="bs-btn bs-mi${theme.glass?.enabled && theme.glass.targets.buttons ? " bs-glass-btn" : ""}">${ICONS.mail} Contact ${esc(firstName)}</a>`
        : `<span class="bs-muted" style="font-size:0.875rem;">Contact details below.</span>`;
      return `<section class="bs-section" id="bs-contact">${revealWrap(
        m,
        head +
          (body ? `<p class="bs-contact-body">${esc(body)}</p>` : "") +
          `<div class="bs-contact-row">${cta}
            ${profile.contactEmail ? `<a class="bs-contact-meta bs-link" href="mailto:${esc(profile.contactEmail)}">${ICONS.mail} ${esc(profile.contactEmail)}</a>` : ""}
            ${profile.websiteUrl ? `<a class="bs-contact-meta bs-link" href="${esc(profile.websiteUrl)}" target="_blank" rel="noopener noreferrer">${ICONS.globe} ${esc(profile.websiteUrl.replace(/^https?:\/\//, ""))}</a>` : ""}
            ${profile.location ? `<span class="bs-contact-meta loc">${ICONS.pin} ${esc(profile.location)}</span>` : ""}
          </div>`
      )}</section>`;
    }

    default:
      return "";
  }
}

// ------------------------------------------------------------------ background layer

function backgroundLayerHtml(theme: ResolvedTheme, motion: SiteMotion): string {
  const bg = motion.enabled ? motion.background : "bg-none";
  if (bg === "bg-none" || !getMotionPreset(bg)) return "";
  const needsBlobs = ["bg-aurora-soft", "bg-aurora-vivid", "bg-float-soft", "bg-float-orbs"].includes(bg);
  const usesThemeGradient = bg === "bg-gradient-pan" || bg === "bg-gradient-hue";
  const gradient = theme.gradient
    ? `linear-gradient(${theme.gradient.angle}deg, ${theme.gradient.from}, ${theme.gradient.to})`
    : `linear-gradient(120deg, ${theme.background}, ${theme.accent})`;
  const blobs = needsBlobs
    ? `<div class="bs-bg-aurora-1"></div>` +
      (bg === "bg-aurora-vivid" || bg === "bg-float-orbs" ? `<div class="bs-bg-aurora-2"></div>` : "") +
      (bg === "bg-aurora-vivid" ? `<div class="bs-bg-aurora-3"></div>` : "") +
      (bg === "bg-float-soft" || bg === "bg-float-orbs" ? `<div class="bs-bg-blob-1"></div>` : "") +
      (bg === "bg-float-soft" ? `<div class="bs-bg-blob-2"></div>` : "") +
      (bg === "bg-float-orbs" ? `<div class="bs-bg-blob-3"></div>` : "")
    : "";
  return `<div class="bs-bg-layer" aria-hidden="true" style="color:${theme.accent};">
    <div style="position:absolute; inset:0;${usesThemeGradient ? ` background-image:${gradient}; background-size:260% 260%;` : ""}"${needsBlobs ? "" : ' class="bs-bg-anim"'}></div>
    ${blobs}
  </div>`;
}

// ------------------------------------------------------------------ page assembly

interface PageFilePlan {
  page: SitePage;
  file: string;
  isHome: boolean;
}

function planPageFiles(config: SiteConfig): PageFilePlan[] {
  // Only VISIBLE pages are part of the exported site: the landing page is the
  // first visible page (matching the live renderer's homePage()), and hidden
  // pages — which have no nav link and are unreachable on the live site — are
  // not emitted as orphan .html files. A site with every page hidden falls
  // back to the first page so an export always exists.
  const visible = config.pages.filter((p) => p.visible !== false);
  const pages = (visible.length > 0 ? visible : config.pages.slice(0, 1)).map((p, i) => ({ page: p, first: i === 0 }));
  const used = new Set<string>();
  return pages.map(({ page, first }) => {
    let file = sanitizePageFile(page.id);
    let n = 2;
    while (used.has(file)) file = `${sanitizePageFile(page.id)}-${n++}`;
    used.add(file);
    return { page, file: first ? "index" : file, isHome: first };
  });
}

async function buildPageHtml(
  ctx: Ctx,
  plan: PageFilePlan,
  plans: PageFilePlan[],
  opts: { title: string; description: string; fontsHref: string | null; watermark: boolean; contentVarStyle: string; bgLayer: string; stylesPath: string; siteJsPath: string; logoHtml: string }
): Promise<string> {
  const { theme } = ctx;
  const visibleSections = plan.page.sections.filter((s) => s && typeof s === "object" && s.visible !== false);
  const navPages = plans.filter((p) => p.page.visible !== false);

  const navLinks =
    navPages.length > 1
      ? navPages
          .map((p) => {
            const href = p.isHome ? "./index.html" : `./${p.file}.html`;
            const current = p.page.id === plan.page.id;
            return `<a class="bs-nav-link bs-mi" href="${href}"${current ? ' aria-current="page"' : ""}>${esc(p.page.name)}</a>`;
          })
          .join("")
      : "";

  const sectionsHtml = (await Promise.all(visibleSections.map((s) => sectionHtml(ctx, s)))).join("\n");

  const masthead = `<header class="bs-masthead${theme.navLayout === "stacked" ? " stacked" : ""}${theme.navLayout === "centered" ? " centered" : ""}${
    theme.glass?.enabled && theme.glass.targets.nav ? " bs-glass" : ""
  }" style="${theme.glass?.enabled && theme.glass.targets.nav ? "" : `border-top: none;`}">
    <p class="bs-site-name">${opts.logoHtml ? `${opts.logoHtml}<span class="bs-sr-only">${esc(ctx.config.name)}</span>` : esc(ctx.config.name)}</p>
    <nav class="bs-site-nav" aria-label="Site pages">${navLinks}<span class="bs-handle">@${esc(ctx.profile.username ?? ctx.profile.name)}</span></nav>
  </header>`;

  const transitionClass =
    ctx.siteMotion.enabled && theme.pageTransition !== "none"
      ? { none: "", fade: "bs-page-fade", slide: "bs-page-slide", rise: "bs-page-rise", zoom: "bs-page-zoom" }[theme.pageTransition]
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description.slice(0, 300))}">
${opts.fontsHref ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${esc(opts.fontsHref)}">` : ""}
<link rel="stylesheet" href="${esc(opts.stylesPath)}">
<script src="${esc(opts.siteJsPath)}" defer></script>
<noscript><style>.bean-site .bs-reveal,.bean-site .bs-reveal .bs-sh,.bean-site .bs-reveal .bs-w{opacity:1 !important;transform:none !important;filter:none !important;clip-path:none !important;transition:none !important}</style></noscript>
</head>
<body>
${ctx.siteMotion.enabled && ctx.siteMotion.scrollProgress ? '<div class="bs-progress" aria-hidden="true"></div>' : ""}
<div class="bean-site bs-bg-host" style="${esc(opts.contentVarStyle)}">
  ${opts.bgLayer}
  <div class="bs-content-wrap">
    ${masthead}
    <div class="${transitionClass}">
      ${sectionsHtml}
    </div>
    <footer class="bs-footer">
      <div class="bs-footer-row">
        <span>${esc(ctx.config.name)} · ${esc(ctx.profile.name)}</span>
        ${opts.watermark ? `<span aria-label="Made with BEAN Folio · GIFTZ">Made with BEAN Folio · GIFTZ</span>` : ""}
      </div>
    </footer>
  </div>
</div>
</body>
</html>`;
}

// ------------------------------------------------------------------ project detail pages

function exportDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));
  } catch {
    return null;
  }
}

/**
 * A project detail page for the exported static site — the export's own
 * equivalent of the live `/site/<username>/projects/<id>` page. Reuses the
 * page shell (masthead, background, footer, generated stylesheet) and swaps
 * the body for the project's REAL data (the same public fields the live
 * project page renders), styled by the same theme. Cards across the site
 * link here via `./project-<id>.html`, so the exported website keeps its
 * own project navigation instead of dead in-page anchors.
 */
async function buildProjectDetailHtml(
  ctx: Ctx,
  project: ExportProject,
  opts: { title: string; description: string; fontsHref: string | null; watermark: boolean; contentVarStyle: string; bgLayer: string; stylesPath: string; siteJsPath: string; logoHtml: string }
): Promise<string> {
  const { theme } = ctx;
  const published = exportDate(project.publishedAt);
  const meta = [published, project.role?.trim() || null].filter(Boolean) as string[];
  const gallery = (project.media ?? []).filter((m) => m.kind === "IMAGE" && m.url);
  const chips = [...new Set([...(project.skills ?? []), ...(project.tools ?? [])])].filter((s) => s.trim().length > 0);
  const narrative = (
    [
      ["Brief", project.brief],
      ["Process", project.process],
      ["Challenges", project.challenges],
      ["Outcome", project.outcome],
    ] as [string, string | null][]
  ).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);

  const coverHtml = project.coverUrl
    ? `<div style="margin-top:2rem; width:100%; overflow:hidden; aspect-ratio:${IMAGE_RATIO[theme.imageRatio]}; border-radius:${RADIUS[theme.radius]};">${await coverImgHtml(ctx, project.coverUrl, project.title, project.title)}</div>`
    : "";
  const galleryHtml = gallery.length
    ? `<section style="margin-top:2.5rem;">
        <h2 class="bs-meta-label" style="font-size:0.875rem; font-weight:600; color:${theme.accent};">Gallery</h2>
        <div style="margin-top:1.25rem; display:grid; gap:1.25rem; grid-template-columns:repeat(auto-fit, minmax(min(260px, 100%), 1fr));">
          ${(await Promise.all(gallery.map(async (m) => `<figure style="margin:0; min-width:0;"><div style="overflow:hidden; border-radius:${RADIUS[theme.radius]};">${await coverImgHtml(ctx, m.url, m.caption ?? project.title, project.title)}</div>${m.caption ? `<figcaption class="bs-muted" style="margin-top:0.5rem; font-size:0.75rem;">${esc(m.caption)}</figcaption>` : ""}</figure>`))).join("")}
        </div>
      </section>`
    : "";
  const linksHtml =
    project.externalUrl || project.repoUrl
      ? `<div class="bs-cta-row" style="margin-top:1.5rem; justify-content:flex-start;">
          ${project.externalUrl ? `<a class="bs-btn bs-mi${theme.glass?.enabled && theme.glass.targets.buttons ? " bs-glass-btn" : ""}" href="${esc(project.externalUrl)}" target="_blank" rel="noopener noreferrer">${ICONS.globe} Visit live site</a>` : ""}
          ${project.repoUrl ? `<a class="bs-btn bs-mi${theme.glass?.enabled && theme.glass.targets.buttons ? " bs-glass-btn" : ""}" href="${esc(project.repoUrl)}" target="_blank" rel="noopener noreferrer">${ICONS.globe} Source code</a>` : ""}
        </div>`
      : "";
  const chipsHtml = chips.length
    ? `<div style="margin-top:2.25rem; display:flex; flex-wrap:wrap; gap:0.5rem;">${chips.map((s) => `<span style="border:1px solid ${theme.border}; border-radius:${RADIUS[theme.radius]}; padding:0.25rem 0.75rem; font-size:0.875rem; color:${theme.muted};">${esc(s)}</span>`).join("")}</div>`
    : "";
  const narrativeHtml = narrative
    .map(
      ([label, body]) =>
        `<section style="margin-top:2.25rem; max-width:44rem;"><h2 class="bs-meta-label" style="font-size:0.875rem; font-weight:600; color:${theme.accent};">${esc(label)}</h2><p style="margin-top:0.75rem; white-space:pre-wrap; line-height:1.65; opacity:0.92;">${esc(body)}</p></section>`
    )
    .join("");

  const navPages = planPageFiles(ctx.config).filter((p) => p.page.visible !== false);
  const navLinks =
    navPages.length > 1
      ? navPages
          .map((p) => `<a class="bs-nav-link bs-mi" href="${p.isHome ? "./index.html" : `./${p.file}.html`}">${esc(p.page.name)}</a>`)
          .join("")
      : "";
  const masthead = `<header class="bs-masthead${theme.navLayout === "stacked" ? " stacked" : ""}${theme.navLayout === "centered" ? " centered" : ""}${
    theme.glass?.enabled && theme.glass.targets.nav ? " bs-glass" : ""
  }" style="${theme.glass?.enabled && theme.glass.targets.nav ? "" : `border-top: none;`}">
    <p class="bs-site-name">${opts.logoHtml ? `${opts.logoHtml}<span class="bs-sr-only">${esc(ctx.config.name)}</span>` : esc(ctx.config.name)}</p>
    <nav class="bs-site-nav" aria-label="Site pages">${navLinks}<span class="bs-handle">@${esc(ctx.profile.username ?? ctx.profile.name)}</span></nav>
  </header>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description.slice(0, 300))}">
${opts.fontsHref ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${esc(opts.fontsHref)}">` : ""}
<link rel="stylesheet" href="${esc(opts.stylesPath)}">
<script src="${esc(opts.siteJsPath)}" defer></script>
<noscript><style>.bean-site .bs-reveal,.bean-site .bs-reveal .bs-sh,.bean-site .bs-reveal .bs-w{opacity:1 !important;transform:none !important;filter:none !important;clip-path:none !important;transition:none !important}</style></noscript>
</head>
<body>
${ctx.siteMotion.enabled && ctx.siteMotion.scrollProgress ? '<div class="bs-progress" aria-hidden="true"></div>' : ""}
<div class="bean-site bs-bg-host" style="${esc(opts.contentVarStyle)}">
  ${opts.bgLayer}
  <div class="bs-content-wrap">
    ${masthead}
    <div>
      <nav aria-label="Back to site" style="padding-top:0.5rem;">
        <a class="bs-nav-link bs-mi" href="./index.html" style="color:${theme.accent};">&#8592; Back to ${esc(ctx.config.name)}</a>
      </nav>
      <article style="padding:1.5rem 0 3rem;">
        <p class="bs-cat-label">${esc(categoryLabel(project.category))}</p>
        <h1 class="bs-h1" style="font-size:clamp(1.75rem, 4vw, 2.75rem);">${esc(project.title)}</h1>
        ${meta.length > 0 ? `<p class="bs-meta-label" style="margin-top:0.75rem;">${meta.map(esc).join(" · ")}</p>` : ""}
        ${linksHtml}
        ${coverHtml}
        ${project.summary ? `<p style="margin-top:2rem; max-width:44rem; font-size:1.125rem; line-height:1.6;">${esc(project.summary)}</p>` : ""}
        ${project.description ? `<p style="margin-top:1.25rem; max-width:44rem; white-space:pre-wrap; line-height:1.65; opacity:0.92;">${esc(project.description)}</p>` : ""}
        ${narrativeHtml}
        ${chipsHtml}
        ${galleryHtml}
      </article>
    </div>
    <footer class="bs-footer">
      <div class="bs-footer-row">
        <span>${esc(ctx.config.name)} · ${esc(ctx.profile.name)}</span>
        ${opts.watermark ? `<span aria-label="Made with BEAN Folio · GIFTZ">Made with BEAN Folio · GIFTZ</span>` : ""}
      </div>
    </footer>
  </div>
</div>
</body>
</html>`;
}

// ------------------------------------------------------------------ README & manifest

function buildReadme(input: SiteExportInput, source: "draft" | "published", warnings: string[], externalFonts: boolean, fileNames: string[]): string {
  const { config, profile } = input;
  const siteName = config.name || profile.name;
  return `# ${siteName} — static website

Exported from BEAN Folio Website Studio on ${new Date().toISOString().slice(0, 10)} (source: the website ${source === "draft" ? "draft" : "published snapshot"} as saved at export time).

## What this is

A fully standalone static website — plain HTML, CSS and vanilla JavaScript with
relative asset paths. It does not depend on BEAN Folio, its API, or any preview
hostname. Open it, host it anywhere that serves files.

## Run it locally

The simplest option — most machines can open \`index.html\` directly in a browser.
For the cleanest result (correct font + image loading under strict browsers),
serve the folder over HTTP:

    # Python
    python3 -m http.server 8080
    # then open http://localhost:8080

    # Node
    npx serve .

## Deploy it

Any static host works — drag-and-drop or connect the folder:

- **Cloudflare Pages** — create a project → "Direct Upload" → upload this folder
  (or push it to a Git repo and select "None" as the build framework; no build command, output directory = root).
- **Netlify** — drag the folder onto app.netlify.com/drop, or connect a repo
  (build command: empty; publish directory: \`.\`).
- **GitHub Pages** — push the folder to a repo → Settings → Pages →
  deploy from branch (root), or use the included \`index.html\` as-is.
- Any web server (nginx, Apache, S3 + CDN): upload the files, that's all.

## Files

${fileNames.map((f) => `- \`${f}\``).join("\n")}

## Design system

Colors, typography, spacing, glass effects and motion come from the creator's
saved configuration. Fonts are loaded from Google Fonts (open-source licensed)
via a \`fonts.googleapis.com\` stylesheet link${externalFonts ? "" : " (none needed)"}, with system-font fallbacks built into
the CSS — the site renders correctly offline, just with fallback typefaces.

## What a static export cannot do (honest limitations)

- **Inquiries / contact form** → replaced by plain \`mailto:\` email links.
- **BEAN Folio platform features** (follows, follower stats, saves, RIISHE AI,
  discovery) are not part of a static site.
- **Live content**: this is a snapshot. Editing the site in Website Studio and
  re-exporting produces a new ZIP; the files never update themselves.
- **Project detail pages** are not included — project cards link to in-page
  anchors (${fileNames.length > 1 ? "use the site's pages for navigation" : "the home page"}).
- The footer credit "Made with BEAN Folio · GIFTZ" is plain text here (it
  links to the platform on the live site).

${warnings.length ? `## Export notes\n\n${warnings.map((w) => `- ${w}`).join("\n")}\n` : ""}
See \`manifest.json\` for the exact file inventory and feature notes.
`;
}

interface ManifestShape {
  generator: string;
  generatedAt: string;
  source: "draft" | "published";
  site: { name: string; template: string; pages: number; sections: number };
  creator: { name: string; username: string | null };
  files: { path: string; bytes: number; role: string }[];
  fonts: { source: string; note: string };
  externalResources: string[];
  unsupportedFeatures: string[];
  exportNotes: string[];
  watermark: boolean;
}

// ------------------------------------------------------------------ main entry

export async function buildSiteExport(input: SiteExportInput): Promise<SiteExportResult> {
  const { config, profile, projects, collections, watermark, loadMedia } = input;
  const theme = deriveTheme(config.theme);
  const motion = config.motion;
  const assets = new AssetMapper(loadMedia);
  // external: true — same reason as buildStylesheet: the export has no
  // next/font variables, so bundled families use real names in every stack.
  const stacks = themeFontStacks(theme, { external: true });

  const ctx: Ctx = {
    theme,
    siteMotion: motion,
    motionFor: (s) => sectionMotion(motion, s),
    assets,
    config,
    profile,
    projects,
    collections,
    splitText: splitTextHtml,
  };

  // ---- fonts (Google Fonts stylesheet for exactly the families/weights used)
  const fontRequests = new Map<string, Set<number>>();
  const addFont = (id: string, weights: number[]) => {
    const key = id;
    if (!fontRequests.has(key)) fontRequests.set(key, new Set());
    for (const w of weights) fontRequests.get(key)!.add(w);
  };
  addFont(theme.headingFont, [HEADING_WEIGHT_NUM[theme.headingWeight], 700]);
  addFont(theme.bodyFont, [400, 500, 600]);
  addFont(theme.accentFont, [500, 600]);
  addFont(theme.codeFont, [400, 600]);
  // includeBundled: the export must load EVERY family the config names —
  // including the app-bundled Fraunces/Geist/Geist Mono, which exist as real
  // Google Fonts. Without this the exported site silently fell back to
  // system fonts for those families while the live site used the real ones.
  const fontsHref = googleFontsHref(Array.from(fontRequests, ([id, ws]) => ({ id, weights: Array.from(ws).sort((a, b) => a - b) })), { includeBundled: true });

  // ---- pages
  const plans = planPageFiles(config);
  const files: ExportFile[] = [];

  // Pre-resolve every REFERENCED image so asset files + warnings are final
  // BEFORE the HTML is written (HTML references relative paths only). Only
  // images the site actually renders are exported — no orphan assets.
  await ctx.assets.resolve(profile.coverUrl);
  for (const p of projects) await ctx.assets.resolve(p.coverUrl);
  for (const c of collections) for (const item of c.items) await ctx.assets.resolve(item.coverUrl);

  // ---- masthead branding logo (optional)
  // Uploaded media resolves through the owner-scoped loader like every other
  // asset; the built-in BEAN Folio mark is copied from the app's public/brand
  // directory (a static asset shipped with the app — not user data).
  let logoHtml = "";
  const logoSrc = siteLogoSrc(config);
  if (logoSrc) {
    let logoPath: string | null = null;
    if (logoSrc === BEAN_FOLIO_LOGO_PATH) {
      try {
        const fsp = await import("node:fs/promises");
        const bytes = await fsp.readFile(join(process.cwd(), "public", BEAN_FOLIO_LOGO_PATH));
        logoPath = "assets/images/bean-folio-logo.png";
        files.push({ path: logoPath, data: bytes });
      } catch {
        assets.warnings.push("The BEAN Folio brand logo file was unavailable — the masthead falls back to the site name.");
      }
    } else {
      const resolved = await ctx.assets.resolve(logoSrc);
      if (resolved.kind === "media") logoPath = resolved.path;
      else if (resolved.kind === "external") logoPath = null;
    }
    if (logoPath) {
      logoHtml = `<img class="bs-site-logo" src="./${esc(logoPath)}" alt="${esc(config.name)} logo">`;
    }
  }

  const contentVarStyle = rootVars(theme, motion);
  const bgLayer = backgroundLayerHtml(theme, motion);

  const description =
    profile.bio?.trim() || profile.headline || `Portfolio of ${profile.name}.`;

  for (const plan of plans) {
    const html = await buildPageHtml(ctx, plan, plans, {
      title: `${config.name} — ${profile.name}`,
      description,
      fontsHref,
      watermark,
      contentVarStyle,
      bgLayer,
      stylesPath: "./assets/styles.css",
      siteJsPath: "./assets/site.js",
      logoHtml,
    });
    files.push({ path: `${plan.file}.html`, data: Buffer.from(html, "utf8") });
  }

  // ---- project detail pages (the website's OWN project pages, exported)
  // Each public project gets a real standalone page (project-<id>.html) built
  // from the SAME design system — every project card links here, mirroring
  // /site/<username>/projects/<id> on the live site.
  for (const p of projects) {
    for (const m of p.media ?? []) {
      if (m.kind === "IMAGE" && m.url) await ctx.assets.resolve(m.url);
    }
    const html = await buildProjectDetailHtml(ctx, p, {
      title: `${p.title} — ${config.name}`,
      description: p.summary || p.description || description,
      fontsHref,
      watermark,
      contentVarStyle,
      bgLayer,
      stylesPath: "./assets/styles.css",
      siteJsPath: "./assets/site.js",
      logoHtml,
    });
    files.push({ path: `project-${p.id}.html`, data: Buffer.from(html, "utf8") });
  }

  // ---- styles + script
  files.push({ path: "assets/styles.css", data: Buffer.from(buildStylesheet(theme, motion, config), "utf8") });
  files.push({ path: "assets/site.js", data: Buffer.from(buildSiteJs(motion), "utf8") });

  // ---- media assets
  for (const f of assets.files) files.push({ path: f.path, data: f.data });

  // ---- README + manifest
  const fileNames = files.map((f) => f.path);
  files.push({
    path: "README.md",
    data: Buffer.from(buildReadme(input, input.source, assets.warnings, Boolean(fontsHref), fileNames), "utf8"),
  });

  const roles = (p: string): string =>
    p === "index.html"
      ? "Home page"
      : p.endsWith(".html")
        ? "Site page"
        : p === "assets/styles.css"
          ? "Generated stylesheet (theme, layout, motion)"
          : p === "assets/site.js"
            ? "Generated behavior (scroll reveals, parallax)"
            : p.startsWith("assets/images/")
              ? "Media asset (relative path)"
              : p === "README.md"
                ? "Export documentation"
                : "Export manifest";

  const manifest: ManifestShape = {
    generator: "BEAN Folio Website Studio — static website export",
    generatedAt: new Date().toISOString(),
    source: input.source,
    site: {
      name: config.name,
      template: config.template,
      pages: plans.length,
      sections: config.pages.reduce((n, p) => n + p.sections.length, 0),
    },
    creator: { name: profile.name, username: profile.username },
    // The manifest inventories EVERY archive file including itself.
    files: [...files.map((f) => ({ path: f.path, bytes: f.data.length, role: roles(f.path) })), { path: "manifest.json", bytes: 0, role: "Export manifest" }],
    fonts: {
      source: fontsHref ? "Google Fonts CDN (OFL-licensed)" : "system fallbacks only",
      note: "Font families match the saved configuration; system fallback stacks are included in the CSS.",
    },
    externalResources: [...assets.externalUrls, ...(fontsHref ? ["https://fonts.googleapis.com (stylesheet)"] : [])],
    unsupportedFeatures: [
      "Inquiry/contact form → replaced with mailto: links (no backend in a static site)",
      "Follow / follower counts / saves / platform insights are not exported",
      "RIISHE AI features are platform-only",
      "Project structured/custom studio fields render on the live site but are not exported",
      "Project gallery videos, audio and documents are not bundled — image media only",
      "Static snapshot: content does not update without re-exporting",
    ],
    exportNotes: assets.warnings,
    watermark,
  };
  files.push({ path: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });

  return { files, warnings: assets.warnings };
}
