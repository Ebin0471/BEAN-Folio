/**
 * Code Giftz — REAL browser preview checks (client-side complement to the
 * server verification report).
 *
 * The server's verification (src/lib/ai-design/verify.ts) validates the
 * configuration it CAN validate server-side and honestly lists what it
 * cannot: layout regressions, broken assets and runtime errors. This module
 * closes that gap where a real preview exists — the Website Studio canvas
 * renders the actual SiteRenderer inside a same-origin iframe at a real
 * device viewport, so the client can MEASURE it.
 *
 * The DOM gathering lives in the builder (it owns the iframe); the evaluation
 * logic is extracted here as pure functions so it is unit-testable and the
 * panel renders the exact same check shape as the server report.
 *
 * Pure module — safe to import from client code.
 */

export type BrowserCheckStatus = "pass" | "warn" | "fail";

export interface BrowserCheck {
  id: string;
  label: string;
  status: BrowserCheckStatus;
  detail: string;
}

/** One element that sticks out past the right edge of the viewport. */
export interface OffendingElement {
  tag: string;
  id: string;
  className: string;
  text: string;
  overflowPx: number;
}

export interface OverflowMeasurement {
  /** The iframe's REAL viewport width (device width — scaling is visual only). */
  viewportW: number;
  /** documentElement.scrollWidth inside the frame. */
  docScrollW: number;
  /** documentElement.clientWidth inside the frame. */
  clientW: number;
  /** Elements extending past the viewport edge (sampled, capped). */
  offending: OffendingElement[];
}

/** Layout regression check — horizontal overflow at the current device width. */
export function evaluateOverflow(m: OverflowMeasurement): BrowserCheck {
  // Tolerate sub-pixel rounding; anything above 1px counts as real overflow.
  const overflowX = Math.max(0, Math.max(m.docScrollW - m.clientW, ...m.offending.map((o) => o.overflowPx)));
  if (overflowX <= 1 && m.offending.length === 0) {
    return {
      id: "browser-overflow",
      label: "Layout (browser)",
      status: "pass",
      detail: `No horizontal overflow at ${m.viewportW}px viewport (content width ${m.clientW}px).`,
    };
  }
  const samples = m.offending
    .slice(0, 3)
    .map((o) => `<${o.tag}${o.id ? `#${o.id}` : ""}${o.className ? `.${o.className.split(/\s+/)[0]}` : ""}> overflows by ${Math.round(o.overflowPx)}px`)
    .join("; ");
  return {
    id: "browser-overflow",
    label: "Layout (browser)",
    status: overflowX > 24 ? "fail" : "warn",
    detail:
      `Horizontal overflow of ${Math.round(overflowX)}px at ${m.viewportW}px viewport` +
      (samples ? ` — ${samples}.` : ". Content is wider than the viewport (scroll or clipping risk)."),
  };
}

export interface ImageMeasurement {
  src: string;
  complete: boolean;
  naturalWidth: number;
}

/** Broken-asset check — every rendered <img> must have decoded pixels. */
export function evaluateAssets(images: ImageMeasurement[]): BrowserCheck {
  if (images.length === 0) {
    return { id: "browser-assets", label: "Assets (browser)", status: "pass", detail: "No images rendered on this page — nothing to break." };
  }
  // complete && naturalWidth === 0 → failed decode or broken URL. Images still
  // mid-load (complete === false) are given the benefit of the doubt; the
  // caller waits for the load window before measuring.
  const broken = images.filter((i) => i.complete && i.naturalWidth === 0);
  if (broken.length === 0) {
    return { id: "browser-assets", label: "Assets (browser)", status: "pass", detail: `All ${images.length} rendered image${images.length === 1 ? "" : "s"} decoded successfully.` };
  }
  const samples = broken.slice(0, 3).map((i) => shortSrc(i.src)).join(", ");
  return {
    id: "browser-assets",
    label: "Assets (browser)",
    status: "fail",
    detail: `${broken.length} of ${images.length} images failed to load${samples ? ` (${samples})` : ""}. Check the media panel for missing or deleted assets.`,
  };
}

/** Runtime check — errors captured from the frame during the observation window. */
export function evaluateRuntime(errors: string[]): BrowserCheck {
  if (errors.length === 0) {
    return { id: "browser-runtime", label: "Runtime (browser)", status: "pass", detail: "No script errors or unhandled rejections captured during the check window." };
  }
  return {
    id: "browser-runtime",
    label: "Runtime (browser)",
    status: "fail",
    detail: `${errors.length} runtime error${errors.length === 1 ? "" : "s"} captured during the check window: ${errors.slice(0, 2).join(" | ")}`,
  };
}

/** Render sanity — the frame rendered roughly the sections the config declares. */
export function evaluateStructure(rendered: number, expected: number): BrowserCheck {
  if (rendered >= expected) {
    return { id: "browser-structure", label: "Render (browser)", status: "pass", detail: `${rendered} section${rendered === 1 ? "" : "s"} rendered (config declares ${expected}).` };
  }
  return {
    id: "browser-structure",
    label: "Render (browser)",
    status: rendered === 0 ? "fail" : "warn",
    detail: `${rendered} of ${expected} expected section${expected === 1 ? "" : "s"} rendered — hidden sections or a partial render.`,
  };
}

export interface LinkMeasurement {
  href: string;
  text: string;
}

/**
 * Link check — anchors on the rendered page must be real destinations.
 * FAILs on script-URL hrefs (a hard safety smell), warns on placeholder
 * hrefs ("" / "#" / "undefined" / "null") and on links with no accessible
 * text — the classic "broken link" symptoms a fix request targets.
 */
export function evaluateLinks(links: LinkMeasurement[]): BrowserCheck {
  if (links.length === 0) {
    return { id: "browser-links", label: "Links (browser)", status: "pass", detail: "No links rendered on this page — nothing to check." };
  }
  const dangerous = links.filter((l) => /^javascript:/i.test(l.href.trim()));
  const placeholders = links.filter((l) => {
    const h = l.href.trim();
    return h === "" || h === "#" || /^(undefined|null)$/i.test(h);
  });
  const emptyText = links.filter((l) => l.text.length === 0);
  if (dangerous.length === 0 && placeholders.length === 0 && emptyText.length === 0) {
    return { id: "browser-links", label: "Links (browser)", status: "pass", detail: `All ${links.length} link${links.length === 1 ? "" : "s"} resolve to real destinations with accessible text.` };
  }
  const parts: string[] = [];
  if (dangerous.length > 0) parts.push(`${dangerous.length} script-URL link${dangerous.length === 1 ? "" : "s"}`);
  if (placeholders.length > 0) parts.push(`${placeholders.length} placeholder destination${placeholders.length === 1 ? "" : "s"} (e.g. "${(placeholders[0].href || "(empty)").slice(0, 24)}")`);
  if (emptyText.length > 0) parts.push(`${emptyText.length} link${emptyText.length === 1 ? "" : "s"} without text`);
  return {
    id: "browser-links",
    label: "Links (browser)",
    status: dangerous.length > 0 ? "fail" : "warn",
    detail: `${parts.join("; ")} out of ${links.length} checked.`,
  };
}

/** Shorten an asset URL for a human-readable check detail. */
function shortSrc(src: string): string {
  try {
    const u = new URL(src, "http://preview.local");
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1].slice(0, 40) : src.slice(0, 40);
  } catch {
    return src.slice(0, 40);
  }
}
