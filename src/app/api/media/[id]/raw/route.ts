import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ERR, handler } from "@/lib/api-helpers";
import { getObject, getObjectRange, getObjectSize } from "@/lib/storage";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Post media authorization (creator social feed). An asset linked through a
 * PostMedia row (as the media itself OR as the poster frame) is viewable
 * exactly when the post itself is viewable under the same ladder the feed
 * and /api/posts/:id use (loadViewablePost):
 *  - the post's PUBLISHED + PUBLIC and its author is a live, non-demo,
 *    publicly-visible account: allowed for EVERYONE (anonymous included),
 *    publicly cacheable, because the feed renders it for every visitor;
 *  - otherwise (PRIVATE posts, drafts, scheduled posts, demo fixtures) only
 *    the post's author may fetch the bytes through the owner branch above.
 *    The ladder never widens access for anyone else.
 */
function postLadderAllows(
  post: {
    status: string;
    visibility: string;
    authorId: string;
    author: { isDemo: boolean; deletedAt: Date | null; profileVisibility: string };
  },
  viewerId: string | null
): { allowed: boolean; publiclyShared: boolean } {
  if (post.author.deletedAt) return { allowed: false, publiclyShared: false };
  if (viewerId && post.authorId === viewerId) return { allowed: true, publiclyShared: false };
  if (
    post.status === "PUBLISHED" &&
    post.visibility === "PUBLIC" &&
    !post.author.isDemo &&
    post.author.profileVisibility === "PUBLIC"
  ) {
    return { allowed: true, publiclyShared: true };
  }
  return { allowed: false, publiclyShared: false };
}

/**
 * Whether a PUBLISHED site config snapshot legitimately makes this media id
 * part of its public face: top-level logo/cover branding, or a Video Reel
 * section entry. Snapshots are JSON text — parse defensively and verify the
 * id precisely (never substring matching).
 */
function publishedConfigAllows(publishedConfig: string | null | undefined, mediaId: string): boolean {
  try {
    const cfg = JSON.parse(publishedConfig ?? "") as {
      logoMediaId?: string | null;
      coverMediaId?: string | null;
      pages?: { sections?: { type?: string; videos?: { mediaId?: string }[] }[] }[];
    };
    if (cfg.logoMediaId === mediaId || cfg.coverMediaId === mediaId) return true;
    return (cfg.pages ?? []).some((page) =>
      (page.sections ?? []).some(
        (s) => s.type === "reel" && (s.videos ?? []).some((v) => v.mediaId === mediaId)
      )
    );
  } catch {
    return false; // unreadable snapshot — never widen access on a parse failure
  }
}

/**
 * Binary media streaming with server-enforced authorization:
 *  1. owner → allowed
 *  2. used as avatar/cover by any live account → allowed
 *  3. used as a project cover → allowed when that project is PUBLIC/UNLISTED,
 *     or the viewer owns it (covers are set via Project.coverMediaId without
 *     a ProjectMedia link, and published sites render them for everyone)
 *  4. attached to a project → allowed when the project is PUBLIC/UNLISTED,
 *     or the viewer owns that project (PRIVATE stays owner-only)
 *  5. anything else (unattached) → owner-only
 *
 * HTTP byte ranges (RFC 7233) are supported so <video> seeking works and
 * whole files are never buffered for range-capable clients — Safari/iOS
 * require 206 responses for progressive media playback.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const media = await db.mediaAsset.findUnique({ where: { id } });
  if (!media) return ERR.notFound();

  const viewer = await getSessionUser();
  let allowed = viewer?.id === media.ownerId;
  // P3 — CDN-safe cache classes. `publiclyShared` marks assets whose access
  // is VIEWER-INDEPENDENT (every anonymous visitor may fetch them): those get
  // `Cache-Control: public` so a CDN/browser can cache the bytes. Assets
  // allowed ONLY because the caller is the owner (private project media,
  // unattached uploads, private site branding) keep `private` — a shared
  // cache must never store them.
  let publiclyShared = false;

  if (!allowed) {
    const refCount = await db.user.count({
      where: { deletedAt: null, OR: [{ avatarMediaId: media.id }, { coverMediaId: media.id }] },
    });
    if (refCount > 0) {
      allowed = true;
      publiclyShared = true; // profile imagery is public by definition
    }
  }

  if (!allowed) {
    const coverCount = await db.project.count({
      where: {
        coverMediaId: media.id,
        owner: { deletedAt: null },
        ...(viewer
          ? { OR: [{ visibility: { in: ["PUBLIC", "UNLISTED"] } }, { ownerId: viewer.id }] }
          : { visibility: { in: ["PUBLIC", "UNLISTED"] } }),
      },
    });
    if (coverCount > 0) {
      allowed = true;
      // Public only when the reason is a PUBLIC/UNLISTED cover — an owner
      // opening their own PRIVATE project's cover stays private.
      const publicCover = await db.project.count({
        where: { coverMediaId: media.id, owner: { deletedAt: null }, visibility: { in: ["PUBLIC", "UNLISTED"] } },
      });
      publiclyShared = publicCover > 0;
    }
  }

  if (!allowed) {
    const links = await db.projectMedia.findMany({
      where: { mediaId: media.id },
      include: { project: { select: { visibility: true, ownerId: true, owner: { select: { deletedAt: true } } } } },
      take: 20,
    });
    for (const link of links) {
      // A soft-deleted owner's projects are unreachable everywhere else —
      // their media must not stay fetchable through stale project links.
      if (link.project.owner.deletedAt) continue;
      if (link.project.visibility === "PUBLIC" || link.project.visibility === "UNLISTED") {
        allowed = true;
        publiclyShared = true; // UNLISTED keeps "anyone with the link" semantics — public caching is correct
        break;
      }
      if (viewer && link.project.ownerId === viewer.id) {
        allowed = true; // owner access to their own PRIVATE project media — stays private
        break;
      }
    }
  }

  if (!allowed) {
    // Creator social feed media: linked through PostMedia as the post's
    // media asset or its poster frame. Access mirrors loadViewablePost
    // exactly (see postLadderAllows above) — PUBLIC posts of live, publicly
    // visible authors are fetchable by everyone; everything else stays
    // author-only. Soft-deleted authors' posts never leak their media.
    const links = await db.postMedia.findMany({
      where: { OR: [{ mediaAssetId: media.id }, { posterMediaAssetId: media.id }] },
      include: {
        post: {
          select: {
            status: true,
            visibility: true,
            authorId: true,
            author: { select: { isDemo: true, deletedAt: true, profileVisibility: true } },
          },
        },
      },
      take: 10,
    });
    for (const link of links) {
      const verdict = postLadderAllows(link.post, viewer?.id ?? null);
      if (verdict.allowed) {
        allowed = true;
        publiclyShared = verdict.publiclyShared;
        break;
      }
    }
  }

  if (!allowed) {
    // Branding/logo (and cover) media referenced by a PUBLISHED website are
    // part of that site's public face — visitors must be able to see them.
    // Draft-only and unpublished sites keep owner-only access, so a private
    // draft never leaks its assets through this endpoint. The config lives in
    // a JSON text column, so prefilter with a cheap `contains` and then verify
    // the id precisely against the parsed snapshot (no substring false
    // positives). OWNERSHIP IS ENFORCED: the referenced media must belong to
    // the site's owner — a config pointing at someone else's media id never
    // makes that media public (server-side IDOR guard; the save routes
    // reject such references at write time too).
    const publishedSites = await db.siteDesign.findMany({
      where: {
        status: "PUBLISHED",
        user: { deletedAt: null, id: media.ownerId },
        publishedConfig: { contains: media.id },
      },
      select: { publishedConfig: true },
      take: 5,
    });
    for (const site of publishedSites) {
      const verdict = publishedConfigAllows(site.publishedConfig, media.id);
      if (verdict) {
        allowed = true;
        publiclyShared = true; // published-site media is part of the public site
        break;
      }
    }
  }

  if (!allowed) {
    // GIFTZ generated sites (GiftzSite) — the same public-face rule for the
    // independent prompt-built artifacts: PUBLISHED generated sites may serve
    // their own branding and Video Reel media publicly. Ownership was
    // enforced at every save/publish boundary; drafts stay owner-only.
    const publishedGiftzSites = await db.giftzSite.findMany({
      where: {
        status: "PUBLISHED",
        user: { deletedAt: null, id: media.ownerId },
        publishedConfig: { contains: media.id },
      },
      select: { publishedConfig: true },
      take: 5,
    });
    for (const site of publishedGiftzSites) {
      const verdict = publishedConfigAllows(site.publishedConfig, media.id);
      if (verdict) {
        allowed = true;
        publiclyShared = true;
        break;
      }
    }
  }

  if (!allowed) return ERR.forbidden();

  let total: number;
  try {
    total = await getObjectSize(media.storagePath);
  } catch {
    // Row exists but the blob is gone — mark FAILED and 404
    await db.mediaAsset.update({ where: { id: media.id }, data: { status: "FAILED" } }).catch(() => undefined);
    return ERR.notFound();
  }

  // Documents download instead of rendering inline (no same-origin PDF surface)
  const disposition =
    media.kind === "DOCUMENT"
      ? `attachment; filename="media-${media.id}"`
      : `inline; filename="media-${media.id}"`;

  const baseHeaders: Record<string, string> = {
    "Content-Type": media.mime,
    "Accept-Ranges": "bytes",
    // P3: viewer-independent (publicly shared) media is CDN/browser-cacheable
    // — asset bytes never mutate after upload, so max-age is safe. Owner-only
    // media keeps `private` (authorization was per-request; a shared cache
    // must never store it).
    "Cache-Control": publiclyShared ? "public, max-age=3600, stale-while-revalidate=86400" : "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": disposition,
  };

  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, total);
    if (!range) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    const chunk = await getObjectRange(media.storagePath, range.start, range.end);
    return new NextResponse(new Uint8Array(chunk), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
        "Content-Length": String(range.end - range.start + 1),
      },
    });
  }

  let buf: Buffer;
  try {
    buf = await getObject(media.storagePath);
  } catch {
    await db.mediaAsset.update({ where: { id: media.id }, data: { status: "FAILED" } }).catch(() => undefined);
    return ERR.notFound();
  }

  return new NextResponse(new Uint8Array(buf), {
    headers: { ...baseHeaders, "Content-Length": String(buf.length) },
  });
});

/**
 * Parse a single-range `Range` header (multipart ranges fall back to the
 * first range). Returns { start, end } clamped to the object, or null when
 * the header is malformed or unsatisfiable.
 */
function parseByteRange(header: string, total: number): { start: number; end: number } | null {
  if (total <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  let start: number;
  let end: number;
  if (rawStart === "") {
    // suffix range: last N bytes
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix === 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? total - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
    if (start >= total) return null;
    end = Math.min(end, total - 1);
  }
  return { start, end };
}
