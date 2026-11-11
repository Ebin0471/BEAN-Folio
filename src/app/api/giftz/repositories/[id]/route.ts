import { NextRequest } from "next/server";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok } from "@/lib/api-helpers";
import { clientTree, inspectRepository } from "@/lib/giftz/inspect";
import { WorkspaceError, removeWorkspace } from "@/lib/giftz/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/giftz/repositories/[id] — repository detail with a FRESH
 * deterministic inspection digest (metadata only — never file contents,
 * never secret paths).
 */
export const GET = handler(async (_req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;

  const repo = await db.giftzRepository.findFirst({ where: { id, ownerId: user.id } });
  if (!repo) return ERR.notFound();

  try {
    const digest = inspectRepository(id);
    return ok({
      repository: { id: repo.id, name: repo.name, sizeBytes: repo.sizeBytes, fileCount: repo.fileCount, createdAt: repo.createdAt },
      digest,
      tree: clientTree(digest),
    });
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 404) {
      return err("The workspace files are missing — the repository needs to be recreated", 410);
    }
    return ERR.server();
  }
});

/** DELETE /api/giftz/repositories/[id] — remove the workspace and its registry row. */
export const DELETE = handler(async (_req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;

  const repo = await db.giftzRepository.findFirst({ where: { id, ownerId: user.id } });
  if (!repo) return ERR.notFound();

  try {
    removeWorkspace(id);
  } catch (error) {
    if (error instanceof WorkspaceError) return err(error.message, error.status);
    /* fall through — the registry row still goes away */
  }
  await db.giftzRepository.delete({ where: { id: repo.id } });
  return ok({ deleted: true });
});
