import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

import { handler, ok, err, ERR, parseBody, rateLimit } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { normalizeConfig } from "@/lib/site-config";

export const dynamic = "force-dynamic";

const MAX_REVISIONS = 10;

/**
 * GET /api/me/site/revisions — the owner's recent draft snapshots (newest
 * first). Returns a safe projection: the label, timestamp and a small summary
 * (site name + page/section counts) parsed from the stored config — the full
 * config is only ever handed back through the restore endpoint.
 */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const rows = await db.siteRevision.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: MAX_REVISIONS,
    select: { id: true, label: true, config: true, createdAt: true },
  });

  return ok({
    revisions: rows.map((r) => {
      let name = "Website draft";
      let pageCount = 0;
      let sectionCount = 0;
      try {
        const parsed = normalizeConfig(r.config);
        if (parsed) {
          name = parsed.name || name;
          pageCount = parsed.pages.length;
          sectionCount = parsed.pages.reduce((n, p) => n + p.sections.length, 0);
        }
      } catch {
        // unparseable snapshots are still listable — they just can't be restored
      }
      return {
        id: r.id,
        label: r.label,
        createdAt: r.createdAt.toISOString(),
        summary: `${name} · ${pageCount} page${pageCount === 1 ? "" : "s"} · ${sectionCount} section${sectionCount === 1 ? "" : "s"}`,
        restorable: normalizeConfig(r.config) !== null,
      };
    }),
  });
});

/**
 * POST /api/me/site/revisions — restore a snapshot as the working draft.
 * The CURRENT draft is snapshotted first (restores are themselves reversible),
 * then the revision's config (re-validated through the site schema and the
 * same media-ownership rule as PUT) replaces the draft. The restore response
 * carries the new draft so the builder can adopt it without a refetch.
 */
const restoreSchema = z.object({ id: z.string().min(1).max(40) });

export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  // Restores rewrite the draft — keep them deliberate (10 / hour).
  if (!rateLimit(`site-restore:${user.id}`, 10, 3_600_000)) return ERR.rateLimited();

  const r = await parseBody(req, restoreSchema);
  if (r.response) return r.response;

  const revision = await db.siteRevision.findFirst({ where: { id: r.data.id, userId: user.id } });
  if (!revision) return err("Revision not found.", 404);

  const restored = normalizeConfig(revision.config);
  if (!restored) return err("This snapshot is not a valid website configuration and cannot be restored.", 400);

  // Media ownership (same rule as PUT /api/me/site): a restored config may
  // only reference media the session user owns.
  const mediaIds = [restored.logoMediaId, restored.coverMediaId].filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  if (mediaIds.length > 0) {
    const owned = await db.mediaAsset.findMany({
      where: { id: { in: mediaIds }, ownerId: user.id },
      select: { id: true },
    });
    if (owned.length !== new Set(mediaIds).size) {
      return err("This snapshot references media that no longer exists on your account and cannot be restored.", 400);
    }
  }

  const current = await db.siteDesign.findUnique({ where: { userId: user.id }, select: { draftConfig: true } });
  if (current?.draftConfig && current.draftConfig !== revision.config) {
    await db.siteRevision.create({
      data: { userId: user.id, label: "Before restore", config: current.draftConfig },
    });
    const stale = await db.siteRevision.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      skip: MAX_REVISIONS,
      select: { id: true },
    });
    if (stale.length > 0) {
      await db.siteRevision.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
  }

  await db.siteDesign.upsert({
    where: { userId: user.id },
    update: { draftConfig: JSON.stringify(restored), updatedAt: new Date() },
    create: { userId: user.id, draftConfig: JSON.stringify(restored) },
  });

  return ok({ restored: true, draft: restored, label: revision.label });
});
