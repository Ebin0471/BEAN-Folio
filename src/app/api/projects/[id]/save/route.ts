import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Load a project for save/unsave: must be PUBLISHED, PUBLIC or UNLISTED,
 * owned by a live account, and not the caller's own project.
 */
async function loadSavableProject(id: string, userId: string) {
  const project = await db.project.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      ownerId: true,
      status: true,
      visibility: true,
      owner: { select: { deletedAt: true } },
    },
  });
  if (!project || project.owner.deletedAt) return { error: "notFound" as const };
  if (project.ownerId === userId) return { error: "ownProject" as const };
  if (project.status !== "PUBLISHED" || project.visibility === "PRIVATE") return { error: "notFound" as const };
  return { project };
}

// ---------- POST /api/projects/:id/save ----------

export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const loaded = await loadSavableProject(id, user.id);
  if ("error" in loaded) {
    return loaded.error === "ownProject" ? err("You cannot save your own project", 400) : ERR.notFound();
  }
  const project = loaded.project;

  const existing = await db.savedProject.findUnique({
    where: { userId_projectId: { userId: user.id, projectId: id } },
  });
  await db.savedProject.upsert({
    where: { userId_projectId: { userId: user.id, projectId: id } },
    update: {},
    create: { userId: user.id, projectId: id },
  });

  // Notify the owner only on the first save (re-saving is idempotent).
  if (!existing) {
    await db.notification
      .create({
        data: {
          userId: project.ownerId,
          type: "SAVE",
          payload: JSON.stringify({
            actor: user.name,
            actorUsername: user.username,
            projectTitle: project.title,
          }),
        },
      })
      .catch(() => undefined);
  }

  return ok({ saved: true });
});

// ---------- DELETE /api/projects/:id/save ----------

export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  await db.savedProject.deleteMany({ where: { userId: user.id, projectId: id } });
  return ok({ saved: false });
});
