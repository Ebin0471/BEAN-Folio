import { NextRequest } from "next/server";

import { handler, ok, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { listProjectFiles, mimeForPath, projectTreeSummary } from "@/lib/giftz/project-files";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/giftz/sites/[id]/files — the project's file TREE (no contents).
 * Owner-scoped. Rows carry source badges (generated | user | ai) and a
 * MIME hint so the code workspace can render the tree without downloading
 * every file.
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const [rows, summary] = await Promise.all([listProjectFiles(id), projectTreeSummary(id)]);

  return ok({
    files: rows.map((r) => ({
      path: r.path,
      source: r.source,
      sizeBytes: r.sizeBytes,
      encoding: r.encoding,
      updatedAt: r.updatedAt.toISOString(),
      mime: mimeForPath(r.path),
    })),
    summary,
  });
});
