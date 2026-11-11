"use client";

import { useEffect, useMemo, Children, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ExternalLink, Globe, Mail, MapPin } from "lucide-react";

import { categoryLabel } from "@/components/bean/ProjectCard";
import {
  defaultMotion,
  deriveTheme,
  homePage,
  mixHex,
  safeCtaHref,
  sectionMotion,
  siteCoverSrc,
  siteLogoSrc,
  themeFontStacks,
} from "@/lib/site-config";
import type {
  HeroVariant,
  ResolvedTheme,
  SiteConfig,
  SiteGlass,
  SiteMotion,
  SitePage,
  SiteSection,
  SiteTheme,
} from "@/lib/site-config";
import { BANNER_ASPECT_CLASS } from "@/lib/banner";
import { ensureFontLoaded, fontStack } from "@/lib/site-fonts";
import { publicSiteProjectHashUrl } from "@/lib/site-url";
import type { FullProject, ProjectCardDTO, ProjectMediaDTO } from "@/lib/types";
import {
  backgroundMotionCss,
  baseMotionCss,
  easingCss,
  getMotionPreset,
  microInteractionCss,
  revealPresetCss,
} from "@/lib/site-motion";
import { cn } from "@/lib/utils";

/**
 * Renders a published (or draft) website configuration against a profile's
 * real data. Used by:
 *  - Website Studio (live device preview canvas, inside an iframe)
 *  - the public profile page (site mode — the published snapshot)
 *
 * The renderer is data-driven and defensive: a config that lost sections
 * (legacy/corrupt JSON) renders the remaining content instead of crashing.
 * Every design control in the builder maps to something rendered here:
 * fonts, palette tokens, gradients, surface opacity, glass, motion presets,
 * background effects, micro-interactions, nav layouts, alignment, density.
 * All animation honors prefers-reduced-motion.
 */

export interface SiteRendererProfile {
  name: string;
  username: string | null;
  headline: string | null;
  location: string | null;
  bio: string | null;
  availability: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  coverPositionY: number;
  professions: string[];
  skills: string[];
  websiteUrl: string | null;
  contactEmail: string | null;
  stats: { followers: number; following: number; projects: number };
}

export interface SiteRendererProps {
  config: SiteConfig;
  profile: SiteRendererProfile;
  projects: ProjectCardDTO[];
  collections: { id: string; name: string; description: string | null; items: ProjectCardDTO[] }[];
  /** Opens the inquiry dialog (public page) — the renderer itself never sends data. */
  onContact?: () => void;
  /**
   * mailto: fallback for the contact CTA when the visitor has no platform
   * session (standalone published websites). Rendered as a plain email link
   * so an anonymous visitor is NEVER pushed to platform sign-in — the site
   * must stay fully standalone. Ignored when onContact is provided.
   */
  contactHref?: string | null;
  /**
   * Platform-level footer attribution ("Made with BEAN Folio · GIFTZ").
   * Rendered by the VIEW at display time — it is never part of SiteConfig or
   * the published snapshot, so republishing cannot duplicate it and content
   * edits cannot corrupt it. On by default; the platform setting can turn it
   * off (SiteDesign.watermark).
   */
  watermark?: boolean;
  /** Optional controlled page selection (Website Studio). Uncontrolled in public mode. */
  pageId?: string;
  onPageChange?: (pageId: string) => void;
  /**
   * Direct element selection (Website Studio only). When provided, every
   * rendered section becomes click-to-select: the section gets data attributes,
   * a subtle selection outline (interactive mode ONLY — never rendered on
   * public/published sites), and clicks report the owning section id. The
   * builder connects the selection to the existing side-panel controls.
   */
  interactiveSelection?: {
    selectedSectionId: string | null;
    onSelectSection: (sectionId: string | null) => void;
  };
}

// ------------------------------------------------------------------ theme plumbing

const HEADING_WEIGHT_NUM: Record<SiteTheme["headingWeight"], number> = {
  light: 300,
  semibold: 600,
  bold: 800,
};

const DENSITY_GAP: Record<SiteTheme["density"], string> = {
  compact: "3.25rem",
  regular: "5rem",
  relaxed: "7rem",
};

/** Vertical gap between sections — driven by the Spacing (density) control. */
const SECTION_GAP: Record<SiteTheme["density"], string> = {
  compact: "2.75rem",
  regular: "4rem",
  relaxed: "6rem",
};

/** Gap inside grids/lists — also density-driven. */
const GRID_GAP: Record<SiteTheme["density"], string> = {
  compact: "0.9rem",
  regular: "1.25rem",
  relaxed: "1.6rem",
};

const RADIUS: Record<SiteTheme["radius"], string> = {
  none: "0px",
  md: "12px",
  full: "16px",
};

const TYPE_SCALE: Record<SiteTheme["typeScale"], { hero: string; h2: string }> = {
  intimate: { hero: "text-3xl sm:text-4xl", h2: "text-lg sm:text-xl" },
  balanced: { hero: "text-4xl sm:text-6xl", h2: "text-2xl sm:text-3xl" },
  grand: { hero: "text-5xl sm:text-7xl", h2: "text-3xl sm:text-4xl" },
};

/** Fluid clamp() sizing layered on top of TYPE_SCALE — inline style wins over
 * the Tailwind classes, so headlines scale continuously between the scale's
 * two fixed sizes instead of jumping at the sm breakpoint. Mirrored 1:1 in
 * the static export's stylesheet (site-export.ts). */
const FLUID_HERO: Record<SiteTheme["typeScale"], string> = {
  intimate: "clamp(1.9rem, 1.2rem + 3.2vw, 2.6rem)",
  balanced: "clamp(2.25rem, 1.3rem + 4.6vw, 3.9rem)",
  grand: "clamp(2.75rem, 1.6rem + 6.2vw, 5.2rem)",
};

const FLUID_H2: Record<SiteTheme["typeScale"], string> = {
  intimate: "clamp(1.15rem, 1.05rem + 0.8vw, 1.5rem)",
  balanced: "clamp(1.5rem, 1.15rem + 1.9vw, 2.1rem)",
  grand: "clamp(1.85rem, 1.3rem + 2.9vw, 2.75rem)",
};

const LINE_HEIGHT: Record<SiteTheme["lineHeight"], string> = {
  tight: "1.15",
  normal: "1.4",
  relaxed: "1.7",
};

const TRACKING: Record<SiteTheme["letterSpacing"], string> = {
  tight: "-0.02em",
  normal: "0em",
  wide: "0.06em",
};

const CONTENT_WIDTH: Record<SiteTheme["contentWidth"], string> = {
  narrow: "56rem",
  regular: "72rem",
  wide: "80rem",
};

const IMAGE_RATIO: Record<SiteTheme["imageRatio"], string> = {
  "4/3": "4 / 3",
  "3/2": "3 / 2",
  "1/1": "1 / 1",
  "16/9": "16 / 9",
};

const PAGE_TRANSITION_CLASS: Record<SiteTheme["pageTransition"], string> = {
  none: "",
  fade: "bs-page-fade",
  slide: "bs-page-slide",
  rise: "bs-page-rise",
  zoom: "bs-page-zoom",
};

function fill(text: string, profile: SiteRendererProfile, extra: Record<string, string> = {}): string {
  const map: Record<string, string> = {
    name: profile.name,
    headline: profile.headline ?? "",
    location: profile.location ?? "",
    bio: profile.bio ?? "",
    availability: profile.availability ?? "",
    ...extra,
  };
  return text.replace(/\{(name|headline|location|bio|availability|tagline)\}/g, (_, key: string) => map[key] ?? "");
}

// ------------------------------------------------------------------ fonts

/** Load exactly the families + weights this site uses (never the whole library).
 * Injection targets the document the renderer actually renders into — the
 * public page's document, or the studio's preview iframe document (the bundle
 * always executes in the parent window, so `document` alone is wrong there). */
function useSiteFonts(containerRef: React.RefObject<HTMLDivElement | null>, theme: ResolvedTheme): void {
  useEffect(() => {
    const doc = containerRef.current?.ownerDocument ?? document;
    ensureFontLoaded(doc, theme.headingFont, [HEADING_WEIGHT_NUM[theme.headingWeight], 700]);
    ensureFontLoaded(doc, theme.bodyFont, [400, 500, 600]);
    ensureFontLoaded(doc, theme.accentFont, [500, 600]);
    ensureFontLoaded(doc, theme.codeFont, [400, 600]);
    ensureFontLoaded(doc, theme.navFont, [400, 500]);
    ensureFontLoaded(doc, theme.buttonFont, [500, 600]);
  }, [containerRef, theme.headingFont, theme.bodyFont, theme.accentFont, theme.codeFont, theme.navFont, theme.buttonFont, theme.headingWeight]);
}

// ------------------------------------------------------------------ glass

/** Inline glass treatment for one target element (nav, card, button). */
function glassStyle(theme: ResolvedTheme, radiusPx?: string): React.CSSProperties {
  const g = theme.glass as SiteGlass;
  const bg = `color-mix(in srgb, ${g.tint} ${g.opacity}%, transparent)`;
  const border =
    g.borderWidth > 0
      ? `${g.borderWidth}px solid color-mix(in srgb, ${g.tint} ${Math.min(100, g.borderOpacity + 22)}%, transparent)`
      : undefined;
  const shadows: string[] = [];
  if (g.shadow > 0) shadows.push(`0 ${Math.round(g.shadow * 0.16)}px ${Math.round(g.shadow * 0.42)}px rgba(0, 0, 0, ${((g.shadow / 100) * 0.42).toFixed(2)})`);
  if (g.highlight > 0) shadows.push(`inset 0 1px 0 color-mix(in srgb, ${g.tint} ${Math.round(g.highlight * 0.55)}%, transparent)`);
  return {
    backgroundColor: bg,
    backgroundImage: g.gradient ? `linear-gradient(165deg, color-mix(in srgb, ${g.tint} 15%, transparent), transparent 56%)` : undefined,
    backdropFilter: `blur(${g.blur}px) saturate(1.35)`,
    WebkitBackdropFilter: `blur(${g.blur}px) saturate(1.35)`,
    border,
    boxShadow: shadows.length ? shadows.join(", ") : undefined,
    borderRadius: radiusPx,
  };
}

/** Global CSS: glass fallback for browsers without backdrop-filter. */
function glassFallbackCss(theme: ResolvedTheme): string {
  if (!theme.glass?.enabled) return "";
  const g = theme.glass;
  return `
@supports not ((backdrop-filter: blur(2px)) or (-webkit-backdrop-filter: blur(2px))) {
  .bean-site .bs-glass { background-color: color-mix(in srgb, ${g.tint} ${Math.min(94, g.opacity + 42)}%, ${theme.background}) !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
}`;
}

// ------------------------------------------------------------------ motion CSS

function useMotionCss(config: SiteConfig, motion: SiteMotion): string {
  return useMemo(() => {
    const presets = new Set<string>([motion.preset]);
    for (const page of config.pages) {
      for (const s of page.sections) {
        const o = s.motion;
        if (o?.preset && getMotionPreset(o.preset)) presets.add(o.preset);
      }
    }
    let css = baseMotionCss();
    for (const p of presets) css += revealPresetCss(p);
    css += microInteractionCss(motion.enabled && motion.hoverEffects ? motion.microInteractions : "none");
    css += backgroundMotionCss(motion.enabled ? motion.background : "bg-none");
    return css;
  }, [config.pages, motion]);
}

/** Scroll-triggered reveal with once/repeat behavior + a no-JS/missed-observer safety net. */
function useReveal(motion: SiteMotion) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !motion.enabled || !motion.scrollReveal || motion.preset === "none") {
      el.classList.add("bs-static", "bs-in");
      return;
    }
    // Safety net: content must never stay invisible if the observer misses.
    const failsafe = window.setTimeout(() => el.classList.add("bs-in"), Math.max(1200, motion.duration + 1600));
    let io: IntersectionObserver | null = null;
    if (motion.once) {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              el.classList.add("bs-in");
              io?.disconnect();
            }
          }
        },
        { threshold: 0.12 }
      );
    } else {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) el.classList.toggle("bs-in", e.isIntersecting);
        },
        { threshold: 0.08 }
      );
    }
    io.observe(el);
    return () => {
      window.clearTimeout(failsafe);
      io?.disconnect();
    };
  }, [motion]);
  return ref;
}

function Reveal({
  motion,
  children,
  className,
  style,
  stagger = false,
}: {
  motion: SiteMotion;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  stagger?: boolean;
}) {
  const ref = useReveal(motion);
  const presetDef = getMotionPreset(motion.preset);
  const animClass =
    !motion.enabled || motion.preset === "none" || presetDef?.parallax
      ? "bs-static"
      : cn("bs-reveal", `bs-r-${motion.preset}`);

  return (
    <div
      ref={ref}
      style={{
        ["--bs-dur" as string]: `${motion.duration}ms`,
        ["--bs-ease" as string]: easingCss(motion.easing),
        ["--bs-int" as string]: String(motion.intensity),
        ["--bs-stag" as string]: `${motion.stagger}ms`,
        ["--bs-delay" as string]: `${motion.delay}ms`,
        ...style,
      }}
      className={cn(animClass, stagger && "bs-stagger", className)}
    >
      {stagger
        ? Children.map(children, (child, i) =>
            child === null || child === undefined ? child : (
              <div className="bs-sh" style={{ ["--bs-i" as string]: i }}>
                {child}
              </div>
            )
          )
        : children}
    </div>
  );
}

function splitOf(motion: SiteMotion): "word" | "char" | null {
  return getMotionPreset(motion.preset)?.spec?.textSplit ?? null;
}

/** Screen-reader-safe split text for typography presets (words or characters). */
function SplitText({ text, motion }: { text: string; motion: SiteMotion }) {
  const split = splitOf(motion);
  if (!split) return <>{text}</>;
  const parts = split === "word" ? text.split(/(\s+)/) : Array.from(text);
  return (
    <>
      <span className="sr-only">{text}</span>
      {/* bs-split makes each word/char an inline-block so the per-preset
          transforms (rise/rotate/blur) actually apply — inline spans ignore
          transform, which previously reduced 11 typography presets to fades. */}
      <span aria-hidden="true" className="bs-split">
        {parts.map((p, i) =>
          /^\s+$/.test(p) ? (
            p
          ) : (
            <span key={`${p}-${i}`} className="bs-w" style={{ ["--bs-i" as string]: i }}>
              {p}
            </span>
          )
        )}
      </span>
    </>
  );
}

/** Restrained hero-cover parallax (±~24px), desktop widths only. */
function useParallax(enabled: boolean, intensity: number) {
  const ref = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const img = ref.current;
    if (!img || !enabled) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || window.innerWidth < 768) return;
    let raf = 0;
    const amount = Math.min(28, Math.max(6, (intensity / 100) * 28));
    const update = () => {
      raf = 0;
      const rect = img.parentElement?.getBoundingClientRect();
      if (!rect) return;
      const progress = Math.min(1, Math.max(0, 1 - rect.top / Math.max(1, window.innerHeight)));
      img.style.transform = `translateY(${(progress - 0.5) * amount * 2}px) scale(1.12)`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled, intensity]);
  return ref;
}

// ------------------------------------------------------------------ shared bits

function stacks(theme: ResolvedTheme) {
  return themeFontStacks(theme);
}

function border(theme: ResolvedTheme): string {
  return theme.divider === "none" ? "transparent" : theme.border;
}

function dividerStyle(theme: ResolvedTheme): React.CSSProperties {
  if (theme.divider === "accent") return { borderBottom: `2px solid ${theme.accent}` };
  if (theme.divider === "line") return { borderBottom: `1px solid color-mix(in srgb, ${theme.foreground} 16%, transparent)` };
  return {};
}

function cardStyle(theme: ResolvedTheme, opts: { elevated?: boolean; asGlass?: boolean } = {}): React.CSSProperties {
  const radius = RADIUS[theme.radius];
  if (opts.asGlass && theme.glass?.enabled && theme.glass) return glassStyle(theme, radius);
  const baseColor = opts.elevated ? mixHex(theme.surface, theme.foreground, 0.05) : theme.surface;
  return {
    background:
      theme.surfaceOpacity < 100
        ? `color-mix(in srgb, ${baseColor} ${theme.surfaceOpacity}%, transparent)`
        : baseColor,
    borderColor: theme.border,
    borderRadius: radius,
  };
}

function buttonClasses(theme: ResolvedTheme): string {
  return cn(
    "bs-btn bs-mi inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold",
    theme.buttonStyle === "outline" && "border bg-transparent"
  );
}

function buttonStyle(theme: ResolvedTheme): React.CSSProperties {
  // Button typeface is its own theme role — changing it never touches body,
  // nav or heading fonts (control isolation).
  return { ...buttonVisualStyle(theme), fontFamily: stacks(theme).button };
}

function buttonVisualStyle(theme: ResolvedTheme): React.CSSProperties {
  const glassOn = Boolean(theme.glass?.enabled && theme.glass.targets.buttons);
  const glass = glassOn ? glassStyle(theme, undefined) : null;
  if (glass) {
    switch (theme.buttonStyle) {
      case "sharp": return { ...glass, color: theme.foreground, borderRadius: "0px" };
      case "rounded": return { ...glass, color: theme.foreground, borderRadius: RADIUS[theme.radius] };
      case "pill": return { ...glass, color: theme.foreground, borderRadius: "9999px" };
      case "outline": return { ...glass, borderColor: theme.accent, color: theme.accent, borderRadius: RADIUS[theme.radius] };
    }
  }
  switch (theme.buttonStyle) {
    case "sharp": return { background: theme.accent, color: theme.background, borderRadius: "0px" };
    case "rounded": return { background: theme.accent, color: theme.background, borderRadius: RADIUS[theme.radius] };
    case "pill": return { background: theme.accent, color: theme.background, borderRadius: "9999px" };
    case "outline": return { borderColor: theme.accent, color: theme.accent, borderRadius: RADIUS[theme.radius] };
  }
}

function linkProps(theme: ResolvedTheme): React.CSSProperties {
  switch (theme.linkStyle) {
    case "underline": return { textDecorationLine: "underline", textUnderlineOffset: "3px" };
    case "accent": return { color: theme.accent };
    case "plain": return {};
  }
}

function SectionHeading({
  section, theme, motion,
}: {
  section: SiteSection;
  theme: ResolvedTheme;
  motion: SiteMotion;
}) {
  const scale = TYPE_SCALE[theme.typeScale];
  // Per-section style overrides (direct editing) — absent fields inherit the
  // site-wide theme. Scoped strictly to THIS section's heading.
  const style = section.style;
  const headingFontStack = style?.headingFont ? fontStack(style.headingFont) : stacks(theme).heading;
  const headingWeight = style?.headingWeight ? HEADING_WEIGHT_NUM[style.headingWeight] : HEADING_WEIGHT_NUM[theme.headingWeight];
  const align = style?.headingAlign ?? theme.headingAlign;
  return (
    <h2
      className={cn(scale.h2)}
      style={{
        fontWeight: headingWeight,
        letterSpacing: TRACKING[theme.letterSpacing],
        fontFamily: headingFontStack,
        fontSize: FLUID_H2[theme.typeScale],
        color: style?.titleColor || undefined,
        textAlign: align === "center" ? "center" : undefined,
      }}
    >
      <SplitText text={section.title} motion={motion} />
    </h2>
  );
}

function gridCols(theme: ResolvedTheme, fallback = "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"): string {
  if (theme.columns === 2) return "grid-cols-1 sm:grid-cols-2";
  if (theme.columns === 3) return "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
  return fallback;
}

/**
 * Per-section style band — background / spacing / width overrides.
 * Strictly scoped to THIS section: absent overrides render a plain
 * passthrough (zero layout change); an override here never touches any other
 * section. Backgrounds escape the centered content column full-bleed while
 * the section content keeps its column position.
 */
function SectionBand({
  section, theme, children,
}: {
  section: SiteSection;
  theme: ResolvedTheme;
  children: React.ReactNode;
}) {
  const st = section.style;
  const bg = st?.background && st.background !== "none" ? st.background : null;
  const spacing = st?.spacing ? SECTION_GAP[st.spacing] : null;
  const width = st?.width ? CONTENT_WIDTH[st.width] : null;
  if (!bg && spacing == null && !width) return <>{children}</>;
  const bandStyle: React.CSSProperties = {};
  if (bg) {
    bandStyle.background =
      bg === "surface" ? theme.surface
      : bg === "wash" ? `color-mix(in srgb, ${theme.accent} 8%, transparent)`
      : bg;
    bandStyle.marginLeft = "calc(50% - 50vw)";
    bandStyle.marginRight = "calc(50% - 50vw)";
    bandStyle.paddingLeft = "calc(50vw - 50%)";
    bandStyle.paddingRight = "calc(50vw - 50%)";
  }
  if (spacing != null) {
    bandStyle.paddingTop = spacing;
    bandStyle.paddingBottom = `calc(${spacing} * 0.35)`;
  }
  return (
    <div style={bandStyle} data-bs-band={section.id}>
      {width ? <div style={{ maxWidth: width, marginInline: "auto" }}>{children}</div> : children}
    </div>
  );
}

// ------------------------------------------------------------------ images

/** True only for a usable image URL — an empty/blank src must never reach an <img>. */
function hasImageSrc(src: string | null | undefined): src is string {
  return typeof src === "string" && src.trim().length > 0;
}

/** "Ada Lovelace" → "AL" — the graceful no-photo fallback for site avatars. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * The creator's real BEAN Folio profile picture, rendered in the standalone
 * website's hero — circular by default, professionally rounded when the
 * template's radius is "none". An initials tile always sits underneath, so a
 * missing photo (or a broken URL) degrades gracefully instead of showing a
 * broken image. The <img> is keyed by its src: when the creator updates
 * their BEAN Folio profile picture, a changed src remounts the element with
 * a clean error state — the live site always shows the CURRENT avatar
 * because the URL is resolved from profile data at request time.
 */
function SiteAvatar({
  src,
  name,
  theme,
  centered,
  size = 96,
}: {
  src: string | null | undefined;
  name: string;
  theme: ResolvedTheme;
  centered?: boolean;
  /** Rendered edge length in px (desktop); mobile scales to 64px via CSS. */
  size?: number;
}) {
  const rounded = theme.radius === "none" ? "18px" : "9999px";
  const initials = initialsOf(name);
  return (
    <div
      className={cn("bs-avatar relative mb-6 shrink-0", centered && "mx-auto")}
      style={{ width: size, height: size }}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 grid select-none place-items-center overflow-hidden"
        style={{
          borderRadius: rounded,
          background: `color-mix(in srgb, ${theme.accent} 16%, ${theme.background})`,
          color: theme.foreground,
          fontFamily: stacks(theme).heading,
          fontWeight: 600,
          fontSize: size * 0.34,
          letterSpacing: "0.02em",
        }}
      >
        {initials || "@"}
      </div>
      {hasImageSrc(src) ? (
        <img
          key={src}
          src={src}
          alt={`${name} — profile photo`}
          className="absolute inset-0 h-full w-full object-cover"
          style={{ borderRadius: rounded }}
          onError={(e) => {
            // Reveal the initials tile underneath; the src key above resets
            // this whenever the profile picture changes.
            e.currentTarget.style.display = "none";
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Cover image with a theme-aware fallback. If the cover is missing or blank,
 * a decorative monogram tile is rendered using the site's own theme tokens —
 * no <img> element at all, so no empty-src request and no console error.
 */
function SiteCoverImage({
  src, alt, title, theme, kind,
}: {
  src: string | null | undefined;
  alt: string;
  title: string;
  theme: ResolvedTheme;
  kind?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  if (!hasImageSrc(src) || failed) {
    const monogram = title.trim().charAt(0).toUpperCase() || "•";
    return (
      <div
        className="flex h-full w-full items-center justify-center"
        style={{
          background: `linear-gradient(145deg, color-mix(in srgb, ${theme.accent} 14%, ${theme.background}) 0%, ${theme.surface} 58%, ${theme.background} 100%)`,
        }}
        aria-hidden="true"
      >
        <span
          className="select-none leading-none"
          style={{
            color: theme.accent,
            opacity: 0.55,
            fontFamily: stacks(theme).heading,
            fontWeight: HEADING_WEIGHT_NUM[theme.headingWeight],
            letterSpacing: TRACKING[theme.letterSpacing],
            fontSize: "clamp(1.75rem, 5vw, 3.5rem)",
          }}
        >
          {monogram}
        </span>
      </div>
    );
  }
  if (kind === "VIDEO") {
    // Video covers render their first frame (muted, metadata-only) instead of
    // a broken <img> — playback happens on the project page.
    return (
      <video
        src={src}
        className="h-full w-full"
        style={{ objectFit: "cover" }}
        muted
        playsInline
        preload="metadata"
        onError={() => setFailed(true)}
        aria-label={alt}
      />
    );
  }
  return <img src={src} alt={alt} className="h-full w-full" style={{ objectFit: "cover" }} loading="lazy" />;
}

// ------------------------------------------------------------------ project cards

/**
 * The project-link rule for EVERY surface of the standalone website: project
 * links stay INSIDE the website (`#/site/<username>/projects/<id>` — the
 * website-native detail page) and never send visitors into the BEAN Folio
 * platform's `/p/<id>` experience. Falls back to the platform route only
 * when the profile somehow has no username (defensive — cannot normally
 * happen: usernames are claimed at onboarding).
 */
function siteProjectHref(profile: SiteRendererProfile, projectId: string): string {
  return publicSiteProjectHashUrl(profile.username, projectId) ?? `#/p/${projectId}`;
}

function SiteProjectCard({
  project, profile, theme, large, hoverZoom,
}: {
  project: ProjectCardDTO;
  profile: SiteRendererProfile;
  theme: ResolvedTheme;
  large?: boolean;
  hoverZoom: boolean;
}) {
  const featured = Boolean(large);
  return (
    <a
      href={siteProjectHref(profile, project.id)}
      className={cn("group block h-full overflow-hidden border", hoverZoom && "bs-hoverzoom")}
      style={cardStyle(theme)}
    >
      <div className="w-full overflow-hidden" style={{ aspectRatio: IMAGE_RATIO[theme.imageRatio] }}>
        <SiteCoverImage src={project.coverUrl} kind={project.coverKind} alt={project.title} title={project.title} theme={theme} />
      </div>
      <div className={cn("space-y-1", featured ? "p-5" : "p-4")}>
        <p className="text-[11px] uppercase tracking-[0.14em]" style={{ color: theme.muted, fontFamily: stacks(theme).accent }}>
          {categoryLabel(project.category)}
        </p>
        <h3
          className={cn("font-semibold leading-snug", featured ? "text-xl" : "text-base")}
          style={{ color: theme.accent, fontFamily: stacks(theme).heading }}
        >
          {project.title}
        </h3>
        {project.summary && <p className="line-clamp-2 text-sm" style={{ color: theme.muted }}>{project.summary}</p>}
      </div>
    </a>
  );
}

// ------------------------------------------------------------------ hero variants

function SiteHero({ section, config, profile, theme, motion }: { section: Extract<SiteSection, { type: "hero" }>; config: SiteConfig; profile: SiteRendererProfile; theme: ResolvedTheme; motion: SiteMotion }) {
  const scale = TYPE_SCALE[theme.typeScale];
  const isParallax = getMotionPreset(motion.preset)?.parallax === true;
  const parallaxRef = useParallax(motion.enabled && isParallax, motion.intensity);
  const variant: HeroVariant = section.variant ?? "classic";
  const subtitle = fill(section.subtitle, profile, { tagline: config.tagline });
  const showTagline = config.tagline && !section.subtitle.includes("{tagline}");
  // Hero cover: the config-level override (coverMediaId) wins when set;
  // otherwise the profile cover — identical fallback in the static export.
  const coverSrc = siteCoverSrc(config) ?? (hasImageSrc(profile.coverUrl) ? profile.coverUrl : null);
  // The creator's real profile picture (initials fallback inside) — shown
  // alongside the name in every hero variant.
  const avatar = <SiteAvatar src={profile.avatarUrl} name={profile.name} theme={theme} />;

  const headline = (
    <h1
      className={cn("max-w-3xl text-balance leading-[1.05]", scale.hero, variant === "centered" && "mx-auto text-center", variant === "split" && "max-w-none")}
      style={{
        fontWeight: section.style?.headingWeight ? HEADING_WEIGHT_NUM[section.style.headingWeight] : HEADING_WEIGHT_NUM[theme.headingWeight],
        letterSpacing: TRACKING[theme.letterSpacing],
        fontFamily: section.style?.headingFont ? fontStack(section.style.headingFont) : stacks(theme).heading,
        fontSize: FLUID_HERO[theme.typeScale],
        color: section.style?.titleColor || undefined,
      }}
    >
      <SplitText text={fill(section.title, profile, { tagline: config.tagline })} motion={motion} />
    </h1>
  );

  // CTA destination — user-configurable, sanitized (anchors + http(s) only;
  // javascript:/data:/vbscript: never render). Empty = the in-page contact anchor.
  const ctaHref = safeCtaHref(section.ctaHref) ?? "#bs-contact";
  const cta = section.ctaLabel ? (
    <a href={ctaHref} className={buttonClasses(theme)} style={buttonStyle(theme)}>
      {section.ctaLabel}
    </a>
  ) : null;

  if (variant === "cover" && coverSrc) {
    return (
      <section className="relative -mx-5 mb-4 overflow-hidden sm:-mx-8" style={{ minHeight: "min(72vh, 560px)" }}>
        <img
          ref={parallaxRef}
          src={coverSrc}
          alt={`${profile.name} cover`}
          className={cn("absolute inset-0 h-full w-full", motion.enabled && isParallax && "bs-parallax")}
          style={{ objectFit: "cover", objectPosition: `50% ${profile.coverPositionY}%`, transform: "scale(1.12)" }}
        />
        <div className="absolute inset-0" style={{ background: `linear-gradient(to top, ${theme.background} 8%, color-mix(in srgb, ${theme.background} 55%, transparent) 55%, transparent)` }} />
        <div className="relative mx-auto flex w-full max-w-6xl flex-col justify-end px-5 pb-14 pt-40 sm:px-8">
          {avatar}
          {headline}
          {subtitle && <p className="mt-4 max-w-2xl text-base opacity-85 sm:text-lg">{subtitle}</p>}
          {showTagline ? <p className="mt-3 text-sm uppercase tracking-[0.2em] opacity-60">{config.tagline}</p> : null}
          {cta && <div className="mt-6">{cta}</div>}
        </div>
      </section>
    );
  }

  if (variant === "split") {
    return (
      <section className="grid items-end gap-8 pt-14 sm:grid-cols-[1.2fr_1fr] sm:pt-20">
        <div>
          {avatar}
          {headline}
        </div>
        <div className="space-y-4 sm:pb-2">
          {subtitle && <p className="text-base opacity-80 sm:text-lg">{subtitle}</p>}
          {showTagline ? <p className="text-sm uppercase tracking-[0.2em] opacity-60">{config.tagline}</p> : null}
          {cta}
        </div>
      </section>
    );
  }

  return (
    <section className={cn("pt-14 sm:pt-20", variant === "centered" && "text-center")}>
      {coverSrc && variant !== "cover" && (
        // Banner strip at the platform-standard 2048:687 ratio (lib/banner.ts):
        // height stays proportional to width, object-fit:cover + focal point.
        <div className={cn("mb-8 w-full overflow-hidden", BANNER_ASPECT_CLASS)} style={{ borderRadius: theme.radius === "none" ? "0px" : "18px" }}>
          <img
            src={coverSrc}
            alt={`${profile.name} cover`}
            className="h-full w-full"
            style={{ objectFit: "cover", objectPosition: `50% ${profile.coverPositionY}%` }}
          />
        </div>
      )}
      {avatar}
      {headline}
      {subtitle && (
        <p className={cn("mt-4 max-w-2xl text-base opacity-75 sm:text-lg", variant === "centered" && "mx-auto")}>
          {subtitle}
        </p>
      )}
      {showTagline ? (
        <p className={cn("mt-3 text-sm uppercase tracking-[0.2em] opacity-60", variant === "centered" && "mx-auto")}>{config.tagline}</p>
      ) : null}
      {cta && <div className="mt-6">{cta}</div>}
    </section>
  );
}

// ------------------------------------------------------------------ background layer

function BackgroundLayer({ theme, motion }: { theme: ResolvedTheme; motion: SiteMotion }) {
  const bg = motion.enabled ? motion.background : "bg-none";
  if (bg === "bg-none" || !getMotionPreset(bg)) return null;
  const needsBlobs =
    bg === "bg-aurora-soft" || bg === "bg-aurora-vivid" || bg === "bg-float-soft" || bg === "bg-float-orbs";
  // Only the two gradient-drift presets render the THEME gradient inline; the
  // other presets paint their own accent-tinted canvas via CSS.
  const usesThemeGradient = bg === "bg-gradient-pan" || bg === "bg-gradient-hue";
  const themeGradient = theme.gradient
    ? `linear-gradient(${theme.gradient.angle}deg, ${theme.gradient.from}, ${theme.gradient.to})`
    : `linear-gradient(120deg, ${theme.background}, ${mixHex(theme.background, theme.accent, 0.1)})`;
  return (
    <div className="bs-bg-layer" aria-hidden="true" style={{ color: theme.accent }}>
      <div
        className={cn(!needsBlobs && "bs-bg-anim")}
        style={{
          position: "absolute",
          inset: 0,
          ...(usesThemeGradient ? { backgroundImage: themeGradient, backgroundSize: "260% 260%" } : {}),
        }}
      />
      {needsBlobs && (
        <>
          <div className="bs-bg-aurora-1" />
          {(bg === "bg-aurora-vivid" || bg === "bg-float-orbs") && <div className="bs-bg-aurora-2" />}
          {bg === "bg-aurora-vivid" && <div className="bs-bg-aurora-3" />}
          {(bg === "bg-float-soft" || bg === "bg-float-orbs") && <div className="bs-bg-blob-1" />}
          {bg === "bg-float-soft" && <div className="bs-bg-blob-2" />}
          {bg === "bg-float-orbs" && <div className="bs-bg-blob-3" />}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ scroll progress

/**
 * Thin reading-progress bar fixed to the top of the page (motion.scrollProgress).
 * Binds to the document the renderer actually renders into — the public page's
 * document, or the studio's preview iframe document (`ownerDocument`/`defaultView`,
 * never the parent `window`). rAF-throttled; honors prefers-reduced-motion.
 */
function ScrollProgress({ motion, theme, containerRef }: { motion: SiteMotion; theme: ResolvedTheme; containerRef: React.RefObject<HTMLDivElement | null> }) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const active = motion.enabled && motion.scrollProgress;
  useEffect(() => {
    if (!active) return;
    const bar = barRef.current;
    if (!bar) return;
    const doc = containerRef.current?.ownerDocument ?? document;
    const win = doc.defaultView ?? window;
    if (win.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const de = doc.documentElement;
      const max = de.scrollHeight - win.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, (win.scrollY || de.scrollTop || 0) / max)) : 0;
      bar.style.transform = `scaleX(${p})`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    win.addEventListener("scroll", onScroll, { passive: true });
    win.addEventListener("resize", onScroll);
    return () => {
      win.removeEventListener("scroll", onScroll);
      win.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, containerRef]);
  if (!active) return null;
  return (
    <div
      ref={barRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: "2px",
        background: theme.accent,
        transform: "scaleX(0)",
        transformOrigin: "0 50%",
        zIndex: 40,
        pointerEvents: "none",
      }}
    />
  );
}

// ------------------------------------------------------------------ masthead

function Masthead({
  theme, config, profile, navPages, activePageId, onPageChange, setInternalPage, glassOn,
}: {
  theme: ResolvedTheme;
  config: SiteConfig;
  profile: SiteRendererProfile;
  navPages: SitePage[];
  activePageId: string;
  onPageChange?: (pageId: string) => void;
  setInternalPage: (id: string) => void;
  glassOn: boolean;
}) {
  const stacked = theme.navLayout === "stacked";
  const centered = theme.navLayout === "centered";
  const glass = glassOn && theme.glass?.targets.nav ? glassStyle(theme, "14px") : null;
  // Branding logo (optional) — uploaded media or the built-in BEAN Folio mark.
  const logoSrc = siteLogoSrc(config);
  return (
    <header
      className={cn(
        "flex flex-wrap items-baseline justify-between gap-3 pb-6",
        (stacked || centered) && "flex-col items-stretch gap-2",
        centered && "items-center text-center",
        glass && "bs-glass -mx-2 mb-5 mt-2 px-4 py-3 sm:-mx-4 sm:px-5"
      )}
      style={{
        // Glass carries its own full border; otherwise only a bottom divider —
        // never mix the border shorthand with borderTop (React warning).
        ...(glass ? glass : { ...dividerStyle(theme), borderTop: "none" }),
      }}
    >
      <p className={cn("flex items-center gap-2.5 text-lg font-semibold tracking-tight", centered && "mx-auto")} style={{ fontFamily: stacks(theme).heading }}>
        {logoSrc && (
          // Branding logo — optional, aspect ratio preserved (h-auto w-auto
          // within a fixed height band); never stretched, cropped or recolored.
          // Fallback to the text name on load errors via onError.
          <img
            src={logoSrc}
            alt={`${config.name} logo`}
            className="block h-9 w-auto max-w-[180px] object-contain sm:h-10"
            style={{ borderRadius: "4px" }}
            onError={(e) => {
              const img = e.currentTarget;
              // Hide the broken image but keep the accessible name text.
              img.style.display = "none";
            }}
          />
        )}
        <span className={logoSrc ? "sr-only" : undefined}>{config.name}</span>
      </p>
      <nav
        aria-label="Site pages"
        className={cn("flex flex-wrap items-center gap-4", stacked && "justify-start", centered && "justify-center")}
      >
        {navPages.length > 1 &&
          navPages.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => (onPageChange ? onPageChange(p.id) : setInternalPage(p.id))}
              className="bs-mi text-sm transition-colors hover:opacity-80"
              style={{
                fontFamily: stacks(theme).nav,
                ...(theme.linkStyle === "accent" ? { color: p.id === activePageId ? theme.accent : theme.foreground } : {}),
                opacity: p.id === activePageId ? 1 : 0.65,
                textDecorationLine: p.id === activePageId && theme.linkStyle === "underline" ? "underline" : "none",
                textUnderlineOffset: "4px",
              }}
              aria-current={p.id === activePageId ? "page" : undefined}
            >
              {p.name}
            </button>
          ))}
        <span className="text-sm opacity-70" style={{ fontFamily: stacks(theme).code }}>@{profile.username ?? profile.name}</span>
      </nav>
    </header>
  );
}

// ------------------------------------------------------------------ main renderer

export function SiteRenderer({ config, profile, projects, collections, onContact, contactHref, watermark = true, pageId, onPageChange, interactiveSelection }: SiteRendererProps) {
  const theme = useMemo(() => deriveTheme(config.theme), [config.theme]);
  // Defensive: legacy/stored configs may predate the pages & motion schema —
  // render them with defaults instead of crashing (see file header contract).
  const motion = config.motion ?? defaultMotion();
  const rootRef = useRef<HTMLDivElement | null>(null);
  useSiteFonts(rootRef, theme);
  const interactive = Boolean(interactiveSelection);

  // Per-section heading font overrides (direct editing): load each referenced
  // family into the rendering document so section-scoped fonts actually draw.
  useEffect(() => {
    if (!interactive) return;
    const doc = rootRef.current?.ownerDocument ?? document;
    for (const page of config.pages) {
      for (const s of page.sections) {
        if (s.style?.headingFont) ensureFontLoaded(doc, s.style.headingFont, [400, 600, 700]);
      }
    }
  }, [config.pages, interactive]);

  const pages = (config.pages?.length ?? 0) > 0 ? config.pages : [{ id: "home", name: "Home", visible: true, sections: [] } as SitePage];
  // The landing page is the first VISIBLE page (hidden pages are nav-less and
  // unreachable on the live site) — never a hidden pages[0].
  const [internalPage, setInternalPage] = useState<string>(() => homePage({ ...config, pages })?.id ?? pages[0]?.id ?? "home");
  const activePageId = pageId ?? internalPage;
  const page = pages.find((p) => p.id === activePageId) ?? (config.pages?.length ? homePage(config) : null) ?? pages[0];
  const sections = (page?.sections ?? []).filter((s) => s && typeof s === "object" && s.visible !== false);
  const navPages = pages.filter((p) => p.visible !== false);

  const hoverZoom = motion.enabled && motion.hoverEffects;
  const contentMax = CONTENT_WIDTH[theme.contentWidth];
  const motionCss = useMotionCss(config, motion);
  const glassOn = Boolean(theme.glass?.enabled);

  const sectionClass: React.CSSProperties = { paddingTop: SECTION_GAP[theme.density] };
  const gapStyle: React.CSSProperties = { gap: GRID_GAP[theme.density] };

  const bgMotion = motion.enabled ? motion.background : "bg-none";

  // Studio-only direct-selection affordances. The classes below are applied
  // exclusively in interactive mode (the builder) — public/published sites
  // never render .bs-selectable, so the live website's appearance is unchanged.
  const selectionCss = `
.bean-site .bs-selectable { outline: 1px dashed transparent; outline-offset: 6px; border-radius: 8px; cursor: pointer; transition: outline-color 140ms ease; }
.bean-site .bs-selectable:hover { outline-color: color-mix(in srgb, var(--site-accent, #d4af6a) 45%, transparent); }
.bean-site .bs-selectable.bs-selected { outline: 1.5px solid color-mix(in srgb, var(--site-accent, #d4af6a) 80%, transparent); }
@media (prefers-reduced-motion: reduce) { .bean-site .bs-selectable { transition: none; } }
/* Hero avatar scales down gracefully on small screens (inline size stays desktop). */
@media (max-width: 639px) { .bean-site .bs-avatar { width: 64px !important; height: 64px !important; margin-bottom: 1rem !important; } .bean-site .bs-avatar div { font-size: 22px !important; } }`;

  return (
    <div
      ref={rootRef}
      className="bean-site min-h-full w-full overflow-x-hidden"
      style={{
        background: theme.gradient
          ? `linear-gradient(${theme.gradient.angle}deg, ${theme.gradient.from}, ${theme.gradient.to})`
          : theme.background,
        color: theme.foreground,
        fontFamily: stacks(theme).body,
        lineHeight: LINE_HEIGHT[theme.lineHeight],
        ["--bs-ease" as string]: easingCss(motion.easing),
        ["--site-accent" as string]: theme.accent,
        ["--site-accent2" as string]: theme.accent2,
        ["--site-focus" as string]: theme.focus,
        ["--site-radius" as string]: RADIUS[theme.radius],
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: motionCss + glassFallbackCss(theme) + selectionCss }} />

      <ScrollProgress motion={motion} theme={theme} containerRef={rootRef} />

      <BackgroundLayer theme={theme} motion={motion} />

      <div className={cn("mx-auto w-full px-5 sm:px-8", bgMotion !== "bg-none" && "bs-content")} style={{ maxWidth: contentMax, paddingTop: "2.5rem", paddingBottom: DENSITY_GAP[theme.density] }}>
        <Masthead
          theme={theme}
          config={config}
          profile={profile}
          navPages={navPages}
          activePageId={activePageId}
          onPageChange={onPageChange}
          setInternalPage={setInternalPage}
          glassOn={glassOn}
        />

        {/* page body (transition applied on page switch) */}
        <div key={page?.id ?? "home"} className={cn(motion.enabled && PAGE_TRANSITION_CLASS[theme.pageTransition])}>
          {sections.map((section) => {
            const m = sectionMotion(motion, section);
            const rendered = (() => {
              switch (section.type) {
              case "hero":
                return (
                  <Reveal key={section.id} motion={m}>
                    <SiteHero section={section} config={config} profile={profile} theme={theme} motion={m} />
                  </Reveal>
                );

              case "about":
                return (
                  <section key={section.id} className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      <p className="mt-4 max-w-3xl whitespace-pre-wrap text-[15px] opacity-85 sm:text-base">
                        {fill(section.body, profile) || "This creator hasn't written an about section yet."}
                      </p>
                    </Reveal>
                  </section>
                );

              case "stats":
                return (
                  <section key={section.id} className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      <Reveal motion={m} stagger className="mt-5 grid grid-cols-3" style={gapStyle}>
                        {(
                          [
                            { label: "Projects", value: profile.stats.projects },
                            { label: "Followers", value: profile.stats.followers },
                            { label: "Following", value: profile.stats.following },
                          ] as const
                        ).map((s) => (
                          <div key={s.label} className="border p-4" style={cardStyle(theme, { elevated: true, asGlass: glassOn && theme.glass!.targets.cards })}>
                            <p className="text-xs uppercase tracking-wide" style={{ color: theme.muted, fontFamily: stacks(theme).accent }}>{s.label}</p>
                            <p className="mt-1 text-2xl font-semibold" style={{ color: theme.accent, fontFamily: stacks(theme).code }}>{s.value}</p>
                          </div>
                        ))}
                      </Reveal>
                    </Reveal>
                  </section>
                );

              case "projects": {
                const filtered = section.category ? projects.filter((p) => (p.category ?? "") === section.category) : projects;
                const list = filtered.slice(0, section.limit);
                const featured = section.layout === "featured" && list.length > 0;
                return (
                  <section key={section.id} className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      {list.length === 0 ? (
                        <p className="mt-4 text-sm" style={{ color: theme.muted }}>No published projects yet — check back soon.</p>
                      ) : section.layout === "list" ? (
                        <ul className="mt-5 divide-y" style={{ borderColor: border(theme) }}>
                          {list.map((p) => (
                            <li key={p.id} style={{ borderColor: border(theme) }}>
                              <a href={siteProjectHref(profile, p.id)} className="flex items-baseline justify-between gap-4 py-3 transition-opacity hover:opacity-80">
                                <span className="font-semibold" style={{ color: theme.accent }}>{p.title}</span>
                                <span className="shrink-0 text-xs uppercase tracking-wide" style={{ color: theme.muted }}>{categoryLabel(p.category)}</span>
                              </a>
                            </li>
                          ))}
                        </ul>
                      ) : section.layout === "editorial" ? (
                        <div className="mt-5 space-y-10">
                          {list.map((p, i) => (
                            <Reveal key={p.id} motion={m}>
                              <a
                                href={siteProjectHref(profile, p.id)}
                                className={cn("group grid items-center gap-6 sm:grid-cols-2", i % 2 === 1 && "sm:[&>div:first-child]:order-2", hoverZoom && "bs-hoverzoom")}
                              >
                                <div className="overflow-hidden" style={{ aspectRatio: IMAGE_RATIO[theme.imageRatio], borderRadius: RADIUS[theme.radius] }}>
                                  <SiteCoverImage src={p.coverUrl} kind={p.coverKind} alt={p.title} title={p.title} theme={theme} />
                                </div>
                                <div>
                                  <p className="text-[11px] uppercase tracking-[0.14em]" style={{ color: theme.muted, fontFamily: stacks(theme).accent }}>{categoryLabel(p.category)}</p>
                                  <h3 className="mt-1 text-2xl font-semibold" style={{ color: theme.accent, fontFamily: stacks(theme).heading }}>{p.title}</h3>
                                  {p.summary && <p className="mt-2 text-sm" style={{ color: theme.muted }}>{p.summary}</p>}
                                </div>
                              </a>
                            </Reveal>
                          ))}
                        </div>
                      ) : featured ? (
                        <div className="mt-5 space-y-6">
                          <Reveal motion={m}>
                            <SiteProjectCard project={list[0]} profile={profile} theme={theme} large hoverZoom={hoverZoom} />
                          </Reveal>
                          {list.length > 1 && (
                            <Reveal motion={m} stagger className={gridCols(theme, "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3")} style={gapStyle}>
                              {list.slice(1).map((p) => (
                                <SiteProjectCard key={p.id} project={p} profile={profile} theme={theme} hoverZoom={hoverZoom} />
                              ))}
                            </Reveal>
                          )}
                        </div>
                      ) : (
                        <Reveal motion={m} stagger className={cn("mt-5 grid", gridCols(theme))} style={gapStyle}>
                          {list.map((p) => (
                            <SiteProjectCard key={p.id} project={p} profile={profile} theme={theme} hoverZoom={hoverZoom} />
                          ))}
                        </Reveal>
                      )}
                    </Reveal>
                  </section>
                );
              }

              case "skills":
                return (
                  <section key={section.id} className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      {profile.skills.length === 0 ? (
                        <p className="mt-4 text-sm" style={{ color: theme.muted }}>No skills listed yet.</p>
                      ) : (
                        <Reveal motion={m} stagger className="mt-4 flex flex-wrap gap-2">
                          {profile.skills.map((s) => (
                            <span key={s} className="border px-3 py-1 text-sm" style={{ borderColor: theme.border, borderRadius: RADIUS[theme.radius] }}>
                              {s}
                            </span>
                          ))}
                        </Reveal>
                      )}
                    </Reveal>
                  </section>
                );

              case "collections": {
                const list = collections.slice(0, section.limit);
                return (
                  <section key={section.id} className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      {list.length === 0 ? (
                        <p className="mt-4 text-sm" style={{ color: theme.muted }}>No public collections yet.</p>
                      ) : (
                        <Reveal motion={m} stagger className={cn("mt-5 grid", gridCols(theme, "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"))} style={gapStyle}>
                          {list.map((c) => (
                            <div key={c.id} className="border p-4" style={cardStyle(theme, { asGlass: glassOn && theme.glass!.targets.cards })}>
                              <p className="font-semibold" style={{ fontFamily: stacks(theme).heading }}>{c.name}</p>
                              {c.description && <p className="mt-1 line-clamp-2 text-sm" style={{ color: theme.muted }}>{c.description}</p>}
                              <p className="mt-3 text-xs uppercase tracking-wide" style={{ color: theme.muted, fontFamily: stacks(theme).code }}>
                                {c.items.length} {c.items.length === 1 ? "project" : "projects"}
                              </p>
                            </div>
                          ))}
                        </Reveal>
                      )}
                    </Reveal>
                  </section>
                );
              }

              case "services": {
                const items = section.items.filter((i) => i.title.trim());
                return (
                  <section key={section.id} className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      {items.length === 0 ? (
                        <p className="mt-4 text-sm" style={{ color: theme.muted }}>Services will appear here once added.</p>
                      ) : section.layout === "rows" ? (
                        <ul className="mt-5 divide-y" style={{ borderColor: border(theme) }}>
                          {items.map((it, i) => (
                            <li key={i} className="flex items-baseline gap-4 py-4" style={{ borderColor: border(theme) }}>
                              <span className="text-sm font-semibold" style={{ color: theme.accent2 }}>{String(i + 1).padStart(2, "0")}</span>
                              <div>
                                <p className="font-semibold">{it.title}</p>
                                {it.description && <p className="mt-1 text-sm" style={{ color: theme.muted }}>{it.description}</p>}
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <Reveal motion={m} stagger className={cn("mt-5 grid", gridCols(theme, "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"))} style={gapStyle}>
                          {items.map((it, i) => (
                            <div key={i} className="border p-5" style={cardStyle(theme, { asGlass: glassOn && theme.glass!.targets.cards })}>
                              <p className="font-semibold" style={{ fontFamily: stacks(theme).heading, color: theme.accent }}>{it.title}</p>
                              {it.description && <p className="mt-2 text-sm" style={{ color: theme.muted }}>{it.description}</p>}
                            </div>
                          ))}
                        </Reveal>
                      )}
                    </Reveal>
                  </section>
                );
              }

              case "experience": {
                const entries = section.entries.filter((e) => e.role.trim());
                return (
                  <section key={section.id} className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      {entries.length === 0 ? (
                        <p className="mt-4 text-sm" style={{ color: theme.muted }}>Experience entries will appear here once added.</p>
                      ) : section.layout === "rows" ? (
                        <ul className="mt-5 divide-y" style={{ borderColor: border(theme) }}>
                          {entries.map((e, i) => (
                            <li key={i} className="py-4" style={{ borderColor: border(theme) }}>
                              <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <p className="font-semibold">{e.role}{e.org ? ` · ${e.org}` : ""}</p>
                                {e.period && <p className="text-xs uppercase tracking-wide" style={{ color: theme.muted, fontFamily: stacks(theme).code }}>{e.period}</p>}
                              </div>
                              {e.description && <p className="mt-1 text-sm" style={{ color: theme.muted }}>{e.description}</p>}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <ol className="mt-6 space-y-6 border-l-2 pl-6" style={{ borderColor: theme.border }}>
                          {entries.map((e, i) => (
                            <li key={i} className="relative">
                              <span className="absolute -left-[31px] top-1.5 size-2.5 rounded-full" style={{ background: theme.accent2 }} aria-hidden />
                              <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <p className="font-semibold">{e.role}{e.org ? ` · ${e.org}` : ""}</p>
                                {e.period && <p className="text-xs uppercase tracking-wide" style={{ color: theme.muted, fontFamily: stacks(theme).code }}>{e.period}</p>}
                              </div>
                              {e.description && <p className="mt-1 text-sm" style={{ color: theme.muted }}>{e.description}</p>}
                            </li>
                          ))}
                        </ol>
                      )}
                    </Reveal>
                  </section>
                );
              }

              case "gallery": {
                const src =
                  section.source === "collections"
                    ? collections.flatMap((c) => c.items)
                    : projects;
                const shots = src.filter((p) => hasImageSrc(p.coverUrl)).slice(0, section.limit);
                return (
                  <section key={section.id} className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      {shots.length === 0 ? (
                        <p className="mt-4 text-sm" style={{ color: theme.muted }}>No images to show yet.</p>
                      ) : section.layout === "strip" ? (
                        <Reveal motion={m}>
                          <ul className="mt-5 flex snap-x gap-4 overflow-x-auto pb-2" style={{ scrollbarWidth: "thin" }}>
                            {shots.map((p) => (
                              <li key={p.id} className="w-64 shrink-0 snap-start overflow-hidden sm:w-80" style={{ borderRadius: RADIUS[theme.radius] }}>
                                <a href={siteProjectHref(profile, p.id)} className={cn("block", hoverZoom && "bs-hoverzoom")} style={{ aspectRatio: IMAGE_RATIO[theme.imageRatio] }}>
                                  <SiteCoverImage src={p.coverUrl} kind={p.coverKind} alt={p.title} title={p.title} theme={theme} />
                                </a>
                              </li>
                            ))}
                          </ul>
                        </Reveal>
                      ) : section.layout === "masonry" ? (
                        <Reveal motion={m} stagger className="mt-5 columns-2 gap-4 sm:columns-3 [&>*]:mb-4">
                          {shots.map((p) => (
                            <a key={p.id} href={siteProjectHref(profile, p.id)} className={cn("block break-inside-avoid overflow-hidden", hoverZoom && "bs-hoverzoom")} style={{ borderRadius: RADIUS[theme.radius] }}>
                              <SiteCoverImage src={p.coverUrl} kind={p.coverKind} alt={p.title} title={p.title} theme={theme} />
                            </a>
                          ))}
                        </Reveal>
                      ) : (
                        <Reveal motion={m} stagger className={cn("mt-5 grid", gridCols(theme))} style={gapStyle}>
                          {shots.map((p) => (
                            <a key={p.id} href={siteProjectHref(profile, p.id)} className={cn("block overflow-hidden", hoverZoom && "bs-hoverzoom")} style={{ aspectRatio: IMAGE_RATIO[theme.imageRatio], borderRadius: RADIUS[theme.radius] }}>
                              <SiteCoverImage src={p.coverUrl} kind={p.coverKind} alt={p.title} title={p.title} theme={theme} />
                            </a>
                          ))}
                        </Reveal>
                      )}
                    </Reveal>
                  </section>
                );
              }

              case "testimonials": {
                const items = section.items.filter((i) => i.quote.trim() && i.name.trim());
                return (
                  <section key={section.id} className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      {items.length === 0 ? (
                        <p className="mt-4 text-sm" style={{ color: theme.muted }}>Genuine client quotes will appear here once added.</p>
                      ) : section.layout === "stack" ? (
                        <div className="mt-6 space-y-8">
                          {items.map((t, i) => (
                            <Reveal key={i} motion={m}>
                              <blockquote>
                                <p className="text-xl leading-relaxed" style={{ fontFamily: stacks(theme).heading }}>
                                  <span aria-hidden="true" style={{ color: theme.accent2 }}>“</span>
                                  {t.quote}
                                  <span aria-hidden="true" style={{ color: theme.accent2 }}>”</span>
                                </p>
                                <footer className="mt-2 text-sm" style={{ color: theme.muted, fontFamily: stacks(theme).accent }}>
                                  — {t.name}{t.role ? `, ${t.role}` : ""}
                                </footer>
                              </blockquote>
                            </Reveal>
                          ))}
                        </div>
                      ) : (
                        <Reveal motion={m} stagger className={cn("mt-5 grid", gridCols(theme, "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"))} style={gapStyle}>
                          {items.map((t, i) => (
                            <figure key={i} className="border p-5" style={cardStyle(theme, { asGlass: glassOn && theme.glass!.targets.cards })}>
                              <blockquote className="text-sm leading-relaxed">“{t.quote}”</blockquote>
                              <figcaption className="mt-3 text-xs uppercase tracking-wide" style={{ color: theme.muted, fontFamily: stacks(theme).accent }}>
                                {t.name}{t.role ? ` · ${t.role}` : ""}
                              </figcaption>
                            </figure>
                          ))}
                        </Reveal>
                      )}
                    </Reveal>
                  </section>
                );
              }

              case "process": {
                const steps = section.items.filter((it) => it.title.trim());
                return (
                  <section key={section.id} className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      {steps.length === 0 ? (
                        <p className="mt-4 text-sm" style={{ color: theme.muted }}>Process steps will appear here once added.</p>
                      ) : section.layout === "steps" ? (
                        <ol className="mt-6 space-y-6 border-l-2 pl-6" style={{ borderColor: theme.border }}>
                          {steps.map((it, i) => (
                            <li key={i} className="relative">
                              <span
                                className="absolute -left-[37px] flex size-6 items-center justify-center rounded-full text-xs font-semibold"
                                style={{ background: theme.accent, color: theme.background }}
                              >
                                {i + 1}
                              </span>
                              <p className="font-semibold">{it.title}</p>
                              {it.description && <p className="mt-1 text-sm" style={{ color: theme.muted }}>{it.description}</p>}
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <Reveal motion={m} stagger className={cn("mt-5 grid", gridCols(theme))} style={gapStyle}>
                          {steps.map((it, i) => (
                            <div key={i} className="border p-5" style={cardStyle(theme, { asGlass: glassOn && theme.glass!.targets.cards })}>
                              {section.layout === "numbers" && (
                                <p className="text-2xl font-semibold" style={{ color: theme.accent, fontFamily: stacks(theme).code }}>
                                  {String(i + 1).padStart(2, "0")}
                                </p>
                              )}
                              <p
                                className="font-semibold"
                                style={{ fontFamily: stacks(theme).heading, color: section.layout === "grid" ? theme.accent : undefined }}
                              >
                                {it.title}
                              </p>
                              {it.description && <p className="mt-2 text-sm" style={{ color: theme.muted }}>{it.description}</p>}
                            </div>
                          ))}
                        </Reveal>
                      )}
                    </Reveal>
                  </section>
                );
              }

              case "faq": {
                const items = section.items.filter((it) => it.question.trim());
                return (
                  <section key={section.id} className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      {items.length === 0 ? (
                        <p className="mt-4 text-sm" style={{ color: theme.muted }}>Questions will appear here once added.</p>
                      ) : (
                        <div className="mt-5 divide-y" style={{ borderColor: border(theme) }}>
                          {items.map((it, i) => (
                            <details key={i} className="group py-4" style={{ borderColor: border(theme) }}>
                              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold [&::-webkit-details-marker]:hidden">
                                <span>{it.question}</span>
                                <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
                              </summary>
                              {it.answer && <p className="mt-3 text-sm" style={{ color: theme.muted }}>{it.answer}</p>}
                            </details>
                          ))}
                        </div>
                      )}
                    </Reveal>
                  </section>
                );
              }

              case "pricing": {
                const tiers = section.tiers.filter((t) => t.name.trim());
                // Static Tailwind classes only — tier count picks the widest grid.
                const tierCols =
                  tiers.length === 1
                    ? "grid-cols-1"
                    : tiers.length === 2
                      ? "grid-cols-1 sm:grid-cols-2"
                      : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
                return (
                  <section key={section.id} className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      {tiers.length === 0 ? (
                        <p className="mt-4 text-sm" style={{ color: theme.muted }}>Pricing tiers will appear here once added.</p>
                      ) : section.layout === "rows" ? (
                        <ul className="mt-5 divide-y" style={{ borderColor: border(theme) }}>
                          {tiers.map((tier, i) => (
                            <li key={i} className="py-4" style={{ borderColor: border(theme) }}>
                              <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <p className="font-semibold" style={{ fontFamily: stacks(theme).heading }}>{tier.name}</p>
                                {(tier.price || tier.period) && (
                                  <p className="text-sm" style={{ color: theme.muted, fontFamily: stacks(theme).code }}>
                                    {tier.price}{tier.period ? ` ${tier.period}` : ""}
                                  </p>
                                )}
                              </div>
                              {tier.description && <p className="mt-1 text-sm" style={{ color: theme.muted }}>{tier.description}</p>}
                              {tier.features.some((f) => f.trim()) && (
                                <ul className="mt-2 space-y-1">
                                  {tier.features.filter((f) => f.trim()).map((f, j) => (
                                    <li key={j} className="flex items-start gap-2 text-sm">
                                      <Check className="mt-0.5 size-3.5 shrink-0" style={{ color: theme.accent }} aria-hidden />
                                      <span>{f}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <Reveal motion={m} stagger className={cn("mt-5 grid", tierCols)} style={gapStyle}>
                          {tiers.map((tier, i) => (
                            <div
                              key={i}
                              className="relative border p-5"
                              style={{
                                ...cardStyle(theme, { asGlass: glassOn && theme.glass!.targets.cards }),
                                // Highlighted tier: accent ring treatment — never
                                // fabricated marketing copy, just a color signal.
                                ...(tier.highlighted
                                  ? { borderColor: theme.accent, background: `color-mix(in srgb, ${theme.accent} 7%, transparent)` }
                                  : {}),
                              }}
                            >
                              {tier.highlighted && (
                                <span className="absolute right-3 top-3 size-2 rounded-full" style={{ background: theme.accent }} role="img" aria-label="Highlighted tier" />
                              )}
                              <p className="font-semibold" style={{ fontFamily: stacks(theme).heading }}>{tier.name}</p>
                              {tier.price && (
                                <p className="mt-2 text-3xl font-semibold" style={{ color: theme.accent, fontFamily: stacks(theme).heading }}>{tier.price}</p>
                              )}
                              {tier.period && (
                                <p className="mt-1 text-sm" style={{ color: theme.muted, fontFamily: stacks(theme).code }}>{tier.period}</p>
                              )}
                              {tier.description && <p className="mt-2 text-sm" style={{ color: theme.muted }}>{tier.description}</p>}
                              {tier.features.some((f) => f.trim()) && (
                                <ul className="mt-3 space-y-1.5">
                                  {tier.features.filter((f) => f.trim()).map((f, j) => (
                                    <li key={j} className="flex items-start gap-2 text-sm">
                                      <Check className="mt-0.5 size-3.5 shrink-0" style={{ color: theme.accent }} aria-hidden />
                                      <span>{f}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {tier.ctaLabel && (
                                <div className="mt-4">
                                  <a href="#bs-contact" className={buttonClasses(theme)} style={buttonStyle(theme)}>
                                    {tier.ctaLabel}
                                  </a>
                                </div>
                              )}
                            </div>
                          ))}
                        </Reveal>
                      )}
                    </Reveal>
                  </section>
                );
              }

              case "logos": {
                const names = section.items.map((it) => it.name.trim()).filter(Boolean);
                const chipStyle: React.CSSProperties = {
                  borderColor: theme.border,
                  borderRadius: RADIUS[theme.radius],
                  color: theme.muted,
                  fontFamily: stacks(theme).accent,
                };
                const chips = names.length
                  ? names.map((name, i) => (
                      <span key={i} className="border px-4 py-2 text-sm uppercase tracking-[0.14em]" style={chipStyle}>
                        {name}
                      </span>
                    ))
                  : [0, 1, 2, 3].map((i) => (
                      <span
                        key={i}
                        role="img"
                        aria-label="Placeholder — add real client names"
                        className="border px-4 py-2 text-sm uppercase tracking-[0.14em]"
                        style={{ ...chipStyle, borderStyle: "dashed", opacity: 0.6 }}
                      >
                        Client logo
                      </span>
                    ));
                return (
                  <section key={section.id} className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      {section.note && <p className="mt-2 text-sm" style={{ color: theme.muted }}>{section.note}</p>}
                      <Reveal motion={m} stagger className="mt-5 flex flex-wrap gap-3">{chips}</Reveal>
                      {names.length === 0 && (
                        <p className="mt-3 text-xs" style={{ color: theme.muted }}>
                          Placeholder tiles — the real client names will replace these. GIFTZ never invents clients.
                        </p>
                      )}
                    </Reveal>
                  </section>
                );
              }

              case "contact":
                return (
                  <section key={section.id} id="bs-contact" className="pt-14 sm:pt-20" style={sectionClass}>
                    <Reveal motion={m}>
                      <SectionHeading section={section} theme={theme} motion={m} />
                      {fill(section.body, profile) && (
                        <p className="mt-3 max-w-2xl text-[15px] opacity-85">{fill(section.body, profile)}</p>
                      )}
                      <div className="mt-5 flex flex-wrap items-center gap-3">
                        {onContact ? (
                          <button type="button" onClick={onContact} className={buttonClasses(theme)} style={buttonStyle(theme)}>
                            <Mail className="size-4" aria-hidden /> Contact {profile.name.split(" ")[0]}
                          </button>
                        ) : contactHref ? (
                          <a
                            href={contactHref}
                            className={buttonClasses(theme)}
                            style={buttonStyle(theme)}
                          >
                            <Mail className="size-4" aria-hidden /> Contact {profile.name.split(" ")[0]}
                          </a>
                        ) : null}
                        {profile.contactEmail && (
                          <a
                            href={`mailto:${profile.contactEmail}`}
                            className="bs-mi inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
                            style={linkProps(theme)}
                          >
                            <Mail className="size-4" aria-hidden /> {profile.contactEmail}
                          </a>
                        )}
                        {profile.websiteUrl && (
                          <a
                            href={profile.websiteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="bs-mi inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
                            style={linkProps(theme)}
                          >
                            <Globe className="size-4" aria-hidden /> {profile.websiteUrl.replace(/^https?:\/\//, "")}
                          </a>
                        )}
                        {profile.location && (
                          <span className="inline-flex items-center gap-1.5 text-sm opacity-70">
                            <MapPin className="size-4" aria-hidden /> {profile.location}
                          </span>
                        )}
                      </div>
                    </Reveal>
                  </section>
                );

              default:
                return null;
            }
            })();

            if (!rendered) return rendered;
            // Per-section style band (background/spacing/width) — always
            // applied, inside or outside the studio's selection wrapper.
            // Keyed here because the non-interactive path returns it directly.
            const banded = <SectionBand key={section.id} section={section} theme={theme}>{rendered}</SectionBand>;
            if (!interactive) return banded;
            const selected = interactiveSelection!.selectedSectionId === section.id;
            return (
              <div
                key={section.id}
                data-bs-section-id={section.id}
                data-bs-section-type={section.type}
                // Studio-only direct selection: prevent inner link navigation
                // and report the owning section to the builder.
                onClick={(e) => {
                  e.preventDefault();
                  interactiveSelection!.onSelectSection(section.id);
                }}
                className={cn("bs-selectable", selected && "bs-selected")}
              >
                {banded}
              </div>
            );
          })}
        </div>

        <footer
          className="mt-20 pt-6 text-xs opacity-70"
          style={{ borderTop: theme.divider === "none" ? "none" : `1px solid ${theme.border}` }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Creator branding stays first and dominant. */}
            <span>
              {config.name} · {profile.name}
            </span>
            {watermark && (
              <span aria-label="Made with BEAN Folio · GIFTZ">
                Made with{" "}
                <a
                  href="#/"
                  className="underline-offset-4 transition-colors hover:underline"
                  title="Built with BEAN Folio — the portfolio platform"
                >
                  BEAN Folio
                </a>{" "}
                · GIFTZ
              </span>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

// ------------------------------------------------- website project detail page

function formatSiteDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));
  } catch {
    return null;
  }
}

/** Gallery item rendering for the website project page (image / video / audio / document). */
function SiteMediaItem({ item, theme }: { item: ProjectMediaDTO; theme: ResolvedTheme }) {
  const radius = RADIUS[theme.radius];
  if (item.kind === "VIDEO") {
    return (
      <video
        src={item.url}
        className="w-full"
        style={{ borderRadius: radius, background: theme.surface }}
        controls
        playsInline
        preload="metadata"
        aria-label={item.caption ?? undefined}
      />
    );
  }
  if (item.kind === "AUDIO") {
    return <audio src={item.url} controls preload="metadata" className="w-full" aria-label={item.caption ?? undefined} />;
  }
  if (item.kind === "DOCUMENT") {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="bs-mi inline-flex items-center gap-1.5 border px-4 py-2 text-sm transition-opacity hover:opacity-80"
        style={{ borderColor: theme.border, borderRadius: radius, color: theme.accent, ...linkProps(theme) }}
      >
        <ExternalLink className="size-4" aria-hidden /> Open document
      </a>
    );
  }
  return <img src={item.url} alt={item.caption ?? ""} className="w-full" style={{ borderRadius: radius }} loading="lazy" />;
}

/**
 * SiteProjectPage — a project detail page rendered INSIDE the standalone
 * website's own design system. Mounted at `/site/<username>/projects/<id>`,
 * it is the website-native alternative to the platform's ProjectDetailView:
 * the visitor never leaves the creator's website — same theme, fonts, motion
 * and canvas as the homepage, no BEAN Folio chrome. Data arrives via the
 * existing GET /api/projects/[id] contract (FullProject), so nothing here
 * invents content and every visibility rule stays server-enforced.
 */
export function SiteProjectPage({
  config,
  profile,
  project,
  backHref,
  watermark = true,
}: {
  config: SiteConfig;
  profile: SiteRendererProfile;
  project: FullProject;
  /** In-site link back to the website homepage (hash form). */
  backHref: string;
  watermark?: boolean;
}) {
  const theme = useMemo(() => deriveTheme(config.theme), [config.theme]);
  const motion = config.motion ?? defaultMotion();
  const rootRef = useRef<HTMLDivElement | null>(null);
  useSiteFonts(rootRef, theme);
  const motionCss = useMotionCss(config, motion);
  const hoverZoom = motion.enabled && motion.hoverEffects;
  const contentMax = CONTENT_WIDTH[theme.contentWidth];
  const scale = TYPE_SCALE[theme.typeScale];

  const headingStyle: React.CSSProperties = {
    fontFamily: stacks(theme).heading,
    fontWeight: HEADING_WEIGHT_NUM[theme.headingWeight],
    letterSpacing: TRACKING[theme.letterSpacing],
  };
  const labelStyle: React.CSSProperties = { color: theme.muted, fontFamily: stacks(theme).accent };
  const chipStyle: React.CSSProperties = {
    borderColor: theme.border,
    borderRadius: RADIUS[theme.radius],
    color: theme.muted,
    fontFamily: stacks(theme).accent,
  };

  const published = formatSiteDate(project.publishedAt);
  const meta = [published, project.role?.trim() || null].filter(Boolean) as string[];
  const gallery = project.media ?? [];
  const fieldEntries = [
    ...Object.entries(project.customFields?.fields ?? {}),
    ...(project.customFields?.custom ?? []).map((c) => [c.label, c.value] as const),
  ].filter(([, v]) => typeof v === "string" && v.trim().length > 0);
  const narrative = (
    [
      ["Brief", project.brief],
      ["Process", project.process],
      ["Challenges", project.challenges],
      ["Outcome", project.outcome],
    ] as const
  ).filter(([, body]) => typeof body === "string" && body.trim().length > 0);
  const chips = [...new Set([...(project.skills ?? []), ...(project.tools ?? [])])].filter((s) => s.trim().length > 0);

  return (
    <div
      ref={rootRef}
      className="bean-site min-h-full w-full overflow-x-hidden"
      style={{
        background: theme.gradient
          ? `linear-gradient(${theme.gradient.angle}deg, ${theme.gradient.from}, ${theme.gradient.to})`
          : theme.background,
        color: theme.foreground,
        fontFamily: stacks(theme).body,
        lineHeight: LINE_HEIGHT[theme.lineHeight],
        ["--bs-ease" as string]: easingCss(motion.easing),
        ["--site-accent" as string]: theme.accent,
        ["--site-accent2" as string]: theme.accent2,
        ["--site-focus" as string]: theme.focus,
        ["--site-radius" as string]: RADIUS[theme.radius],
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: motionCss + glassFallbackCss(theme) }} />
      <BackgroundLayer theme={theme} motion={motion} />
      <div
        className="mx-auto w-full px-5 sm:px-8"
        style={{ maxWidth: contentMax, paddingTop: "1.75rem", paddingBottom: DENSITY_GAP[theme.density] }}
      >
        {/* Website-native header — the ONLY navigation affordances are the
            website's own: back to the site and the site's identity. */}
        <nav aria-label="Website" className="flex flex-wrap items-center justify-between gap-3 pb-6">
          <a
            href={backHref}
            className="bs-mi inline-flex items-center gap-1.5 text-sm transition-opacity hover:opacity-75"
            style={{ color: theme.accent, ...linkProps(theme) }}
          >
            <ArrowLeft className="size-4" aria-hidden /> Back to {config.name}
          </a>
          <a href={backHref} className="text-sm font-semibold transition-opacity hover:opacity-75" style={labelStyle}>
            {config.name}
          </a>
        </nav>

        <Reveal motion={motion}>
          <article className="pb-12">
            <p className="text-[11px] uppercase tracking-[0.14em]" style={labelStyle}>
              {categoryLabel(project.category)}
            </p>
            <h1 className={cn("mt-2 max-w-3xl text-balance leading-[1.08]", scale.h2)} style={{ ...headingStyle, color: theme.accent }}>
              {project.title}
            </h1>
            {meta.length > 0 && (
              <p className="mt-3 text-sm" style={labelStyle}>
                {meta.join(" · ")}
              </p>
            )}
            {(project.externalUrl || project.repoUrl) && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {project.externalUrl && (
                  <a href={project.externalUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses(theme)} style={buttonStyle(theme)}>
                    <Globe className="size-4" aria-hidden /> Visit live site
                  </a>
                )}
                {project.repoUrl && (
                  <a
                    href={project.repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bs-mi inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
                    style={{ color: theme.accent, ...linkProps(theme) }}
                  >
                    <ExternalLink className="size-4" aria-hidden /> Source code
                  </a>
                )}
              </div>
            )}
            {project.coverUrl && (
              <div
                className={cn("mt-8 w-full overflow-hidden", hoverZoom && "bs-hoverzoom")}
                style={{ aspectRatio: IMAGE_RATIO[theme.imageRatio], borderRadius: RADIUS[theme.radius] }}
              >
                <SiteCoverImage src={project.coverUrl} kind={project.coverKind} alt={project.title} title={project.title} theme={theme} />
              </div>
            )}
            {project.summary && (
              <p className="mt-8 max-w-2xl text-lg leading-relaxed" style={{ color: theme.foreground }}>
                {project.summary}
              </p>
            )}
            {project.description && (
              <div className="mt-5 max-w-2xl whitespace-pre-wrap text-[15px] leading-relaxed opacity-90">{project.description}</div>
            )}

            {fieldEntries.length > 0 && (
              <dl className="mt-8 grid gap-x-8 gap-y-4 sm:grid-cols-2" style={{ maxWidth: "42rem" }}>
                {fieldEntries.map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs uppercase tracking-wide" style={labelStyle}>
                      {label}
                    </dt>
                    <dd className="mt-1 text-sm opacity-90">{value}</dd>
                  </div>
                ))}
              </dl>
            )}

            {narrative.map(([label, body]) => (
              <section key={label} className="mt-9 max-w-2xl">
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em]" style={{ ...headingStyle, color: theme.accent }}>
                  {label}
                </h2>
                <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed opacity-90">{body}</p>
              </section>
            ))}

            {chips.length > 0 && (
              <div className="mt-9 flex flex-wrap gap-2">
                {chips.map((s) => (
                  <span key={s} className="border px-3 py-1 text-sm" style={chipStyle}>
                    {s}
                  </span>
                ))}
              </div>
            )}

            {gallery.length > 0 && (
              <section className="mt-10">
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em]" style={{ ...headingStyle, color: theme.accent }}>
                  Gallery
                </h2>
                <Reveal motion={motion} stagger className="mt-5 grid gap-5 sm:grid-cols-2">
                  {gallery.map((item) => (
                    <figure key={item.id} className="min-w-0">
                      <SiteMediaItem item={item} theme={theme} />
                      {item.caption && (
                        <figcaption className="mt-2 text-xs" style={labelStyle}>
                          {item.caption}
                        </figcaption>
                      )}
                    </figure>
                  ))}
                </Reveal>
              </section>
            )}

            {project.contributors.length > 0 && (
              <section className="mt-10 max-w-2xl">
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em]" style={{ ...headingStyle, color: theme.accent }}>
                  Contributors
                </h2>
                <ul className="mt-4 space-y-2">
                  {project.contributors.map((c) => (
                    <li key={c.id} className="text-sm opacity-90">
                      <span className="font-semibold" style={{ color: theme.accent }}>
                        {c.name}
                      </span>
                      {c.role ? <span style={labelStyle}> · {c.role}</span> : null}
                      {c.contribution ? <span className="opacity-80"> — {c.contribution}</span> : null}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </article>
        </Reveal>

        <footer className="mt-6 pt-6 text-xs opacity-70" style={{ borderTop: theme.divider === "none" ? "none" : `1px solid ${theme.border}` }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {config.name} · {profile.name}
            </span>
            {watermark && (
              <span aria-label="Made with BEAN Folio · GIFTZ">
                Made with{" "}
                <a href="#/" className="underline-offset-4 transition-colors hover:underline" title="Built with BEAN Folio — the portfolio platform">
                  BEAN Folio
                </a>{" "}
                · GIFTZ
              </span>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
