import type { Metadata } from "next";
import { headers } from "next/headers";

import SiteShell from "@/components/bean/SiteShell";
import { getPublicProfileMeta } from "@/lib/public-profile";
import { seoOrigin, publicProfilePath } from "@/lib/site-url";
import { SEO_DEFAULTS } from "@/lib/seo-defaults";

/**
 * The application's single document (hash-routed SPA — see lib/hash-router).
 *
 * Public ROUTE-FORM URLs (`/u/<username>`, `/p/<id>`, `/site/<username>`) are
 * served AT the path by src/proxy.ts, which rewrites the request to this
 * document and seeds the intended route in the `x-bean-boot-route` request
 * header. Reading that header here passes the boot route into the client
 * shell, so the server render, the hydration snapshot and the visible route
 * all agree from the first paint — a published website opens directly as the
 * creator's own site (site skeleton, platform chrome suppressed) and never
 * flashes the Discover feed.
 *
 * Reading headers() makes this document render dynamically per request; the
 * SPA fetches all data client-side, so no per-route static HTML is lost.
 */
export const dynamic = "force-dynamic";

const BOOT_ROUTE_RE = /^\/(u|p|post)\/[^/]+$|^\/site\/[^/]+(?:\/[^/]+)?$/;

/**
 * Server-side SEO/social metadata for public portfolio paths (P3).
 *
 * When the document is served AT `/u/<username>`, the initial HTML now
 * carries the creator's real title/description/canonical/og tags — crawlers
 * that never execute JavaScript (social cards, search bots) no longer fall
 * back to the generic app metadata. Data comes ONLY from the public,
 * viewer-independent payload path (lib/public-profile): demo fixtures and
 * PRIVATE profiles resolve to null → the document emits the default metadata
 * with `noindex` so a draft/private profile can never leak its name, bio or
 * imagery through metadata. The client-side SEO manager (lib/seo) continues
 * to own the live document head after hydration — the two paths compose,
 * they never disagree on public data.
 */
export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const seeded = h.get("x-bean-boot-route");
  const bootRoute = seeded && BOOT_ROUTE_RE.test(seeded) ? seeded : null;

  if (!bootRoute) {
    // The app shell keeps the platform defaults.
    return {
      title: SEO_DEFAULTS.title,
      description: SEO_DEFAULTS.description,
    };
  }

  // `/post/<id>` — public creator posts get REAL post metadata (caption,
  // author, media). Restricted content resolves to null → noindex, never
  // leaking a private post's existence through metadata.
  if (bootRoute.startsWith("/post/")) {
    const { getPublicPostMeta } = await import("@/lib/public-post");
    const post = await getPublicPostMeta(decodeURIComponent(bootRoute.slice(6))).catch(() => null);
    if (!post) {
      return {
        title: SEO_DEFAULTS.title,
        description: SEO_DEFAULTS.description,
        robots: { index: false, follow: false },
      };
    }
    const origin = seoOrigin();
    const canonical = `/post/${post.id}`;
    const title = `${post.authorName}: ${post.excerpt ?? (post.mediaKind === "VIDEO" ? "a new reel" : "a new post")}`.slice(0, 120);
    const ogImage = origin && post.imageMediaId ? `${origin}/api/media/${post.imageMediaId}/raw` : null;
    const ogVideo = origin && post.videoMediaId ? `${origin}/api/media/${post.videoMediaId}/raw` : null;
    return {
      title,
      description: post.description ?? SEO_DEFAULTS.description,
      keywords: post.hashtags.length > 0 ? post.hashtags : undefined,
      ...(origin ? { alternates: { canonical: `${origin}${canonical}` } } : {}),
      openGraph: {
        title,
        description: post.description ?? SEO_DEFAULTS.description,
        type: "article",
        publishedTime: post.createdAt.toISOString(),
        ...(origin ? { url: `${origin}${canonical}` } : {}),
        ...(ogImage ? { images: [{ url: ogImage }] } : {}),
        ...(ogVideo ? { videos: [{ url: ogVideo }] } : {}),
      },
      twitter: {
        card: ogImage ? "summary_large_image" : "summary",
        title,
        description: post.description ?? SEO_DEFAULTS.description,
        ...(ogImage ? { images: [ogImage] } : {}),
      },
    };
  }

  if (!bootRoute.startsWith("/u/")) {
    // /p/<id> project deep links keep platform defaults (payload is viewer-
    // dependent). Crawlers land on the same canonical the client SEO
    // manager would emit.
    return {
      title: SEO_DEFAULTS.title,
      description: SEO_DEFAULTS.description,
    };
  }

  const username = decodeURIComponent(bootRoute.slice(3));
  const meta = await getPublicProfileMeta(username).catch(() => null);

  if (!meta) {
    // Not publicly visible (missing, demo fixture, PRIVATE, or soft-deleted):
    // generic + noindex. We deliberately do NOT reveal whether the profile
    // exists privately.
    return {
      title: SEO_DEFAULTS.title,
      description: SEO_DEFAULTS.description,
      robots: { index: false, follow: false },
    };
  }

  const title = meta.siteName?.trim()
    ? `${meta.siteName} — BEAN Folio`
    : meta.headline?.trim()
      ? `${meta.name} — ${meta.headline}`
      : `${meta.name} — BEAN Folio`;
  const description =
    meta.siteTagline?.trim() ||
    meta.bio?.trim().slice(0, 200) ||
    meta.headline?.trim() ||
    `See ${meta.name}'s portfolio on BEAN Folio.`;

  const origin = seoOrigin();
  const canonical = publicProfilePath(meta.username);
  const ogImage = origin && meta.avatarMediaId ? `${origin}/api/media/${meta.avatarMediaId}/raw` : null;

  return {
    title,
    description,
    ...(canonical && origin ? { alternates: { canonical: `${origin}${canonical}` } } : {}),
    openGraph: {
      title,
      description,
      type: "profile",
      ...(origin && canonical ? { url: `${origin}${canonical}` } : {}),
      ...(ogImage ? { images: [{ url: ogImage }] } : {}),
    },
    twitter: {
      card: ogImage ? "summary_large_image" : "summary",
      title,
      description,
      ...(ogImage ? { images: [ogImage] } : {}),
    },
  };
}

export default async function Home() {
  const h = await headers();
  const seeded = h.get("x-bean-boot-route");
  // Only ever trust a well-formed seed — the header is set by our own proxy,
  // but this document also renders for every unproxied request (boot = null).
  const bootRoute = seeded && BOOT_ROUTE_RE.test(seeded) ? seeded : null;
  return <SiteShell bootRoute={bootRoute} />;
}
