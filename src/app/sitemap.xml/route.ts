import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { publicOwnerFilter, publicProfileBaseFilter } from "@/lib/visibility";
import { resolveCrawlerOrigin } from "@/lib/seo-origin";
import { publicProfilePath } from "@/lib/site-url";

export const dynamic = "force-dynamic";

/**
 * GET /sitemap.xml — eligible public pages.
 *
 * Public portfolio addresses are the PATH form — `https://<origin>/u/<username>`
 * (the BEAN Folio public profile) and `https://<origin>/p/<id>` (projects) —
 * served at the path for direct requests by src/proxy.ts (the SPA document is
 * served there with the route seeded via x-bean-boot-route). That is the form
 * crawlers must index: hash fragments (`/#/u/...`) are stripped by crawlers
 * and would be useless entries.
 *
 * The sitemap lists the real addresses of the publicly eligible pages — the
 * root feed, every PUBLIC non-demo non-deleted profile that has a username,
 * and every PUBLISHED+PUBLIC project owned by such a profile (the same
 * server-side visibility ladder used by every public surface — drafts,
 * private profiles and demo fixtures are structurally excluded).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const origin = resolveCrawlerOrigin(req);

  const urls: { loc: string; lastmod?: string }[] = [{ loc: `${origin}/` }];

  try {
    const profiles = await db.user.findMany({
      where: {
        username: { not: null },
        profileVisibility: "PUBLIC",
        ...publicProfileBaseFilter,
        // Eligible = the profile page carries real published work to index.
        projects: { some: { status: "PUBLISHED", visibility: "PUBLIC" } },
      },
      select: { username: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 1000,
    });
    for (const p of profiles) {
      const profilePath = publicProfilePath(p.username);
      if (profilePath) {
        urls.push({
          loc: `${origin}${profilePath}`,
          lastmod: p.updatedAt.toISOString().slice(0, 10),
        });
      }
    }

    const projects = await db.project.findMany({
      where: {
        status: "PUBLISHED",
        visibility: "PUBLIC",
        owner: publicOwnerFilter,
      },
      select: { id: true, publishedAt: true },
      orderBy: { publishedAt: "desc" },
      take: 1000,
    });
    for (const p of projects) {
      urls.push({
        loc: `${origin}/p/${p.id}`,
        lastmod: (p.publishedAt ?? new Date(0)).toISOString().slice(0, 10),
      });
    }

    // Creator social posts — indexable ONLY when PUBLISHED + PUBLIC and the
    // author passes the live public-visibility ladder (lib/visibility.ts);
    // private posts, drafts, demo fixtures and soft-deleted authors are
    // structurally excluded by the same where-clause the API serves.
    const posts = await db.post.findMany({
      where: {
        status: "PUBLISHED",
        visibility: "PUBLIC",
        author: publicOwnerFilter,
      },
      select: { id: true, updatedAt: true },
      orderBy: { createdAt: "desc" },
      take: 1000,
    });
    for (const p of posts) {
      urls.push({
        loc: `${origin}/post/${p.id}`,
        lastmod: p.updatedAt.toISOString().slice(0, 10),
      });
    }
  } catch {
    // A database hiccup must not break the sitemap entirely — the root entry
    // alone is still valid and truthful.
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(
      (u) =>
        `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`
    ),
    "</urlset>",
    "",
  ].join("\n");

  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
