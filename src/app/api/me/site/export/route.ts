import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { err, ERR, handler, rateLimit } from "@/lib/api-helpers";
import { normalizeConfig } from "@/lib/site-config";
import { buildSiteExport, type ExportProfile } from "@/lib/site-export";
import { getObject } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/me/site/export — "Download Website Code".
 *
 * Streams a ZIP archive of the caller's OWN website as a standalone static
 * site (HTML/CSS/JS + local assets + README + manifest), generated from the
 * ACTUAL saved configuration. Publishing state is deliberately irrelevant:
 * exporting never publishes, unpublishes or otherwise touches the live
 * website or the published snapshot (kept separate from the publish flow by
 * design), and it works for drafts as well as published sites.
 *
 * Which configuration is exported: the saved draft when one exists (the
 * creator's current working site), otherwise the published snapshot. The
 * source is recorded inside the archive (README + manifest) — never silently
 * mixed up with the live snapshot.
 *
 * Security: session-owner scoped. Projects and collections are read with the
 * same PUBLIC-visibility filters the public profile uses (draft or private
 * projects — the user's or anyone else's — are never included). Media bytes
 * resolve exclusively through MediaAsset rows owned by the session user, read
 * via the storage layer's path-validated accessor; archive filenames are
 * generated here and sanitized. No environment files, cookies, tokens,
 * credentials, other users' data, or server configuration can enter the
 * archive.
 */
export const GET = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  // ZIP generation is CPU/memory heavy — throttle per account.
  if (!rateLimit(`site-export:${user.id}`, 5, 5 * 60_000)) return ERR.rateLimited();
  if (!user.username) {
    return err("Finish onboarding to claim your website before exporting.", 400);
  }

  const design = await db.siteDesign.findUnique({ where: { userId: user.id } });
  const draftConfig = normalizeConfig(design?.draftConfig);
  const publishedConfig = normalizeConfig(design?.publishedConfig);
  const config = draftConfig ?? publishedConfig;
  if (!config) {
    return err("Save your website in Website Studio first — there is nothing to export yet.", 400);
  }
  const source: "draft" | "published" = draftConfig ? "draft" : "published";

  // ---- public-facing data only (mirrors GET /api/profiles/:username filters)
  const [profileRow, projectCount, projects, collections] = await Promise.all([
    db.user.findUnique({
      where: { id: user.id },
      select: {
        name: true,
        username: true,
        headline: true,
        location: true,
        bio: true,
        availability: true,
        coverPositionY: true,
        contactEmail: true,
        websiteUrl: true,
        avatarMediaId: true,
        coverMediaId: true,
        _count: { select: { followsReceived: true, followsGiven: true } },
        skills: { include: { skill: true }, take: 30 },
      },
    }),
    db.project.count({ where: { ownerId: user.id, status: "PUBLISHED" } }),
    db.project.findMany({
      where: { ownerId: user.id, status: "PUBLISHED", visibility: "PUBLIC" },
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
      take: 60,
      select: { id: true, title: true, summary: true, category: true, coverMediaId: true },
    }),
    db.collection.findMany({
      where: { ownerId: user.id, isPublic: true },
      orderBy: { createdAt: "asc" },
      take: 24,
      select: {
        id: true,
        name: true,
        description: true,
        items: {
          where: { project: { status: "PUBLISHED", visibility: "PUBLIC" } },
          orderBy: { addedAt: "asc" },
          take: 24,
          select: {
            project: { select: { id: true, title: true, summary: true, category: true, coverMediaId: true } },
          },
        },
      },
    }),
  ]);
  if (!profileRow) return ERR.unauthorized();

  const mediaUrl = (id: string | null | undefined) => (id ? `/api/media/${id}/raw` : null);
  const exportProfile: ExportProfile = {
    name: profileRow.name,
    username: profileRow.username,
    headline: profileRow.headline,
    location: profileRow.location,
    bio: profileRow.bio,
    availability: profileRow.availability,
    avatarUrl: mediaUrl(profileRow.avatarMediaId),
    coverUrl: mediaUrl(profileRow.coverMediaId),
    coverPositionY: profileRow.coverPositionY,
    skills: profileRow.skills.map((s) => s.skill.label),
    websiteUrl: profileRow.websiteUrl,
    contactEmail: profileRow.contactEmail,
    stats: {
      followers: profileRow._count.followsReceived,
      following: profileRow._count.followsGiven,
      projects: projectCount,
    },
  };

  const toCard = (p: { id: string; title: string; summary: string | null; category: string | null; coverMediaId: string | null }) => ({
    id: p.id,
    title: p.title,
    summary: p.summary,
    category: p.category,
    coverUrl: mediaUrl(p.coverMediaId),
  });

  /**
   * Owner-scoped media loader: the MediaAsset row MUST belong to the session
   * user — anything else (including nonexistent ids) yields null and the
   * generator falls back to the themed placeholder tile.
   */
  const loadMedia = async (mediaId: string) => {
    const asset = await db.mediaAsset.findUnique({ where: { id: mediaId }, select: { ownerId: true, storagePath: true, mime: true } });
    if (!asset || asset.ownerId !== user.id) return null;
    try {
      const bytes = await getObject(asset.storagePath);
      return { mime: asset.mime, bytes };
    } catch {
      return null;
    }
  };

  const { files, warnings } = await buildSiteExport({
    config,
    profile: exportProfile,
    projects: projects.map(toCard),
    collections: collections.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      items: c.items.map((it) => toCard(it.project)),
    })),
    watermark: design?.watermark ?? true,
    source,
    loadMedia,
  });

  // ---- zip (in-memory; contents are generated text + the owner's own media)
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.data);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });

  const safeSlug = user.username.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "website";
  const filename = `${safeSlug}-website.zip`;

  if (warnings.length > 0) {
    console.info("[site-export] notes:", JSON.stringify(warnings));
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
