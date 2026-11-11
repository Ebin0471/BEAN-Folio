import { NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ERR, handler, ok, parseBody, rateLimit, err } from "@/lib/api-helpers";
import { WorkspaceError, createWorkspaceFromTemplate, removeWorkspace } from "@/lib/giftz/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(3).max(60).optional(),
});

/** GET /api/giftz/repositories — list the caller's authorized workspaces. */
export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const repos = await db.giftzRepository.findMany({
    where: { ownerId: user.id, status: "READY" },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, name: true, sizeBytes: true, fileCount: true, createdAt: true, updatedAt: true },
  });
  return ok({ repositories: repos });
});

/** POST /api/giftz/repositories — create a workspace from the starter template. */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`giftz-repo:${user.id}`, 10, 60 * 60 * 1000)) return ERR.rateLimited();

  const parsed = await parseBody(req, createSchema);
  if (parsed.response) return parsed.response;

  const count = await db.giftzRepository.count({ where: { ownerId: user.id, status: "READY" } });
  if (count >= 5) {
    return err("Workspace limit reached (5). Delete one before creating another.", 409);
  }

  const repo = await db.giftzRepository.create({
    data: { ownerId: user.id, name: parsed.data.name?.slice(0, 60) ?? "ledger-kit starter" },
    select: { id: true, name: true },
  });

  try {
    const stats = createWorkspaceFromTemplate(repo.id);
    const updated = await db.giftzRepository.update({
      where: { id: repo.id },
      data: stats,
      select: { id: true, name: true, sizeBytes: true, fileCount: true, createdAt: true, updatedAt: true },
    });
    return ok({ repository: updated }, 201);
  } catch (error) {
    // Do not leave a registry row without a workspace behind it.
    await db.giftzRepository.delete({ where: { id: repo.id } }).catch(() => undefined);
    if (error instanceof WorkspaceError) return err(error.message, error.status);
    return err("Could not create the workspace", 500);
  }
});
