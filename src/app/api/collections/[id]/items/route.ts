import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, parseBody, handler } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const addSchema = z.object({
  projectId: z.string().trim().min(1),
});

/** Load a collection owned by the caller — 404 for missing rows AND foreign collections. */
async function loadOwnCollection(id: string, userId: string) {
  const collection = await db.collection.findUnique({ where: { id }, select: { id: true, ownerId: true } });
  if (!collection || collection.ownerId !== userId) return null;
  return collection;
}

// ---------- POST /api/collections/:id/items ----------

export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const own = await loadOwnCollection(id, user.id);
  if (!own) return ERR.notFound();

  const r = await parseBody(req, addSchema);
  if (r.response) return r.response;

  const project = await db.project.findUnique({
    where: { id: r.data.projectId },
    select: { id: true, status: true, visibility: true },
  });
  if (!project) return ERR.notFound();
  if (project.status !== "PUBLISHED" || project.visibility === "PRIVATE") {
    return err("Only published projects can be added to a collection", 400);
  }

  await db.collectionItem.upsert({
    where: { collectionId_projectId: { collectionId: id, projectId: project.id } },
    update: {},
    create: { collectionId: id, projectId: project.id },
  });

  return ok({ ok: true });
});

// ---------- DELETE /api/collections/:id/items?projectId= ----------

export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const own = await loadOwnCollection(id, user.id);
  if (!own) return ERR.notFound();

  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return err("projectId query parameter is required", 400);

  await db.collectionItem.deleteMany({ where: { collectionId: id, projectId } });
  return ok({ ok: true });
});
