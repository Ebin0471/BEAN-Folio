import type { SiteConfig } from "@/lib/site-config";

/**
 * Virtual file view of a website configuration change.
 *
 * The Website Studio talks about website changes in FILE terms (the user is a
 * developer audience — Code Giftz). A SiteConfig is the site's declarative
 * source; this module projects a before/after config pair onto a stable
 * virtual file tree and produces the changed-file inventory the chat panel
 * renders. Pure functions — deterministic, unit-testable, no DB.
 *
 * The tree is intentionally SMALL and semantic (not a 1:1 dump): every file
 * maps to one studio control group, so "which file changed" always answers
 * "which area of the site changed".
 *
 *   site.json                     identity (name/tagline/template/logo/cover)
 *   theme/tokens.json             color tokens + surface opacity + gradient
 *   theme/typography.json         fonts, scale, weights, line-height, tracking
 *   theme/layout.json             density, radius, widths, columns, ratios,
 *                                 buttons/links/dividers, nav layout, glass
 *   motion/presets.json           animation system
 *   pages/<pageId>.json           page name/visibility + its sections
 */

export interface ChangedFile {
  path: string;
  action: "modified" | "added" | "removed";
  /** Human change summary (deterministic, value-free of internals). */
  summary: string;
}

interface PageRef {
  id: string;
  name: string;
  visible: boolean;
  sections: { id: string; type: string }[];
}

function pageRefs(config: SiteConfig): PageRef[] {
  return config.pages.map((p) => ({
    id: p.id,
    name: p.name,
    visible: p.visible,
    sections: p.sections.map((s) => ({ id: s.id, type: s.type })),
  }));
}

function summarizeIdentityDiff(a: SiteConfig, b: SiteConfig): string | null {
  const bits: string[] = [];
  if (a.name !== b.name) bits.push("site name");
  if (a.tagline !== b.tagline) bits.push("tagline");
  if (a.template !== b.template) bits.push(`template → “${b.template}”`);
  if (a.logoMediaId !== b.logoMediaId || a.logoPreset !== b.logoPreset) bits.push("logo");
  if (a.coverMediaId !== b.coverMediaId) bits.push("cover image");
  if (bits.length === 0) return null;
  return `Updated ${bits.join(", ")}.`;
}

const THEME_TOKEN_KEYS = [
  "background",
  "foreground",
  "accent",
  "accent2",
  "surface",
  "border",
  "muted",
  "focus",
  "gradient",
  "surfaceOpacity",
] as const;

const THEME_TYPOGRAPHY_KEYS = [
  "font",
  "headingFont",
  "bodyFont",
  "accentFont",
  "codeFont",
  "typeScale",
  "headingWeight",
  "lineHeight",
  "letterSpacing",
  "headingAlign",
] as const;

const THEME_LAYOUT_KEYS = [
  "radius",
  "density",
  "contentWidth",
  "columns",
  "buttonStyle",
  "linkStyle",
  "imageRatio",
  "divider",
  "pageTransition",
  "navLayout",
  "glass",
] as const;

function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function labelKey(key: string): string {
  const map: Record<string, string> = {
    background: "background color",
    foreground: "text color",
    accent: "accent color",
    accent2: "secondary accent",
    surface: "surface color",
    border: "border color",
    muted: "muted text color",
    focus: "focus color",
    gradient: "background gradient",
    surfaceOpacity: "surface opacity",
    font: "base font",
    headingFont: "heading font",
    bodyFont: "body font",
    accentFont: "accent font",
    codeFont: "code font",
    typeScale: "type scale",
    headingWeight: "heading weight",
    lineHeight: "line height",
    letterSpacing: "letter spacing",
    headingAlign: "heading alignment",
    radius: "corner radius",
    density: "density",
    contentWidth: "content width",
    columns: "grid columns",
    buttonStyle: "button style",
    linkStyle: "link style",
    imageRatio: "image ratio",
    divider: "dividers",
    pageTransition: "page transition",
    navLayout: "nav layout",
    glass: "glassmorphism",
  };
  return map[key] ?? key;
}

function motionSummary(a: SiteConfig["motion"], b: SiteConfig["motion"]): string | null {
  const keys = [
    "enabled",
    "preset",
    "duration",
    "stagger",
    "easing",
    "intensity",
    "hoverEffects",
    "scrollReveal",
    "once",
    "background",
    "microInteractions",
  ];
  const changed = changedKeys(a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>, keys);
  if (changed.length === 0) return null;
  if (a.enabled !== b.enabled) {
    return b.enabled ? "Animations turned on." : "Animations turned off (content stays fully visible).";
  }
  return `Updated animation ${changed.slice(0, 4).map(labelKey).join(", ")}${changed.length > 4 ? ` +${changed.length - 4} more` : ""}.`;
}

function sectionsSignature(page: PageRef): string {
  return JSON.stringify(page.sections.map((s) => `${s.id}:${s.type}`));
}

/**
 * Project a before/after config pair onto the virtual file tree.
 * Files with identical content are omitted — the inventory lists ONLY what
 * actually changed (never a padded list).
 */
export function changedFilesBetween(before: SiteConfig, after: SiteConfig): ChangedFile[] {
  const files: ChangedFile[] = [];

  // ---- site.json (identity) ----
  const identity = summarizeIdentityDiff(before, after);
  if (identity) files.push({ path: "site.json", action: "modified", summary: identity });

  // ---- theme/tokens.json ----
  const tokenKeys = changedKeys(
    before.theme as unknown as Record<string, unknown>,
    after.theme as unknown as Record<string, unknown>,
    THEME_TOKEN_KEYS
  );
  if (tokenKeys.length > 0) {
    files.push({
      path: "theme/tokens.json",
      action: "modified",
      summary: `Updated ${tokenKeys.map(labelKey).join(", ")}.`,
    });
  }

  // ---- theme/typography.json ----
  const typoKeys = changedKeys(
    before.theme as unknown as Record<string, unknown>,
    after.theme as unknown as Record<string, unknown>,
    THEME_TYPOGRAPHY_KEYS
  );
  if (typoKeys.length > 0) {
    files.push({
      path: "theme/typography.json",
      action: "modified",
      summary: `Updated ${typoKeys.map(labelKey).join(", ")}.`,
    });
  }

  // ---- theme/layout.json ----
  const layoutKeys = changedKeys(
    before.theme as unknown as Record<string, unknown>,
    after.theme as unknown as Record<string, unknown>,
    THEME_LAYOUT_KEYS
  );
  if (layoutKeys.length > 0) {
    files.push({
      path: "theme/layout.json",
      action: "modified",
      summary: `Updated ${layoutKeys.map(labelKey).join(", ")}.`,
    });
  }

  // ---- motion/presets.json ----
  const motion = motionSummary(before.motion, after.motion);
  if (motion) files.push({ path: "motion/presets.json", action: "modified", summary: motion });

  // ---- pages/<id>.json (name/visibility/sections) ----
  const beforePages = pageRefs(before);
  const afterPages = pageRefs(after);
  const beforeById = new Map(beforePages.map((p) => [p.id, p]));

  for (const page of afterPages) {
    const prev = beforeById.get(page.id);
    const sig = sectionsSignature(page);
    const prevSig = prev ? sectionsSignature(prev) : null;
    if (!prev) {
      files.push({
        path: `pages/${page.id}.json`,
        action: "added",
        summary: `Added page “${page.name}” with ${page.sections.length} section${page.sections.length === 1 ? "" : "s"}.`,
      });
    } else if (sig !== prevSig || prev.name !== page.name || prev.visible !== page.visible) {
      const bits: string[] = [];
      if (prev.name !== page.name) bits.push(`renamed to “${page.name}”`);
      if (prev.visible !== page.visible) bits.push(page.visible ? "made visible in nav" : "hidden from nav");
      if (sig !== prevSig) {
        const prevTypes = prev.sections.map((s) => s.type);
        const nextTypes = page.sections.map((s) => s.type);
        const differing = nextTypes.filter((t, i) => t !== prevTypes[i]).length;
        bits.push(
          prevTypes.length !== nextTypes.length
            ? `${nextTypes.length} section${nextTypes.length === 1 ? "" : "s"} (was ${prevTypes.length})`
            : `section order/content changed (${differing} position${differing === 1 ? "" : "s"} differ)`
        );
      }
      files.push({
        path: `pages/${page.id}.json`,
        action: "modified",
        summary: `${page.name}: ${bits.join("; ")}.`,
      });
    }
  }
  for (const prev of beforePages) {
    if (!afterPages.some((p) => p.id === prev.id)) {
      files.push({ path: `pages/${prev.id}.json`, action: "removed", summary: `Removed page “${prev.name}”.` });
    }
  }

  return files;
}
