/**
 * BEAN Folio — GIFTZ consolidated quality gate (M33.3).
 *
 * Deterministic STATIC quality report over real generated-site artifacts
 * (HTML pages, stylesheets and the project file tree), consolidating
 * accessibility, SEO, internal links, responsive-layout and static-
 * performance checks into one evidence-backed surface with an explicit,
 * honest `untested` list (Guide §4 Stage 11 / M33.3:
 * docs/GIFTZ_UNIVERSAL_CREATIVE_STUDIO_GUIDE.md).
 *
 * Truth rules (non-negotiable, Guide §0):
 *  - Every finding carries evidence (page + capped sample). Nothing is
 *    invented; a check that cannot run honestly reports `not-run`.
 *  - Static analysis can NEVER prove runtime behaviour. The report always
 *    lists what only a real browser/device session can verify (runtime
 *    errors, real-viewport overflow, font loading, reduced motion, low
 *    bandwidth, contrast over imagery). The existing per-proposal browser
 *    checks (src/lib/ai-design/browser-checks.ts) remain the live-render
 *    complement — this module complements, never replaces, them.
 *  - Pure and deterministic: same artifacts → same report. No model calls,
 *    no persistence, no side effects.
 *
 * Machine-pinned by tests/giftz-quality-gate.test.ts.
 */

import { contrastRatio } from "@/lib/site-palettes";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type QualityGateCategory =
  | "accessibility"
  | "seo"
  | "links"
  | "responsive"
  | "performance";

export type QualityGateStatus = "pass" | "warn" | "fail" | "not-run";

export interface QualityGateEvidence {
  page: string;
  sample: string;
}

export interface QualityGateCheck {
  id: string;
  category: QualityGateCategory;
  status: QualityGateStatus;
  detail: string;
  evidence: QualityGateEvidence[];
}

export interface QualityGatePage {
  /** Project-relative page path, e.g. "index.html" or "about.html". */
  path: string;
  html: string;
}

export interface QualityGateStylesheet {
  path: string;
  css: string;
}

export interface QualityGateInput {
  pages: QualityGatePage[];
  /** Project stylesheets (checked for responsive/perf signals). */
  stylesheets?: QualityGateStylesheet[];
  /**
   * Every local file path the artifact ships (pages + css + js + assets).
   * Local asset references are resolved against this set — a referenced
   * path that is absent is reported as a broken local asset.
   */
  localFiles?: string[];
  /** Palette tokens for the contrast check; omit → contrast reports not-run. */
  palette?: { foreground: string; background: string } | null;
  /** Hard caps: no more than this many pages are scanned. */
  maxPages?: number;
}

export interface QualityGateReport {
  overall: "strong" | "acceptable" | "needs-work";
  summary: string;
  pagesChecked: number;
  checks: QualityGateCheck[];
  /**
   * What this static report deliberately does NOT claim. Only a real
   * browser/device session (studio browser checks, device QA) can verify
   * these; the report never presents static analysis as runtime proof.
   */
  untested: string[];
}

// ---------------------------------------------------------------------------
// Limits (bounded work — Guide §1.1 file/size budget discipline)
// ---------------------------------------------------------------------------

const MAX_PAGES_DEFAULT = 50;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_EVIDENCE = 3;
const INLINE_STYLE_BUDGET = 100 * 1024;
const INLINE_SCRIPT_BUDGET = 100 * 1024;
/** A stylesheet count above this is a real request-waterfall smell. */
const STYLESHEET_COUNT_WARN = 4;
/** Images per page above which lazy-loading absence becomes a warn. */
const IMAGES_LAZY_WARN = 10;
/** Fixed px widths above this look desktop-locked in a horizontal rule. */
const FIXED_WIDTH_WARN_PX = 900;

// ---------------------------------------------------------------------------
// Small extraction helpers (regex-based static parsing; bounded and defensive)
// ---------------------------------------------------------------------------

interface TagMatch {
  tag: string;
  attrs: string;
  index: number;
  full: string;
}

function scanTags(html: string, tag: string): TagMatch[] {
  const out: TagMatch[] = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}\\s*>`, "gi");
  const selfClosing = new RegExp(`<${tag}\\b([^>]*?)/?>`, "gi");
  if (tag === "img" || tag === "input") {
    let m: RegExpExecArray | null;
    while ((m = selfClosing.exec(html)) !== null) {
      out.push({ tag, attrs: m[1] ?? "", index: m.index, full: m[0] });
    }
    return out;
  }
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({ tag, attrs: m[1] ?? "", index: m.index, full: m[0] });
  }
  return out;
}

function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = attrs.match(re);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? "";
}

function hasAttr(attrs: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*=`, "i").test(attrs);
}

function stripTags(fragment: string): string {
  return fragment
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shorten(sample: string, max = 120): string {
  const one = sample.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// ---------------------------------------------------------------------------
// Check builders
// ---------------------------------------------------------------------------

function checkImagesAlt(pages: QualityGatePage[]): QualityGateCheck {
  const evidence: QualityGateEvidence[] = [];
  let missing = 0;
  let total = 0;
  for (const page of pages) {
    for (const img of scanTags(page.html, "img")) {
      total += 1;
      if (!hasAttr(img.attrs, "alt")) {
        missing += 1;
        if (evidence.length < MAX_EVIDENCE) {
          evidence.push({ page: page.path, sample: shorten(img.full) });
        }
      }
    }
  }
  if (total === 0) {
    return {
      id: "a11y-img-alt",
      category: "accessibility",
      status: "pass",
      detail: "No <img> elements found — nothing to check.",
      evidence: [],
    };
  }
  return {
    id: "a11y-img-alt",
    category: "accessibility",
    status: missing === 0 ? "pass" : "fail",
    detail:
      missing === 0
        ? `All ${total} <img> element(s) carry an alt attribute (alt="" is accepted for decorative images).`
        : `${missing} of ${total} <img> element(s) have NO alt attribute — screen readers announce the file name or skip the image entirely.`,
    evidence,
  };
}

function checkHtmlLang(pages: QualityGatePage[]): QualityGateCheck {
  const evidence: QualityGateEvidence[] = [];
  const missing: string[] = [];
  for (const page of pages) {
    const htmlTag = /<html\b[^>]*>/i.exec(page.html);
    if (!htmlTag || !hasAttr(htmlTag[0], "lang")) {
      missing.push(page.path);
      if (evidence.length < MAX_EVIDENCE) {
        evidence.push({
          page: page.path,
          sample: htmlTag ? `${shorten(htmlTag[0])} — no lang attribute` : "no <html> tag found",
        });
      }
    }
  }
  return {
    id: "a11y-html-lang",
    category: "accessibility",
    status: missing.length === 0 ? "pass" : "warn",
    detail:
      missing.length === 0
        ? "Every page declares its document language (<html lang>)."
        : `${missing.length} page(s) do not declare a lang attribute — screen readers and translation tools fall back to an unspecified language.`,
    evidence,
  };
}

function checkHeadingOrder(pages: QualityGatePage[]): QualityGateCheck {
  const evidence: QualityGateEvidence[] = [];
  let multiH1 = 0;
  let skipped = 0;
  let pagesWithHeadings = 0;
  for (const page of pages) {
    const levels: number[] = [];
    let m: RegExpExecArray | null;
    const re = /<h([1-6])\b/gi;
    while ((m = re.exec(page.html)) !== null) levels.push(Number(m[1]));
    if (levels.length === 0) continue;
    pagesWithHeadings += 1;
    const h1 = levels.filter((l) => l === 1).length;
    if (h1 > 1) {
      multiH1 += 1;
      if (evidence.length < MAX_EVIDENCE) {
        evidence.push({ page: page.path, sample: `${h1} <h1> elements on one page` });
      }
    }
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i] - levels[i - 1] > 1) {
        skipped += 1;
        if (evidence.length < MAX_EVIDENCE) {
          evidence.push({
            page: page.path,
            sample: `heading level jumps h${levels[i - 1]} → h${levels[i]}`,
          });
        }
      }
    }
  }
  return {
    id: "a11y-heading-order",
    category: "accessibility",
    status: multiH1 > 0 ? "fail" : skipped > 0 ? "warn" : "pass",
    detail:
      multiH1 > 0
        ? `${multiH1} page(s) use multiple <h1> elements — every page should have exactly one main heading.`
        : skipped > 0
          ? `${skipped} heading-level jump(s) (e.g. h2 → h4) — assistive technology loses the document outline.`
          : pagesWithHeadings === 0
            ? "No headings found on any page — consider a real heading structure for orientation."
            : "Heading levels are ordered with a single <h1> per page.",
    evidence,
  };
}

function checkFormLabels(pages: QualityGatePage[]): QualityGateCheck {
  const evidence: QualityGateEvidence[] = [];
  let unlabeled = 0;
  let total = 0;
  for (const page of pages) {
    // Collect <label for="id"> targets and the ranges of wrapping <label> blocks.
    const labelBlocks: { start: number; end: number; forId: string | null }[] = [];
    let lm: RegExpExecArray | null;
    const labelRe = /<label\b[^>]*>([\s\S]*?)<\/label\s*>/gi;
    while ((lm = labelRe.exec(page.html)) !== null) {
      labelBlocks.push({
        start: lm.index,
        end: lm.index + lm[0].length,
        forId: attrValue(lm[0].slice(0, lm[0].indexOf(">") + 1), "for"),
      });
    }
    const labelledIds = new Set(labelBlocks.map((b) => b.forId).filter((v): v is string => v !== null));

    for (const input of scanTags(page.html, "input")) {
      const type = (attrValue(input.attrs, "type") ?? "text").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "reset") continue;
      total += 1;
      const ok =
        hasAttr(input.attrs, "aria-label") ||
        hasAttr(input.attrs, "aria-labelledby") ||
        hasAttr(input.attrs, "title") === true
          ? true
          : false;
      const id = attrValue(input.attrs, "id");
      const inLabel = labelBlocks.some((b) => input.index >= b.start && input.index <= b.end);
      const forMatch = id !== null && labelledIds.has(id);
      if (!ok && !inLabel && !forMatch) {
        unlabeled += 1;
        if (evidence.length < MAX_EVIDENCE) {
          evidence.push({ page: page.path, sample: shorten(input.full) });
        }
      }
    }
    for (const ta of [...scanTags(page.html, "textarea"), ...scanTags(page.html, "select")]) {
      total += 1;
      const ok = hasAttr(ta.attrs, "aria-label") || hasAttr(ta.attrs, "aria-labelledby");
      const id = attrValue(ta.attrs, "id");
      const inLabel = labelBlocks.some((b) => ta.index >= b.start && ta.index <= b.end);
      const forMatch = id !== null && labelledIds.has(id);
      if (!ok && !inLabel && !forMatch) {
        unlabeled += 1;
        if (evidence.length < MAX_EVIDENCE) {
          evidence.push({ page: page.path, sample: shorten(ta.full) });
        }
      }
    }
  }
  if (total === 0) {
    return {
      id: "a11y-form-labels",
      category: "accessibility",
      status: "pass",
      detail: "No form fields found — nothing to check.",
      evidence: [],
    };
  }
  return {
    id: "a11y-form-labels",
    category: "accessibility",
    status: unlabeled === 0 ? "pass" : "fail",
    detail:
      unlabeled === 0
        ? `All ${total} form field(s) have an accessible label (label element, aria-label or aria-labelledby).`
        : `${unlabeled} of ${total} form field(s) have no accessible name — users of assistive technology cannot tell what to enter.`,
    evidence,
  };
}

function checkContrast(
  palette: { foreground: string; background: string } | null | undefined,
): QualityGateCheck {
  if (!palette || !palette.foreground || !palette.background) {
    return {
      id: "a11y-contrast",
      category: "accessibility",
      status: "not-run",
      detail:
        "Contrast was NOT evaluated: this static report has no rendered-pixel or palette context. Real contrast (including text over images/gradients) needs the studio browser checks or device QA.",
      evidence: [],
    };
  }
  const ratio = contrastRatio(palette.foreground, palette.background);
  if (ratio >= 4.5) {
    return {
      id: "a11y-contrast",
      category: "accessibility",
      status: "pass",
      detail: `Configured body text/background contrast is ${ratio.toFixed(2)}:1 (≥ 4.5 required). Rendered contrast over imagery is still unverified.`,
      evidence: [],
    };
  }
  return {
    id: "a11y-contrast",
    category: "accessibility",
    status: "fail",
    detail: `Configured body text/background contrast is ${ratio.toFixed(2)}:1 — below the 4.5:1 WCAG AA floor for body text.`,
    evidence: [],
  };
}

function checkSeoMeta(pages: QualityGatePage[]): QualityGateCheck[] {
  const missingTitle: string[] = [];
  const longTitle: string[] = [];
  const missingDesc: string[] = [];
  const missingOg: string[] = [];
  const titleEvidence: QualityGateEvidence[] = [];
  const descEvidence: QualityGateEvidence[] = [];
  const ogEvidence: QualityGateEvidence[] = [];

  for (const page of pages) {
    const title = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(page.html);
    const titleText = title ? stripTags(title[1]) : "";
    if (!titleText) {
      missingTitle.push(page.path);
      if (titleEvidence.length < MAX_EVIDENCE) {
        titleEvidence.push({ page: page.path, sample: "no <title> element" });
      }
    } else if (titleText.length > 120) {
      longTitle.push(page.path);
    }
    const desc = /<meta\s+[^>]*name\s*=\s*["']description["'][^>]*>/i.exec(page.html);
    const descContent = desc ? attrValue(desc[0], "content") : null;
    if (!descContent || descContent.trim().length === 0) {
      missingDesc.push(page.path);
      if (descEvidence.length < MAX_EVIDENCE) {
        descEvidence.push({ page: page.path, sample: "no meta description" });
      }
    }
    const ogTitle = /<meta\s+[^>]*property\s*=\s*["']og:title["'][^>]*>/i.test(page.html);
    const ogDesc = /<meta\s+[^>]*property\s*=\s*["']og:description["'][^>]*>/i.test(page.html);
    if (!ogTitle || !ogDesc) {
      missingOg.push(page.path);
      if (ogEvidence.length < MAX_EVIDENCE) {
        ogEvidence.push({
          page: page.path,
          sample: `missing ${!ogTitle ? "og:title" : "og:description"}`,
        });
      }
    }
  }

  const titleCheck: QualityGateCheck = {
    id: "seo-title",
    category: "seo",
    status: missingTitle.length === 0 ? (longTitle.length === 0 ? "pass" : "warn") : "fail",
    detail:
      missingTitle.length > 0
        ? `${missingTitle.length} page(s) have no <title> — browsers, screen readers and search engines all rely on it.`
        : longTitle.length > 0
          ? `${longTitle.length} page(s) carry a <title> longer than 120 characters — it will be truncated in result snippets.`
          : "Every page has a <title>.",
    evidence: titleEvidence,
  };

  const descCheck: QualityGateCheck = {
    id: "seo-meta-description",
    category: "seo",
    status: missingDesc.length === 0 ? "pass" : "warn",
    detail:
      missingDesc.length === 0
        ? "Every page declares a meta description."
        : `${missingDesc.length} page(s) have no meta description — search engines will synthesize one from page copy.`,
    evidence: descEvidence,
  };

  const ogCheck: QualityGateCheck = {
    id: "seo-open-graph",
    category: "seo",
    status: missingOg.length === 0 ? "pass" : "warn",
    detail:
      missingOg.length === 0
        ? "Every page carries og:title and og:description."
        : `${missingOg.length} page(s) lack Open Graph tags — shared links render without a prepared title/description card.`,
    evidence: ogEvidence,
  };

  return [titleCheck, descCheck, ogCheck];
}

function checkViewport(pages: QualityGatePage[]): QualityGateCheck {
  const missing: string[] = [];
  for (const page of pages) {
    const hasViewport = /<meta\s+[^>]*name\s*=\s*["']viewport["'][^>]*>/i.test(page.html);
    if (!hasViewport) missing.push(page.path);
  }
  return {
    id: "resp-viewport-meta",
    category: "responsive",
    status: missing.length === 0 ? "pass" : "fail",
    detail:
      missing.length === 0
        ? "Every page declares the viewport meta tag — mobile rendering uses the device width."
        : `${missing.length} page(s) miss the viewport meta tag — mobile browsers render at a ~980px desktop width and scale down, producing unreadable text.`,
    evidence: missing.slice(0, MAX_EVIDENCE).map((p) => ({ page: p, sample: "no viewport meta" })),
  };
}

function checkMediaQueries(
  stylesheets: QualityGateStylesheet[],
  pages: QualityGatePage[],
): QualityGateCheck {
  let found = 0;
  for (const sheet of stylesheets) {
    found += (sheet.css.match(/@media[\s\S]*?\{/gi) ?? []).length;
  }
  for (const page of pages) {
    const inlineStyles = [...page.html.matchAll(/<style[^>]*>([\s\S]*?)<\/style\s*>/gi)];
    for (const block of inlineStyles) {
      found += (block[1].match(/@media[\s\S]*?\{/gi) ?? []).length;
    }
  }
  if (stylesheets.length === 0 && pages.every((p) => !/<style/i.test(p.html))) {
    return {
      id: "resp-media-queries",
      category: "responsive",
      status: "not-run",
      detail: "No stylesheets were provided to this report — responsive CSS could not be assessed.",
      evidence: [],
    };
  }
  return {
    id: "resp-media-queries",
    category: "responsive",
    status: found > 0 ? "pass" : "warn",
    detail:
      found > 0
        ? `${found} @media breakpoint(s) found across the provided styles — the layout adapts at viewport widths.`
        : "No @media breakpoints found — the layout cannot adapt to smaller viewports. Verify with real browser QA before publishing.",
    evidence: [],
  };
}

function checkFixedWidth(
  stylesheets: QualityGateStylesheet[],
): QualityGateCheck {
  const evidence: QualityGateEvidence[] = [];
  let offenders = 0;
  const re = /(width|min-width)\s*:\s*(\d{3,5})px/gi;
  for (const sheet of stylesheets) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(sheet.css)) !== null) {
      const px = Number(m[2]);
      if (px >= FIXED_WIDTH_WARN_PX) {
        offenders += 1;
        if (evidence.length < MAX_EVIDENCE) {
          evidence.push({ page: sheet.path, sample: shorten(m[0]) });
        }
      }
    }
  }
  return {
    id: "resp-fixed-width",
    category: "responsive",
    status: offenders === 0 ? "pass" : "warn",
    detail:
      offenders === 0
        ? `No desktop-locked fixed widths (≥ ${FIXED_WIDTH_WARN_PX}px) outside media queries were found in the provided styles.`
        : `${offenders} fixed width declaration(s) ≥ ${FIXED_WIDTH_WARN_PX}px found — static analysis only; real overflow must be measured in a browser (see untested areas).`,
    evidence,
  };
}

interface AnchorInfo {
  href: string;
  text: string;
  page: string;
}

function collectAnchors(pages: QualityGatePage[]): AnchorInfo[] {
  const out: AnchorInfo[] = [];
  for (const page of pages) {
    let m: RegExpExecArray | null;
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
    while ((m = re.exec(page.html)) !== null) {
      out.push({
        href: attrValue(m[1], "href") ?? "",
        text: stripTags(m[2]),
        page: page.path,
      });
    }
  }
  return out;
}

const EXTERNAL_HREF = /^(https?:)?\/\//i;
const SKIP_SCHEME = /^(mailto:|tel:|data:)/i;

function resolveInternalTarget(href: string): string {
  let t = href.trim();
  const hash = t.indexOf("#");
  if (hash === 0) return ""; // same-page fragment
  if (hash > 0) t = t.slice(0, hash);
  if (!t) return "";
  t = t.replace(/^\.\//, "").replace(/^\//, "");
  if (t === "" || t.toLowerCase() === "index.html") return "index.html";
  return t;
}

function checkLinks(
  anchors: AnchorInfo[],
  knownPaths: Set<string>,
): QualityGateCheck[] {
  const scriptUrls: QualityGateEvidence[] = [];
  const placeholders: QualityGateEvidence[] = [];
  const emptyText: QualityGateEvidence[] = [];
  const brokenInternal: QualityGateEvidence[] = [];
  let internalChecked = 0;

  for (const a of anchors) {
    const href = a.href.trim();
    if (/^javascript:/i.test(href)) {
      scriptUrls.push({ page: a.page, sample: shorten(`<a href="${href}">${a.text}`) });
      continue;
    }
    if (EXTERNAL_HREF.test(href) || SKIP_SCHEME.test(href)) continue;
    if (href === "" || href === "#") {
      placeholders.push({ page: a.page, sample: shorten(`href="${href}" — ${a.text || "(no text)"}`) });
      continue;
    }
    if (!a.text) {
      emptyText.push({ page: a.page, sample: shorten(`<a href="${href}">(no text)`) });
    }
    const target = resolveInternalTarget(href);
    if (!target) continue; // pure same-page fragment
    internalChecked += 1;
    const candidates = new Set([
      target,
      target.endsWith(".html") ? target : `${target}.html`,
      `${target.replace(/\/$/, "")}/index.html`,
    ]);
    if (target.endsWith("/index.html")) candidates.add(target.replace(/\/index\.html$/, ""));
    const resolved = [...candidates].some((c) => knownPaths.has(c));
    if (!resolved) {
      brokenInternal.push({ page: a.page, sample: shorten(`href="${href}" — no such page in the artifact`) });
    }
  }

  const linkSafety: QualityGateCheck = {
    id: "links-safety",
    category: "links",
    status: scriptUrls.length > 0 ? "fail" : placeholders.length > 0 ? "warn" : "pass",
    detail:
      scriptUrls.length > 0
        ? `${scriptUrls.length} javascript: URL(s) — a hard safety smell; anchors must be real destinations or buttons.`
        : placeholders.length > 0
          ? `${placeholders.length} placeholder destination(s) ("", "#") — links must lead somewhere real or be visibly disabled.`
          : "No script URLs or placeholder destinations among the checked anchors.",
    evidence: [...scriptUrls, ...placeholders].slice(0, MAX_EVIDENCE),
  };

  const linkText: QualityGateCheck = {
    id: "links-text",
    category: "links",
    status: emptyText.length === 0 ? "pass" : "warn",
    detail:
      emptyText.length === 0
        ? "Every anchor has accessible text."
        : `${emptyText.length} anchor(s) have no text — screen readers announce a bare URL.`,
    evidence: emptyText.slice(0, MAX_EVIDENCE),
  };

  const internal: QualityGateCheck = {
    id: "links-internal",
    category: "links",
    status: brokenInternal.length === 0 ? "pass" : "fail",
    detail:
      internalChecked === 0
        ? "No internal page links to resolve."
        : brokenInternal.length === 0
          ? `All ${internalChecked} internal link(s) resolve to a page shipped in this artifact.`
          : `${brokenInternal.length} internal link(s) point to pages that do NOT exist in the artifact — visitors hit the 404/fallback.`,
    evidence: brokenInternal.slice(0, MAX_EVIDENCE),
  };

  return [linkSafety, linkText, internal];
}

function checkLocalAssets(
  pages: QualityGatePage[],
  stylesheets: QualityGateStylesheet[],
  knownPaths: Set<string>,
): QualityGateCheck {
  const broken: QualityGateEvidence[] = [];
  let checked = 0;
  const scan = (page: string, text: string, attrName: "src" | "href", tagRe: RegExp) => {
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(text)) !== null) {
      const attrs = m[1] ?? "";
      const val = attrValue(attrs, attrName);
      if (!val) continue;
      const v = val.trim();
      if (!v || EXTERNAL_HREF.test(v) || SKIP_SCHEME.test(v) || v.startsWith("#")) continue;
      if (/^javascript:/i.test(v)) continue;
      checked += 1;
      const t = v.replace(/^\.\//, "").replace(/^\//, "").split("#")[0].split("?")[0];
      if (t && !knownPaths.has(t)) {
        broken.push({ page, sample: shorten(`${v} — not shipped in the artifact`) });
      }
    }
  };
  for (const page of pages) {
    scan(page.path, page.html, "src", /<(?:img|script|source|video|audio)\b([^>]*)>/gi);
    scan(page.path, page.html, "href", /<link\b([^>]*)>/gi);
  }
  for (const sheet of stylesheets) {
    let m: RegExpExecArray | null;
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    while ((m = re.exec(sheet.css)) !== null) {
      const v = m[2].trim();
      if (!v || EXTERNAL_HREF.test(v) || SKIP_SCHEME.test(v) || v.startsWith("#") || v.startsWith("data:")) continue;
      checked += 1;
      const t = v.replace(/^\.\//, "").replace(/^\//, "").split("#")[0].split("?")[0];
      if (t && !knownPaths.has(t)) {
        broken.push({ page: sheet.path, sample: shorten(`url(${v}) — not shipped in the artifact`) });
      }
    }
  }
  return {
    id: "links-local-assets",
    category: "links",
    status: checked === 0 ? "pass" : broken.length === 0 ? "pass" : "fail",
    detail:
      checked === 0
        ? "No local asset references to resolve."
        : broken.length === 0
          ? `All ${checked} local asset reference(s) resolve to files shipped in the artifact.`
          : `${broken.length} local asset reference(s) point to files NOT shipped in the artifact — broken images/scripts/styles at render time.`,
    evidence: broken.slice(0, MAX_EVIDENCE),
  };
}

function checkImageDimensions(pages: QualityGatePage[]): QualityGateCheck {
  const evidence: QualityGateEvidence[] = [];
  let noDims = 0;
  let total = 0;
  for (const page of pages) {
    for (const img of scanTags(page.html, "img")) {
      total += 1;
      if (!hasAttr(img.attrs, "width") || !hasAttr(img.attrs, "height")) {
        noDims += 1;
        if (evidence.length < MAX_EVIDENCE) {
          evidence.push({ page: page.path, sample: shorten(img.full) });
        }
      }
    }
  }
  if (total === 0) {
    return {
      id: "perf-img-dimensions",
      category: "performance",
      status: "pass",
      detail: "No <img> elements found — nothing to check.",
      evidence: [],
    };
  }
  return {
    id: "perf-img-dimensions",
    category: "performance",
    status: noDims === 0 ? "pass" : "warn",
    detail:
      noDims === 0
        ? `All ${total} <img> element(s) declare width/height — the browser can reserve layout space (no CLS from images).`
        : `${noDims} of ${total} <img> element(s) lack width/height attributes — images shifting layout while loading (CLS risk). Static analysis only; real layout shift needs browser QA.`,
    evidence,
  };
}

function checkLazyImages(pages: QualityGatePage[]): QualityGateCheck {
  const evidence: QualityGateEvidence[] = [];
  const offenders: string[] = [];
  for (const page of pages) {
    const imgs = scanTags(page.html, "img");
    if (imgs.length <= IMAGES_LAZY_WARN) continue;
    const lazy = imgs.filter((i) => (attrValue(i.attrs, "loading") ?? "").toLowerCase() === "lazy");
    if (lazy.length === 0) {
      offenders.push(page.path);
      if (evidence.length < MAX_EVIDENCE) {
        evidence.push({
          page: page.path,
          sample: `${imgs.length} images, none with loading="lazy"`,
        });
      }
    }
  }
  return {
    id: "perf-img-lazy",
    category: "performance",
    status: offenders.length === 0 ? "pass" : "warn",
    detail:
      offenders.length === 0
        ? "Image-heavy pages (if any) use lazy loading."
        : `${offenders.length} image-heavy page(s) load every image eagerly — below-the-fold imagery should use loading="lazy".`,
    evidence,
  };
}

function checkInlineBudgets(pages: QualityGatePage[]): QualityGateCheck {
  const evidence: QualityGateEvidence[] = [];
  let offenders = 0;
  for (const page of pages) {
    for (const block of page.html.matchAll(/<style[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
      const bytes = Buffer.byteLength(block[1], "utf8");
      if (bytes > INLINE_STYLE_BUDGET) {
        offenders += 1;
        if (evidence.length < MAX_EVIDENCE) {
          evidence.push({ page: page.path, sample: `inline <style> ≈ ${(bytes / 1024).toFixed(0)} KB` });
        }
      }
    }
    for (const block of page.html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      const bytes = Buffer.byteLength(block[1], "utf8");
      if (bytes > INLINE_SCRIPT_BUDGET) {
        offenders += 1;
        if (evidence.length < MAX_EVIDENCE) {
          evidence.push({ page: page.path, sample: `inline <script> ≈ ${(bytes / 1024).toFixed(0)} KB` });
        }
      }
    }
  }
  return {
    id: "perf-inline-budget",
    category: "performance",
    status: offenders === 0 ? "pass" : "warn",
    detail:
      offenders === 0
        ? `Inline style/script blocks stay within the ${(INLINE_STYLE_BUDGET / 1024).toFixed(0)} KB per-block budget.`
        : `${offenders} oversized inline block(s) — large inline payloads cannot be cached across pages.`,
    evidence,
  };
}

function checkStylesheetCount(stylesheets: QualityGateStylesheet[]): QualityGateCheck {
  if (stylesheets.length === 0) {
    return {
      id: "perf-stylesheets",
      category: "performance",
      status: "not-run",
      detail: "No stylesheets were provided to this report.",
      evidence: [],
    };
  }
  const status = stylesheets.length > STYLESHEET_COUNT_WARN ? "warn" : "pass";
  return {
    id: "perf-stylesheets",
    category: "performance",
    status,
    detail:
      status === "pass"
        ? `${stylesheets.length} stylesheet(s) ship with the artifact.`
        : `${stylesheets.length} stylesheets ship with the artifact — each one is a render-blocking request; consider consolidating.`,
    evidence: [],
  };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Explicit, honest list of what static analysis cannot verify (Guide §4
 * Stage 11/12). Never presented as passing — it is a scope statement.
 */
export function untestedAreas(): string[] {
  return [
    "Runtime JS errors and unhandled rejections — only a real browser session can capture them.",
    "Horizontal overflow at real device widths (390/768/1024/1440) — static width heuristics are indicative only; use the studio browser checks or device QA.",
    "Font loading, swap behaviour and font-driven layout shift.",
    "prefers-reduced-motion behaviour of CSS/GSAP motion presets.",
    "Rendering under throttled/low-bandwidth network conditions.",
    "Real contrast of rendered text over images, gradients and video stills.",
    "Keyboard focus order, visible focus and screen-reader announcement quality on the live DOM.",
  ];
}

export function runQualityGate(input: QualityGateInput): QualityGateReport {
  const maxPages = Math.max(1, input.maxPages ?? MAX_PAGES_DEFAULT);
  const pages = input.pages
    .filter((p) => typeof p.html === "string" && p.html.length <= MAX_HTML_BYTES)
    .slice(0, maxPages);

  const stylesheets = (input.stylesheets ?? []).slice(0, 24);
  const knownPaths = new Set<string>([
    ...(input.localFiles ?? []).map((p) => p.replace(/^\.\//, "").replace(/^\//, "")),
    ...pages.map((p) => p.path.replace(/^\.\//, "").replace(/^\//, "")),
    ...stylesheets.map((s) => s.path.replace(/^\.\//, "").replace(/^\//, "")),
  ]);

  const anchors = collectAnchors(pages);

  const checks: QualityGateCheck[] = [
    checkImagesAlt(pages),
    checkHtmlLang(pages),
    checkHeadingOrder(pages),
    checkFormLabels(pages),
    checkContrast(input.palette),
    ...checkSeoMeta(pages),
    checkViewport(pages),
    checkMediaQueries(stylesheets, pages),
    checkFixedWidth(stylesheets),
    ...checkLinks(anchors, knownPaths),
    checkLocalAssets(pages, stylesheets, knownPaths),
    checkImageDimensions(pages),
    checkLazyImages(pages),
    checkInlineBudgets(pages),
    checkStylesheetCount(stylesheets),
  ];

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const overall: QualityGateReport["overall"] = fails > 0 ? "needs-work" : warns > 2 ? "acceptable" : "strong";

  const summary =
    fails > 0
      ? `${fails} blocking finding(s) and ${warns} warning(s) across ${pages.length} page(s) — fix the blocking findings before publishing.`
      : warns > 0
        ? `No blocking findings; ${warns} warning(s) across ${pages.length} page(s) worth addressing.`
        : `All ${checks.filter((c) => c.status !== "not-run").length} static checks passed across ${pages.length} page(s).`;

  return {
    overall,
    summary,
    pagesChecked: pages.length,
    checks,
    untested: untestedAreas(),
  };
}
