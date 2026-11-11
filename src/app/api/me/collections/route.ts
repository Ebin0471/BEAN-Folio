import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, parseBody, handler } from "@/lib/api-helpers";
import { projectCardInclude, toProjectCard } from "@/lib/serialize";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).optional(),
  isPublic: z.boolean().optional(),
});

function optText(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Defensive item filter: never surface PRIVATE projects or deleted owners in collection lists. */
const visibleItemsInclude = {
  items: {
    where: { project: { visibility: { not: "PRIVATE" }, owner: { deletedAt: null } } },
    orderBy: { addedAt: "asc" as const },
    include: { project: { include: projectCardInclude } },
  },
};

// ---------- GET /api/me/collections ----------

export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const collections = await db.collection.findMany({
    where: { ownerId: user.id },
    orderBy: { createdAt: "asc" },
    include: visibleItemsInclude,
  });

  return ok({
    collections: collections.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      isPublic: c.isPublic,
      items: c.items.map((ci) => toProjectCard(ci.project)),
    })),
  });
});

// ---------- POST /api/me/collections ----------

export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const r = await parseBody(req, createSchema);
  if (r.response) return r.response;

  const collection = await db.collection.create({
    data: {
      ownerId: user.id,
      name: r.data.name,
      description: optText(r.data.description),
      isPublic: r.data.isPublic ?? false,
    },
  });

  return ok({
    collection: {
      id: collection.id,
      name: collection.name,
      description: collection.description,
      isPublic: collection.isPublic,
      items: [],
    },
  });
});
