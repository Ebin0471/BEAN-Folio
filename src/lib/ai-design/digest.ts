/**
 * Code Giftz — site digest (deep project understanding).
 *
 * A deterministic, computed inventory of the website the agent is working on:
 * pages, sections, resolved fonts, motion, matched palette, contrast pairs and
 * structural warnings. It is computed from the REAL config (never from model
 * output), shared by the server (prompt grounding + audit evidence) and the
 * client (the AI panel's context display), so the model, the panel and the
 * executor all reason about exactly the same picture of the site.
 *
 * Pure module — safe to import from client and server code.
 */
import { resolveFont } from "@/lib/site-fonts";
import { getMotionPreset } from "@/lib/site-motion";
import { contrastRatio, PALETTES } from "@/lib/site-palettes";
import { mixHex } from "@/lib/site-config";
import type { SiteConfig, SitePage, SiteSection } from "@/lib/site-config";

export interface DigestSection {
  id: string;
  type: string;
  title: string;
  visible: boolean;
  /** Compact human summary of the section's content state. */
  detail: string;
}

export interface DigestPage {
  id: string;
  name: string;
  visible: boolean;
  sections: DigestSection[];
}

export interface DigestContrastPair {
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  aaPass: boolean;
  aaLargePass: boolean;
}

export interface SiteDigest {
  template: string;
  name: string;
  tagline: string;
  pageCount: number;
  pages: DigestPage[];
  sectionCount: number;
  sectionTypes: string[];
  fonts: { heading: string; body: string; accent: string; code: string };
  /** Curated palette matched by exact token identity, when the site uses one. */
  palette: { id: string; label: string } | null;
  motion: {
    enabled: boolean;
    preset: string;
    presetLabel: string;
    duration: number;
    intensity: number;
    stagger: number;
    background: string;
    microInteractions: string;
    hoverEffects: boolean;
    scrollReveal: boolean;
    once: boolean;
  };
  theme: {
    background: string;
    foreground: string;
    accent: string;
    accent2: string;
    surface: string;
    radius: string;
    density: string;
    typeScale: string;
    contentWidth: string;
    navLayout: string;
    buttonStyle: string;
    glass: boolean;
  };
  contrast: DigestContrastPair[];
  /** Computed structural/content warnings — real evidence, not speculation. */
  warnings: string[];
  /** Extra environment context supplied by the caller (server session data). */
  context?: {
    publishState: string;
    publishedProjects: number;
    hasAvatar: boolean;
    hasCover: boolean;
  };
}

function sectionDetail(s: SiteSection): string {
  switch (s.type) {
    case "hero":
      return `variant ${s.variant}${s.subtitle ? "" : " · no subtitle"}${s.ctaLabel ? ` · CTA "${s.ctaLabel}"` : " · no CTA"}`;
    case "about":
      return s.body ? `${s.body.length} chars` : "EMPTY body";
    case "projects":
      return `limit ${s.limit} · ${s.layout}${s.category ? ` · filter ${s.category}` : ""}`;
    case "collections":
      return `limit ${s.limit}`;
    case "services":
      return s.items.length ? `${s.items.length} items · ${s.layout}` : "EMPTY (no items)";
    case "experience":
      return s.entries.length ? `${s.entries.length} entries · ${s.layout}` : "EMPTY (no entries)";
    case "process":
      return s.items.length ? `${s.items.length} steps · ${s.layout}` : "EMPTY (no steps)";
    case "faq":
      return s.items.length ? `${s.items.length} Q&As` : "EMPTY (no questions)";
    case "pricing":
      return s.tiers.length ? `${s.tiers.length} tiers · ${s.layout}` : "EMPTY (no tiers)";
    case "logos":
      return s.items.length ? `${s.items.length} wordmarks` : "placeholder tiles";
    case "gallery":
      return `${s.source} · limit ${s.limit} · ${s.layout}`;
    case "testimonials":
      return s.items.length ? `${s.items.length} quotes · ${s.layout}` : "EMPTY (no quotes yet)";
    case "contact":
      return s.body ? `${s.body.length} chars` : "EMPTY body";
    default:
      return "profile data section";
  }
}

/** Match the site's exact background+accent+foreground tokens against the curated palettes. */
function matchPalette(config: SiteConfig): { id: string; label: string } | null {
  for (const p of PALETTES) {
    if (
      p.tokens.background.toLowerCase() === config.theme.background.toLowerCase() &&
      p.tokens.accent.toLowerCase() === config.theme.accent.toLowerCase() &&
      p.tokens.foreground.toLowerCase() === config.theme.foreground.toLowerCase()
    ) {
      return { id: p.id, label: p.label };
    }
  }
  return null;
}

/**
 * Derive the optional theme tokens exactly like deriveTheme does, so digest
 * evidence and verification always match what actually renders on the site.
 * Pure — safe from client and server code.
 */
export function derivedThemeTokens(config: SiteConfig): {
  surface: string;
  border: string;
  muted: string;
  accent2: string;
  focus: string;
} {
  const t = config.theme;
  return {
    surface: t.surface ?? mixHex(t.background, t.foreground, 0.06),
    border: t.border ?? mixHex(t.background, t.foreground, 0.18),
    muted: t.muted ?? mixHex(t.foreground, t.background, 0.42),
    accent2: t.accent2 ?? mixHex(t.accent, t.foreground, 0.35),
    focus: t.focus ?? mixHex(t.accent, t.background, 0.35),
  };
}

export function buildSiteDigest(
  config: SiteConfig,
  context?: SiteDigest["context"]
): SiteDigest {
  const derived = derivedThemeTokens(config);
  const pages: DigestPage[] = config.pages.map((p: SitePage) => ({
    id: p.id,
    name: p.name,
    visible: p.visible,
    sections: p.sections.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      visible: s.visible,
      detail: sectionDetail(s),
    })),
  }));
  const allSections = config.pages.flatMap((p) => p.sections);
  const sectionTypes = Array.from(new Set(allSections.map((s) => s.type)));

  // Contrast evidence — the pairs that actually render text on this site.
  // muted is optional in the schema (deriveTheme fills it); the digest uses
  // the same derivation so evidence matches what renders.
  const { muted } = derivedThemeTokens(config);
  const contrast: DigestContrastPair[] = [
    { label: "Body text", fg: config.theme.foreground, bg: config.theme.background },
    { label: "Muted text", fg: muted, bg: config.theme.background },
    { label: "Accent on background", fg: config.theme.accent, bg: config.theme.background },
  ].map(({ label, fg, bg }) => {
    const ratio = contrastRatio(fg, bg);
    return { label, fg, bg, ratio: Math.round(ratio * 100) / 100, aaPass: ratio >= 4.5, aaLargePass: ratio >= 3 };
  });

  const warnings: string[] = [];
  const pageNameOf = (s: SiteSection) => config.pages.find((p) => p.sections.some((x) => x.id === s.id))?.name ?? "?";
  for (const s of allSections) {
    if (s.type === "services" && s.items.length === 0)
      warnings.push(`The “${s.title}” services section on “${pageNameOf(s)}” has no items yet.`);
    if (s.type === "experience" && s.entries.length === 0)
      warnings.push(`The “${s.title}” experience section on “${pageNameOf(s)}” has no entries yet.`);
    if (s.type === "process" && s.items.length === 0)
      warnings.push(`The “${s.title}” process section on “${pageNameOf(s)}” has no steps yet.`);
    if (s.type === "faq" && s.items.length === 0)
      warnings.push(`The “${s.title}” FAQ section on “${pageNameOf(s)}” has no questions yet.`);
    if (s.type === "pricing" && s.tiers.length === 0)
      warnings.push(`The “${s.title}” pricing section on “${pageNameOf(s)}” has no tiers yet.`);
    if (s.type === "testimonials" && s.items.length === 0)
      warnings.push(`The “${s.title}” testimonials section is an empty container — add genuine quotes before publishing.`);
  }
  if (!config.tagline.trim()) warnings.push("No tagline set for the website.");
  const about = allSections.find((s) => s.type === "about");
  if (about && about.body.trim() === "") warnings.push(`The “${about.title}” about section has no text.`);
  const contact = allSections.find((s) => s.type === "contact");
  if (contact && contact.body.trim() === "") warnings.push(`The “${contact.title}” contact section has no text.`);
  const titleCount = new Map<string, number>();
  for (const s of allSections) titleCount.set(s.title, (titleCount.get(s.title) ?? 0) + 1);
  for (const [title, n] of titleCount) if (n > 1) warnings.push(`Section title “${title}” is used ${n}× — consider distinct headings.`);
  for (const p of config.pages) if (!p.visible) warnings.push(`Page “${p.name}” is hidden from the site navigation.`);
  const firstPage = config.pages[0];
  if (firstPage && !firstPage.sections.some((s) => s.type === "hero"))
    warnings.push(`The first page (“${firstPage.name}”) has no hero section.`);
  for (const c of contrast) if (!c.aaLargePass) warnings.push(`Contrast: ${c.label} (${c.fg}) on background is ${c.ratio}:1 — below WCAG AA-large.`);

  const heading = resolveFont(config.theme.headingFont);
  const body = resolveFont(config.theme.bodyFont);
  const accent = resolveFont(config.theme.accentFont, heading.id);
  const code = resolveFont(config.theme.codeFont, "geist-mono");
  const motion = config.motion;
  const presetLabel = getMotionPreset(motion.preset)?.label ?? motion.preset;

  return {
    template: config.template,
    name: config.name,
    tagline: config.tagline,
    pageCount: config.pages.length,
    pages,
    sectionCount: allSections.length,
    sectionTypes,
    fonts: {
      heading: `${heading.id} (${heading.family})`,
      body: `${body.id} (${body.family})`,
      accent: `${accent.id} (${accent.family})`,
      code: `${code.id} (${code.family})`,
    },
    palette: matchPalette(config),
    motion: {
      enabled: motion.enabled,
      preset: motion.preset,
      presetLabel,
      duration: motion.duration,
      intensity: motion.intensity,
      stagger: motion.stagger,
      background: motion.background,
      microInteractions: motion.microInteractions,
      hoverEffects: motion.hoverEffects,
      scrollReveal: motion.scrollReveal,
      once: motion.once,
    },
    theme: {
      background: config.theme.background,
      foreground: config.theme.foreground,
      accent: config.theme.accent,
      accent2: derived.accent2,
      surface: derived.surface,
      radius: config.theme.radius,
      density: config.theme.density,
      typeScale: config.theme.typeScale,
      contentWidth: config.theme.contentWidth,
      navLayout: config.theme.navLayout,
      buttonStyle: config.theme.buttonStyle,
      glass: Boolean(config.theme.glass?.enabled),
    },
    contrast,
    warnings,
    context,
  };
}

/** One-line human summary used in the AI panel context strip. */
export function digestSummaryLine(d: SiteDigest): string {
  const bits = [
    `${d.pageCount} page${d.pageCount === 1 ? "" : "s"}`,
    `${d.sectionCount} section${d.sectionCount === 1 ? "" : "s"}`,
    d.template,
    d.motion.enabled ? d.motion.presetLabel : "no motion",
  ];
  const fails = d.contrast.filter((c) => !c.aaLargePass).length;
  if (fails > 0) bits.push(`${fails} contrast issue${fails === 1 ? "" : "s"}`);
  return bits.join(" · ");
}
