import type { CSSProperties } from "react";
import type { PortfolioConfig } from "@/lib/portfolio-schema";

/**
 * Portfolio theme engine — turns a config's theme/layout/motion into CSS
 * custom properties and shared style helpers used by the renderer. The
 * portfolio root element scopes everything under [data-pf], so site themes
 * never leak into the BEAN Folio application shell.
 */

export interface PfTheme {
  vars: CSSProperties;
  isLight: boolean;
  fontDisplay: string;
  fontBody: string;
  maxW: string;
  sectionPad: string;
  gap: string;
}

const FONT_STACKS: Record<PortfolioConfig["theme"]["fontPairing"], { display: string; body: string }> = {
  editorial: {
    display: "var(--font-fraunces), Georgia, 'Times New Roman', serif",
    body: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  },
  modern: {
    display: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
    body: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  },
  technical: {
    display: "var(--font-geist-mono), ui-monospace, 'SF Mono', monospace",
    body: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  },
  classic: {
    display: "var(--font-fraunces), Georgia, serif",
    body: "var(--font-fraunces), Georgia, serif",
  },
};

const WIDTHS: Record<PortfolioConfig["theme"]["contentWidth"], string> = {
  narrow: "760px",
  regular: "1040px",
  wide: "1280px",
};

const DENSITY_PAD: Record<PortfolioConfig["theme"]["density"], string> = {
  compact: "56px",
  regular: "92px",
  spacious: "132px",
};

const DENSITY_GAP: Record<PortfolioConfig["theme"]["density"], string> = {
  compact: "18px",
  regular: "26px",
  spacious: "38px",
};

/** hex (#rgb or #rrggbb) → rgba string with the given alpha. */
export function alpha(hex: string, a: number): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function buildPfTheme(config: PortfolioConfig): PfTheme {
  const t = config.theme;
  const pairing = FONT_STACKS[t.fontPairing] ?? FONT_STACKS.editorial;
  return {
    vars: {
      ["--pf-accent"]: t.accent,
      ["--pf-accent-soft"]: alpha(t.accent, 0.14),
      ["--pf-accent-border"]: alpha(t.accent, 0.38),
      ["--pf-bg"]: t.background,
      ["--pf-surface"]: t.surface,
      ["--pf-text"]: t.text,
      ["--pf-muted"]: t.muted,
      ["--pf-border"]: alpha(t.text, 0.1),
      ["--pf-border-strong"]: alpha(t.text, 0.2),
      ["--pf-radius"]: `${t.radius}px`,
      ["--pf-shadow"]: t.shadows ? "0 24px 60px -28px rgba(0,0,0,0.55)" : "none",
      ["--pf-font-display"]: pairing.display,
      ["--pf-font-body"]: pairing.body,
      ["--pf-maxw"]: WIDTHS[t.contentWidth] ?? WIDTHS.regular,
      ["--pf-secy"]: DENSITY_PAD[t.density] ?? DENSITY_PAD.regular,
      ["--pf-gap"]: DENSITY_GAP[t.density] ?? DENSITY_GAP.regular,
      ["--pf-glass"]: t.glass ? alpha(t.background, 0.72) : t.background,
      backgroundColor: t.background,
      color: t.text,
      fontFamily: pairing.body,
      fontSize: `${16 * t.fontScale}px`,
    } as CSSProperties,
    isLight: isLightColor(t.background),
    fontDisplay: pairing.display,
    fontBody: pairing.body,
    maxW: WIDTHS[t.contentWidth] ?? WIDTHS.regular,
    sectionPad: DENSITY_PAD[t.density] ?? DENSITY_PAD.regular,
    gap: DENSITY_GAP[t.density] ?? DENSITY_GAP.regular,
  };
}

export function isLightColor(hex: string): boolean {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6;
}

/** Card aspect ratio class per layout setting. */
export const ASPECT_CLASS: Record<PortfolioConfig["layout"]["cardAspect"], string> = {
  landscape: "aspect-[4/3]",
  square: "aspect-square",
  cinema: "aspect-video",
  portrait: "aspect-[3/4]",
};

export function mediaUrl(mediaId: string | null | undefined): string | null {
  return mediaId ? `/api/media/${mediaId}/raw` : null;
}

/** Typed getters for section/widget data blobs (already schema-normalized). */
export function dstr(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  return typeof v === "string" ? v : "";
}
export function dnum(data: Record<string, unknown>, key: string): number {
  const v = data[key];
  return typeof v === "number" ? v : 0;
}
export function dbool(data: Record<string, unknown>, key: string): boolean {
  return data[key] === true;
}
export function dnstr(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
export function darr<T = Record<string, unknown>>(data: Record<string, unknown>, key: string): T[] {
  const v = data[key];
  return Array.isArray(v) ? (v as T[]) : [];
}
