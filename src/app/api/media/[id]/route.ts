import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler } from "@/lib/api-helpers";
import { deleteMediaFile } from "@/lib/media";

type Ctx = { params: Promise<{ id: string }> };

function toMediaDTO(m: { id: string; kind: string; mime: string; size: number }) {
  return { id: m.id, kind: m.kind, mime: m.mime, size: m.size, url: `/api/media/${m.id}/raw` };
}

/** Metadata for a media asset — owner only. */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const media = await db.mediaAsset.findUnique({ where: { id } });
  if (!media || media.ownerId !== user.id) return ERR.notFound();

  return ok({ media: toMediaDTO(media) });
});

/** Delete a media asset (file + row) — owner only. */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const media = await db.mediaAsset.findUnique({ where: { id } });
  if (!media || media.ownerId !== user.id) return ERR.notFound();

  // Refuse deletion while the asset is still referenced — deleting a cover,
  // avatar or attached project media would break already-published pages.
  // This also covers the custom-website builder: a logo/cover referenced by
  // the owner's draft or published SiteDesign snapshot must not be deletable
  // (deleting it would 404 the image on the live site).
  const [projectLinks, coverUses, profileUses, siteUses] = await Promise.all([
    db.projectMedia.count({ where: { mediaId: media.id } }),
    db.project.count({ where: { coverMediaId: media.id } }),
    db.user.count({ where: { deletedAt: null, OR: [{ avatarMediaId: media.id }, { coverMediaId: media.id }] } }),
    db.siteDesign.findMany({
      where: { userId: user.id, OR: [{ draftConfig: { contains: media.id } }, { publishedConfig: { contains: media.id } }] },
      select: { draftConfig: true, publishedConfig: true },
    }),
  ]);
  const siteRefs = siteUses.some((row) =>
    [row.draftConfig, row.publishedConfig].some((cfg) => {
      if (!cfg) return false;
      try {
        const parsed = JSON.parse(cfg) as { logoMediaId?: unknown; coverMediaId?: unknown } | null;
        return parsed?.logoMediaId === media.id || parsed?.coverMediaId === media.id;
      } catch {
        return false;
      }
    })
  );
  if (projectLinks > 0 || coverUses > 0 || profileUses > 0 || siteRefs) {
    return err(
      "This file is still in use — remove it from your project, profile or website first",
      409
    );
  }

  await deleteMediaFile(media.storagePath);
  await db.mediaAsset.delete({ where: { id: media.id } }).catch(() => undefined);

  return ok({ ok: true });
});
