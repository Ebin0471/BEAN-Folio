import type { PortfolioConfig } from "@/lib/portfolio-schema";

/**
 * Portfolio templates — ten genuinely distinct starting points. All share the
 * SAME data model (PortfolioConfig); a template only presets theme tokens,
 * layout structure and motion. Switching templates never touches content
 * (hero text, sections, widgets, projects), so users can try any identity
 * without losing work.
 */

type Theme = PortfolioConfig["theme"];
type Layout = PortfolioConfig["layout"];

export interface TemplatePreset {
  id: string;
  name: string;
  blurb: string;
  tags: string[];
  swatch: { bg: string; surface: string; accent: string; text: string };
  theme: Partial<Theme>;
  layout: Partial<Layout>;
}

export const TEMPLATES: TemplatePreset[] = [
  {
    id: "editorial",
    name: "Minimal Editorial",
    blurb: "Magazine-grade serif elegance on obsidian. The signature BEAN look.",
    tags: ["Serif", "Centered", "Gold"],
    swatch: { bg: "#090A0C", surface: "#17191D", accent: "#E8BC51", text: "#F7F5EF" },
    theme: {
      mode: "dark",
      accent: "#E8BC51",
      background: "#090A0C",
      surface: "#17191D",
      text: "#F7F5EF",
      muted: "#A5A6A8",
      fontPairing: "editorial",
      contentWidth: "regular",
      radius: 12,
      density: "regular",
      shadows: true,
      glass: true,
    },
    layout: { heroLayout: "centered", nav: "top", projectGrid: "grid", cardAspect: "landscape", columns: 3, align: "left" },
  },
  {
    id: "cinematic",
    name: "Cinematic Creator",
    blurb: "Full-bleed hero imagery, moody contrast, film-credit typography.",
    tags: ["Full-bleed", "Film", "Bold"],
    swatch: { bg: "#050506", surface: "#141416", accent: "#E8BC51", text: "#F4F2EC" },
    theme: {
      mode: "dark",
      accent: "#E8BC51",
      background: "#050506",
      surface: "#141416",
      text: "#F4F2EC",
      muted: "#9C9DA1",
      fontPairing: "editorial",
      contentWidth: "wide",
      radius: 4,
      density: "spacious",
      shadows: true,
      glass: true,
      grain: true,
    },
    layout: { heroLayout: "cinematic", nav: "top", projectGrid: "grid", cardAspect: "cinema", columns: 2, align: "left" },
  },
  {
    id: "minimal-dev",
    name: "Software Engineer",
    blurb: "Monospace headlines, hairline borders, zero decoration. Ship and show.",
    tags: ["Mono", "Grid", "Quiet"],
    swatch: { bg: "#0C0E10", surface: "#16191C", accent: "#B7C9A3", text: "#E9EAE4" },
    theme: {
      mode: "dark",
      accent: "#B7C9A3",
      background: "#0C0E10",
      surface: "#16191C",
      text: "#E9EAE4",
      muted: "#9B9EA0",
      fontPairing: "technical",
      contentWidth: "regular",
      radius: 2,
      density: "compact",
      shadows: false,
      glass: false,
    },
    layout: { heroLayout: "minimal", nav: "top", projectGrid: "grid", cardAspect: "landscape", columns: 2, align: "left" },
  },
  {
    id: "designer-case",
    name: "Graphic Designer",
    blurb: "Split hero and portrait cards built for deep, visual storytelling.",
    tags: ["Split", "Masonry", "Warm"],
    swatch: { bg: "#121014", surface: "#1D1A21", accent: "#D98E5F", text: "#F5F1EA" },
    theme: {
      mode: "dark",
      accent: "#D98E5F",
      background: "#121014",
      surface: "#1D1A21",
      text: "#F5F1EA",
      muted: "#A8A2A0",
      fontPairing: "modern",
      contentWidth: "regular",
      radius: 16,
      density: "regular",
      shadows: true,
      glass: true,
    },
    layout: { heroLayout: "split", nav: "top", projectGrid: "masonry", cardAspect: "portrait", columns: 3, align: "left" },
  },
  {
    id: "video-reel",
    name: "Filmmaker & Video Editor",
    blurb: "Widescreen everything — a hero canvas and cinema cards for motion work.",
    tags: ["Widescreen", "Motion", "Dark"],
    swatch: { bg: "#080809", surface: "#151518", accent: "#F2D06B", text: "#F2F0E9" },
    theme: {
      mode: "dark",
      accent: "#F2D06B",
      background: "#080809",
      surface: "#151518",
      text: "#F2F0E9",
      muted: "#A0A1A4",
      fontPairing: "modern",
      contentWidth: "wide",
      radius: 8,
      density: "regular",
      shadows: true,
      glass: true,
    },
    layout: { heroLayout: "cinematic", nav: "top", projectGrid: "grid", cardAspect: "cinema", columns: 2, align: "left" },
  },
  {
    id: "photographer",
    name: "Photographer Gallery",
    blurb: "Chrome-free masonry wall. The photographs are the interface.",
    tags: ["Masonry", "Edge-to-edge", "Minimal"],
    swatch: { bg: "#0A0A0A", surface: "#161616", accent: "#E3E1DB", text: "#F0EEE8" },
    theme: {
      mode: "dark",
      accent: "#E3E1DB",
      background: "#0A0A0A",
      surface: "#161616",
      text: "#F0EEE8",
      muted: "#98999B",
      fontPairing: "editorial",
      contentWidth: "wide",
      radius: 0,
      density: "compact",
      shadows: false,
      glass: false,
    },
    layout: { heroLayout: "portrait", nav: "top", projectGrid: "masonry", cardAspect: "portrait", columns: 4, align: "left" },
  },
  {
    id: "architect",
    name: "Architect Portfolio",
    blurb: "Daylight paper, bronze rules, strict grid — measured and precise.",
    tags: ["Light", "Grid", "Strict"],
    swatch: { bg: "#EFECE4", surface: "#F7F5EF", accent: "#8C6F46", text: "#1A1B1D" },
    theme: {
      mode: "light",
      accent: "#8C6F46",
      background: "#EFECE4",
      surface: "#F7F5EF",
      text: "#1A1B1D",
      muted: "#6E6F72",
      fontPairing: "modern",
      contentWidth: "wide",
      radius: 0,
      density: "compact",
      shadows: false,
      glass: false,
    },
    layout: { heroLayout: "minimal", nav: "top", projectGrid: "grid", cardAspect: "square", columns: 3, align: "left" },
  },
  {
    id: "writer",
    name: "Writer & Researcher",
    blurb: "A narrow reading column with classical serif rhythm. Words first.",
    tags: ["Serif", "Narrow", "Light"],
    swatch: { bg: "#F8F5EC", surface: "#FFFDF6", accent: "#7A5C14", text: "#23221E" },
    theme: {
      mode: "light",
      accent: "#7A5C14",
      background: "#F8F5EC",
      surface: "#FFFDF6",
      text: "#23221E",
      muted: "#6B6A63",
      fontPairing: "classic",
      contentWidth: "narrow",
      radius: 6,
      density: "regular",
      shadows: false,
      glass: false,
    },
    layout: { heroLayout: "minimal", nav: "top", projectGrid: "grid", cardAspect: "landscape", columns: 2, align: "left" },
  },
  {
    id: "product-designer",
    name: "UI/UX Designer",
    blurb: "Soft panels, generous radius, balanced split hero. Friendly and sharp.",
    tags: ["Split", "Soft", "Balanced"],
    swatch: { bg: "#101113", surface: "#1B1D20", accent: "#E8BC51", text: "#F3F1EB" },
    theme: {
      mode: "dark",
      accent: "#E8BC51",
      background: "#101113",
      surface: "#1B1D20",
      text: "#F3F1EB",
      muted: "#A5A6A8",
      fontPairing: "modern",
      contentWidth: "regular",
      radius: 20,
      density: "regular",
      shadows: true,
      glass: true,
    },
    layout: { heroLayout: "split", nav: "top", projectGrid: "grid", cardAspect: "landscape", columns: 3, align: "left" },
  },
  {
    id: "personal-brand",
    name: "Freelancer & Consultant",
    blurb: "Oversized type, warm accent, big calls to action. You are the product.",
    tags: ["Bold type", "CTA", "Warm"],
    swatch: { bg: "#0D0A07", surface: "#1A1510", accent: "#E89B51", text: "#F7F3EC" },
    theme: {
      mode: "dark",
      accent: "#E89B51",
      background: "#0D0A07",
      surface: "#1A1510",
      text: "#F7F3EC",
      muted: "#A8A29A",
      fontPairing: "modern",
      contentWidth: "regular",
      radius: 24,
      density: "spacious",
      shadows: true,
      glass: true,
    },
    layout: { heroLayout: "centered", nav: "top", projectGrid: "grid", cardAspect: "landscape", columns: 2, align: "center" },
  },
  {
    id: "fullstack-dev",
    name: "Full-stack Developer",
    blurb: "Terminal-warm dark theme, project grid first, repos and stack up front.",
    tags: ["Dark", "Grid", "Developer"],
    swatch: { bg: "#0B0D0F", surface: "#171B1F", accent: "#7FD1B9", text: "#E6EAE7" },
    theme: {
      mode: "dark",
      accent: "#7FD1B9",
      background: "#0B0D0F",
      surface: "#171B1F",
      text: "#E6EAE7",
      muted: "#9AA3A0",
      fontPairing: "technical",
      contentWidth: "regular",
      radius: 6,
      density: "regular",
      shadows: true,
      glass: false,
    },
    layout: { heroLayout: "split", nav: "top", projectGrid: "grid", cardAspect: "landscape", columns: 2, align: "left" },
  },
  {
    id: "creative-studio",
    name: "Creative Studio",
    blurb: "Gallery-forward identity with generous whitespace and an editorial voice.",
    tags: ["Studio", "Masonry", "Editorial"],
    swatch: { bg: "#101013", surface: "#1B1B20", accent: "#E8BC51", text: "#F4F1E9" },
    theme: {
      mode: "dark",
      accent: "#E8BC51",
      background: "#101013",
      surface: "#1B1B20",
      text: "#F4F1E9",
      muted: "#A5A2A0",
      fontPairing: "editorial",
      contentWidth: "wide",
      radius: 10,
      density: "spacious",
      shadows: true,
      glass: true,
    },
    layout: { heroLayout: "centered", nav: "top", projectGrid: "masonry", cardAspect: "portrait", columns: 3, align: "center" },
  },
  {
    id: "blank",
    name: "Custom Blank",
    blurb: "A clean slate: brand tokens only — you shape every section and widget.",
    tags: ["Blank", "Unopinionated", "From scratch"],
    swatch: { bg: "#0B0C0E", surface: "#181A1E", accent: "#E8BC51", text: "#F7F5EF" },
    theme: {
      mode: "custom",
      accent: "#E8BC51",
      background: "#0B0C0E",
      surface: "#181A1E",
      text: "#F7F5EF",
      muted: "#A5A6A8",
      fontPairing: "modern",
      contentWidth: "regular",
      radius: 8,
      density: "regular",
      shadows: false,
      glass: false,
      grain: false,
    },
    layout: { heroLayout: "minimal", nav: "top", projectGrid: "grid", cardAspect: "landscape", columns: 3, align: "left" },
  },
];

export const DEFAULT_TEMPLATE_ID = "editorial";

export function getTemplate(id: string): TemplatePreset {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

/**
 * Apply a template onto an existing config: replaces theme/layout/motion
 * presets AND the templateId, but preserves every piece of content.
 */
export function applyTemplate(config: PortfolioConfig, templateId: string): PortfolioConfig {
  const preset = getTemplate(templateId);
  return {
    ...config,
    templateId: preset.id,
    theme: { ...config.theme, ...preset.theme },
    layout: { ...config.layout, ...preset.layout },
  };
}
