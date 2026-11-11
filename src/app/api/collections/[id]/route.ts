import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, parseBody, handler } from "@/lib/api-helpers";
import { projectCardInclude, toProjectCard } from "@/lib/serialize";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(300).optional(),
  isPublic: z.boolean().optional(),
});

function optText(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Load a collection owned by the caller — 404 for missing rows AND foreign collections. */
async function loadOwnCollection(id: string, userId: string) {
  const collection = await db.collection.findUnique({ where: { id }, select: { id: true, ownerId: true } });
  if (!collection || collection.ownerId !== userId) return null;
  return collection;
}

// ---------- PATCH /api/collections/:id — owner only ----------

export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const own = await loadOwnCollection(id, user.id);
  if (!own) return ERR.notFound();

  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;

  const data = {
    ...(r.data.name !== undefined ? { name: r.data.name } : {}),
    ...(r.data.description !== undefined ? { description: optText(r.data.description) } : {}),
    ...(r.data.isPublic !== undefined ? { isPublic: r.data.isPublic } : {}),
  };

  const updated = await db.collection.update({
    where: { id },
    data,
    include: {
      items: {
        where: { project: { visibility: { not: "PRIVATE" }, owner: { deletedAt: null } } },
        orderBy: { addedAt: "asc" },
        include: { project: { include: projectCardInclude } },
      },
    },
  });

  return ok({
    collection: {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      isPublic: updated.isPublic,
      items: updated.items.map((ci) => toProjectCard(ci.project)),
    },
  });
});

// ---------- DELETE /api/collections/:id — owner only ----------

export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const own = await loadOwnCollection(id, user.id);
  if (!own) return ERR.notFound();

  await db.collection.delete({ where: { id } });
  return ok({ ok: true });
});
