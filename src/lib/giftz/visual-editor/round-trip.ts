/**
 * BEAN Folio — GIFTZ visual-editor round-trip helpers (pure, DOM-free).
 *
 * M3/M4: the GrapesJS-based visual editor operates on the EXISTING GIFTZ
 * project files — it never introduces a parallel site format. This module
 * holds the pure analysis that decides HOW a page can be edited safely:
 *
 * - which local stylesheets the page links (`analyzePageStyles`),
 * - whether the page is visually editable AT ALL (the round-trip contract:
 *   exactly ONE local stylesheet, or inline <style> only — multi-stylesheet
 *   or externally-hosted styling is refused with an explanation, and full
 *   code editing stays available),
 * - the save payload split (page HTML → its path, exported CSS → the
 *   stylesheet path).
 *
 * The verification evidence for the round-trip itself (import → export →
 * structural diff on representative GIFTZ output) lives in
 * `scripts/poc/giftz-visual-editor-roundtrip/` and is summarized in
 * `docs/oss/website-editor-evaluation.md`.
 */

export interface PageStyleAnalysis {
  /** Local stylesheet paths linked from the page (<link rel=stylesheet href=…>), in order. */
  localStylesheets: string[];
  /** External (http/https/protocol-relative) stylesheet refs — unsupported for visual editing. */
  externalStylesheets: string[];
  /** The page has inline <style> blocks (their CSS rides inside the page round-trip). */
  hasInlineStyles: boolean;
  /** Inline <script> blocks or local/external <script src> — preserved verbatim by the editor round-trip. */
  scriptCount: number;
  /** Verdict: can the visual editor round-trip this page safely? */
  editable: boolean;
  /** When not editable, the honest reason shown to the creator. */
  notEditableReason: string | null;
  /** The single stylesheet path when editable via a linked file (null for inline-only pages). */
  stylesheetPath: string | null;
}

const LINK_TAG_RE = /<link\b[^>]*>/gi;
const HREF_ATTR_RE = /href\s*=\s*["']([^"']+)["']/i;
const REL_ATTR_RE = /rel\s*=\s*["']([^"']+)["']/i;
const STYLE_OPEN_RE = /<style\b[^>]*>/i;
const SCRIPT_RE = /<script\b[^>]*>/gi;

function isExternalRef(ref: string): boolean {
  return /^(?:https?:)?\/\//i.test(ref) || ref.startsWith("data:") || ref.startsWith("mailto:");
}

/**
 * Resolve a local href against the page directory (mirrors the build
 * validator's rule): leading "/" is project-rooted, otherwise relative to
 * the page's directory.
 */
export function resolveProjectRef(href: string, pagePath: string): string {
  const cleaned = href.split("?")[0].split("#")[0].trim();
  if (cleaned.startsWith("/")) return cleaned.replace(/^\/+/, "");
  const dir = pagePath.includes("/") ? pagePath.slice(0, pagePath.lastIndexOf("/") + 1) : "";
  const parts: string[] = [];
  for (const seg of `${dir}${cleaned}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Analyze a page's styling structure for visual-editing eligibility.
 * The GIFTZ generated sites link exactly one project stylesheet per page —
 * that shape round-trips safely; anything else is honestly refused.
 */
export function analyzePageStyles(html: string, pagePath: string): PageStyleAnalysis {
  const localStylesheets: string[] = [];
  const externalStylesheets: string[] = [];

  for (const tag of html.match(LINK_TAG_RE) ?? []) {
    const rel = REL_ATTR_RE.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!rel.split(/\s+/).includes("stylesheet")) continue;
    const href = HREF_ATTR_RE.exec(tag)?.[1] ?? "";
    if (!href) continue;
    if (isExternalRef(href)) {
      externalStylesheets.push(href);
      continue;
    }
    localStylesheets.push(resolveProjectRef(href, pagePath));
  }

  const hasInlineStyles = STYLE_OPEN_RE.test(html);
  const scriptCount = (html.match(SCRIPT_RE) ?? []).length;

  let editable = true;
  let notEditableReason: string | null = null;
  let stylesheetPath: string | null = null;

  if (externalStylesheets.length > 0) {
    editable = false;
    notEditableReason = `This page loads external stylesheets (${externalStylesheets.join(", ")}) that the visual editor cannot round-trip safely. Edit it in the Code workspace instead.`;
  } else if (localStylesheets.length > 1) {
    editable = false;
    notEditableReason = `This page links ${localStylesheets.length} project stylesheets (${localStylesheets.join(", ")}). The visual editor round-trips one stylesheet per page — edit it in the Code workspace instead.`;
  } else if (localStylesheets.length === 1) {
    stylesheetPath = localStylesheets[0];
  }
  // Zero stylesheets (with or without inline styles): trivially editable —
  // GrapesJS starts from the page's inline styles or an empty style sheet.

  return { localStylesheets, externalStylesheets, hasInlineStyles, scriptCount, editable, notEditableReason, stylesheetPath };
}

/** Extract inline <style> block contents (for pages without a linked stylesheet). */
export function extractInlineStyles(html: string): string[] {
  const out: string[] = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1] ?? "");
  }
  return out;
}

export interface VisualSavePayload {
  /** The exported page HTML — written back to the page path. */
  html: string;
  /** The exported CSS — written back to stylesheetPath when the page uses one. */
  css: string | null;
  /** The stylesheet path the CSS belongs to (null for inline-only pages). */
  cssPath: string | null;
}

/**
 * Wrap exported content back into the project's file layout. For
 * linked-stylesheet pages the exported HTML keeps its <link> (the build
 * validator and serving rely on it) and the exported CSS goes back to the
 * stylesheet file. For inline-style pages the exported CSS is re-injected
 * into a <style> block so the file keeps working in the existing pipeline.
 */
export function buildVisualSavePayload(
  exportedHtml: string,
  exportedCss: string,
  analysis: PageStyleAnalysis
): VisualSavePayload {
  if (analysis.stylesheetPath) {
    return { html: exportedHtml, css: exportedCss, cssPath: analysis.stylesheetPath };
  }
  let html = exportedHtml;
  if (/<style[^>]*data-bean-visual[^>]*>[\s\S]*?<\/style>/i.test(html)) {
    html = html.replace(
      /<style[^>]*data-bean-visual[^>]*>[\s\S]*?<\/style>/i,
      exportedCss.trim().length > 0 ? `<style data-bean-visual="1">${exportedCss}</style>` : ""
    );
  } else if (exportedCss.trim().length > 0 && /<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `<style data-bean-visual="1">${exportedCss}</style></head>`);
  }
  return { html, css: null, cssPath: null };
}

// ------------------------------------------------- document round-trip (M3 PoC evidence)

const HEAD_ITEM_START_RE =
  /^\s*(?:<meta\b[^>]*>|<title\b[^>]*>[\s\S]*?<\/title>|<link\b[^>]*>|<style\b[^>]*>[\s\S]*?<\/style>)/i;

/**
 * Strip the head items GrapesJS flattens into the start of its body export
 * (they are preserved VERBATIM from the original document instead).
 */
export function stripLeadingHeadItems(exported: string): string {
  let out = exported.trimStart();
  let m: RegExpExecArray | null;
  while ((m = HEAD_ITEM_START_RE.exec(out)) !== null) {
    out = out.slice(m[0].length).trimStart();
  }
  return out;
}

export interface ScriptRef {
  tag: string;
  /** true when the script sits in <head> (already preserved by the head splice). */
  inHead: boolean;
}

/** Extract every <script> tag verbatim, flagging head vs body position. */
export function extractScripts(html: string): ScriptRef[] {
  const headEnd = /<\/head>/i.exec(html);
  const headEndIdx = headEnd ? headEnd.index : 0;
  const out: ScriptRef[] = [];
  const re = /<script\b[\s\S]*?<\/script>|<script\b[^>]*\/>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({ tag: m[0], inHead: m.index < headEndIdx });
  }
  return out;
}

/** Body attributes from the original document (`class="x" ...` or ""). */
export function extractBodyAttrs(html: string): string {
  const m = /<body\b([^>]*)>/i.exec(html);
  return (m?.[1] ?? "").trim();
}

/** The document prefix (everything up to and including </head>) — preserved verbatim. */
export function extractHeadBlock(html: string): string {
  const m = /[\s\S]*?<\/head>/i.exec(html);
  return m ? m[0] : "";
}

/**
 * Inject the page's CSS as an editor-managed <style> block so GrapesJS parses
 * the FULL stylesheet into its CSS composer (PoC-verified: the separate
 * `styles` project-data entry round-trips only partially; the in-document
 * style block round-trips completely). The block carries a marker id so it
 * can never be confused with creator styles.
 */
export function buildEditorHtml(html: string, css: string): string {
  if (!css.trim()) return html;
  const block = `<style id="bean-visual-css">${css}</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${block}</head>`);
  return `${html}${block}`;
}

/**
 * Rebuild the real project file from the editor's export.
 *
 * Preservation strategy (PoC-verified against representative GIFTZ output):
 * - HEAD: the original head block is kept VERBATIM — meta, charset/viewport,
 *   title/SEO, the stylesheet <link>, head scripts and JSON-LD never pass
 *   through the editor model, so nothing can be dropped there.
 * - BODY: the exported (visually edited) body content, with the head items
 *   GrapesJS flattened into it stripped (they exist in the head) and the
 *   original BODY scripts re-injected verbatim before </body> (the editor
 *   model does not serialize scripts; creators edit them in the Code
 *   workspace — the visual editor must never silently remove them).
 * - Document wrapper (doctype, <html lang>): taken from the ORIGINAL
 *   document (the editor exports only the wrapper's children).
 */
export function reconstructDocument(
  originalHtml: string,
  exportedHtml: string
): { html: string; reattachedScripts: number } {
  const doctype = /<!DOCTYPE\s+html[^>]*>/i.exec(originalHtml)?.[0] ?? "<!DOCTYPE html>";
  const head = extractHeadBlock(originalHtml);
  const bodyAttrs = extractBodyAttrs(originalHtml);
  const bodyScripts = extractScripts(originalHtml).filter((s) => !s.inHead);

  let bodyContent = stripLeadingHeadItems(exportedHtml);
  // If the export carries its own <body> wrapper (some flows), unwrap it.
  const bodyMatch = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(bodyContent);
  if (bodyMatch) bodyContent = bodyMatch[1];
  bodyContent = bodyContent.trimEnd();
  // The original closing structure after </head> (</body></html> tail).
  const originalTail = /<\/body>\s*<\/html>\s*$/i.test(originalHtml) ? "</body></html>" : "</body></html>";

  const scriptBlock = bodyScripts.length > 0 ? `\n${bodyScripts.map((s) => s.tag).join("\n")}` : "";
  const html = `${doctype}\n${head}\n<body${bodyAttrs ? ` ${bodyAttrs}` : ""}>\n${bodyContent}${scriptBlock}\n${originalTail}`;
  return { html, reattachedScripts: bodyScripts.length };
}
