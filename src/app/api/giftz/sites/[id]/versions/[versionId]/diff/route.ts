import { NextRequest } from "next/server";

import { handler, ok, err, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { diffVersionAgainstCurrent } from "@/lib/giftz/project-versions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; versionId: string }> };

/**
 * GET /api/giftz/sites/[id]/versions/[versionId]/diff — what would change
 * when restoring this snapshot: per-file added/removed/modified vs the
 * CURRENT working tree, with unified patches for text files (binary rows
 * diff to patch: null).
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id, versionId } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id } });
  if (!site) return ERR.notFound();

  const result = await diffVersionAgainstCurrent(site, versionId);
  if (!result.ok) return err(result.error, 404);

  return ok({ changed: result.changed });
});
