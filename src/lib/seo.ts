"use client";

import { useEffect } from "react";
import { seoOrigin } from "@/lib/site-url";

/**
 * Client-side SEO manager for the hash-routed SPA.
 *
 * BEAN Folio renders every route inside the single `/` document (hash routes
 * like `/#/u/ada`), so per-page metadata is applied to the live document head
 * whenever a route's data resolves. Crawlers that execute JavaScript read these
 * tags; the sandbox's single-visible-route constraint is documented honestly in
 * the worklog — social crawlers that do not execute JS fall back to the static
 * layout defaults, never to fabricated content.
 *
 * Tags managed (idempotent, one instance each):
 *   <title>, meta[description], meta[robots], link[canonical],
 *   og:title/description/type/url/image, twitter:card/title/description/image,
 *   one JSON-LD script (bean-seo-jsonld).
 */

// Re-exported from the server-safe module so existing client imports keep
// working and the server document metadata reads the exact same constants.
import { SEO_DEFAULTS } from "./seo-defaults";
export { SEO_DEFAULTS };

export interface SeoInput {
  title: string;
  description: string;
  /** Route path for the canonical URL, e.g. "/u/ada". Defaults to the current route.
   *  Public portfolio paths (u/…, p/…) get a PATH-form canonical; other routes
   *  keep the hash form (see canonicalUrl). */
  path?: string;
  /** Open Graph type. */
  type?: "website" | "profile" | "article";
  /** Absolute or root-relative preview image (og:image + twitter:image). */
  image?: string | null;
  /** Emits <meta name="robots" content="noindex,nofollow"> when true. */
  noindex?: boolean;
  /** JSON-LD structured data object (replaces any previous one). Null removes it. */
  jsonLd?: Record<string, unknown> | null;
}

/**
 * Absolute canonical URL for metadata (link[canonical] + og:url). Built from
 * the VERIFIED configured production origin only (see lib/site-url) — never
 * from window.location, so a workspace/sandbox/preview host can never leak
 * into shared/social metadata. Returns null when no production origin is
 * configured: callers then OMIT the absolute URL rather than emit a wrong one.
 *
 * Form: public portfolio routes (`u/<username>`, `p/<id>`, `site/<username>`)
 * and public creator posts (`post/<id>`) are served AT the path by
 * src/proxy.ts (boot-route seeding) — their canonical is the plain path, no
 * fragment. Every other route lives only inside the hash router on the
 * single `/` document and keeps the hash-form canonical (documented
 * limitation of the SPA architecture).
 */
function canonicalUrl(path?: string): string | null {
  const origin = seoOrigin();
  if (!origin) return null;
  const p = path ?? (typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") || "/" : "/");
  const normalized = p.startsWith("/") ? p : `/${p}`;
  if (/^\/(u|p|site|post)\//.test(normalized)) return `${origin}${normalized}`;
  return `${origin}/#${normalized}`;
}

/**
 * Absolute og:image/twitter:image URL. Prefixed with the verified configured
 * origin when one exists; otherwise returned root-relative as-is (scrapers
 * resolve it against the serving origin) — never prefixed with the current
 * preview host.
 */
function absoluteImage(src: string | null | undefined): string | null {
  if (!src) return null;
  if (src.startsWith("http://") || src.startsWith("https://")) return src;
  const origin = seoOrigin();
  if (!origin) return src;
  return `${origin}${src.startsWith("/") ? src : `/${src}`}`;
}

function upsertMeta(attr: "name" | "property", key: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    markSeoManaged(el);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

/**
 * React-ownership boundary for the document head.
 *
 * React 19 (App Router) renders <head> metadata (title, description, canonical,
 * og:*) as its own hoistable nodes and keeps fiber references to them. Manually
 * REMOVING such a node desynchronizes React's bookkeeping: the next deletion
 * pass that touches those fibers crashes inside commitDeletion/
 * commitMutation effects with
 *   TypeError: Cannot read properties of null (reading 'removeChild')
 * — exactly when views unmount, i.e. on every route change.
 *
 * Rule enforced here: nodes this module CREATED are marked with
 * data-bean-seo and may be removed; foreign nodes (server/React-rendered) are
 * never removed — they are neutralized IN PLACE by dropping the attribute that
 * gives them effect (href on canonical, content on og:url). Attribute writes
 * are not structural and cannot corrupt React's virtual-DOM bookkeeping.
 */
const SEO_MANAGED = "data-bean-seo";

function markSeoManaged(el: Element): void {
  el.setAttribute(SEO_MANAGED, "");
}

/** Remove the node only when this module created it; never remove React's. */
function removeIfSeoManaged(el: Element | null): void {
  if (el && el.hasAttribute(SEO_MANAGED)) el.remove();
}

/** Apply SEO metadata to the document head. Client-side only (no-op on SSR). */
export function applySeo(input: SeoInput): void {
  if (typeof document === "undefined") return;

  const url = canonicalUrl(input.path);
  const image = absoluteImage(input.image);

  document.title = input.title;
  upsertMeta("name", "description", input.description);
  upsertMeta("name", "robots", input.noindex ? "noindex, nofollow" : "index, follow");

  // Canonical link + og:url are emitted ONLY with a verified production
  // origin; stale values from a previous application are neutralized
  // otherwise so an internal/preview address is never left in the head.
  let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (url) {
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      markSeoManaged(canonical);
      document.head.appendChild(canonical);
    }
    canonical.href = url;
  } else if (canonical) {
    if (canonical.hasAttribute(SEO_MANAGED)) {
      canonical.remove();
    } else {
      // React/server-owned canonical — keep the node, drop its effect.
      canonical.removeAttribute("href");
    }
  }
  const ogUrl = document.head.querySelector<HTMLMetaElement>('meta[property="og:url"]');
  if (url) {
    upsertMeta("property", "og:url", url);
  } else if (ogUrl) {
    if (ogUrl.hasAttribute(SEO_MANAGED)) ogUrl.remove();
    else ogUrl.removeAttribute("content");
  }

  upsertMeta("property", "og:title", input.title);
  upsertMeta("property", "og:description", input.description);
  upsertMeta("property", "og:type", input.type ?? "website");
  upsertMeta("property", "og:site_name", SEO_DEFAULTS.siteName);
  if (image) upsertMeta("property", "og:image", image);

  upsertMeta("name", "twitter:card", image ? "summary_large_image" : "summary");
  upsertMeta("name", "twitter:title", input.title);
  upsertMeta("name", "twitter:description", input.description);
  if (image) upsertMeta("name", "twitter:image", image);

  let jsonLd = document.getElementById("bean-seo-jsonld");
  if (input.jsonLd) {
    if (!jsonLd) {
      jsonLd = document.createElement("script");
      jsonLd.id = "bean-seo-jsonld";
      (jsonLd as HTMLScriptElement).type = "application/ld+json";
      markSeoManaged(jsonLd);
      document.head.appendChild(jsonLd);
    }
    jsonLd.textContent = JSON.stringify(input.jsonLd);
  } else {
    removeIfSeoManaged(jsonLd);
  }
}

/**
 * React hook: applies the given SEO metadata whenever it changes.
 * Pass the same object identity across renders to apply once per data load —
 * callers normally memoize the input from loaded data.
 */
export function useSeo(input: SeoInput | null): void {
  useEffect(() => {
    if (input) applySeo(input);
  }, [input]);
}
