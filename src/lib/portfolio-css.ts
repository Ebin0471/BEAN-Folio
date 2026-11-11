/**
 * Portfolio custom-CSS sanitizer + scoper (advanced mode).
 *
 * Users can attach a small stylesheet to their own portfolio. Two risks must
 * be handled: (1) dangerous constructs, (2) leaking styles onto the parent
 * application shell (header, session UI, other pages).
 *
 * Approach (documented in docs/portfolio-studio.md):
 * - Hard-strip: comments, `</style>`-breakouts, `@import`, javascript/data:
 *   URLs, `-moz-binding`/`behavior`, `@charset`, and control characters.
 * - Scope: every selector is prefixed with `[data-pf]` so rules only apply
 *   inside the portfolio root element. `html`, `body`, `:root` selectors are
 *   rewritten to the portfolio root — custom CSS cannot restyle the app shell.
 *   At-rules (`@media`, `@supports`, `@container`, `@layer`) recurse; keyframe
 *   bodies are preserved untouched.
 * - Size cap 8000 chars enforced here AND by the zod schema.
 *
 * This is a pragmatic parser for well-formed CSS. Malformed input degrades to
 * "best-effort scoping"; nothing can escape the attribute prefix, and output
 * is always injected as textContent of a <style> tag (no HTML parsing).
 */

const MAX_CSS = 8000;

function stripDangerous(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, " ") // comments
    .replace(/[<>]/g, " ") // no HTML breakouts
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "") // control chars
    .replace(/@import[^;{]*(;|(?=\}))/gi, " ")
    .replace(/@charset[^;]*(;)?/gi, " ")
    .replace(/expression\s*\(/gi, " ")
    .replace(/(-moz-)?binding\s*:[^;}]*(;)?/gi, " ")
    .replace(/behaviou?r\s*:[^;}]*(;)?/gi, " ")
    .replace(/url\s*\(\s*(['"]?)\s*(javascript|data|vbscript):[^;}]*\)?/gi, "none");
}

interface Ctx {
  out: string[];
  scope: string;
}

function scopeSelectorList(selector: string, scope: string): string {
  // Split on top-level commas (not inside (), [], or strings).
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  let quote: string | null = null;
  for (const ch of selector) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf.trim());

  const scoped = parts
    .filter(Boolean)
    .map((sel) => {
      if (sel === scope || sel.startsWith(scope)) return sel;
      // Rewrite global selectors onto the portfolio root.
      sel = sel.replace(/^(html|body|:root)\b/gi, scope);
      if (sel === scope || sel.startsWith(scope)) return sel;
      if (sel.startsWith("&")) return sel.replace("&", scope);
      return `${scope} ${sel}`;
    })
    .join(", ");
  return scoped;
}

function transformBlock(css: string, ctx: Ctx, depth: number): void {
  if (depth > 6 || !css.trim()) return;
  let i = 0;
  const n = css.length;
  while (i < n) {
    // Read prelude up to '{' or ';'
    let prelude = "";
    while (i < n && css[i] !== "{" && css[i] !== ";") {
      prelude += css[i];
      i++;
    }
    prelude = prelude.trim();
    if (i >= n) {
      if (prelude) ctx.out.push(prelude + ";");
      return;
    }
    if (css[i] === ";") {
      i++; // stray declaration — drop
      continue;
    }
    // '{' — read matching body
    i++;
    let body = "";
    let d = 1;
    while (i < n && d > 0) {
      const ch = css[i];
      if (ch === "{") d++;
      else if (ch === "}") d--;
      if (d === 0) break;
      body += ch;
      i++;
    }
    i++; // skip closing '}'

    if (prelude.startsWith("@")) {
      const name = (prelude.match(/^@([\w-]+)/)?.[1] ?? "").toLowerCase();
      if (name === "media" || name === "supports" || name === "container" || name === "layer") {
        ctx.out.push(`${prelude}{`);
        transformBlock(body, ctx, depth + 1);
        ctx.out.push("}");
      } else {
        // @keyframes / @font-face / @property / unknown: preserve body verbatim
        ctx.out.push(`${prelude}{${body}}`);
      }
    } else {
      const scoped = scopeSelectorList(prelude, ctx.scope);
      if (scoped) ctx.out.push(`${scoped}{${body}}`);
    }
  }
}

export function sanitizePortfolioCss(raw: string, scope = "[data-pf]"): string {
  if (!raw || !raw.trim()) return "";
  const cleaned = stripDangerous(raw).slice(0, MAX_CSS);
  const ctx: Ctx = { out: [], scope };
  transformBlock(cleaned, ctx, 0);
  const out = ctx.out.join(" ").replace(/\s{2,}/g, " ").trim();
  return out.slice(0, MAX_CSS);
}
