import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/media — the Studio Asset Library listing (owner-scoped).
 *
 * Returns the caller's READY media assets, newest first, with per-asset usage
 * counts and an aggregate storage summary. Pagination via `limit` (max 120)
 * + `offset`; optional `kind` filter (IMAGE | VIDEO | AUDIO | DOCUMENT).
 *
 * This endpoint only READS — uploads go through the existing upload flows
 * (POST /api/media/upload or the presigned direct route) and deletion stays
 * on DELETE /api/media/:id with its in-use guards, so the library can never
 * delete something a published page still references.
 */

const KINDS = ["IMAGE", "VIDEO", "AUDIO", "DOCUMENT"] as const;

export const GET = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const params = req.nextUrl.searchParams;

  const kindParam = params.get("kind")?.toUpperCase() ?? "";
  const kind: (typeof KINDS)[number] | undefined = kindParam
    ? (z.enum(KINDS).safeParse(kindParam).data satisfies (typeof KINDS)[number] | undefined)
    : undefined;
  if (kindParam && !kind) return err("Invalid kind filter. Use IMAGE, VIDEO, AUDIO or DOCUMENT.", 400);

  const limitRaw = Number(params.get("limit") ?? "60");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 120) : 60;
  const offsetRaw = Number(params.get("offset") ?? "0");
  const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0;

  const where = { ownerId: user.id, status: "READY", ...(kind ? { kind } : {}) };

  const [assets, total, storage] = await Promise.all([
    db.mediaAsset.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        kind: true,
        filename: true,
        mime: true,
        size: true,
        width: true,
        height: true,
        createdAt: true,
        _count: { select: { projectMedia: true } },
      },
    }),
    db.mediaAsset.count({ where }),
    db.mediaAsset.aggregate({ where: { ownerId: user.id, status: "READY" }, _sum: { size: true }, _count: true }),
  ]);

  return ok({
    assets: assets.map((m) => ({
      id: m.id,
      kind: m.kind,
      filename: m.filename,
      mime: m.mime,
      size: m.size,
      width: m.width,
      height: m.height,
      createdAt: m.createdAt.toISOString(),
      url: `/api/media/${m.id}/raw`,
      usedInProjects: m._count.projectMedia,
    })),
    total,
    storage: { bytes: storage._sum.size ?? 0, count: storage._count },
  });
});
