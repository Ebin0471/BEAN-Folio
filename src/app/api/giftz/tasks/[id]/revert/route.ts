import { NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { ERR, err, handler, ok } from "@/lib/api-helpers";
import { GiftzTaskError, revertTask } from "@/lib/giftz/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/giftz/tasks/[id]/revert — restore ONLY the files this task
 * applied, from the workspace's baseline commit (git checkout HEAD -- paths).
 * Unrelated files are never touched.
 */
export const POST = handler(async (_req: NextRequest, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;

  try {
    const out = await revertTask(user.id, id);
    return ok({ reverted: true, restoredFiles: out.restored });
  } catch (error) {
    if (error instanceof GiftzTaskError) return err(error.message, error.status);
    return ERR.server();
  }
});
