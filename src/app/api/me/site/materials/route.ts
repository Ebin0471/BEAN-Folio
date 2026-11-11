import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { handler, ok, err, ERR, parseBody, rateLimit } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { addSiteMaterials, deleteSiteMaterial, describeImageMaterials, listSiteMaterials, MATERIAL_LIMITS } from "@/lib/ai-design/ingest";

export const dynamic = "force-dynamic";

const addSchema = z.object({
  mediaIds: z.array(z.string().min(1).max(40)).min(1).max(MATERIAL_LIMITS.maxPerUser),
});

/**
 * GET /api/me/site/materials — the owner's uploaded source materials for the
 * Code Giftz "create my own website" workflow.
 */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const materials = await listSiteMaterials(user.id);
  return ok({ materials });
});

/**
 * POST /api/me/site/materials — register ALREADY-UPLOADED media (from
 * /api/media/upload) as site materials and extract their content.
 *
 * Ownership is enforced inside addSiteMaterials (media rows are matched by
 * ownerId, so a foreign mediaId never resolves). After extraction, uploaded
 * images get a one-line visual description via ONE batched vision call when
 * the provider is available — best-effort, degrades silently.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  // 20 material registrations / hour per account.
  if (!rateLimit(`site-materials:${user.id}`, 20, 3_600_000)) return ERR.rateLimited();

  const r = await parseBody(req, addSchema);
  if (r.response) return r.response;

  try {
    const materials = await addSiteMaterials(user.id, r.data.mediaIds);
    // Best-effort image understanding (1 provider call max, ≤5 images).
    const described = await describeImageMaterials(user.id, r.data.mediaIds).catch(() => 0);
    const fresh = described > 0 ? await listSiteMaterials(user.id) : materials;
    return ok({ materials: fresh, described });
  } catch (e) {
    // Phase 6 leak fix: forward only the curated, client-fixable message from
    // the ingest lib; anything else (Prisma internals, IO faults) is logged
    // server-side and answered with the generic typed message — the wire
    // never carries raw Error.message.
    if (e instanceof Error && e.message === "None of the selected files could be found among your uploads.") {
      return err(e.message, 400);
    }
    console.error("[api] materials registration failed:", e);
    return err("Could not register the materials.", 400);
  }
});

/**
 * DELETE /api/me/site/materials?id=… — remove a material (the underlying
 * MediaAsset stays; this only detaches it from the generation workflow).
 */
export const DELETE = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return err("Missing material id.", 400);
  const removed = await deleteSiteMaterial(user.id, id);
  if (!removed) return err("Material not found.", 404);
  return ok({ removed: true });
});
