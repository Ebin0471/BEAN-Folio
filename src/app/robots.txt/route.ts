import { NextRequest } from "next/server";
import { resolveCrawlerOrigin } from "@/lib/seo-origin";

export const dynamic = "force-dynamic";

/**
 * GET /robots.txt — crawler directives for the whole origin.
 *
 * This route is the SINGLE source of truth for robots.txt. A static
 * public/robots.txt must never exist alongside it: Next.js treats that as a
 * conflicting public file and page and responds 500 on /robots.txt (verified
 * in this repo — the stale scaffold file was removed). Do not re-add
 * public/robots.txt.
 *
 * Hash fragments (`#/...`) never reach the server, so per-page crawl rules are
 * delivered as client-side robots meta tags (see src/lib/seo.ts — private
 * workspace routes emit noindex). This file keeps crawlers out of the JSON API
 * and points to the sitemap of eligible public pages.
 *
 * Origin preference (see lib/seo-origin): NEXT_PUBLIC_APP_URL → VERCEL_URL →
 * the serving request's forwarded headers.
 */
export function GET(req: NextRequest): Response {
  const origin = resolveCrawlerOrigin(req);

  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
